#!/usr/bin/env bash
set -euo pipefail

# Prepared, read-only boundary. Run from the trusted base with a trusted App token.
repo="${1:?repository is required}"
app_id="${2:?trusted App ID is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "prepare-ai-resume-validate-consumer: $1" >&2; exit 1; }
ignore() { jq -cn --arg code "$1" '{result:"ignore",code:$code}'; exit 0; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
[[ "$app_id" =~ ^[1-9][0-9]*$ ]] || fail 'invalid App ID'
dispatch="$(head -c 10001)" || fail 'could not read dispatch'
[ "${#dispatch}" -le 10000 ] || fail 'oversized dispatch'
jq -cse '
  def positive: type == "number" and floor == . and . > 0;
  def sha: type == "string" and test("\\A[0-9a-f]{40}\\z");
  def fingerprint: type == "string" and test("\\Asha256:[0-9a-f]{64}\\z");
  if length != 1 or (.[0] | type) != "object" then error("one dispatch required") end
  | .[0] | if (keys) != ["action","actor","closing_issue_number","follow_up_issue",
                           "pause_issue_body_fingerprint","paused_head","pr_number",
                           "prepared_head","prepared_issue_body_fingerprint","reason",
                           "source_pause_id","target","version"]
       or .version != 1 or .action != "validate" or .follow_up_issue != null
       or (.actor | type) != "string" or (.actor | length) == 0 or (.actor | length) > 100
       or (.source_pause_id | type) != "string"
       or (.source_pause_id | test("\\A[1-9][0-9]*\\z") | not)
       or (.closing_issue_number | positive | not) or (.pr_number | positive | not)
       or .target != ("pr:" + (.pr_number | tostring))
       or (.paused_head | sha | not)
       or (.prepared_head | sha | not)
       or (.prepared_issue_body_fingerprint | fingerprint | not)
       or (.pause_issue_body_fingerprint != null and
           (.pause_issue_body_fingerprint | fingerprint | not))
       or (.reason | IN("validation_failed","validation_timeout",
                        "resume_transition_failed") | not)
  then error("invalid validate dispatch") else . end
' <<< "$dispatch" >/dev/null || fail 'malformed dispatch'
pr="$(jq -r '.pr_number' <<< "$dispatch")"
issue="$(jq -r '.closing_issue_number' <<< "$dispatch")"
source="$(jq -r '.source_pause_id' <<< "$dispatch")"
actor="$(jq -r '.actor' <<< "$dispatch")"
head="$(jq -r '.prepared_head' <<< "$dispatch")"
reason="$(jq -r '.reason' <<< "$dispatch")"

# Existing target, active-pause graph, and policy are the canonical read path.
export AI_RESUME_MAX_HISTORY_PAGES=10
command="$(jq -c '{result:"accepted",action,actor}' <<< "$dispatch")"
context="$(bash "$script_dir/build-ai-resume-prepare-context.sh" \
  "$repo" pr "$pr" "$app_id" <<< "$command")" || fail 'trusted context unavailable'
prepared="$(bash "$script_dir/prepare-ai-resume.sh" <<< "$context")" || fail 'resume policy unavailable'
jq -e --argjson snapshot "$dispatch" \
  '.result == "prepared" and
   (.dispatch | del(.prepared_head)) == ($snapshot | del(.prepared_head))' \
  <<< "$prepared" >/dev/null \
  || ignore 'stale_or_consumed'

# The REST PR response establishes same-repository current HEAD facts that
# the shared PREPARE context does not carry.
# PREPARE does not apply a validate same-HEAD policy. The pause payload must
# nevertheless authorize validate for a transition failure.
jq -e --arg reason "$reason" '
  .pause.result == "active" and .pause.reason == $reason
  and (.pause.record.kind | IN("pause","pause-normalization"))
  and (if $reason == "resume_transition_failed" then
         .pause.record.payload.failed_action == "validate"
       else true end)
' <<< "$context" >/dev/null || ignore 'invalid_source_action'

pr_fact="$(gh api "/repos/$repo/pulls/$pr")" || fail 'PR fact unavailable'
jq -e --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" --arg head "$head" '
  type == "object" and .number == $pr and .state == "open" and (.draft | type) == "boolean"
  and .head.repo.full_name == $repo and .base.repo.full_name == $repo
  and .head.ref == ("ai/issue-" + $issue) and .base.ref == "main"
  and (.head.sha | type == "string" and test("\\A[0-9a-f]{40}\\z"))
' <<< "$pr_fact" >/dev/null || ignore 'invalid_pr'
current_head="$(jq -r '.head.sha' <<< "$pr_fact")"
fresh_head="$(jq -r '.dispatch.prepared_head' <<< "$prepared")"
[ "$current_head" = "$fresh_head" ] || ignore 'stale_head'
[ "$(jq -r '.paused_head' <<< "$dispatch")" = "$current_head" ] \
  || ignore 'changed_head_evidence_unsupported'
[ "$current_head" = "$head" ] || ignore 'changed_head_evidence_unsupported'

for number in "$issue" "$pr"; do
  labels="$(gh api "/repos/$repo/issues/$number")" || fail 'label fact unavailable'
  jq -e --argjson number "$number" '
    type == "object" and .number == $number and (.labels | type) == "array"
    and all(.labels[]; type == "object" and (.name | type) == "string")
    and any(.labels[]; .name == "human-review-required")
  ' <<< "$labels" >/dev/null || ignore 'missing_human_label'
done

# A dispatch actor is untrusted. Require the exact later human command in the
# same Conversation; retain its REST ID for deterministic reconciliation.
command_id=''
for page in {1..10}; do
  comments="$(gh api -H 'Accept: application/vnd.github+json' \
    "/repos/$repo/issues/$pr/comments?per_page=100&page=$page")" || fail 'command history unavailable'
  count="$(jq -er 'if type == "array" and length <= 100 and
    all(.[]; type == "object" and (.id | type) == "number" and .id > 0
      and .id == (.id | floor) and (.body | type) == "string"
      and (.user.login | type) == "string"
      and (.author_association | type) == "string")
    then length else error("invalid page") end' <<< "$comments")" \
    || fail 'invalid command history'
  found="$(jq -r --arg actor "$actor" --arg source "$source" '
    def later($id): ($id | length) > ($source | length) or
      (($id | length) == ($source | length) and $id > $source);
    [.[] | select((.id | type) == "number" and .id > 0 and .id == (.id | floor)
      and ((.id | tostring) | later(.))
      and .body == "/ai resume validate" and .user.login == $actor
      and (.author_association | IN("OWNER","MEMBER","COLLABORATOR")))
      | .id] | min // empty
  ' <<< "$comments")" || fail 'invalid command history'
  if [ -n "$found" ] && { [ -z "$command_id" ] || [ "$found" -lt "$command_id" ]; }; then
    command_id="$found"
  fi
  if [ "$count" -lt 100 ]; then break; fi
  [ "$page" -lt 10 ] || fail 'command history exceeds bound'
done
[ -n "$command_id" ] || ignore 'command_provenance_missing'

jq -cn --argjson dispatch "$dispatch" --arg command_id "$command_id" '
  $dispatch as $d
  | {result:"accepted_candidate",
     identity:{target:$d.target,source_pause_id:$d.source_pause_id,
       command_comment_id:$command_id,reason:$d.reason,action:"validate",
       closing_issue_number:$d.closing_issue_number,pr_number:$d.pr_number,
       head:$d.prepared_head},
     accepted_record:{version:1,kind:"ai-resume-accepted",reason:$d.reason,
       target:$d.target,source_pause_id:$d.source_pause_id,
       payload:{action:"validate",accepted_actor:$d.actor,
         command_comment_id:$command_id,accepted_head:$d.prepared_head}},
     requalification:{head_relation:"same_head",changed_head:"unsupported_without_trusted_gate_and_write_evidence"},
     reconciliation:{conversation:$d.target, trusted_app_record_required:true,
       match:"exact accepted_record and source_pause_id; one matching record only",
       response_loss:"relist trusted records before any retry; reuse one matching record ID, stop on ambiguity",
       consumed:"matched accepted record ID and source consumed with no active pause"},
     sequence:[
       {action:"create_or_reconcile_accepted_record",requires:"same identity; reconcile before retry",writes:"PR comment only if absent"},
       {action:"revalidate_record_graph",requires:"trusted App record matches accepted_record and source is consumed; no active pause"},
       {action:"confirm_normal_paid_review_suppressed",requires:"fresh Draft or ai-followup-in-progress; normal Review gate and already-started paid run state verified"},
       {action:"remove_issue_label",requires:"revalidated graph and current Issue human-review-required label"},
       {action:"confirm_issue_label_absent",requires:"fresh Issue label read"},
       {action:"remove_pr_label",requires:"Issue label confirmed absent and current PR human-review-required label"},
       {action:"start_validation_cycle",requires:"both labels confirmed absent; next stage owns 10-minute window and validation"}
     ]}
'
