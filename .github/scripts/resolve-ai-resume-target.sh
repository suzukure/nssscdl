#!/usr/bin/env bash
set -euo pipefail

fail_closed() {
  echo "resolve-ai-resume-target: $1" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  fail_closed 'usage: resolve-ai-resume-target.sh <repo> <issue|pr> <number>'
fi

repo="$1"
target_kind="$2"
number="$3"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
snapshot="$(bash "$script_dir/inspect-ai-resume-target.sh" "$repo" "$target_kind" "$number")" \
  || fail_closed 'could not inspect target'

if [ "$target_kind" = 'issue' ]; then
  jq -cse --arg expected_target "issue:$number" --argjson number "$number" '
    if length != 1 or (.[0] | type) != "object" then
      error("invalid target snapshot")
    else
      .[0] as $snapshot
      | if $snapshot.target != $expected_target
           or $snapshot.issue != {number: $number, state: "open"}
           or $snapshot.pull_request != null then
          error("invalid Issue target snapshot")
        else
          {command: $snapshot.command, target: $snapshot.target,
           closing_issue: $snapshot.issue, pull_request: null}
        end
    end
  ' <<< "$snapshot" || fail_closed 'Issue relation is invalid'
  exit 0
fi

branch_issue="$(jq -rse --arg target "pr:$number" '
  def positive_integer: type == "number" and floor == . and . >= 1;
  if length != 1 or (.[0] | type) != "object" then
    error("invalid target snapshot")
  else
    .[0] as $snapshot
    | $snapshot.pull_request as $pr
    | if $snapshot.target != $target or $snapshot.issue != null
         or ($pr | type) != "object"
         or ($pr.branch_issue_number | positive_integer | not)
         or $pr.head_ref != ("ai/issue-" + ($pr.branch_issue_number | tostring))
         or ($pr.closing_issue_numbers | type) != "array"
         or ([$pr.closing_issue_numbers[] | positive_integer] | all | not)
         or ([$pr.closing_issue_numbers[]] | index($pr.branch_issue_number)) == null then
        error("branch Issue is not a same-repository closing Issue")
      else
        $pr.branch_issue_number
      end
  end
' <<< "$snapshot")" || fail_closed 'PR relation is invalid'

issue="$(gh api "repos/${repo}/issues/${branch_issue}")" \
  || fail_closed 'could not fetch branch Issue'
jq -cse --argjson snapshot "$snapshot" --argjson branch_issue "$branch_issue" '
  if length != 1 or (.[0] | type) != "object" then
    error("branch Issue response must be one object")
  elif .[0].number != $branch_issue or .[0].state != "open"
       or (.[0] | has("pull_request")) then
    error("branch Issue is not an open non-PR Issue")
  else
    {command: $snapshot.command, target: $snapshot.target,
     closing_issue: {number: $branch_issue, state: "open"},
     pull_request: ($snapshot.pull_request
                    | {number, state, base_ref, head_ref, head_sha})}
  end
' <<< "$issue" || fail_closed 'branch Issue relation is invalid'
