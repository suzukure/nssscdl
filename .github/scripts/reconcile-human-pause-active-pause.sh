#!/usr/bin/env bash
set -euo pipefail

# Aggregates chain-level effective states into the Conversation's one active
# pause, without reinterpreting record, transition, or acceptance semantics.

fail_closed() {
  echo "reconcile-human-pause-active-pause: $1" >&2
  exit 1
}

input="$(cat)" || fail_closed 'could not read input'

output="$(jq -ce '
  def valid_effective:
    type == "object"
    and (.status == "active" or .status == "consumed")
    and (.pause_id | type == "string")
    and (.reason | type == "string");
  def valid_envelope:
    type == "object"
    and (.target | type == "string")
    and (.chains | type == "array")
    and all(.chains[]; type == "object" and (.effective | valid_effective));
  . as $input
  | [inputs] as $additional_values
  | if $additional_values != [] then
      error("expected one JSON value")
    elif valid_envelope | not then
      error("reconciled chain envelope is invalid")
    else
      [$input.chains[] | .effective | select(.status == "active")] as $active
      | if ($active | length) == 0 then
          {target: $input.target, result: "no_active_pause"}
        elif ($active | length) == 1 then
          {target: $input.target, result: "active",
           active_pause: {pause_id: $active[0].pause_id, reason: $active[0].reason}}
        else
          {target: $input.target, result: "state_inconsistent"}
        end
    end
' <<< "$input")" || fail_closed 'could not reconcile active pause'

[ -n "$output" ] || fail_closed 'could not reconcile active pause'
printf '%s\n' "$output"
