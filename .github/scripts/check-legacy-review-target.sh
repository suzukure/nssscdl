#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?PR number is required}"
review_id="${3:?review ID is required}"
review_commit="${4:?review commit is required}"
reviewer="${5:?reviewer App slug is required}"

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$pr_number" =~ ^[1-9][0-9]*$ \
  && "$review_id" =~ ^[1-9][0-9]*$ && "$review_commit" =~ ^[0-9a-f]{40}$ \
  && "$reviewer" =~ ^[A-Za-z0-9_-]+$ ]] || exit 1

review="$(gh api "repos/${repo}/pulls/${pr_number}/reviews/${review_id}")" || exit 1
jq -es --argjson id "$review_id" --arg commit "$review_commit" --arg slug "$reviewer" '
  length == 1 and (.[0] | type == "object" and .id == $id
    and .commit_id == $commit and .state == "CHANGES_REQUESTED"
    and (.user.login == $slug or .user.login == ($slug + "[bot]")
         or .user.login == ("app/" + $slug)))
' <<< "$review" >/dev/null || exit 1

pr="$(gh pr view "$pr_number" --repo "$repo" \
  --json number,state,headRefOid,labels,closingIssuesReferences)" || exit 1
jq -es --argjson number "$pr_number" --arg head "$review_commit" '
  length == 1 and (.[0] | type == "object" and .number == $number
    and .state == "OPEN" and .headRefOid == $head
    and (.labels | type == "array")
    and all(.labels[]; type == "object" and (.name | type == "string"))
    and ([.labels[].name] | index("human-review-required") == null)
    and (.closingIssuesReferences | type == "array" and length > 0)
    and all(.closingIssuesReferences[]; type == "object"
      and (.number | type == "number" and . > 0 and floor == .)
      and (.url | type == "string")))
' <<< "$pr" >/dev/null || exit 1

issue_numbers="$(jq -r --arg repo "$repo" '
  .closingIssuesReferences[] |
  select(.url == ("https://github.com/" + $repo + "/issues/" + (.number | tostring))) |
  .number
' <<< "$pr")" || exit 1
[ -n "$issue_numbers" ] || exit 1
while IFS= read -r issue_number; do
  issue="$(gh api "repos/${repo}/issues/${issue_number}")" || exit 1
  jq -es --argjson number "$issue_number" '
    length == 1 and (.[0] | type == "object" and .number == $number
      and .state == "open" and (has("pull_request") | not)
      and (.labels | type == "array")
      and all(.labels[]; type == "object" and (.name | type == "string"))
      and ([.labels[].name] | index("human-review-required") == null))
  ' <<< "$issue" >/dev/null || exit 1
done <<< "$issue_numbers"
