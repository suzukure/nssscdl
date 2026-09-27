#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/check-claude-followup-target.sh"
workflow="$repo_root/.github/workflows/ai-developer.yml"
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
valid_review='{"id":123,"state":"CHANGES_REQUESTED","commit_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","user":{"login":"review[bot]"}}'
valid_pr='{"number":37,"state":"OPEN","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRefName":"ai/issue-36","labels":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}'
valid_issue='{"number":36,"state":"open","labels":[]}'
export MOCK_REVIEW="$valid_review" MOCK_PR="$valid_pr" MOCK_ISSUE="$valid_issue"

gh() {
  case "$1 $2" in
    'api repos/owner/repo/pulls/37/reviews/123')
      [ "${MOCK_FAIL:-}" != review ] || return 1
      printf '%s\n' "$MOCK_REVIEW" ;;
    'pr view')
      [ "${MOCK_FAIL:-}" != pr ] || return 1
      printf '%s\n' "$MOCK_PR" ;;
    'api repos/owner/repo/issues/36')
      [ "${MOCK_FAIL:-}" != issue ] || return 1
      printf '%s\n' "$MOCK_ISSUE" ;;
    *) return 2 ;;
  esac
}
export -f gh

check() { bash "$helper" owner/repo 37 123 "$sha" review ai/issue-36; }
assert_skip() {
  local result
  result="$(check)"
  [ "$result" = skip ] || { echo "Expected skip, got: $result" >&2; exit 1; }
}

[ "$(check)" = current ]
MOCK_REVIEW="$(jq -c '.id=124' <<< "$valid_review")" assert_skip
MOCK_REVIEW="$(jq -c '.commit_id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' <<< "$valid_review")" assert_skip
MOCK_REVIEW="$(jq -c '.state="APPROVED"' <<< "$valid_review")" assert_skip
MOCK_REVIEW="$(jq -c '.user.login="other"' <<< "$valid_review")" assert_skip
MOCK_PR="$(jq -c '.number=38' <<< "$valid_pr")" assert_skip
MOCK_PR="$(jq -c '.state="CLOSED"' <<< "$valid_pr")" assert_skip
MOCK_PR="$(jq -c '.headRefOid="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' <<< "$valid_pr")" assert_skip
MOCK_PR="$(jq -c '.headRefName="other"' <<< "$valid_pr")" assert_skip
MOCK_PR="$(jq -c '.labels=[{name:"human-review-required"}]' <<< "$valid_pr")" assert_skip
MOCK_PR="$(jq -c '.closingIssuesReferences=[]' <<< "$valid_pr")" assert_skip
MOCK_ISSUE="$(jq -c '.state="closed"' <<< "$valid_issue")" assert_skip
MOCK_ISSUE="$(jq -c '.labels=[{name:"human-review-required"}]' <<< "$valid_issue")" assert_skip
MOCK_ISSUE="$(jq -c '.pull_request={}' <<< "$valid_issue")" assert_skip
for failure in review pr issue; do MOCK_FAIL="$failure" assert_skip; done
MOCK_PR='{' assert_skip
MOCK_REVIEW='{}' assert_skip
MOCK_PR="$valid_pr"$'\n'"$valid_pr" assert_skip
MOCK_REVIEW="$valid_review"$'\n'"$valid_review" assert_skip
[ "$(bash "$helper" owner/repo 37 123 invalid review ai/issue-36)" = skip ]

# A late skip must not run the post-Codex gates or writes; the actual call
# performs its own target check after runtime preparation.
awk '/      - name: Run Codex follow-up/{on=1} on{print} on && /      - name: Verify Codex follow-up host integrity/{exit}' "$workflow" |
  grep -F 'Follow-up target changed before paid Codex invocation; skipping.' >/dev/null
grep -Fq 'steps.codex.outputs.continue == '\''true'\''' "$workflow"
grep -Fq 'steps.followup-checkout.outputs.continue == '\''true'\''' "$workflow"
grep -Fq 'Checked-out HEAD differs from the reviewed commit; skipping follow-up.' "$workflow"
grep -Fq 'Draft target changed; skipping.' "$workflow"
grep -Fq 'Diff guard escalation target changed; skipping target write.' "$workflow"
grep -Fq 'Follow-up target changed before repository write; skipping.' "$workflow"
grep -Fq 'Failure target is stale or unverifiable; skipping pause.' "$workflow"
grep -Fq 'steps.codex-requirements-gate.outputs.notify == '\''true'\''' "$workflow"
grep -Fq 'steps.followup-diff-guard.outputs.notify == '\''true'\''' "$workflow"

echo 'Claude follow-up target fixture tests passed.'
