#!/usr/bin/env bash
set -euo pipefail

# Normalizes only the current target.  Relation and dispatch decisions belong
# to later helpers.

fail_closed() {
  echo "inspect-ai-resume-target: $1" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  fail_closed 'usage: inspect-ai-resume-target.sh <repo> <issue|pr> <number>'
fi

repo="$1"
target_kind="$2"
number="$3"

if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  fail_closed 'repository must be owner/repo'
fi
if [ "$target_kind" != 'issue' ] && [ "$target_kind" != 'pr' ]; then
  fail_closed 'target kind must be issue or pr'
fi
if [[ ! "$number" =~ ^[1-9][0-9]*$ ]]; then
  fail_closed 'target number must be a positive decimal integer without leading zeroes'
fi

input="$(cat)" || fail_closed 'could not read input'
command="$(jq -cse '
  def positive_integer:
    type == "number" and floor == . and . >= 1;
  if length != 1 then
    error("expected exactly one JSON object")
  elif (.[0] | type) != "object" then
    error("input must be a JSON object")
  elif .[0].result != "accepted"
       or (.[0].actor | type) != "string"
       or (.[0].action | type) != "string" then
    error("input must be an accepted command object")
  elif (.[0].action as $action
        | (["develop", "validate", "review", "fix", "no-action"] | index($action)) == null
          and ($action != "follow-up" or (.[0].follow_up_issue | positive_integer | not))) then
    error("input action is not an accepted command")
  else
    .[0] as $accepted
    | if $accepted.action == "follow-up" then
        $accepted | {result, actor, action, follow_up_issue}
      else
        $accepted | {result, actor, action}
      end
  end
' <<< "$input")" || fail_closed 'input could not be parsed safely'

if [ "$target_kind" = 'issue' ]; then
  metadata="$(gh api "repos/${repo}/issues/${number}")" \
    || fail_closed 'could not fetch Issue metadata'
  jq -cse --argjson command "$command" --argjson number "$number" '
    def positive_integer:
      type == "number" and floor == . and . >= 1;
    if length != 1 or (.[0] | type) != "object" then
      error("Issue metadata must be exactly one object")
    elif (.[0].number | positive_integer | not)
         or .[0].number != $number
         or .[0].state != "open"
         or (.[0] | has("pull_request")) then
      error("Issue metadata is not an open non-PR Issue")
    else
      {command: $command, target: ("issue:" + ($number | tostring)),
       issue: {number: $number, state: "open"}, pull_request: null}
    end
  ' <<< "$metadata" || fail_closed 'Issue metadata shape is invalid'
  exit 0
fi

metadata="$(gh pr view "$number" --repo "$repo" \
  --json number,state,baseRefName,headRefName,headRefOid,closingIssuesReferences)" \
  || fail_closed 'could not fetch pull request metadata'
issue_prefix="https://github.com/${repo}/issues/"
jq -cse --argjson command "$command" --argjson number "$number" \
  --arg issue_prefix "$issue_prefix" '
  def positive_integer:
    type == "number" and floor == . and . >= 1;
  if length != 1 or (.[0] | type) != "object" then
    error("pull request metadata must be exactly one object")
  elif (.[0].number | positive_integer | not)
       or .[0].number != $number
       or .[0].state != "OPEN"
       or (.[0].baseRefName | type) != "string"
       or (.[0].baseRefName | length) == 0
       or (.[0].headRefName | type) != "string"
       or (.[0].headRefName | length) == 0
       or (.[0].headRefOid | type) != "string"
       or (.[0].headRefOid | test("^[0-9a-f]{40}$") | not)
       or (.[0].closingIssuesReferences | type) != "array"
       or ([.[0].closingIssuesReferences[] |
            (type == "object") and (.number | positive_integer)
            and (.url | type) == "string"] | all | not) then
    error("pull request metadata shape is invalid")
  else
    .[0] as $pr
    | ($pr.headRefName
       | if test("^ai/issue-[1-9][0-9]*$") then
           capture("^ai/issue-(?<number>[1-9][0-9]*)$").number | tonumber
         else null
         end) as $branch_issue_number
    | [$pr.closingIssuesReferences[]
       | select(.url == ($issue_prefix + (.number | tostring)))
       | .number] | sort | unique as $closing_issue_numbers
    | {command: $command, target: ("pr:" + ($number | tostring)), issue: null,
       pull_request: {number: $number, state: "open", base_ref: $pr.baseRefName,
                      head_ref: $pr.headRefName, head_sha: $pr.headRefOid,
                      branch_issue_number: $branch_issue_number,
                      closing_issue_numbers: $closing_issue_numbers}}
  end
' <<< "$metadata" || fail_closed 'pull request metadata shape is invalid'
