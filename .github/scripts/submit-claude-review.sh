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
  echo '## Claude review'
  echo
  echo "**Verdict:** \`$verdict\`"
  echo
  jq -r '.summary' "$review_json"
  echo
  echo '### Blocking findings'
  echo
  if jq -e '.blocking_findings | length == 0' "$review_json" > /dev/null; then
    echo '- None.'
  else
    jq -r '.blocking_findings[] | "- " + .' "$review_json"
  fi
  echo
  echo '### Non-blocking findings'
  echo
  if jq -e '.non_blocking_findings | length == 0' "$review_json" > /dev/null; then
    echo '- None.'
  else
    jq -r '.non_blocking_findings[] | "- " + .' "$review_json"
  fi
  echo
  echo '### Linked Issues checked'
  echo
  if jq -e '.linked_issues_checked | length == 0' "$review_json" > /dev/null; then
    echo '- None.'
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

echo "Claude review submitted with verdict: ${verdict}"
