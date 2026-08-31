#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
mode="${3:-traceability}"

metadata="$(mktemp)"
trap 'rm -f "$metadata"' EXIT

gh pr view "$pr_number" --repo "$repo" \
  --json number,state,isDraft,headRefName,closingIssuesReferences,labels \
  > "$metadata"

linked_count="$(jq '.closingIssuesReferences | length' "$metadata")"
if [ "$linked_count" -lt 1 ]; then
  echo 'The PR must use a closing keyword to link at least one existing Issue, for example: Closes #123.' >&2
  exit 1
fi

if [ "$mode" != 'merge' ]; then
  exit 0
fi

jq -e '.state == "OPEN" and (.isDraft | not)' "$metadata" > /dev/null \
  || { echo 'Only an open, non-draft PR can be auto-merged.' >&2; exit 1; }

head_ref="$(jq -r '.headRefName' "$metadata")"
if [[ ! "$head_ref" =~ ^ai/issue-([0-9]+)$ ]]; then
  echo "Auto-merge is restricted to ai/issue-<number> branches; got: ${head_ref}" >&2
  exit 1
fi

branch_issue="${BASH_REMATCH[1]}"
jq -e --argjson issue "$branch_issue" \
  '.closingIssuesReferences | any(.number == $issue)' "$metadata" > /dev/null \
  || { echo "Branch Issue #${branch_issue} must be one of the PR closing Issues." >&2; exit 1; }

if jq -e '.labels | any(.name == "human-review-required")' "$metadata" > /dev/null; then
  echo 'Auto-merge is paused by the human-review-required label.' >&2
  exit 1
fi
