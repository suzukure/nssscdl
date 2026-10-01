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
  grep -F '有料のCodex実行前にフォローアップ対象が変わったため、処理をスキップします。' >/dev/null
grep -Fq 'steps.codex.outputs.continue == '\''true'\''' "$workflow"
grep -Fq 'steps.followup-checkout.outputs.continue == '\''true'\''' "$workflow"
grep -Fq 'checkoutしたHEADがレビュー対象のcommitと異なるため、フォローアップをスキップします。' "$workflow"
grep -Fq 'Draft対象が変わったため、処理をスキップします。' "$workflow"
grep -Fq 'diff guardのエスカレーション対象が変わったため、書き込みをスキップします。' "$workflow"
grep -Fq 'リポジトリへの書き込み前にフォローアップ対象が変わったため、処理をスキップします。' "$workflow"
grep -Fq 'steps.codex-requirements-gate.outputs.notify == '\''true'\''' "$workflow"
grep -Fq 'steps.followup-diff-guard.outputs.notify == '\''true'\''' "$workflow"

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
# The helper has one implementation. Both producers load the trusted base blob.
if grep -Eq 'FOLLOWUP_TARGET_(DRAFT|GATE)|Inline bootstrap for the helper' "$workflow"; then
  echo 'Obsolete follow-up target bootstrap remains in the workflow.' >&2
  exit 1
fi
[ "$(grep -Fc "git show 'HEAD:.github/scripts/check-claude-followup-target.sh' >" "$workflow")" -eq 2 ]
[ "$(grep -Fc "target_helper_blob=\"\$(git rev-parse 'HEAD:.github/scripts/check-claude-followup-target.sh')\"" "$workflow")" -eq 2 ]
draft_checkout="$(grep -nF '      - name: Check out trusted Draft gate' "$workflow" | cut -d: -f1)"
draft_producer="$(grep -nF '      - name: Convert pull request to Draft' "$workflow" | cut -d: -f1)"
gate_producer="$(grep -nF '      - name: Gate automated follow-up' "$workflow" | cut -d: -f1)"
gate_checkout="$(grep -nF '      - name: Check out trusted automation' "$workflow" | cut -d: -f1 | awk -v limit="$gate_producer" '$1 < limit { last = $1 } END { print last }')"
head_checkout="$(grep -nF '      - name: Check out PR branch' "$workflow" | cut -d: -f1)"
(( draft_checkout < draft_producer && gate_checkout < gate_producer && gate_producer < head_checkout ))
sed -n "${draft_checkout},${draft_producer}p" "$workflow" | grep -Fq 'ref: ${{ github.event.pull_request.base.sha }}'
sed -n "${gate_checkout},${gate_producer}p" "$workflow" | grep -Fq 'ref: ${{ github.event.pull_request.base.sha }}'

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
expected_blob="$(git rev-parse 'HEAD:.github/scripts/check-claude-followup-target.sh')"
[ "$(git hash-object --no-filters "$RUNNER_TEMP/check-claude-followup-target.sh")" = "$expected_blob" ]
# A missing trusted base helper cannot silently fall back to PR head code.
if bash -c 'git() { [ "$1" != show ] && command git "$@"; }; source "$1"' bash "$test_dir/draft-step.sh" 2>/dev/null; then
  echo 'Draft conversion accepted a missing trusted base helper.' >&2
  exit 1
fi

awk '
  /      - name: Gate automated follow-up/ { step = 1 }
  step && /        run: \|/ { run = 1; next }
  run && /      - name: / { exit }
  run { sub(/^          /, ""); print }
' "$workflow" > "$test_dir/gate-step.sh"
[ -s "$test_dir/gate-step.sh" ]
export GITHUB_OUTPUT="$test_dir/gate-output" DEVELOPER_APP_SLUG=developer REVIEW_BODY=valid
: > "$GITHUB_OUTPUT"
bash -c '
  bash() {
    if [ "$1" = .github/scripts/evaluate-followup-gate.sh ]; then
      printf "%s\n" '\''{"continue":true,"escalate":false,"notify":false,"reason":"current"}'\''
    else
      command bash "$@"
    fi
  }
  source "$1"
' bash "$test_dir/gate-step.sh"
grep -Fxq 'continue=true' "$GITHUB_OUTPUT"
grep -Fxq "target_helper_blob=$expected_blob" "$GITHUB_OUTPUT"
[ "$(git hash-object --no-filters "$RUNNER_TEMP/check-claude-followup-target.sh")" = "$expected_blob" ]
if bash -c 'git() { [ "$1" != show ] && command git "$@"; }; source "$1"' bash "$test_dir/gate-step.sh" 2>/dev/null; then
  echo 'Follow-up gate accepted a missing trusted base helper.' >&2
  exit 1
fi

# Checkout, paid-call, and write boundaries must keep using the materialized helper.
for step in 'Check follow-up checkout target' 'Run Codex follow-up' \
            'Gate Codex follow-up requirement changes' 'Evaluate trusted follow-up diff guard' \
            'Commit and answer review'; do
  awk -v name="$step" '
    $0 == "      - name: " name { found = 1; next }
    found && /^      - name: / { exit }
    found { print }
  ' "$workflow" > "$test_dir/boundary-step.yml"
  grep -Fq '"$RUNNER_TEMP/check-claude-followup-target.sh"' "$test_dir/boundary-step.yml"
done

awk '
  /      - name: Restore trusted post-Codex helpers/ { count++; if (count == 2) step = 1 }
  step && /        run: \|/ { run = 1; next }
  run && /      - name: / { exit }
  run { sub(/^          /, ""); print }
' "$workflow" > "$test_dir/restore-step.sh"
[ -s "$test_dir/restore-step.sh" ]
base_sha="$(git rev-parse HEAD)"
export BASE_SHA="$base_sha" TARGET_HELPER_BLOB="$expected_blob"
export NOTIFY_HUMAN_BLOB="$(git rev-parse 'HEAD:.github/scripts/notify-human.sh')"
export APPLY_HUMAN_PAUSE_BLOB="$(git rev-parse 'HEAD:.github/scripts/apply-human-pause.sh')"
export REQUIREMENTS_MARKER_BLOB="$(git rev-parse 'HEAD:.github/scripts/has-requirements-change-marker.sh')"
export DIFF_GUARD_BLOB="$(git rev-parse 'HEAD:.github/scripts/evaluate-codex-diff-gate.sh')"
printf 'tampered\n' > "$RUNNER_TEMP/check-claude-followup-target.sh"
bash "$test_dir/restore-step.sh"
cmp "$helper" "$RUNNER_TEMP/check-claude-followup-target.sh"
[ "$(git hash-object --no-filters "$RUNNER_TEMP/check-claude-followup-target.sh")" = "$expected_blob" ]
TARGET_HELPER_BLOB=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bash "$test_dir/restore-step.sh" >/dev/null 2>&1 && {
    echo 'Post-Codex restore accepted an incorrect target helper blob.' >&2
    exit 1
  }
if bash -c '
  git() {
    if [ "$1" = show ] && [ "$2" = "${BASE_SHA}:.github/scripts/check-claude-followup-target.sh" ]; then
      return 1
    fi
    command git "$@"
  }
  source "$1"
' bash "$test_dir/restore-step.sh" >/dev/null 2>&1; then
  echo 'Post-Codex restore accepted a missing trusted base helper.' >&2
  exit 1
fi
echo 'Claude follow-up target fixture tests passed.'
