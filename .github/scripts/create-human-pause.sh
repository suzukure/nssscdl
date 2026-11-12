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

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail_closed 'リポジトリ指定が不正です'
positive "$app_id" || fail_closed '信頼済みApp IDが不正です'
if [ "$issue" != '-' ]; then positive "$issue" || fail_closed 'Issue番号が不正です'; fi
if [ "$pr" != '-' ]; then positive "$pr" || fail_closed 'PR番号が不正です'; fi
[ "$issue" != '-' ] || [ "$pr" != '-' ] || fail_closed 'IssueまたはPRの指定が必要です'

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
  [ "$#" -ge 7 ] || fail_closed 'createには理由と判断内容が必要です'
  reason="$6"
  detail="$7"
  [ -n "$detail" ] || fail_closed '判断内容が空です'
  shift 7
  paused_head='' issue_body_fingerprint='' failed_action='' repair_head='' notification_detail="$detail"
  head_seen=false fingerprint_seen=false action_seen=false repair_active=false repair_head_seen=false notification_seen=false
  if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then
    paused_head="$1"
    head_seen=true
    shift
  fi
  while [ "$#" -gt 0 ]; do
    option="$1"
    case "$option" in
      --paused-head)
        [ "$head_seen" = false ] || fail_closed '停止時HEADが重複しています'
        head_seen=true
        ;;
      --issue-body-fingerprint)
        [ "$fingerprint_seen" = false ] || fail_closed 'Issue本文fingerprintが重複しています'
        fingerprint_seen=true
        ;;
      --failed-action)
        [ "$action_seen" = false ] || fail_closed '失敗actionが重複しています'
        action_seen=true
        ;;
      --repair-active)
        [ "$repair_active" = false ] || fail_closed '修復optionが重複しています'
        repair_active=true
        shift
        continue
        ;;
      --repair-head)
        [ "$repair_head_seen" = false ] || fail_closed '修復HEADが重複しています'
        repair_head_seen=true
        ;;
      --notification-detail)
        [ "$notification_seen" = false ] || fail_closed '通知用の判断内容が重複しています'
        notification_seen=true
        ;;
      *) fail_closed '不明なcreate optionです' ;;
    esac
    [ "$#" -ge 2 ] && [[ "$2" != --* ]] || fail_closed "$option の値がありません"
    case "$option" in
      --paused-head) paused_head="$2" ;;
      --issue-body-fingerprint) issue_body_fingerprint="$2" ;;
      --failed-action) failed_action="$2" ;;
      --repair-head) repair_head="$2" ;;
      --notification-detail) notification_detail="$2" ;;
    esac
    shift 2
  done
  [ -n "$notification_detail" ] || fail_closed '通知用の判断内容が空です'
  if [ "$repair_active" = true ]; then
    [ "$reason" = developer_execution_failed ] || fail_closed '修復にはdeveloper失敗が必要です'
    if [ "$pr" = '-' ]; then
      [ "$repair_head_seen" = false ] || fail_closed '修復HEADにはPRが必要です'
    else
      [ "$repair_head_seen" = true ] && [[ "$repair_head" =~ ^[0-9a-f]{40}$ ]] \
        || fail_closed '修復には有効な現在のPR HEADが必要です'
    fi
  else
    [ "$repair_head_seen" = false ] || fail_closed '修復HEADには修復optionが必要です'
  fi
  if [ "$head_seen" = true ]; then
    [ "$pr" != '-' ] || fail_closed '停止時HEADにはPRが必要です'
    [[ "$paused_head" =~ ^[0-9a-f]{40}$ ]] || fail_closed '停止時HEADが不正です'
  fi
  if [ "$fingerprint_seen" = true ]; then
    [[ "$issue_body_fingerprint" =~ ^sha256:[0-9a-f]{64}$ ]] || fail_closed 'Issue本文fingerprintが不正です'
    case "$reason" in
      requirements_change|scope_decision|diff_guard_exceeded) ;;
      *) fail_closed 'この理由にはIssue本文fingerprintを指定できません' ;;
    esac
  fi
  if [ "$action_seen" = true ]; then
    [ "$reason" = developer_execution_failed ] || fail_closed 'この理由には失敗actionを指定できません'
    [[ "$failed_action" = develop || "$failed_action" = fix ]] || fail_closed '失敗actionが不正です'
  fi
  case "$reason" in
    requirements_change|scope_decision|diff_guard_exceeded)
      [ "$fingerprint_seen" = true ] || fail_closed 'Issue本文fingerprintが必要です' ;;
    developer_execution_failed)
      [ "$action_seen" = true ] || fail_closed '失敗actionが必要です'
      if [ "$failed_action" = fix ]; then
        [ "$head_seen" = true ] || fail_closed 'fix失敗には停止時HEADが必要です'
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
    || fail_closed '停止記録が不正です'
elif [ "$mode" = inspect ]; then
  [ "$#" -eq 6 ] || fail_closed 'inspectにはpause IDが必要です'
  positive "$6" || fail_closed 'pause IDが不正です'
  expected_id="$6"
else
  fail_closed 'createまたはinspectを指定してください'
fi

verify_repair_relation() {
  local pr_json
  [ "$pr" != '-' ] || return 0
  pr_json="$(gh pr view "$pr" --repo "$repo" \
    --json headRefName,headRefOid,closingIssuesReferences)" \
    || fail_closed '修復対象PRの関連とHEADを確認できません'
  jq -e --arg head "$repair_head" --arg issue "$issue" --arg repo "$repo" '
    .headRefOid == $head and
    (.closingIssuesReferences | type == "array") and
    (if $issue == "-" then true else
      (.headRefName == ("ai/issue-" + $issue)) and
      any(.closingIssuesReferences[]; .number == ($issue | tonumber) and
        .url == ("https://github.com/" + $repo + "/issues/" + $issue))
    end)' <<< "$pr_json" > /dev/null \
    || fail_closed '修復対象PRの関連またはHEADが一致しません'
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
    <<< "$history" > /dev/null || fail_closed '有効な停止記録の識別情報または機械項目が曖昧です'
  verify_repair_relation
}

history="$(reconcile)" || fail_closed '信頼済み停止履歴を照合できません'
active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$history")" \
  || fail_closed '有効な停止記録を照合できません'
result="$(jq -r '.result' <<< "$active")"
[ "$result" != state_inconsistent ] || fail_closed '有効な停止記録が複数あります'

if [ "$mode" = inspect ]; then
  if [ "$result" = active ] && [ "$(jq -r '.active_pause.pause_id' <<< "$active")" = "$expected_id" ]; then
    bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
      || fail_closed '停止ラベルを同期できません'
    jq -cn --arg pause_id "$expected_id" '{result:"already_active", pause_id:$pause_id}'
  elif jq -e --arg id "$expected_id" \
    'any(.chains[]; .effective.status == "consumed" and .effective.pause_id == $id)' \
    <<< "$history" > /dev/null; then
    jq -cn --arg pause_id "$expected_id" '{result:"already_consumed", pause_id:$pause_id}'
  else
    fail_closed 'pause IDは有効または消費済みの停止記録を指しません'
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
      || fail_closed '元の停止記録の識別情報を維持できません'
    original_reason="$(jq -r '.active_pause.reason' <<< "$active")"
    bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
      || fail_closed '既存の停止ラベルを同期できません'
    history="$(reconcile)" || fail_closed '修復後の停止履歴を確認できません'
    active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$history")" \
      || fail_closed '修復後の有効な停止記録を確認できません'
    jq -e --arg id "$pause_id" --arg reason "$original_reason" '
      .result == "active" and .active_pause.pause_id == $id and
      .active_pause.reason == $reason' \
      <<< "$active" > /dev/null || fail_closed '修復後の停止記録が一意に有効ではありません'
    jq -e --arg id "$pause_id" --argjson record "$original_record" '
      any(.chains[].records[]; .pause_id == $id and .record == $record)' \
      <<< "$history" > /dev/null || fail_closed '修復後の停止記録が変化しました'
    verify_repair "$pause_id"
    jq -cn --arg pause_id "$pause_id" '{result:"already_active", pause_id:$pause_id}'
    exit 0
  fi
  [ "$(jq -r '.active_pause.reason' <<< "$active")" = "$reason" ] \
    || fail_closed '有効な停止記録の理由が異なります'
  jq -e --arg id "$pause_id" --arg head "$paused_head" \
    --arg fingerprint "$issue_body_fingerprint" --arg action "$failed_action" '
    any(.chains[].records[];
      .pause_id == $id and (.record | has("source_pause_id") | not)
      and (.record.paused_head // "") == $head
      and (.record.payload.issue_body_fingerprint // "") == $fingerprint
      and (.record.payload.failed_action // "") == $action)' \
    <<< "$history" > /dev/null || fail_closed '有効な停止記録の機械項目が異なります'
  bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
    || fail_closed '停止ラベルを同期できません'
  jq -cn --arg pause_id "$pause_id" '{result:"already_active", pause_id:$pause_id}'
  exit 0
fi
[ "$result" = no_active_pause ] || fail_closed '不明な照合結果です'

recover_post() {
  local failure="$1" recovered recovered_active pause_id
  recovered="$(reconcile)" || fail_closed 'POSTが失敗し、信頼済み履歴を照合できません'
  recovered_active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$recovered")" \
    || fail_closed 'POSTが失敗し、有効な停止記録を照合できません'
  if [ "$(jq -r '.result' <<< "$recovered_active")" = active ]; then
    pause_id="$(jq -r '.active_pause.pause_id' <<< "$recovered_active")"
    jq -e --arg id "$pause_id" --argjson record "$record" \
      'any(.chains[].records[]; .pause_id == $id and .record == $record)' \
      <<< "$recovered" > /dev/null || fail_closed "$failure; 有効な記録が要求と一致しません"
    bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
      || fail_closed "$failure; 一致する記録はありますが、ラベルを同期できません"
    recovered="$(reconcile)" || fail_closed "$failure; 復旧した停止記録を確認できません"
    recovered_active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$recovered")" \
      || fail_closed "$failure; 復旧した有効な停止記録を確認できません"
    jq -e --arg id "$pause_id" --argjson record "$record" '
      any(.chains[].records[]; .pause_id == $id and .record == $record)' \
      <<< "$recovered" > /dev/null || fail_closed "$failure; 復旧した記録が変化しました"
    jq -e --arg id "$pause_id" \
      '.result == "active" and .active_pause.pause_id == $id' \
      <<< "$recovered_active" > /dev/null || fail_closed "$failure; 復旧した停止記録が一意に有効ではありません"
    if [ "$repair_active" = true ]; then verify_repair_relation; fi
    jq -cn --arg pause_id "$pause_id" '{result:"already_active", pause_id:$pause_id}'
    return
  fi
  fail_closed "$failure; 一致する一意の有効な信頼済み停止記録がありません"
}

# The REST comment ID is the pause identity. If the response is lost, a fresh
# trusted listing must prove that the intended record became the sole active pause.
if ! created="$(gh api -X POST "/repos/$repo/issues/$conversation/comments" -f "body=$body")"; then
  recover_post 'POSTに失敗しました'
  exit 0
fi
if ! pause_id="$(jq -er '.id | if type == "number" and . >= 1 and floor == . then tostring else error("invalid comment ID") end' \
  <<< "$created" 2>/dev/null)"; then
  recover_post 'POST応答に有効なREST IDがありません'
  exit 0
fi
bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "${pr/-/}" \
  || fail_closed '停止ラベルを同期できません'

# Observe the exact new record and its active state through the trusted
# reconciliation boundary before notifying. A concurrent conflicting pause or
# delayed visibility leaves the GitHub pause in place without Discord output.
confirmed="$(reconcile)" || fail_closed '新しい停止状態を確認できません'
jq -e --arg id "$pause_id" --argjson record "$record" \
  'any(.chains[].records[]; .pause_id == $id and .record == $record)' \
  <<< "$confirmed" > /dev/null || fail_closed '新しい停止記録を信頼済み記録として確認できません'
confirmed_active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" \
  <<< "$confirmed")" || fail_closed '有効な停止記録を確認できません'
if [ "$(jq -r '.result' <<< "$confirmed_active")" = state_inconsistent ]; then
  message="$(bash "$script_dir/format-human-pause-notification.sh" \
    state_inconsistent "$target" '同時に複数の停止記録が作成されました。Issue・PRの記録を確認してください。' "$url" "$pause_id")" \
    || fail_closed '不整合状態の通知を生成できません'
  if ! bash "$script_dir/notify-human.sh" "$message"; then
    echo 'create-human-pause: Discord通知に失敗しました。GitHubの停止は継続します。' >&2
  fi
  fail_closed '作成後に有効な停止記録が複数あります'
fi
jq -e --arg id "$pause_id" --arg reason "$reason" \
  '.result == "active" and .active_pause.pause_id == $id and .active_pause.reason == $reason' \
  <<< "$confirmed_active" > /dev/null || fail_closed '新しい停止記録が唯一の有効な停止記録ではありません'
message="$(bash "$script_dir/format-human-pause-notification.sh" \
  "$reason" "$target" "$notification_detail" "$url" "$pause_id")" \
  || fail_closed '人間向け通知を生成できません'
if ! bash "$script_dir/notify-human.sh" "$message"; then
  echo 'create-human-pause: Discord通知に失敗しました。GitHubの停止は継続します。' >&2
fi
jq -cn --arg pause_id "$pause_id" '{result:"created", pause_id:$pause_id}'
