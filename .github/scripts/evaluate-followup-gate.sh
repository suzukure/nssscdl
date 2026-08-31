#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
reviewer_app_slug="${3:?reviewer App slug is required}"
developer_app_slug="${4:?developer App slug is required}"
review_body="${5:-}"

metadata="$(gh pr view "$pr_number" --repo "$repo" --json author,reviews,labels,closingIssuesReferences)"
author_login="$(jq -r '.author.login' <<< "$metadata")"

emit_result() {
  jq -cn \
    --argjson continue "$1" \
    --argjson escalate "$2" \
    --argjson notify "$3" \
    --arg reason "$4" \
    '{continue: $continue, escalate: $escalate, notify: $notify, reason: $reason}'
}

if [ "$author_login" != "$developer_app_slug" ] && [ "$author_login" != "${developer_app_slug}[bot]" ]; then
  emit_result false false false "Ignoring automated follow-up for untrusted PR author: ${author_login}"
  exit 0
fi

if jq -e '.labels | any(.name == "human-review-required")' <<< "$metadata" > /dev/null; then
  emit_result false false false 'Codex follow-up remains paused by the human-review-required label.'
  exit 0
fi

issue_prefix="https://github.com/${repo}/issues/"
mapfile -t closing_issues < <(
  jq -r --arg prefix "$issue_prefix" \
    '.closingIssuesReferences[]? | select(.url | startswith($prefix)) | .number' \
    <<< "$metadata"
)
for issue_number in "${closing_issues[@]}"; do
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    echo "Could not fetch closing Issue #${issue_number}; refusing automated follow-up." >&2
    exit 1
  fi
  if jq -e '(.labels // []) | any(.name == "human-review-required")' <<< "$issue_json" > /dev/null; then
    emit_result false false false "Codex follow-up remains paused by the human-review-required label on Issue #${issue_number}."
    exit 0
  fi
done

review_count="$(
  jq --arg slug "$reviewer_app_slug" \
    '[.reviews[]? | select((.author.login == $slug or .author.login == ($slug + "[bot]")) and .state == "CHANGES_REQUESTED")] | length' \
    <<< "$metadata"
)"

review_summary="$(sed -n '/^\*\*Verdict:/,/^### Blocking findings/{ /^\*\*Verdict:/d; /^### Blocking findings/d; p; }' <<< "$review_body")"
if grep -Eq '\[(REQUIREMENTS_CHANGE_REQUIRED|HUMAN_ESCALATION_RECOMMENDED)\]' <<< "$review_summary"; then
  emit_result false true false 'Claude requested a human decision.'
elif [ "$review_count" -ge 3 ]; then
  emit_result false true true "Automated review reached ${review_count} change-request rounds."
else
  emit_result true false false ''
fi
