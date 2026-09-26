#!/usr/bin/env bash
set -euo pipefail

# Runs only after the canonical Issue writer concurrency group is acquired.
repo="${1:?repository is required}"
app_slug="${2:?developer App slug is required}"
output="${3:?GitHub output path is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "consume-ai-resume-develop: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
dispatch="$(cat)" || fail 'could not read dispatch'
jq -e '
  type == "object" and
  (keys == ["action","actor","closing_issue_number","follow_up_issue",
            "pause_issue_body_fingerprint","paused_head","pr_number",
            "prepared_head","prepared_issue_body_fingerprint","reason",
            "source_pause_id","target","version"]) and
  .version == 1 and .action == "develop" and
  (.actor | type == "string" and length > 0) and
  (.source_pause_id | type == "string" and test("^[1-9][0-9]*$")) and
  (.closing_issue_number | type == "number" and floor == . and . > 0) and
  (.target | type == "string" and test("^(issue|pr):[1-9][0-9]*$")) and
  .follow_up_issue == null
' <<< "$dispatch" >/dev/null || fail 'malformed dispatch'
issue="$(jq -r '.closing_issue_number' <<< "$dispatch")"
target="$(jq -r '.target' <<< "$dispatch")"
kind="${target%%:*}"
number="${target#*:}"
app_id="$(gh api "/apps/$app_slug" --jq '.id')" || fail 'could not resolve App identity'
[[ "$app_id" =~ ^[1-9][0-9]*$ ]] || fail 'invalid App identity'
command="$(jq -c '{result:"accepted",action,actor}' <<< "$dispatch")"
context="$(bash "$script_dir/build-ai-resume-prepare-context.sh" \
  "$repo" "$kind" "$number" "$app_id" <<< "$command")" || fail 'trusted revalidation failed'
prepared="$(bash "$script_dir/prepare-ai-resume.sh" <<< "$context")" || fail 'resume policy failed'
jq -e --argjson snapshot "$dispatch" \
  '.result == "prepared" and .dispatch == $snapshot' <<< "$prepared" >/dev/null \
  || fail 'stale or rejected dispatch'
pr="$(jq -r '.pr_number // "-"' <<< "$dispatch")"
[[ "$target" == "issue:$issue" && "$pr" == '-' || "$target" == "pr:$pr" ]] \
  || fail 'target relation mismatch'
conversation="$number"
source="$(jq -r '.source_pause_id' <<< "$dispatch")"
reason="$(jq -r '.reason' <<< "$dispatch")"
actor="$(jq -r '.actor' <<< "$dispatch")"

# A dispatch cannot prove that a trusted human issued the command. Find the
# actual later command comment on this Conversation within the same page cap.
command_found=false
for page in {1..10}; do
  comments="$(gh api -H 'Accept: application/vnd.github+json' \
    "/repos/$repo/issues/$conversation/comments?per_page=100&page=$page")" \
    || fail 'could not fetch command history'
  count="$(jq -er 'if type == "array" then length else error("invalid comments") end' <<< "$comments")" \
    || fail 'invalid command history'
  if jq -e --arg actor "$actor" --arg source "$source" '
    def later($id): ($id | length) > ($source | length) or
      (($id | length) == ($source | length) and $id > $source);
    any(.[]; (.id | type) == "number" and .id > 0 and (.id | floor) == .id and
      ((.id | tostring) | test("^[1-9][0-9]*$") and later(.)) and
      .body == "/ai resume develop" and .user.login == $actor and
      (.author_association | IN("OWNER","MEMBER","COLLABORATOR")))
  ' <<< "$comments" >/dev/null; then
    command_found=true
  fi
  if [ "$count" -lt 100 ]; then break; fi
  if [ "$page" -eq 10 ]; then fail 'command history exceeds bound'; fi
done
[ "$command_found" = true ] || fail 'trusted command was not found after source pause'

# Labels are checked before ACK. A missing label is an inconsistent transition.
label_state() {
  local metadata
  metadata="$(gh issue view "$1" --repo "$repo" --json labels)" || return 1
  jq -er 'if (.labels | type) == "array" and
             all(.labels[]; type == "object" and (.name | type) == "string")
          then if any(.labels[]; .name == "human-review-required")
               then "present" else "absent" end
          else error("invalid labels") end' <<< "$metadata"
}
[ "$(label_state "$issue")" = present ] || fail 'closing Issue pause label is absent'
if [ "$pr" != '-' ]; then [ "$(label_state "$pr")" = present ] || fail 'PR pause label is absent'; fi

accepted_id=''
acceptance_attempted=false
transition_done=false
recover() {
  status=$?
  trap - ERR
  if [ "$acceptance_attempted" = true ] && [ -z "$accepted_id" ]; then
    if observed="$(bash "$script_dir/list-human-pause-records.sh" "$repo" "$issue" "$pr" "$app_id")"; then
      accepted_id="$(jq -er --argjson record "$record" '
        [.records[] | select(.record == $record) | .pause_id] |
        if length == 1 then .[0] else error("ACK identity is ambiguous") end
      ' <<< "$observed")" || accepted_id=''
    fi
  fi
  if [ -n "$accepted_id" ] && [ "$transition_done" = false ]; then
    echo 'consume-ai-resume-develop: failure after accepted record; restoring machine pause.' >&2
    replacement="$(jq -cn --arg target "$target" --arg source "$accepted_id" \
      '{version:1,kind:"pause",reason:"resume_transition_failed",target:$target,
        source_pause_id:$source,payload:{failed_action:"develop"}}')"
    if body="$(bash "$script_dir/human-pause-record.sh" create "$replacement")"; then
      gh api -X POST "/repos/$repo/issues/$conversation/comments" -f "body=$body" >/dev/null || true
    fi
    bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" || true
  elif [ "$acceptance_attempted" = true ]; then
    echo 'consume-ai-resume-develop: ACK outcome is uncertain; pause labels were not intentionally removed.' >&2
  fi
  exit "$status"
}
trap recover ERR
record="$(jq -cn --arg target "$target" --arg source "$source" --arg reason "$reason" \
  --arg actor "$actor" \
  '{version:1,kind:"ai-resume-accepted",reason:$reason,target:$target,
    source_pause_id:$source,payload:{action:"develop",accepted_actor:$actor}}')"
body="$(bash "$script_dir/human-pause-record.sh" create "$record")"
acceptance_attempted=true
posted="$(gh api -X POST "/repos/$repo/issues/$conversation/comments" -f "body=$body")"
accepted_id="$(jq -er '.id | if type == "number" and floor == . and . > 0 then tostring else error("invalid ACK ID") end' <<< "$posted")"

# Observe trusted App provenance and the complete lifecycle pipeline before labels move.
listing="$(bash "$script_dir/list-human-pause-records.sh" "$repo" "$issue" "$pr" "$app_id")"
state="$(printf '%s\n' "$listing" |
  bash "$script_dir/validate-human-pause-record-graph.sh" |
  bash "$script_dir/decompose-human-pause-record-graph.sh" |
  bash "$script_dir/derive-human-pause-pre-resume-state.sh" |
  bash "$script_dir/reconcile-human-pause-resume-acceptance.sh")"
active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$state")"
jq -e --arg source "$source" --arg accepted "$accepted_id" --argjson record "$record" '
  any(.chains[]; .effective.status == "consumed" and
      .effective.pause_id == $source and .effective.accepted_record_id == $accepted and
      any(.records[]; .pause_id == $accepted and .record == $record))
' <<< "$state" >/dev/null
jq -e --arg target "$target" '.target == $target and .result == "no_active_pause"' \
  <<< "$active" >/dev/null

gh issue edit "$issue" --repo "$repo" --remove-label human-review-required
if [ "$pr" != '-' ]; then
  gh issue edit "$pr" --repo "$repo" --remove-label human-review-required
fi
[ "$(label_state "$issue")" = absent ] || { echo 'closing Issue label not confirmed absent' >&2; false; }
if [ "$pr" != '-' ]; then
  [ "$(label_state "$pr")" = absent ] || { echo 'PR label not confirmed absent' >&2; false; }
fi
printf 'issue_number=%s\naccepted=true\n' "$issue" >> "$output"
transition_done=true
trap - ERR
