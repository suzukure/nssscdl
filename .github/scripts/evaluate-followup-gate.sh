#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
reviewer_app_slug="${3:?reviewer App slug is required}"
developer_app_slug="${4:?developer App slug is required}"
review_body="${5:-}"

metadata="$(gh pr view "$pr_number" --repo "$repo" --json author,reviews,labels,closingIssuesReferences)"
if ! jq -es 'length == 1 and (.[0] | type == "object" and
    (.author.login | type == "string") and
    (.reviews | type == "array") and
    (.labels | type == "array") and
    all(.labels[]; type == "object" and (.name | type == "string")) and
    (.closingIssuesReferences | type == "array") and
    all(.closingIssuesReferences[]; type == "object" and
      (.number | type == "number" and . > 0 and floor == .) and
      (.url | type == "string")))' <<< "$metadata" > /dev/null; then
  echo 'Invalid pull request metadata; refusing automated follow-up.' >&2
  exit 1
fi
author_login="$(jq -r '.author.login' <<< "$metadata")"

emit_result() {
  jq -cn \
    --argjson continue "$1" \
    --argjson escalate "$2" \
    --argjson notify "$3" \
    --arg reason "$4" \
    --arg pause_code "${5:-}" \
    '{continue: $continue, escalate: $escalate, notify: $notify, reason: $reason, pause_code: $pause_code}'
}

normal_followup_reason() {
  printf '%s\n' 'Automated Codex follow-up passed the entry gate; successful trusted completion will request re-review by marking the PR ready for review.'
}

human_decision_pause_reason() {
  printf '%s\n' 'Codex follow-up is paused; a human must decide how to proceed.'
}

if [ "$author_login" != "$developer_app_slug" ] \
    && [ "$author_login" != "${developer_app_slug}[bot]" ] \
    && [ "$author_login" != "app/${developer_app_slug}" ]; then
  emit_result false false false "Ignoring automated follow-up for untrusted PR author: ${author_login}"
  exit 0
fi

pr_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$metadata")"
if [ "$pr_paused" = true ]; then
  emit_result false false false 'Codex follow-up remains paused by the human-review-required label.'
  exit 0
fi

issue_prefix="https://github.com/${repo}/issues/"
if ! closing_issues="$(jq -r --arg prefix "$issue_prefix" \
    '.closingIssuesReferences[] | select(.url | startswith($prefix)) | .number' \
    <<< "$metadata")"; then
  echo 'Could not extract closing Issues; refusing automated follow-up.' >&2
  exit 1
fi
while IFS= read -r issue_number; do
  [ -n "$issue_number" ] || continue
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    echo "Could not fetch closing Issue #${issue_number}; refusing automated follow-up." >&2
    exit 1
  fi
  if ! jq -es 'length == 1 and (.[0] | type == "object" and
      (.labels | type == "array") and
      all(.labels[]; type == "object" and (.name | type == "string")))' \
      <<< "$issue_json" > /dev/null; then
    echo "Invalid closing Issue #${issue_number} label metadata; refusing automated follow-up." >&2
    exit 1
  fi
  issue_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$issue_json")"
  if [ "$issue_paused" = true ]; then
    emit_result false false false "Codex follow-up remains paused by the human-review-required label on Issue #${issue_number}."
    exit 0
  fi
done <<< "$closing_issues"

review_count="$(
  jq --arg slug "$reviewer_app_slug" \
    '[.reviews[]? | select((.author.login == $slug or .author.login == ($slug + "[bot]") or .author.login == ("app/" + $slug)) and .state == "CHANGES_REQUESTED")] | length' \
    <<< "$metadata"
)"

if ! grep -Fxq -- '--- BEGIN REVIEW SUMMARY DATA ---' <<< "$review_body" \
    || ! grep -Fxq -- '--- END REVIEW SUMMARY DATA ---' <<< "$review_body"; then
  emit_result false true false "Could not parse the trusted reviewer summary; refusing automated follow-up. $(human_decision_pause_reason)" state_inconsistent
  exit 0
fi
review_summary="$(
  sed -n '/^--- BEGIN REVIEW SUMMARY DATA ---$/,/^--- END REVIEW SUMMARY DATA ---$/{
    /^SUMMARY| /{s/^SUMMARY| //; p;}
  }' <<< "$review_body"
)"
human_escalation=false
while IFS= read -r summary_line || [ -n "$summary_line" ]; do
  summary_line="${summary_line%$'\r'}"
  case "$summary_line" in
    '[REQUIREMENTS_CHANGE_REQUIRED]'|'[HUMAN_ESCALATION_RECOMMENDED]')
      human_escalation=true
      break
      ;;
  esac
done <<< "$review_summary"

if [ "$human_escalation" = true ]; then
  emit_result false true false "Claude requested a human decision. $(human_decision_pause_reason)" explicit_human_escalation
elif [ "$review_count" -ge 3 ]; then
  emit_result false true true "Automated review reached ${review_count} change-request rounds. $(human_decision_pause_reason)" round_limit
else
  emit_result true false false "$(normal_followup_reason)"
fi
