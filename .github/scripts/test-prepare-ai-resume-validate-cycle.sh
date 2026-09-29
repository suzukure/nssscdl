#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$root/.github/scripts/prepare-ai-resume-validate-cycle.sh"
a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
base="$(jq -cn --arg a "$a" '
  {accepted:{record_id:"201",created_at:1000,
    identity:{action:"validate",closing_issue_number:36,command_comment_id:"150",head:$a,
      pr_number:37,reason:"validation_failed",source_pause_id:"101",target:"pr:37"},
    record:{version:1,kind:"ai-resume-accepted",reason:"validation_failed",target:"pr:37",
      source_pause_id:"101",payload:{action:"validate",accepted_actor:"alice",
        command_comment_id:"150",accepted_head:$a}}},
   active_pause:"none",cycle:null,issue_label_absent:true,pr_label_absent:true,
   normal_review_suppressed:true,source_consumed:true,
   validation:{automated_followup_count:1,branch_mutating_runs:[{id:10,sha:$a,status:"success"}],
     branch_mutating_runs_complete:true,
     checks:[{id:20,name:"PR Traceability / Linked Issue",sha:$a,
       created_at:1010,started_at:1020,status:"pending"}],checks_complete:true,
     current_head_sha:$a,diff_guard_passed:true,followup_gate_passed:true,
     human_pause:false,now:1050,ready_started_at:1010,repository_write:"pushed",
     requirements_gate_passed:true,validation_sha:$a}}')"
assert() {
  local name="$1" action="$2" code="$3" input="$4" actual
  actual="$(bash "$helper" <<< "$input")"
  jq -e --arg action "$action" --arg code "$code" \
    '.action == $action and .code == $code and
     (if .cycle then .cycle.window_started_at == 1000 and
       .cycle.accepted_record_id == "201" else true end) and
     (if .cycle then .observation.current_head_sha != null and
       .observation.ready_started_at != null and
       (.observation | has("checks_complete")) else true end) and
     (if .action == "handoff_candidate" then
       .current_validated_sha == .handoff.validated_sha and
       .current_validated_sha == .cycle.identity.head and
       .handoff.action == "review" else
       .current_validated_sha == null and (has("handoff") | not) end)' \
    <<< "$actual" >/dev/null || { echo "Bad $name: $actual" >&2; exit 1; }
}
case_input() { jq -c "$1" <<< "$base"; }
assert pending wait pending "$base"
assert success handoff_candidate success "$(case_input '.validation.checks[0].status="success"')"
assert failed pause_record validation_failed "$(case_input '.validation.checks[0].status="failure"')"
assert before-deadline wait pending "$(case_input '.validation.now=1599')"
assert deadline pause_record validation_timeout "$(case_input '.validation.now=1600')"
assert failure-at-deadline pause_record validation_failed "$(case_input '.validation.now=1600 | .validation.checks[0].status="failure"')"
cycle="$(bash "$helper" <<< "$base" | jq -c .cycle)"
assert duplicate wait pending "$(jq -c --argjson cycle "$cycle" '.cycle=$cycle | .validation.now=1051' <<< "$base")"
assert changed-head requalify changed_head "$(jq -c --arg b "$b" '.validation.current_head_sha=$b' <<< "$base")"
assert changed-head-deadline requalify changed_head "$(jq -c --arg b "$b" '.validation.current_head_sha=$b | .validation.now=1600' <<< "$base")"
assert mismatched-cycle stop invalid_snapshot "$(jq -c --argjson cycle "$cycle" '.cycle=$cycle | .cycle.window_started_at=1100' <<< "$base")"
assert stale-check wait pending "$(case_input '.validation.checks[0].status="success" | .validation.checks[0].started_at=999')"
assert incomplete wait pending "$(case_input '.validation.checks_complete=false')"
assert api-failure stop invalid_snapshot "$(case_input '.validation.checks[0].status="unknown"')"
assert human-pause stop already_paused "$(case_input '.active_pause="other"')"
assert source-unconsumed stop source_not_consumed "$(case_input '.source_consumed=false')"
assert round-limit pause_record round_limit "$(case_input '.validation.automated_followup_count=3')"
assert no-review-suppression stop review_suppression_unverified "$(case_input '.normal_review_suppressed=false')"
assert stale-ready stop stale_ready "$(case_input '.validation.ready_started_at=999')"
assert forged-gate stop invalid_snapshot "$(case_input 'del(.validation.requirements_gate_passed)')"
assert wrong-sha wait stale_head "$(case_input '.validation.validation_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')"
# The helper is prepared only: no production entry, write, dispatch, or paid call.
if rg -n 'prepare-ai-resume-validate-cycle\.sh|ai-resume-validate' "$root/.github/workflows"; then
  echo 'Validate cycle is production reachable.' >&2; exit 1
fi
if rg -n '\bgh\b|curl|git push|repository_dispatch|claude|codex' "$helper" | rg -v '^.*#|normal_trusted_review'; then
  echo 'Validate cycle has an external call.' >&2; exit 1
fi
echo 'prepare-ai-resume-validate-cycle fixture passed.'
