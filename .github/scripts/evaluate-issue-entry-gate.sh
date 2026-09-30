#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
issue_number="${2:?Issue number is required}"

if [[ ! "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Issue番号が不正です: ${issue_number}" >&2
  exit 1
fi

issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"
if ! jq -es --argjson expected_number "$issue_number" 'length == 1 and (.[0] | type == "object" and
    .number == $expected_number and
    (.state == "open" or .state == "closed") and
    (has("pull_request") | not) and
    (.labels | type == "array") and
    all(.labels[]; type == "object" and (.name | type == "string")))' \
    <<< "$issue_json" > /dev/null; then
  echo 'Issueの識別情報・状態・ラベル情報が不正なため、開発を停止します。' >&2
  exit 1
fi
if [ "$(jq -r .state <<< "$issue_json")" = closed ]; then
  jq -cn '{continue: false, reason: "Issueがclosedです。"}'
  exit 0
fi
issue_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$issue_json")"
if [ "$issue_paused" = true ]; then
  jq -cn '{continue: false, reason: "human-review-requiredによりIssueが停止中です。"}'
  exit 0
fi

prs_json="$(gh pr list --repo "$repo" --head "ai/issue-${issue_number}" --state open --json number,labels)"
if ! jq -es 'length == 1 and (.[0] | type == "array" and
    all(.[]; type == "object" and
      (.number | type == "number" and . > 0 and floor == .) and
      (.labels | type == "array") and
      all(.labels[]; type == "object" and (.name | type == "string"))))' \
    <<< "$prs_json" > /dev/null; then
  echo '関連PRのラベル情報が不正なため、開発を停止します。' >&2
  exit 1
fi
pr_paused="$(jq -r 'any(.labels | any(.name == "human-review-required"))' <<< "$prs_json")"
if [ "$pr_paused" = true ]; then
  jq -cn '{continue: false, reason: "関連するopen PRがhuman-review-requiredにより停止中です。"}'
  exit 0
fi

jq -cn '{continue: true, reason: ""}'
