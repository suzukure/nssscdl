#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$script_dir/classify-claude-human-escalation.sh"

assert_classification() {
  local name="$1" input="$2" expected="$3" actual
  actual="$(printf '%s' "$input" | bash "$helper")"
  if [ "$actual" != "$expected" ]; then
    printf 'Unexpected classification for %s: %s\n' "$name" "$actual" >&2
    exit 1
  fi
}

none='{"result":"none"}'
requirements='{"result":"pause","reason":"requirements_change"}'
human='{"result":"pause","reason":"explicit_human_escalation"}'
inconsistent='{"result":"state_inconsistent"}'

assert_classification no-marker 'Review complete.' "$none"
assert_classification requirements '[REQUIREMENTS_CHANGE_REQUIRED]' "$requirements"
assert_classification human '[HUMAN_ESCALATION_RECOMMENDED]' "$human"
assert_classification both $'[REQUIREMENTS_CHANGE_REQUIRED]\n[HUMAN_ESCALATION_RECOMMENDED]' "$inconsistent"
assert_classification crlf $'Review complete.\r\n[REQUIREMENTS_CHANGE_REQUIRED]\r\n' "$requirements"
assert_classification leading-space ' [REQUIREMENTS_CHANGE_REQUIRED]' "$none"
assert_classification trailing-space '[HUMAN_ESCALATION_RECOMMENDED] ' "$none"
assert_classification prose 'Use [REQUIREMENTS_CHANGE_REQUIRED] when needed.' "$none"
assert_classification duplicate $'[HUMAN_ESCALATION_RECOMMENDED]\n[HUMAN_ESCALATION_RECOMMENDED]' "$human"
assert_classification wrapper 'SUMMARY| [REQUIREMENTS_CHANGE_REQUIRED]' "$none"

echo 'classify-claude-human-escalation tests passed.'
