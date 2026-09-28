#!/usr/bin/env bash
set -euo pipefail

# Runs only under the canonical per-Issue writer lock, from the default branch.
repo="${1:?repository required}"
app_slug="${2:?developer App slug required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "consume-ai-resume-review: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
envelope="$(head -c 11001)" || fail 'dispatch unavailable'
[ "${#envelope}" -le 11000 ] || fail 'oversized dispatch'
dispatch="$(jq -cse '
  if length != 1 or (.[0] | type) != "object" then error("envelope") else .[0] end
  | if keys != ["dispatch","version"] or .version != 1 or (.dispatch | type) != "object"
    then error("envelope shape") else .dispatch end
' <<< "$envelope")" || fail 'malformed envelope'
app_id="$(gh api "/apps/$app_slug" --jq .id)" || fail 'App identity unavailable'
[[ "$app_id" =~ ^[1-9][0-9]*$ ]] || fail 'invalid App identity'
candidate="$(bash "$script_dir/prepare-ai-resume-review-consumer.sh" "$repo" "$app_id" <<< "$dispatch")" \
  || fail 'trusted gate failed'
[ "$(jq -r .result <<< "$candidate")" = accepted_candidate ] || exit 0
issue="$(jq -r .identity.closing_issue_number <<< "$candidate")"
pr="$(jq -r .identity.pr_number <<< "$candidate")"
source="$(jq -r .identity.source_pause_id <<< "$candidate")"
record="$(jq -c .accepted_record <<< "$candidate")"

# The workflow run display title persists PR and source pause before any write.
# Recovery validates it against the completed attempt and the fresh record graph.
[[ "${GITHUB_WORKFLOW:-}" == 'AI Resume Review Consumer' ]] || fail 'wrong workflow'
[[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || fail 'missing durable run identity'

read_graph() {
  bash "$script_dir/list-human-pause-records.sh" "$repo" "$issue" "$pr" "$app_id" |
    bash "$script_dir/validate-human-pause-record-graph.sh" |
    bash "$script_dir/decompose-human-pause-record-graph.sh" |
    bash "$script_dir/derive-human-pause-pre-resume-state.sh" |
    bash "$script_dir/reconcile-human-pause-resume-acceptance.sh"
}
accepted_id() {
  local graph="$1"
  jq -er --argjson record "$record" '
    [.chains[].records[] | select(.record == $record) | .pause_id]
    | if length == 1 then .[0] else error("accepted identity absent or ambiguous") end
  ' <<< "$graph"
}
label_state() {
  local number="$1" fact
  fact="$(gh api "/repos/$repo/issues/$number")" || return 1
  jq -er --argjson number "$number" '
    if .number == $number and .state == "open" and (.labels | type) == "array"
      and all(.labels[]; type == "object" and (.name | type) == "string")
    then if any(.labels[]; .name == "human-review-required") then "present" else "absent" end
    else error("invalid label fact") end
  ' <<< "$fact"
}

body="$(bash "$script_dir/human-pause-record.sh" create "$record")" || fail 'invalid accepted record'
# On a lost POST response, relist before any retry. No second POST is attempted.
if posted="$(gh api -X POST "/repos/$repo/issues/$pr/comments" -f "body=$body")"; then
  posted_id="$(jq -er '.id | if type == "number" and . > 0 and floor == . then tostring else error("ID") end' \
    <<< "$posted")" || posted_id=''
else
  posted_id=''
fi
graph="$(read_graph)" || fail 'accepted record graph unavailable'
accepted="$(accepted_id "$graph")" || fail 'accepted record not uniquely visible'
[ -z "$posted_id" ] || [ "$accepted" = "$posted_id" ] || fail 'POST response differs from trusted record'
active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$graph")" || fail 'active graph unavailable'
jq -e --arg target "pr:$pr" --arg source "$source" --arg accepted "$accepted" '
  .target == $target and any(.chains[];
    .effective.status == "consumed" and .effective.pause_id == $source
    and .effective.accepted_record_id == $accepted)
' <<< "$graph" >/dev/null || fail 'source not consumed by accepted record'
jq -e '.result == "no_active_pause"' <<< "$active" >/dev/null || fail 'another pause is active'

[ "$(label_state "$issue")" = present ] || fail 'closing Issue label changed before transition'
# A failed API call may still have removed the label; a fresh read settles it.
if ! gh issue edit "$issue" --repo "$repo" --remove-label human-review-required; then
  [ "$(label_state "$issue")" = absent ] || fail 'Issue label removal failed'
fi
[ "$(label_state "$issue")" = absent ] || fail 'Issue label removal unconfirmed'
[ "$(label_state "$pr")" = present ] || fail 'PR label changed before transition'
if ! gh issue edit "$pr" --repo "$repo" --remove-label human-review-required; then
  [ "$(label_state "$pr")" = absent ] || fail 'PR label removal failed'
fi
[ "$(label_state "$pr")" = absent ] || fail 'PR label removal unconfirmed'

# A successful label edit is not proof that the normal Review took ownership.
# Wait for the same-HEAD Review job to reach model selection. A skipped or
# unrelated run makes this consumer fail so independent recovery can decide.
accepted_fact="$(gh api "/repos/$repo/issues/comments/$accepted")" || fail 'accepted timestamp unavailable'
since="$(jq -er --argjson id "$accepted" --argjson app "$app_id" '
  if .id == $id and .performed_via_github_app.id == $app
    and (.created_at | type) == "string" and (.created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  then .created_at else error("accepted identity") end
' <<< "$accepted_fact")" || fail 'accepted timestamp invalid'
head="$(jq -r .identity.head <<< "$candidate")"
for poll in {1..90}; do
  runs="$(GH_TOKEN="${READ_TOKEN:-$GH_TOKEN}" gh api --paginate --slurp \
    "/repos/$repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100")" \
    || fail 'normal Review history unavailable'
  candidates="$(jq -r --arg repo "$repo" --argjson pr "$pr" --arg head "$head" --arg since "$since" '
    if type != "array" or any(.[]; (.workflow_runs | type) != "array") then error("runs") end
    | .[].workflow_runs[] | select(.name == "Claude Review" and .event == "pull_request"
      and (.path | type == "string" and test("^\\.github/workflows/claude-review\\.yml(@|$)"))
      and .head_repository.full_name == $repo and .head_sha == $head
      and .created_at >= $since and any(.pull_requests[]?; .number == $pr and .head.sha == $head))
    | [.id,.run_attempt] | @tsv
  ' <<< "$runs")" || fail 'normal Review history malformed'
  while IFS=$'\t' read -r review_id review_attempt; do
    [ -n "$review_id" ] || continue
    [[ "$review_id" =~ ^[1-9][0-9]*$ && "$review_attempt" =~ ^[1-9][0-9]*$ ]] \
      || fail 'normal Review attempt invalid'
    jobs="$(GH_TOKEN="${READ_TOKEN:-$GH_TOKEN}" gh api --paginate --slurp \
      "/repos/$repo/actions/runs/$review_id/attempts/$review_attempt/jobs?per_page=100")" \
      || fail 'normal Review job unavailable'
    state="$(jq -er '
      if type != "array" or any(.[]; (.jobs | type) != "array") then error("jobs") end
      | [.[] .jobs[] | select(.name == "Review")]
      | if length != 1 then error("Review job ambiguity") else .[0] end
      | if .conclusion == "skipped" then "skipped"
        elif [.steps[]? | select(.name == "Select Claude review model")]
          | length == 1 and (.[0].status == "in_progress" or
            (.[0].conclusion | IN("success","failure","cancelled","timed_out")))
          then "entered"
        elif .status == "completed" then "skipped"
        else "pending" end
    ' <<< "$jobs")" || fail 'normal Review job ambiguous'
    [ "$state" = entered ] && exit 0
    [ "$state" = skipped ] && fail 'normal Review did not enter model selection'
  done <<< "$candidates"
  [ "$poll" -lt 90 ] || fail 'normal Review handoff not observed'
  sleep 5
done
