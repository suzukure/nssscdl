#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
output="${3:?output path is required}"

mkdir -p "$(dirname "$output")"
metadata="$(mktemp)"

gh pr view "$pr_number" \
  --repo "$repo" \
  --json number,title,body,url,author,baseRefName,headRefName,isDraft,files,commits,reviews,comments \
  > "$metadata"

{
  echo '# Pull request review context'
  echo
  jq -r '
    "- PR: #\(.number) \(.title)",
    "- URL: \(.url)",
    "- Author: \(.author.login)",
    "- Branch: \(.headRefName) -> \(.baseRefName)",
    "- Draft: \(.isDraft)",
    "",
    "## Pull request body",
    "",
    (.body // "(empty)"),
    "",
    "## Changed files",
    "",
    (.files[] | "- \(.path) (+\(.additions) / -\(.deletions))"),
    "",
    "## Existing conversation",
    "",
    ((.comments[]? | "### Comment by \(.author.login)\n\n\(.body)\n") // empty),
    ((.reviews[]? | "### Review by \(.author.login) — \(.state)\n\n" + (.body // "") + "\n") // empty)
  ' "$metadata"

  echo
  echo '## Linked Issue snapshots'
  echo

  jq -r '.body // ""' "$metadata" \
    | grep -Eo '#[0-9]+' \
    | tr -d '#' \
    | sort -nu \
    | while read -r issue_number; do
        [ -n "$issue_number" ] || continue
        gh api "repos/${repo}/issues/${issue_number}" \
          --jq '"### Issue #\(.number): \(.title)\n\nState: \(.state)\n\n" + (.body // "(empty)") + "\n"' \
          || echo "Issue #${issue_number} could not be fetched."
      done

  echo
  echo '## Pull request diff'
  echo
  gh pr diff "$pr_number" --repo "$repo"
} > "$output"

rm -f "$metadata"
