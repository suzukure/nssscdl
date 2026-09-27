#!/usr/bin/env bash
set -euo pipefail

# Dormant producer contract. No workflow invokes this helper until #499 also
# installs review suppression, dispatch consumption, and pause recovery.
# Load this file and its sibling helpers from the trusted base, never a PR
# worktree. Each call accepts exactly one trusted JSON snapshot on stdin and
# emits one instruction. The future caller owns GitHub writes, calls entry
# after checkout, then pre_codex after the label transition immediately before
# paid Codex, and pre_write immediately before repository write. Each target
# snapshot includes a freshly observed machine label and checked-out HEAD.
# Execute a dispatch instruction only once. An ambiguous dispatch
# result goes to common pause; it is never retried automatically.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
phase="${1:-}"
input="$(cat)"
stop() { jq -cn --arg code "$1" '{action:"stop",code:$code}'; exit 0; }
pause() { jq -cn --arg code "$1" '{action:"pause_record",code:$code}'; exit 0; }
target_failure() {
  if [[ "$phase" == pre_codex || "$phase" == pre_write ]]; then pause state_inconsistent; fi
  stop "$1"
}
if ! valid="$(jq -cse 'if length == 1 and (.[0] | type) == "object" then .[0] else error("snapshot") end' <<< "$input" 2>/dev/null)"; then
  if [[ "$phase" == machine_label_result || "$phase" == pre_codex || "$phase" == pre_write || "$phase" == validate || "$phase" == written || "$phase" == ready_result || "$phase" == dispatch_result ]]; then pause state_inconsistent; fi
  stop invalid_snapshot
fi

case "$phase" in
  machine_label_result)
    jq -cse '
      if length != 1 or (.[0] | keys | sort) != ["label_present","transition_succeeded"]
        or (.[0].label_present | type != "boolean")
        or (.[0].transition_succeeded | type != "boolean")
      then {action:"pause_record",code:"state_inconsistent"}
      elif .[0].label_present and .[0].transition_succeeded then
        {action:"check_pre_codex_target"}
      elif (.[0].label_present | not) and (.[0].transition_succeeded | not) then
        {action:"stop",code:"machine_label_failed"}
      else {action:"pause_record",code:"state_inconsistent"} end
    ' <<< "$input" 2>/dev/null || pause state_inconsistent
    ;;
  entry|pre_codex|pre_write)
    # This is the canonical #523 current review/PR/Issue/HEAD/pause check.
    facts="$(jq -cse '
      def positive: type == "number" and floor == . and . > 0;
      def sha: type == "string" and test("^[0-9a-f]{40}$");
      if length != 1 or (.[0] | keys | sort) !=
        ["checked_out_sha","developer_gate_passed","diff_guard_passed","head_ref","machine_label","pr_number","repo","requirements_gate_passed","review_commit","review_id","reviewer_slug","round"]
        or (.[0].repo | type != "string" or (test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not))
        or (.[0].pr_number | positive | not) or (.[0].review_id | positive | not)
        or (.[0].round | positive | not) or (.[0].review_commit | sha | not)
        or (.[0].checked_out_sha | sha | not)
        or (.[0].head_ref | type != "string" or (test("^ai/issue-[1-9][0-9]*$") | not))
        or (.[0].reviewer_slug | type != "string" or length == 0)
        or (.[0].developer_gate_passed | type != "boolean")
        or (.[0].machine_label | type != "boolean")
        or (.[0].requirements_gate_passed | type != "boolean")
        or (.[0].diff_guard_passed | type != "boolean")
      then error("snapshot") else .[0] end
    ' <<< "$input" 2>/dev/null)" || target_failure invalid_snapshot
    [ "$(jq -r .checked_out_sha <<< "$facts")" = "$(jq -r .review_commit <<< "$facts")" ] \
      || target_failure stale_checkout
    if [ "$phase" != entry ]; then
      [ "$(jq -r .machine_label <<< "$facts")" = true ] || pause state_inconsistent
    fi
    round="$(jq -r .round <<< "$facts")"
    target="$(bash "$script_dir/check-claude-followup-target.sh" \
      "$(jq -r .repo <<< "$facts")" "$(jq -r .pr_number <<< "$facts")" \
      "$(jq -r .review_id <<< "$facts")" "$(jq -r .review_commit <<< "$facts")" \
      "$(jq -r .reviewer_slug <<< "$facts")" "$(jq -r .head_ref <<< "$facts")")" \
      || target_failure target_unavailable
    [ "$target" = current ] || target_failure stale_target
    if [ "$round" -gt 2 ]; then pause round_limit; fi
    if [ "$phase" = entry ]; then
      [ "$(jq -r .machine_label <<< "$facts")" = false ] || target_failure machine_label_present
    fi
    if [ "$(jq -r .developer_gate_passed <<< "$facts")" != true ]; then target_failure followup_gate_failed; fi
    if [ "$phase" = pre_write ]; then
      [ "$(jq -r .requirements_gate_passed <<< "$facts")" = true ] || pause requirements_change
      [ "$(jq -r .diff_guard_passed <<< "$facts")" = true ] || pause diff_guard_error
    fi
    if [ "$phase" = entry ]; then
      jq -cn '{action:"add_machine_label",label:"ai-followup-in-progress"}'
    elif [ "$phase" = pre_codex ]; then
      jq -cn '{action:"paid_codex"}'
    else
      jq -cn '{action:"repository_write"}'
    fi
    ;;
  written)
    # The write/no-diff completion time is captured once. The caller must
    # preserve it across Ready, HEAD changes, and every validation poll.
    jq -cse '
      def sha: type == "string" and test("^[0-9a-f]{40}$");
      def time: type == "number" and floor == . and . >= 0;
      if length != 1 or (.[0] | keys | sort) !=
        ["current_head_sha","expected_sha","machine_label","now","repository_write","window_started_at"]
        or (.[0].current_head_sha | sha | not) or (.[0].expected_sha | sha | not)
        or (.[0].machine_label != true)
        or (.[0].repository_write != "pushed" and .[0].repository_write != "no_diff")
        or (.[0].window_started_at | time | not)
        or (.[0].now | time | not) or .[0].now < .[0].window_started_at
      then {action:"pause_record",code:"state_inconsistent"}
      elif .[0].current_head_sha != .[0].expected_sha then
        {action:"pause_record",code:"state_inconsistent"}
      elif .[0].now - .[0].window_started_at >= 600 then
        {action:"pause_record",code:"validation_timeout"}
      else {action:"ready_pr",validated_sha:.[0].expected_sha,
            window_started_at:.[0].window_started_at}
      end
    ' <<< "$input" 2>/dev/null || pause state_inconsistent
    ;;
  ready_result)
    jq -cse '
      if length != 1 or (.[0] | keys | sort) !=
        ["machine_label","now","ready_started_at","ready_succeeded","window_started_at"]
        or (.[0].machine_label != true)
        or (.[0].ready_succeeded | type != "boolean")
        or (.[0].window_started_at | type != "number" or floor != . or . < 0)
        or (.[0].ready_started_at | type != "number" or floor != . or . < 0)
        or (.[0].now | type != "number" or floor != . or . < 0)
        or .[0].now < .[0].ready_started_at
      then {action:"pause_record",code:"state_inconsistent"}
      elif .[0].now - .[0].window_started_at >= 600 then
        {action:"pause_record",code:"validation_timeout"}
      elif .[0].ready_succeeded and .[0].ready_started_at >= .[0].window_started_at then
        {action:"validate",ready_started_at:.[0].ready_started_at,
         window_started_at:.[0].window_started_at}
      else {action:"pause_record",code:"state_inconsistent"} end
    ' <<< "$input" 2>/dev/null || pause state_inconsistent
    ;;
  validate)
    # The caller supplies complete current-head checks and only known branch
    # writers under the canonical Issue concurrency group. Never infer writers
    # by scanning all AI Developer workflow runs.
    normalized="$(jq -cse '
      def sha: type == "string" and test("^[0-9a-f]{40}$");
      def time: type == "number" and floor == . and . >= 0;
      def check:
        type == "object" and (keys | sort) ==
          ["conclusion","created_at","head_sha","id","name","started_at","status"]
        and (.id | type == "number" and floor == . and . > 0)
        and (.name | type == "string" and length > 0) and (.head_sha | sha)
        and (.created_at | time) and (.started_at | . == null or time)
        and (.status | IN("queued","in_progress","completed"))
        and (if .status == "completed" then (.conclusion | type == "string" and length > 0)
             else .conclusion == null end);
      if length != 1 or (.[0] | type) != "object"
        or (.[0] | keys | sort) !=
          ["automated_followup_count","branch_mutating_runs","branch_mutating_runs_complete","checks","checks_complete","current_head_sha","diff_guard_passed","followup_gate_passed","human_pause","machine_label","now","pr_number","ready_started_at","repository_write","requirements_gate_passed","validation_sha","window_started_at"]
        or (.[0].checks | type != "array" or (all(.[]; check) | not))
        or (.[0].pr_number | type != "number" or floor != . or . <= 0)
        or (.[0].machine_label != true)
      then error("snapshot") else .[0] end
      | del(.machine_label, .pr_number)
      | .checks |= map({id, sha:.head_sha, created_at, started_at,
          name:(if .name == "Linked Issue" then "PR Traceability / Linked Issue" else .name end),
          status:(if .status == "completed" then
                    (if .conclusion == "success" then "success" else "failure" end)
                  else "pending" end)})
    ' <<< "$input" 2>/dev/null)" || pause state_inconsistent
    result="$(bash "$script_dir/evaluate-current-head-validation.sh" <<< "$normalized")" \
      || pause state_inconsistent
    action="$(jq -er '.action' <<< "$result" 2>/dev/null)" || pause state_inconsistent
    code="$(jq -er '.code' <<< "$result" 2>/dev/null)" || pause state_inconsistent
    case "$action/$code" in
      ready/success)
        jq -cn --arg sha "$(jq -r .validation_sha <<< "$normalized")" \
          --argjson pr "$(jq -r .pr_number <<< "$valid")" \
          --argjson round "$(jq -r .automated_followup_count <<< "$normalized")" \
          '{action:"dispatch",event_type:"claude-auto-rereview",
            client_payload:{pr_number:$pr,validated_sha:$sha,round:$round}}'
        ;;
      wait/*) jq -cn --arg code "$code" '{action:"wait",code:$code}' ;;
      stop/validation_failed|stop/validation_timeout|stop/round_limit) pause "$code" ;;
      stop/human_pause) stop already_paused ;;
      stop/*) pause state_inconsistent ;;
      *) pause state_inconsistent ;;
    esac
    ;;
  pause_recorded)
    # A trusted common pause record must be active before label cleanup.
    jq -cse '
      if length != 1 or (.[0] | keys | sort) != ["active_pause_id","recorded_pause_id"]
        or (.[0].active_pause_id | type != "number" or floor != . or . <= 0)
        or (.[0].recorded_pause_id | type != "number" or floor != . or . <= 0)
      then {action:"stop",code:"invalid_snapshot"}
      elif .[0].active_pause_id != .[0].recorded_pause_id then
        {action:"stop",code:"pause_not_active"}
      else {action:"remove_machine_label",label:"ai-followup-in-progress"} end
    ' <<< "$input" 2>/dev/null || stop invalid_snapshot
    ;;
  dispatch_result)
    jq -cse '
      if length != 1 or (.[0] | keys | sort) != ["dispatch_succeeded","machine_label"]
        or (.[0].dispatch_succeeded | type != "boolean")
        or (.[0].machine_label != true)
      then {action:"pause_record",code:"state_inconsistent"}
      elif .[0].dispatch_succeeded then {action:"await_consumer"}
      else {action:"pause_record",code:"state_inconsistent"} end
    ' <<< "$input" 2>/dev/null || pause state_inconsistent
    ;;
  *) stop invalid_phase ;;
esac
