#!/usr/bin/env bash
set -euo pipefail

execution_file="${1-}"
review_output_file="${2-}"
validator="$(dirname "$0")/validate-claude-review-output.sh"

emit_reason() {
  printf '%s\n' "$1"
}

# The execution file is untrusted action output.  Inspect only event metadata
# here; the validator owns all parsing of the model's result string.
if [ -z "$execution_file" ] || ! jq -e 'type == "array"' "$execution_file" > /dev/null 2> /dev/null; then
  emit_reason REVIEW_JSON_INVALID
  exit 0
fi

event_has_subtype() {
  local subtype="${1:?subtype is required}"
  jq -e --arg subtype "$subtype" '
    any(.[]; type == "object" and .type == "result" and .subtype == $subtype)
  ' "$execution_file" > /dev/null 2> /dev/null
}

event_has_error_type() {
  local error_type="${1:?error type is required}"
  jq -e --arg error_type "$error_type" '
    any(.[]; type == "object" and .type == "error" and
      (.error | type == "object") and .error.type == $error_type)
  ' "$execution_file" > /dev/null 2> /dev/null
}

event_has_error_code() {
  local error_code="${1:?error code is required}"
  jq -e --arg error_code "$error_code" '
    any(.[]; type == "object" and .type == "error" and
      (.error | type == "object") and (.error.details | type == "object") and
      .error.details.error_code == $error_code)
  ' "$execution_file" > /dev/null 2> /dev/null
}

terminal_result_is_success() {
  jq -e '
    [.[] | select(type == "object" and .type == "result")] | last
    | type == "object" and .subtype == "success" and .is_error == false
  ' "$execution_file" > /dev/null 2> /dev/null
}

# A successful terminal result is authoritative, matching summarize-claude-
# usage.sh's last-result convention. It represents a completed retry and must
# be validated before prior error events are classified. When no terminal
# success exists, scan recorded result/error metadata for the most specific
# fixed failure reason; this includes error_max_budget_usd and structured error
# events, neither of which is allowed to inspect messages or HTTP status.
if terminal_result_is_success; then
  :
elif event_has_subtype error_max_budget_usd; then
  emit_reason RUN_BUDGET_LIMIT_REACHED
  exit 0
elif event_has_subtype enforced_spend_limit_reached \
    || event_has_error_type enforced_spend_limit_reached; then
  emit_reason ACCOUNT_SPEND_LIMIT_REACHED
  exit 0
elif event_has_error_code enforced_spend_limit_reached; then
  emit_reason ACCOUNT_SPEND_LIMIT_REACHED
  exit 0
elif event_has_subtype rate_limit_error || event_has_error_type rate_limit_error; then
  emit_reason TRANSIENT_RATE_LIMIT
  exit 0
elif jq -e '
  any(.[]; type == "object" and .type == "result" and .is_error == true)
' "$execution_file" > /dev/null 2> /dev/null; then
  emit_reason CLAUDE_EXECUTION_FAILED
  exit 0
fi

validation_diagnostic="$(mktemp)"
trap 'rm -f "$validation_diagnostic" "${temporary_output:-}" "${normalized_output:-}"' EXIT

if [ ! -f "$validator" ] || [ ! -r "$validator" ] || [ ! -s "$validator" ]; then
  emit_reason CLASSIFIER_INTERNAL_ERROR
  exit 0
fi

if [ -n "$review_output_file" ]; then
  output_dir="$(dirname "$review_output_file")"
  output_base="$(basename "$review_output_file")"
  temporary_output="$(mktemp "$output_dir/.${output_base}.XXXXXX")"
  chmod 600 "$temporary_output"
else
  temporary_output="$(mktemp)"
  chmod 600 "$temporary_output"
fi

normalized_output="$(mktemp)"
chmod 600 "$normalized_output"

# A validator exit status alone is not enough to establish a review. Keep its
# stdout private until it has been confirmed as exactly one JSON object, then
# reserialize it for the only hand-off path.
if bash "$validator" --execution-file "$execution_file" > "$temporary_output" 2> "$validation_diagnostic" \
  && [ -s "$temporary_output" ] \
  && jq -e -s 'length == 1 and (.[0] | type == "object")' "$temporary_output" > /dev/null 2> /dev/null \
  && jq -c . "$temporary_output" > "$normalized_output" 2> /dev/null; then
  if [ -n "$review_output_file" ]; then
    mv -f "$normalized_output" "$review_output_file"
  fi
  emit_reason REVIEW_VALID
  exit 0
fi

# The validator's stdout (the review) is never forwarded. Its diagnostic is a
# fixed code, which is translated to this classifier's fixed code below.
validation_reason="$(cat "$validation_diagnostic")"

case "$validation_reason" in
  missing_result) emit_reason REVIEW_RESULT_MISSING ;;
  ambiguous_result) emit_reason REVIEW_RESULT_AMBIGUOUS ;;
  invalid_json) emit_reason REVIEW_JSON_INVALID ;;
  schema_mismatch) emit_reason REVIEW_SCHEMA_MISMATCH ;;
  *) emit_reason CLASSIFIER_INTERNAL_ERROR ;;
esac
