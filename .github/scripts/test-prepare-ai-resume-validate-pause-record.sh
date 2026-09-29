#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$root/.github/scripts/prepare-ai-resume-validate-pause-record.sh"
validator="$root/.github/scripts/human-pause-record.sh"
head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
assert_record() {
  local action="$1" expected="$2" actual
  actual="$(printf '%s\n' "$action" | bash "$helper" 37)"
  [ "$(jq -cS . <<< "$actual")" = "$(jq -cS . <<< "$expected")" ]
  bash "$validator" validate "$actual"
}
assert_rejected() {
  if printf '%s\n' "$1" | bash "$helper" 37 >/dev/null 2>&1; then
    echo "Malformed pause action accepted: $1" >&2; exit 1
  fi
}
assert_record \
  '{"action":"create_or_reconcile_replacement_pause","source_pause_id":"201","reason":"resume_transition_failed","failed_action":"validate"}' \
  '{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"pr:37","source_pause_id":"201","payload":{"failed_action":"validate"}}'
for reason in validation_failed validation_timeout round_limit; do
  action="$(jq -cn --arg reason "$reason" --arg head "$head" \
    '{action:"create_or_reconcile_validation_pause",accepted_record_id:"201",paused_head:$head,reason:$reason}')"
  expected="$(jq -cn --arg reason "$reason" --arg head "$head" \
    '{version:1,kind:"pause",reason:$reason,target:"pr:37",paused_head:$head,payload:{accepted_record_id:"201"}}')"
  assert_record "$action" "$expected"
done
assert_rejected '{}'
assert_rejected '{"action":"create_or_reconcile_validation_pause_extra","accepted_record_id":"201","paused_head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reason":"round_limit"}'
assert_rejected '{"action":"create_or_reconcile_validation_pause","accepted_record_id":"201","paused_head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reason":"round_limit","source_pause_id":"201"}'
assert_rejected '{"action":"create_or_reconcile_validation_pause","accepted_record_id":"0","paused_head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reason":"round_limit"}'
assert_rejected '{"action":"create_or_reconcile_validation_pause","accepted_record_id":"201","paused_head":"bad","reason":"round_limit"}'
assert_rejected '{"action":"create_or_reconcile_replacement_pause","source_pause_id":"201","reason":"resume_transition_failed","failed_action":"review"}'
assert_rejected '{"action":"create_or_reconcile_replacement_pause","source_pause_id":"201","reason":"resume_transition_failed","failed_action":"validate"}
{"action":"create_or_reconcile_replacement_pause","source_pause_id":"201","reason":"resume_transition_failed","failed_action":"validate"}'
if printf '%s\n' '{"action":"create_or_reconcile_validation_pause","accepted_record_id":"201","paused_head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reason":"round_limit"}' |
  bash "$helper" 0 >/dev/null 2>&1; then exit 1; fi
if rg -l 'prepare-ai-resume-validate-pause-record\.sh' "$root/.github/workflows" >/dev/null; then
  echo 'Prepared record helper became reachable from a production workflow.' >&2; exit 1
fi
echo 'prepare-ai-resume-validate-pause-record fixture passed.'
