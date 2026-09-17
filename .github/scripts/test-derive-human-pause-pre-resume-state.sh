#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/derive-human-pause-pre-resume-state.sh"

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

envelope() {
  jq -cn --argjson chains "[$(IFS=,; echo "$*")]" \
    '{target: "issue:277", chains: $chains}'
}

chain() {
  jq -cn --argjson records "[$(IFS=,; echo "$*")]" '{records: $records}'
}

assert_derives() {
  local test_name="${1:?name is required}"
  local input="${2:?input is required}"
  local expected="${3:?expected JSON is required}"
  local output

  output="$(printf '%s\n' "$input" | bash "$helper")"
  jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Expected $test_name to derive the expected pre-resume state." >&2; exit 1; }
}

assert_rejected() {
  local test_name="${1:?name is required}"
  local input="${2:?input is required}"

  if printf '%s\n' "$input" | bash "$helper" > /dev/null 2>&1; then
    echo "Expected $test_name to be rejected." >&2
    exit 1
  fi
}

root_101="$(entry 101 pause requirements_change)"
root_only="$(envelope "$(chain "$root_101")")"
root_only_expected="$(jq -cn --argjson record "$root_101" \
  '{target: "issue:277", chains: [{records: [$record], pre_resume: {status: "active", pause_id: "101", reason: "requirements_change"}}]}')"
assert_derives root-pause "$root_only" "$root_only_expected"

replacement_102="$(entry 102 pause scope_decision 101)"
normalization_103="$(entry 103 pause-normalization state_inconsistent 102)"
# Legacy prose must not influence the reason derived from the source chain.
normalization_103="$(jq -c '.record.from_reason = "requirements_change"' <<< "$normalization_103")"
accepted_104="$(entry 104 ai-resume-accepted requirements_change 103)"
post_acceptance_105="$(entry 105 pause validation_failed 104)"
transition_chain="$(chain "$root_101" "$replacement_102" "$normalization_103" "$accepted_104" "$post_acceptance_105")"
transition_input="$(envelope "$transition_chain")"
transition_expected="$(jq -cn --argjson records "[$root_101,$replacement_102,$normalization_103,$accepted_104,$post_acceptance_105]" \
  '{target: "issue:277", chains: [{records: $records, pre_resume: {status: "active", pause_id: "103", reason: "state_inconsistent"}}]}')"
assert_derives replacement-normalization-and-acceptance-prefix "$transition_input" "$transition_expected"

second_root="$(entry 201 pause round_limit)"
multiple_input="$(envelope "$(chain "$root_101")" "$(chain "$second_root")")"
multiple_expected="$(jq -cn --argjson first "$root_101" --argjson second "$second_root" \
  '{target: "issue:277", chains: [
    {records: [$first], pre_resume: {status: "active", pause_id: "101", reason: "requirements_change"}},
    {records: [$second], pre_resume: {status: "active", pause_id: "201", reason: "round_limit"}}
  ]}')"
assert_derives independent-chains "$multiple_input" "$multiple_expected"

assert_derives empty-chain-set '{"target":"issue:277","chains":[]}' \
  '{"target":"issue:277","chains":[]}'
assert_rejected empty-chain '{"target":"issue:277","chains":[{"records":[]}]}'
assert_rejected invalid-source-pause-id "$(envelope "$(chain "$root_101" "$(entry 302 ai-resume-accepted scope_decision 01)")")"
assert_rejected trailing-newline-pause-id "$(envelope "$(chain "$(entry $'301\n' pause requirements_change)")")"
assert_rejected trailing-newline-source-pause-id "$(envelope "$(chain "$root_101" "$(entry 302 ai-resume-accepted scope_decision $'101\n')")")"
assert_rejected non-root-first "$(envelope "$(chain "$(entry 301 pause-normalization state_inconsistent 300)")")"
assert_rejected transition-source-not-effective "$(envelope "$(chain "$root_101" "$(entry 302 pause scope_decision 999)")")"
assert_rejected unknown-prefix-kind "$(envelope "$(chain "$root_101" "$(entry 303 other scope_decision 101)")")"
assert_rejected multiple-json-values "$root_only
$root_only"

echo 'derive-human-pause-pre-resume-state tests passed.'
