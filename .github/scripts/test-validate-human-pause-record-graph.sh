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
child_2="$(record 102 101)"
grandchild_3="$(record 103 102)"
assert_valid single-root-linear-chain "$(graph "$grandchild_3" "$root_1" "$child_2")"

root_4="$(record 201 -)"
child_5="$(record 202 201)"
root_6="$(record 301 -)"
assert_valid multiple-roots-and-historical-chain "$(graph "$child_5" "$root_6" "$root_4")"
assert_valid empty-records '{"target":"issue:271","records":[]}'

assert_rejected duplicate-pause-id "$(graph "$root_1" "$(record 101 -)")"
assert_rejected broken-source "$(graph "$(record 401 999)")"
assert_rejected self-reference "$(graph "$(record 501 501)")"
assert_rejected cycle "$(graph "$(record 602 601)" "$(record 601 602)")"
assert_rejected conflicting-successors "$(graph "$(record 702 701)" "$(record 703 701)" "$(record 701 -)")"
assert_rejected multiple-json-values "$root_1
$root_4"
assert_rejected missing-records '{"target":"issue:271"}'
assert_rejected records-not-array '{"target":"issue:271","records":{}}'
assert_rejected non-string-target '{"target":271,"records":[]}'
assert_rejected non-string-pause-id '{"target":"issue:271","records":[{"pause_id":101,"record":{}}]}'
assert_rejected missing-record '{"target":"issue:271","records":[{"pause_id":"101"}]}'
assert_rejected record-not-object '{"target":"issue:271","records":[{"pause_id":"101","record":[]}]}'
assert_rejected non-string-source '{"target":"issue:271","records":[{"pause_id":"101","record":{"source_pause_id":102}}]}'

echo 'validate-human-pause-record-graph tests passed.'
