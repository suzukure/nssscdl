#!/usr/bin/env bash
set -euo pipefail

fail_closed() {
  echo "build-ai-resume-github-context: $1" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  fail_closed '使い方: build-ai-resume-github-context.sh <repo> <issue|pr> <number>'
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)" || fail_closed '一時ディレクトリを作成できませんでした'
trap 'rm -rf "$work_dir"' EXIT

bash "$script_dir/resolve-ai-resume-target.sh" "$1" "$2" "$3" > "$work_dir/relation.json" \
  || fail_closed '対象との関連を解決できませんでした'
closing_number="$(jq -er '.closing_issue.number | select(type == "number" and floor == . and . >= 1)' "$work_dir/relation.json")" \
  || fail_closed 'closing Issue番号が不正です'
gh api "repos/$1/issues/$closing_number" > "$work_dir/closing.json" \
  || fail_closed 'closing Issue本文を取得できませんでした'
jq -e --argjson number "$closing_number" '
  type == "object" and .number == $number and .state == "open"
  and (has("pull_request") | not) and (.body | type) == "string"
' "$work_dir/closing.json" > /dev/null || fail_closed 'closing Issueの応答が不正です'

# jq -j writes the decoded body without adding or trimming a newline.
jq -j '.body' "$work_dir/closing.json" > "$work_dir/body" \
  || fail_closed 'closing Issue本文をデコードできませんでした'
fingerprint="sha256:$(sha256sum "$work_dir/body" | cut -d ' ' -f 1)" \
  || fail_closed 'closing Issue本文のハッシュを計算できませんでした'

action="$(jq -er '.command.action' "$work_dir/relation.json")" \
  || fail_closed 'command actionが不正です'
if [ "$action" = 'follow-up' ]; then
  follow_up_number="$(jq -er '.command.follow_up_issue | select(type == "number" and floor == . and . >= 1)' "$work_dir/relation.json")" \
    || fail_closed '後継Issue番号が不正です'
  gh api "repos/$1/issues/$follow_up_number" > "$work_dir/follow-up.json" \
    || fail_closed '後継Issueを取得できませんでした'
else
  printf 'null\n' > "$work_dir/follow-up.json"
fi

jq -cn --slurpfile relation "$work_dir/relation.json" \
  --slurpfile closing "$work_dir/closing.json" \
  --slurpfile follow_up "$work_dir/follow-up.json" \
  --arg fingerprint "$fingerprint" '
  def follow_up_numbers:
    split("\n")
    | reduce .[] as $line (
        {scope_out_language: null, numbers: []};
        if ($line | test("^## Scope-out impact and follow-up[[:space:]]*$")) then
          .scope_out_language = "en"
        elif ($line | test("^## スコープ外影響と後継Issue[[:space:]]*$")) then
          .scope_out_language = "ja"
        elif ($line | test("^#{1,2}[[:space:]]")) then
          .scope_out_language = null
        elif .scope_out_language == "en" and ($line | test("^- Follow-up Issue: #[0-9]+[[:space:]]*$")) then
          .numbers += [($line | capture("^- Follow-up Issue: #(?<number>[0-9]+)[[:space:]]*$").number | tonumber)]
        elif .scope_out_language == "ja" and ($line | test("^- 後継Issue: #[0-9]+[[:space:]]*$")) then
          .numbers += [($line | capture("^- 後継Issue: #(?<number>[0-9]+)[[:space:]]*$").number | tonumber)]
        else . end
      )
    | .numbers;
  if ($relation | length) != 1 or ($closing | length) != 1 or ($follow_up | length) != 1 then
    error("各スナップショットには応答が1件必要です")
  else
    $relation[0] as $snapshot
    | $closing[0].body as $body
    | ($snapshot.command.follow_up_issue // null) as $number
    | (if $snapshot.command.action == "follow-up" then
         $follow_up[0] as $item
         | if ($item | type) != "object" or $item.number != $number
              or ($item.state != "open" and $item.state != "closed")
              or ($item | has("pull_request") and (.pull_request | type) != "object") then
             error("後継Issueの応答が不正です")
           else
             {number: $number,
              kind: (if $item | has("pull_request") then "pr" else "issue" end),
              state: $item.state,
              explicitly_recorded: (($body | follow_up_numbers | index($number)) != null)}
           end
       elif $follow_up[0] == null then null
       else error("予期しない後継Issueの応答です") end) as $follow_up_fact
    | {command: $snapshot.command, target: $snapshot.target,
       closing_issue: ($snapshot.closing_issue + {body_fingerprint: $fingerprint}),
       pull_request: $snapshot.pull_request, follow_up_issue: $follow_up_fact}
  end
' || fail_closed 'GitHub contextを組み立てられませんでした'
