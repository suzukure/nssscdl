#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/validate-human-pause-record-graph.sh"

record() {
  local pause_id="${1:?pause ID is required}"
  local source_pause_id="${2:--}"

  if [ "$source_pause_id" = '-' ]; then
    jq -cn --arg pause_id "$pause_id" \
      '{pause_id: $pause_id, record: {kind: "pause"}}'
  else
    jq -cn --arg pause_id "$pause_id" --arg source_pause_id "$source_pause_id" \
      '{pause_id: $pause_id, record: {kind: "pause", source_pause_id: $source_pause_id}}'
  fi
}

graph() {
  jq -cn --argjson records "[$(IFS=,; echo "$*")]" \
    '{target: "issue:271", records: $records}'
}

assert_valid() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"
  local output

  output="$(printf '%s\n' "$input" | bash "$helper")"
  jq -e --argjson expected "$input" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Expected $name to preserve the validated graph." >&2; exit 1; }
}

assert_rejected() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"

  if printf '%s\n' "$input" | bash "$helper" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

# API/comment enumeration order is deliberately shuffled in each valid case.
root_1="$(record 101 -)"
replacement_2="$(record 102 101)"
normalization_3="$(record 103 102)"
assert_valid single-chain "$(graph "$normalization_3" "$root_1" "$replacement_2")"

root_4="$(record 201 -)"
replacement_5="$(record 202 201)"
root_6="$(record 301 -)"
assert_valid multiple-independent-chains "$(graph "$replacement_5" "$root_6" "$root_4")"

assert_rejected duplicate-pause-id "$(graph "$root_1" "$(record 101 -)")"
assert_rejected broken-source "$(graph "$(record 401 999)")"
assert_rejected self-reference "$(graph "$(record 501 501)")"
assert_rejected cycle "$(graph "$(record 602 601)" "$(record 601 602)")"
assert_rejected conflicting-successors "$(graph "$(record 702 701)" "$(record 703 701)" "$(record 701 -)")"
assert_rejected multiple-json-values "$root_1
$root_4"

echo 'validate-human-pause-record-graph tests passed.'
