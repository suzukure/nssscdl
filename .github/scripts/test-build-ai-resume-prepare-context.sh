#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/build-ai-resume-prepare-context.sh"
record_helper="$repo_root/.github/scripts/human-pause-record.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

gh() {
  if [ "$1 $2" = 'pr view' ]; then
    printf '%s\n' '{"number":37,"state":"OPEN","baseRefName":"main","headRefName":"ai/issue-36","headRefOid":"0123456789abcdef0123456789abcdef01234567","closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}'
  elif [ "$1" = api ]; then
    case "$*" in
      *'/issues/37/comments'*) printf '%s\n' "$MOCK_PR_COMMENTS" ;;
      *'/issues/36/comments'*) printf '%s\n' "$MOCK_ISSUE_COMMENTS" ;;
      *'/issues/36'*)
        if [ "${MOCK_CASE:-}" = closing_failure ]; then return 1; fi
        printf '%s\n' '{"number":36,"state":"open","body":"## Scope-out impact and follow-up\n- Follow-up Issue: #123\n"}'
        ;;
      *'/issues/123'*) printf '%s\n' '{"number":123,"state":"open"}' ;;
      *) echo "Unexpected gh invocation: $*" >&2; return 2 ;;
    esac
  else
    echo "Unexpected gh invocation: $*" >&2
    return 2
  fi
}
export -f gh

comment() {
  local id="$1" record="$2" body
  body="$(bash "$record_helper" create "$record")"
  jq -cn --argjson id "$id" --arg body "$body" \
    '{id:$id,body:$body,performed_via_github_app:{id:99}}'
}

root_record='{"version":1,"kind":"pause","reason":"non_blocking_decision","target":"pr:37","paused_head":"0123456789abcdef0123456789abcdef01234567","payload":{"detail":"source text"}}'
replacement_record='{"version":1,"kind":"pause","reason":"scope_decision","target":"pr:37","source_pause_id":"101","paused_head":"0123456789abcdef0123456789abcdef01234567","payload":{"issue_body_fingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}}'
accepted_record='{"version":1,"kind":"ai-resume-accepted","reason":"scope_decision","target":"pr:37","source_pause_id":"102"}'
issue_record='{"version":1,"kind":"pause","reason":"non_blocking_decision","target":"issue:36"}'
root_comment="$(comment 101 "$root_record")"
replacement_comment="$(comment 102 "$replacement_record")"
accepted_comment="$(comment 103 "$accepted_record")"
issue_comment="$(comment 201 "$issue_record")"
export MOCK_PR_COMMENTS MOCK_ISSUE_COMMENTS
MOCK_PR_COMMENTS="$(jq -cn --argjson root "$root_comment" --argjson replacement "$replacement_comment" '[[$replacement,$root]]')"
MOCK_ISSUE_COMMENTS='[[]]'

command='{"result":"accepted","actor":"suzukure","action":"fix"}'
run_context() {
  printf '%s\n' "$command" | bash "$helper" owner/repo "$1" "$2" 99
}
assert_rejected() {
  local name="$1" kind="$2" number="$3"
  if run_context "$kind" "$number" > "$test_dir/rejected.out" 2> "$test_dir/rejected.err"; then
    echo "Expected $name to fail closed." >&2
    exit 1
  fi
  test ! -s "$test_dir/rejected.out" || {
    echo "Expected no output for $name." >&2
    exit 1
  }
}

run_context pr 37 > "$test_dir/active.json"
jq -e --argjson record "$replacement_record" '
  (. | keys) == ["closing_issue","command","follow_up_issue","pause","pull_request","target"]
  and .target == "pr:37"
  and .closing_issue.number == 36
  and .pull_request.number == 37
  and .pause == {result:"active",pause_id:"102",reason:"scope_decision",record:$record}
  and .follow_up_issue == null
' "$test_dir/active.json" > /dev/null

MOCK_PR_COMMENTS="$(jq -cn --argjson root "$root_comment" --argjson replacement "$replacement_comment" --argjson accepted "$accepted_comment" '[[$root,$replacement,$accepted]]')"
run_context pr 37 > "$test_dir/consumed.json"
jq -e '.pause == {result:"no_active_pause"}' "$test_dir/consumed.json" > /dev/null

MOCK_PR_COMMENTS="$(jq -cn --argjson root "$root_comment" --argjson issue "$issue_comment" '[[$root,($issue | .body |= sub("issue:36"; "pr:37") | .id = 201)]]')"
run_context pr 37 > "$test_dir/inconsistent.json"
jq -e '.pause == {result:"state_inconsistent"}' "$test_dir/inconsistent.json" > /dev/null

MOCK_PR_COMMENTS='[[]]'
MOCK_ISSUE_COMMENTS="$(jq -cn --argjson issue "$issue_comment" '[[$issue]]')"
run_context issue 36 > "$test_dir/issue.json"
jq -e --argjson record "$issue_record" '
  .target == "issue:36" and .pull_request == null
  and .pause == {result:"active",pause_id:"201",reason:"non_blocking_decision",record:$record}
' "$test_dir/issue.json" > /dev/null

command='{"result":"accepted","actor":"suzukure","action":"follow-up","follow_up_issue":123}'
run_context issue 36 > "$test_dir/follow-up.json"
jq -e '.follow_up_issue == {number:123,kind:"issue",state:"open",explicitly_recorded:true}' "$test_dir/follow-up.json" > /dev/null

command='{"result":"accepted","actor":"suzukure","action":"fix"}'
MOCK_PR_COMMENTS="$(jq -cn --argjson root "$root_comment" '[[$root,$root]]')"
assert_rejected duplicate-record pr 37
bad_accepted='{"version":1,"kind":"ai-resume-accepted","reason":"non_blocking_decision","target":"pr:37","source_pause_id":"102"}'
bad_accepted_comment="$(comment 103 "$bad_accepted")"
MOCK_PR_COMMENTS="$(jq -cn --argjson root "$root_comment" --argjson replacement "$replacement_comment" --argjson accepted "$bad_accepted_comment" '[[$root,$replacement,$accepted]]')"
assert_rejected invalid-acceptance pr 37
MOCK_PR_COMMENTS='{"bad":"shape"}'
assert_rejected malformed-listing pr 37
MOCK_PR_COMMENTS='[[]]'
MOCK_CASE=closing_failure
export MOCK_CASE
assert_rejected github-failure pr 37
unset MOCK_CASE

command='{"result":"accepted","actor":"suzukure","action":"fix"}{"result":"accepted","actor":"suzukure","action":"fix"}'
assert_rejected multiple-commands issue 36
command='{"result":"accepted","action":"fix"}'
assert_rejected missing-command-field issue 36
command='{"result":"ignore"}'
assert_rejected rejected-command issue 36
command='{"result":"accepted","actor":"suzukure","action":"fix"}'
if printf '%s\n' "$command" | bash "$helper" owner/repo pr 37 099 > /dev/null 2>&1; then
  echo 'Expected invalid App ID to fail closed.' >&2
  exit 1
fi

echo 'build-ai-resume-prepare-context tests passed.'
