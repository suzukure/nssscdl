#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/reconcile-human-pause-resume-acceptance.sh"

entry() {
  local pause_id="${1:?pause ID is required}"
  local kind="${2:?kind is required}"
  local reason="${3:?reason is required}"
  local source_pause_id="${4:--}"

  if [ "$source_pause_id" = '-' ]; then
    jq -cn --arg pause_id "$pause_id" --arg kind "$kind" --arg reason "$reason" \
      '{pause_id: $pause_id, record: {kind: $kind, reason: $reason}}'
  else
    jq -cn --arg pause_id "$pause_id" --arg kind "$kind" --arg reason "$reason" \
      --arg source_pause_id "$source_pause_id" \
      '{pause_id: $pause_id, record: {kind: $kind, reason: $reason, source_pause_id: $source_pause_id}}'
  fi
}

chain() {
  local pre_resume="${1:?pre-resume JSON is required}"
  shift
  jq -cn --argjson records "[$(IFS=,; echo "$*")]" --argjson pre_resume "$pre_resume" \
    '{records: $records, pre_resume: $pre_resume}'
}

envelope() {
  jq -cn --argjson chains "[$(IFS=,; echo "$*")]" \
    '{target: "issue:278", chains: $chains}'
}

pre_resume() {
  jq -cn --arg pause_id "$1" --arg reason "$2" \
    '{status: "active", pause_id: $pause_id, reason: $reason}'
}

assert_reconciles() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"
  local expected="${3:?expected JSON is required}"
  local output

  output="$(printf '%s\n' "$input" | bash "$helper")"
  jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Expected $name to produce the expected effective state." >&2; exit 1; }
}

assert_rejected() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"

  if printf '%s\n' "$input" | bash "$helper" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

root_101="$(entry 101 pause requirements_change)"
active_chain="$(chain "$(pre_resume 101 requirements_change)" "$root_101")"
active_input="$(envelope "$active_chain")"
active_expected="$(jq -cn --argjson record "$root_101" \
  '{target: "issue:278", chains: [{records: [$record], pre_resume: {status: "active", pause_id: "101", reason: "requirements_change"}, effective: {status: "active", pause_id: "101", reason: "requirements_change"}}]}')"
assert_reconciles no-acceptance-remains-active "$active_input" "$active_expected"

replacement_102="$(entry 102 pause scope_decision 101)"
normalization_103="$(entry 103 pause-normalization state_inconsistent 102)"
replacement_normalization_chain="$(chain "$(pre_resume 103 state_inconsistent)" "$root_101" "$replacement_102" "$normalization_103")"
replacement_normalization_expected="$(jq -cn --argjson records "[$root_101,$replacement_102,$normalization_103]" \
  '{target: "issue:278", chains: [{records: $records, pre_resume: {status: "active", pause_id: "103", reason: "state_inconsistent"}, effective: {status: "active", pause_id: "103", reason: "state_inconsistent"}}]}')"
assert_reconciles no-acceptance-after-replacement-and-normalization "$(envelope "$replacement_normalization_chain")" "$replacement_normalization_expected"

accepted_103="$(entry 103 ai-resume-accepted scope_decision 102)"
consumed_chain="$(chain "$(pre_resume 102 scope_decision)" "$root_101" "$replacement_102" "$accepted_103")"
consumed_input="$(envelope "$consumed_chain")"
consumed_expected="$(jq -cn --argjson records "[$root_101,$replacement_102,$accepted_103]" \
  '{target: "issue:278", chains: [{records: $records, pre_resume: {status: "active", pause_id: "102", reason: "scope_decision"}, effective: {status: "consumed", pause_id: "102", reason: "scope_decision", accepted_record_id: "103"}}]}')"
assert_reconciles terminal-matching-acceptance-is-consumed "$consumed_input" "$consumed_expected"

second_root="$(entry 201 pause round_limit)"
multiple_input="$(envelope "$consumed_chain" "$(chain "$(pre_resume 201 round_limit)" "$second_root")")"
multiple_expected="$(jq -cn --argjson consumed "$(jq '.chains[0]' <<< "$consumed_expected")" --argjson root "$second_root" \
  '{target: "issue:278", chains: [$consumed, {records: [$root], pre_resume: {status: "active", pause_id: "201", reason: "round_limit"}, effective: {status: "active", pause_id: "201", reason: "round_limit"}}]}')"
assert_reconciles independent-chains "$multiple_input" "$multiple_expected"

assert_rejected duplicate-acceptance "$(envelope "$(chain "$(pre_resume 102 scope_decision)" "$root_101" "$replacement_102" "$accepted_103" "$(entry 104 ai-resume-accepted scope_decision 102)")")"
assert_rejected acceptance-not-terminal "$(envelope "$(chain "$(pre_resume 102 scope_decision)" "$root_101" "$replacement_102" "$accepted_103" "$(entry 104 pause validation_failed 103)")")"
assert_rejected source-mismatch "$(envelope "$(chain "$(pre_resume 102 scope_decision)" "$root_101" "$replacement_102" "$(entry 103 ai-resume-accepted scope_decision 101)")")"
assert_rejected reason-mismatch "$(envelope "$(chain "$(pre_resume 102 scope_decision)" "$root_101" "$replacement_102" "$(entry 103 ai-resume-accepted requirements_change 102)")")"
assert_rejected invalid-pre-resume '{"target":"issue:278","chains":[{"records":[],"pre_resume":{"status":"consumed","pause_id":"101","reason":"requirements_change"}}]}'
assert_rejected invalid-source-pause-id "$(envelope "$(chain "$(pre_resume 101 requirements_change)" "$(entry 101 pause requirements_change 01)")")"
assert_rejected trailing-newline-pause-id "$(envelope "$(chain "$(pre_resume 101 requirements_change)" "$root_101" "$(entry $'102\n' pause scope_decision 101)")")"
assert_rejected trailing-newline-source-pause-id "$(envelope "$(chain "$(pre_resume 101 requirements_change)" "$(entry 101 pause requirements_change $'101\n')")")"
assert_rejected trailing-newline-pre-resume-pause-id "$(envelope "$(chain "$(pre_resume $'101\n' requirements_change)" "$root_101")")"
assert_rejected empty-records-chain '{"target":"issue:278","chains":[{"records":[],"pre_resume":{"status":"active","pause_id":"101","reason":"requirements_change"}}]}'
assert_rejected pre-resume-id-not-in-records "$(envelope "$(chain "$(pre_resume 999 requirements_change)" "$root_101")")"
assert_rejected multiple-json-values "$active_input
$active_input"

echo 'reconcile-human-pause-resume-acceptance tests passed.'
