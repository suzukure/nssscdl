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
  echo 'The PR must use a closing keyword to link at least one Issue in this repository, for example: Closes #123.' >&2
  exit 1
fi

open_issue_count=0
for issue_number in "${linked_issues[@]}"; do
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    echo "Could not fetch closing Issue #${issue_number}; refusing to continue." >&2
    exit 1
  fi
  if jq -e '.state == "open" and (has("pull_request") | not)' <<< "$issue_json" > /dev/null; then
    open_issue_count=$((open_issue_count + 1))
  fi
done

if [ "$open_issue_count" -lt 1 ]; then
  echo 'At least one same-repository closing Issue must be open.' >&2
  exit 1
fi

if [ "$mode" != 'merge' ]; then
  exit 0
fi

if [ -z "$developer_app_slug" ]; then
  echo 'Developer App slug is required for merge verification.' >&2
  exit 1
fi

author_login="$(jq -r '.author.login' "$metadata")"
if [ "$author_login" != "$developer_app_slug" ] && [ "$author_login" != "${developer_app_slug}[bot]" ]; then
  echo "Auto-merge requires a PR authored by the developer App; got: ${author_login}" >&2
  exit 1
fi

jq -e '.state == "OPEN" and (.isDraft | not)' "$metadata" > /dev/null \
  || { echo 'Only an open, non-draft PR can be auto-merged.' >&2; exit 1; }

jq -e '.baseRefName == "main"' "$metadata" > /dev/null \
  || { echo 'Auto-merge is restricted to pull requests targeting main.' >&2; exit 1; }

head_ref="$(jq -r '.headRefName' "$metadata")"
if [[ ! "$head_ref" =~ ^ai/issue-([0-9]+)$ ]]; then
  echo "Auto-merge is restricted to ai/issue-<number> branches; got: ${head_ref}" >&2
  exit 1
fi

branch_issue="${BASH_REMATCH[1]}"
if ! printf '%s\n' "${linked_issues[@]}" | grep -qx "$branch_issue"; then
  echo "Branch Issue #${branch_issue} must be a same-repository PR closing Issue." >&2
  exit 1
fi

if jq -e '.labels | any(.name == "human-review-required")' "$metadata" > /dev/null; then
  echo 'Auto-merge is paused by the human-review-required label.' >&2
  exit 1
fi

protected_paths="$(
  gh pr diff "$pr_number" --repo "$repo" --name-only \
    | grep -E '(^|/)(AGENTS\.md|CLAUDE\.md|\.mcp\.json)$|(^|/)\.(claude|codex)(/|$)|^\.github/' \
    || true
)"
if [ -n "$protected_paths" ]; then
  echo 'AI instruction, agent configuration, and GitHub automation changes require a human Code Owner merge:' >&2
  printf '%s\n' "$protected_paths" >&2
  exit 1
fi
