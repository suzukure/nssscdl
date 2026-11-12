#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
primary_issue="${2:--}"
pr_number="${3:-}"
label='human-review-required'

issue_numbers=()
if [ "$primary_issue" != '-' ]; then
  if [[ ! "$primary_issue" =~ ^[0-9]+$ ]]; then
    echo "Issue番号が不正です: ${primary_issue}" >&2
    exit 1
  fi
  issue_numbers+=("$primary_issue")
fi

if [ -n "$pr_number" ]; then
  if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
    echo "PR番号が不正です: ${pr_number}" >&2
    exit 1
  fi
  issue_prefix="https://github.com/${repo}/issues/"
  if ! pr_json="$(gh pr view "$pr_number" --repo "$repo" --json closingIssuesReferences)"; then
    echo "PR #${pr_number}を取得できないため、停止ラベルの部分的な同期を行いません。" >&2
    exit 1
  fi
  issue_numbers+=("$pr_number")
  closing_issue_numbers="$(
    jq -r --arg prefix "$issue_prefix" \
      '.closingIssuesReferences[]? | select(.url | startswith($prefix)) | .number' \
      <<< "$pr_json"
  )"
  if [ -n "$closing_issue_numbers" ]; then
    mapfile -t closing_issues <<< "$closing_issue_numbers"
    issue_numbers+=("${closing_issues[@]}")
  fi
fi

gh label create "$label" --repo "$repo" \
  --color D93F0B --description '人間の判断を待つため自動処理を停止中' --force

if [ "${#issue_numbers[@]}" -gt 0 ]; then
  while read -r issue_number; do
    [ -n "$issue_number" ] || continue
    gh issue edit "$issue_number" --repo "$repo" --add-label "$label"
  done < <(printf '%s\n' "${issue_numbers[@]}" | sort -nu)
fi
