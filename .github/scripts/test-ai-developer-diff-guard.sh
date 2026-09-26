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
publish_script="$test_dir/publish-issue-pr.sh"
followup_commit_script="$test_dir/followup-commit.sh"

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
extract_step_run "$developer_job" 'Commit, push, and open or update PR' "$publish_script"

awk '
  $0 == "  respond-to-claude:" { in_job = 1 }
  in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  respond-to-claude:" { exit }
  in_job { print }
' "$workflow" > "$followup_job"
[ -s "$followup_job" ]
extract_step_run "$followup_job" 'Evaluate trusted follow-up diff guard' "$followup_guard_script"
extract_step_run "$followup_job" 'Commit and answer review' "$followup_commit_script"

# Structural boundaries that are not practical to exercise in the extracted run body.
grep -Fq 'git show "${base_sha}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$developer_job"
grep -Fq 'bash "$RUNNER_TEMP/evaluate-codex-diff-gate.sh" --contract > "$RUNNER_TEMP/codex-diff-guard-contract.json"' "$developer_job"
grep -Fq 'cp "$RUNNER_TEMP/codex-diff-guard-contract.json" .ai-context/diff-guard-contract.json' "$developer_job"
bootstrap_line="$(grep -n -F 'git show "${base_sha}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$developer_job" | cut -d: -f1)"
codex_line="$(grep -n -F '      - name: Run Codex developer' "$developer_job" | cut -d: -f1)"
[ "$bootstrap_line" -lt "$codex_line" ]
grep -Fq '.ai-context/diff-guard-contract.json completely' "$developer_job"
grep -Fq 'maximum changed files, total changed lines (additions + deletions), and new files; keep every metric at or below its maximum.' "$developer_job"
if grep -Fq '25 changed files, 2,000 total changed lines, and 10 new files' "$developer_job"; then
  echo 'Issue-origin Codex prompt must use the trusted contract context.' >&2
  exit 1
fi
grep -Fq 'Avoid broad formatting changes and large generated additions.' "$developer_job"

assert_guard_setup_order() {
  local script="${1:?guard script is required}"
  local label="${2:?label is required}"
  local remove_line reset_line stage_line helper_line
  remove_line="$(grep -n -F 'rm -rf .ai-context' "$script" | head -n1 | cut -d: -f1)"
  reset_line="$(grep -n -F 'git reset -- .ai-context' "$script" | head -n1 | cut -d: -f1)"
  stage_line="$(grep -n -F 'git add -A' "$script" | head -n1 | cut -d: -f1)"
  helper_line="$(grep -n -F 'evaluate-codex-diff-gate.sh' "$script" | head -n1 | cut -d: -f1)"
  [ -n "$remove_line" ] && [ -n "$reset_line" ] && [ -n "$stage_line" ] && [ -n "$helper_line" ]
  if ! [ "$remove_line" -lt "$reset_line" ] || ! [ "$reset_line" -lt "$stage_line" ] || ! [ "$stage_line" -lt "$helper_line" ]; then
    echo "$label guard must remove and unstage runtime context before staging." >&2
    exit 1
  fi
}

assert_publisher_git_allowlist() {
  local script="${1:?publisher script is required}"
  local label="${2:?label is required}"
  local commit_line="${3:?commit command is required}"
  local push_line="${4:?push command is required}"
  local command_count expected_command_count=5

  # This is deliberately an allowlist, rather than a denylist for `git add`:
  # it rejects alternate index writers such as `git -C ... add`, `git stage`,
  # and `git update-index` in addition to commit modes that absorb worktree
  # changes. The publisher may only configure identity, inspect the guarded
  # index, commit it exactly, and push it.
  # Match a shell-command token, not only a line-leading command.  A write
  # hidden after `&&` or `;` must be subject to the same allowlist.
  command_count="$(grep -Ec '(^|[[:space:];&|()])git([[:space:]]|$)' "$script" || true)"
  if grep -Fq 'git rev-parse HEAD' "$script"; then
    expected_command_count=6
  fi
  if [ "$command_count" -ne "$expected_command_count" ] \
      || ! grep -Fxq 'git config user.name "$bot_login"' "$script" \
      || ! grep -Fxq 'git config user.email "${bot_id}+${bot_login}@users.noreply.github.com"' "$script" \
      || ! grep -Fxq 'if git diff --cached --quiet; then' "$script" \
      || ! grep -Fxq "$commit_line" "$script" \
      || ! grep -Fxq "$push_line" "$script"; then
    echo "$label publisher contains a git invocation outside the guarded-index allowlist." >&2
    return 1
  fi
}

assert_guard_setup_order "$guard_script" 'Issue-origin'
assert_publisher_git_allowlist "$publish_script" 'Issue-origin' \
  'git commit -m "Implement #${ISSUE_NUMBER} with Codex"' \
  'git push --set-upstream origin "$AI_BRANCH"'

publish_if="$(awk '
  /^      - name: Commit, push, and open or update PR$/ { found = 1; next }
  found && /^        if: / { print; exit }
  found && /^      - name: / { exit }
' "$developer_job")"
[ "$publish_if" = "        if: steps.development-gate.outputs.continue == 'true' && steps.diff-guard.outputs.continue == 'true'" ]

grep -Fq 'git show "${BASE_SHA}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$followup_job"
grep -Fq 'bash "$RUNNER_TEMP/evaluate-codex-diff-gate.sh" --contract > "$RUNNER_TEMP/codex-diff-guard-contract.json"' "$followup_job"
grep -Fq 'cp "$RUNNER_TEMP/codex-diff-guard-contract.json" .ai-context/diff-guard-contract.json' "$followup_job"
followup_bootstrap_line="$(grep -n -F 'git show "${BASE_SHA}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$followup_job" | cut -d: -f1)"
followup_codex_line="$(grep -n -F '      - name: Run Codex follow-up' "$followup_job" | cut -d: -f1)"
[ "$followup_bootstrap_line" -lt "$followup_codex_line" ]
grep -Fq '.ai-context/diff-guard-contract.json completely' "$followup_job"
grep -Fq 'maximum changed files, total changed lines (additions + deletions), and new files; keep every metric at or below its maximum.' "$followup_job"
if grep -Fq '25 changed files, 2,000 total changed lines, and 10 new files' "$followup_job"; then
  echo 'Follow-up Codex prompt must use the trusted contract context.' >&2
  exit 1
fi
grep -Fq 'Avoid broad formatting changes and large generated additions.' "$followup_job"

assert_guard_setup_order "$followup_guard_script" 'Follow-up'
assert_publisher_git_allowlist "$followup_commit_script" 'Follow-up' \
  'git commit -m "Address Claude review for PR #${PR_NUMBER}"' \
  'git push origin "HEAD:${HEAD_REF}"'

followup_publish_if="$(awk '
  /^      - name: Commit and answer review$/ { found = 1; next }
  found && /^        if: / { print; exit }
  found && /^      - name: / { exit }
' "$followup_job")"
[ "$followup_publish_if" = "        if: steps.verify-reviewer.outputs.trusted == 'true' && steps.followup-gate.outputs.continue == 'true' && steps.codex-requirements-gate.outputs.continue == 'true' && steps.followup-diff-guard.outputs.continue == 'true'" ]

make_case_environment() {
  local case_dir="${1:?case dir is required}"
  local contract="${2-}"
  if [ -z "$contract" ]; then
    contract='{"max_changed_files":25,"max_changed_lines":2000,"max_new_files":10}'
  fi
  mkdir -p "$case_dir/bin" "$case_dir/runner/trusted-human-pause" "$case_dir/.ai-context"
  : > "$case_dir/.ai-context/request.md"
  printf '%s\n' "$contract" > "$case_dir/runner/codex-diff-guard-contract.json"
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
  [ ! -e .ai-context/request.md ]
  exit 0
fi
if [ "$#" -eq 3 ] && [ "$1" = reset ] && [ "$2" = -- ] && [ "$3" = .ai-context ]; then
  [ ! -e .ai-context/request.md ]
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
  printf '[]\n'
  exit 0
fi
if [ "$1" = api ] && [ "$2" = /apps/dev ]; then
  printf '123\n'
  exit 0
fi
if [ "$1" = api ] && { [ "$2" = /repos/owner/repo/issues/169 ] || [ "$2" = repos/owner/repo/issues/170 ]; }; then
  printf '{"body":"fixture body\\n"}\n'
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

  cat > "$case_dir/runner/trusted-human-pause/create-human-pause.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$PAUSE_LOG"
EOF
  chmod +x "$case_dir/runner/trusted-human-pause/create-human-pause.sh"
  cp "$case_dir/runner/trusted-human-pause/create-human-pause.sh" \
    "$case_dir/runner/apply-human-pause.sh"
}

run_case() {
  local name="${1:?case name is required}"
  local helper_body="${2:?helper body is required}"
  local guard="${3:-$guard_script}"
  local contract="${4-}"
  if [ -z "$contract" ]; then
    contract='{"max_changed_files":25,"max_changed_lines":2000,"max_new_files":10}'
  fi
  local case_dir="$test_dir/$name"
  make_case_environment "$case_dir" "$contract"
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
    APP_SLUG='dev' \
    GH_LOG="$case_dir/gh.log" \
    PAUSE_LOG="$case_dir/pause.log" \
    GIT_LOG="$case_dir/git.log" \
      PR_NUMBER='172' \
      HEAD_REF='ai/issue-170' \
      bash "$guard"
  )

  assert_runtime_guard_setup_order "$case_dir/git.log" "$name"
  [ ! -e "$case_dir/.ai-context/request.md" ]
}

assert_invalid_contract_fails_closed() {
  local name="${1:?case name is required}"
  local contract="${2:?contract is required}"
  local guard="${3:-$guard_script}"
  local case_dir="$test_dir/$name"
  make_case_environment "$case_dir" "$contract"
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
    'printf helper-invoked > "$RUNNER_TEMP/helper.log"' > "$case_dir/runner/evaluate-codex-diff-gate.sh"
  chmod +x "$case_dir/runner/evaluate-codex-diff-gate.sh"

  if (
    cd "$case_dir"
    PATH="$case_dir/bin:$PATH" \
    RUNNER_TEMP="$case_dir/runner" \
    GITHUB_OUTPUT="$case_dir/github-output" \
    GITHUB_STEP_SUMMARY="$case_dir/summary" \
    GITHUB_REPOSITORY='owner/repo' \
    APP_SLUG='dev' \
    ISSUE_NUMBER='169' PR_NUMBER='172' HEAD_REF='ai/issue-170' \
    GH_LOG="$case_dir/gh.log" PAUSE_LOG="$case_dir/pause.log" GIT_LOG="$case_dir/git.log" \
      bash "$guard"
  ); then
    echo "$name accepted an invalid trusted diff guard contract." >&2
    exit 1
  fi
  [ ! -e "$case_dir/runner/helper.log" ]
  [ ! -s "$case_dir/github-output" ]
  [ ! -s "$case_dir/summary" ]
  [ ! -s "$case_dir/gh.log" ]
  [ ! -s "$case_dir/pause.log" ]
}

assert_missing_contract_fails_closed() {
  local name="${1:?case name is required}"
  local guard="${2:-$guard_script}"
  local case_dir="$test_dir/$name"
  make_case_environment "$case_dir"
  rm "$case_dir/runner/codex-diff-guard-contract.json"
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
    'printf helper-invoked > "$RUNNER_TEMP/helper.log"' > "$case_dir/runner/evaluate-codex-diff-gate.sh"
  chmod +x "$case_dir/runner/evaluate-codex-diff-gate.sh"

  if (
    cd "$case_dir"
    PATH="$case_dir/bin:$PATH" \
    RUNNER_TEMP="$case_dir/runner" \
    GITHUB_OUTPUT="$case_dir/github-output" \
    GITHUB_STEP_SUMMARY="$case_dir/summary" \
    GITHUB_REPOSITORY='owner/repo' \
    APP_SLUG='dev' \
    ISSUE_NUMBER='169' PR_NUMBER='172' HEAD_REF='ai/issue-170' \
    GH_LOG="$case_dir/gh.log" PAUSE_LOG="$case_dir/pause.log" GIT_LOG="$case_dir/git.log" \
      bash "$guard"
  ); then
    echo "$name accepted a missing trusted diff guard contract." >&2
    exit 1
  fi
  [ ! -e "$case_dir/runner/helper.log" ]
  [ ! -s "$case_dir/github-output" ]
  [ ! -s "$case_dir/summary" ]
  [ ! -s "$case_dir/gh.log" ]
  [ ! -s "$case_dir/pause.log" ]
}

assert_runtime_guard_setup_order() {
  local git_log="${1:?git log is required}"
  local label="${2:?label is required}"
  local reset_line stage_line
  reset_line="$(grep -n -Fx 'reset -- .ai-context' "$git_log" | head -n1 | cut -d: -f1)"
  stage_line="$(grep -n -Fx 'add -A' "$git_log" | head -n1 | cut -d: -f1)"
  if [ -z "$reset_line" ] || [ -z "$stage_line" ] || ! [ "$reset_line" -lt "$stage_line" ]; then
    echo "$label runtime guard must unstage runtime context before staging." >&2
    exit 1
  fi
}

run_publisher_case() {
  local name="${1:?case name is required}"
  local publisher="${2:?publisher script is required}"
  local commit_message="${3:?commit message is required}"
  local injection="${4-}"
  local remote_head="${5-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  local expected_head="${6-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  local case_dir="$test_dir/publisher-$name"
  mkdir -p "$case_dir"
  : > "$case_dir/calls.log"
  : > "$case_dir/github-output"
  printf '%s\n' 'result summary' > "$case_dir/final.md"

  if [ -n "$injection" ]; then
    sed "/^git commit -m /i\\$injection" "$publisher" > "$case_dir/publisher.sh"
  else
    cp "$publisher" "$case_dir/publisher.sh"
  fi

  (
    cd "$case_dir"
    git() {
      printf 'git %s\n' "$*" >> "$PUBLISH_LOG"
      case "$1" in
        config) return 0 ;;
        diff) return 1 ;;
        commit)
          if ! [ "$#" -eq 3 ] || ! [ "$2" = -m ] || ! [ "$3" = "$PUBLISH_COMMIT_MESSAGE" ]; then
            echo "Publisher invoked a git command outside the guarded-index allowlist: $*" >&2
            return 2
          fi
          return 0
          ;;
        push) return 0 ;;
        rev-parse)
          printf '%s\n' "$PUBLISH_EXPECTED_HEAD"
          return 0
          ;;
        *)
          echo "Publisher invoked a git command outside the guarded-index allowlist: $*" >&2
          return 2
          ;;
      esac
    }
    gh() {
      printf 'gh %s\n' "$*" >> "$PUBLISH_LOG"
      case "$1 $2" in
        'api /users/dev[bot]') echo 123 ;;
        'pr list') printf '[]\n' ;;
        'pr create') echo 'https://github.com/owner/repo/pull/37' ;;
        'pr view')
          printf '%s\n' "$PUBLISH_REMOTE_HEAD"
          return 0
          ;;
        'pr ready'|'pr comment'|'issue comment') return 0 ;;
        *) return 2 ;;
      esac
    }
    export -f git gh
    PUBLISH_LOG="$case_dir/calls.log" \
    PUBLISH_COMMIT_MESSAGE="$commit_message" \
    PUBLISH_REMOTE_HEAD="$remote_head" \
    PUBLISH_EXPECTED_HEAD="$expected_head" \
    EVENT_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    GITHUB_OUTPUT="$case_dir/github-output" \
    GITHUB_REPOSITORY=owner/repo APP_SLUG=dev ISSUE_NUMBER=36 PR_NUMBER=37 \
    ISSUE_TITLE='Related correction' AI_BRANCH=ai/issue-36 HEAD_REF=ai/issue-36 \
    CODEX_FINAL="$case_dir/final.md" \
      bash "$case_dir/publisher.sh"
  )
}

assert_publisher_bypass_is_blocked() {
  local route="${1:?route is required}"
  local publisher="${2:?publisher script is required}"
  local commit_message="${3:?commit message is required}"
  local variant_name injection expected_call case_dir stderr_file static_commit static_push
  case "$route" in
    issue-origin)
      static_commit='git commit -m "Implement #${ISSUE_NUMBER} with Codex"'
      static_push='git push --set-upstream origin "$AI_BRANCH"'
      ;;
    followup)
      static_commit='git commit -m "Address Claude review for PR #${PR_NUMBER}"'
      static_push='git push origin "HEAD:${HEAD_REF}"'
      ;;
    *)
      echo "Unknown publisher route: $route" >&2
      exit 1
      ;;
  esac
  for variant_name in git-c-add git-stage git-update-index git-commit-a git-commit-am git-after-and git-after-semicolon; do
    case "$variant_name" in
      git-c-add) injection='git -C . add -A'; expected_call='git -C . add -A' ;;
      git-stage) injection='git stage -A'; expected_call='git stage -A' ;;
      git-update-index) injection='git update-index --add guarded-file'; expected_call='git update-index --add guarded-file' ;;
      git-commit-a) injection="git commit -a -m \"$commit_message\""; expected_call="git commit -a -m $commit_message" ;;
      git-commit-am) injection="git commit -am \"$commit_message\""; expected_call="git commit -am $commit_message" ;;
      git-after-and) injection=': && git -C . add -A'; expected_call='git -C . add -A' ;;
      git-after-semicolon) injection=':; git stage -A'; expected_call='git stage -A' ;;
    esac
    case_dir="$test_dir/publisher-${route}-${variant_name}"
    stderr_file="$test_dir/publisher-${route}-${variant_name}.stderr"
    run_publisher_case "${route}-${variant_name}" "$publisher" "$commit_message" "$injection" \
      >"$test_dir/publisher-${route}-${variant_name}.stdout" 2>"$stderr_file" && {
      echo "$route publisher accepted post-guard $variant_name staging." >&2
      exit 1
    }
    if assert_publisher_git_allowlist "$case_dir/publisher.sh" "$route mutation" \
        "$static_commit" "$static_push" > /dev/null 2>&1; then
      echo "$route publisher static allowlist accepted $variant_name." >&2
      exit 1
    fi
    if ! grep -Fxq "$expected_call" "$case_dir/calls.log"; then
      echo "$route publisher did not invoke the injected $variant_name git command." >&2
      exit 1
    fi
    grep -Fq 'Publisher invoked a git command outside the guarded-index allowlist:' "$stderr_file"
    if grep -Eq 'git push|gh (pr create|pr comment|issue comment)' "$case_dir/calls.log" \
        || grep -Fxq "git commit -m $commit_message" "$case_dir/calls.log"; then
      echo "$route publisher performed a publish side effect after $variant_name." >&2
      exit 1
    fi
  done
}

assert_no_metric_diagnostics() {
  local file="${1:?file is required}"
  if grep -Eq '(^|[-[:space:]])(changed_files|additions|deletions|total_changed_lines|new_files):[[:space:]]*[0-9]+' "$file"; then
    echo "Unexpected measured metric in $file" >&2
    cat "$file" >&2
    exit 1
  fi
}

fixture_contract='{"max_changed_files":3,"max_changed_lines":40,"max_new_files":2}'
run_case pass 'printf '\''%s\n'\'' '\''{"result":"pass","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\''' "$guard_script" "$fixture_contract"
grep -Fxq 'continue=true' "$test_dir/pass/github-output"
[ ! -s "$test_dir/pass/gh.log" ]
[ ! -s "$test_dir/pass/pause.log" ]
grep -Fq -- '- Result: pass' "$test_dir/pass/summary"
grep -Fq -- '- Changed files: 2 / 3' "$test_dir/pass/summary"
grep -Fq -- '- Total changed lines: 13 / 40' "$test_dir/pass/summary"
grep -Fq -- '- New files: 1 / 2' "$test_dir/pass/summary"

assert_invalid_contract_fails_closed contract_missing '{}'
assert_missing_contract_fails_closed contract_file_missing
assert_invalid_contract_fails_closed contract_schema_invalid '{"max_changed_files":25,"max_changed_lines":2000,"max_new_files":10,"unexpected":true}'
assert_invalid_contract_fails_closed contract_value_invalid '{"max_changed_files":0,"max_changed_lines":2000,"max_new_files":10}'

run_case stop 'printf '\''%s\n'\'' '\''{"result":"stop","changed_files":26,"additions":1200,"deletions":900,"total_changed_lines":2100,"new_files":4}'\''' "$guard_script" "$fixture_contract"
grep -Fxq 'continue=false' "$test_dir/stop/github-output"
[ -s "$test_dir/stop/pause.log" ]
stop_fingerprint="sha256:$(printf 'fixture body\n' | sha256sum | cut -d' ' -f1)"
grep -Fq "create owner/repo 169 - 123 diff_guard_exceeded" "$test_dir/stop/pause.log"
grep -Fq -- "--issue-body-fingerprint $stop_fingerprint" "$test_dir/stop/pause.log"
grep -Fq 'oversized repository change' "$test_dir/stop/gh.log"
grep -Fq 'changed_files: 26' "$test_dir/stop/gh.log"
grep -Fq 'total_changed_lines: 2100' "$test_dir/stop/gh.log"
grep -Fq -- '- changed_files: 26' "$test_dir/stop/summary"
grep -Fq -- '- Thresholds: 3 changed files / 40 total changed lines / 2 new files' "$test_dir/stop/summary"

run_case error 'printf '\''%s\n'\'' '\''{"result":"error","changed_files":0,"additions":0,"deletions":0,"total_changed_lines":0,"new_files":0,"error":"git_numstat_unavailable"}'\''; exit 1' "$guard_script" "$fixture_contract"
grep -Fxq 'continue=false' "$test_dir/error/github-output"
[ -s "$test_dir/error/pause.log" ]
grep -Fq 'create owner/repo 169 - 123 diff_guard_error' "$test_dir/error/pause.log"
if grep -Fq -- '--issue-body-fingerprint' "$test_dir/error/pause.log"; then
  echo 'Diff guard error must not require an Issue body fingerprint.' >&2
  exit 1
fi
grep -Fq 'could not safely measure' "$test_dir/error/gh.log"
grep -Fq 'error: git_numstat_unavailable' "$test_dir/error/gh.log"
grep -Fq 'Metrics: unavailable' "$test_dir/error/gh.log"
grep -Fq -- '- Metrics: unavailable' "$test_dir/error/summary"
grep -Fq -- '- Thresholds: 3 changed files / 40 total changed lines / 2 new files' "$test_dir/error/summary"
assert_no_metric_diagnostics "$test_dir/error/gh.log"
assert_no_metric_diagnostics "$test_dir/error/summary"

run_case malformed 'printf '\''%s\n'\'' '\''not-json'\'''
grep -Fxq 'continue=false' "$test_dir/malformed/github-output"
grep -Fq 'create owner/repo 169 - 123 diff_guard_error' "$test_dir/malformed/pause.log"
grep -Fq 'could not be parsed' "$test_dir/malformed/gh.log"
assert_no_metric_diagnostics "$test_dir/malformed/gh.log"

run_case unexpected 'printf '\''%s\n'\'' '\''{"result":"later","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\'''
grep -Fxq 'continue=false' "$test_dir/unexpected/github-output"
grep -Fq 'create owner/repo 169 - 123 diff_guard_error' "$test_dir/unexpected/pause.log"
grep -Fq "unexpected result 'later'" "$test_dir/unexpected/gh.log"
assert_no_metric_diagnostics "$test_dir/unexpected/gh.log"

run_case malformed_pass 'printf '\''%s\n'\'' '\''{"result":"pass","changed_files":-1,"additions":10,"deletions":3,"total_changed_lines":12,"new_files":1}'\'''
grep -Fxq 'continue=false' "$test_dir/malformed_pass/github-output"
grep -Fq 'create owner/repo 169 - 123 diff_guard_error' "$test_dir/malformed_pass/pause.log"
grep -Fq 'could not be parsed' "$test_dir/malformed_pass/gh.log"

run_case helper_failure 'exit 2'
grep -Fxq 'continue=false' "$test_dir/helper_failure/github-output"
grep -Fq 'create owner/repo 169 - 123 diff_guard_error' "$test_dir/helper_failure/pause.log"

run_case followup_pass 'printf '\''%s\n'\'' '\''{"result":"pass","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\''' "$followup_guard_script" "$fixture_contract"
grep -Fxq 'continue=true' "$test_dir/followup_pass/github-output"
[ ! -s "$test_dir/followup_pass/gh.log" ]
[ ! -s "$test_dir/followup_pass/pause.log" ]
grep -Fq -- '- Result: pass' "$test_dir/followup_pass/summary"
grep -Fq -- '- Changed files: 2 / 3' "$test_dir/followup_pass/summary"
grep -Fq -- '- Total changed lines: 13 / 40' "$test_dir/followup_pass/summary"
grep -Fq -- '- New files: 1 / 2' "$test_dir/followup_pass/summary"

assert_invalid_contract_fails_closed followup_contract_missing '{}' "$followup_guard_script"
assert_missing_contract_fails_closed followup_contract_file_missing "$followup_guard_script"
assert_invalid_contract_fails_closed followup_contract_schema_invalid '{"max_changed_files":25,"max_changed_lines":2000,"max_new_files":10,"unexpected":true}' "$followup_guard_script"
assert_invalid_contract_fails_closed followup_contract_value_invalid '{"max_changed_files":0,"max_changed_lines":2000,"max_new_files":10}' "$followup_guard_script"

run_case followup_stop 'printf '\''%s\n'\'' '\''{"result":"stop","changed_files":26,"additions":1200,"deletions":900,"total_changed_lines":2100,"new_files":4}'\''' "$followup_guard_script" "$fixture_contract"
grep -Fxq 'continue=false' "$test_dir/followup_stop/github-output"
grep -Fq 'create owner/repo 170 172 123 diff_guard_exceeded' "$test_dir/followup_stop/pause.log"
grep -Fq -- "--issue-body-fingerprint $stop_fingerprint" "$test_dir/followup_stop/pause.log"
grep -Fq 'oversized repository change' "$test_dir/followup_stop/pause.log"
grep -Fq 'changed_files: 26' "$test_dir/followup_stop/pause.log"
[ ! -s "$test_dir/followup_stop/gh.log" ]
grep -Fq -- '- Thresholds: 3 changed files / 40 total changed lines / 2 new files' "$test_dir/followup_stop/summary"

run_case followup_error 'printf '\''%s\n'\'' '\''{"result":"error","changed_files":0,"additions":0,"deletions":0,"total_changed_lines":0,"new_files":0,"error":"git_numstat_unavailable"}'\''; exit 1' "$followup_guard_script" "$fixture_contract"
grep -Fxq 'continue=false' "$test_dir/followup_error/github-output"
grep -Fq 'create owner/repo 170 172 123 diff_guard_error' "$test_dir/followup_error/pause.log"
grep -Fq 'Metrics: unavailable' "$test_dir/followup_error/pause.log"
[ ! -s "$test_dir/followup_error/gh.log" ]
grep -Fq -- '- Thresholds: 3 changed files / 40 total changed lines / 2 new files' "$test_dir/followup_error/summary"
assert_no_metric_diagnostics "$test_dir/followup_error/pause.log"
assert_no_metric_diagnostics "$test_dir/followup_error/summary"

run_case followup_malformed 'printf '\''%s\n'\'' '\''not-json'\''' "$followup_guard_script"
grep -Fxq 'continue=false' "$test_dir/followup_malformed/github-output"
grep -Fq 'could not be parsed' "$test_dir/followup_malformed/pause.log"
assert_no_metric_diagnostics "$test_dir/followup_malformed/pause.log"

run_case followup_unexpected 'printf '\''%s\n'\'' '\''{"result":"later","changed_files":2,"additions":10,"deletions":3,"total_changed_lines":13,"new_files":1}'\''' "$followup_guard_script"
grep -Fxq 'continue=false' "$test_dir/followup_unexpected/github-output"
grep -Fq "unexpected result 'later'" "$test_dir/followup_unexpected/pause.log"
assert_no_metric_diagnostics "$test_dir/followup_unexpected/pause.log"

# Exercise both extracted publishers. The normal case demonstrates that the
# exact guarded index can still be committed and pushed; each mutation models
# either a post-guard index write or a commit mode that absorbs worktree
# changes, and must stop before an allowed commit, push, or GitHub publication
# side effect.
run_publisher_case issue-origin "$publish_script" 'Implement #36 with Codex'
grep -Fq 'git commit -m Implement #36 with Codex' "$test_dir/publisher-issue-origin/calls.log"
grep -Fq 'git push --set-upstream origin ai/issue-36' "$test_dir/publisher-issue-origin/calls.log"
run_publisher_case followup "$followup_commit_script" 'Address Claude review for PR #37'
grep -Fq 'git commit -m Address Claude review for PR #37' "$test_dir/publisher-followup/calls.log"
grep -Fq 'git push origin HEAD:ai/issue-36' "$test_dir/publisher-followup/calls.log"
grep -Fxq 'result=pushed' "$test_dir/publisher-followup/github-output"
grep -Fxq 'sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$test_dir/publisher-followup/github-output"
if grep -Fq 'gh pr ready' "$test_dir/publisher-followup/calls.log"; then
  echo 'Follow-up publisher readied the PR before the separate traceability step.' >&2
  exit 1
fi
if run_publisher_case followup-stale-head "$followup_commit_script" 'Address Claude review for PR #37' '' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  echo 'Follow-up publisher accepted a stale pushed HEAD.' >&2
  exit 1
fi
if grep -Fxq 'result=pushed' "$test_dir/publisher-followup-stale-head/github-output"; then
  echo 'Follow-up publisher reported a stale remote HEAD as pushed.' >&2
  exit 1
fi
assert_publisher_bypass_is_blocked issue-origin "$publish_script" 'Implement #36 with Codex'
assert_publisher_bypass_is_blocked followup "$followup_commit_script" 'Address Claude review for PR #37'

# Both diff guard routes create a common human pause before its helper notifies.
if grep -Fq '      - name: Notify human of diff guard stop' "$developer_job"; then
  echo 'Issue-origin diff guard still has a direct notification step.' >&2
  exit 1
fi
grep -Fq '"$RUNNER_TEMP/trusted-human-pause/create-human-pause.sh" create' "$guard_script"
if grep -Fq '      - name: Notify human of follow-up diff guard stop' "$followup_job"; then
  echo 'Follow-up diff guard still has a direct notification step.' >&2
  exit 1
fi
grep -Fq '"$RUNNER_TEMP/trusted-human-pause/create-human-pause.sh" create' "$followup_guard_script"
if grep -Fq 'notify-human.sh' "$followup_guard_script"; then
  echo 'Follow-up diff guard notified outside the common human-pause helper.' >&2
  exit 1
fi
grep -Fq 'jq -e --arg id "$pause_id" --arg reason "$reason"' "$repo_root/.github/scripts/create-human-pause.sh"
grep -Fq 'bash "$script_dir/notify-human.sh" "$message"' "$repo_root/.github/scripts/create-human-pause.sh"

printf '%s\n' 'AI Developer diff guard fixture tests passed'
