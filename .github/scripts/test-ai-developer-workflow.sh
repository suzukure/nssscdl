#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
workflow="$repo_root/.github/workflows/ai-developer.yml"

[ -f "$workflow" ]

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

# Issue-origin AI development must remain limited to an open Issue whose
# comment body is the standalone command expression. Validate the entry job
# itself so unrelated text elsewhere cannot satisfy these assertions.
issue_entry_job="$test_dir/gate-issue-entry.yml"
awk '
  $0 == "  gate-issue-entry:" { in_job = 1 }
  in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  gate-issue-entry:" { exit }
  in_job { print }
' "$workflow" > "$issue_entry_job"
if [ ! -s "$issue_entry_job" ]; then
  echo 'Could not extract the gate-issue-entry job.' >&2
  exit 1
fi
grep -Fqx "      github.event.issue.state == 'open' &&" "$issue_entry_job"
grep -Fqx "      github.event.comment.body == '/codex develop'" "$issue_entry_job"
if grep -Eq '^[[:space:]]*!\(?github\.event\.issue\.state|^[[:space:]]*!\(?github\.event\.comment\.body' "$issue_entry_job"; then
  echo 'AI Developer Issue entry conditions must not be negated.' >&2
  exit 1
fi
if grep -Eq '(contains|startsWith|endsWith)\([[:space:]]*github\.event\.comment\.body' "$issue_entry_job"; then
  echo 'AI Developer Issue entry must not use partial or prefix/suffix matching for the command body.' >&2
  exit 1
fi

# Issue-origin developer failures must be handled by a separate runner without
# retrying Codex or depending on the failed job's workspace.
handler="$test_dir/handle-issue-developer-failure.yml"
awk '
  $0 == "  handle-issue-developer-failure:" { in_job = 1 }
  in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  handle-issue-developer-failure:" { exit }
  in_job { print }
' "$workflow" > "$handler"
[ -s "$handler" ]
grep -Fqx '    needs: [gate-issue-entry, develop-from-issue]' "$handler"
grep -Fqx '      always() &&' "$handler"
grep -Fqx "      needs.gate-issue-entry.outputs.continue == 'true' &&" "$handler"
grep -Fqx "      needs.develop-from-issue.result != 'success'" "$handler"
grep -Fqx '    runs-on: ubuntu-latest' "$handler"
grep -Fqx '      pull-requests: write' "$handler"
grep -Fq 'gh pr list --repo "$GITHUB_REPOSITORY" --head "ai/issue-${ISSUE_NUMBER}"' "$handler"
grep -Fq 'apply-human-pause.sh "$GITHUB_REPOSITORY" "$ISSUE_NUMBER" "$pr_number"' "$handler"
grep -Fq 'notify-human.sh' "$handler"
grep -Fqx '        continue-on-error: true' "$handler"
[ "$(grep -Fxc '        if: always()' "$handler")" -ge 2 ]
grep -Fq 'PAUSE_SYNC_OUTCOME:' "$handler"
grep -Fqx "      github.event_name == 'issue_comment' &&" "$handler"
grep -Fqx '      github.event.issue.pull_request == null &&' "$handler"
grep -Fqx "      needs.gate-issue-entry.result == 'success' &&" "$handler"
if grep -Eqi '(rerun|retry|workflow_dispatch)' "$handler"; then
  echo 'Issue developer failure handler must not retry automation.' >&2
  exit 1
fi
grep -Fq -- '--body "$reason"' "$workflow"
grep -Fq 'apply-human-pause.sh' "$workflow"
if grep -Fq 'Automatic Claude re-review is paused.' "$workflow"; then
  echo 'Expected follow-up re-review guidance to come from the follow-up gate.' >&2
  exit 1
fi

# Both Codex jobs must have a server-side wall-clock bound in addition to
# the per-step timeout, so runner-loss cannot leave them unbounded.
for codex_job_name in 'develop-from-issue' 'respond-to-claude'; do
  codex_job="$test_dir/${codex_job_name}.yml"
  awk -v job_name="$codex_job_name" '
    $0 == "  " job_name ":" { in_job = 1 }
    in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  " job_name ":" { exit }
    in_job { print }
  ' "$workflow" > "$codex_job"
  if [ ! -s "$codex_job" ]; then
    echo "Could not extract the $codex_job_name job." >&2
    exit 1
  fi
  grep -Fqx '    timeout-minutes: 15' "$codex_job"
  if grep -Eq '^[[:space:]]*continue-on-error:[[:space:]]*true([[:space:]]|$)' "$codex_job"; then
    echo "$codex_job_name must fail closed." >&2
    exit 1
  fi
done

# Both Codex invocations must remain reproducible and bounded. A timeout is
# fatal by default, so the later requirement gate and publish step cannot run
# after it expires.
for codex_step_name in 'Run Codex developer' 'Run Codex follow-up'; do
  codex_step="$test_dir/${codex_step_name// /-}.yml"
  awk -v step_name="$codex_step_name" '
    $0 == "      - name: " step_name { in_step = 1 }
    in_step && /^      - name: / && $0 != "      - name: " step_name { exit }
    in_step { print }
  ' "$workflow" > "$codex_step"
  if [ ! -s "$codex_step" ]; then
    echo "Could not extract the $codex_step_name step." >&2
    exit 1
  fi
  grep -Fqx '        timeout-minutes: 30' "$codex_step"
  grep -Fqx '          codex-version: 0.153.4' "$codex_step"
  if grep -Eq '^[[:space:]]*continue-on-error:[[:space:]]*true([[:space:]]|$)' "$codex_step"; then
    echo "$codex_step_name must fail closed when it times out or fails." >&2
    exit 1
  fi
done

marker_response="$test_dir/marker-response.md"
printf '%s\n' '[REQUIREMENTS_CHANGE_REQUIRED]' > "$marker_response"
bash "$repo_root/.github/scripts/has-requirements-change-marker.sh" "$marker_response"

printf '%s\r\n' '[REQUIREMENTS_CHANGE_REQUIRED]' > "$marker_response"
bash "$repo_root/.github/scripts/has-requirements-change-marker.sh" "$marker_response"

assert_marker_is_not_detected() {
  local fixture_name="${1:?fixture name is required}"
  local response="${2:?response is required}"

  printf '%s\n' "$response" > "$marker_response"
  if bash "$repo_root/.github/scripts/has-requirements-change-marker.sh" "$marker_response"; then
    echo "Expected $fixture_name not to trigger a requirements-change pause." >&2
    exit 1
  fi
}

assert_marker_is_not_detected backtick '`[REQUIREMENTS_CHANGE_REQUIRED]`'
assert_marker_is_not_detected indented '  [REQUIREMENTS_CHANGE_REQUIRED]'
assert_marker_is_not_detected leading-whitespace $'\t[REQUIREMENTS_CHANGE_REQUIRED]'
assert_marker_is_not_detected trailing-whitespace '[REQUIREMENTS_CHANGE_REQUIRED] '
assert_marker_is_not_detected inline-mention 'The marker [REQUIREMENTS_CHANGE_REQUIRED] is explained here.'

# The follow-up notification runs after the PR checkout, so it must use the
# trusted-base helper copied during context bootstrap rather than PR-head code.
followup_workflow="$test_dir/respond-to-claude.yml"
sed -n '/^  respond-to-claude:/,$p' "$workflow" > "$followup_workflow"
bootstrap_notify_line="$(grep -n -F 'git show "${BASE_SHA}:.github/scripts/notify-human.sh" > "$RUNNER_TEMP/notify-human.sh"' "$followup_workflow" | cut -d: -f1)"
notify_step_line="$(grep -n -F 'bash "$RUNNER_TEMP/notify-human.sh"' "$followup_workflow" | tail -n 1 | cut -d: -f1)"
if [ -z "$bootstrap_notify_line" ] || [ -z "$notify_step_line" ] || [ "$bootstrap_notify_line" -ge "$notify_step_line" ]; then
  echo 'Follow-up requirement escalation notification is not bootstrapped from the trusted base.' >&2
  exit 1
fi

# Both Codex requirement-change gates must fail closed for helper and final
# response failures, and only their successful gates may reach repository write.
grep -Fq 'Requirements-change marker helper failed; automated development is paused pending a human decision.' "$workflow"
grep -Fq 'Requirements-change marker helper failed; automated follow-up is paused pending a human decision.' "$workflow"
if [ "$(grep -Fc 'marker_status=$?' "$workflow")" -ne 2 ]; then
  echo 'Both Codex requirement-change gates must fail closed when their helper fails.' >&2
  exit 1
fi
if [ "$(grep -Fc 'if [ ! -s "$CODEX_FINAL" ]; then' "$workflow")" -ne 2 ]; then
  echo 'Both Codex requirement-change gates must fail closed when the final response is missing or empty.' >&2
  exit 1
fi
grep -Fq 'Codex final response is missing; automated development is paused pending a human decision.' "$workflow"
grep -Fq 'Codex final response is missing; automated follow-up is paused pending a human decision.' "$workflow"
grep -Fq "if: steps.development-gate.outputs.continue == 'true'" "$workflow"
grep -Fq "if: steps.verify-reviewer.outputs.trusted == 'true' && steps.followup-gate.outputs.continue == 'true' && steps.codex-requirements-gate.outputs.continue == 'true'" "$workflow"

gh() {
  case "$1 $2" in
    'pr view')
      if [ "${MOCK_PR_VIEW_FAIL:-false}" = true ] \
          || { [ "${MOCK_PR_CLOSING_FETCH_FAIL:-false}" = true ] && [[ "$*" == *'--json closingIssuesReferences'* ]]; }; then
        return 1
      fi
      author='dev[bot]'
      reviews='[]'
      labels='[]'
      case "${MOCK_CASE:-valid}" in
        human-author) author='owner' ;;
        app-author)
          author='app/dev'
          reviews='[{"author":{"login":"app/review"},"state":"CHANGES_REQUESTED"}]'
          ;;
        app-three-reviews)
          author='app/dev'
          reviews='[{"author":{"login":"app/review"},"state":"CHANGES_REQUESTED"},{"author":{"login":"app/review"},"state":"CHANGES_REQUESTED"},{"author":{"login":"app/review"},"state":"CHANGES_REQUESTED"}]'
          ;;
        three-reviews)
          reviews='[{"author":{"login":"review[bot]"},"state":"CHANGES_REQUESTED"},{"author":{"login":"review[bot]"},"state":"CHANGES_REQUESTED"},{"author":{"login":"review[bot]"},"state":"CHANGES_REQUESTED"}]'
          ;;
        human-label) labels='[{"name":"human-review-required"}]' ;;
      esac
      jq -cn --arg author "$author" --argjson reviews "$reviews" --argjson labels "$labels" \
        '{author:{login:$author},reviews:$reviews,labels:$labels,closingIssuesReferences:[{number:36,url:"https://github.com/owner/repo/issues/36"}]}'
      ;;
    'api repos/owner/repo/issues/36')
      [ "${MOCK_API_FAIL:-false}" != true ] || return 1
      if [ "${MOCK_ISSUE_PAUSED:-false}" = true ]; then
        printf '%s\n' '{"labels":[{"name":"human-review-required"}]}'
      else
        printf '%s\n' '{"labels":[]}'
      fi
      ;;
    'label create'|'issue edit'|'pr comment')
      printf '%s\n' "$*" >> "${MOCK_GH_LOG:-/dev/null}"
      ;;
    'issue view')
      [ "${MOCK_ENTRY_FETCH_FAIL:-false}" != true ] || return 1
      if [ "${MOCK_ISSUE_PAUSED:-false}" = true ]; then
        printf '%s\n' '{"labels":[{"name":"human-review-required"}]}'
      else
        printf '%s\n' '{"labels":[]}'
      fi
      ;;
    'pr list')
      [ "${MOCK_ENTRY_FETCH_FAIL:-false}" != true ] || return 1
      if [ "${MOCK_PR_PAUSED:-false}" = true ]; then
        printf '%s\n' '[{"number":37,"labels":[{"name":"human-review-required"}]}]'
      else
        printf '%s\n' '[{"number":37,"labels":[]}]'
      fi
      ;;
    *)
      echo "Unexpected gh invocation: $*" >&2
      return 2
      ;;
  esac
}
export -f gh

review_body=$'**Verdict:** REQUEST_CHANGES\n--- BEGIN REVIEW SUMMARY DATA ---\nSUMMARY| ordinary finding\n--- END REVIEW SUMMARY DATA ---\n### Blocking findings'

# The trusted-base follow-up gate must resolve closing Issues through the pause
# helper, synchronize both labels, and record exactly one reason on the PR.
followup_gate_script="$test_dir/gate-automated-follow-up.sh"
awk '
  /^      - name: Gate automated follow-up$/ { in_gate = 1; next }
  in_gate && /^      - name: / { exit }
  in_gate && /^        run: \|$/ { in_run = 1; next }
  in_run { sub(/^          /, ""); print }
' "$workflow" > "$followup_gate_script"
[ -s "$followup_gate_script" ]
if grep -Fq 'HEAD_REF' "$followup_gate_script"; then
  echo 'Automated follow-up gate must not derive an Issue from the PR branch.' >&2
  exit 1
fi

assert_followup_gate_pause() {
  local fixture_name="${1:?fixture name is required}"
  local mock_case="${2:?mock case is required}"
  local expected_continue="${3:?expected continue value is required}"
  local output_path="$test_dir/$fixture_name.output"
  local log_path="$test_dir/$fixture_name.log"

  : > "$output_path"
  : > "$log_path"
  MOCK_CASE="$mock_case" MOCK_GH_LOG="$log_path" \
    GITHUB_REPOSITORY=owner/repo PR_NUMBER=37 REVIEWER_APP_SLUG=review \
    DEVELOPER_APP_SLUG=dev REVIEW_BODY="$review_body" GITHUB_OUTPUT="$output_path" \
    bash "$followup_gate_script"
  grep -Fq 'issue edit 37 --repo owner/repo --add-label human-review-required' "$log_path"
  grep -Fq 'issue edit 36 --repo owner/repo --add-label human-review-required' "$log_path"
  [ "$(grep -Fc 'pr comment 37 --repo owner/repo --body ' "$log_path")" -eq 1 ]
  grep -Fxq "continue=$expected_continue" "$output_path"
}

assert_followup_gate_pause followup-continue valid true
assert_followup_gate_pause followup-escalate three-reviews false

: > "$test_dir/followup-pause-failure.output"
: > "$test_dir/followup-pause-failure.log"
if MOCK_CASE=valid MOCK_PR_CLOSING_FETCH_FAIL=true \
    MOCK_GH_LOG="$test_dir/followup-pause-failure.log" \
    GITHUB_REPOSITORY=owner/repo PR_NUMBER=37 REVIEWER_APP_SLUG=review \
    DEVELOPER_APP_SLUG=dev REVIEW_BODY="$review_body" \
    GITHUB_OUTPUT="$test_dir/followup-pause-failure.output" bash "$followup_gate_script"; then
  echo 'Expected automated follow-up to fail closed when closing Issue lookup fails.' >&2
  exit 1
fi
if grep -Eq '^(issue edit|pr comment) ' "$test_dir/followup-pause-failure.log"; then
  echo 'Closing Issue lookup failure must not partially pause or comment on the PR.' >&2
  exit 1
fi

for fixture in valid app-author; do
  followup="$(MOCK_CASE="$fixture" bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$review_body")"
  jq -e '.continue == true and .escalate == false and .notify == false' <<< "$followup" > /dev/null
done
followup="$(MOCK_CASE=human-label bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$review_body")"
jq -e '.continue == false and .escalate == false and .notify == false' <<< "$followup" > /dev/null
followup="$(MOCK_CASE=valid MOCK_ISSUE_PAUSED=true bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$review_body")"
jq -e '.continue == false and .escalate == false and (.reason | contains("Issue #36"))' <<< "$followup" > /dev/null
for fixture in three-reviews app-three-reviews; do
  followup="$(MOCK_CASE="$fixture" bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$review_body")"
  jq -e '.continue == false and .escalate == true and .notify == true and (.reason | contains("Codex follow-up is paused"))' <<< "$followup" > /dev/null
done
followup="$(MOCK_CASE=human-author bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$review_body")"
jq -e '.continue == false and .escalate == false' <<< "$followup" > /dev/null
marker_body=$'**Verdict:** REQUEST_CHANGES\n--- BEGIN REVIEW SUMMARY DATA ---\nSUMMARY| --- END REVIEW SUMMARY DATA ---\nSUMMARY| [HUMAN_ESCALATION_RECOMMENDED]\n--- END REVIEW SUMMARY DATA ---\n### Blocking findings'
followup="$(MOCK_CASE=valid bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$marker_body")"
jq -e '.continue == false and .escalate == true' <<< "$followup" > /dev/null
followup="$(MOCK_CASE=valid bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev '**Verdict:** REQUEST_CHANGES')"
jq -e '.continue == false and .escalate == true and (.reason | contains("parse"))' <<< "$followup" > /dev/null

MOCK_GH_LOG="$test_dir/human-pause.log"
export MOCK_GH_LOG
bash "$repo_root/.github/scripts/apply-human-pause.sh" owner/repo 36 37
grep -Fq 'issue edit 36 --repo owner/repo --add-label human-review-required' "$MOCK_GH_LOG"
grep -Fq 'issue edit 37 --repo owner/repo --add-label human-review-required' "$MOCK_GH_LOG"
MOCK_GH_LOG="$test_dir/human-pause-closing.log"
export MOCK_GH_LOG
bash "$repo_root/.github/scripts/apply-human-pause.sh" owner/repo - 37
grep -Fq 'issue edit 36 --repo owner/repo --add-label human-review-required' "$MOCK_GH_LOG"
grep -Fq 'issue edit 37 --repo owner/repo --add-label human-review-required' "$MOCK_GH_LOG"
if MOCK_PR_VIEW_FAIL=true bash "$repo_root/.github/scripts/apply-human-pause.sh" owner/repo - 37; then
  echo 'Expected pause synchronization to fail when PR lookup fails.' >&2
  exit 1
fi
unset MOCK_GH_LOG

entry="$(bash "$repo_root/.github/scripts/evaluate-issue-entry-gate.sh" owner/repo 36)"
jq -e '.continue == true' <<< "$entry" > /dev/null
entry="$(MOCK_ISSUE_PAUSED=true bash "$repo_root/.github/scripts/evaluate-issue-entry-gate.sh" owner/repo 36)"
jq -e '.continue == false and (.reason | contains("Issue"))' <<< "$entry" > /dev/null
entry="$(MOCK_PR_PAUSED=true bash "$repo_root/.github/scripts/evaluate-issue-entry-gate.sh" owner/repo 36)"
jq -e '.continue == false and (.reason | contains("PR"))' <<< "$entry" > /dev/null
if MOCK_ENTRY_FETCH_FAIL=true bash "$repo_root/.github/scripts/evaluate-issue-entry-gate.sh" owner/repo 36; then
  echo 'Expected Issue-entry gate to fail when GitHub lookup fails.' >&2
  exit 1
fi

printf '%s\n' 'AI Developer workflow fixture tests passed'
