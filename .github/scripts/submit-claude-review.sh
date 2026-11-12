#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
review_json="${3:?review JSON path is required}"
commit_id="${4:-}"

jq -e '
  (.verdict == "approve" or .verdict == "request_changes") and
  (.summary | type == "string") and
  (.blocking_findings | type == "array") and
  (.non_blocking_findings | type == "array") and
  (.linked_issues_checked | type == "array")
' "$review_json" > /dev/null

verdict="$(jq -r '.verdict' "$review_json")"
if [ "$verdict" = 'approve' ]; then
  event='APPROVE'
else
  event='REQUEST_CHANGES'
fi

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
{
  echo '## Claudeレビュー'
  echo
  echo "**判定:** \`$verdict\`"
  echo
  echo '--- BEGIN REVIEW SUMMARY DATA ---'
  jq -r '.summary | split("\n") | map("SUMMARY| " + .) | join("\n")' "$review_json"
  echo '--- END REVIEW SUMMARY DATA ---'
  echo
  echo '### 修正必須の指摘'
  echo
  if jq -e '.blocking_findings | length == 0' "$review_json" > /dev/null; then
    echo '- なし。'
  else
    jq -r '.blocking_findings[] | "- " + .' "$review_json"
  fi
  echo
  echo '### 修正任意の指摘'
  echo
  if jq -e '.non_blocking_findings | length == 0' "$review_json" > /dev/null; then
    echo '- なし。'
  else
    jq -r '.non_blocking_findings[] | "- " + .' "$review_json"
  fi
  echo
  echo '### 確認した関連Issue'
  echo
  if jq -e '.linked_issues_checked | length == 0' "$review_json" > /dev/null; then
    echo '- なし。'
  else
    jq -r '.linked_issues_checked[] | "- " + .' "$review_json"
  fi
} > "$body_file"

jq -n \
  --arg event "$event" \
  --arg commit_id "$commit_id" \
  --rawfile body "$body_file" \
  '{event: $event, body: $body} + (if $commit_id == "" then {} else {commit_id: $commit_id} end)' \
  | gh api --method POST "repos/${repo}/pulls/${pr_number}/reviews" --input - > /dev/null

echo "Claudeレビューを投稿しました。判定: ${verdict}"
