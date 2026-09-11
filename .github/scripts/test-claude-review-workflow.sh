#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$repo_root/.github/workflows/claude-review.yml"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

assert_bootstrap_matches() {
  local terminator="${1:?terminator is required}"
  local script_path="${2:?script path is required}"
  local output_path="$test_dir/bootstrap-${terminator,,}.sh"

  awk -v terminator="$terminator" '
    /^          #!\/usr\/bin\/env bash$/ { candidate = 1; block = "" }
    candidate { line = $0; sub(/^          /, "", line); block = block line ORS }
    candidate && $0 == "          " terminator { printf "%s", block; exit }
  ' "$workflow" | sed '$d' > "$output_path"

  if ! cmp -s "$script_path" "$output_path"; then
    echo "Bootstrap copy mismatch for $script_path (terminator: $terminator)." >&2
    exit 1
  fi
}

extract_step_run() {
  local step_name="${1:?step name is required}"
  local output_path="${2:?output path is required}"

  awk -v step_name="$step_name" '
    $0 == "      - name: " step_name { step = 1 }
    step && /^        run: \|$/ { run = 1; next }
    run && /^      - name: / { exit }
    run { line = $0; sub(/^          /, "", line); print line }
  ' "$workflow" > "$output_path"
  if [ ! -s "$output_path" ]; then
    echo "Could not extract $step_name step." >&2
    exit 1
  fi
}

assert_bootstrap_matches VALIDATOR "$repo_root/.github/scripts/validate-claude-review-output.sh"
assert_bootstrap_matches SUMMARIZER "$repo_root/.github/scripts/summarize-claude-usage.sh"
assert_bootstrap_matches REVIEW_GATE "$repo_root/.github/scripts/evaluate-claude-review-entry-gate.sh"
assert_bootstrap_matches RISK_CLASSIFIER "$repo_root/.github/scripts/classify-claude-review-risk.sh"
grep -Fq 'git show "${BASE_SHA}:.github/scripts/classify-claude-review-execution.sh" > "$RUNNER_TEMP/classify-claude-review-execution.sh"' "$workflow"

model_step="$test_dir/select-claude-review-model.sh"
extract_step_run 'Select Claude review model' "$model_step"
runner_temp="$test_dir/runner-temp"
mkdir "$runner_temp"
cat > "$runner_temp/classify-claude-review-risk.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${TEST_RISK:?TEST_RISK is required}"
EOF
chmod +x "$runner_temp/classify-claude-review-risk.sh"

assert_model_selection() {
  local risk="${1:?risk is required}"
  local expected_model="${2:?expected model is required}"
  local expected_budget="${3:?expected budget is required}"
  local output_path="$test_dir/model-$risk.outputs"

  TEST_RISK="$risk" \
    RUNNER_TEMP="$runner_temp" \
    GITHUB_REPOSITORY=owner/repo \
    PR_NUMBER=37 \
    STANDARD_MODEL=standard-model \
    HIGH_RISK_MODEL=high-risk-model \
    GITHUB_OUTPUT="$output_path" \
    bash "$model_step" > "$test_dir/model-$risk.stdout"
  grep -Fqx "model=$expected_model" "$output_path"
  grep -Fqx "risk=$risk" "$output_path"
  grep -Fqx "budget_arg=$expected_budget" "$output_path"
}

assert_model_selection high high-risk-model '--max-budget-usd 2.10'
assert_model_selection standard standard-model '--max-budget-usd 1.70'

if TEST_RISK=unsupported \
  RUNNER_TEMP="$runner_temp" \
  GITHUB_REPOSITORY=owner/repo \
  PR_NUMBER=37 \
  STANDARD_MODEL=standard-model \
  HIGH_RISK_MODEL=high-risk-model \
  GITHUB_OUTPUT="$test_dir/model-unsupported.outputs" \
  bash "$model_step" > /dev/null 2> "$test_dir/model-unsupported.stderr"; then
  echo 'Expected an unsupported risk classification to fail closed.' >&2
  exit 1
fi
grep -Fq 'Unsupported Claude review risk classification: unsupported' "$test_dir/model-unsupported.stderr"

if TEST_RISK=standard \
  RUNNER_TEMP="$runner_temp" \
  GITHUB_REPOSITORY=owner/repo \
  PR_NUMBER=37 \
  STANDARD_MODEL='   ' \
  HIGH_RISK_MODEL=high-risk-model \
  GITHUB_OUTPUT="$test_dir/model-whitespace.outputs" \
  bash "$model_step" > /dev/null 2> "$test_dir/model-whitespace.stderr"; then
  echo 'Expected a whitespace-only standard model variable to fail preflight.' >&2
  exit 1
fi
grep -Fq 'CLAUDE_MODEL_STANDARD repository variable must contain a non-whitespace value.' "$test_dir/model-whitespace.stderr"

if TEST_RISK=high \
  RUNNER_TEMP="$runner_temp" \
  GITHUB_REPOSITORY=owner/repo \
  PR_NUMBER=37 \
  STANDARD_MODEL=standard-model \
  HIGH_RISK_MODEL=$'\t' \
  GITHUB_OUTPUT="$test_dir/model-high-whitespace.outputs" \
  bash "$model_step" > /dev/null 2> "$test_dir/model-high-whitespace.stderr"; then
  echo 'Expected a whitespace-only high-risk model variable to fail preflight.' >&2
  exit 1
fi
grep -Fq 'CLAUDE_MODEL repository variable must contain a non-whitespace value.' "$test_dir/model-high-whitespace.stderr"

run_step="$test_dir/run-claude-review.yml"
awk '
  $0 == "      - name: Run Claude review" { step = 1 }
  step && /^      - name: / && $0 != "      - name: Run Claude review" { exit }
  step { print }
' "$workflow" > "$run_step"
grep -Fq 'model "${{ steps.review-model.outputs.model }}"' "$run_step"
grep -Fq '${{ steps.review-model.outputs.budget_arg }}' "$run_step"
if grep -Eq -- '--max-budget-usd (1\.70|2\.10)' "$run_step"; then
  echo 'Run Claude review must receive its budget through the selected output.' >&2
  exit 1
fi

if [ "$(grep -Fc 'uses: anthropics/claude-code-action@' "$workflow")" -ne 1 ]; then
  echo 'Expected exactly one Claude review invocation.' >&2
  exit 1
fi
if [ "$(grep -Fc 'continue-on-error: true' "$workflow")" -ne 2 ]; then
  echo 'Expected one fail-closed Claude execution and one non-fatal usage step.' >&2
  exit 1
fi
grep -Fq 'types: [opened, synchronize, reopened, ready_for_review, unlabeled]' "$workflow"
grep -Fq "github.event.label.name == 'human-review-required'" "$workflow"
grep -Fq "!contains(github.event.pull_request.labels.*.name, 'human-review-required')" "$workflow"
grep -Fq 'CLAUDE_MODEL_STANDARD' "$workflow"
grep -Fq 'Record Claude review usage' "$workflow"
grep -Fq 'if $risk == "" then "unavailable" else $risk end' "$workflow"
grep -Fq 'Claude review not run' "$workflow"
grep -Fq 'Gate Claude review entry' "$workflow"
grep -Fq 'cacheCreationInputTokens' "$repo_root/.github/scripts/summarize-claude-usage.sh"
grep -Fq 'cacheReadInputTokens' "$repo_root/.github/scripts/summarize-claude-usage.sh"

echo 'Claude Review workflow fixture tests passed.'
