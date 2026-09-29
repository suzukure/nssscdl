#!/usr/bin/env bash
set -euo pipefail

# Dormant, read-only recovery. The caller supplies a durable validation snapshot
# from trusted storage, never source-job stdout. Every mutable target fact is
# fetched again here; an absent snapshot permits only pre-acceptance repair.
repo="${1:?repository required}"
run_id="${2:?source run ID required}"
attempt="${3:?source attempt required}"
app_id="${4:?trusted App ID required}"
pr="${5:?PR number required}"
issue="${6:?closing Issue number required}"
source="${7:?source pause ID required}"
evidence="${8:--}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
head='' pr_head='' source_head='' accepted='' active='' draft='' machine=''
source_record='null' accepted_record='null' active_record='null'
issue_label='' pr_label='' candidates='[]'
fail() {
  echo "prepare-ai-resume-validate-recovery: $1 (run=$run_id attempt=$attempt pr=$pr issue=$issue source=$source)" >&2
  exit 1
}
diagnostics() {
  jq -cn --arg repo "$repo" --argjson run "$run_id" --argjson attempt "$attempt" \
    --argjson issue "$issue" --argjson pr "$pr" --arg source "$source" \
    --arg accepted "$accepted" --arg source_head "$source_head" \
    --arg head "$pr_head" --arg issue_label "$issue_label" \
    --arg pr_label "$pr_label" --arg draft "$draft" --arg machine "$machine" \
    --arg active "$active" --argjson source_record "$source_record" \
    --argjson accepted_record "$accepted_record" --argjson active_record "$active_record" \
    --argjson candidates "$candidates" '
    def known: if . == "" then null else . end;
    {target:{repository:$repo,issue_number:$issue,pr_number:$pr},
     source:{run_id:$run,attempt:$attempt,pause_id:$source,paused_head:($source_head|known),
       pause_record:$source_record,accepted_record_id:($accepted|known),
       accepted_record:$accepted_record},
     current:{head:($head|known),issue_human_label:($issue_label|known|if . == null then . else . == "true" end),
       pr_human_label:($pr_label|known|if . == null then . else . == "true" end),
       draft:($draft|known|if . == null then . else . == "true" end),
       machine_state:($machine|known|if . == null then . else . == "true" end),
       active_pause_id:($active|known),active_pause_record:$active_record,
       writer_ownership:null},normal_review:$candidates}'
}
emit() { jq -c --argjson diagnostics "$(diagnostics)" '. + {diagnostics:$diagnostics}'; }
manual() {
  jq -cn --arg code "$1" '{result:"manual_reconcile",code:$code,actions:[]}' | emit
  exit 0
}
positive() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
for value in "$run_id" "$attempt" "$app_id" "$pr" "$issue" "$source"; do
  positive "$value" || fail 'invalid numeric identity'
done
tmp="$(mktemp -d)" || fail 'temporary directory unavailable'
trap 'rm -rf "$tmp"' EXIT

gh api "/repos/$repo/actions/runs/$run_id" > "$tmp/run.json" || fail 'source run unavailable'
jq -e --arg repo "$repo" --argjson id "$run_id" --argjson attempt "$attempt" \
  --arg title "AI Resume Validate Consumer pr:$pr pause:$source" '
  .id == $id and .run_attempt == $attempt and .name == "AI Resume Validate Consumer"
  and .display_title == $title and .event == "repository_dispatch"
  and (.path | type == "string" and test("^\\.github/workflows/ai-resume-validate-consumer\\.yml(@|$)"))
  and .head_repository.full_name == $repo and .status == "completed"
  and (.conclusion | IN("failure","cancelled","timed_out"))
  and (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and (.updated_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and .created_at <= .updated_at
' "$tmp/run.json" >/dev/null || fail 'source run identity inconsistent'
gh api "/repos/$repo/actions/runs/$run_id/attempts/$attempt" > "$tmp/attempt.json" \
  || fail 'source attempt unavailable'
jq -e --argjson id "$run_id" --argjson attempt "$attempt" '
  .id == $id and .run_attempt == $attempt and .status == "completed"
  and (.conclusion | IN("failure","cancelled","timed_out"))
  and (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and (.updated_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and .created_at <= .updated_at
' "$tmp/attempt.json" >/dev/null || fail 'source attempt inconsistent'

command='{"result":"accepted","action":"validate","actor":"recovery"}'
bash "$script_dir/resolve-ai-resume-target.sh" "$repo" pr "$pr" <<< "$command" \
  > "$tmp/target.json" || fail 'target relation unavailable'
jq -e --argjson pr "$pr" --argjson issue "$issue" '
  .target == ("pr:" + ($pr | tostring)) and .closing_issue.number == $issue
  and .closing_issue.state == "open" and .pull_request.number == $pr
  and .pull_request.state == "open" and .pull_request.base_ref == "main"
  and .pull_request.head_ref == ("ai/issue-" + ($issue | tostring))
  and (.pull_request.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
' "$tmp/target.json" >/dev/null || fail 'target relation mismatch or terminal'
head="$(jq -r .pull_request.head_sha "$tmp/target.json")"
gh api "/repos/$repo/pulls/$pr" > "$tmp/pr.json" || fail 'PR state unavailable'
jq -e --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" '
  .number == $pr and .state == "open" and (.draft | type == "boolean")
  and .head.repo.full_name == $repo and .base.repo.full_name == $repo
  and .head.ref == ("ai/issue-" + $issue) and .base.ref == "main"
  and (.head.sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.labels | type == "array")
  and all(.labels[]; type == "object" and (.name | type) == "string")
' "$tmp/pr.json" >/dev/null || fail 'PR state malformed or relation changed'
pr_head="$(jq -r .head.sha "$tmp/pr.json")"
draft="$(jq -r .draft "$tmp/pr.json")"
machine="$(jq -r 'any(.labels[]; .name == "ai-followup-in-progress")' "$tmp/pr.json")"
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
  [ "$pr_label" = "$(jq -r 'any(.labels[]; .name == "human-review-required")' "$tmp/pr.json")" ] \
    || manual pr_label_changed_during_read
}
read_labels
[ "$pr_head" = "$head" ] || manual head_changed_during_read

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
jq -ce --arg source "$source" '
  [.chains[] | select(.pre_resume.pause_id == $source)]
  | if length != 1 then error("source chain is not unique") else .[0] end
  | if (.pre_resume.reason | IN("validation_failed","validation_timeout","resume_transition_failed") | not)
      or (.records[] | select(.pause_id == $source) | .record.paused_head
          | type != "string" or (test("^[0-9a-f]{40}$") | not))
    then error("source identity invalid") else . end
  | if .pre_resume.reason == "resume_transition_failed" and
       (.records[] | select(.pause_id == $source) | .record.payload.failed_action) != "validate"
    then error("source action invalid") else . end
  | [.records[] | select(.record.kind == "ai-resume-accepted")] as $accepted
  | if ($accepted | length) > 1 then error("multiple acceptances")
    elif ($accepted | length) == 1 and
       ($accepted[0].record.source_pause_id != $source or
        $accepted[0].record.reason != .pre_resume.reason or
        $accepted[0].record.payload.action != "validate" or
        $accepted[0].record.payload.accepted_head !=
          (.records[] | select(.pause_id == $source) | .record.paused_head))
    then error("accepted identity mismatch") else . end
' "$tmp/graph-4.json" > "$tmp/chain.json" || fail 'source or accepted identity mismatch'
accepted="$(jq -r '[.records[] | select(.record.kind == "ai-resume-accepted")][0].pause_id // empty' "$tmp/chain.json")"
source_head="$(jq -r --arg source "$source" '.records[] | select(.pause_id == $source) | .record.paused_head' "$tmp/chain.json")"
source_record="$(jq -c --arg source "$source" '.records[] | select(.pause_id == $source) | .record' "$tmp/chain.json")"
if [ -n "$accepted" ]; then
  accepted_record="$(jq -c --arg accepted "$accepted" '.records[] | select(.pause_id == $accepted) | .record' "$tmp/chain.json")"
fi
[ "$source_head" = "$head" ] || manual source_head_changed
effective="$(jq -r .effective.status "$tmp/chain.json")"
active="$(jq -r '.active_pause.pause_id // empty' "$tmp/graph-5.json")"
if [ -n "$active" ]; then
  active_record="$(jq -c --arg active "$active" '[.chains[].records[] | select(.pause_id == $active) | .record][0] // null' "$tmp/graph-4.json")"
fi
label_actions() {
  jq -cn --argjson issue "$issue" --argjson pr "$pr" \
    --arg issue_label "$issue_label" --arg pr_label "$pr_label" '
    [if $issue_label == "false" then {action:"add_issue_human_label",number:$issue} else empty end,
     if $pr_label == "false" then {action:"add_pr_human_label",number:$pr} else empty end]'
}
if [ -z "$accepted" ]; then
  [ "$effective" = active ] && [ "$active" = "$source" ] \
    || fail 'pre-acceptance pause is not active'
  read_labels
  jq -cn --argjson actions "$(label_actions)" \
    '{result:"pre_acceptance",actions:$actions}' | emit
  exit 0
fi
if [ "$effective" = active ]; then
  [ "$active" = "$(jq -r .effective.pause_id "$tmp/chain.json")" ] \
    || fail 'replacement pause relation mismatch'
  replacement="$active"
else
  [ "$effective" = consumed ] || fail 'accepted graph inconsistent'
  if [ -n "$active" ]; then
    jq -e --arg head "$head" --arg active "$active" --arg accepted "$accepted" '
      [.chains[] | select(.effective.status == "active" and .effective.pause_id == $active)]
      | length == 1 and (.[0].effective.reason | IN("validation_failed","validation_timeout","round_limit"))
        and (.[0].records[0].record.paused_head == $head)
        and (.[0].records[0].pause_id | tonumber) > ($accepted | tonumber)
    ' "$tmp/graph-4.json" >/dev/null || manual another_active_pause
  fi
  replacement=''
fi
gh api "/repos/$repo/issues/comments/$accepted" > "$tmp/accepted.json" \
  || fail 'accepted comment unavailable'
jq -e --argjson id "$accepted" --argjson app "$app_id" '
  .id == $id and .performed_via_github_app.id == $app
  and (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
' "$tmp/accepted.json" >/dev/null || fail 'accepted comment identity mismatch'
since="$(jq -r .created_at "$tmp/accepted.json")"
jq -e --arg since "$since" '.created_at <= $since and $since <= .updated_at' \
  "$tmp/attempt.json" >/dev/null || fail 'accepted outside source attempt'
started="$(date -u -d "$since" +%s)" || fail 'accepted timestamp invalid'
now="$(date -u +%s)" || fail 'current time unavailable'
[ "$now" -ge "$started" ] || fail 'accepted timestamp is in the future'
read_labels

# The Review job and model-selection step are the existing Failure Handler's
# ownership boundary. A queued run alone cannot establish handoff.
gh api --paginate --slurp "/repos/$repo/pulls/$pr/files?per_page=100" \
  > "$tmp/files.json" || fail 'PR file list unavailable'
jq -e 'type == "array" and all(.[]; type == "array" and
  all(.[]; type == "object" and (.filename | type) == "string"))
  and (any(.[][]; .filename == ".github/workflows/claude-review.yml") | not)' \
  "$tmp/files.json" >/dev/null || fail 'Review workflow evidence untrusted'
gh api --paginate --slurp "/repos/$repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100" \
  > "$tmp/runs.json" || fail 'normal Review history unavailable'
jq -e 'type == "array" and all(.[]; .workflow_runs | type == "array")' \
  "$tmp/runs.json" >/dev/null || fail 'normal Review history malformed'
jq -r --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" \
  --arg head "$head" --arg since "$since" '
  .[].workflow_runs[]
  | select(.name == "Claude Review" and .event == "pull_request"
      and (.path | type == "string" and test("^\\.github/workflows/claude-review\\.yml(@|$)"))
      and .head_repository.full_name == $repo and .head_sha == $head
      and .head_branch == ("ai/issue-" + ($issue | tostring))
      and .created_at >= $since
      and (.pull_requests | type == "array"))
  | if any(.pull_requests[]; .number == $pr and .head.sha == $head)
    then . else error("same-HEAD Review relation ambiguous") end
  | [.id, .run_attempt] | @tsv
' "$tmp/runs.json" > "$tmp/candidates.tsv" || fail 'normal Review identity malformed'
while IFS=$'\t' read -r review_id review_attempt; do
  [ -n "$review_id" ] || continue
  positive "$review_id" && positive "$review_attempt" || fail 'invalid Review attempt'
  gh api --paginate --slurp \
    "/repos/$repo/actions/runs/$review_id/attempts/$review_attempt/jobs?per_page=100" \
    > "$tmp/review-jobs.json" || fail 'Review job evidence unavailable'
  jq -e 'type == "array" and all(.[]; (.jobs | type) == "array")
    and ([.[] .jobs[] | select(.name == "Review")] | length == 1)' \
    "$tmp/review-jobs.json" >/dev/null || fail 'Review job evidence malformed'
  candidates="$(jq -cn --argjson prior "$candidates" --argjson run "$review_id" \
    --argjson attempt "$review_attempt" --slurpfile jobs "$tmp/review-jobs.json" '
    $prior + [{run_id:$run,attempt:$attempt,ownership:"unconfirmed",
      review_jobs:[$jobs[0][] .jobs[] | select(.name == "Review")]}]')"
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
          elif .conclusion == "skipped" and .status == "completed" then "skipped"
          else error("unknown entry state") end
      else error("unknown Review job state") end
  ' "$tmp/review-jobs.json" 2>/dev/null)" || manual review_ownership_unconfirmed
  candidates="$(jq -cn --argjson prior "$candidates" --arg state "$state" \
    '$prior | .[-1].ownership = $state')"
  if [ "$state" = entered ]; then
    jq -cn --argjson run "$review_id" --argjson attempt "$review_attempt" \
      '{result:"normal_review_owns",normal_review:{run_id:$run,attempt:$attempt},actions:[]}' | emit
    exit 0
  fi
done < "$tmp/candidates.tsv"

# A replacement is authoritative even after its POST response was lost.
if [ -n "$replacement" ]; then
  jq -cn --arg accepted "$accepted" --arg replacement "$replacement" \
    --argjson actions "$(label_actions)" --arg machine "$machine" '
    {result:"paused",accepted_record_id:$accepted,replacement_pause_id:$replacement,
     actions:($actions + [if $machine == "true" then
       {action:"remove_machine_label",requires:"fresh graph active and both human labels present"}
       else empty end])}' | emit
  exit 0
fi
if [ -n "$active" ]; then
  jq -cn --arg accepted "$accepted" --arg pause "$active" \
    --argjson actions "$(label_actions)" --arg machine "$machine" '
    {result:"paused",accepted_record_id:$accepted,validation_pause_id:$pause,
     actions:($actions + [if $machine == "true" then
       {action:"remove_machine_label",requires:"fresh graph active and both human labels present"}
       else empty end])}' | emit
  exit 0
fi

if [ "$draft" = false ] && [ "$machine" = false ]; then
  jq -cn --arg accepted "$accepted" --argjson labels "$(label_actions)" '
    {result:"recover",accepted_record_id:$accepted,
     actions:([{action:"create_or_reconcile_replacement_pause",source_pause_id:$accepted,
       reason:"resume_transition_failed",failed_action:"validate"},
       {action:"revalidate_record_graph",requires:"one matching active replacement pause"}]
       + $labels)}' | emit
  exit 0
fi

# Durable cycle and validation evidence must be supplied independently of the
# failed job. Its provenance is a future caller contract; absence never grants
# success or a validation-failure classification.
if [ "$evidence" = - ] || [ ! -f "$evidence" ]; then
  jq -cn --arg accepted "$accepted" --argjson started "$started" \
    '{result:"manual_reconcile",code:"durable_validation_evidence_missing",
      accepted_record_id:$accepted,window_started_at:$started,actions:[]}' | emit
  exit 0
fi
jq -e --argjson run "$run_id" --argjson attempt "$attempt" \
  --arg accepted "$accepted" --arg head "$head" '
  (keys | sort) == ["accepted_record_id","cycle","source_attempt","source_run_id","validation"]
  and .source_run_id == $run and .source_attempt == $attempt
  and .accepted_record_id == $accepted and .validation.current_head_sha == $head
' "$evidence" >/dev/null || fail 'durable evidence identity mismatch'
record="$(jq -c --arg accepted "$accepted" '.records[] | select(.pause_id == $accepted) | .record' "$tmp/chain.json")"
identity="$(jq -cn --argjson record "$record" --argjson issue "$issue" --argjson pr "$pr" '
  {action:"validate",closing_issue_number:$issue,
   command_comment_id:$record.payload.command_comment_id,head:$record.payload.accepted_head,
   pr_number:$pr,reason:$record.reason,source_pause_id:$record.source_pause_id,
   target:$record.target}')"
snapshot="$(jq -cn --argjson identity "$identity" --argjson record "$record" \
  --arg accepted "$accepted" --argjson started "$started" \
  --argjson now "$now" \
  --argjson evidence "$(cat "$evidence")" \
  --arg issue_label "$issue_label" --arg pr_label "$pr_label" \
  --arg draft "$draft" --arg machine "$machine" '
  {accepted:{record_id:$accepted,created_at:$started,identity:$identity,record:$record},
   cycle:$evidence.cycle,validation:($evidence.validation + {now:$now}),
   source_consumed:true,active_pause:"none",
   issue_label_absent:($issue_label == "false"),pr_label_absent:($pr_label == "false"),
   normal_review_suppressed:($draft == "true" or $machine == "true")}')"
cycle_result="$(bash "$script_dir/prepare-ai-resume-validate-cycle.sh" <<< "$snapshot")" \
  || fail 'validation cycle unavailable'
action="$(jq -r .action <<< "$cycle_result")"
code="$(jq -r .code <<< "$cycle_result")"
case "$action/$code" in
  wait/*) jq -cn --argjson cycle "$cycle_result" \
    '{result:"cycle_wait",cycle:$cycle,actions:[]}' | emit ;;
  pause_record/validation_failed|pause_record/validation_timeout|pause_record/round_limit)
    jq -cn --arg accepted "$accepted" --arg reason "$code" --arg head "$head" \
      --argjson labels "$(label_actions)" --arg machine "$machine" \
      '{result:"recover",accepted_record_id:$accepted,
        actions:([{action:"create_or_reconcile_validation_pause",reason:$reason,
          accepted_record_id:$accepted,paused_head:$head,failed_action:"validate"},
          {action:"revalidate_record_graph",requires:"one active validation pause"}]
          + $labels
          + [if $machine == "true" then
              {action:"remove_machine_label",requires:"fresh graph active and both human labels present"}
             else empty end])}' | emit ;;
  stop/labels_not_cleared|stop/review_suppression_unverified|handoff_candidate/success)
    jq -cn --arg accepted "$accepted" --argjson cycle "$cycle_result" \
      --argjson labels "$(label_actions)" --arg machine "$machine" \
      '{result:"recover",accepted_record_id:$accepted,cycle:$cycle,
        actions:([{action:"create_or_reconcile_replacement_pause",source_pause_id:$accepted,
          reason:"resume_transition_failed",failed_action:"validate"},
          {action:"revalidate_record_graph",requires:"one matching active replacement pause"}]
          + $labels
          + [if $machine == "true" then
              {action:"remove_machine_label",requires:"fresh graph active and both human labels present"}
             else empty end])}' | emit ;;
  *) manual "$code" ;;
esac
