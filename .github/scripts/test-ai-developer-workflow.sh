#!/usr/bin/env bash
set -euo pipefail
set -x

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
repo_root="$(cd "$repo_root" && pwd)"
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
assert_issue_entry_grouping() {
  local entry_job="${1:?entry job is required}"
  local open_line close_line normal_line extended_line
  local event_line pr_line state_line comment_trust_line issue_trust_line pause_line

  open_line="$(grep -nFx '      (' "$entry_job" | cut -d: -f1)"
  close_line="$(grep -nFx '      )' "$entry_job" | cut -d: -f1)"
  normal_line="$(grep -nFx "        github.event.comment.body == '/codex develop' ||" "$entry_job" | cut -d: -f1)"
  extended_line="$(grep -nFx "        github.event.comment.body == '/codex develop extended'" "$entry_job" | cut -d: -f1)"
  event_line="$(grep -nFx "      github.event_name == 'issue_comment' &&" "$entry_job" | cut -d: -f1)"
  pr_line="$(grep -nFx '      github.event.issue.pull_request == null &&' "$entry_job" | cut -d: -f1)"
  state_line="$(grep -nFx "      github.event.issue.state == 'open' &&" "$entry_job" | cut -d: -f1)"
  comment_trust_line="$(grep -nFx "      contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association) &&" "$entry_job" | cut -d: -f1)"
  issue_trust_line="$(grep -nFx "      contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.issue.author_association) &&" "$entry_job" | cut -d: -f1)"
  pause_line="$(grep -nFx "      !contains(github.event.issue.labels.*.name, 'human-review-required') &&" "$entry_job" | cut -d: -f1)"

  for line in "$open_line" "$close_line" "$normal_line" "$extended_line"     "$event_line" "$pr_line" "$state_line" "$comment_trust_line" "$issue_trust_line" "$pause_line"; do
    if [[ ! "$line" =~ ^[0-9]+$ ]]; then
      return 1
    fi
  done

  [ "$(grep -Fc '||' "$entry_job")" -eq 1 ] &&
    [ "$event_line" -lt "$open_line" ] &&
    [ "$pr_line" -lt "$open_line" ] &&
    [ "$state_line" -lt "$open_line" ] &&
    [ "$comment_trust_line" -lt "$open_line" ] &&
    [ "$issue_trust_line" -lt "$open_line" ] &&
    [ "$pause_line" -lt "$open_line" ] &&
    [ "$open_line" -lt "$normal_line" ] &&
    [ "$normal_line" -lt "$extended_line" ] &&
    [ "$extended_line" -lt "$close_line" ]
}

if ! assert_issue_entry_grouping "$issue_entry_job"; then
  echo 'AI Developer Issue entry must apply every trust and pause condition to both develop commands.' >&2
  exit 1
fi

ungrouped_issue_entry="$test_dir/gate-issue-entry-ungrouped.yml"
sed '/^      ($/d; /^      )$/d' "$issue_entry_job" > "$ungrouped_issue_entry"
if assert_issue_entry_grouping "$ungrouped_issue_entry"; then
  echo 'Issue entry grouping regression fixture unexpectedly passed without command parentheses.' >&2
  exit 1
fi

if grep -Eq '^[[:space:]]*!\(?github\.event\.issue\.state|^[[:space:]]*!\(?github\.event\.comment\.body' "$issue_entry_job"; then
  echo 'AI Developer Issue entry conditions must not be negated.' >&2
  exit 1
fi
if grep -Eq '(contains|startsWith|endsWith)\([[:space:]]*github\.event\.comment\.body' "$issue_entry_job"; then
  echo 'AI Developer Issue entry must not use partial or prefix/suffix matching for the command body.' >&2
  exit 1
fi

# Issue context is retrieved through the structured `comments` JSON field.
# GitHub CLI rejects combining that form with the legacy --comments flag.
issue_context_step="$test_dir/prepare-branch-and-issue-context.yml"
awk '
  $0 == "      - name: Prepare branch and Issue context" { in_step = 1 }
  in_step && /^      - name: / && $0 != "      - name: Prepare branch and Issue context" { exit }
  in_step { print }
' "$workflow" > "$issue_context_step"
if [ ! -s "$issue_context_step" ]; then
  echo 'Could not extract the Prepare branch and Issue context step.' >&2
  exit 1
fi
grep -Fqx "            gh issue view \"\$ISSUE_NUMBER\" --repo \"\$GITHUB_REPOSITORY\" \\" "$issue_context_step"
grep -Fqx "              --json number,title,body,url,labels,comments \\" "$issue_context_step"
if grep -Fq -- '--comments' "$issue_context_step"; then
  echo 'Issue context retrieval must not combine --comments with --json.' >&2
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
# the per-step timeout, so runner-loss cannot leave them unbounded. Issue-origin
# development uses a fixed 35-minute exception only for the explicit extended
# command; normal development and Claude follow-up remain at 15 minutes.
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
  if [ "$codex_job_name" = 'develop-from-issue' ]; then
    grep -Fqx "    timeout-minutes: \${{ github.event.comment.body == '/codex develop extended' && 35 || 15 }}" "$codex_job"
  else
    grep -Fqx '    timeout-minutes: 15' "$codex_job"
  fi
  if grep -Eq '^[[:space:]]*continue-on-error:[[:space:]]*true([[:space:]]|$)' "$codex_job"; then
    echo "$codex_job_name must fail closed." >&2
    exit 1
  fi
done

# Issue-origin development uses the pinned OpenAI action for setup-only
# runtime preparation, resolves trusted native/action-helper paths, then runs
# the hardened native Codex process tree inside a bounded systemd service
# cgroup. Claude follow-up remains on the pinned action.
prepare_step="$test_dir/Prepare-Codex-developer-runtime.yml"
setup_step="$test_dir/Setup-Codex-developer-runtime.yml"
resolver_step="$test_dir/Resolve-trusted-Codex-developer-runtime.yml"
prompt_step="$test_dir/Prepare-fixed-Codex-developer-prompt.yml"
developer_step="$test_dir/Run-Codex-developer.yml"
followup_step="$test_dir/Run-Codex-follow-up.yml"

for pair in \
  "Prepare Codex developer runtime|$prepare_step" \
  "Setup Codex developer runtime|$setup_step" \
  "Resolve trusted Codex developer runtime|$resolver_step" \
  "Prepare fixed Codex developer prompt|$prompt_step" \
  "Run Codex developer|$developer_step" \
  "Run Codex follow-up|$followup_step"; do
  step_name="${pair%%|*}"
  step_path="${pair#*|}"
  awk -v step_name="$step_name" '
    $0 == "      - name: " step_name { in_step = 1 }
    in_step && /^      - name: / && $0 != "      - name: " step_name { exit }
    in_step { print }
  ' "$workflow" > "$step_path"
  if [ ! -s "$step_path" ]; then
    echo "Could not extract the $step_name step." >&2
    exit 1
  fi
done

grep -Fqx '          CODEX_HOME: ${{ runner.temp }}/codex-home' "$prepare_step"
grep -Fqx '          CODEX_FINAL: ${{ runner.temp }}/codex-final.md' "$prepare_step"
grep -Fq 'mkdir -p "$CODEX_HOME"' "$prepare_step"
grep -Fq 'rm -f "$CODEX_FINAL"' "$prepare_step"

grep -Fqx '        uses: openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e # v1.12' "$setup_step"
grep -Fqx '          openai-api-key: ${{ secrets.OPENAI_API_KEY }}' "$setup_step"
grep -Fqx '          codex-version: 0.153.4' "$setup_step"
grep -Fqx '          codex-home: ${{ runner.temp }}/codex-home' "$setup_step"
grep -Fqx '          safety-strategy: unsafe' "$setup_step"
if grep -Eq '^[[:space:]]+(prompt|prompt-file|output-file):' "$setup_step"; then
  echo 'Secure Codex setup must not enter the action wrapper execution path.' >&2
  exit 1
fi

grep -Fqx '        id: codex_runtime' "$resolver_step"
grep -Fqx '          CODEX_HOME: ${{ runner.temp }}/codex-home' "$resolver_step"
grep -Fq 'launcher="$(command -v codex)"' "$resolver_step"
grep -Fq 'test "$(basename "$entry")" = codex.js' "$resolver_step"
grep -Fq 'test "$(realpath "$package_root/bin/codex.js")" = "$entry"' "$resolver_step"
grep -Fq 'mainPackage.name !== "@openai/codex"' "$resolver_step"
grep -Fq 'mainPackage.version !== "0.153.4"' "$resolver_step"
grep -Fq 'platformPackage = "@openai/codex-linux-x64"' "$resolver_step"
grep -Fq 'targetTriple = "x86_64-unknown-linux-musl"' "$resolver_step"
grep -Fq 'platformPackage = "@openai/codex-linux-arm64"' "$resolver_step"
grep -Fq 'targetTriple = "aarch64-unknown-linux-musl"' "$resolver_step"
grep -Fq 'const require = createRequire(entry);' "$resolver_step"
grep -Fq '"vendor",' "$resolver_step"
grep -Fq '"bin",' "$resolver_step"
grep -Fq '"codex",' "$resolver_step"
grep -Fq 'fs.accessSync(nativePath, fs.constants.X_OK);' "$resolver_step"
grep -Fq "test \"\$native_version\" = 'codex-cli 0.153.4'" "$resolver_step"
grep -Fq '_actions/openai/codex-action/86365089eb2b84e0a8fb0717b304f8bdcb13b20e' "$resolver_step"
grep -Fq 'actual_blob="$(git hash-object "$action_main")"' "$resolver_step"
grep -Fq 'test "$actual_blob" = ce4e94e119abb91b980d23bfb4210688241f3a0a' "$resolver_step"
grep -Fq 'supplementaryGroupIds:$groups' "$resolver_step"
grep -Fq "printf 'native_path=%s\\n' \"\$native_path\" >> \"\$GITHUB_OUTPUT\"" "$resolver_step"
grep -Fq "printf 'package_root=%s\\n' \"\$package_root\" >> \"\$GITHUB_OUTPUT\"" "$resolver_step"
grep -Fq "printf 'action_main=%s\\n' \"\$action_main\" >> \"\$GITHUB_OUTPUT\"" "$resolver_step"
grep -Fq "printf 'runner_credentials=%s\\n' \"\$credentials\" >> \"\$GITHUB_OUTPUT\"" "$resolver_step"
if grep -Eq 'OPENAI_API_KEY|secrets\.|openai-api-key' "$resolver_step"; then
  echo 'Trusted Codex resolver must not receive repository secrets.' >&2
  exit 1
fi

grep -Fqx '          CODEX_PROMPT_FILE: ${{ runner.temp }}/codex-developer-prompt.md' "$prompt_step"
grep -Fq "cat > \"\$CODEX_PROMPT_FILE\" <<'CODEX_PROMPT'" "$prompt_step"
grep -Fq 'Read .ai-context/AGENTS.base.md, .ai-context/request.md, and .ai-context/diff-guard-contract.json completely.' "$prompt_step"
grep -Fq 'Do not commit, push, open a pull request, merge, or contact external services;' "$prompt_step"
if grep -Eq 'OPENAI_API_KEY|secrets\.|openai-api-key' "$prompt_step"; then
  echo 'Fixed developer prompt preparation must not receive repository secrets.' >&2
  exit 1
fi

grep -Fqx '        id: codex' "$developer_step"
grep -Fqx "        timeout-minutes: \${{ github.event.comment.body == '/codex develop extended' && 30 || 12 }}" "$developer_step"
grep -Fqx '          CODEX_HOME: ${{ runner.temp }}/codex-home' "$developer_step"
grep -Fqx '          CODEX_FINAL: ${{ runner.temp }}/codex-final.md' "$developer_step"
grep -Fqx '          CODEX_PROMPT_FILE: ${{ runner.temp }}/codex-developer-prompt.md' "$developer_step"
grep -Fqx '          CODEX_MODEL: ${{ vars.CODEX_MODEL }}' "$developer_step"
grep -Fqx '          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: codex_github_action' "$developer_step"
grep -Fqx '          CODEX_NATIVE: ${{ steps.codex_runtime.outputs.native_path }}' "$developer_step"
grep -Fqx '          CODEX_PACKAGE_ROOT: ${{ steps.codex_runtime.outputs.package_root }}' "$developer_step"
grep -Fqx '          ACTION_MAIN: ${{ steps.codex_runtime.outputs.action_main }}' "$developer_step"
grep -Fqx '          RUNNER_CREDENTIALS: ${{ steps.codex_runtime.outputs.runner_credentials }}' "$developer_step"
grep -Fqx "          CODEX_RUNTIME_MAX_SEC: \${{ github.event.comment.body == '/codex develop extended' && 1780 || 700 }}" "$developer_step"
grep -Fq 'test "$(git hash-object "$ACTION_MAIN")" = ce4e94e119abb91b980d23bfb4210688241f3a0a' "$developer_step"
grep -Fq 'test "$current_credentials" = "$RUNNER_CREDENTIALS"' "$developer_step"
grep -Fq 'case "$CODEX_RUNTIME_MAX_SEC" in' "$developer_step"
grep -Fq '700|1780)' "$developer_step"
grep -Fq 'exec sudo -n -E -- ' "$developer_step"
grep -Fq 'drop-sudo ' "$developer_step"
grep -Fq -- '--root-phase ' "$developer_step"
grep -Fq '/usr/bin/systemd-run ' "$developer_step"
grep -Fq -- '--wait ' "$developer_step"
grep -Fq -- '--collect ' "$developer_step"
grep -Fq -- '--property=Type=exec ' "$developer_step"
grep -Fq -- '--property="RuntimeMaxSec=${runtime_max_sec}s" ' "$developer_step"
grep -Fq -- '--property=TimeoutStopSec=5s ' "$developer_step"
grep -Fq -- '--property=KillMode=control-group ' "$developer_step"
grep -Fq -- '--property=SendSIGKILL=yes ' "$developer_step"
grep -Fq '/usr/bin/setpriv ' "$developer_step"
grep -Fq -- '--reuid="$uid" ' "$developer_step"
grep -Fq -- '--regid="$nobody_gid" ' "$developer_step"
grep -Fq -- '--clear-groups ' "$developer_step"
grep -Fq -- '--no-new-privs ' "$developer_step"
grep -Fq -- '--bounding-set=-all ' "$developer_step"
grep -Fq -- '--inh-caps=-all ' "$developer_step"
grep -Fq -- '--ambient-caps=-all ' "$developer_step"
grep -Fq 'CODEX_MANAGED_PACKAGE_ROOT="$CODEX_PACKAGE_ROOT" ' "$developer_step"
grep -Fq 'CODEX_MANAGED_BY_NPM=1 ' "$developer_step"
grep -Fq '"$CODEX_NATIVE" exec ' "$developer_step"
grep -Fq -- '--skip-git-repo-check ' "$developer_step"
grep -Fq -- '--cd "$GITHUB_WORKSPACE" ' "$developer_step"
grep -Fq -- '--output-last-message "$CODEX_FINAL" ' "$developer_step"
grep -Fq -- '--model "$CODEX_MODEL" ' "$developer_step"
grep -Fq -- "--config 'model_reasoning_effort=\"medium\"' \\" "$developer_step"
grep -Fq -- "--config 'default_permissions=\":workspace\"' \\" "$developer_step"
grep -Fq '< "$CODEX_PROMPT_FILE"' "$developer_step"
if grep -Fq 'exec codex exec' "$developer_step"; then
  echo 'Hardened developer step must bypass the npm Node launcher.' >&2
  exit 1
fi
if grep -Eq 'OPENAI_API_KEY|secrets\.|openai-api-key|DEV_APP_PRIVATE_KEY|NOTIFICATION_WEBHOOK_URL' "$developer_step"; then
  echo 'Hardened Codex developer service must not receive repository secrets.' >&2
  exit 1
fi
developer_run="$test_dir/Run-Codex-developer-run.sh"
awk '
  found { print }
  $0 == "        run: |" { found = 1 }
' "$developer_step" > "$developer_run"
test -s "$developer_run"
if grep -Fq '${{' "$developer_run"; then
  echo 'Hardened Codex run body must not interpolate GitHub expressions.' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*continue-on-error:[[:space:]]*true([[:space:]]|$)' "$developer_step"; then
  echo 'Hardened Codex developer step must fail closed.' >&2
  exit 1
fi

grep -Fqx '        timeout-minutes: 30' "$followup_step"
grep -Fqx '        uses: openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e # v1.12' "$followup_step"
grep -Fqx '          codex-version: 0.153.4' "$followup_step"

prepare_line="$(grep -nF '      - name: Prepare Codex developer runtime' "$workflow" | cut -d: -f1)"
setup_line="$(grep -nF '      - name: Setup Codex developer runtime' "$workflow" | cut -d: -f1)"
resolver_line="$(grep -nF '      - name: Resolve trusted Codex developer runtime' "$workflow" | cut -d: -f1)"
prompt_line="$(grep -nF '      - name: Prepare fixed Codex developer prompt' "$workflow" | cut -d: -f1)"
developer_line="$(grep -nF '      - name: Run Codex developer' "$workflow" | cut -d: -f1)"
gate_line="$(grep -nF '      - name: Gate requirement changes' "$workflow" | cut -d: -f1)"
if [ -z "$prepare_line" ] || [ -z "$setup_line" ] || [ -z "$resolver_line" ] || [ -z "$prompt_line" ] ||
   [ -z "$developer_line" ] || [ -z "$gate_line" ] ||
   [ "$prepare_line" -ge "$setup_line" ] || [ "$setup_line" -ge "$resolver_line" ] ||
   [ "$resolver_line" -ge "$prompt_line" ] || [ "$prompt_line" -ge "$developer_line" ] ||
   [ "$developer_line" -ge "$gate_line" ]; then
  echo 'Codex setup, trusted resolution, fixed prompt, hardened execution, and requirement gate order is invalid.' >&2
  exit 1
fi

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

extract_workflow_step() {
  local step_name="${1:?step name is required}"
  local output_path="${2:?output path is required}"

  awk -v step_name="$step_name" '
    $0 == "      - name: " step_name { in_step = 1 }
    in_step && /^      - name: / && $0 != "      - name: " step_name { exit }
    in_step && /^  [[:alnum:]_-]+:$/ { exit }
    in_step { print }
  ' "$workflow" > "$output_path"
  if [ ! -s "$output_path" ]; then
    echo "Could not extract the $step_name step." >&2
    exit 1
  fi
}

extract_workflow_step_run() {
  local step_path="${1:?step path is required}"
  local output_path="${2:?output path is required}"

  awk '
    /^        run: \|$/ { in_run = 1; next }
    in_run { line = $0; sub(/^          /, "", line); print line }
  ' "$step_path" > "$output_path"
  if [ ! -s "$output_path" ]; then
    echo "Could not extract the run body from $step_path." >&2
    exit 1
  fi
}

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
followup_gate_step="$test_dir/gate-automated-follow-up.yml"
followup_gate_script="$test_dir/gate-automated-follow-up.sh"
extract_workflow_step 'Gate automated follow-up' "$followup_gate_step"
if grep -Eq 'HEAD_REF|head\.ref|ai/issue-' "$followup_gate_step"; then
  echo 'Automated follow-up gate must not derive a closing Issue from the PR branch.' >&2
  exit 1
fi
extract_workflow_step_run "$followup_gate_step" "$followup_gate_script"

# The fixture verifies that, even when its checkout root differs from this
# repository root, the gate resolves helpers only beneath that checkout's
# .github directory. Existing bootstrap assertions cover the base-derived
# trust boundary. Invoke the extracted script from outside that checkout root.
followup_gate_workdir="$test_dir/gate-automated-follow-up-workdir"
mkdir "$followup_gate_workdir"
ln -s "$repo_root/.github" "$followup_gate_workdir/.github"

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
    bash -c 'cd "$1" && bash "$2"' -- "$followup_gate_workdir" "$followup_gate_script"
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
    GITHUB_OUTPUT="$test_dir/followup-pause-failure.output" \
    bash -c 'cd "$1" && bash "$2"' -- "$followup_gate_workdir" "$followup_gate_script"; then
  echo 'Expected automated follow-up to fail closed when closing Issue lookup fails.' >&2
  exit 1
fi
if [ -s "$test_dir/followup-pause-failure.log" ]; then
  echo 'Closing Issue lookup failure must not perform any GitHub write.' >&2
  exit 1
fi

for fixture in valid app-author; do
  followup="$(MOCK_CASE="$fixture" bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$review_body")"
  jq -e '.continue == true and .escalate == false and .notify == false and (.reason | contains("Automatic Claude re-review is paused."))' <<< "$followup" > /dev/null
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
if MOCK_CASE=valid MOCK_API_FAIL=true bash "$repo_root/.github/scripts/evaluate-followup-gate.sh" owner/repo 37 review dev "$review_body"; then
  echo 'Expected follow-up gate to fail closed when closing Issue lookup fails.' >&2
  exit 1
fi

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
MOCK_GH_LOG="$test_dir/human-pause-failure.log"
: > "$MOCK_GH_LOG"
export MOCK_GH_LOG
if MOCK_PR_VIEW_FAIL=true bash "$repo_root/.github/scripts/apply-human-pause.sh" owner/repo - 37; then
  echo 'Expected pause synchronization to fail when PR lookup fails.' >&2
  exit 1
fi
if grep -Eq '^(label create|issue edit) ' "$MOCK_GH_LOG"; then
  echo 'PR lookup failure must not partially create or apply pause labels.' >&2
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

# Extract and exercise the actual Issue-entry publish step with all Git/GitHub
# writes mocked. Creating a PR must preserve Draft until a human requests
# review; updating an existing PR must not create another PR or change its
# stage.
publish_step="$test_dir/publish-issue-pr.sh"
publish_step_source="$test_dir/publish-issue-pr.yml"
extract_workflow_step 'Commit, push, and open or update PR' "$publish_step_source"
extract_workflow_step_run "$publish_step_source" "$publish_step"
for publish_case in new existing-draft existing-ready no-diff push-failure list-failure create-failure commit-a-regression commit-am-regression; do
  (
    case_dir="$test_dir/publish-$publish_case"
    mkdir "$case_dir"
    cd "$case_dir"
    printf '%s\n' 'Related references and validation checked.' > final.md
    export PUBLISH_CASE="$publish_case" PUBLISH_LOG="$case_dir/calls.log"
    export PUBLISH_BODY="$case_dir/body.md"
    export GITHUB_REPOSITORY=owner/repo APP_SLUG=dev ISSUE_NUMBER=36
    export ISSUE_TITLE='Related correction' AI_BRANCH=ai/issue-36 CODEX_FINAL="$case_dir/final.md"
    publish_script="$publish_step"
    case "$PUBLISH_CASE" in
      commit-a-regression)
        publish_script="$case_dir/publish-with-commit-a.sh"
        sed 's/git commit -m "Implement #${ISSUE_NUMBER} with Codex"/git commit -a -m "Implement #${ISSUE_NUMBER} with Codex"/' \
          "$publish_step" > "$publish_script"
        ;;
      commit-am-regression)
        publish_script="$case_dir/publish-with-commit-am.sh"
        sed 's/git commit -m "Implement #${ISSUE_NUMBER} with Codex"/git commit -am "Implement #${ISSUE_NUMBER} with Codex"/' \
          "$publish_step" > "$publish_script"
        ;;
    esac
    git() {
      printf 'git %s\n' "$*" >> "$PUBLISH_LOG"
      case "$1" in
        config) return 0 ;;
        commit)
          if [ "$#" -ne 3 ] || [ "$2" != '-m' ] || [ "$3" != 'Implement #36 with Codex' ]; then
            echo 'Publish must not commit unguarded worktree changes.' >&2
            return 2
          fi
          return 0
          ;;
        add)
          echo 'Publish must not stage post-guard worktree changes.' >&2
          return 2
          ;;
        diff) [ "$PUBLISH_CASE" = no-diff ] ;;
        push) [ "$PUBLISH_CASE" != push-failure ] ;;
        *) echo "Unexpected git call: $*" >&2; return 2 ;;
      esac
    }
    gh() {
      printf 'gh %s\n' "$*" >> "$PUBLISH_LOG"
      case "$1 $2" in
        'api /users/dev[bot]') echo 123 ;;
        'pr list')
          [ "$PUBLISH_CASE" != list-failure ] || return 1
          case "$PUBLISH_CASE" in existing-*) echo 37 ;; esac
          ;;
        'pr create')
          local saw_draft=false
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --draft) saw_draft=true ;;
              --body-file) shift; cp "$1" "$PUBLISH_BODY" ;;
            esac
            shift
          done
          [ "$saw_draft" = true ] || return 2
          [ "$PUBLISH_CASE" != create-failure ] || return 1
          echo 'https://github.com/owner/repo/pull/37'
          ;;
        'pr comment'|'issue comment') return 0 ;;
        *) echo "Unexpected gh call (including automatic stage change): $*" >&2; return 2 ;;
      esac
    }
    export -f git gh
    outcome=success
    bash "$publish_script" > stdout 2> stderr || outcome=failure
    assert_no_publish_call() {
      if grep -Eq "$1" "$PUBLISH_LOG"; then
        echo "Unexpected publish side effect in $PUBLISH_CASE: $1" >&2
        exit 1
      fi
    }
    case "$PUBLISH_CASE" in
      *-failure|*-regression) [ "$outcome" = failure ] ;;
      *) [ "$outcome" = success ] ;;
    esac
    case "$PUBLISH_CASE" in
      new)
        grep -Fq 'gh pr create ' "$PUBLISH_LOG"
        grep -Fq -- '--draft' "$PUBLISH_LOG"
        grep -Fq 'Closes #36' "$PUBLISH_BODY"
        grep -Fq '## Review readiness' "$PUBLISH_BODY"
        grep -Fq 'Ready for review' "$PUBLISH_BODY"
        grep -Fq 'as Draft.' "$PUBLISH_LOG"
        ;;
      existing-*)
        grep -Fq 'git push ' "$PUBLISH_LOG"
        grep -Fq 'gh pr comment 37 ' "$PUBLISH_LOG"
        assert_no_publish_call 'gh pr create '
        ;;
      no-diff)
        grep -Fq 'produced no repository changes' "$PUBLISH_LOG"
        assert_no_publish_call 'git (commit|push)|gh pr create'
        ;;
      push-failure|list-failure)
        assert_no_publish_call 'gh pr create '
        ;;
      create-failure)
        assert_no_publish_call 'Codex opened'
        ;;
      *-regression)
        assert_no_publish_call 'git push|gh pr (create|comment)|gh issue comment'
        ;;
    esac
    assert_no_publish_call 'gh pr (ready|edit)'
  )
done

printf '%s\n' 'AI Developer workflow fixture tests passed'
