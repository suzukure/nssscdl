#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
issue_number="${2:?Issue number is required}"

if [[ ! "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Invalid Issue number: ${issue_number}" >&2
  exit 1
fi

issue_json="$(gh issue view "$issue_number" --repo "$repo" --json labels)"
if jq -e '.labels | any(.name == "human-review-required")' <<< "$issue_json" > /dev/null; then
  jq -cn '{continue: false, reason: "Issue is paused by human-review-required."}'
  exit 0
fi

prs_json="$(gh pr list --repo "$repo" --head "ai/issue-${issue_number}" --state open --json number,labels)"
if jq -e 'any(.labels | any(.name == "human-review-required"))' <<< "$prs_json" > /dev/null; then
  jq -cn '{continue: false, reason: "Related open PR is paused by human-review-required."}'
  exit 0
fi

jq -cn '{continue: true, reason: ""}'
