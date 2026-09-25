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
      if [ "${MOCK_CONCURRENT_PAUSE:-false}" = true ]; then
        jq --arg body "$body" --argjson id "$((id + 1))" \
          '. + [{id:$id, body:$body, performed_via_github_app:{id:99}}]' \
          "$TEST_DIR/comments.json" > "$TEST_DIR/next.json"
        mv "$TEST_DIR/next.json" "$TEST_DIR/comments.json"
      fi
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
  bash "$script_dir/create-human-pause.sh" create owner/repo 36 37 99 "$@"
}
inspect() {
  bash "$script_dir/create-human-pause.sh" inspect owner/repo 36 37 99 "$1"
}

first="$(create requirements_change 'REQ-123 の変更を判断する')"
jq -e '.result == "created" and .pause_id == "101"' <<< "$first" > /dev/null
jq -e '.content | contains("対象: pr:37") and contains("要求の変更が必要") and contains("REQ-123 の変更を判断する") and contains("https://github.com/owner/repo/pull/37") and contains("pause_id: 101")' \
  "$test_dir/notification.json" > /dev/null
jq -e '.allowed_mentions == {parse: []}' "$test_dir/notification.json" > /dev/null
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
reasons="$(bash "$script_dir/human-pause-record.sh" reasons)"
jq -e 'type == "array" and length > 0 and (unique | length) == length' \
  <<< "$reasons" > /dev/null
while IFS= read -r reason; do
  message="$(bash "$script_dir/format-human-pause-notification.sh" "$reason" \
    pr:37 '判断内容' https://github.com/owner/repo/pull/37 104)"
  [[ "$message" == *'判断内容'* && "$message" == *"($reason)"* \
    && "$message" == *'次の対応:'* ]] || exit 1
done < <(jq -r '.[]' <<< "$reasons")

# The full free text stays in the GitHub record while Discord is bounded.
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"
long_detail="$(printf 'あ%.0s' {1..300})@everyone"
create validation_failed "$long_detail" > /dev/null
jq -e --arg detail "$long_detail" '.[0].body | contains($detail)' \
  "$test_dir/comments.json" > /dev/null
jq -e '.allowed_mentions == {parse: []} and (.content | contains("…") and (contains("@everyone") | not))' \
  "$test_dir/notification.json" > /dev/null
[ "$(wc -c < "$test_dir/notification.json")" -lt 1800 ]

# Competing roots remain paused and report inconsistency without choosing one.
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"
MOCK_CONCURRENT_PAUSE=true
export MOCK_CONCURRENT_PAUSE
if create validation_failed '競合' > /dev/null 2>&1; then
  echo 'Expected concurrent roots to fail closed.' >&2
  exit 1
fi
unset MOCK_CONCURRENT_PAUSE
[ "$(jq 'length' "$test_dir/comments.json")" -eq 2 ]
grep -q '^label 36$' "$test_dir/events"
grep -q '^label 37$' "$test_dir/events"
[ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]
jq -e '.content | contains("state_inconsistent")' "$test_dir/notification.json" > /dev/null

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

# The optional review producer input is a strict PR HEAD and remains part of
# the schema-owned record; legacy callers still omit it.
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"
head_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
jq -e '.result == "created"' <<< "$(bash "$script_dir/create-human-pause.sh" create \
  owner/repo 36 37 99 claude_execution_failed 'review failed' "$head_sha")" > /dev/null
jq -e --arg head "$head_sha" '.[0].body | contains("\"paused_head\":\"" + $head + "\"")' \
  "$test_dir/comments.json" > /dev/null
jq -e '.result == "already_active"' <<< "$(bash "$script_dir/create-human-pause.sh" create \
  owner/repo 36 37 99 claude_execution_failed 'review failed' "$head_sha")" > /dev/null
if bash "$script_dir/create-human-pause.sh" create owner/repo 36 37 99 \
  claude_execution_failed 'review failed' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb > /dev/null 2>&1; then
  echo 'Expected a mismatched active HEAD to fail closed.' >&2; exit 1
fi
if bash "$script_dir/create-human-pause.sh" create owner/repo 36 37 99 \
  claude_execution_failed 'review failed' AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA > /dev/null 2>&1; then
  echo 'Expected an uppercase HEAD to be rejected.' >&2; exit 1
fi
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"


assert_rejected() {
  local count
  count="$(jq 'length' "$test_dir/comments.json")"
  if "$@" > /dev/null 2>&1; then
    echo "Expected create input to be rejected: $*" >&2; exit 1
  fi
  [ "$(jq 'length' "$test_dir/comments.json")" -eq "$count" ]
}

# Named inputs produce only the reason-specific machine fields. Invalid input
# stops before any record is posted; legacy omission remains accepted above.
fingerprint="sha256:$(printf 'a%.0s' {1..64})"
for pause_reason in requirements_change scope_decision diff_guard_exceeded; do
  printf '[]\n' > "$test_dir/comments.json"
  jq -e '.result == "created"' <<< "$(create "$pause_reason" '判断内容' \
    --issue-body-fingerprint "$fingerprint")" > /dev/null
  jq -e --arg reason "$pause_reason" --arg fingerprint "$fingerprint" \
    '.[0].body | split("\n")[1] | fromjson |
      .reason == $reason and .payload == {detail:"判断内容", issue_body_fingerprint:$fingerprint}' \
    "$test_dir/comments.json" > /dev/null
done
assert_rejected create validation_failed detail --issue-body-fingerprint "$fingerprint"
assert_rejected create requirements_change detail --issue-body-fingerprint sha256:abcdef
assert_rejected create requirements_change detail --issue-body-fingerprint "sha256:$(printf 'A%.0s' {1..64})"
assert_rejected create requirements_change detail --issue-body-fingerprint "$fingerprint" \
  --issue-body-fingerprint "$fingerprint"
assert_rejected create requirements_change detail --issue-body-fingerprint

for action in develop fix; do
  printf '[]\n' > "$test_dir/comments.json"
  jq -e '.result == "created"' <<< "$(create developer_execution_failed '実行失敗' \
    --failed-action "$action")" > /dev/null
  jq -e --arg action "$action" \
    '.[0].body | split("\n")[1] | fromjson |
      .payload == {detail:"実行失敗", failed_action:$action}' \
    "$test_dir/comments.json" > /dev/null
done
assert_rejected create validation_failed detail --failed-action fix
assert_rejected create developer_execution_failed detail --failed-action retry
assert_rejected create developer_execution_failed detail --failed-action
assert_rejected create developer_execution_failed detail --failed-action fix --failed-action develop
assert_rejected create developer_execution_failed detail --failed-action ''
assert_rejected create validation_failed detail --payload '{"failed_action":"fix"}'
assert_rejected create validation_failed detail --unknown-machine-field value
assert_rejected create validation_failed detail '{"failed_action":"fix"}'
printf '[]\n' > "$test_dir/comments.json"
create developer_execution_failed '{"failed_action":"fix"}' > /dev/null
jq -e '.[0].body | split("\n")[1] | fromjson |
  .payload == {detail:"{\"failed_action\":\"fix\"}"}' \
  "$test_dir/comments.json" > /dev/null

printf '[]\n' > "$test_dir/comments.json"
jq -e '.result == "created"' <<< "$(create claude_execution_failed 'review failed' \
  --paused-head "$head_sha")" > /dev/null
jq -e --arg head "$head_sha" \
  '.[0].body | split("\n")[1] | fromjson | .paused_head == $head' \
  "$test_dir/comments.json" > /dev/null
jq -e '.result == "already_active"' <<< "$(create claude_execution_failed \
  'review failed' --paused-head "$head_sha")" > /dev/null
assert_rejected create claude_execution_failed detail --paused-head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
assert_rejected create claude_execution_failed detail --paused-head AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
assert_rejected create claude_execution_failed detail --paused-head "$head_sha" --paused-head "$head_sha"
assert_rejected create claude_execution_failed detail "$head_sha" --paused-head "$head_sha"
assert_rejected create claude_execution_failed detail --paused-head
assert_rejected bash "$script_dir/create-human-pause.sh" create owner/repo 36 - 99 \
  claude_execution_failed detail --paused-head "$head_sha"

echo 'create-human-pause tests passed.'
