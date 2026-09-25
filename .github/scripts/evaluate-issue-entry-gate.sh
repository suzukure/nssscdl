#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
issue_number="${2:?Issue number is required}"

if [[ ! "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Invalid Issue number: ${issue_number}" >&2
  exit 1
fi

issue_json="$(gh issue view "$issue_number" --repo "$repo" --json labels)"
if ! jq -es 'length == 1 and (.[0] | type == "object" and
    (.labels | type == "array") and
    all(.labels[]; type == "object" and (.name | type == "string")))' \
    <<< "$issue_json" > /dev/null; then
  echo 'Invalid Issue label metadata; refusing development.' >&2
  exit 1
fi
issue_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$issue_json")"
if [ "$issue_paused" = true ]; then
  jq -cn '{continue: false, reason: "Issue is paused by human-review-required."}'
  exit 0
fi

prs_json="$(gh pr list --repo "$repo" --head "ai/issue-${issue_number}" --state open --json number,labels)"
if ! jq -es 'length == 1 and (.[0] | type == "array" and
    all(.[]; type == "object" and
      (.number | type == "number" and . > 0 and floor == .) and
      (.labels | type == "array") and
      all(.labels[]; type == "object" and (.name | type == "string"))))' \
    <<< "$prs_json" > /dev/null; then
  echo 'Invalid related PR label metadata; refusing development.' >&2
  exit 1
fi
pr_paused="$(jq -r 'any(.labels | any(.name == "human-review-required"))' <<< "$prs_json")"
if [ "$pr_paused" = true ]; then
  jq -cn '{continue: false, reason: "Related open PR is paused by human-review-required."}'
  exit 0
fi

jq -cn '{continue: true, reason: ""}'
