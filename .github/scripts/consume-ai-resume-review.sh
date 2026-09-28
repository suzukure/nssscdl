#!/usr/bin/env bash
set -euo pipefail

# Run only in the canonical Issue writer, with a trusted default-branch helper.
repo="${1:?repository required}"
app_id="${2:?App ID required}"
issue="${3:?trusted closing Issue required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "consume-ai-resume-review: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ &&
   "$app_id" =~ ^[1-9][0-9]*$ && "$issue" =~ ^[1-9][0-9]*$ ]] || fail 'invalid identity'
dispatch="$(cat)" || fail 'dispatch unavailable'
candidate="$(bash "$script_dir/prepare-ai-resume-review-consumer.sh" "$repo" "$app_id" <<< "$dispatch")" \
  || fail 'prepared gate unavailable'
case "$(jq -er '.result' <<< "$candidate")" in
  ignore) echo "ignore:$(jq -r .code <<< "$candidate")"; exit 0 ;;
  accepted_candidate) ;;
  *) fail 'invalid prepared result' ;;
esac
jq -e --argjson issue "$issue" '.identity.closing_issue_number == $issue' \
  <<< "$candidate" >/dev/null || fail 'writer identity changed'
pr="$(jq -er '.identity.pr_number' <<< "$candidate")"
source="$(jq -er '.identity.source_pause_id' <<< "$candidate")"
head="$(jq -er '.identity.head' <<< "$candidate")"
record="$(jq -c '.accepted_record' <<< "$candidate")"
body="$(bash "$script_dir/human-pause-record.sh" create "$record")" || fail 'record unavailable'
export AI_RESUME_MAX_HISTORY_PAGES=10

graph() {
  bash "$script_dir/list-human-pause-records.sh" "$repo" "$issue" "$pr" "$app_id" |
    bash "$script_dir/validate-human-pause-record-graph.sh" |
    bash "$script_dir/decompose-human-pause-record-graph.sh" |
    bash "$script_dir/derive-human-pause-pre-resume-state.sh" |
    bash "$script_dir/reconcile-human-pause-resume-acceptance.sh"
}
current() {
  local facts
  facts="$(gh api "/repos/$repo/pulls/$pr")" || return 1
  jq -e --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" --arg head "$head" '
    .number == $pr and .state == "open" and .draft == false
    and .head.repo.full_name == $repo and .base.repo.full_name == $repo
    and .head.ref == ("ai/issue-" + $issue) and .base.ref == "main"
    and .head.sha == $head
  ' <<< "$facts" >/dev/null
}
label() {
  local number="$1" facts
  facts="$(gh api "/repos/$repo/issues/$number")" || return 1
  jq -er --argjson number "$number" '
    if .number == $number and .state == "open" and (.labels | type) == "array"
       and all(.labels[]; type == "object" and (.name | type) == "string")
    then if any(.labels[]; .name == "human-review-required") then "present" else "absent" end
    else error("invalid label fact") end
  ' <<< "$facts"
}
accepted_id() {
  jq -er --argjson record "$record" '
    [.chains[].records[] | select(.record == $record) | .pause_id]
    | if length == 1 then .[0] else error("acceptance is absent or ambiguous") end
  ' <<< "$1"
}
verify_graph() {
  local state active id
  state="$(graph)" || return 1
  id="$(accepted_id "$state")" || return 1
  jq -e --arg source "$source" --arg id "$id" '
    [.chains[] | select(.effective.pause_id == $source and
      .effective.status == "consumed" and .effective.accepted_record_id == $id)]
    | length == 1
  ' <<< "$state" >/dev/null || return 1
  active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$state")" || return 1
  jq -e --arg target "pr:$pr" '.target == $target and .result == "no_active_pause"' \
    <<< "$active" >/dev/null || return 1
  printf '%s\n' "$id"
}

# A failed POST may have committed. Re-list once and never repeat an uncertain write.
before="$(graph)" || fail 'source graph unavailable'
if accepted_id "$before" >/dev/null 2>&1; then fail 'acceptance already exists'; fi
current && [ "$(label "$issue")" = present ] && [ "$(label "$pr")" = present ] \
  || fail 'target or pause labels changed'
if ! posted="$(gh api -X POST "/repos/$repo/issues/$pr/comments" -f "body=$body")"; then
  echo 'acceptance POST response uncertain; reconciling trusted graph' >&2
else
  jq -e '.id | type == "number" and floor == . and . > 0' <<< "$posted" >/dev/null \
    || fail 'invalid acceptance response'
fi
accepted="$(verify_graph)" || fail 'acceptance or graph could not be confirmed'

# Each removal is followed by a fresh absence check, including response loss.
current && [ "$(label "$issue")" = present ] || fail 'Issue transition facts changed'
if ! gh issue edit "$issue" --repo "$repo" --remove-label human-review-required; then
  echo 'Issue label write response uncertain; checking current fact' >&2
fi
[ "$(label "$issue")" = absent ] || fail 'Issue label removal unconfirmed'
current && [ "$(verify_graph)" = "$accepted" ] && [ "$(label "$pr")" = present ] \
  || fail 'PR transition facts changed'
if ! gh issue edit "$pr" --repo "$repo" --remove-label human-review-required; then
  echo 'PR label write response uncertain; checking current fact' >&2
fi
current && [ "$(label "$issue")" = absent ] && [ "$(label "$pr")" = absent ] \
  || fail 'PR label removal unconfirmed'

# The App's PR-unlabeled event enters the existing normal Review. Observe the
# same HEAD's Review job and model-selection step; queued runs are not ownership.
accepted_fact="$(gh api "/repos/$repo/issues/comments/$accepted")" || fail 'acceptance time unavailable'
since="$(jq -er --argjson id "$accepted" --argjson app "$app_id" '
  select(.id == $id and .performed_via_github_app.id == $app)
  | .created_at | select(type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
' <<< "$accepted_fact")" || fail 'acceptance provenance unavailable'
# Review step names are trusted only when this PR leaves the workflow intact.
files="$(gh api --paginate --slurp "/repos/$repo/pulls/$pr/files?per_page=100")" \
  || fail 'PR file list unavailable'
jq -e 'type == "array" and all(.[]; type == "array" and
  all(.[]; type == "object" and (.filename | type) == "string"))
  and (any(.[][]; .filename == ".github/workflows/claude-review.yml") | not)' \
  <<< "$files" >/dev/null || fail 'Review workflow evidence is untrusted'
for poll in {1..9}; do
  current || fail 'HEAD changed during Review handoff'
  runs="$(gh api --paginate --slurp "/repos/$repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100")" \
    || fail 'Review runs unavailable'
  candidates="$(jq -r --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" \
    --arg head "$head" --arg since "$since" '
    if type != "array" or any(.[]; (.workflow_runs | type) != "array") then error("runs") end
    | [.[] .workflow_runs[] | select(.name == "Claude Review" and .event == "pull_request"
      and (.path | type == "string" and test("^\\.github/workflows/claude-review\\.yml(@|$)"))
      and .head_repository.full_name == $repo and .head_sha == $head
      and .head_branch == ("ai/issue-" + $issue) and .created_at >= $since
      and any(.pull_requests[]?; .number == $pr and .head.sha == $head))]
    | unique_by(.id) | .[]
    | [.id,.run_attempt] | @tsv
  ' <<< "$runs")" || fail 'Review identity ambiguous'
  entered=0
  waiting=0
  while IFS=$'\t' read -r review_id review_attempt; do
    [ -n "$review_id" ] || continue
    [[ "$review_id" =~ ^[1-9][0-9]*$ && "$review_attempt" =~ ^[1-9][0-9]*$ ]] \
      || fail 'invalid Review attempt'
    jobs="$(gh api --paginate --slurp \
      "/repos/$repo/actions/runs/$review_id/attempts/$review_attempt/jobs?per_page=100")" \
      || fail 'Review jobs unavailable'
    state="$(jq -er '
      if type != "array" or any(.[]; (.jobs | type) != "array") then error("jobs") end
      | [.[] .jobs[] | select(.name == "Review")]
      | if length == 0 then "waiting"
        elif length != 1 then error("Review job ambiguity")
        else .[0] | if (.conclusion | IN("failure","cancelled","timed_out","stale"))
          then "entered"
          elif .conclusion == "skipped" then "declined"
          else [.steps[]? | select(.name == "Select Claude review model")]
            | if length == 0 then "waiting"
              elif length != 1 then error("entry step ambiguity")
              elif .[0].status == "in_progress" or
                   (.[0].conclusion | IN("success","failure","cancelled","timed_out"))
              then "entered"
              elif .[0].conclusion == "skipped" then "declined"
              else "waiting" end
          end end
    ' <<< "$jobs")" || fail 'Review ownership ambiguous'
    case "$state" in
      entered) entered=$((entered + 1)); owner="$review_id" ;;
      waiting) waiting=$((waiting + 1)) ;;
      declined) ;;
    esac
  done <<< "$candidates"
  [ "$entered" -le 1 ] || fail 'multiple normal Reviews entered'
  if [ "$entered" -eq 1 ] && [ "$waiting" -eq 0 ]; then
    echo "normal Review owns pr:$pr head:$head run:$owner"
    exit 0
  fi
  [ "$poll" -lt 9 ] || break
  sleep 10
done
fail 'normal Review entry remains undetermined'
