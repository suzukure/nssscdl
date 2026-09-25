#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export GH_LOG="$test_dir/gh.log" PAID_LOG="$test_dir/paid.log"

valid_pr='{"state":"OPEN","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}'
valid_issue='{"labels":[]}'
valid_pr_list='[]'
export MOCK_PR_JSON="$valid_pr" MOCK_ISSUE_JSON="$valid_issue" MOCK_PR_LIST_JSON="$valid_pr_list" MOCK_API_JSON="$valid_issue"

gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$1 $2" in
    'issue view') [ "${MOCK_FAIL:-}" != issue ] || return 1; printf '%s\n' "$MOCK_ISSUE_JSON" ;;
    'pr list') [ "${MOCK_FAIL:-}" != list ] || return 1; printf '%s\n' "$MOCK_PR_LIST_JSON" ;;
    'pr view') [ "${MOCK_FAIL:-}" != pr ] || return 1; printf '%s\n' "$MOCK_PR_JSON" ;;
    'api repos/owner/repo/issues/36') [ "${MOCK_FAIL:-}" != api ] || return 1; printf '%s\n' "$MOCK_API_JSON" ;;
    *) return 2 ;;
  esac
}
export -f gh
jq() {
  if [ "${MOCK_JQ_EXTRACT_FAIL:-false}" = true ] \
      && [[ "$*" == *'.closingIssuesReferences[] | select('* ]]; then
    return 1
  fi
  command jq "$@"
}
export -f jq

issue_gate="$repo_root/.github/scripts/evaluate-issue-entry-gate.sh"
review_gate="$repo_root/.github/scripts/evaluate-claude-review-entry-gate.sh"
followup_gate="$repo_root/.github/scripts/evaluate-followup-gate.sh"
review_body=$'--- BEGIN REVIEW SUMMARY DATA ---\nSUMMARY| ordinary finding\n--- END REVIEW SUMMARY DATA ---'

assert_passes() {
  local output
  output="$("$@")"
  jq -e '.continue == true' <<< "$output" > /dev/null
}

assert_stops() {
  local name="$1" output
  shift
  : > "$GH_LOG"
  : > "$PAID_LOG"
  if output="$(bash -c 'set -e; result="$("$@")"; printf "%s\n" "$result"; printf "paid\n" >> "$PAID_LOG"' \
      -- "$@" 2> "$test_dir/error")"; then
    echo "Expected $name to stop before downstream work." >&2
    exit 1
  fi
  if [ -s "$PAID_LOG" ] || grep -Eq '"continue"[[:space:]]*:[[:space:]]*true' <<< "$output"; then
    echo "Unsafe continuation in $name." >&2
    exit 1
  fi
  if grep -Ev '^(issue view|pr list|pr view|api repos/owner/repo/issues/36)( |$)' "$GH_LOG"; then
    echo "Unexpected GitHub call in $name." >&2
    exit 1
  fi
}

assert_passes bash "$issue_gate" owner/repo 36
assert_passes bash "$review_gate" owner/repo 37
assert_passes bash "$followup_gate" owner/repo 37 review dev "$review_body"

for payload in '{}' '{"labels":null}' '{"labels":{}}' '{"labels":[null]}' '{"labels":[{"name":null}]}' '{'; do
  MOCK_ISSUE_JSON="$payload" assert_stops "Issue metadata: $payload" bash "$issue_gate" owner/repo 36
  MOCK_API_JSON="$payload" assert_stops "Claude closing Issue: $payload" bash "$review_gate" owner/repo 37
  MOCK_API_JSON="$payload" assert_stops "follow-up closing Issue: $payload" bash "$followup_gate" owner/repo 37 review dev "$review_body"
done
for payload in '{}' 'null' '[{"labels":[]}]' '[{"number":37,"labels":null}]' '[{"number":37,"labels":{}}]' '[{"number":37,"labels":[{"name":3}]}]' '['; do
  MOCK_PR_LIST_JSON="$payload" assert_stops "related PR list: $payload" bash "$issue_gate" owner/repo 36
done
for payload in \
  '{"state":"OPEN","author":{"login":"dev[bot]"},"reviews":[],"labels":{},"closingIssuesReferences":[]}' \
  '{"state":"OPEN","author":{"login":"dev[bot]"},"reviews":[],"labels":null,"closingIssuesReferences":[]}' \
  '{"state":"OPEN","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[{"number":36,"url":null}]}' \
  '{"state":"OPEN","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":null}' \
  '{"state":"OPEN","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[{"number":"36","url":"https://github.com/owner/repo/issues/36"}]}' \
  '{'; do
  MOCK_PR_JSON="$payload" assert_stops "Claude PR metadata: $payload" bash "$review_gate" owner/repo 37
  MOCK_PR_JSON="$payload" assert_stops "follow-up PR metadata: $payload" bash "$followup_gate" owner/repo 37 review dev "$review_body"
done
for failure in issue list; do
  MOCK_FAIL="$failure" assert_stops "Issue entry API: $failure" bash "$issue_gate" owner/repo 36
done
for gate in review followup; do
  if [ "$gate" = review ]; then
    args=(bash "$review_gate" owner/repo 37)
  else
    args=(bash "$followup_gate" owner/repo 37 review dev "$review_body")
  fi
  MOCK_FAIL=pr assert_stops "$gate PR API" "${args[@]}"
  MOCK_FAIL=api assert_stops "$gate closing Issue API" "${args[@]}"
  MOCK_JQ_EXTRACT_FAIL=true assert_stops "$gate relation extraction" "${args[@]}"
done

MOCK_PR_JSON='{"state":"OPEN","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[]}'
export MOCK_PR_JSON
assert_passes bash "$review_gate" owner/repo 37
assert_passes bash "$followup_gate" owner/repo 37 review dev "$review_body"

MOCK_ISSUE_JSON='{"labels":[{"name":"human-review-required"}]}'
export MOCK_ISSUE_JSON
jq -e '.continue == false' <<< "$(bash "$issue_gate" owner/repo 36)" > /dev/null

echo 'AI entry gate metadata tests passed.'
