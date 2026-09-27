#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export GH_LOG="$test_dir/gh.log" PAID_LOG="$test_dir/paid.log"

reviewed_head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
valid_pr='{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}'
valid_issue='{"number":36,"state":"open","labels":[]}'
valid_pr_list='[]'
export MOCK_PR_JSON="$valid_pr" MOCK_PR_LIST_JSON="$valid_pr_list" MOCK_API_JSON="$valid_issue"

gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$1 $2" in
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
  if grep -Ev '^(pr list|pr view|api repos/owner/repo/issues/36)( |$)' "$GH_LOG"; then
    echo "Unexpected GitHub call in $name." >&2
    exit 1
  fi
}

assert_followup_skips() {
  local name="$1" output
  shift
  : > "$GH_LOG"
  output="$("$@")"
  if ! jq -e '.continue == false and .escalate == false and .notify == false' <<< "$output" >/dev/null; then
    echo "Expected $name to skip without escalation." >&2
    exit 1
  fi
}

assert_passes bash "$issue_gate" owner/repo 36
assert_passes bash "$review_gate" owner/repo 37 "$reviewed_head"
assert_passes bash "$followup_gate" owner/repo 37 review dev "$review_body"

for payload in '{}' '{"number":37,"state":"open","labels":[]}' \
  '{"number":36,"state":"OPEN","labels":[]}' \
  '{"number":36,"state":"open","pull_request":{},"labels":[]}' \
  '{"number":36,"state":"open","labels":null}' \
  '{"number":36,"state":"open","labels":{}}' \
  '{"number":36,"state":"open","labels":[null]}' \
  '{"number":36,"state":"open","labels":[{"name":null}]}' '{'; do
  MOCK_API_JSON="$payload" assert_stops "Issue metadata: $payload" bash "$issue_gate" owner/repo 36
done
for payload in '{}' '{"labels":null}' '{"labels":{}}' '{"labels":[null]}' '{"labels":[{"name":null}]}' '{'; do
  MOCK_API_JSON="$payload" assert_stops "Claude closing Issue: $payload" bash "$review_gate" owner/repo 37 "$reviewed_head"
  MOCK_API_JSON="$payload" assert_followup_skips "follow-up closing Issue: $payload" bash "$followup_gate" owner/repo 37 review dev "$review_body"
done
for payload in '{}' 'null' '[{"labels":[]}]' '[{"number":37,"labels":null}]' '[{"number":37,"labels":{}}]' '[{"number":37,"labels":[{"name":3}]}]' '['; do
  MOCK_PR_LIST_JSON="$payload" assert_stops "related PR list: $payload" bash "$issue_gate" owner/repo 36
done
for payload in \
  '{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":{},"closingIssuesReferences":[]}' \
  '{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":null,"closingIssuesReferences":[]}' \
  '{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[{"number":36,"url":null}]}' \
  '{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":null}' \
  '{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[{"number":"36","url":"https://github.com/owner/repo/issues/36"}]}' \
  '{'; do
  MOCK_PR_JSON="$payload" assert_stops "Claude PR metadata: $payload" bash "$review_gate" owner/repo 37 "$reviewed_head"
  MOCK_PR_JSON="$payload" assert_followup_skips "follow-up PR metadata: $payload" bash "$followup_gate" owner/repo 37 review dev "$review_body"
done
for payload in \
  '{"number":38,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[]}' \
  '{"number":37,"state":"OPEN","isDraft":null,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[]}' \
  '{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"invalid","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[]}'; do
  MOCK_PR_JSON="$payload" assert_stops "Claude PR metadata: $payload" bash "$review_gate" owner/repo 37 "$reviewed_head"
done
for failure in api list; do
  MOCK_FAIL="$failure" assert_stops "Issue entry API: $failure" bash "$issue_gate" owner/repo 36
done
args=(bash "$review_gate" owner/repo 37 "$reviewed_head")
MOCK_FAIL=pr assert_stops 'review PR API' "${args[@]}"
MOCK_FAIL=api assert_stops 'review closing Issue API' "${args[@]}"
MOCK_JQ_EXTRACT_FAIL=true assert_stops 'review relation extraction' "${args[@]}"
args=(bash "$followup_gate" owner/repo 37 review dev "$review_body")
MOCK_FAIL=pr assert_followup_skips 'follow-up PR API' "${args[@]}"
MOCK_FAIL=api assert_followup_skips 'follow-up closing Issue API' "${args[@]}"
MOCK_JQ_EXTRACT_FAIL=true assert_followup_skips 'follow-up relation extraction' "${args[@]}"

MOCK_PR_JSON='{"number":37,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","author":{"login":"dev[bot]"},"reviews":[],"labels":[],"closingIssuesReferences":[]}'
export MOCK_PR_JSON
assert_passes bash "$review_gate" owner/repo 37 "$reviewed_head"
assert_passes bash "$followup_gate" owner/repo 37 review dev "$review_body"

MOCK_API_JSON='{"number":36,"state":"closed","labels":[]}'
export MOCK_API_JSON
jq -e '.continue == false and (.reason | contains("closed"))' \
  <<< "$(bash "$issue_gate" owner/repo 36)" > /dev/null
: > "$GH_LOG"
: > "$PAID_LOG"
if bash -c 'set -e; result="$(bash "$1" owner/repo 36)"; jq -e ".continue == true" <<< "$result" >/dev/null; printf "paid\n" >> "$PAID_LOG"' -- "$issue_gate"; then
  echo 'Event-time open Issue must stop when current Issue is closed.' >&2
  exit 1
fi
[ ! -s "$PAID_LOG" ]
if grep -Fq 'pr list' "$GH_LOG"; then
  echo 'Closed Issue must stop before related PR lookup.' >&2
  exit 1
fi

MOCK_API_JSON='{"number":36,"state":"open","labels":[{"name":"human-review-required"}]}'
export MOCK_API_JSON
jq -e '.continue == false' <<< "$(bash "$issue_gate" owner/repo 36)" > /dev/null

echo 'AI entry gate metadata tests passed.'
