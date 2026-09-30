#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
reviewed_head="${3:?reviewed head SHA is required}"
event_action="${4:-}"
event_machine_state="${5:-false}"
[[ "$reviewed_head" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid reviewed head SHA; refusing Claude review.' >&2; exit 1; }
[[ "$event_machine_state" = true || "$event_machine_state" = false ]] || { echo 'Invalid event machine-state fact; refusing Claude review.' >&2; exit 1; }

if ! metadata="$(gh pr view "$pr_number" --repo "$repo" --json number,state,isDraft,headRefOid,labels,closingIssuesReferences)"; then
  echo 'Could not fetch current pull request metadata; refusing Claude review.' >&2
  exit 1
fi

emit_result() {
  jq -cn --argjson continue "$1" --arg reason "$2" \
    '{continue: $continue, reason: $reason}'
}

if ! pr_state="$(jq -er '.state | select(type == "string")' <<< "$metadata")"; then
  echo 'Could not determine pull request state; refusing Claude review.' >&2
  exit 1
fi
case "$pr_state" in
  OPEN)
    ;;
  CLOSED|MERGED)
    emit_result false "Claude review is not run for pull request state ${pr_state}."
    exit 0
    ;;
  *)
    echo "Unsupported pull request state ${pr_state}; refusing Claude review." >&2
    exit 1
    ;;
esac

if ! jq -es 'length == 1 and (.[0] | type == "object" and
    (.number | type == "number" and . > 0 and floor == .) and
    (.isDraft | type == "boolean") and
    (.headRefOid | type == "string" and test("^[0-9a-f]{40}$")) and
    (.labels | type == "array") and
    all(.labels[]; type == "object" and (.name | type == "string")) and
    (.closingIssuesReferences | type == "array") and
    all(.closingIssuesReferences[]; type == "object" and
      (.number | type == "number" and . > 0 and floor == .) and
      (.url | type == "string")))' <<< "$metadata" > /dev/null; then
  echo 'Invalid pull request metadata; refusing Claude review.' >&2
  exit 1
fi
if [ "$(jq -r .number <<< "$metadata")" != "$pr_number" ]; then
  echo 'Pull request number mismatch; refusing Claude review.' >&2
  exit 1
fi
if [ "$(jq -r .isDraft <<< "$metadata")" = true ]; then
  emit_result false 'Claude review is not run for a Draft pull request.'
  exit 0
fi
if [ "$(jq -r .headRefOid <<< "$metadata")" != "$reviewed_head" ]; then
  emit_result false 'Claude review is not run because the current PR HEAD differs from the reviewed event HEAD.'
  exit 0
fi

pr_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$metadata")"
if [ "$pr_paused" = true ]; then
  emit_result false 'Claude review is paused by the human-review-required label on the PR.'
  exit 0
fi
if [ "$event_machine_state" = true ] ||
  [ "$(jq -r '.labels | any(.name == "ai-followup-in-progress")' <<< "$metadata")" = true ]; then
  emit_result false 'Normal Claude review is suppressed for a machine-state PR.'
  exit 0
fi

issue_prefix="https://github.com/${repo}/issues/"
if ! closing_issues="$(jq -r --arg prefix "$issue_prefix" \
    '.closingIssuesReferences[] | select(.url | startswith($prefix)) | .number' \
    <<< "$metadata")"; then
  echo 'Could not extract closing Issues; refusing Claude review.' >&2
  exit 1
fi
if [ -z "$closing_issues" ]; then
  echo 'No same-repository closing Issue; refusing Claude review.' >&2
  exit 1
fi

while IFS= read -r issue_number; do
  [ -n "$issue_number" ] || continue
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    echo "Could not fetch closing Issue #${issue_number}; refusing Claude review." >&2
    exit 1
  fi
  if ! jq -es 'length == 1 and (.[0] | type == "object" and
      (.labels | type == "array") and
      all(.labels[]; type == "object" and (.name | type == "string")))' \
      <<< "$issue_json" > /dev/null; then
    echo "Invalid closing Issue #${issue_number} label metadata; refusing Claude review." >&2
    exit 1
  fi
  issue_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$issue_json")"
  if [ "$issue_paused" = true ]; then
    emit_result false "Claude review is paused by the human-review-required label on Issue #${issue_number}."
    exit 0
  fi
done <<< "$closing_issues"

emit_result true ''
