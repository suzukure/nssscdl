#!/usr/bin/env bash
set -euo pipefail

# Read exactly one trusted snapshot from stdin. The caller gathers GitHub
# evidence and sets window_started_at when the follow-up write step finishes,
# including a legitimate no-diff. ready_started_at is the trusted Ready event
# time. All times are Unix seconds. A later HEAD or Ready event never changes
# window_started_at. The complete flags certify API enumeration: checks have
# unique check-run IDs, and branch_mutating_runs includes in-flight
# runs from older SHAs. False means pending; API errors or unknown states stop.
# Codex report text is deliberately absent from this interface.
#
# Output: {action: "ready"|"wait"|"stop", code: fixed_code}.
# A wait result may be polled until the original deadline. Stop is terminal.
if ! result="$(jq -c -s '
  def sha: type == "string" and test("^[0-9a-f]{40}$");
  def integer: type == "number" and floor == .;
  def state: . == "success" or . == "pending" or . == "failure";
  def check_state: state or . == "skipped";
  def timestamp: integer and . >= 0;
  def check: type == "object" and (keys | sort) == ["created_at", "id", "name", "sha", "started_at", "status"]
    and (.id | integer and . > 0)
    and (.name | type == "string" and length > 0)
    and (.sha | sha) and (.status | check_state)
    and (.created_at | timestamp)
    and (.started_at | . == null or timestamp);
  def run: type == "object" and (keys | sort) == ["id", "sha", "status"]
    and (.id | integer and . > 0) and (.sha | sha) and (.status | state);
  def valid:
    type == "object" and
    (keys | sort) == ["automated_followup_count", "branch_mutating_runs", "branch_mutating_runs_complete", "checks", "checks_complete", "current_head_sha", "diff_guard_passed", "followup_gate_passed", "human_pause", "now", "ready_started_at", "repository_write", "requirements_gate_passed", "validation_sha", "window_started_at"] and
    (.automated_followup_count | integer and . >= 1) and
    (.branch_mutating_runs | type == "array" and all(.[]; run) and ([.[].id] | length == (unique | length))) and
    (.branch_mutating_runs_complete | type == "boolean") and
    (.checks | type == "array" and all(.[]; check) and ([.[].id] | length == (unique | length))) and
    (.checks_complete | type == "boolean") and
    (.current_head_sha | sha) and (.validation_sha | sha) and
    (.diff_guard_passed | type == "boolean") and
    (.followup_gate_passed | type == "boolean") and
    (.human_pause | type == "boolean") and
    (.repository_write == "pushed" or .repository_write == "no_diff") and
    (.requirements_gate_passed | type == "boolean") and
    (.now | integer and . >= 0) and
    (.ready_started_at | timestamp) and
    (.window_started_at | integer and . >= 0) and
    .now >= .window_started_at and .now >= .ready_started_at;
  def decision($action; $code): {action: $action, code: $code};
  if length != 1 or (.[0] | valid | not) then
    decision("stop"; "invalid_snapshot")
  else
    .[0] as $s |
    ($s.checks | map(select(.sha == $s.current_head_sha and
      (.started_at // .created_at) >= $s.ready_started_at))) as $current_checks |
    if ($s.followup_gate_passed and $s.requirements_gate_passed and $s.diff_guard_passed) | not then
      decision("stop"; "validation_failed")
    elif $s.human_pause then decision("stop"; "human_pause")
    elif $s.automated_followup_count > 2 then decision("stop"; "round_limit")
    elif (any($current_checks[]; .status == "failure" or .status == "skipped") or
          any($s.branch_mutating_runs[]; .status == "failure")) then
      decision("stop"; "validation_failed")
    elif $s.now - $s.window_started_at >= 600 then
      decision("stop"; "validation_timeout")
    elif $s.validation_sha != $s.current_head_sha then
      decision("wait"; "stale_head")
    elif ($s.checks_complete | not) or ($s.branch_mutating_runs_complete | not) or
         (any($current_checks[]; .status == "pending")) or
         (any($s.branch_mutating_runs[]; .status == "pending")) or
         ([ $current_checks[] | select(.name == "PR Traceability / Linked Issue" and .status == "success") ] | length != 1) then
      decision("wait"; "pending")
    else decision("ready"; "success")
    end
  end
' 2>/dev/null)"; then
  printf '%s\n' '{"action":"stop","code":"invalid_snapshot"}'
else
  printf '%s\n' "$result"
fi
