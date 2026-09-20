#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/inspect-ai-resume-target.sh"
command='{"result":"accepted","actor":"suzukure","action":"develop"}'

gh() {
  case "$*" in
    *'api repos/owner/repo/issues/36'*)
      case "${MOCK_CASE:-issue}" in
        issue-pr) printf '%s\n' '{"number":36,"state":"open","pull_request":{}}' ;;
        issue-closed) printf '%s\n' '{"number":36,"state":"closed"}' ;;
        issue-malformed) printf '%s\n' '{"number":"36","state":"open"}' ;;
        api-failure) return 1 ;;
        *) printf '%s\n' '{"number":36,"state":"open"}' ;;
      esac
      ;;
    *'pr view 37 --repo owner/repo'*)
      case "${MOCK_CASE:-pr}" in
        pr-closed) printf '%s\n' '{"number":37,"state":"CLOSED","baseRefName":"main","headRefName":"ai/issue-36","headRefOid":"0123456789abcdef0123456789abcdef01234567","closingIssuesReferences":[]}' ;;
        pr-non-ai-branch) printf '%s\n' '{"number":37,"state":"OPEN","baseRefName":"main","headRefName":"feature/current","headRefOid":"0123456789abcdef0123456789abcdef01234567","closingIssuesReferences":[]}' ;;
        pr-malformed) printf '%s\n' '{"number":37,"state":"OPEN","baseRefName":"main","headRefName":"ai/issue-36","headRefOid":"not-a-sha","closingIssuesReferences":[]}' ;;
        pr-bad-link) printf '%s\n' '{"number":37,"state":"OPEN","baseRefName":"main","headRefName":"ai/issue-36","headRefOid":"0123456789abcdef0123456789abcdef01234567","closingIssuesReferences":[{"number":36}]}' ;;
        api-failure) return 1 ;;
        *) printf '%s\n' '{"number":37,"state":"OPEN","baseRefName":"main","headRefName":"ai/issue-36","headRefOid":"0123456789abcdef0123456789abcdef01234567","closingIssuesReferences":[{"number":40,"url":"https://github.com/owner/repo/issues/40"},{"number":36,"url":"https://github.com/owner/repo/issues/36"},{"number":36,"url":"https://github.com/owner/repo/issues/36"},{"number":99,"url":"https://github.com/other/repo/issues/99"}]}' ;;
      esac
      ;;
    *) echo "Unexpected gh invocation: $*" >&2; return 2 ;;
  esac
}
export -f gh

assert_result() {
  local name="$1" target_kind="$2" number="$3" expected="$4" output
  output="$(printf '%s' "$command" | bash "$helper" owner/repo "$target_kind" "$number")"
  jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Expected $name to produce the expected result." >&2; exit 1; }
}

assert_rejected() {
  local name="$1" input="$2" target_kind="$3" number="$4"
  if printf '%s' "$input" | bash "$helper" owner/repo "$target_kind" "$number" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

MOCK_CASE=issue
export MOCK_CASE
assert_result issue issue 36 \
  '{"command":{"result":"accepted","actor":"suzukure","action":"develop"},"target":"issue:36","issue":{"number":36,"state":"open"},"pull_request":null}'

MOCK_CASE=pr
assert_result pr pr 37 \
  '{"command":{"result":"accepted","actor":"suzukure","action":"develop"},"target":"pr:37","issue":null,"pull_request":{"number":37,"state":"open","base_ref":"main","head_ref":"ai/issue-36","head_sha":"0123456789abcdef0123456789abcdef01234567","branch_issue_number":36,"closing_issue_numbers":[36,40]}}'

MOCK_CASE=pr-non-ai-branch
assert_result non-ai-branch pr 37 \
  '{"command":{"result":"accepted","actor":"suzukure","action":"develop"},"target":"pr:37","issue":null,"pull_request":{"number":37,"state":"open","base_ref":"main","head_ref":"feature/current","head_sha":"0123456789abcdef0123456789abcdef01234567","branch_issue_number":null,"closing_issue_numbers":[]}}'

for case_name in issue-pr issue-closed issue-malformed api-failure; do
  MOCK_CASE="$case_name"
  assert_rejected "Issue $case_name" "$command" issue 36
done
for case_name in pr-closed pr-malformed pr-bad-link api-failure; do
  MOCK_CASE="$case_name"
  assert_rejected "PR $case_name" "$command" pr 37
done

MOCK_CASE=issue
command='{"result":"accepted","actor":"suzukure","action":"follow-up","follow_up_issue":123}'
assert_result follow-up issue 36 \
  '{"command":{"result":"accepted","actor":"suzukure","action":"follow-up"},"target":"issue:36","issue":{"number":36,"state":"open"},"pull_request":null}'
command='{"result":"accepted","actor":"suzukure","action":"develop"}'
assert_rejected invalid-command '{"result":"ignore"}' issue 36
assert_rejected invalid-action '{"result":"accepted","actor":"suzukure","action":"deploy"}' issue 36
assert_rejected multiple-command-values $'{"result":"accepted","actor":"suzukure","action":"develop"}\n{}' issue 36
assert_rejected leading-zero-number "$command" issue 036
assert_rejected invalid-kind "$command" pull 36
if printf '%s' "$command" | bash "$helper" owner/repo issue 36 extra > /dev/null 2>&1; then
  echo 'Expected extra arguments to be rejected.' >&2
  exit 1
fi

echo 'inspect-ai-resume-target tests passed.'
