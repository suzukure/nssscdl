#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
workflow="$repo_root/.github/workflows/ai-developer.yml"

[ -f "$workflow" ]

developer_job="$(mktemp)"
trap 'rm -f "$developer_job"' EXIT
awk '
  $0 == "  develop-from-issue:" { in_job = 1 }
  in_job && /^  [[:alnum:]_-]+:$/ && $0 != "  develop-from-issue:" { exit }
  in_job { print }
' "$workflow" > "$developer_job"
[ -s "$developer_job" ]

# Trusted helper must be copied from the base SHA before Codex can mutate the tree.
grep -Fq 'git show "${base_sha}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$developer_job"
bootstrap_line="$(grep -n -F 'git show "${base_sha}:.github/scripts/evaluate-codex-diff-gate.sh" > "$RUNNER_TEMP/evaluate-codex-diff-gate.sh"' "$developer_job" | cut -d: -f1)"
codex_line="$(grep -n -F '      - name: Run Codex developer' "$developer_job" | cut -d: -f1)"
[ "$bootstrap_line" -lt "$codex_line" ]

# Prompt is only an early suppression layer; the trusted helper is the hard stop.
grep -Fq '25 changed files, 2,000 total changed lines, and 10 new files' "$developer_job"
grep -Fq 'Avoid broad formatting changes and large generated additions.' "$developer_job"

# Guard runs only after the requirement gate and stages the final repository diff.
grep -Fq '      - name: Evaluate trusted diff guard' "$developer_job"
grep -Fq "        if: steps.development-gate.outputs.continue == 'true'" "$developer_job"
grep -Fq '          rm -f .ai-context/request.md' "$developer_job"
grep -Fq '          git add -A' "$developer_job"
grep -Fq 'result_json="$(bash "$RUNNER_TEMP/evaluate-codex-diff-gate.sh")"' "$developer_job"

# Exit status alone must never authorize repository write. A pass result must also
# carry the complete numeric metrics contract expected from the trusted helper.
grep -Fq '[ "$helper_status" -eq 0 ] && [ "$parsed" = true ] && [ "$result" = pass ]' "$developer_job"
grep -Fq '.changed_files | type == "number"' "$developer_job"
grep -Fq '.additions | type == "number"' "$developer_job"
grep -Fq '.deletions | type == "number"' "$developer_job"
grep -Fq '.total_changed_lines | type == "number"' "$developer_job"
grep -Fq '.new_files | type == "number"' "$developer_job"
grep -Fq "echo 'continue=true' >> \"\$GITHUB_OUTPUT\"" "$developer_job"
grep -Fq "echo 'continue=false' >> \"\$GITHUB_OUTPUT\"" "$developer_job"
grep -Fq 'Trusted diff guard output could not be parsed; automated development is paused.' "$developer_job"
grep -Fq 'Trusted diff guard returned unexpected result' "$developer_job"
grep -Fq 'Trusted diff guard could not safely measure the staged change' "$developer_job"

# Stop/error path pauses and records diagnostics before returning continue=false.
grep -Fq 'bash "$RUNNER_TEMP/apply-human-pause.sh" "$GITHUB_REPOSITORY" "$ISSUE_NUMBER" "$pr_number"' "$developer_job"
grep -Fq 'gh issue comment "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --body "$diagnostics"' "$developer_job"
grep -Fq '### AI Developer diff guard' "$developer_job"
grep -Fq 'Notify human of diff guard stop' "$developer_job"
grep -Fq 'bash "$RUNNER_TEMP/notify-human.sh"' "$developer_job"

# Repository write step itself must be skipped unless both gates pass. This keeps
# an intentional guard stop from turning the whole job into a failure and avoids
# duplicate pause/comment/notification via the generic failure handler.
publish_step="$test_dir_placeholder"
publish_if="$(awk '
  /^      - name: Commit, push, and open or update PR$/ { found = 1; next }
  found && /^        if: / { print; exit }
  found && /^      - name: / { exit }
' "$developer_job")"
[ "$publish_if" = "        if: steps.development-gate.outputs.continue == 'true' && steps.diff-guard.outputs.continue == 'true'" ]
if grep -Fq 'if [ "${{ steps.diff-guard.outputs.continue }}" != true ]; then' "$developer_job"; then
  echo 'Publish step must be skipped by its workflow condition, not fail inside the shell body.' >&2
  exit 1
fi

# This Issue must not alter follow-up behavior yet.
if grep -Fq 'evaluate-codex-diff-gate.sh' <(sed -n '/^  respond-to-claude:/,$p' "$workflow"); then
  echo 'Issue #169 must not connect the diff guard to the Claude follow-up path.' >&2
  exit 1
fi

printf '%s\n' 'AI Developer diff guard fixture tests passed'
