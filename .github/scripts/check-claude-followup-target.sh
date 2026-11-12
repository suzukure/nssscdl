#!/usr/bin/env bash
set -euo pipefail

# A stale or unverifiable review is a normal skip, not a failed developer run.
repo="${1:-}"
pr_number="${2:-}"
review_id="${3:-}"
review_commit="${4:-}"
reviewer_slug="${5:-}"
head_ref="${6:-}"
skip() { printf 'skip\n'; exit 0; }

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || skip
[[ "$pr_number" =~ ^[1-9][0-9]*$ && "$review_id" =~ ^[1-9][0-9]*$ ]] || skip
[[ "$review_commit" =~ ^[0-9a-f]{40}$ && "$head_ref" =~ ^ai/issue-([1-9][0-9]*)$ ]] || skip
issue_number="${BASH_REMATCH[1]}"
[[ -n "$reviewer_slug" ]] || skip

review="$(gh api "repos/$repo/pulls/$pr_number/reviews/$review_id" 2>/dev/null)" || skip
jq -es --argjson id "$review_id" --arg sha "$review_commit" --arg slug "$reviewer_slug" '
  length == 1 and (.[0] |
    type == "object" and .id == $id and .state == "CHANGES_REQUESTED" and
    .commit_id == $sha and
    (.user.login == $slug or .user.login == ($slug + "[bot]") or
     .user.login == ("app/" + $slug)))
' <<< "$review" >/dev/null 2>&1 || skip

pr="$(gh pr view "$pr_number" --repo "$repo" --json number,state,headRefOid,headRefName,labels,closingIssuesReferences 2>/dev/null)" || skip
jq -es --argjson number "$pr_number" --arg sha "$review_commit" \
  --arg ref "$head_ref" --arg issue "$issue_number" \
  --arg url "https://github.com/$repo/issues/$issue_number" '
  length == 1 and (.[0] |
    type == "object" and .number == $number and .state == "OPEN" and
    .headRefOid == $sha and .headRefName == $ref and
    (.labels | type == "array" and all(.[]; type == "object" and (.name | type == "string")) and
      all(.[]; .name != "human-review-required")) and
    (.closingIssuesReferences | type == "array" and
      any(.[]; .number == ($issue | tonumber) and .url == $url)))
' <<< "$pr" >/dev/null 2>&1 || skip

issue="$(gh api "repos/$repo/issues/$issue_number" 2>/dev/null)" || skip
jq -es --argjson number "$issue_number" '
  length == 1 and (.[0] |
    type == "object" and .number == $number and .state == "open" and
    (has("pull_request") | not) and
    (.labels | type == "array" and all(.[]; type == "object" and (.name | type == "string")) and
      all(.[]; .name != "human-review-required")))
' <<< "$issue" >/dev/null 2>&1 || skip

printf 'current\n'
