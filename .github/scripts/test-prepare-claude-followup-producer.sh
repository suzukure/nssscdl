#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/prepare-claude-followup-producer.sh"
workflow="$repo_root/.github/workflows/ai-developer.yml"
claude_workflow="$repo_root/.github/workflows/claude-review.yml"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir "$test_dir/bin"
cat > "$test_dir/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'api repos/owner/repo/pulls/37/reviews/41')
    printf '%s\n' '{"id":41,"state":"CHANGES_REQUESTED","commit_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","user":{"login":"reviewer[bot]"}}' ;;
  'pr view 37 --repo owner/repo --json number,state,headRefOid,headRefName,labels,closingIssuesReferences')
    jq -cn --arg state "${MOCK_PR_STATE:-OPEN}" --arg sha "${MOCK_HEAD:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" \
      '{number:37,state:$state,headRefOid:$sha,headRefName:"ai/issue-36",labels:[],closingIssuesReferences:[{number:36,url:"https://github.com/owner/repo/issues/36"}]}' ;;
  'api repos/owner/repo/issues/36')
    jq -cn --arg state "${MOCK_ISSUE_STATE:-open}" \
      '{number:36,state:$state,labels:[]}' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$test_dir/bin/gh"
export PATH="$test_dir/bin:$PATH"
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
entry="$(jq -cn --arg sha "$sha" '{repo:"owner/repo",pr_number:37,review_id:41,
  review_commit:$sha,checked_out_sha:$sha,machine_label:false,
  reviewer_slug:"reviewer",head_ref:"ai/issue-36",round:1,
  developer_gate_passed:true,requirements_gate_passed:true,diff_guard_passed:true}')"

assert() {
  local name="$1" phase="$2" snapshot="$3" expected="$4" actual
  actual="$(bash "$helper" "$phase" <<< "$snapshot")"
  if ! jq -es --argjson expected "$expected" 'length == 1 and .[0] == $expected' \
    <<< "$actual" >/dev/null; then
    echo "Wrong producer decision for $name: $actual" >&2
    exit 1
  fi
}
case_entry() { jq -c "$1" <<< "$entry"; }
assert entry entry "$entry" '{"action":"add_machine_label","label":"ai-followup-in-progress"}'
assert second-round entry "$(case_entry '.round = 2')" '{"action":"add_machine_label","label":"ai-followup-in-progress"}'
assert third-round entry "$(case_entry '.round = 3')" '{"action":"pause_record","code":"round_limit"}'
assert third-round-gate-stopped entry "$(case_entry '.round = 3 | .developer_gate_passed = false')" '{"action":"pause_record","code":"round_limit"}'
assert third-round-labeled entry "$(case_entry '.round = 3 | .machine_label = true')" '{"action":"pause_record","code":"round_limit"}'
assert failed-gate entry "$(case_entry '.developer_gate_passed = false')" '{"action":"stop","code":"followup_gate_failed"}'
assert stale-checkout entry "$(case_entry '.checked_out_sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')" '{"action":"stop","code":"stale_checkout"}'
assert preexisting-machine-label entry "$(case_entry '.machine_label = true')" '{"action":"stop","code":"machine_label_present"}'
MOCK_PR_STATE=CLOSED assert closed-pr entry "$entry" '{"action":"stop","code":"stale_target"}'
MOCK_ISSUE_STATE=closed assert closed-issue entry "$entry" '{"action":"stop","code":"stale_target"}'
MOCK_HEAD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb assert moved-head entry "$entry" '{"action":"stop","code":"stale_target"}'
assert label-failed machine_label_result '{"label_present":false,"transition_succeeded":false}' '{"action":"stop","code":"machine_label_failed"}'
assert label-ready machine_label_result '{"label_present":true,"transition_succeeded":true}' '{"action":"check_pre_codex_target"}'
assert label-partial machine_label_result '{"label_present":true,"transition_succeeded":false}' '{"action":"pause_record","code":"state_inconsistent"}'
assert label-unknown machine_label_result '{"label_present":false,"transition_succeeded":true}' '{"action":"pause_record","code":"state_inconsistent"}'
assert label-result-malformed machine_label_result '{"label_present":true}' '{"action":"pause_record","code":"state_inconsistent"}'
labeled_entry="$(case_entry '.machine_label = true')"
assert fresh-pre-codex pre_codex "$labeled_entry" '{"action":"paid_codex"}'
MOCK_HEAD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb assert moved-before-codex pre_codex "$labeled_entry" '{"action":"pause_record","code":"state_inconsistent"}'
MOCK_PR_STATE=CLOSED assert closed-before-codex pre_codex "$labeled_entry" '{"action":"pause_record","code":"state_inconsistent"}'
MOCK_ISSUE_STATE=closed assert issue-closed-before-codex pre_codex "$labeled_entry" '{"action":"pause_record","code":"state_inconsistent"}'
assert missing-label-before-codex pre_codex "$entry" '{"action":"pause_record","code":"state_inconsistent"}'
assert fresh-write pre_write "$labeled_entry" '{"action":"repository_write"}'
assert requirements-stop pre_write "$(jq -c '.requirements_gate_passed = false' <<< "$labeled_entry")" '{"action":"pause_record","code":"requirements_change"}'
assert diff-stop pre_write "$(jq -c '.diff_guard_passed = false' <<< "$labeled_entry")" '{"action":"pause_record","code":"diff_guard_error"}'
assert missing-label-before-write pre_write "$entry" '{"action":"pause_record","code":"state_inconsistent"}'
MOCK_HEAD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb assert stale-write pre_write "$labeled_entry" '{"action":"pause_record","code":"state_inconsistent"}'
MOCK_PR_STATE=CLOSED assert closed-before-write pre_write "$labeled_entry" '{"action":"pause_record","code":"state_inconsistent"}'
MOCK_ISSUE_STATE=closed assert issue-closed-before-write pre_write "$labeled_entry" '{"action":"pause_record","code":"state_inconsistent"}'

written="$(jq -cn --arg sha "$sha" '{repository_write:"pushed",expected_sha:$sha,
  current_head_sha:$sha,machine_label:true,now:1050,window_started_at:1000}')"
assert pushed written "$written" "$(jq -cn --arg sha "$sha" '{action:"ready_pr",validated_sha:$sha,window_started_at:1000}')"
assert no-diff written "$(jq -c '.repository_write = "no_diff"' <<< "$written")" "$(jq -cn --arg sha "$sha" '{action:"ready_pr",validated_sha:$sha,window_started_at:1000}')"
assert head-not-converged written "$(jq -c '.current_head_sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' <<< "$written")" '{"action":"pause_record","code":"state_inconsistent"}'
assert written-expired written "$(jq -c '.now = 1600' <<< "$written")" '{"action":"pause_record","code":"validation_timeout"}'
assert written-invalid written "$(jq -c 'del(.now)' <<< "$written")" '{"action":"pause_record","code":"state_inconsistent"}'
assert ready-success ready_result '{"machine_label":true,"now":1050,"ready_started_at":1030,"ready_succeeded":true,"window_started_at":1000}' '{"action":"validate","ready_started_at":1030,"window_started_at":1000}'
assert ready-failure ready_result '{"machine_label":true,"now":1050,"ready_started_at":1030,"ready_succeeded":false,"window_started_at":1000}' '{"action":"pause_record","code":"state_inconsistent"}'
assert ready-expired ready_result '{"machine_label":true,"now":1600,"ready_started_at":1599,"ready_succeeded":true,"window_started_at":1000}' '{"action":"pause_record","code":"validation_timeout"}'
assert ready-invalid ready_result '{"machine_label":true,"ready_started_at":1030,"ready_succeeded":true,"window_started_at":1000}' '{"action":"pause_record","code":"state_inconsistent"}'

snapshot="$(jq -cn --arg sha "$sha" '{automated_followup_count:1,
  branch_mutating_runs:[],branch_mutating_runs_complete:true,
  checks:[{id:20,name:"Linked Issue",head_sha:$sha,created_at:1031,started_at:null,
           status:"completed",conclusion:"success"}],checks_complete:true,
  current_head_sha:$sha,diff_guard_passed:true,followup_gate_passed:true,
  human_pause:false,machine_label:true,now:1050,pr_number:37,ready_started_at:1030,
  repository_write:"pushed",requirements_gate_passed:true,validation_sha:$sha,
  window_started_at:1000}')"
case_validation() { jq -c "$1" <<< "$snapshot"; }
dispatch="$(jq -cn --arg sha "$sha" '{action:"dispatch",event_type:"claude-auto-rereview",
  client_payload:{pr_number:37,validated_sha:$sha,round:1}}')"
assert validated validate "$snapshot" "$dispatch"
jq -e '.client_payload | (keys | length) <= 10' <<< "$dispatch" >/dev/null
[ "$(printf '%s' "$dispatch" | wc -c)" -le 65535 ]
assert no-diff-validates validate "$(case_validation '.repository_write = "no_diff"')" "$dispatch"
assert missing-check validate "$(case_validation '.checks = []')" '{"action":"wait","code":"pending"}'
assert queued validate "$(case_validation '.checks[0].status = "queued" | .checks[0].conclusion = null')" '{"action":"wait","code":"pending"}'
assert in-progress validate "$(case_validation '.checks[0].status = "in_progress" | .checks[0].conclusion = null')" '{"action":"wait","code":"pending"}'
assert failed-check validate "$(case_validation '.checks[0].conclusion = "failure"')" '{"action":"pause_record","code":"validation_failed"}'
assert skipped-after-ready validate "$(case_validation '.checks[0].conclusion = "skipped"')" '{"action":"pause_record","code":"validation_failed"}'
assert draft-skipped validate "$(case_validation '.checks[0].created_at = 1001 | .checks[0].conclusion = "skipped"')" '{"action":"wait","code":"pending"}'
assert expired validate "$(case_validation '.now = 1600')" '{"action":"pause_record","code":"validation_timeout"}'
assert deadline-not-reset validate "$(case_validation '.now = 1600 | .ready_started_at = 1599')" '{"action":"pause_record","code":"validation_timeout"}'
assert stale-head validate "$(case_validation '.current_head_sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')" '{"action":"wait","code":"stale_head"}'
assert api-invalid validate "$(case_validation '.checks_complete = null')" '{"action":"pause_record","code":"state_inconsistent"}'
assert unknown-status validate "$(case_validation '.checks[0].status = "unknown"')" '{"action":"pause_record","code":"state_inconsistent"}'
assert dispatch-success dispatch_result '{"dispatch_succeeded":true,"machine_label":true}' '{"action":"await_consumer"}'
assert dispatch-failure dispatch_result '{"dispatch_succeeded":false,"machine_label":true}' '{"action":"pause_record","code":"state_inconsistent"}'
assert dispatch-unknown dispatch_result '{"dispatch_succeeded":null,"machine_label":true}' '{"action":"pause_record","code":"state_inconsistent"}'
assert pause-first pause_recorded '{"active_pause_id":41,"recorded_pause_id":42}' '{"action":"stop","code":"pause_not_active"}'
assert cleanup pause_recorded '{"active_pause_id":41,"recorded_pause_id":41}' '{"action":"remove_machine_label","label":"ai-followup-in-progress"}'

# Consumer activation is absent: neither production workflow may reach the
# prepared producer or dedicated dispatch. Ready suppression may read its label.
for production_workflow in "$workflow" "$claude_workflow"; do
  if [ ! -f "$production_workflow" ] || [ ! -r "$production_workflow" ]; then
    echo "Production workflow is missing or unreadable: $production_workflow" >&2
    exit 1
  fi
done
if grep -Eq 'prepare-claude-followup-producer|claude-auto-rereview' \
  "$workflow" "$claude_workflow"; then
  search_rc=0
else
  search_rc=$?
fi
case "$search_rc" in
  0)
    echo 'Dormant producer became reachable from a production workflow.' >&2
    exit 1 ;;
  1) ;;
  *)
    echo "Production workflow search failed (exit $search_rc)." >&2
    exit 1 ;;
esac
echo 'Prepared Claude follow-up producer fixtures passed.'
