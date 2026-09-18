#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

curl() {
  printf '%s\n' "$*" > "$MOCK_CURL_ARGS"
  cat > "$MOCK_CURL_BODY"
}
export -f curl

unset NOTIFICATION_WEBHOOK_URL
if ! bash "$repo_root/.github/scripts/notify-human.sh" 'test escalation' \
  > "$test_dir/notification-unset.out" 2> "$test_dir/notification-unset.err"; then
  echo 'Expected notification to be skipped when the webhook is not configured.' >&2
  exit 1
fi
grep -Fq 'GitHub escalation remains active' "$test_dir/notification-unset.err"

NOTIFICATION_WEBHOOK_URL='https://discord.invalid/api/webhooks/secret-value'
MOCK_CURL_ARGS="$test_dir/curl.args"
MOCK_CURL_BODY="$test_dir/curl.body"
export NOTIFICATION_WEBHOOK_URL MOCK_CURL_ARGS MOCK_CURL_BODY
bash "$repo_root/.github/scripts/notify-human.sh" 'test escalation' \
  > "$test_dir/notification.out" 2> "$test_dir/notification.err"
jq -e '. == {"content":"test escalation"}' "$MOCK_CURL_BODY" > /dev/null
grep -Fq -- '--header Content-Type: application/json' "$MOCK_CURL_ARGS"
grep -Fq -- '--data-binary @-' "$MOCK_CURL_ARGS"
if grep -Fq "$NOTIFICATION_WEBHOOK_URL" "$test_dir/notification.out" "$test_dir/notification.err"; then
  echo 'Webhook URL was written to notification output.' >&2
  exit 1
fi

gh() {
  if [ "$1 $2" = 'pr view' ]; then
    case "${MOCK_CASE:-valid}" in
      no-links)
        printf '%s\n' '{"number":37,"title":"Test","body":"No link","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[],"comments":[],"reviews":[],"labels":[]}'
        ;;
      invalid-branch)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"feature/untrusted","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      wrong-base)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"release","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      draft)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":true,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      human-author)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"owner"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      app-author)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"app/dev"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[{"author":{"login":"app/review"},"state":"CHANGES_REQUESTED"}],"labels":[]}'
        ;;
      human-label)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[{"name":"human-review-required"}]}'
        ;;
      *)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[{"path":"x","additions":1,"deletions":0}],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
    esac
  elif [ "$1" = 'api' ]; then
    if [ "${MOCK_API_FAIL:-false}" = 'true' ]; then
      return 1
    fi
    if [[ "$*" =~ /issues/([0-9]+) ]]; then
      issue_number="${BASH_REMATCH[1]}"
    else
      echo "Unexpected Issue API target: $*" >&2
      return 2
    fi
    issue_labels='[]'
    if [ "${MOCK_ISSUE_PAUSED:-false}" = 'true' ]; then
      issue_labels='[{"name":"human-review-required"}]'
    fi
    jq -cn \
      --argjson number "$issue_number" \
      --arg state "${MOCK_ISSUE_STATE:-open}" \
      --argjson labels "$issue_labels" \
      '{number: $number, title: "Closing Issue", state: $state, body: "requirements", labels: $labels}'
  elif [ "$1 $2" = 'pr diff' ]; then
    if [ "${MOCK_DIFF_FAIL:-false}" = 'true' ]; then
      return 1
    elif [[ "$*" == *'--name-only'* ]]; then
      printf '%s\n' "${MOCK_CHANGED_PATH:-x}"
    else
      echo "Unexpected PR diff invocation: $*" >&2
      return 2
    fi
  else
    echo "Unexpected gh invocation: $*" >&2
    return 2
  fi
}
export -f gh

grep -Fq 'followup_re_review_pause_reason' "$repo_root/.github/scripts/evaluate-followup-gate.sh"

regression_workflow="$repo_root/.github/workflows/ai-workflow-regression.yml"
test -f "$regression_workflow"
grep -Fxq 'name: AI Workflow Regression' "$regression_workflow"
grep -Fq 'types: [opened, synchronize, reopened]' "$regression_workflow"
grep -Fq -- "- '.github/actions/**'" "$regression_workflow"
grep -Fq -- "- '.github/scripts/**'" "$regression_workflow"
grep -Fq -- "- '.github/workflows/**'" "$regression_workflow"
grep -A1 '^permissions:$' "$regression_workflow" | grep -Fxq '  contents: read'
grep -Fq 'group: ai-workflow-regression-${{ github.event.pull_request.number }}' "$regression_workflow"
grep -Fq 'cancel-in-progress: true' "$regression_workflow"
grep -Fq 'name: Fixtures' "$regression_workflow"
grep -Fq 'runs-on: ubuntu-latest' "$regression_workflow"
grep -Fq 'timeout-minutes: 10' "$regression_workflow"
grep -Fq 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' "$regression_workflow"
grep -Fq 'ref: ${{ github.event.pull_request.head.sha }}' "$regression_workflow"
grep -Fq 'persist-credentials: false' "$regression_workflow"
grep -Fq 'export LC_ALL=C' "$regression_workflow"
grep -Fq 'fixtures=(.github/scripts/test-*.sh)' "$regression_workflow"
grep -Fq 'if [ "${#fixtures[@]}" -eq 0 ]; then' "$regression_workflow"
grep -Fq 'for fixture in "${fixtures[@]}"; do' "$regression_workflow"
grep -Fq 'if bash "$fixture"; then' "$regression_workflow"

probe_action="$repo_root/.github/actions/background-cancel-probe/action.yml"
test -f "$probe_action"
grep -Fq 'using: composite' "$probe_action"
grep -Fq ': "${PROBE_MARKER:?PROBE_MARKER is required}"' "$probe_action"
grep -Fq ': "${PROBE_PID:?PROBE_PID is required}"' "$probe_action"
grep -Fq ': "${PROBE_DONE:?PROBE_DONE is required}"' "$probe_action"
grep -Fq 'printf '"'"'%s\n'"'"' "$" > "$PROBE_PID"' "$probe_action"
grep -Fq 'sleep 300' "$probe_action"
grep -Fq 'printf '"'"'%s\n'"'"' done > "$PROBE_DONE"' "$probe_action"
if grep -Eq 'secrets\.|github\.token|GH_TOKEN' "$probe_action"; then
  echo 'Background cancel probe must not consume a repository credential.' >&2
  exit 1
fi

probe_job="$test_dir/background-cancel-probe.yml"
awk '
  /^  background-cancel-probe:$/ { in_job = 1 }
  in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  background-cancel-probe:" { exit }
  in_job { print }
' "$regression_workflow" > "$probe_job"
test -s "$probe_job"
grep -Fq '    name: Background Cancel Probe' "$probe_job"
grep -Fq '    runs-on: ubuntu-latest' "$probe_job"
grep -Fq '    timeout-minutes: 5' "$probe_job"
grep -Fq '      PROBE_MARKER: ${{ runner.temp }}/background-cancel-probe.marker' "$probe_job"
grep -Fq '      PROBE_PID: ${{ runner.temp }}/background-cancel-probe.pid' "$probe_job"
grep -Fq '      PROBE_DONE: ${{ runner.temp }}/background-cancel-probe.done' "$probe_job"
grep -Fq '          persist-credentials: false' "$probe_job"
grep -Fq '        id: probe' "$probe_job"
grep -Fq '        uses: ./.github/actions/background-cancel-probe' "$probe_job"
grep -Fq '        background: true' "$probe_job"
grep -Fq '        cancel: probe' "$probe_job"
grep -Fq '      - name: Verify termination and continuation after cancel' "$probe_job"
grep -Fq '          if ! kill -0 "$pid" 2>/dev/null; then' "$probe_job"
grep -Fq '              test ! -e "$PROBE_DONE"' "$probe_job"
cancel_line="$(grep -nF '        cancel: probe' "$probe_job" | cut -d: -f1)"
verify_line="$(grep -nF '      - name: Verify termination and continuation after cancel' "$probe_job" | cut -d: -f1)"
if [ -z "$cancel_line" ] || [ -z "$verify_line" ] || [ "$cancel_line" -ge "$verify_line" ]; then
  echo 'Background cancel probe must verify process termination after runner-native cancel.' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]+[A-Za-z-]+: write$' "$regression_workflow"; then
  echo 'AI Workflow Regression grants a write permission.' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*permissions:[[:space:]]*write-all([[:space:]]*(#.*)?)?$' "$regression_workflow"; then
  echo 'AI Workflow Regression grants write-all permission.' >&2
  exit 1
fi
if grep -Fq 'secrets.' "$regression_workflow"; then
  echo 'AI Workflow Regression passes a repository secret.' >&2
  exit 1
fi
if grep -Eq 'github\.token|^[[:space:]]+GH_TOKEN:' "$regression_workflow"; then
  echo 'AI Workflow Regression passes a repository credential.' >&2
  exit 1
fi

grep -Fq 'outputs.execution_file' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq 'BASE_REF: ${{ github.event.pull_request.base.ref }}' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq 'git/ref/heads/${BASE_REF}' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq '^[0-9a-f]{40}$' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq 'steps.build-review-context.outputs.base_sha' "$repo_root/.github/workflows/claude-review.yml"
if grep -Fq 'github.event.pull_request.base.sha' "$repo_root/.github/workflows/claude-review.yml"; then
  echo 'Workflow still uses the stale event base SHA.' >&2
  exit 1
fi
if grep -Eq 'attempt (2|3) of 3' "$repo_root/.github/workflows/claude-review.yml"; then
  echo 'Expected duplicate full-review retries to be removed.' >&2
  exit 1
fi

MOCK_CASE=valid
export MOCK_CASE
bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 traceability
bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev

MOCK_CASE=no-links
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 traceability; then
  echo 'Expected traceability failure without a closing Issue.' >&2
  exit 1
fi

MOCK_CASE=invalid-branch
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a non-AI branch.' >&2
  exit 1
fi

MOCK_CASE=human-author
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a human-authored AI-named branch.' >&2
  exit 1
fi

MOCK_CASE=app-author
export MOCK_CASE
bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev

MOCK_CASE=wrong-base
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a PR not targeting main.' >&2
  exit 1
fi

MOCK_CASE=draft
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a draft PR.' >&2
  exit 1
fi

MOCK_CASE=human-label
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure while human-review-required is present.' >&2
  exit 1
fi

MOCK_CASE=valid
MOCK_CHANGED_PATH=src/CLAUDE.md
export MOCK_CASE MOCK_CHANGED_PATH
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a nested AI instruction file.' >&2
  exit 1
fi
unset MOCK_CHANGED_PATH

MOCK_CASE=valid
MOCK_DIFF_FAIL=true
export MOCK_CASE MOCK_DIFF_FAIL
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure when protected-path lookup fails.' >&2
  exit 1
fi
unset MOCK_DIFF_FAIL

MOCK_CASE=valid
MOCK_ISSUE_PAUSED=true
export MOCK_CASE MOCK_ISSUE_PAUSED
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure while a closing Issue is paused.' >&2
  exit 1
fi
unset MOCK_ISSUE_PAUSED

MOCK_CASE=valid
MOCK_ISSUE_STATE=closed
export MOCK_CASE MOCK_ISSUE_STATE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 traceability; then
  echo 'Expected traceability failure for a closed Issue.' >&2
  exit 1
fi
unset MOCK_ISSUE_STATE

echo 'AI workflow fixture tests passed.'
