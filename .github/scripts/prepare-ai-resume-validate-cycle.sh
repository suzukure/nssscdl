#!/usr/bin/env bash
set -euo pipefail

# Prepared read-only boundary. The caller obtains every fact from trusted base
# helpers/API, and persists the returned cycle; this helper makes no writes.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input="$(cat)"
stop() { jq -cn --arg code "$1" '{action:"stop",code:$code}'; exit 0; }
valid="$(jq -cse '
  def integer: type == "number" and floor == . and . >= 0;
  def positive: integer and . > 0;
  def sha: type == "string" and test("^[0-9a-f]{40}$");
  def state: IN("success","pending","failure");
  def check: type == "object" and (keys | sort) ==
    ["created_at","id","name","sha","started_at","status"]
    and (.id | positive) and (.name | type == "string" and length > 0)
    and (.sha | sha) and (.status | state or . == "skipped")
    and (.created_at | integer) and (.started_at | . == null or integer);
  def run: type == "object" and (keys | sort) == ["id","sha","status"]
    and (.id | positive) and (.sha | sha) and (.status | state);
  def validation: type == "object" and (keys | sort) ==
    ["automated_followup_count","branch_mutating_runs","branch_mutating_runs_complete","checks","checks_complete","current_head_sha","diff_guard_passed","followup_gate_passed","human_pause","now","ready_started_at","repository_write","requirements_gate_passed","validation_sha"]
    and (.automated_followup_count | positive)
    and (.branch_mutating_runs | type == "array" and all(.[]; run) and ([.[].id] | length == (unique | length)))
    and (.checks | type == "array" and all(.[]; check) and ([.[].id] | length == (unique | length)))
    and (.branch_mutating_runs_complete | type == "boolean")
    and (.checks_complete | type == "boolean")
    and (.current_head_sha | sha) and (.validation_sha | sha)
    and (.diff_guard_passed | type == "boolean")
    and (.followup_gate_passed | type == "boolean")
    and (.human_pause | type == "boolean")
    and (.repository_write | IN("pushed","no_diff"))
    and (.requirements_gate_passed | type == "boolean")
    and (.now | integer)
    and (.ready_started_at | . == null or integer);
  def identity: type == "object" and (keys | sort) ==
    ["action","closing_issue_number","command_comment_id","head","pr_number","reason","source_pause_id","target"]
    and .action == "validate" and (.closing_issue_number | positive)
    and (.pr_number | positive) and .target == ("pr:" + (.pr_number | tostring))
    and (.head | sha) and (.source_pause_id | type == "string" and test("^[1-9][0-9]*$"))
    and (.command_comment_id | type == "string" and test("^[1-9][0-9]*$"))
    and (.reason | IN("validation_failed","validation_timeout","resume_transition_failed"));
  def accepted: type == "object" and (keys | sort) == ["created_at","identity","record","record_id"]
    and (.created_at | integer) and (.record_id | type == "string" and test("^[1-9][0-9]*$"))
    and (.identity | identity)
    and .record.version == 1 and .record.kind == "ai-resume-accepted"
    and .record.reason == .identity.reason and .record.target == .identity.target
    and .record.source_pause_id == .identity.source_pause_id
    and .record.payload.action == "validate"
    and .record.payload.command_comment_id == .identity.command_comment_id
    and .record.payload.accepted_head == .identity.head;
  def cycle: type == "object" and (keys | sort) ==
    ["accepted_record_id","identity","window_started_at"]
    and (.accepted_record_id | type == "string" and test("^[1-9][0-9]*$"))
    and (.identity | identity) and (.window_started_at | integer);
  if length != 1 or (.[0] | type) != "object" then error("snapshot") end
  | .[0] | if (keys | sort) != ["accepted","active_pause","cycle","issue_label_absent","normal_review_suppressed","pr_label_absent","source_consumed","validation"]
      or (.accepted | accepted | not)
      or (.cycle != null and (.cycle | cycle | not))
      or (.cycle != null and (.cycle.accepted_record_id != .accepted.record_id
        or .cycle.identity != .accepted.identity
        or .cycle.window_started_at != .accepted.created_at))
      or (.active_pause | IN("none","source","other","unknown") | not)
      or (.source_consumed | type != "boolean")
      or (.issue_label_absent | type != "boolean")
      or (.pr_label_absent | type != "boolean")
      or (.normal_review_suppressed | type != "boolean")
      or (.validation | validation | not)
      or .validation.now < .accepted.created_at
      or (.validation.ready_started_at != null and .validation.ready_started_at > .validation.now)
    then error("snapshot") else . end
' <<< "$input" 2>/dev/null)" || stop invalid_snapshot
cycle="$(jq -c '{accepted_record_id:.accepted.record_id,identity:.accepted.identity,window_started_at:.accepted.created_at}' <<< "$valid")"
observation="$(jq -c '.validation | {current_head_sha,validation_sha,ready_started_at,
  checks,checks_complete,branch_mutating_runs,branch_mutating_runs_complete}' <<< "$valid")"
emit() {
  jq -cn --arg action "$1" --arg code "$2" --argjson cycle "$cycle" \
    --argjson observation "$observation" \
    '{action:$action,code:$code,cycle:$cycle,observation:$observation,
      current_validated_sha:null}'
  exit 0
}
[ "$(jq -r .source_consumed <<< "$valid")" = true ] || emit stop source_not_consumed
[ "$(jq -r .active_pause <<< "$valid")" = none ] || emit stop already_paused
[ "$(jq -r .issue_label_absent <<< "$valid")" = true ] || emit stop labels_not_cleared
[ "$(jq -r .pr_label_absent <<< "$valid")" = true ] || emit stop labels_not_cleared
[ "$(jq -r .normal_review_suppressed <<< "$valid")" = true ] || emit stop review_suppression_unverified
accepted_head="$(jq -r .accepted.identity.head <<< "$valid")"
current_head="$(jq -r '.validation.current_head_sha // empty' <<< "$valid")"
[[ "$current_head" =~ ^[0-9a-f]{40}$ ]] || emit stop invalid_snapshot
# The accepted comment creation time is the immutable window anchor, including
# after response loss, duplicate polling, or HEAD changes.
normalized="$(jq -c --argjson started "$(jq -r .accepted.created_at <<< "$valid")" \
  '.validation + {window_started_at:$started}' <<< "$valid")"
ready="$(jq -r '.ready_started_at // empty' <<< "$normalized")"
if [ "$current_head" != "$accepted_head" ] ||
   [ -z "$ready" ] || [ "$ready" -le "$(jq -r .window_started_at <<< "$normalized")" ]; then
  if [ "$(jq -r '.now - .window_started_at' <<< "$normalized")" -ge 600 ]; then
    emit pause_record validation_timeout
  fi
  [ "$current_head" = "$accepted_head" ] || emit requalify changed_head
  emit wait pending
fi
result="$(bash "$script_dir/evaluate-current-head-validation.sh" <<< "$normalized")" || emit stop evaluator_unavailable
case "$(jq -r '.action + "/" + .code' <<< "$result")" in
  ready/success)
    jq -cn --argjson cycle "$cycle" --argjson observation "$observation" \
      --arg sha "$current_head" \
      '{action:"handoff_candidate",code:"success",cycle:$cycle,observation:$observation,
        current_validated_sha:$sha,
        handoff:{path:"normal_trusted_review",action:"review",pr_number:$cycle.identity.pr_number,
          accepted_record_id:$cycle.accepted_record_id,validated_sha:$sha,
          requires:"fresh normal review source and ownership evidence"}}' ;;
  wait/*) emit wait "$(jq -r .code <<< "$result")" ;;
  stop/validation_failed|stop/validation_timeout|stop/round_limit)
    emit pause_record "$(jq -r .code <<< "$result")" ;;
  stop/human_pause) emit stop already_paused ;;
  stop/*) emit stop "$(jq -r .code <<< "$result")" ;;
  *) emit stop invalid_evaluator_result ;;
esac
