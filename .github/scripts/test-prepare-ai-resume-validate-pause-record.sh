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
check_dormant_workflows() {
  local directory="$1" workflow rc
  local -a workflows
  if [ ! -d "$directory" ] || [ ! -r "$directory" ] || [ -L "$directory" ]; then
    echo "Production workflow directory is unavailable: $directory" >&2; return 1
  fi
  shopt -s nullglob
  workflows=("$directory"/*.yml "$directory"/*.yaml)
  if [ "${#workflows[@]}" -eq 0 ]; then
    echo "No production workflows found in $directory." >&2; return 1
  fi
  for workflow in "${workflows[@]}"; do
    if [ ! -f "$workflow" ] || [ ! -r "$workflow" ] || [ -L "$workflow" ]; then
      echo "Production workflow is not a readable regular file: $workflow" >&2
      return 1
    fi
    if grep -Eq 'prepare-ai-resume-validate-pause-record\.sh' "$workflow"; then
      rc=0
    else
      rc=$?
    fi
    case "$rc" in
      0) echo "Prepared record helper became reachable from $workflow." >&2; return 1 ;;
      1) ;;
      *) echo "Production workflow search failed for $workflow (exit $rc)." >&2; return 1 ;;
    esac
  done
}
check_dormant_workflows "$root/.github/workflows"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/empty-workflows" "$tmp/invalid-workflows"
if check_dormant_workflows "$tmp/empty-workflows" >/dev/null 2>&1; then exit 1; fi
ln -s "$root/.github/workflows" "$tmp/workflow-link"
if check_dormant_workflows "$tmp/workflow-link" >/dev/null 2>&1; then exit 1; fi
ln -s "$root/.github/workflows/ai-workflow-regression.yml" "$tmp/invalid-workflows/link.yml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
rm "$tmp/invalid-workflows/link.yml"
mkdir "$tmp/invalid-workflows/dir.yaml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
rmdir "$tmp/invalid-workflows/dir.yaml"
printf 'name: unreadable\n' > "$tmp/invalid-workflows/unreadable.yml"
chmod 000 "$tmp/invalid-workflows/unreadable.yml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
chmod 600 "$tmp/invalid-workflows/unreadable.yml"
printf 'run: prepare-ai-resume-validate-pause-record.sh\n' > "$tmp/invalid-workflows/reachable.yaml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
if (grep() { return 127; }; check_dormant_workflows "$root/.github/workflows" >/dev/null 2>&1); then
  echo 'Missing workflow search tool was accepted.' >&2; exit 1
fi
echo 'prepare-ai-resume-validate-pause-record fixture passed.'
