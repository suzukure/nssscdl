#!/usr/bin/env bash
set -euo pipefail

# Derives each independently ordered chain's effective pause immediately
# before resume acceptance.  Graph validation and graph-to-chain decomposition
# are intentionally upstream responsibilities; acceptance semantics are owned
# by the following lifecycle stage.

fail_closed() {
  echo "derive-human-pause-pre-resume-state: $1" >&2
  exit 1
}

input="$(cat)" || fail_closed 'could not read input'

jq -ce '
  def valid_entry:
    type == "object"
    and (.pause_id | type == "string" and test("\\A[1-9][0-9]*\\z"))
    and (.record | type == "object")
    and (.record.kind | type == "string")
    and ((.record | has("source_pause_id") | not)
      or (.record.source_pause_id | type == "string" and test("\\A[1-9][0-9]*\\z")));
  def valid_envelope:
    type == "object"
    and (.target | type == "string")
    and (.chains | type == "array")
    and all(.chains[];
      type == "object"
      and (.records | type == "array")
      and all(.records[]; valid_entry));
  def pre_resume:
    reduce .records[] as $entry
      ({seen_root: false, stopped: false, state: null};
       if .stopped then .
       elif $entry.record.kind == "ai-resume-accepted" then .stopped = true
       elif .seen_root | not then
         if $entry.record.kind == "pause"
           and ($entry.record | has("source_pause_id") | not)
           and ($entry.record.reason | type == "string")
         then {
           seen_root: true,
           stopped: false,
           state: {status: "active", pause_id: $entry.pause_id,
                   reason: $entry.record.reason}
         }
         else error("chain does not begin with a root pause")
         end
       elif ($entry.record.kind == "pause" or $entry.record.kind == "pause-normalization")
         and ($entry.record.source_pause_id? == .state.pause_id)
         and ($entry.record.reason | type == "string")
       then .state = {status: "active", pause_id: $entry.pause_id,
                      reason: $entry.record.reason}
       else error("chain has an uninterpretable pre-acceptance transition")
       end)
    | if .seen_root then .state else error("chain has no pre-acceptance root pause") end;
  . as $input
  | [inputs] as $additional_values
  | if $additional_values != [] then
      error("expected one JSON value")
    elif valid_envelope | not then
      error("chain envelope is invalid")
    else {
      target: $input.target,
      chains: [
        $input.chains[]
        | . as $chain
        | ($chain | pre_resume) as $pre_resume
        | $chain + {pre_resume: $pre_resume}
      ]
    }
    end
' <<< "$input" || fail_closed 'could not derive pre-resume pause state'
