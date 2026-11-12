#!/usr/bin/env bash
set -euo pipefail

# Pure conversion of one prepared validate recovery pause action from stdin.
pr="${1:?PR number required}"
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || { echo 'invalid PR number' >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
record="$(jq -ce -s --arg target "pr:$pr" '
  def id: type == "string" and test("^[1-9][0-9]*$");
  def head: type == "string" and test("^[0-9a-f]{40}$");
  if length != 1 or (.[0] | type) != "object" then error("one action required") end
  | .[0]
  | if .action == "create_or_reconcile_replacement_pause" then
      if (keys | sort) != ["action","failed_action","reason","source_pause_id"]
        or .reason != "resume_transition_failed" or .failed_action != "validate"
        or (.source_pause_id | id | not) then error("invalid replacement action") end
      | {version:1,kind:"pause",reason:.reason,target:$target,
         source_pause_id:.source_pause_id,payload:{failed_action:.failed_action}}
    elif .action == "create_or_reconcile_validation_pause" then
      if (keys | sort) != ["accepted_record_id","action","paused_head","reason"]
        or (.accepted_record_id | id | not) or (.paused_head | head | not)
        or (.reason | IN("validation_failed","validation_timeout","round_limit") | not)
      then error("invalid validation action") end
      | {version:1,kind:"pause",reason:.reason,target:$target,
         paused_head:.paused_head,payload:{accepted_record_id:.accepted_record_id}}
    else error("unknown pause action") end
')" || { echo 'invalid pause action' >&2; exit 1; }
bash "$script_dir/human-pause-record.sh" validate "$record"
printf '%s\n' "$record"
