#!/usr/bin/env bash
set -euo pipefail

fail_closed() {
  echo "build-ai-resume-prepare-context: $1" >&2
  exit 1
}

if [ "$#" -ne 4 ]; then
  fail_closed 'usage: build-ai-resume-prepare-context.sh <repo> <issue|pr> <number> <trusted-app-id>'
fi
[[ "$4" =~ ^[1-9][0-9]*$ ]] || fail_closed 'trusted App ID must be a positive decimal integer without leading zeroes'

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)" || fail_closed 'could not create temporary directory'
trap 'rm -rf "$work_dir"' EXIT
cat > "$work_dir/command.json" || fail_closed 'could not read command'

# The GitHub context helper owns command, target, relation, and body facts.
bash "$script_dir/build-ai-resume-github-context.sh" "$1" "$2" "$3" \
  < "$work_dir/command.json" > "$work_dir/github.json" \
  || fail_closed 'could not build GitHub context'
target="$2:$3"
jq -cse --arg target "$target" '
  if length != 1 or (.[0] | type) != "object"
     or (.[0] | keys) != ["closing_issue", "command", "follow_up_issue", "pull_request", "target"]
     or .[0].target != $target
     or (.[0].closing_issue.number | type) != "number"
     or (.[0].closing_issue.number | floor) != .[0].closing_issue.number
     or .[0].closing_issue.number < 1
     or (.[0].command | type) != "object"
     or (.[0].closing_issue | type) != "object"
     or (.[0].follow_up_issue | type) != "object" and .[0].follow_up_issue != null
     or (.[0].pull_request | type) != "object" and .[0].pull_request != null
  then error("invalid GitHub context shape") else .[0] end
' "$work_dir/github.json" > "$work_dir/github.checked.json" \
  || fail_closed 'invalid GitHub context'

closing_number="$(jq -r '.closing_issue.number' "$work_dir/github.checked.json")"
if [ "$2" = 'pr' ]; then
  pr_number="$3"
else
  pr_number='-'
fi

bash "$script_dir/list-human-pause-records.sh" "$1" "$closing_number" "$pr_number" "$4" \
  > "$work_dir/list.json" || fail_closed 'could not list human pause records'

# Check each boundary before handing its output to the next authoritative stage.
check_stage() {
  jq -cse --arg target "$target" '
    if length != 1 or (.[0] | type) != "object" or .[0].target != $target
    then error("invalid stage target or shape") else .[0] end
  ' "$1" > "$2" || fail_closed 'human pause stage returned an invalid snapshot'
}

check_stage "$work_dir/list.json" "$work_dir/stage-0.json"
stages=(
  validate-human-pause-record-graph
  decompose-human-pause-record-graph
  derive-human-pause-pre-resume-state
  reconcile-human-pause-resume-acceptance
  reconcile-human-pause-active-pause
)
for index in "${!stages[@]}"; do
  next=$((index + 1))
  bash "$script_dir/${stages[$index]}.sh" < "$work_dir/stage-$index.json" \
    > "$work_dir/output.json" || fail_closed "${stages[$index]} failed"
  check_stage "$work_dir/output.json" "$work_dir/stage-$next.json"
done

jq -cn --slurpfile github "$work_dir/github.checked.json" \
  --slurpfile listing "$work_dir/stage-0.json" \
  --slurpfile state "$work_dir/stage-5.json" '
  $github[0] as $context | $listing[0] as $source | $state[0] as $final
  | (if $final.result == "active" then
       if ($final | keys) != ["active_pause", "result", "target"]
          or ($final.active_pause | type) != "object"
          or ($final.active_pause | keys) != ["pause_id", "reason"]
          or ($final.active_pause.pause_id | type) != "string"
          or ($final.active_pause.reason | type) != "string"
          or ($source.records | type) != "array"
       then error("invalid active pause shape") end
       | [$source.records[] | select(.pause_id == $final.active_pause.pause_id)] as $matches
       | if ($matches | length) != 1 or ($matches[0].record | type) != "object"
         then error("active source record is not unique")
         else {result: "active", pause_id: $final.active_pause.pause_id,
               reason: $final.active_pause.reason, record: $matches[0].record}
         end
     elif ($final.result == "no_active_pause" or $final.result == "state_inconsistent")
          and ($final | keys) == ["result", "target"] then
       {result: $final.result}
     else error("invalid human pause result") end) as $pause
  | {command: $context.command, target: $context.target,
     closing_issue: $context.closing_issue, pull_request: $context.pull_request,
     pause: $pause, follow_up_issue: $context.follow_up_issue}
' || fail_closed 'could not assemble PREPARE context'
