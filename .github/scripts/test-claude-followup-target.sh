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
      if [[ " $* " == *' --json isDraft '* ]]; then
        printf '%s\n' "${MOCK_DRAFT:-false}"
      else
        printf '%s\n' "$MOCK_PR"
      fi ;;
    'pr ready')
      printf 'ready\n' >> "$MOCK_WRITE_LOG" ;;
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
grep -Fq 'steps.codex-requirements-gate.outputs.notify == '\''true'\''' "$workflow"
grep -Fq 'steps.followup-diff-guard.outputs.notify == '\''true'\''' "$workflow"

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
for marker in FOLLOWUP_TARGET_DRAFT FOLLOWUP_TARGET_GATE; do
  awk -v marker="$marker" '
    $0 == "            cat > \"$RUNNER_TEMP/check-claude-followup-target.sh\" <<\047" marker "\047" { block = 1; next }
    block && $0 == "          " marker { exit }
    block { sub(/^          /, ""); print }
  ' "$workflow" > "$test_dir/$marker.sh"
  cmp "$helper" "$test_dir/$marker.sh"
done

awk '
  /      - name: Convert pull request to Draft/ { step = 1 }
  step && /        run: \|/ { run = 1; next }
  run && /      - name: / { exit }
  run && /^  [[:alnum:]_-]+:$/ { exit }
  run { sub(/^          /, ""); print }
' "$workflow" > "$test_dir/draft-step.sh"
[ -s "$test_dir/draft-step.sh" ]
export RUNNER_TEMP="$test_dir" MOCK_WRITE_LOG="$test_dir/writes"
export GITHUB_REPOSITORY=owner/repo PR_NUMBER=37 REVIEW_ID=123 REVIEW_COMMIT="$sha"
export REVIEWER_APP_SLUG=review HEAD_REF=ai/issue-36
cd "$repo_root"
bash "$test_dir/draft-step.sh"
[ "$(cat "$MOCK_WRITE_LOG")" = ready ]
rm "$MOCK_WRITE_LOG"
# Simulate the introducing PR's trusted base, which lacks the new helper.
bash -c 'git() { [ "$1" != cat-file ]; }; source "$1"' bash "$test_dir/draft-step.sh"
[ "$(cat "$MOCK_WRITE_LOG")" = ready ]
rm "$MOCK_WRITE_LOG"
MOCK_PR="$(jq -c '.headRefOid="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' <<< "$valid_pr")" \
  bash -c 'git() { [ "$1" != cat-file ]; }; source "$1"' bash "$test_dir/draft-step.sh"
[ ! -e "$MOCK_WRITE_LOG" ]

awk '
  /      - name: Gate automated follow-up/ { step = 1 }
  step && /        run: \|/ { run = 1; next }
  run && /      - name: / { exit }
  run { sub(/^          /, ""); print }
' "$workflow" > "$test_dir/gate-step.sh"
[ -s "$test_dir/gate-step.sh" ]
export GITHUB_OUTPUT="$test_dir/gate-output" DEVELOPER_APP_SLUG=developer REVIEW_BODY=valid
for mode in base bootstrap; do
  : > "$GITHUB_OUTPUT"
  MOCK_MODE="$mode" bash -c '
    git() {
      if [ "$MOCK_MODE" = bootstrap ] && [ "$1" = cat-file ]; then return 1; fi
      command git "$@"
    }
    bash() {
      if [ "$1" = .github/scripts/evaluate-followup-gate.sh ]; then
        printf "%s\n" '\''{"continue":true,"escalate":false,"notify":false,"reason":"current"}'\''
      else
        command bash "$@"
      fi
    }
    source "$1"
  ' bash "$test_dir/gate-step.sh"
  grep -Fqx 'continue=true' "$GITHUB_OUTPUT"
done

echo 'Claude follow-up target fixture tests passed.'
