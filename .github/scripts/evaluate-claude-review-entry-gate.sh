#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"

metadata="$(gh pr view "$pr_number" --repo "$repo" --json labels,closingIssuesReferences)"

emit_result() {
  jq -cn --argjson continue "$1" --arg reason "$2" \
    '{continue: $continue, reason: $reason}'
}

if jq -e '.labels | any(.name == "human-review-required")' <<< "$metadata" > /dev/null; then
  emit_result false 'Claude review is paused by the human-review-required label on the PR.'
  exit 0
fi

issue_prefix="https://github.com/${repo}/issues/"
mapfile -t closing_issues < <(
  jq -r --arg prefix "$issue_prefix" \
    '.closingIssuesReferences[]? | select(.url | startswith($prefix)) | .number' \
    <<< "$metadata"
)

if [ "${#closing_issues[@]}" -lt 1 ]; then
  echo 'Claude review requires at least one same-repository closing Issue.' >&2
  exit 1
fi

for issue_number in "${closing_issues[@]}"; do
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    echo "Could not fetch closing Issue #${issue_number}; refusing Claude review." >&2
    exit 1
  fi
  if jq -e '(.labels // []) | any(.name == "human-review-required")' <<< "$issue_json" > /dev/null; then
    emit_result false "Claude review is paused by the human-review-required label on Issue #${issue_number}."
    exit 0
  fi
done

emit_result true ''
