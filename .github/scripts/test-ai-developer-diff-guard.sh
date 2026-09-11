#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
workflow="$repo_root/.github/workflows/ai-developer.yml"

[ -f "$workflow" ]

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

developer_job="$test_dir/develop-from-issue.yml"
guard_script="$test_dir/diff-guard.sh"
followup_job="$test_dir/respond-to-claude.yml"
followup_guard_script="$test_dir/followup-diff-guard.sh"
followup_notify_script="$test_dir/followup-diff-guard-notify.sh"

awk '
  $0 == "  develop-from-issue:" { in_job = 1 }
  in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  develop-from-issue:" { exit }
  in_job { print }
' "$workflow" > "$developer_job"
[ -s "$developer_job" ]

extract_step_run() {
  local job="${1:?job path is required}"
  local step_name="${2:?step name is required}"
  local output="${3:?output path is required}"
  awk -v step_name="$step_name" '
    $0 == "      - name: " step_name { in_step = 1; next }
    in_step && /^      - name: / { exit }
    in_step && ($0 == "        run: |" || $0 == "        run: >-") { in_run = 1; next }
    in_run {
      if ($0 ~ /^          /) sub(/^          /, "")
      print
    }
  ' "$job" > "$output"
  [ -s "$output" ]
}

extract_step_run "$developer_job" 'Evaluate trusted diff guard' "$guard_script"

awk '
  $0 == "  respond-to-claude:" { in_job = 1 }
  in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  respond-to-claude:" { exit }
  in_job { print }
' "$workflow" > "$followup_job"
[ -s "$followup_job" ]
extract_step_run "$followup_job" 'Evaluate trusted follow-up diff guard' "$followup_guard_script"
extract_step_run "$followup_job" 'Notify human of follow-up diff guard stop' "$followup_notify_script"

# Structural boundaries that are not practical to exercise in the extracted run body.
grep -Fq 'git show "${base_sha}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$developer_job"
bootstrap_line="$(grep -n -F 'git show "${base_sha}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$developer_job" | cut -d: -f1)"
codex_line="$(grep -n -F '      - name: Run Codex developer' "$developer_job" | cut -d: -f1)"
[ "$bootstrap_line" -lt "$codex_line" ]
grep -Fq '25 changed files, 2,000 total changed lines, and 10 new files' "$developer_job"
grep -Fq 'Avoid broad formatting changes and large generated additions.' "$developer_job"

guard_stage_line="$(grep -n -F 'git add -A' "$guard_script" | head -n1 | cut -d: -f1)"
guard_helper_line="$(grep -n -F 'evaluate-codex-diff-gate.sh' "$guard_script" | head -n1 | cut -d: -f1)"
[ -n "$guard_stage_line" ]
[ -n "$guard_helper_line" ]
[ "$guard_stage_line" -lt "$guard_helper_line" ]

publish_if="$(awk '
  /^      - name: Commit, push, and open or update PR$/ { found = 1; next }
  found && /^        if: / { print; exit }
  found && /^      - name: / { exit }
' "$developer_job")"
[ "$publish_if" = "        if: steps.development-gate.outputs.continue == 'true' && steps.diff-guard.outputs.continue == 'true'" ]

grep -Fq 'git show "${BASE_SHA}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$followup_job"
followup_bootstrap_line="$(grep -n -F 'git show "${BASE_SHA}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$followup_job" | cut -d: -f1)"
followup_codex_line="$(grep -n -F '      - name: Run Codex follow-up' "$followup_job" | cut -d: -f1)"
[ "$followup_bootstrap_line" -lt "$followup_codex_line" ]
grep -Fq '25 changed files, 2,000 total changed lines, and 10 new files' "$followup_job"
grep -Fq 'Avoid broad formatting changes and large generated additions.' "$followup_job"

followup_stage_line="$(grep -n -F 'git add -A' "$followup_guard_script" | head -n1 | cut -d: -f1)"
followup_helper_line="$(grep -n -F 'evaluate-codex-diff-gate.sh' "$followup_guard_script" | head -n1 | cut -d: -f1)"
[ -n "$followup_stage_line" ]
[ -n "$followup_helper_line" ]
[ "$followup_stage_line" -lt "$followup_helper_line" ]

followup_publish_if="$(awk '
  /^      - name: Commit and answer review$/ { found = 1; next }
  found && /^        if: / { print; exit }
  found && /^      - name: / { exit }
' "$followup_job")"
[ "$followup_publish_if" = "        if: steps.verify-reviewer.outputs.trusted == 'true' && steps.followup-gate.outputs.continue == 'true' && steps.codex-requirements-gate.outputs.continue == 'true' && steps.followup-diff-guard.outputs.continue == 'true'" ]

make_case_environment() {
  local case_dir="${1:?case dir is required}"
  mkdir -p "$case_dir/bin" "$case_dir/runner" "$case_dir/.ai-context"
  : > "$case_dir/.ai-context/request.md"
  : > "$case_dir/github-output"
  : > "$case_dir/summary"
  : > "$case_dir/gh.log"
  : > "$case_dir/pause.log"
  : > "$case_dir/git.log"

  cat > "$case_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GIT_LOG"
if [ "$#" -eq 2 ] && [ "$1" = add ] && [ "$2" = -A ]; then
  exit 0
fi
echo "unexpected git invocation: $*" >&2
exit 2
EOF
  chmod +x "$case_dir/bin/git"

  cat > "$case_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = pr ] && [ "$2" = list ]; then
  exit 0
fi
if { [ "$1" = issue ] || [ "$1" = pr ]; } && [ "$2" = comment ]; then
  shift 2
  body=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --body ]; then
      body="${2-}"
      break
    fi
    shift
  done
  printf '%s\n' "$body" >> "$GH_LOG"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 2
EOF
  chmod +x "$case_dir/bin/gh"

  cat > "$case_dir/runner/apply-human-pause.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$PAUSE_LOG"
EOF
  chmod +x "$case_dir/runner/apply-human-pause.sh"
}

run_case() {
  local name="${1:?case name is required}"
  local helper_body="${2:?helper body is required}"
  local guard="${3:-$guard_script}"
  local case_dir="$test_dir/$name"
  make_case_environment "$case_dir"
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' "$helper_body" > "$case_dir/runner/evaluate-codex-diff-gate.sh"
  chmod +x "$case_dir/runner/evaluate-codex-diff-gate.sh"

  (
    cd "$case_dir"
    PATH="$case_dir/bin:$PATH" \
    RUNNER_TEMP="$case_dir/runner" \
    GITHUB_OUTPUT="$case_dir/github-output" \
    GITHUB_STEP_SUMMARY="$case_dir/summary" \
    GITHUB_REPOSITORY='owner/repo' \
    ISSUE_NUMBER='169' \
    GH_LOG="$case_dir/gh.log" \
    PAUSE_LOG="$case_dir/pause.log" \
    GIT_LOG="$case_dir/git.log" \
      PR_NUMBER='172' \
      HEAD_REF='ai/issue-170' \
      bash "$guard"
  )

  grep -Fxq 'add -A' "$case_dir/git.log"
  [ ! -e "$case_dir/.ai-context/request.md" ]
}

assert_no_metric_diagnostics() {
  local file="${1:?file is required}"
  if grep -Eq '(^|[-[:space:]])(changed_files|additions|deletions|total_changed_lines|new_files):[[:space:]]*[0-9]+' "$file"; then
    echo "Unexpected measured metric in $file" >&2
    cat "$file" >&2
    exit 1
  fi
}

run_case pass 'printf '\''%s\n'\'' '\''{"result":"pass","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\'''
grep -Fxq 'continue=true' "$test_dir/pass/github-output"
[ ! -s "$test_dir/pass/gh.log" ]
[ ! -s "$test_dir/pass/pause.log" ]
grep -Fq -- '- Result: pass' "$test_dir/pass/summary"
grep -Fq -- '- Changed files: 2 / 25' "$test_dir/pass/summary"

run_case stop 'printf '\''%s\n'\'' '\''{"result":"stop","changed_files":26,"additions":1200,"deletions":900,"total_changed_lines":2100,"new_files":4}'\'''
grep -Fxq 'continue=false' "$test_dir/stop/github-output"
[ -s "$test_dir/stop/pause.log" ]
grep -Fq 'oversized repository change' "$test_dir/stop/gh.log"
grep -Fq 'changed_files: 26' "$test_dir/stop/gh.log"
grep -Fq 'total_changed_lines: 2100' "$test_dir/stop/gh.log"
grep -Fq -- '- changed_files: 26' "$test_dir/stop/summary"

run_case error 'printf '\''%s\n'\'' '\''{"result":"error","changed_files":0,"additions":0,"deletions":0,"total_changed_lines":0,"new_files":0,"error":"git_numstat_unavailable"}'\''; exit 1'
grep -Fxq 'continue=false' "$test_dir/error/github-output"
[ -s "$test_dir/error/pause.log" ]
grep -Fq 'could not safely measure' "$test_dir/error/gh.log"
grep -Fq 'error: git_numstat_unavailable' "$test_dir/error/gh.log"
grep -Fq 'Metrics: unavailable' "$test_dir/error/gh.log"
grep -Fq -- '- Metrics: unavailable' "$test_dir/error/summary"
assert_no_metric_diagnostics "$test_dir/error/gh.log"
assert_no_metric_diagnostics "$test_dir/error/summary"

run_case malformed 'printf '\''%s\n'\'' '\''not-json'\'''
grep -Fxq 'continue=false' "$test_dir/malformed/github-output"
grep -Fq 'could not be parsed' "$test_dir/malformed/gh.log"
assert_no_metric_diagnostics "$test_dir/malformed/gh.log"

run_case unexpected 'printf '\''%s\n'\'' '\''{"result":"later","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\'''
grep -Fxq 'continue=false' "$test_dir/unexpected/github-output"
grep -Fq "unexpected result 'later'" "$test_dir/unexpected/gh.log"
assert_no_metric_diagnostics "$test_dir/unexpected/gh.log"

run_case malformed_pass 'printf '\''%s\n'\'' '\''{"result":"pass","changed_files":-1,"additions":10,"deletions":3,"total_changed_lines":12,"new_files":1}'\'''
grep -Fxq 'continue=false' "$test_dir/malformed_pass/github-output"
grep -Fq 'could not be parsed' "$test_dir/malformed_pass/gh.log"

run_case followup_pass 'printf '\''%s\n'\'' '\''{"result":"pass","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\''' "$followup_guard_script"
grep -Fxq 'continue=true' "$test_dir/followup_pass/github-output"
[ ! -s "$test_dir/followup_pass/gh.log" ]
[ ! -s "$test_dir/followup_pass/pause.log" ]
grep -Fq -- '- Result: pass' "$test_dir/followup_pass/summary"

run_case followup_stop 'printf '\''%s\n'\'' '\''{"result":"stop","changed_files":26,"additions":1200,"deletions":900,"total_changed_lines":2100,"new_files":4}'\''' "$followup_guard_script"
grep -Fxq 'continue=false' "$test_dir/followup_stop/github-output"
[ -s "$test_dir/followup_stop/pause.log" ]
grep -Fq 'oversized repository change' "$test_dir/followup_stop/gh.log"
grep -Fq 'changed_files: 26' "$test_dir/followup_stop/gh.log"

run_case followup_error 'printf '\''%s\n'\'' '\''{"result":"error","changed_files":0,"additions":0,"deletions":0,"total_changed_lines":0,"new_files":0,"error":"git_numstat_unavailable"}'\''; exit 1' "$followup_guard_script"
grep -Fxq 'continue=false' "$test_dir/followup_error/github-output"
grep -Fq 'Metrics: unavailable' "$test_dir/followup_error/gh.log"
assert_no_metric_diagnostics "$test_dir/followup_error/gh.log"
assert_no_metric_diagnostics "$test_dir/followup_error/summary"

run_case followup_malformed 'printf '\''%s\n'\'' '\''not-json'\''' "$followup_guard_script"
grep -Fxq 'continue=false' "$test_dir/followup_malformed/github-output"
grep -Fq 'could not be parsed' "$test_dir/followup_malformed/gh.log"
assert_no_metric_diagnostics "$test_dir/followup_malformed/gh.log"

run_case followup_unexpected 'printf '\''%s\n'\'' '\''{"result":"later","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\''' "$followup_guard_script"
grep -Fxq 'continue=false' "$test_dir/followup_unexpected/github-output"
grep -Fq "unexpected result 'later'" "$test_dir/followup_unexpected/gh.log"
assert_no_metric_diagnostics "$test_dir/followup_unexpected/gh.log"

# Notification remains a separate workflow step; verify its fail-closed trigger and trusted helper use.
grep -Fq '      - name: Notify human of diff guard stop' "$developer_job"
grep -Fq "if: steps.development-gate.outputs.continue == 'true' && steps.diff-guard.outputs.continue != 'true'" "$developer_job"
grep -Fq 'bash "$RUNNER_TEMP/notify-human.sh"' "$developer_job"
grep -Fq '      - name: Notify human of follow-up diff guard stop' "$followup_job"
grep -Fq "if: steps.verify-reviewer.outputs.trusted == 'true' && steps.followup-gate.outputs.continue == 'true' && steps.codex-requirements-gate.outputs.continue == 'true' && steps.followup-diff-guard.outputs.continue != 'true'" "$followup_job"
grep -Fq 'bash "$RUNNER_TEMP/notify-human.sh"' "$followup_notify_script"

printf '%s\n' 'AI Developer diff guard fixture tests passed'
