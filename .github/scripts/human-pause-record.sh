#!/usr/bin/env bash
set -euo pipefail

# Creates and validates the version-1 machine-readable record embedded in a
# GitHub Issue or pull-request comment.  Callers must establish comment
# provenance separately; this primitive deliberately makes no trust decision.
#
# Block format:
#   <!-- ai-human-pause-record:start -->
#   {"kind":"pause",...}
#   <!-- ai-human-pause-record:end -->
#
# Commands:
#   create <record-json>  validate and emit one record block
#   parse <file>          extract exactly one block, validate it, emit JSON
#   validate <record-json> validate one JSON record without emitting it

readonly block_start='<!-- ai-human-pause-record:start -->'
readonly block_end='<!-- ai-human-pause-record:end -->'

usage() {
  echo "Usage: $0 {create|parse|validate} argument" >&2
  exit 64
}

fail_closed() {
  echo "human-pause-record: $1" >&2
  exit 1
}

validate_record() {
  local record_json="${1:?record JSON is required}"

  # Keep reason-specific data in payload so schema evolution cannot turn an
  # unknown top-level field into workflow state.  A pause receives its ID from
  # the trusted comment boundary later; records that refer to a pause require
  # that ID here.
  jq -e '
    def nonempty_string:
      type == "string" and length > 0;
    def known_reason:
      IN(
        "requirements_change",
        "scope_decision",
        "diff_guard_exceeded",
        "diff_guard_error",
        "non_blocking_decision",
        "round_limit",
        "validation_failed",
        "validation_timeout",
        "claude_execution_failed",
        "developer_execution_failed",
        "explicit_human_escalation",
        "review_disagreement_decision",
        "resume_transition_failed",
        "state_inconsistent"
      );
    type == "object"
    and ([keys_unsorted[] | IN(
      "version", "kind", "reason", "target", "paused_head",
      "source_pause_id", "payload"
    )] | all)
    and .version == 1
    and (.kind | IN("pause", "ai-resume-accepted", "pause-normalization"))
    and (.reason | type == "string" and known_reason)
    and (.target | nonempty_string)
    and ((has("paused_head") | not)
      or (.paused_head | type == "string" and test("^[0-9a-f]{40}$")))
    and ((has("payload") | not) or (.payload | type == "object"))
    and (if .kind == "pause" then
      has("source_pause_id") | not
    else
      (.source_pause_id | nonempty_string)
    end)
  ' > /dev/null <<< "$record_json" || fail_closed 'record failed schema validation'
}

create_record() {
  local record_json="${1:?record JSON is required}"
  validate_record "$record_json"
  printf '%s\n' "$block_start"
  jq -cS . <<< "$record_json"
  printf '%s\n' "$block_end"
}

parse_record() {
  local record_file="${1:?record file is required}"
  local extracted

  [ -f "$record_file" ] || fail_closed 'record file does not exist'
  if ! extracted="$(awk -v start="$block_start" -v end="$block_end" '
    {
      line = $0
      sub(/\r$/, "", line)
      if (line == start) {
        if (inside) invalid = 1
        inside = 1
        starts++
        next
      }
      if (line == end) {
        if (!inside) invalid = 1
        inside = 0
        ends++
        next
      }
      if (inside) print
    }
    END {
      if (invalid || inside || starts != 1 || ends != 1) exit 1
    }
  ' "$record_file")"; then
    fail_closed 'record block is malformed or ambiguous'
  fi
  [ -n "$extracted" ] || fail_closed 'record block is empty'
  validate_record "$extracted"
  jq -cS . <<< "$extracted"
}

[ "$#" -eq 2 ] || usage
case "$1" in
  create)
    create_record "$2"
    ;;
  parse)
    parse_record "$2"
    ;;
  validate)
    validate_record "$2"
    ;;
  *)
    usage
    ;;
esac
