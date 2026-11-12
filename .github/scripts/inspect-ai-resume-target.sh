#!/usr/bin/env bash
set -euo pipefail

# Normalizes only the current target.  Relation and dispatch decisions belong
# to later helpers.

fail_closed() {
  echo "inspect-ai-resume-target: $1" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  fail_closed '使い方: inspect-ai-resume-target.sh <repo> <issue|pr> <number>'
fi

repo="$1"
target_kind="$2"
number="$3"

if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  fail_closed 'リポジトリ指定はowner/repo形式である必要があります'
fi
if [ "$target_kind" != 'issue' ] && [ "$target_kind" != 'pr' ]; then
  fail_closed '対象の種類はissueまたはprである必要があります'
fi
if [[ ! "$number" =~ ^[1-9][0-9]*$ ]]; then
  fail_closed '対象番号は先頭に0のない正の十進整数である必要があります'
fi

input="$(cat)" || fail_closed '入力を読み取れませんでした'
command="$(jq -cse '
  def positive_integer:
    type == "number" and floor == . and . >= 1;
  if length != 1 then
    error("JSONオブジェクトは1個である必要があります")
  elif (.[0] | type) != "object" then
    error("入力はJSONオブジェクトである必要があります")
  elif .[0].result != "accepted"
       or (.[0].actor | type) != "string"
       or (.[0].action | type) != "string" then
    error("入力は受理済みcommandのオブジェクトである必要があります")
  elif (.[0].action as $action
        | (["develop", "validate", "review", "fix", "no-action"] | index($action)) == null
          and ($action != "follow-up" or (.[0].follow_up_issue | positive_integer | not))) then
    error("入力actionは受理済みcommandではありません")
  else
    .[0] as $accepted
    | if $accepted.action == "follow-up" then
        $accepted | {result, actor, action, follow_up_issue}
      else
        $accepted | {result, actor, action}
      end
  end
' <<< "$input")" || fail_closed '入力を安全に解析できませんでした'

if [ "$target_kind" = 'issue' ]; then
  metadata="$(gh api "repos/${repo}/issues/${number}")" \
    || fail_closed 'Issueの情報を取得できませんでした'
  jq -cse --argjson command "$command" --argjson number "$number" '
    def positive_integer:
      type == "number" and floor == . and . >= 1;
    if length != 1 or (.[0] | type) != "object" then
      error("Issueの情報は単一のオブジェクトである必要があります")
    elif (.[0].number | positive_integer | not)
         or .[0].number != $number
         or .[0].state != "open"
         or (.[0] | has("pull_request")) then
      error("Issueの情報がopenの通常Issueを示していません")
    else
      {command: $command, target: ("issue:" + ($number | tostring)),
       issue: {number: $number, state: "open"}, pull_request: null}
    end
  ' <<< "$metadata" || fail_closed 'Issueの情報の形式が不正です'
  exit 0
fi

metadata="$(gh pr view "$number" --repo "$repo" \
  --json number,state,baseRefName,headRefName,headRefOid,closingIssuesReferences)" \
  || fail_closed 'PRの情報を取得できませんでした'
issue_prefix="https://github.com/${repo}/issues/"
jq -cse --argjson command "$command" --argjson number "$number" \
  --arg issue_prefix "$issue_prefix" '
  def positive_integer:
    type == "number" and floor == . and . >= 1;
  if length != 1 or (.[0] | type) != "object" then
    error("PRの情報は単一のオブジェクトである必要があります")
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
    error("PRの情報の形式が不正です")
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
' <<< "$metadata" || fail_closed 'PRの情報の形式が不正です'
