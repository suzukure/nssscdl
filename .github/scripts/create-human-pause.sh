#!/usr/bin/env bash
set -euo pipefail

# create REPO ISSUE PR APP_ID REASON DETAIL: create a root pause if none is active.
# inspect REPO ISSUE PR APP_ID PAUSE_ID: reconcile an existing pause without notifying.
# ISSUE or PR may be '-', but at least one must be a positive decimal number.
mode="${1:-}"
repo="${2:-}"
issue="${3:-}"
pr="${4:-}"
app_id="${5:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail_closed() { echo "create-human-pause: $1" >&2; exit 1; }
positive() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail_closed 'invalid repository'
positive "$app_id" || fail_closed 'invalid trusted App ID'
if [ "$issue" != '-' ]; then positive "$issue" || fail_closed 'invalid Issue number'; fi
if [ "$pr" != '-' ]; then positive "$pr" || fail_closed 'invalid PR number'; fi
[ "$issue" != '-' ] || [ "$pr" != '-' ] || fail_closed 'Issue or PR is required'

if [ "$pr" = '-' ]; then
  target="issue:$issue"
  conversation="$issue"
  url="https://github.com/$repo/issues/$issue"
else
  target="pr:$pr"
  conversation="$pr"
  url="https://github.com/$repo/pull/$pr"
fi

reconcile() {
  bash "$script_dir/list-human-pause-records.sh" "$repo" "$conversation" "$pr" "$app_id" \
    | bash "$script_dir/validate-human-pause-record-graph.sh" \
    | bash "$script_dir/decompose-human-pause-record-graph.sh" \
    | bash "$script_dir/derive-human-pause-pre-resume-state.sh" \
    | bash "$script_dir/reconcile-human-pause-resume-acceptance.sh"
}

if [ "$mode" = create ]; then
  [ "$#" -eq 7 ] || fail_closed 'create requires reason and decision detail'
  reason="$6"
  detail="$7"
  [ -n "$detail" ] || fail_closed 'decision detail is empty'
  record="$(jq -cn --arg reason "$reason" --arg target "$target" --arg detail "$detail" \
    '{version:1, kind:"pause", reason:$reason, target:$target, payload:{detail:$detail}}')"
  body="$(bash "$script_dir/human-pause-record.sh" create "$record")" \
    || fail_closed 'invalid pause record'
elif [ "$mode" = inspect ]; then
  [ "$#" -eq 6 ] || fail_closed 'inspect requires a pause ID'
  positive "$6" || fail_closed 'invalid pause ID'
  expected_id="$6"
else
  fail_closed 'expected create or inspect'
fi

history="$(reconcile)" || fail_closed 'could not reconcile trusted pause history'
active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$history")" \
  || fail_closed 'could not reconcile active pause'
result="$(jq -r '.result' <<< "$active")"
[ "$result" != state_inconsistent ] || fail_closed 'multiple active pauses'

if [ "$mode" = inspect ]; then
  if [ "$result" = active ] && [ "$(jq -r '.active_pause.pause_id' <<< "$active")" = "$expected_id" ]; then
    bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
      || fail_closed 'could not synchronize pause labels'
    jq -cn --arg pause_id "$expected_id" '{result:"already_active", pause_id:$pause_id}'
  elif jq -e --arg id "$expected_id" \
    'any(.chains[]; .effective.status == "consumed" and .effective.pause_id == $id)' \
    <<< "$history" > /dev/null; then
    jq -cn --arg pause_id "$expected_id" '{result:"already_consumed", pause_id:$pause_id}'
  else
    fail_closed 'pause ID is not the active or consumed pause'
  fi
  exit 0
fi

if [ "$result" = active ]; then
  [ "$(jq -r '.active_pause.reason' <<< "$active")" = "$reason" ] \
    || fail_closed 'an active pause has a different reason'
  pause_id="$(jq -r '.active_pause.pause_id' <<< "$active")"
  bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
    || fail_closed 'could not synchronize pause labels'
  jq -cn --arg pause_id "$pause_id" '{result:"already_active", pause_id:$pause_id}'
  exit 0
fi
[ "$result" = no_active_pause ] || fail_closed 'unknown reconciliation result'

# The returned REST comment ID is the pause identity. A retry sees this record
# and repairs labels without sending a second notification.
created="$(gh api -X POST "/repos/$repo/issues/$conversation/comments" -f "body=$body")" \
  || fail_closed 'could not create pause record'
pause_id="$(jq -er '.id | if type == "number" and . >= 1 and floor == . then tostring else error("invalid comment ID") end' \
  <<< "$created")" || fail_closed 'comment response has no valid REST ID'
bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
  || fail_closed 'could not synchronize pause labels'

# Observe the exact new record and its active state through the trusted
# reconciliation boundary before notifying. A concurrent conflicting pause or
# delayed visibility leaves the GitHub pause in place without Discord output.
confirmed="$(reconcile)" || fail_closed 'could not verify new pause state'
jq -e --arg id "$pause_id" --argjson record "$record" \
  'any(.chains[].records[]; .pause_id == $id and .record == $record)' \
  <<< "$confirmed" > /dev/null || fail_closed 'new pause record is not trusted or visible'
confirmed_active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" \
  <<< "$confirmed")" || fail_closed 'could not verify active pause'
if [ "$(jq -r '.result' <<< "$confirmed_active")" = state_inconsistent ]; then
  message="$(bash "$script_dir/format-human-pause-notification.sh" \
    state_inconsistent "$target" '同時に複数の停止記録が作成されました。Issue・PRの記録を確認してください。' "$url" "$pause_id")" \
    || fail_closed 'could not format inconsistent-state notification'
  if ! bash "$script_dir/notify-human.sh" "$message"; then
    echo 'create-human-pause: Discord notification failed; GitHub pause remains active.' >&2
  fi
  fail_closed 'multiple active pauses after creation'
fi
jq -e --arg id "$pause_id" --arg reason "$reason" \
  '.result == "active" and .active_pause.pause_id == $id and .active_pause.reason == $reason' \
  <<< "$confirmed_active" > /dev/null || fail_closed 'new pause is not the sole active pause'
message="$(bash "$script_dir/format-human-pause-notification.sh" \
  "$reason" "$target" "$detail" "$url" "$pause_id")" \
  || fail_closed 'could not format human notification'
if ! bash "$script_dir/notify-human.sh" "$message"; then
  echo 'create-human-pause: Discord notification failed; GitHub pause remains active.' >&2
fi
jq -cn --arg pause_id "$pause_id" '{result:"created", pause_id:$pause_id}'
