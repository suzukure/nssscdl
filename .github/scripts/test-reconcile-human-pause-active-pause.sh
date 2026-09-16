#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/reconcile-human-pause-active-pause.sh"

chain() {
  local status="${1:?status is required}"
  local pause_id="${2:?pause ID is required}"
  local reason="${3:?reason is required}"

  jq -cn --arg status "$status" --arg pause_id "$pause_id" --arg reason "$reason" \
    '{records: [], pre_resume: {}, effective: {status: $status, pause_id: $pause_id, reason: $reason}}'
}

envelope() {
  jq -cn --argjson chains "[$(IFS=,; echo "$*")]" \
    '{target: "issue:273", chains: $chains}'
}

assert_result() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"
  local expected="${3:?expected JSON is required}"
  local output

  output="$(printf '%s\n' "$input" | bash "$helper")"
  jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Expected $name to produce the expected active-pause result." >&2; exit 1; }
}

assert_rejected() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"

  if printf '%s\n' "$input" | bash "$helper" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

consumed_101="$(chain consumed 101 requirements_change)"
consumed_201="$(chain consumed 201 scope_decision)"
active_301="$(chain active 301 validation_failed)"
active_401="$(chain active 401 round_limit)"

assert_result empty-chain-set '{"target":"issue:273","chains":[]}' \
  '{"target":"issue:273","result":"no_active_pause"}'
assert_result multiple-historical-consumed-chains "$(envelope "$consumed_101" "$consumed_201")" \
  '{"target":"issue:273","result":"no_active_pause"}'
assert_result one-active-with-historical-chain "$(envelope "$consumed_101" "$active_301" "$consumed_201")" \
  '{"target":"issue:273","result":"active","active_pause":{"pause_id":"301","reason":"validation_failed"}}'
assert_result chain-order-does-not-affect-result "$(envelope "$consumed_201" "$active_301" "$consumed_101")" \
  '{"target":"issue:273","result":"active","active_pause":{"pause_id":"301","reason":"validation_failed"}}'
assert_result multiple-active-is-inconsistent "$(envelope "$active_301" "$active_401")" \
  '{"target":"issue:273","result":"state_inconsistent"}'

assert_rejected malformed-envelope '[]'
assert_rejected non-string-target '{"target":273,"chains":[]}'
assert_rejected non-array-chains '{"target":"issue:273","chains":{}}'
assert_rejected non-object-chain '{"target":"issue:273","chains":[null]}'
assert_rejected missing-effective '{"target":"issue:273","chains":[{}]}'
assert_rejected non-object-effective '{"target":"issue:273","chains":[{"effective":null}]}'
assert_rejected unknown-effective-status '{"target":"issue:273","chains":[{"effective":{"status":"superseded","pause_id":"101","reason":"requirements_change"}}]}'
assert_rejected malformed-effective-fields '{"target":"issue:273","chains":[{"effective":{"status":"active","pause_id":101,"reason":null}}]}'
assert_rejected invalid-active-pause-id "$(envelope "$(chain active 01 requirements_change)")"
assert_rejected invalid-consumed-pause-id "$(envelope "$(chain consumed 01 requirements_change)")"
assert_rejected trailing-newline-active-pause-id "$(envelope "$(chain active $'301\n' validation_failed)")"
assert_rejected trailing-newline-consumed-pause-id "$(envelope "$(chain consumed $'101\n' requirements_change)")"
assert_rejected multiple-json-values '{"target":"issue:273","chains":[]}
{"target":"issue:273","chains":[]}'

echo 'reconcile-human-pause-active-pause tests passed.'
