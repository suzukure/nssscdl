#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/prepare-ai-resume.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

head_sha='0123456789abcdef0123456789abcdef01234567'
other_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
old_fingerprint="sha256:$(printf '0%.0s' {1..64})"
new_fingerprint="sha256:$(printf '1%.0s' {1..64})"
base="$(jq -cn --arg head "$head_sha" --arg current "$new_fingerprint" '
  {command:{result:"accepted",actor:"suzukure",action:"fix"},
   target:"pr:37", closing_issue:{number:36,state:"open",body_fingerprint:$current},
   pull_request:{number:37,state:"open",base_ref:"main",head_ref:"ai/issue-36",
                 head_sha:$head}, follow_up_issue:null,
   pause:{result:"active",pause_id:"123456",reason:"non_blocking_decision",
          record:{version:1,kind:"pause",reason:"non_blocking_decision",
                  target:"pr:37",paused_head:$head,payload:{detail:"human text"}}}}
')"

check() {
  local name="$1" expected="$2" input="$3"
  printf '%s\n' "$input" | bash "$helper" > "$test_dir/output" 2> "$test_dir/error" || {
    echo "Expected result for $name" >&2; cat "$test_dir/error" >&2; exit 1;
  }
  jq -e --arg expected "$expected" '
    if $expected == "prepared" then
      .result == "prepared" and (. | keys) == ["dispatch","result"]
      and (.dispatch | keys) == ["action","actor","closing_issue_number",
        "follow_up_issue","pause_issue_body_fingerprint","paused_head","pr_number",
        "prepared_head","prepared_issue_body_fingerprint","reason","source_pause_id",
        "target","version"]
      and .dispatch.version == 1 and .dispatch.actor == "suzukure"
      and .dispatch.source_pause_id == "123456"
    else . == {result:"reject",code:$expected} end
  ' "$test_dir/output" > /dev/null || { echo "Wrong result for $name" >&2; exit 1; }
}

invalid() {
  local name="$1" input="$2"
  if printf '%s\n' "$input" | bash "$helper" > "$test_dir/output" 2> "$test_dir/error"; then
    echo "Expected invalid schema to fail: $name" >&2; exit 1
  fi
  test ! -s "$test_dir/output" || { echo "Unexpected output for $name" >&2; exit 1; }
}

check fix prepared "$base"
jq -e --arg head "$head_sha" --arg fp "$new_fingerprint" '
  .dispatch == {version:1,target:"pr:37",action:"fix",actor:"suzukure",
    source_pause_id:"123456",reason:"non_blocking_decision",closing_issue_number:36,
    pr_number:37,paused_head:$head,prepared_head:$head,
    pause_issue_body_fingerprint:null,prepared_issue_body_fingerprint:$fp,
    follow_up_issue:null}
' "$test_dir/output" > /dev/null

check no-active no_active_pause "$(jq -c '.pause={result:"no_active_pause"}' <<< "$base")"
check inconsistent state_inconsistent "$(jq -c '.pause={result:"state_inconsistent"}' <<< "$base")"
for reason in round_limit explicit_human_escalation state_inconsistent; do
  check "$reason" action_not_allowed "$(jq -c --arg reason "$reason" '.pause.reason=$reason | .pause.record.reason=$reason' <<< "$base")"
done
for reason in requirements_change scope_decision diff_guard_exceeded; do
  snapshot="$(jq -c --arg reason "$reason" --arg fp "$old_fingerprint" '
    .command.action="develop" | .pause.reason=$reason | .pause.record.reason=$reason
    | .pause.record.payload.issue_body_fingerprint=$fp' <<< "$base")"
  check "$reason" prepared "$snapshot"
  check "$reason unchanged" issue_body_not_updated "$(jq -c --arg fp "$new_fingerprint" '.pause.record.payload.issue_body_fingerprint=$fp' <<< "$snapshot")"
  check "$reason missing" invalid_pause_payload "$(jq -c 'del(.pause.record.payload.issue_body_fingerprint)' <<< "$snapshot")"
  check "$reason malformed" invalid_pause_payload "$(jq -c '.pause.record.payload.issue_body_fingerprint="bad"' <<< "$snapshot")"
done
check diff-guard-error prepared "$(jq -c '.command.action="develop" | .pause.reason="diff_guard_error" | .pause.record.reason="diff_guard_error"' <<< "$base")"
for action in fix review follow-up no-action; do
  snapshot="$(jq -c --arg action "$action" '.command.action=$action | if $action == "follow-up" then .command.follow_up_issue=123 | .follow_up_issue={number:123,kind:"issue",state:"open",explicitly_recorded:true} else . end' <<< "$base")"
  if [ "$action" = review ]; then
    snapshot="$(jq -c '.pause.reason="claude_execution_failed" | .pause.record.reason="claude_execution_failed"' <<< "$snapshot")"
  fi
  check "$action same head" prepared "$snapshot"
  check "$action stale head" stale_head "$(jq -c --arg head "$other_sha" '.pull_request.head_sha=$head' <<< "$snapshot")"
  check "$action missing paused head" invalid_pause_payload "$(jq -c 'del(.pause.record.paused_head)' <<< "$snapshot")"
done
for expression in '.follow_up_issue=null' '.follow_up_issue.number=124' '.follow_up_issue.kind="pr"' '.follow_up_issue.state="closed"' '.follow_up_issue.explicitly_recorded=false'; do
  check "follow-up $expression" invalid_follow_up "$(jq -c "$expression" <<< "$(jq -c '.command.action="follow-up" | .command.follow_up_issue=123 | .follow_up_issue={number:123,kind:"issue",state:"open",explicitly_recorded:true}' <<< "$base")")"
done
for reason in validation_failed validation_timeout; do
  for action in validate develop; do
    [ "$reason" = validation_timeout ] && [ "$action" = develop ] && expected=action_not_allowed || expected=prepared
    check "$reason $action changed HEAD" "$expected" "$(jq -c --arg reason "$reason" --arg action "$action" --arg head "$other_sha" '.command.action=$action | .pause.reason=$reason | .pause.record.reason=$reason | .pull_request.head_sha=$head' <<< "$base")"
  done
done
for pair in 'developer_execution_failed:failed_action:develop:fix' 'review_disagreement_decision:decided_action:review:develop' 'resume_transition_failed:failed_action:fix:review'; do
  IFS=: read -r reason field allowed denied <<< "$pair"
  snapshot="$(jq -c --arg reason "$reason" --arg field "$field" --arg action "$allowed" '.command.action=$action | .pause.reason=$reason | .pause.record.reason=$reason | .pause.record.payload[$field]=$action' <<< "$base")"
  check "$reason allowed" prepared "$snapshot"
  check "$reason denied" action_not_allowed "$(jq -c --arg action "$denied" '.command.action=$action' <<< "$snapshot")"
  check "$reason missing payload" invalid_pause_payload "$(jq -c --arg field "$field" 'del(.pause.record.payload[$field])' <<< "$snapshot")"
  check "$reason bad payload" invalid_pause_payload "$(jq -c --arg field "$field" '.pause.record.payload[$field]="unknown"' <<< "$snapshot")"
done
for pair in 'developer_execution_failed:fix' 'review_disagreement_decision:review' 'resume_transition_failed:fix'; do
  IFS=: read -r reason action <<< "$pair"
  field=failed_action
  [ "$reason" = review_disagreement_decision ] && field=decided_action
  snapshot="$(jq -c --arg reason "$reason" --arg action "$action" --arg field "$field" --arg head "$other_sha" '
    .command.action=$action | .pause.reason=$reason | .pause.record.reason=$reason
    | .pause.record.payload[$field]=$action | .pull_request.head_sha=$head' <<< "$base")"
  check "$reason stale HEAD" stale_head "$snapshot"
done
for pair in 'developer_execution_failed:develop' 'review_disagreement_decision:develop' 'resume_transition_failed:develop'; do
  IFS=: read -r reason action <<< "$pair"
  field=failed_action
  [ "$reason" = review_disagreement_decision ] && field=decided_action
  snapshot="$(jq -c --arg reason "$reason" --arg action "$action" --arg field "$field" --arg head "$other_sha" '
    .command.action=$action | .pause.reason=$reason | .pause.record.reason=$reason
    | .pause.record.payload[$field]=$action | .pull_request.head_sha=$head' <<< "$base")"
  check "$reason develop changed HEAD" prepared "$snapshot"
done
check resume-transition-validate prepared "$(jq -c --arg head "$other_sha" '
  .command.action="validate" | .pause.reason="resume_transition_failed"
  | .pause.record.reason="resume_transition_failed"
  | .pause.record.payload.failed_action="validate" | .pull_request.head_sha=$head' <<< "$base")"
check closed-issue invalid_target "$(jq -c '.closing_issue.state="closed"' <<< "$base")"
check wrong-base invalid_target "$(jq -c '.pull_request.base_ref="release"' <<< "$base")"
check wrong-target invalid_target "$(jq -c '.target="pr:38" | .pause.record.target="pr:38"' <<< "$base")"
check active-source-mismatch invalid_pause_payload "$(jq -c '.pause.record.reason="validation_failed"' <<< "$base")"
check accepted-source invalid_pause_payload "$(jq -c '.pause.record.kind="ai-resume-accepted"' <<< "$base")"
check missing-source-head invalid_pause_payload "$(jq -c '.pause.record.paused_head=null' <<< "$base")"
check normalization-source invalid_pause_payload "$(jq -c '.pause.record.kind="pause-normalization"' <<< "$base")"
check normalization prepared "$(jq -c '.pause.record.kind="pause-normalization" | .pause.record.source_pause_id="123455"' <<< "$base")"
check disallowed-action action_not_allowed "$(jq -c '.command.action="develop"' <<< "$base")"

issue_snapshot="$(jq -c 'del(.pause.record.paused_head) | .command.action="develop" | .target="issue:36" | .pause.record.target="issue:36" | .pull_request=null | .pause.reason="diff_guard_error" | .pause.record.reason="diff_guard_error"' <<< "$base")"
check issue-target prepared "$issue_snapshot"
jq -e '.dispatch.pr_number == null and .dispatch.prepared_head == null and .dispatch.paused_head == null' "$test_dir/output" > /dev/null

invalid extra-field "$(jq -c '.extra=true' <<< "$base")"
invalid unknown-state "$(jq -c '.pull_request.state="draft"' <<< "$base")"
invalid malformed-command "$(jq -c 'del(.command.actor)' <<< "$base")"
invalid multiple-values "$base"$'\n'"$base"
invalid non-object '[]'
echo 'PREPARE policy fixture tests passed.'
