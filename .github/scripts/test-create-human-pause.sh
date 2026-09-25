#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export TEST_DIR="$test_dir"
export NOTIFICATION_WEBHOOK_URL='https://discord.invalid/webhook'
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"

gh() {
  case "$1 $2" in
    'api --paginate')
      jq -c '[.]' "$TEST_DIR/comments.json"
      ;;
    'api -X')
      local body='' arg
      for arg in "$@"; do
        case "$arg" in body=*) body="${arg#body=}" ;; esac
      done
      local id
      id="$(jq 'length + 101' "$TEST_DIR/comments.json")"
      jq --arg body "$body" --argjson id "$id" \
        '. + [{id:$id, body:$body, performed_via_github_app:{id:99}}]' \
        "$TEST_DIR/comments.json" > "$TEST_DIR/next.json"
      mv "$TEST_DIR/next.json" "$TEST_DIR/comments.json"
      printf 'record %s\n' "$id" >> "$TEST_DIR/events"
      jq -cn --argjson id "$id" '{id:$id}'
      ;;
    'pr view')
      printf '%s\n' '{"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}'
      ;;
    'label create')
      printf 'label-create\n' >> "$TEST_DIR/events"
      ;;
    'issue edit')
      if [ "${MOCK_LABEL_FAIL:-false}" = true ]; then return 1; fi
      printf 'label %s\n' "$3" >> "$TEST_DIR/events"
      ;;
    *) echo "Unexpected gh invocation: $*" >&2; return 2 ;;
  esac
}

curl() {
  cat > "$TEST_DIR/notification.json"
  printf 'notify\n' >> "$TEST_DIR/events"
  [ "${MOCK_DISCORD_FAIL:-false}" != true ]
}
export -f gh curl

create() {
  bash "$script_dir/create-human-pause.sh" create owner/repo 36 37 99 "$1" "$2"
}
inspect() {
  bash "$script_dir/create-human-pause.sh" inspect owner/repo 36 37 99 "$1"
}

first="$(create requirements_change 'REQ-123 の変更を判断する')"
jq -e '.result == "created" and .pause_id == "101"' <<< "$first" > /dev/null
jq -e '.content | contains("対象: pr:37") and contains("要求の変更が必要") and contains("REQ-123 の変更を判断する") and contains("https://github.com/owner/repo/pull/37") and contains("pause_id: 101")' \
  "$test_dir/notification.json" > /dev/null
[ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]
[ "$(grep -nE '^record |^label |^notify$' "$test_dir/events" | cut -d: -f2- | head -1)" = 'record 101' ]
[ "$(grep -nE '^record |^label |^notify$' "$test_dir/events" | cut -d: -f2- | tail -1)" = notify ]
grep -q '^label 36$' "$test_dir/events"
grep -q '^label 37$' "$test_dir/events"

jq -e '.result == "already_active" and .pause_id == "101"' \
  <<< "$(create requirements_change 'REQ-123 の変更を判断する')" > /dev/null
jq -e '.result == "already_active" and .pause_id == "101"' \
  <<< "$(inspect 101)" > /dev/null
[ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]
[ "$(jq 'length' "$test_dir/comments.json")" -eq 1 ]
if create scope_decision '別の判断' > /dev/null 2>&1; then
  echo 'Expected a conflicting active reason to stop.' >&2
  exit 1
fi
[ "$(jq 'length' "$test_dir/comments.json")" -eq 1 ]
[ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]

# A consumed pause can be inspected but must never be notified again.
consumed="$(bash "$script_dir/human-pause-record.sh" create \
  '{"version":1,"kind":"ai-resume-accepted","reason":"requirements_change","target":"pr:37","source_pause_id":"101"}')"
jq --arg body "$consumed" \
  '. + [{id:102, body:$body, performed_via_github_app:{id:99}}]' \
  "$test_dir/comments.json" > "$test_dir/next.json"
mv "$test_dir/next.json" "$test_dir/comments.json"
jq -e '.result == "already_consumed" and .pause_id == "101"' \
  <<< "$(inspect 101)" > /dev/null
[ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]

# A new independent pause receives a new ID and exactly one new notification.
MOCK_DISCORD_FAIL=true
export MOCK_DISCORD_FAIL
jq -e '.result == "created" and .pause_id == "103"' \
  <<< "$(create validation_failed '検証ログの判断が必要')" > /dev/null
[ "$(grep -c '^notify$' "$test_dir/events")" -eq 2 ]
jq -e '.result == "already_active" and .pause_id == "103"' \
  <<< "$(create validation_failed '検証ログの判断が必要')" > /dev/null
[ "$(grep -c '^notify$' "$test_dir/events")" -eq 2 ]
unset MOCK_DISCORD_FAIL

# An unknown or machine-only reason cannot create a record or notification.
if create ai-followup-in-progress '機械状態' > /dev/null 2>&1; then
  echo 'Expected machine-only reason to be rejected.' >&2
  exit 1
fi
if bash "$script_dir/format-human-pause-notification.sh" unknown pr:37 detail \
  https://github.com/owner/repo/pull/37 104 > /dev/null 2>&1; then
  echo 'Expected unknown notification reason to be rejected.' >&2
  exit 1
fi
for reason in requirements_change scope_decision diff_guard_exceeded diff_guard_error \
  non_blocking_decision round_limit validation_failed validation_timeout \
  claude_execution_failed developer_execution_failed explicit_human_escalation \
  review_disagreement_decision resume_transition_failed state_inconsistent; do
  message="$(bash "$script_dir/format-human-pause-notification.sh" "$reason" \
    pr:37 '判断内容' https://github.com/owner/repo/pull/37 104)"
  [[ "$message" == *'判断内容'* && "$message" == *"($reason)"* \
    && "$message" == *'次の対応:'* ]] || exit 1
done

# Failed label synchronization cannot send Discord; retry repairs labels only.
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"
MOCK_LABEL_FAIL=true
export MOCK_LABEL_FAIL
if create scope_decision '対象範囲を判断する' > /dev/null 2>&1; then
  echo 'Expected label failure to stop before notification.' >&2
  exit 1
fi
[ "$(jq 'length' "$test_dir/comments.json")" -eq 1 ]
if grep -q '^notify$' "$test_dir/events"; then
  echo 'Notification preceded successful pause state.' >&2
  exit 1
fi
unset MOCK_LABEL_FAIL
jq -e '.result == "already_active" and .pause_id == "101"' \
  <<< "$(create scope_decision '対象範囲を判断する')" > /dev/null
if grep -q '^notify$' "$test_dir/events"; then
  echo 'A retry duplicated the notification.' >&2
  exit 1
fi

# Without a PR, the Issue is the record and label target. An unset webhook is
# best effort and does not undo the GitHub pause.
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"
unset NOTIFICATION_WEBHOOK_URL
issue_result="$(bash "$script_dir/create-human-pause.sh" create owner/repo 36 - 99 \
  round_limit '修正回数を確認する')"
jq -e '.result == "created" and .pause_id == "101"' <<< "$issue_result" > /dev/null
grep -q '^label 36$' "$test_dir/events"
if grep -qE '^label 37$|^notify$' "$test_dir/events"; then
  echo 'Issue-only pause touched the PR or sent an unconfigured notification.' >&2
  exit 1
fi
jq -e '.[0].body | contains("\"target\":\"issue:36\"")' \
  "$test_dir/comments.json" > /dev/null

# PR-only input still synchronizes its closing Issue through the existing
# label helper while keeping the record in the PR Conversation.
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"
pr_result="$(bash "$script_dir/create-human-pause.sh" create owner/repo - 37 99 \
  scope_decision 'PRの判断が必要')"
jq -e '.result == "created" and .pause_id == "101"' <<< "$pr_result" > /dev/null
grep -q '^label 36$' "$test_dir/events"
grep -q '^label 37$' "$test_dir/events"
jq -e '.[0].body | contains("\"target\":\"pr:37\"")' \
  "$test_dir/comments.json" > /dev/null

echo 'create-human-pause tests passed.'
