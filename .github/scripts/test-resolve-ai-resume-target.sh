#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/resolve-ai-resume-target.sh"
command='{"result":"accepted","actor":"suzukure","action":"develop"}'

gh() {
  case "$1 $2" in
    'pr view')
      local head_ref='ai/issue-36' links
      links='[{"number":40,"url":"https://github.com/owner/repo/issues/40"},{"number":36,"url":"https://github.com/owner/repo/issues/36"}]'
      case "${MOCK_CASE:-pr}" in
        non-ai-branch) head_ref='feature/current' ;;
        no-branch-link) links='[{"number":40,"url":"https://github.com/owner/repo/issues/40"}]' ;;
        cross-repo-only) links='[{"number":36,"url":"https://github.com/other/repo/issues/36"}]' ;;
        inspect-failure) return 1 ;;
      esac
      jq -cn --arg head_ref "$head_ref" --argjson links "$links" \
        '{number:37,state:"OPEN",baseRefName:"main",headRefName:$head_ref,
          headRefOid:"0123456789abcdef0123456789abcdef01234567",
          closingIssuesReferences:$links}'
      ;;
    'api repos/owner/repo/issues/36')
      case "${MOCK_CASE:-pr}" in
        issue-closed|closed-branch-issue) printf '%s\n' '{"number":36,"state":"closed"}' ;;
        issue-is-pr|branch-issue-is-pr) printf '%s\n' '{"number":36,"state":"open","pull_request":{}}' ;;
        wrong-branch-issue) printf '%s\n' '{"number":40,"state":"open"}' ;;
        malformed-branch-issue) printf '%s\n' '{"number":"36","state":"open"}' ;;
        api-failure) return 1 ;;
        *) printf '%s\n' '{"number":36,"state":"open"}' ;;
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
    || { echo "Expected $name to produce the expected relation." >&2; exit 1; }
}

assert_rejected() {
  local name="$1" target_kind="$2" number="$3"
  if printf '%s' "$command" | bash "$helper" owner/repo "$target_kind" "$number" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

MOCK_CASE=issue
export MOCK_CASE
assert_result issue issue 36 \
  '{"command":{"result":"accepted","actor":"suzukure","action":"develop"},"target":"issue:36","closing_issue":{"number":36,"state":"open"},"pull_request":null}'

MOCK_CASE='pr'
assert_result multiple-closing-issues pr 37 \
  '{"command":{"result":"accepted","actor":"suzukure","action":"develop"},"target":"pr:37","closing_issue":{"number":36,"state":"open"},"pull_request":{"number":37,"state":"open","base_ref":"main","head_ref":"ai/issue-36","head_sha":"0123456789abcdef0123456789abcdef01234567"}}'

command='{"result":"accepted","actor":"suzukure","action":"follow-up","follow_up_issue":123}'
assert_result follow-up pr 37 \
  '{"command":{"result":"accepted","actor":"suzukure","action":"follow-up","follow_up_issue":123},"target":"pr:37","closing_issue":{"number":36,"state":"open"},"pull_request":{"number":37,"state":"open","base_ref":"main","head_ref":"ai/issue-36","head_sha":"0123456789abcdef0123456789abcdef01234567"}}'
command='{"result":"accepted","actor":"suzukure","action":"develop"}'

for case_name in non-ai-branch no-branch-link cross-repo-only closed-branch-issue \
  branch-issue-is-pr wrong-branch-issue malformed-branch-issue api-failure inspect-failure; do
  MOCK_CASE="$case_name"
  assert_rejected "$case_name" pr 37
done

MOCK_CASE=issue
for case_name in issue-closed issue-is-pr api-failure; do
  MOCK_CASE="$case_name"
  assert_rejected "$case_name" issue 36
done
MOCK_CASE=issue
assert_rejected invalid-target issue 036
assert_rejected invalid-kind pull 36
command='{"result":"ignore"}'
assert_rejected invalid-command issue 36

echo 'resolve-ai-resume-target tests passed.'
