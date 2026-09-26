#!/usr/bin/env bash
set -euo pipefail

helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/evaluate-current-head-validation.sh"
sha_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
sha_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

base="$(jq -cn --arg a "$sha_a" '{
  automated_followup_count: 1,
  branch_mutating_runs: [{id: 10, sha: $a, status: "success"}],
  branch_mutating_runs_complete: true,
  checks: [{id: 20, name: "PR Traceability / Linked Issue", sha: $a, created_at: 1008,
            started_at: 1010, status: "success"}],
  checks_complete: true,
  current_head_sha: $a,
  diff_guard_passed: true,
  followup_gate_passed: true,
  human_pause: false,
  now: 1050,
  ready_started_at: 1005,
  repository_write: "pushed",
  requirements_gate_passed: true,
  validation_sha: $a,
  window_started_at: 1000
}')"

assert_decision() {
  local name="$1" expected_action="$2" expected_code="$3" snapshot="$4" actual
  actual="$(printf '%s\n' "$snapshot" | bash "$helper")"
  if ! jq -es --arg action "$expected_action" --arg code "$expected_code" \
    'length == 1 and .[0] == {action: $action, code: $code}' <<< "$actual" > /dev/null; then
    echo "Wrong current-head validation decision for $name: $actual" >&2
    exit 1
  fi
}

case_snapshot() { jq -c "$1" <<< "$base"; }

assert_decision success ready success "$base"
assert_decision no-diff ready success "$(case_snapshot '.repository_write = "no_diff"')"
assert_decision second-round ready success "$(case_snapshot '.automated_followup_count = 2')"
assert_decision check-pending wait pending "$(case_snapshot '.checks[0].status = "pending"')"
assert_decision run-pending wait pending "$(case_snapshot '.branch_mutating_runs[0].status = "pending"')"
assert_decision checks-incomplete wait pending "$(case_snapshot '.checks_complete = false')"
assert_decision runs-incomplete wait pending "$(case_snapshot '.branch_mutating_runs_complete = false')"
assert_decision traceability-missing wait pending "$(case_snapshot '.checks = []')"
assert_decision check-failed stop validation_failed "$(case_snapshot '.checks[0].status = "failure"')"
assert_decision run-failed stop validation_failed "$(case_snapshot '.branch_mutating_runs[0].status = "failure"')"
assert_decision immediate-failure stop validation_failed "$(case_snapshot '.checks[0].status = "failure" | .now = 1011')"
assert_decision pending-timeout stop validation_timeout "$(case_snapshot '.checks[0].status = "pending" | .now = 1600')"
assert_decision run-timeout stop validation_timeout "$(case_snapshot '.branch_mutating_runs[0].status = "pending" | .now = 1600')"
assert_decision deadline stop validation_timeout "$(case_snapshot '.now = 1600')"
assert_decision gate-failed stop validation_failed "$(case_snapshot '.requirements_gate_passed = false')"
assert_decision diff-guard-failed stop validation_failed "$(case_snapshot '.diff_guard_passed = false')"
assert_decision followup-gate-failed stop validation_failed "$(case_snapshot '.followup_gate_passed = false')"
assert_decision write-missing stop invalid_snapshot "$(case_snapshot '.repository_write = "missing"')"
assert_decision human-pause stop human_pause "$(case_snapshot '.human_pause = true')"
assert_decision round-limit stop round_limit "$(case_snapshot '.automated_followup_count = 3')"

# A new HEAD needs fresh checks and a matching validation SHA. Its original
# write time remains fixed even when the new HEAD later qualifies.
changed_head="$(jq -c --arg b "$sha_b" '.current_head_sha = $b | .checks += [{id: 21, name: "PR Traceability / Linked Issue", sha: $b, created_at: 1019, started_at: 1020, status: "pending"}] | .branch_mutating_runs += [{id: 11, sha: $b, status: "pending"}]' <<< "$base")"
assert_decision stale-head wait stale_head "$changed_head"
assert_decision new-head-pending wait pending "$(jq -c --arg b "$sha_b" '.validation_sha = $b' <<< "$changed_head")"
new_head_success="$(jq -c --arg b "$sha_b" '.validation_sha = $b | .checks[1].status = "success" | .branch_mutating_runs[1].status = "success" | .now = 1599' <<< "$changed_head")"
assert_decision new-head-success ready success "$new_head_success"
assert_decision stale-head-timeout stop validation_timeout "$(jq -c '.now = 1600' <<< "$changed_head")"
assert_decision new-head-timeout stop validation_timeout "$(jq -c '.now = 1600' <<< "$new_head_success")"

# Draft synchronize can produce a skipped check on the same HEAD. Only a
# distinct check run started after the trusted Ready boundary is evidence.
draft_skip="$(case_snapshot '.checks = [{id:19,name:"PR Traceability / Linked Issue",sha:.current_head_sha,created_at:1001,started_at:1002,status:"failure"}]')"
assert_decision draft-skip-ready-unseen wait pending "$draft_skip"
assert_decision ready-check-success ready success "$(jq -c '.checks += [{id:20,name:"PR Traceability / Linked Issue",sha:.current_head_sha,created_at:1005,started_at:1006,status:"success"}]' <<< "$draft_skip")"
assert_decision ready-check-failed stop validation_failed "$(jq -c '.checks += [{id:20,name:"PR Traceability / Linked Issue",sha:.current_head_sha,created_at:1005,started_at:1006,status:"failure"}]' <<< "$draft_skip")"
assert_decision ready-queued wait pending "$(jq -c '.checks += [{id:20,name:"PR Traceability / Linked Issue",sha:.current_head_sha,created_at:1006,started_at:null,status:"pending"}]' <<< "$draft_skip")"
assert_decision ready-boundary-after-deadline stop invalid_snapshot "$(case_snapshot '.ready_started_at = 1601')"

# Unknown API/check states and malformed or partial snapshots cannot qualify.
assert_decision api-failure stop invalid_snapshot "$(case_snapshot '.checks[0].status = "error"')"
assert_decision unknown-check stop invalid_snapshot "$(case_snapshot '.checks[0].status = "neutral"')"
assert_decision unknown-run stop invalid_snapshot "$(case_snapshot '.branch_mutating_runs[0].status = "unknown"')"
assert_decision missing-field stop invalid_snapshot "$(case_snapshot 'del(.checks_complete)')"
assert_decision duplicate-check stop invalid_snapshot "$(case_snapshot '.checks += [.checks[0]]')"
assert_decision duplicate-run stop invalid_snapshot "$(case_snapshot '.branch_mutating_runs += [.branch_mutating_runs[0]]')"
assert_decision future-window stop invalid_snapshot "$(case_snapshot '.now = 999')"
assert_decision extra-field stop invalid_snapshot "$(case_snapshot '.codex_report = "tests passed"')"
assert_decision empty-input stop invalid_snapshot ''
assert_decision malformed-input stop invalid_snapshot '{'
assert_decision multiple-values stop invalid_snapshot "$base"$'\n'"$base"

echo 'evaluate-current-head-validation tests passed.'
