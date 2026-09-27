#!/usr/bin/env bash
set -euo pipefail

# create REPO ISSUE PR APP_ID REASON DETAIL [PAUSED_HEAD] [named options]: create a root pause if none is active.
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
  [ "$#" -ge 7 ] || fail_closed 'create requires reason and decision detail'
  reason="$6"
  detail="$7"
  [ -n "$detail" ] || fail_closed 'decision detail is empty'
  shift 7
  paused_head='' issue_body_fingerprint='' failed_action='' repair_head=''
  head_seen=false fingerprint_seen=false action_seen=false repair_active=false repair_head_seen=false
  if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then
    paused_head="$1"
    head_seen=true
    shift
  fi
  while [ "$#" -gt 0 ]; do
    option="$1"
    case "$option" in
      --paused-head)
        [ "$head_seen" = false ] || fail_closed 'duplicate paused HEAD'
        head_seen=true
        ;;
      --issue-body-fingerprint)
        [ "$fingerprint_seen" = false ] || fail_closed 'duplicate issue body fingerprint'
        fingerprint_seen=true
        ;;
      --failed-action)
        [ "$action_seen" = false ] || fail_closed 'duplicate failed action'
        action_seen=true
        ;;
      --repair-active)
        [ "$repair_active" = false ] || fail_closed 'duplicate repair option'
        repair_active=true
        shift
        continue
        ;;
      --repair-head)
        [ "$repair_head_seen" = false ] || fail_closed 'duplicate repair HEAD'
        repair_head_seen=true
        ;;
      *) fail_closed 'unknown create option' ;;
    esac
    [ "$#" -ge 2 ] && [[ "$2" != --* ]] || fail_closed "missing value for $option"
    case "$option" in
      --paused-head) paused_head="$2" ;;
      --issue-body-fingerprint) issue_body_fingerprint="$2" ;;
      --failed-action) failed_action="$2" ;;
      --repair-head) repair_head="$2" ;;
    esac
    shift 2
  done
  if [ "$repair_active" = true ]; then
    [ "$reason" = developer_execution_failed ] || fail_closed 'repair requires a developer failure'
    if [ "$pr" = '-' ]; then
      [ "$repair_head_seen" = false ] || fail_closed 'repair HEAD requires a PR'
    else
      [ "$repair_head_seen" = true ] && [[ "$repair_head" =~ ^[0-9a-f]{40}$ ]] \
        || fail_closed 'repair requires a valid current PR HEAD'
    fi
  else
    [ "$repair_head_seen" = false ] || fail_closed 'repair HEAD requires repair option'
  fi
  if [ "$head_seen" = true ]; then
    [ "$pr" != '-' ] || fail_closed 'paused HEAD requires a PR'
    [[ "$paused_head" =~ ^[0-9a-f]{40}$ ]] || fail_closed 'invalid paused HEAD'
  fi
  if [ "$fingerprint_seen" = true ]; then
    [[ "$issue_body_fingerprint" =~ ^sha256:[0-9a-f]{64}$ ]] || fail_closed 'invalid issue body fingerprint'
    case "$reason" in
      requirements_change|scope_decision|diff_guard_exceeded) ;;
      *) fail_closed 'issue body fingerprint is not valid for this reason' ;;
    esac
  fi
  if [ "$action_seen" = true ]; then
    [ "$reason" = developer_execution_failed ] || fail_closed 'failed action is not valid for this reason'
    [[ "$failed_action" = develop || "$failed_action" = fix ]] || fail_closed 'invalid failed action'
  fi
  case "$reason" in
    requirements_change|scope_decision|diff_guard_exceeded)
      [ "$fingerprint_seen" = true ] || fail_closed 'issue body fingerprint is required' ;;
    developer_execution_failed)
      [ "$action_seen" = true ] || fail_closed 'failed action is required'
      if [ "$failed_action" = fix ]; then
        [ "$head_seen" = true ] || fail_closed 'paused HEAD is required for failed fix'
      fi
      ;;
  esac
  record="$(jq -cn --arg reason "$reason" --arg target "$target" --arg detail "$detail" \
    --arg paused_head "$paused_head" --arg issue_body_fingerprint "$issue_body_fingerprint" \
    --arg failed_action "$failed_action" \
    '{version:1, kind:"pause", reason:$reason, target:$target,
      payload:({detail:$detail}
        + (if $issue_body_fingerprint == "" then {} else {issue_body_fingerprint:$issue_body_fingerprint} end)
        + (if $failed_action == "" then {} else {failed_action:$failed_action} end))}
     + (if $paused_head == "" then {} else {paused_head:$paused_head} end)')"
  body="$(bash "$script_dir/human-pause-record.sh" create "$record")" \
    || fail_closed 'invalid pause record'
elif [ "$mode" = inspect ]; then
  [ "$#" -eq 6 ] || fail_closed 'inspect requires a pause ID'
  positive "$6" || fail_closed 'invalid pause ID'
  expected_id="$6"
else
  fail_closed 'expected create or inspect'
fi

verify_repair_relation() {
  local pr_json
  [ "$pr" != '-' ] || return 0
  pr_json="$(gh pr view "$pr" --repo "$repo" \
    --json headRefName,headRefOid,closingIssuesReferences)" \
    || fail_closed 'could not verify repair PR relation and HEAD'
  jq -e --arg head "$repair_head" --arg issue "$issue" --arg repo "$repo" '
    .headRefOid == $head and
    (.closingIssuesReferences | type == "array") and
    (if $issue == "-" then true else
      (.headRefName == ("ai/issue-" + $issue)) and
      any(.closingIssuesReferences[]; .number == ($issue | tonumber) and
        .url == ("https://github.com/" + $repo + "/issues/" + $issue))
    end)' <<< "$pr_json" > /dev/null \
    || fail_closed 'repair PR relation or HEAD does not match'
}

verify_repair() {
  local pause_id="$1"
  jq -e --arg id "$pause_id" --arg target "$target" --arg head "$repair_head" '
    .target == $target and
    ([.chains[].records[] | select(.pause_id == $id)] | length) == 1 and
    any(.chains[].records[]; .pause_id == $id and
      .record.target == $target and
      (.record.kind == "pause" or .record.kind == "pause-normalization") and
      .record.reason == $reason and
      (if .record.reason == "requirements_change" or .record.reason == "scope_decision"
          or .record.reason == "diff_guard_exceeded" then
        (.record.payload.issue_body_fingerprint | type == "string" and
          test("^sha256:[0-9a-f]{64}$"))
      elif .record.reason == "developer_execution_failed" then
        (.record.payload.failed_action == "develop" or
          (.record.payload.failed_action == "fix" and (.record.paused_head | type == "string")))
      else true end) and
      (if .record | has("paused_head") then .record.paused_head == $head else true end))' \
    --arg reason "$(jq -r '.active_pause.reason' <<< "$active")" \
    <<< "$history" > /dev/null || fail_closed 'active pause identity or machine fields are ambiguous'
  verify_repair_relation
}

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
  pause_id="$(jq -r '.active_pause.pause_id' <<< "$active")"
  if [ "$repair_active" = true ]; then
    verify_repair "$pause_id"
    original_record="$(jq -ce --arg id "$pause_id" '
      [.chains[].records[] | select(.pause_id == $id) | .record] |
      if length == 1 then .[0] else error("ambiguous record") end' <<< "$history")" \
      || fail_closed 'could not retain original pause identity'
    original_reason="$(jq -r '.active_pause.reason' <<< "$active")"
    bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
      || fail_closed 'could not synchronize existing pause labels'
    history="$(reconcile)" || fail_closed 'could not verify repaired pause history'
    active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$history")" \
      || fail_closed 'could not verify repaired active pause'
    jq -e --arg id "$pause_id" --arg reason "$original_reason" '
      .result == "active" and .active_pause.pause_id == $id and
      .active_pause.reason == $reason' \
      <<< "$active" > /dev/null || fail_closed 'repaired pause is no longer uniquely active'
    jq -e --arg id "$pause_id" --argjson record "$original_record" '
      any(.chains[].records[]; .pause_id == $id and .record == $record)' \
      <<< "$history" > /dev/null || fail_closed 'repaired pause record changed'
    verify_repair "$pause_id"
    jq -cn --arg pause_id "$pause_id" '{result:"already_active", pause_id:$pause_id}'
    exit 0
  fi
  [ "$(jq -r '.active_pause.reason' <<< "$active")" = "$reason" ] \
    || fail_closed 'an active pause has a different reason'
  jq -e --arg id "$pause_id" --arg head "$paused_head" \
    --arg fingerprint "$issue_body_fingerprint" --arg action "$failed_action" '
    any(.chains[].records[];
      .pause_id == $id and (.record | has("source_pause_id") | not)
      and (.record.paused_head // "") == $head
      and (.record.payload.issue_body_fingerprint // "") == $fingerprint
      and (.record.payload.failed_action // "") == $action)' \
    <<< "$history" > /dev/null || fail_closed 'an active pause has different machine fields'
  bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
    || fail_closed 'could not synchronize pause labels'
  jq -cn --arg pause_id "$pause_id" '{result:"already_active", pause_id:$pause_id}'
  exit 0
fi
[ "$result" = no_active_pause ] || fail_closed 'unknown reconciliation result'

recover_post() {
  local failure="$1" recovered recovered_active pause_id
  recovered="$(reconcile)" || fail_closed 'POST failed and trusted history could not be reconciled'
  recovered_active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$recovered")" \
    || fail_closed 'POST failed and active pause could not be reconciled'
  if [ "$(jq -r '.result' <<< "$recovered_active")" = active ]; then
    pause_id="$(jq -r '.active_pause.pause_id' <<< "$recovered_active")"
    jq -e --arg id "$pause_id" --argjson record "$record" \
      'any(.chains[].records[]; .pause_id == $id and .record == $record)' \
      <<< "$recovered" > /dev/null || fail_closed "$failure; active record does not match request"
    bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
      || fail_closed "$failure; matching record found but labels could not be synchronized"
    recovered="$(reconcile)" || fail_closed "$failure; could not verify recovered pause"
    recovered_active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$recovered")" \
      || fail_closed "$failure; could not verify recovered active pause"
    jq -e --arg id "$pause_id" --argjson record "$record" '
      any(.chains[].records[]; .pause_id == $id and .record == $record)' \
      <<< "$recovered" > /dev/null || fail_closed "$failure; recovered record changed"
    jq -e --arg id "$pause_id" \
      '.result == "active" and .active_pause.pause_id == $id' \
      <<< "$recovered_active" > /dev/null || fail_closed "$failure; recovered pause is not uniquely active"
    if [ "$repair_active" = true ]; then verify_repair_relation; fi
    jq -cn --arg pause_id "$pause_id" '{result:"already_active", pause_id:$pause_id}'
    return
  fi
  fail_closed "$failure; no unique matching active trusted pause"
}

# The REST comment ID is the pause identity. If the response is lost, a fresh
# trusted listing must prove that the intended record became the sole active pause.
if ! created="$(gh api -X POST "/repos/$repo/issues/$conversation/comments" -f "body=$body")"; then
  recover_post 'POST failed'
  exit 0
fi
if ! pause_id="$(jq -er '.id | if type == "number" and . >= 1 and floor == . then tostring else error("invalid comment ID") end' \
  <<< "$created" 2>/dev/null)"; then
  recover_post 'POST returned no valid REST ID'
  exit 0
fi
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
