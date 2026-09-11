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

printf '%s\n' 'AI Developer workflow fixture tests passed'
