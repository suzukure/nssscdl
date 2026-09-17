#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/decompose-human-pause-record-graph.sh"

record() {
  local pause_id="${1:?pause ID is required}"
  local source_pause_id="${2:--}"
  local kind="${3:-pause}"

  if [ "$source_pause_id" = '-' ]; then
    jq -cn --arg pause_id "$pause_id" --arg kind "$kind" \
      '{pause_id: $pause_id, record: {kind: $kind, payload: {kept: $pause_id}}}'
  else
    jq -cn --arg pause_id "$pause_id" --arg source_pause_id "$source_pause_id" --arg kind "$kind" \
      '{pause_id: $pause_id, record: {kind: $kind, source_pause_id: $source_pause_id, payload: {kept: $pause_id}}}'
  fi
}

graph() {
  jq -cn --argjson records "[$(IFS=,; echo "$*")]" \
    '{target: "issue:281", records: $records}'
}

assert_decomposes() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"
  local expected="${3:?expected JSON is required}"
  local output

  output="$(printf '%s\n' "$input" | bash "$helper")"
  jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Expected $name to produce the expected chains." >&2; exit 1; }
  jq -e --argjson input "$input" '
    [.chains[].records[]] as $records
    | ($records | length) == ($input.records | length)
    and ([$records[].pause_id] | sort) == ([$input.records[].pause_id] | sort)
  ' <<< "$output" > /dev/null \
    || { echo "Expected $name to cover every record exactly once." >&2; exit 1; }
}

assert_rejected() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"

  if printf '%s\n' "$input" | bash "$helper" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

root_10="$(record 10 -)"
child_11="$(record 11 10 pause-normalization)"
terminal_12="$(record 12 11 ai-resume-accepted)"
single_input="$(graph "$terminal_12" "$root_10" "$child_11")"
single_expected="$(jq -cn --argjson records "[$root_10,$child_11,$terminal_12]" \
  '{target: "issue:281", chains: [{records: $records}]}')"
assert_decomposes single-root-linear-chain "$single_input" "$single_expected"

root_2="$(record 2 -)"
child_3="$(record 3 2)"
root_100="$(record 100 -)"
multiple_input="$(graph "$child_3" "$root_100" "$root_2")"
multiple_expected="$(jq -cn --argjson first "[$root_2,$child_3]" --argjson second "[$root_100]" \
  '{target: "issue:281", chains: [{records: $first}, {records: $second}]}')"
assert_decomposes multiple-independent-chains "$multiple_input" "$multiple_expected"
assert_decomposes empty-records '{"target":"issue:281","records":[]}' \
  '{"target":"issue:281","chains":[]}'

# Shuffling does not change either the chain order or the causal record order.
assert_decomposes shuffled-multiple-chains "$(graph "$root_2" "$child_3" "$root_100")" "$multiple_expected"

assert_rejected malformed-envelope '{"target":"issue:281","records":[{"pause_id":"1"}]}'
assert_rejected non-decimal-pause-id '{"target":"issue:281","records":[{"pause_id":"a","record":{}}]}'
assert_rejected invalid-source-pause-id "$(graph "$(record 20 '01')")"
assert_rejected trailing-newline-pause-id "$(graph "$(record $'20\n' -)")"
assert_rejected trailing-newline-source-pause-id "$(graph "$(record 21 $'20\n')")"
assert_rejected broken-source "$(graph "$(record 21 999)")"
assert_rejected cycle "$(graph "$(record 31 32)" "$(record 32 31)")"
assert_rejected fork "$(graph "$(record 41 -)" "$(record 42 41)" "$(record 43 41)")"
assert_rejected duplicate-pause-id "$(graph "$(record 51 -)" "$(record 51 -)")"
assert_rejected multiple-json-values "$root_2
$root_100"

echo 'decompose-human-pause-record-graph tests passed.'
