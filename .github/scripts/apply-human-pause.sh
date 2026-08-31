#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
primary_issue="${2:--}"
pr_number="${3:-}"
label='human-review-required'

gh label create "$label" --repo "$repo" \
  --color D93F0B --description 'Automation paused pending a human decision' --force

issue_numbers=()
if [ "$primary_issue" != '-' ]; then
  if [[ ! "$primary_issue" =~ ^[0-9]+$ ]]; then
    echo "Invalid Issue number: ${primary_issue}" >&2
    exit 1
  fi
  issue_numbers+=("$primary_issue")
fi

if [ -n "$pr_number" ]; then
  if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
    echo "Invalid PR number: ${pr_number}" >&2
    exit 1
  fi
  gh issue edit "$pr_number" --repo "$repo" --add-label "$label"
  issue_prefix="https://github.com/${repo}/issues/"
  mapfile -t closing_issues < <(
    gh pr view "$pr_number" --repo "$repo" --json closingIssuesReferences \
      | jq -r --arg prefix "$issue_prefix" \
          '.closingIssuesReferences[]? | select(.url | startswith($prefix)) | .number'
  )
  issue_numbers+=("${closing_issues[@]}")
fi

if [ "${#issue_numbers[@]}" -gt 0 ]; then
  while read -r issue_number; do
    [ -n "$issue_number" ] || continue
    gh issue edit "$issue_number" --repo "$repo" --add-label "$label"
  done < <(printf '%s\n' "${issue_numbers[@]}" | sort -nu)
fi
