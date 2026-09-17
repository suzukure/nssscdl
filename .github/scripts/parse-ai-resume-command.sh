#!/usr/bin/env bash
set -euo pipefail

# Parses only the trusted-comment command boundary.  Active pause resolution,
# GitHub targets, and dispatch policy deliberately belong to later stages.

fail_closed() {
  echo "parse-ai-resume-command: $1" >&2
  exit 1
}

input="$(cat)" || fail_closed 'could not read input'

jq -cse '
  if length != 1 then
    error("expected exactly one JSON object")
  elif (.[0] | type) != "object" then
    error("input must be a JSON object")
  else
    .[0] as $input
    | if (($input.body | type) != "string")
         or (($input.actor | type) != "string")
         or (($input.author_association | type) != "string") then
        error("input envelope is invalid")
      elif (["OWNER", "MEMBER", "COLLABORATOR"]
            | index($input.author_association)) == null then
        {result: "ignore"}
      elif ($input.body | test("(?i)/ai[[:space:]]+resume")) | not then
        {result: "ignore"}
      elif $input.body == "/ai resume develop" then
        {result: "accepted", actor: $input.actor, action: "develop"}
      elif $input.body == "/ai resume validate" then
        {result: "accepted", actor: $input.actor, action: "validate"}
      elif $input.body == "/ai resume review" then
        {result: "accepted", actor: $input.actor, action: "review"}
      elif $input.body == "/ai resume fix" then
        {result: "accepted", actor: $input.actor, action: "fix"}
      elif $input.body == "/ai resume no-action" then
        {result: "accepted", actor: $input.actor, action: "no-action"}
      elif ($input.body | test("^/ai resume follow-up #[1-9][0-9]*$")) then
        ($input.body
         | capture("^/ai resume follow-up #(?<issue>[1-9][0-9]*)$").issue
         | tonumber) as $follow_up_issue
        | {result: "accepted", actor: $input.actor, action: "follow-up",
           follow_up_issue: $follow_up_issue}
      else
        {result: "reject", code: "invalid_command"}
      end
  end
' <<< "$input" || fail_closed 'input could not be parsed safely'
