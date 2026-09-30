#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
mode="${3:-traceability}"
developer_app_slug="${4:-}"

metadata="$(mktemp)"
trap 'rm -f "$metadata"' EXIT

gh pr view "$pr_number" --repo "$repo" \
  --json number,state,isDraft,author,baseRefName,headRefName,closingIssuesReferences,labels \
  > "$metadata"

issue_prefix="https://github.com/${repo}/issues/"
mapfile -t linked_issues < <(
  jq -r --arg prefix "$issue_prefix" \
    '.closingIssuesReferences[]? | select(.url | startswith($prefix)) | .number' "$metadata" \
    | sort -nu
)

if [ "${#linked_issues[@]}" -lt 1 ]; then
  echo 'PRにはこのリポジトリのIssueを1件以上closing keywordで関連付けてください（例: Closes #123）。' >&2
  exit 1
fi

open_issue_count=0
paused_issue_count=0
for issue_number in "${linked_issues[@]}"; do
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    echo "closing Issue #${issue_number}を取得できないため、処理を停止します。" >&2
    exit 1
  fi
  if jq -e '.state == "open" and (has("pull_request") | not)' <<< "$issue_json" > /dev/null; then
    open_issue_count=$((open_issue_count + 1))
  fi
  if jq -e '(.labels // []) | any(.name == "human-review-required")' <<< "$issue_json" > /dev/null; then
    paused_issue_count=$((paused_issue_count + 1))
  fi
done

if [ "$open_issue_count" -lt 1 ]; then
  echo 'このリポジトリのclosing Issueが1件以上openである必要があります。' >&2
  exit 1
fi

if [ "$mode" != 'merge' ]; then
  exit 0
fi

if [ -z "$developer_app_slug" ]; then
  echo 'マージ判定にはDeveloper App slugが必要です。' >&2
  exit 1
fi

author_login="$(jq -r '.author.login' "$metadata")"
if [ "$author_login" != "$developer_app_slug" ] \
    && [ "$author_login" != "${developer_app_slug}[bot]" ] \
    && [ "$author_login" != "app/${developer_app_slug}" ]; then
  echo "自動マージにはdeveloper App作成のPRが必要です。現在の作成者: ${author_login}" >&2
  exit 1
fi

jq -e '.state == "OPEN" and (.isDraft | not)' "$metadata" > /dev/null \
  || { echo '自動マージできるのはopenかつ非DraftのPRだけです。' >&2; exit 1; }

jq -e '.baseRefName == "main"' "$metadata" > /dev/null \
  || { echo '自動マージはmainを対象とするPRに限定されます。' >&2; exit 1; }

head_ref="$(jq -r '.headRefName' "$metadata")"
if [[ ! "$head_ref" =~ ^ai/issue-([0-9]+)$ ]]; then
  echo "自動マージはai/issue-<number>ブランチに限定されます。現在のブランチ: ${head_ref}" >&2
  exit 1
fi

branch_issue="${BASH_REMATCH[1]}"
if ! printf '%s\n' "${linked_issues[@]}" | grep -qx "$branch_issue"; then
  echo "ブランチのIssue #${branch_issue}は同じリポジトリのPR closing Issueである必要があります。" >&2
  exit 1
fi

if jq -e '.labels | any(.name == "human-review-required")' "$metadata" > /dev/null; then
  echo 'human-review-requiredラベルにより自動マージを停止しています。' >&2
  exit 1
fi

if [ "$paused_issue_count" -gt 0 ]; then
  echo 'closing Issueにhuman-review-requiredラベルがあるため、自動マージを停止しています。' >&2
  exit 1
fi

protected_paths="$(bash "$(dirname "$0")/classify-claude-review-risk.sh" "$repo" "$pr_number" list)"
if [ -n "$protected_paths" ]; then
  echo 'AI指示・agent設定・GitHub自動化の変更には人間のCode Ownerによるマージが必要です:' >&2
  printf '%s\n' "$protected_paths" >&2
  exit 1
fi
