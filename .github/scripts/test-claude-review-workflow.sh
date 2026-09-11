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

validator="$repo_root/.github/scripts/validate-claude-review-output.sh"
valid_structured_review='{"verdict":"approve","summary":"Reviewed.","blocking_findings":[],"non_blocking_findings":[],"linked_issues_checked":["#59"]}'
validated_structured_review="$(bash "$validator" "$valid_structured_review")"
jq -e '.verdict == "approve" and .linked_issues_checked == ["#59"]' <<< "$validated_structured_review" > /dev/null

fenced_structured_review="$(printf '```json\n%s\n```' "$valid_structured_review")"
validated_fenced_review="$(bash "$validator" "$fenced_structured_review")"
jq -e '.verdict == "approve" and .linked_issues_checked == ["#59"]' <<< "$validated_fenced_review" > /dev/null

surrounded_fenced_review="$(printf 'Review follows:\n```json\n%s\n```' "$valid_structured_review")"
validated_surrounded_fenced_review="$(bash "$validator" "$surrounded_fenced_review")"
jq -e '.verdict == "approve" and .linked_issues_checked == ["#59"]' <<< "$validated_surrounded_fenced_review" > /dev/null

assert_review_rejected() {
  local expected_reason="${1:?expected reason is required}"
  local fixture_name="${2:?fixture name is required}"
  shift 2
  local output_path="$test_dir/$fixture_name.out"
  local error_path="$test_dir/$fixture_name.err"

  if "$@" > "$output_path" 2> "$error_path"; then
    echo "Expected $fixture_name to be rejected." >&2
    exit 1
  fi
  if [ "$(cat "$error_path")" != "$expected_reason" ]; then
    echo "Expected $fixture_name to report $expected_reason." >&2
    exit 1
  fi
  if [ -s "$output_path" ]; then
    echo "Rejected $fixture_name wrote a result to stdout." >&2
    exit 1
  fi
  if grep -Fq 'sensitive-raw-claude-output' "$output_path" "$error_path"; then
    echo "Rejected $fixture_name exposed raw Claude output." >&2
    exit 1
  fi
}

assert_review_rejected invalid_json empty-review bash "$validator" ''
assert_review_rejected invalid_json prose-without-fence \
  bash "$validator" 'Review follows: {"sensitive-raw-claude-output": true}'
assert_review_rejected invalid_json malformed-json \
  bash "$validator" '{"sensitive-raw-claude-output":'
assert_review_rejected ambiguous_result multiple-fences \
  bash "$validator" "$(printf '```json\n%s\n```\n```json\n%s\n```' "$valid_structured_review" "$valid_structured_review")"
assert_review_rejected schema_mismatch incomplete-schema bash "$validator" '{"verdict":"approve"}'
assert_review_rejected schema_mismatch wrong-summary-type \
  bash "$validator" '{"verdict":"approve","summary":[],"blocking_findings":[],"non_blocking_findings":[],"linked_issues_checked":[]}'
assert_review_rejected schema_mismatch extra-schema-key \
  bash "$validator" '{"verdict":"approve","summary":"Reviewed.","blocking_findings":[],"non_blocking_findings":[],"linked_issues_checked":[],"unexpected":true}'

jq -cn --arg review "$fenced_structured_review" '[
  {type:"result", subtype:"success", is_error:false, result:$review}
]' > "$test_dir/valid-execution-with-review.json"
validated_execution_review="$(bash "$validator" --execution-file "$test_dir/valid-execution-with-review.json")"
jq -e '.verdict == "approve" and .linked_issues_checked == ["#59"]' <<< "$validated_execution_review" > /dev/null

for fixture in no-success multiple-success error-result; do
  case "$fixture" in
    no-success)
      fixture_json='[]'
      ;;
    multiple-success)
      fixture_json="$(jq -cn --arg review "$valid_structured_review" '[
        {type:"result", subtype:"success", is_error:false, result:$review},
        {type:"result", subtype:"success", is_error:false, result:$review}
      ]')"
      ;;
    error-result)
      fixture_json="$(jq -cn --arg review "$valid_structured_review" '[
        {type:"result", subtype:"success", is_error:true, result:$review}
      ]')"
      ;;
  esac
  printf '%s\n' "$fixture_json" > "$test_dir/$fixture-execution.json"
  case "$fixture" in
    no-success|error-result) expected_reason=missing_result ;;
    multiple-success) expected_reason=ambiguous_result ;;
  esac
  assert_review_rejected "$expected_reason" "$fixture-execution" \
    bash "$validator" --execution-file "$test_dir/$fixture-execution.json"
done

assert_execution_classification() {
  local expected_reason="${1:?expected reason is required}"
  local fixture_name="${2:?fixture name is required}"
  local execution_file="${3:?execution file is required}"
  local classifier="${4:-$repo_root/.github/scripts/classify-claude-review-execution.sh}"
  local review_file="$test_dir/$fixture_name.review.json"
  local stdout_path="$test_dir/$fixture_name.classifier.out"
  local stderr_path="$test_dir/$fixture_name.classifier.err"

  bash "$classifier" \
    "$execution_file" "$review_file" > "$stdout_path" 2> "$stderr_path"
  if [ "$(cat "$stdout_path")" != "$expected_reason" ]; then
    echo "Expected $fixture_name to be classified as $expected_reason." >&2
    exit 1
  fi
  if [ -s "$stderr_path" ]; then
    echo "Classifier wrote diagnostics for $fixture_name." >&2
    exit 1
  fi
  if grep -Fq 'sensitive-raw-claude-output' "$stdout_path" "$stderr_path"; then
    echo "Classifier exposed raw Claude output for $fixture_name." >&2
    exit 1
  fi
  if [ "$expected_reason" != REVIEW_VALID ] && [ -e "$review_file" ]; then
    echo "Classifier left a review file for rejected $fixture_name." >&2
    exit 1
  fi
}

assert_execution_classification REVIEW_VALID valid-execution-classification \
  "$test_dir/valid-execution-with-review.json"
jq -e '.verdict == "approve" and .linked_issues_checked == ["#59"]' \
  "$test_dir/valid-execution-classification.review.json" > /dev/null

# A different TMPDIR must not prevent the classifier from atomically renaming
# the normalized hand-off into the caller's output directory.
mkdir "$test_dir/foreign-tmp"
TMPDIR="$test_dir/foreign-tmp" bash "$repo_root/.github/scripts/classify-claude-review-execution.sh" \
  "$test_dir/valid-execution-with-review.json" "$test_dir/cross-tmpdir.review.json" \
  > "$test_dir/cross-tmpdir.classifier.out" 2> "$test_dir/cross-tmpdir.classifier.err"
if [ "$(cat "$test_dir/cross-tmpdir.classifier.out")" != REVIEW_VALID ] \
  || [ -s "$test_dir/cross-tmpdir.classifier.err" ]; then
  echo 'Classifier did not safely hand off a review with a different TMPDIR.' >&2
  exit 1
fi
jq -e '.verdict == "approve" and .linked_issues_checked == ["#59"]' \
  "$test_dir/cross-tmpdir.review.json" > /dev/null

# Readable malformed execution containers are untrusted review failures, while
# missing, non-regular, and unreadable files are classifier entry failures.
: > "$test_dir/empty-execution.json"
assert_execution_classification REVIEW_JSON_INVALID empty-execution \
  "$test_dir/empty-execution.json"
printf '%s\n' '{}' > "$test_dir/non-array-execution.json"
assert_execution_classification REVIEW_JSON_INVALID non-array-execution \
  "$test_dir/non-array-execution.json"
printf '%s' '{' > "$test_dir/malformed-execution.json"
assert_execution_classification REVIEW_JSON_INVALID malformed-execution \
  "$test_dir/malformed-execution.json"

assert_classifier_entry_failure() {
  local fixture_name="${1:?fixture name is required}"
  local execution_file="${2-}"
  local review_file="$test_dir/$fixture_name.review.json"
  local stdout_path="$test_dir/$fixture_name.classifier.out"
  local stderr_path="$test_dir/$fixture_name.classifier.err"

  bash "$repo_root/.github/scripts/classify-claude-review-execution.sh" \
    "$execution_file" "$review_file" > "$stdout_path" 2> "$stderr_path"
  if [ "$(cat "$stdout_path")" != CLASSIFIER_INTERNAL_ERROR ] || [ -s "$stderr_path" ]; then
    echo "Expected $fixture_name to be a classifier entry failure." >&2
    exit 1
  fi
  if [ -e "$review_file" ]; then
    echo "Classifier left a review file for entry failure $fixture_name." >&2
    exit 1
  fi
}

assert_classifier_entry_failure missing-execution ''
mkdir "$test_dir/execution-directory"
assert_classifier_entry_failure non-regular-execution "$test_dir/execution-directory"

# Git Bash on Windows does not implement the POSIX mode checks used by these
# fixtures. Keep them enabled on the Linux Actions runner (unless running root).
posix_permissions=true
case "$(uname -s)" in MINGW*|MSYS*) posix_permissions=false ;; esac
if [ "$(id -u)" -eq 0 ] || [ "$posix_permissions" = false ]; then
  echo 'Skipping unreadable validator and execution fixtures: root or Windows cannot enforce chmod 000 read checks.' >&2
else
  unreadable_execution="$test_dir/unreadable-execution.json"
  cp "$test_dir/valid-execution-with-review.json" "$unreadable_execution"
  chmod 000 "$unreadable_execution"
  assert_classifier_entry_failure unreadable-execution "$unreadable_execution"
  chmod 600 "$unreadable_execution"
fi

# Trusted bootstrap scripts are written with `git show > file`, which does not
# preserve their executable bits. The classifier must invoke its validator via
# bash and retain its safe normalized review hand-off.
bootstrap_scripts="$test_dir/bootstrap-scripts"
mkdir "$bootstrap_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$bootstrap_scripts/"
cp "$repo_root/.github/scripts/validate-claude-review-output.sh" "$bootstrap_scripts/"
chmod 600 "$bootstrap_scripts/validate-claude-review-output.sh"
assert_execution_classification REVIEW_VALID non-executable-bootstrap-validator \
  "$test_dir/valid-execution-with-review.json" \
  "$bootstrap_scripts/classify-claude-review-execution.sh"
jq -e '.verdict == "approve" and .linked_issues_checked == ["#59"]' \
  "$test_dir/non-executable-bootstrap-validator.review.json" > /dev/null

normalized_output_validator_scripts="$test_dir/normalized-output-validator-scripts"
mkdir "$normalized_output_validator_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$normalized_output_validator_scripts/"
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' '{ \"normalization\": true }'" \
  > "$normalized_output_validator_scripts/validate-claude-review-output.sh"
chmod 600 "$normalized_output_validator_scripts/validate-claude-review-output.sh"
assert_execution_classification REVIEW_VALID normalized-validator-output \
  "$test_dir/valid-execution-with-review.json" \
  "$normalized_output_validator_scripts/classify-claude-review-execution.sh"
if [ "$(cat "$test_dir/normalized-validator-output.review.json")" != '{"normalization":true}' ]; then
  echo 'Classifier did not normalize the validated review output.' >&2
  exit 1
fi

missing_validator_scripts="$test_dir/missing-validator-scripts"
mkdir "$missing_validator_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$missing_validator_scripts/"
assert_execution_classification CLASSIFIER_INTERNAL_ERROR missing-validator \
  "$test_dir/valid-execution-with-review.json" \
  "$missing_validator_scripts/classify-claude-review-execution.sh"

empty_validator_scripts="$test_dir/empty-validator-scripts"
mkdir "$empty_validator_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$empty_validator_scripts/"
: > "$empty_validator_scripts/validate-claude-review-output.sh"
chmod 600 "$empty_validator_scripts/validate-claude-review-output.sh"
assert_execution_classification CLASSIFIER_INTERNAL_ERROR empty-validator \
  "$test_dir/valid-execution-with-review.json" \
  "$empty_validator_scripts/classify-claude-review-execution.sh"

unreadable_validator_scripts="$test_dir/unreadable-validator-scripts"
mkdir "$unreadable_validator_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$unreadable_validator_scripts/"
cp "$repo_root/.github/scripts/validate-claude-review-output.sh" "$unreadable_validator_scripts/"
chmod 000 "$unreadable_validator_scripts/validate-claude-review-output.sh"
if [ "$(id -u)" -ne 0 ] && [ "$posix_permissions" = true ]; then
  assert_execution_classification CLASSIFIER_INTERNAL_ERROR unreadable-validator \
    "$test_dir/valid-execution-with-review.json" \
    "$unreadable_validator_scripts/classify-claude-review-execution.sh"
fi
chmod 600 "$unreadable_validator_scripts/validate-claude-review-output.sh"

unknown_diagnostic_scripts="$test_dir/unknown-diagnostic-scripts"
mkdir "$unknown_diagnostic_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$unknown_diagnostic_scripts/"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" sensitive-raw-claude-output >&2' 'exit 1' \
  > "$unknown_diagnostic_scripts/validate-claude-review-output.sh"
chmod 600 "$unknown_diagnostic_scripts/validate-claude-review-output.sh"
assert_execution_classification CLASSIFIER_INTERNAL_ERROR unknown-validator-diagnostic \
  "$test_dir/valid-execution-with-review.json" \
  "$unknown_diagnostic_scripts/classify-claude-review-execution.sh"

empty_output_validator_scripts="$test_dir/empty-output-validator-scripts"
mkdir "$empty_output_validator_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$empty_output_validator_scripts/"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' \
  > "$empty_output_validator_scripts/validate-claude-review-output.sh"
chmod 600 "$empty_output_validator_scripts/validate-claude-review-output.sh"
assert_execution_classification CLASSIFIER_INTERNAL_ERROR empty-validator-output \
  "$test_dir/valid-execution-with-review.json" \
  "$empty_output_validator_scripts/classify-claude-review-execution.sh"

non_object_output_validator_scripts="$test_dir/non-object-output-validator-scripts"
mkdir "$non_object_output_validator_scripts"
cp "$repo_root/.github/scripts/classify-claude-review-execution.sh" "$non_object_output_validator_scripts/"
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' '[]'" \
  > "$non_object_output_validator_scripts/validate-claude-review-output.sh"
chmod 600 "$non_object_output_validator_scripts/validate-claude-review-output.sh"
assert_execution_classification CLASSIFIER_INTERNAL_ERROR non-object-validator-output \
  "$test_dir/valid-execution-with-review.json" \
  "$non_object_output_validator_scripts/classify-claude-review-execution.sh"

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
