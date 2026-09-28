#!/usr/bin/env bash
set -euo pipefail

# Dormant independent recovery. The caller owns concurrency and every write.
# Source workflow identity is reserved for a later activation of this helper.
repo="${1:?repository required}"
run_id="${2:?source run ID required}"
attempt="${3:?source attempt required}"
app_id="${4:?trusted App ID required}"
pr="${5:?PR number required}"
issue="${6:?closing Issue number required}"
source="${7:?source pause ID required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "prepare-ai-resume-review-recovery: $1" >&2; exit 1; }
positive() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
for value in "$run_id" "$attempt" "$app_id" "$pr" "$issue" "$source"; do
  positive "$value" || fail 'invalid numeric identity'
done
tmp="$(mktemp -d)" || fail 'temporary directory unavailable'
trap 'rm -rf "$tmp"' EXIT

gh api "/repos/$repo/actions/runs/$run_id" > "$tmp/run.json" || fail 'source run unavailable'
jq -e --arg repo "$repo" --argjson id "$run_id" --argjson attempt "$attempt" \
  --arg title "AI Resume Review Consumer pr:$pr pause:$source" '
  .id == $id and .run_attempt == $attempt and .name == "AI Resume Review Consumer"
  and .display_title == $title
  and .event == "repository_dispatch"
  and (.path | type == "string" and test("^\\.github/workflows/ai-resume-review-consumer\\.yml(@|$)"))
  and .head_repository.full_name == $repo and .status == "completed"
  and (.conclusion | IN("failure","cancelled","timed_out"))
  and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and (.updated_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and .created_at <= .updated_at
' "$tmp/run.json" >/dev/null || fail 'source run identity is inconsistent'
gh api "/repos/$repo/actions/runs/$run_id/attempts/$attempt" > "$tmp/attempt.json" \
  || fail 'source attempt unavailable'
jq -e --argjson id "$run_id" --argjson attempt "$attempt" '
  .id == $id and .run_attempt == $attempt and .status == "completed"
  and (.conclusion | IN("failure","cancelled","timed_out"))
  and (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and (.updated_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and .created_at <= .updated_at
' "$tmp/attempt.json" >/dev/null || fail 'source attempt is inconsistent'

# The canonical target resolver verifies the branch and closing Issue relation.
command='{"result":"accepted","action":"review","actor":"recovery"}'
bash "$script_dir/resolve-ai-resume-target.sh" "$repo" pr "$pr" <<< "$command" \
  > "$tmp/target.json" || fail 'target relation unavailable'
jq -e --argjson pr "$pr" --argjson issue "$issue" '
  .target == ("pr:" + ($pr | tostring)) and .closing_issue.number == $issue
  and .closing_issue.state == "open" and .pull_request.number == $pr
  and .pull_request.state == "open" and .pull_request.base_ref == "main"
  and .pull_request.head_ref == ("ai/issue-" + ($issue | tostring))
  and (.pull_request.head_sha | test("^[0-9a-f]{40}$"))
' "$tmp/target.json" >/dev/null || fail 'target relation mismatch or terminal'
head="$(jq -r '.pull_request.head_sha' "$tmp/target.json")"

# Use the existing trusted listing and lifecycle stages, including replacement
# pause reconciliation. Bounded history fails closed on incomplete scans.
export AI_RESUME_MAX_HISTORY_PAGES=10
bash "$script_dir/list-human-pause-records.sh" "$repo" "$issue" "$pr" "$app_id" \
  > "$tmp/graph-0.json" || fail 'trusted record history unavailable'
stages=(validate-human-pause-record-graph decompose-human-pause-record-graph \
        derive-human-pause-pre-resume-state reconcile-human-pause-resume-acceptance \
        reconcile-human-pause-active-pause)
for index in "${!stages[@]}"; do
  next=$((index + 1))
  bash "$script_dir/${stages[$index]}.sh" < "$tmp/graph-$index.json" \
    > "$tmp/graph-$next.json" || fail 'record graph inconsistent'
done
jq -e --arg target "pr:$pr" '.target == $target and .result != "state_inconsistent"' \
  "$tmp/graph-5.json" >/dev/null || fail 'ambiguous active pause'
jq -ce --arg source "$source" --arg head "$head" '
  [.chains[] | select(.pre_resume.pause_id == $source)]
  | if length != 1 then error("source chain is not unique") else .[0] end
  | if .pre_resume.reason | IN("claude_execution_failed","review_disagreement_decision","resume_transition_failed") | not
    then error("source reason is not resumable for review") else . end
  | if (.records[] | select(.pause_id == $source) | .record.paused_head) != $head
    then error("source HEAD differs from current HEAD") else . end
  | [.records[] | select(.record.kind == "ai-resume-accepted")] as $accepted
  | if ($accepted | length) > 1 then error("multiple acceptances")
    elif ($accepted | length) == 1 and
         ($accepted[0].record.source_pause_id != $source or
          $accepted[0].record.payload.action != "review" or
          $accepted[0].record.reason != .pre_resume.reason)
    then error("accepted identity mismatch") else . end
' "$tmp/graph-4.json" > "$tmp/chain.json" || fail 'source or accepted identity mismatch'
accepted="$(jq -r '[.records[] | select(.record.kind == "ai-resume-accepted")][0].pause_id // empty' "$tmp/chain.json")"
effective="$(jq -r '.effective.status' "$tmp/chain.json")"
active="$(jq -r '.active_pause.pause_id // empty' "$tmp/graph-5.json")"
read_labels() {
  local number
  for number in "$issue" "$pr"; do
    gh api "/repos/$repo/issues/$number" > "$tmp/label-$number.json" || fail 'label fact unavailable'
    jq -e --argjson number "$number" '
      .number == $number and .state == "open" and (.labels | type) == "array"
      and all(.labels[]; type == "object" and (.name | type) == "string")
    ' "$tmp/label-$number.json" >/dev/null || fail 'label fact malformed or terminal'
  done
  issue_label="$(jq -r 'any(.labels[]; .name == "human-review-required")' "$tmp/label-$issue.json")"
  pr_label="$(jq -r 'any(.labels[]; .name == "human-review-required")' "$tmp/label-$pr.json")"
}
if [ -z "$accepted" ]; then
  [ "$effective" = active ] && [ "$active" = "$source" ] \
    || fail 'pre-acceptance pause is not active'
  read_labels
  jq -cn --arg issue "$issue" --arg pr "$pr" \
    --arg issue_label "$issue_label" --arg pr_label "$pr_label" '
    {result:"pre_acceptance",actions:
      ([if $issue_label == "false" then
          {action:"add_issue_human_label",number:($issue | tonumber)} else empty end]
       + [if $pr_label == "false" then
          {action:"add_pr_human_label",number:($pr | tonumber)} else empty end])}'
  exit 0
fi
if [ "$effective" = active ]; then
  [ "$active" = "$(jq -r '.effective.pause_id' "$tmp/chain.json")" ] \
    || fail 'replacement pause relation mismatch'
  replacement="$active"
else
  [ "$effective" = consumed ] || fail 'accepted graph is inconsistent'
  replacement=''
fi

# Accepted comment creation time bounds normal runs. A run's existence alone
# never proves ownership: classify the Review job as the Failure Handler does.
gh api "/repos/$repo/issues/comments/$accepted" > "$tmp/accepted.json" \
  || fail 'accepted comment unavailable'
jq -e --argjson id "$accepted" --argjson app "$app_id" '
  .id == $id and .performed_via_github_app.id == $app
  and (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
' "$tmp/accepted.json" >/dev/null || fail 'accepted comment identity mismatch'
since="$(jq -r .created_at "$tmp/accepted.json")"
jq -e --arg since "$since" '.created_at <= $since and $since <= .updated_at' \
  "$tmp/attempt.json" >/dev/null || fail 'accepted record is outside source attempt lifetime'

# Review step names are only trusted when this PR cannot redefine the workflow.
gh api --paginate --slurp "/repos/$repo/pulls/$pr/files?per_page=100" \
  > "$tmp/files.json" || fail 'PR file list unavailable'
jq -e 'type == "array" and all(.[]; type == "array" and
  all(.[]; type == "object" and (.filename | type) == "string"))
  and (any(.[][]; .filename == ".github/workflows/claude-review.yml") | not)' \
  "$tmp/files.json" >/dev/null || fail 'Review workflow evidence is untrusted'

gh api --paginate --slurp "/repos/$repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100" \
  > "$tmp/runs.json" || fail 'normal Review history unavailable'
jq -e 'type == "array" and all(.[]; .workflow_runs | type == "array")' \
  "$tmp/runs.json" >/dev/null || fail 'normal Review history malformed'
jq -r --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" --arg head "$head" --arg since "$since" '
  .[].workflow_runs[]
  | select(.name == "Claude Review" and .event == "pull_request"
      and (.path | type == "string" and test("^\\.github/workflows/claude-review\\.yml(@|$)"))
      and .head_repository.full_name == $repo and .head_sha == $head
      and .head_branch == ("ai/issue-" + ($issue | tostring))
      and .created_at >= $since
      and any(.pull_requests[]?; .number == $pr and .head.sha == $head))
  | [.id, .run_attempt] | @tsv
' "$tmp/runs.json" > "$tmp/candidates.tsv" || fail 'normal Review identity malformed'
# Branch is checked against the canonical closing Issue separately below.
while IFS=$'\t' read -r review_id review_attempt; do
  [ -n "$review_id" ] || continue
  positive "$review_id" && positive "$review_attempt" || fail 'invalid Review attempt'
  gh api --paginate --slurp \
    "/repos/$repo/actions/runs/$review_id/attempts/$review_attempt/jobs?per_page=100" \
    > "$tmp/review-jobs.json" || fail 'Review job evidence unavailable'
  state="$(jq -er '
    if type != "array" or any(.[]; (.jobs | type) != "array") then error("jobs") end
    | [.[] .jobs[] | select(.name == "Review")]
    | if length != 1 then error("Review job ambiguity") else .[0] end
    | if .conclusion == "skipped" then "skipped"
      elif (.conclusion | IN("failure","cancelled","timed_out","stale")) then "entered"
      elif .conclusion == "success" or
           (.conclusion == null and (.status | IN("queued","in_progress","waiting","pending","requested"))) then
        [.steps[]? | select(.name == "Select Claude review model")]
        | if length == 0 then error("entry step not observed")
          elif length != 1 then error("entry step ambiguity") else .[0] end
        | if .status == "in_progress" or
             (.conclusion | IN("success","failure","cancelled","timed_out")) then "entered"
          elif .conclusion == "skipped" and (.status == "completed") then "skipped"
          else error("unknown entry state") end
      else error("unknown Review job state") end
  ' "$tmp/review-jobs.json")" || fail 'Review ownership ambiguous'
  if [ "$state" = entered ]; then
    read_labels
    jq -cn --argjson run "$review_id" --argjson attempt "$review_attempt" \
      '{result:"normal_review_owns",normal_review:{run_id:$run,attempt:$attempt},actions:[]}'
    exit 0
  fi
done < "$tmp/candidates.tsv"
[ -n "$replacement" ] || [ "$(jq -r .result "$tmp/graph-5.json")" = no_active_pause ] \
  || fail 'another active pause owns this Conversation'

# Fresh label facts determine a minimal, ordered repair. Existing replacement
# wins over a response-lost POST; labels are then reconciled without repeats.
read_labels
jq -cn --arg accepted "$accepted" --arg replacement "$replacement" \
  --arg issue "$issue" --arg pr "$pr" --arg issue_label "$issue_label" \
  --arg pr_label "$pr_label" '
  {result:"recover",accepted_record_id:$accepted,
   actions:([if $replacement == "" then
     {action:"create_or_reconcile_replacement_pause",source_pause_id:$accepted,
      reason:"resume_transition_failed",failed_action:"review"},
     {action:"revalidate_record_graph",requires:"one matching active replacement pause"}
     else empty end]
     + [if $issue_label == "false" then
          {action:"add_issue_human_label",number:($issue | tonumber)} else empty end]
     + [if $pr_label == "false" then
          {action:"add_pr_human_label",number:($pr | tonumber)} else empty end])}
  + if $replacement != "" then {replacement_pause_id:$replacement} else {} end
' || fail 'could not prepare recovery actions'
