#!/usr/bin/env bash
set -euo pipefail

# Applies consumer handoff evidence to independently ordered chains after the
# preceding stage has derived each chain's pre-resume effective pause.

fail_closed() {
  echo "reconcile-human-pause-resume-acceptance: $1" >&2
  exit 1
}

input="$(cat)" || fail_closed '入力を読み取れませんでした'

jq -ce '
  def valid_entry:
    type == "object"
    and (.pause_id | type == "string" and test("\\A[1-9][0-9]*\\z"))
    and (.record | type == "object")
    and (.record.kind | type == "string")
    and ((.record | has("source_pause_id") | not)
      or (.record.source_pause_id | type == "string" and test("\\A[1-9][0-9]*\\z")));
  def valid_pre_resume:
    type == "object"
    and .status == "active"
    and (.pause_id | type == "string" and test("\\A[1-9][0-9]*\\z"))
    and (.reason | type == "string");
  def valid_envelope:
    type == "object"
    and (.target | type == "string")
    and (.chains | type == "array")
    and all(.chains[];
      type == "object"
      and (.records | type == "array")
      and (.records | length > 0)
      and all(.records[]; valid_entry)
      and (.pre_resume | valid_pre_resume)
      and (.pre_resume.pause_id as $pause_id
        | any(.records[]; .pause_id == $pause_id)));
  def effective:
    .pre_resume as $pre_resume
    | [.records[] | select(.record.kind == "ai-resume-accepted")] as $accepted
    | if ($accepted | length) == 0 then
        {status: "active", pause_id: $pre_resume.pause_id,
         reason: $pre_resume.reason}
      elif ($accepted | length) != 1 then
        error("記録チェーンに再開受理が複数あります")
      elif $accepted[0].record.source_pause_id != $pre_resume.pause_id then
        error("再開受理の起点が再開前の停止記録と一致しません")
      elif $accepted[0].record.reason != $pre_resume.reason then
        error("再開受理の理由が再開前の理由と一致しません")
      elif $accepted[0] != .records[-1] then
        if .records[-2] == $accepted[0]
           and .records[-1].record.kind == "pause"
           and .records[-1].record.reason == "resume_transition_failed"
           and .records[-1].record.source_pause_id == $accepted[0].pause_id
           and ($accepted[0].record.payload.action
             | IN("develop","validate","review","fix","follow-up","no-action"))
           and .records[-1].record.payload.failed_action == $accepted[0].record.payload.action
        then {status: "active", pause_id: .records[-1].pause_id,
              reason: "resume_transition_failed"}
        else error("受理後の遷移が不正です") end
      else
        {status: "consumed", pause_id: $pre_resume.pause_id,
         reason: $pre_resume.reason,
         accepted_record_id: $accepted[0].pause_id}
      end;
  . as $input
  | [inputs] as $additional_values
  | if $additional_values != [] then
      error("JSON値は1個である必要があります")
    elif valid_envelope | not then
      error("再開前の記録チェーンの外枠が不正です")
    else {
      target: $input.target,
      chains: [$input.chains[] | . as $chain | $chain + {effective: effective}]
    }
    end
' <<< "$input" || fail_closed '再開受理を照合できませんでした'
