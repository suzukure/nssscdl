#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/human-pause-record.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

pause_record='{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","paused_head":"0123456789abcdef0123456789abcdef01234567","payload":{"detail":"human decision required"}}'
replacement_pause_record='{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"issue:220","source_pause_id":"12345","payload":{"detail":"replacement pause"}}'
resume_record='{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220","source_pause_id":"12345","payload":{"accepted_by":"trusted boundary"}}'
normalization_record='{"version":1,"kind":"pause-normalization","reason":"state_inconsistent","target":"issue:220","source_pause_id":"12345","payload":{"normalization":"superseded"}}'
pr_target_record='{"version":1,"kind":"pause","reason":"requirements_change","target":"pr:233"}'

assert_round_trip() {
  local name="${1:?name is required}"
  local record="${2:?record is required}"
  local created="$test_dir/$name.md"
  local expected actual

  bash "$helper" create "$record" > "$created"
  expected="$(jq -cS . <<< "$record")"
  actual="$(bash "$helper" parse "$created")"
  [ "$actual" = "$expected" ]
}

assert_rejected_record() {
  local name="${1:?name is required}"
  local record="${2:?record is required}"

  if bash "$helper" validate "$record" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

assert_rejected_block() {
  local name="${1:?name is required}"
  local content="${2:?content is required}"
  local record_file="$test_dir/$name.md"

  printf '%s\n' "$content" > "$record_file"
  if bash "$helper" parse "$record_file" > /dev/null 2>&1; then
    echo "Expected $name block to be rejected." >&2
    exit 1
  fi
}

# Each lifecycle record is generated and reparsed independently.  In
# particular, a trusted resume acceptance is not a normalization record.
assert_round_trip pause "$pause_record"
assert_round_trip replacement-pause "$replacement_pause_record"
assert_round_trip resume "$resume_record"
assert_round_trip normalization "$normalization_record"
assert_round_trip pr-target "$pr_target_record"

# Read the vocabulary from the schema contract, rather than maintaining a test list.
reasons="$(bash "$helper" reasons)"
jq -e 'type == "array" and length > 0 and (unique | length) == length' \
  <<< "$reasons" > /dev/null
while IFS= read -r reason; do
  bash "$helper" validate \
    "{\"version\":1,\"kind\":\"pause\",\"reason\":\"$reason\",\"target\":\"issue:220\"}"
done < <(jq -r '.[]' <<< "$reasons")

# Required fields, optional fields, enums, and types all fail closed.
assert_rejected_record malformed-json '{'
assert_rejected_record unknown-version '{"version":2,"kind":"pause","reason":"requirements_change","target":"issue:220"}'
assert_rejected_record unknown-kind '{"version":1,"kind":"unknown","reason":"requirements_change","target":"issue:220"}'
assert_rejected_record unknown-reason '{"version":1,"kind":"pause","reason":"unknown","target":"issue:220"}'
assert_rejected_record missing-target '{"version":1,"kind":"pause","reason":"requirements_change"}'
assert_rejected_record target-wrong-type '{"version":1,"kind":"pause","reason":"requirements_change","target":220}'
assert_rejected_record target-zero '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:0"}'
assert_rejected_record target-leading-zero '{"version":1,"kind":"pause","reason":"requirements_change","target":"pr:0233"}'
assert_rejected_record target-negative '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:-220"}'
assert_rejected_record target-empty-number '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:"}'
assert_rejected_record target-unknown-prefix '{"version":1,"kind":"pause","reason":"requirements_change","target":"comment:220"}'
assert_rejected_record target-free-text '{"version":1,"kind":"pause","reason":"requirements_change","target":"Issue 220 awaiting decision"}'
assert_rejected_record target-trailing-newline '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220\n"}'
assert_rejected_record head-wrong-type '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","paused_head":220}'
assert_rejected_record head-trailing-newline '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","paused_head":"0123456789abcdef0123456789abcdef01234567\n"}'
assert_rejected_record head-too-short '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","paused_head":"0123456789abcdef0123456789abcdef0123456"}'
assert_rejected_record head-too-long '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","paused_head":"0123456789abcdef0123456789abcdef012345678"}'
assert_rejected_record head-uppercase '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","paused_head":"0123456789ABCDEF0123456789abcdef01234567"}'
assert_rejected_record payload-wrong-type '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","payload":[]}'
assert_rejected_record replacement-source-id-empty '{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"issue:220","source_pause_id":""}'
assert_rejected_record replacement-source-id-zero '{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"issue:220","source_pause_id":"0"}'
assert_rejected_record replacement-source-id-leading-zero '{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"issue:220","source_pause_id":"012345"}'
assert_rejected_record replacement-source-id-negative '{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"issue:220","source_pause_id":"-12345"}'
assert_rejected_record replacement-source-id-free-text '{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"issue:220","source_pause_id":"previous pause"}'
assert_rejected_record replacement-source-id-trailing-newline '{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"issue:220","source_pause_id":"12345\n"}'
assert_rejected_record resume-missing-source-id '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220"}'
assert_rejected_record normalization-missing-source-id '{"version":1,"kind":"pause-normalization","reason":"state_inconsistent","target":"issue:220"}'
assert_rejected_record source-id-empty '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220","source_pause_id":""}'
assert_rejected_record source-id-free-text '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220","source_pause_id":"previous pause"}'
assert_rejected_record source-id-zero '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220","source_pause_id":"0"}'
assert_rejected_record source-id-negative '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220","source_pause_id":"-12345"}'
assert_rejected_record source-id-leading-zero '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220","source_pause_id":"012345"}'
assert_rejected_record source-id-decimal '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"issue:220","source_pause_id":"12.5"}'
assert_rejected_record unknown-top-level-field '{"version":1,"kind":"pause","reason":"requirements_change","target":"issue:220","free_text":"do not use this"}'

assert_rejected_block missing-end "<!-- ai-human-pause-record:start -->
$pause_record"
assert_rejected_block two-records "<!-- ai-human-pause-record:start -->
$pause_record
<!-- ai-human-pause-record:end -->
<!-- ai-human-pause-record:start -->
$resume_record
<!-- ai-human-pause-record:end -->"
assert_rejected_block invalid-then-valid-json "<!-- ai-human-pause-record:start -->
{\"version\":2}
$pause_record
<!-- ai-human-pause-record:end -->"
assert_rejected_block valid-then-invalid-json "<!-- ai-human-pause-record:start -->
$pause_record
{\"version\":2}
<!-- ai-human-pause-record:end -->"
assert_rejected_block two-valid-json "<!-- ai-human-pause-record:start -->
$pause_record
$pause_record
<!-- ai-human-pause-record:end -->"

echo 'human-pause-record tests passed.'
