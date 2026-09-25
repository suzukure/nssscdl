#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/build-ai-resume-github-context.sh"
command='{"result":"accepted","actor":"suzukure","action":"develop"}'
body=$'本文\n\n## Scope-out impact and follow-up\n- Follow-up Issue: #123\n\n## Next\n- Follow-up Issue: #999\n\n'
export body

gh() {
  case "$1 $2" in
    'pr view')
      if [ "${MOCK_CASE:-}" = 'bad-relation' ]; then return 1; fi
      printf '%s\n' '{"number":37,"state":"OPEN","baseRefName":"main","headRefName":"ai/issue-36","headRefOid":"0123456789abcdef0123456789abcdef01234567","closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}'
      ;;
    'api repos/owner/repo/issues/36')
      if [ "${MOCK_CASE:-}" = 'closing-api-failure' ]; then return 1; fi
      case "${MOCK_CASE:-}" in
        missing-body) printf '%s\n' '{"number":36,"state":"open"}' ;;
        null-body) printf '%s\n' '{"number":36,"state":"open","body":null}' ;;
        wrong-body-type) printf '%s\n' '{"number":36,"state":"open","body":42}' ;;
        empty-body) printf '%s\n' '{"number":36,"state":"open","body":""}' ;;
        malformed-body) printf '%s\n' '{"number":36,"state":"open","body":' ;;
        wrong-closing-number) printf '%s\n' '{"number":40,"state":"open","body":"text"}' ;;
        *) jq -cn --arg body "$body" '{number:36,state:"open",body:$body}' ;;
      esac
      ;;
    'api repos/owner/repo/issues/123')
      case "${MOCK_CASE:-}" in
        follow-up-api-failure) return 1 ;;
        follow-up-wrong-number) printf '%s\n' '{"number":124,"state":"open"}' ;;
        follow-up-bad-state) printf '%s\n' '{"number":123,"state":"unknown"}' ;;
        follow-up-bad-pr) printf '%s\n' '{"number":123,"state":"open","pull_request":null}' ;;
        follow-up-malformed) printf '%s\n' '{"number":123,' ;;
        follow-up-pr) printf '%s\n' '{"number":123,"state":"closed","pull_request":{}}' ;;
        *) printf '%s\n' '{"number":123,"state":"open"}' ;;
      esac
      ;;
    *) echo "Unexpected gh invocation: $*" >&2; return 2 ;;
  esac
}
export -f gh

assert_result() {
  local name="$1" target_kind="$2" expected="$3" output
  output="$(printf '%s' "$command" | bash "$helper" owner/repo "$target_kind" "${4:-36}")" \
    || { echo "Expected $name to succeed." >&2; exit 1; }
  jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Unexpected $name context." >&2; exit 1; }
}

assert_rejected() {
  local name="$1" target_kind="$2" number="${3:-36}"
  if printf '%s' "$command" | bash "$helper" owner/repo "$target_kind" "$number" > /dev/null 2>&1; then
    echo "Expected $name to fail closed." >&2
    exit 1
  fi
}

fingerprint="sha256:$(printf '%s' "$body" | sha256sum | cut -d ' ' -f 1)"
base="$(jq -cn --arg fingerprint "$fingerprint" '{command:{result:"accepted",actor:"suzukure",action:"develop"},target:"issue:36",closing_issue:{number:36,state:"open",body_fingerprint:$fingerprint},pull_request:null,follow_up_issue:null}')"
assert_result issue issue "$base"
MOCK_CASE=empty-body
export MOCK_CASE
assert_result empty-body issue "$(jq -c '.closing_issue.body_fingerprint = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"' <<< "$base")"
MOCK_CASE=''

command='{"result":"accepted","actor":"suzukure","action":"follow-up","follow_up_issue":123}'
pr_base="$(jq -cn --arg fingerprint "$fingerprint" '{command:{result:"accepted",actor:"suzukure",action:"follow-up",follow_up_issue:123},target:"pr:37",closing_issue:{number:36,state:"open",body_fingerprint:$fingerprint},pull_request:{number:37,state:"open",base_ref:"main",head_ref:"ai/issue-36",head_sha:"0123456789abcdef0123456789abcdef01234567"},follow_up_issue:{number:123,kind:"issue",state:"open",explicitly_recorded:true}}')"
assert_result follow-up pr "$pr_base" 37

MOCK_CASE=follow-up-pr
export MOCK_CASE
assert_result follow-up-pr pr "$(jq -c '.follow_up_issue |= (.kind = "pr" | .state = "closed")' <<< "$pr_base")" 37

MOCK_CASE=''
body=$'Prose mentions #123\n## Other\n- Follow-up Issue: #123\n## Scope-out impact and follow-up\n- Follow-up Issue: #124\n'
export body
fingerprint="sha256:$(printf '%s' "$body" | sha256sum | cut -d ' ' -f 1)"
assert_result outside-section issue "$(jq -cn --arg fingerprint "$fingerprint" '{command:{result:"accepted",actor:"suzukure",action:"follow-up",follow_up_issue:123},target:"issue:36",closing_issue:{number:36,state:"open",body_fingerprint:$fingerprint},pull_request:null,follow_up_issue:{number:123,kind:"issue",state:"open",explicitly_recorded:false}}')"

for case_name in closing-api-failure missing-body null-body wrong-body-type malformed-body wrong-closing-number follow-up-api-failure follow-up-wrong-number follow-up-bad-state follow-up-bad-pr follow-up-malformed; do
  MOCK_CASE="$case_name"
  assert_rejected "$case_name" issue
done
MOCK_CASE=bad-relation
assert_rejected bad-relation pr 37
MOCK_CASE=''
command='{"result":"ignore"}'
assert_rejected invalid-command issue

echo 'build-ai-resume-github-context tests passed.'
