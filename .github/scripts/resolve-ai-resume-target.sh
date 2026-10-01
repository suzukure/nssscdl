#!/usr/bin/env bash
set -euo pipefail

fail_closed() {
  echo "resolve-ai-resume-target: $1" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  fail_closed '使い方: resolve-ai-resume-target.sh <repo> <issue|pr> <number>'
fi

repo="$1"
target_kind="$2"
number="$3"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
snapshot="$(bash "$script_dir/inspect-ai-resume-target.sh" "$repo" "$target_kind" "$number")" \
  || fail_closed '対象を確認できませんでした'

if [ "$target_kind" = 'issue' ]; then
  jq -cse --arg expected_target "issue:$number" --argjson number "$number" '
    if length != 1 or (.[0] | type) != "object" then
      error("対象のsnapshotが不正です")
    else
      .[0] as $snapshot
      | if $snapshot.target != $expected_target
           or $snapshot.issue != {number: $number, state: "open"}
           or $snapshot.pull_request != null then
          error("Issue対象のsnapshotが不正です")
        else
          {command: $snapshot.command, target: $snapshot.target,
           closing_issue: $snapshot.issue, pull_request: null}
        end
    end
  ' <<< "$snapshot" || fail_closed 'Issueとの関連付けが不正です'
  exit 0
fi

branch_issue="$(jq -rse --arg target "pr:$number" '
  def positive_integer: type == "number" and floor == . and . >= 1;
  if length != 1 or (.[0] | type) != "object" then
    error("対象のsnapshotが不正です")
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
        error("branch Issueが同一リポジトリのclosing Issueではありません")
      else
        $pr.branch_issue_number
      end
  end
' <<< "$snapshot")" || fail_closed 'PRとの関連付けが不正です'

issue="$(gh api "repos/${repo}/issues/${branch_issue}")" \
  || fail_closed 'branch Issueを取得できませんでした'
jq -cse --argjson snapshot "$snapshot" --argjson branch_issue "$branch_issue" '
  if length != 1 or (.[0] | type) != "object" then
    error("branch Issueの応答は単一のオブジェクトである必要があります")
  elif .[0].number != $branch_issue or .[0].state != "open"
       or (.[0] | has("pull_request")) then
    error("branch Issueがopenの通常Issueではありません")
  else
    {command: $snapshot.command, target: $snapshot.target,
     closing_issue: {number: $branch_issue, state: "open"},
     pull_request: ($snapshot.pull_request
                    | {number, state, base_ref, head_ref, head_sha})}
  end
' <<< "$issue" || fail_closed 'branch Issueとの関連付けが不正です'
