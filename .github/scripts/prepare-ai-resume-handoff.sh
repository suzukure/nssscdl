#!/usr/bin/env bash
set -euo pipefail

# #1097 PREPARED ONLY. Deterministic, side-effect-free policy over an envelope
# obtained by a future trusted, fresh GitHub collector (#1098).  Supplying
# JSON here is NOT authority to accept a pause or to change GitHub state.
fail_closed() { echo "prepare-ai-resume-handoff: $1" >&2; exit 1; }
[ "$#" -eq 0 ] || fail_closed 'arguments are not supported'
input="$(cat)" || fail_closed 'stdin unavailable'

jq -cse '
  def dec: type == "string" and test("^[1-9][0-9]*$");
  def sha: type == "string" and test("^[a-f0-9]{40}$");
  def human_login: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9-]{0,38}$");
  def issue_number: type == "number" and . >= 1 and floor == .;
  def exact($expected): (type == "object") and ((. | keys) == ($expected | sort));
  def pr_ok($n; $cmd):
    exact(["author_login","base_ref","base_repo","checks","closing_issue_numbers","draft","head_repo","head_sha","number","state","writer_runs_terminal"])
    and .number == $cmd.pr_number
    and .state == "open" and .draft == true
    and .base_ref == "main" and .base_repo == "suzukure/nssscdl"
    and .head_repo == "suzukure/nssscdl"
    and .author_login == $cmd.actor
    and .head_sha == $cmd.head_sha
    and .closing_issue_numbers == [$n]
    and .writer_runs_terminal == true
    and (.checks | exact(["current_head","result"]))
    and .checks.current_head == $cmd.head_sha
    and .checks.result == "success";
  if length != 1 or (.[0] | type) != "object" then
    error("expected one context")
  else .[0] end
  | . as $v
  | if ($v | exact(["command","closing_issue","pause","pull_request","target"]) | not)
       or ($v.command | exact(["action","actor","head_sha","pause_id","pr_number","result"]) | not)
       or ($v.closing_issue | exact(["number","state"]) | not)
       or ($v.pause | exact(["pause_id","reason","record","result"]) | not)
  then error("invalid envelope")
  elif $v.command.result != "accepted" or $v.command.action != "handoff"
       or ($v.command.actor | human_login | not)
       or ($v.command.pause_id | dec | not)
       or ($v.command.pr_number | issue_number | not)
       or ($v.command.head_sha | sha | not)
       or ($v.closing_issue.number | issue_number | not)
       or $v.closing_issue.state != "open"
       or $v.target != ("issue:" + ($v.closing_issue.number | tostring))
       or $v.pause.result != "active"
       or $v.pause.pause_id != $v.command.pause_id
       or $v.pause.reason != "developer_execution_failed"
       or ($v.pause.record | type) != "object"
       or $v.pause.record.version != 1
       or $v.pause.record.kind != "pause"
       or $v.pause.record.reason != $v.pause.reason
       or $v.pause.record.target != $v.target
       or ($v.pause.record.payload | type) != "object"
       or $v.pause.record.payload.failed_action != "develop"
       or ($v.pull_request | pr_ok($v.closing_issue.number; $v.command) | not)
  then error("handoff binding not eligible")
  else {
    result: "prepared_snapshot_only", write_authorized: false,
    target: $v.target, actor: $v.command.actor,
    source_pause_id: $v.command.pause_id,
    pr_number: $v.command.pr_number, pr_head: $v.command.head_sha,
    closing_issue_number: $v.closing_issue.number
  } end
' <<< "$input" || fail_closed 'invalid or stale binding; preserve machine pause'
