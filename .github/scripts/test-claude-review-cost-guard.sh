#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/.github/scripts/evaluate-claude-review-cost-guard.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

write_runs() {
  local path="$1"
  shift
  jq -cn --argjson runs "$1" --arg repo 'owner/repo' \
    '{workflow_runs: ($runs | map(. + {head_repository: {full_name: $repo}, run_attempt: (.run_attempt // 1), run_started_at: (.run_started_at // .created_at)}))}' > "$path"
}

run_guard() {
  bash "$guard" "$1" "$2" owner/repo
}

normal='[
  {"id":1,"head_branch":"ai/issue-387","status":"completed","conclusion":"success","created_at":"2026-09-20T10:00:00Z"},
  {"id":2,"head_branch":"ai/issue-387","status":"completed","conclusion":"success","created_at":"2026-09-20T10:05:00Z"},
  {"id":3,"head_branch":"ai/issue-387","status":"in_progress","conclusion":null,"created_at":"2026-09-20T10:10:00Z"}
]'
write_runs "$test_dir/normal.json" "$normal"
run_guard "$test_dir/normal.json" 3 | jq -e '.result == "no_notify" and .run_count == 3 and .cancelled_count == 0' > /dev/null

burst='[
  {"id":1,"head_branch":"ops/issue-378-af-unix-socket-mask","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T10:00:00Z"},
  {"id":2,"head_branch":"ops/issue-378-af-unix-socket-mask","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T10:03:00Z"},
  {"id":3,"head_branch":"ops/issue-378-af-unix-socket-mask","status":"completed","conclusion":"success","created_at":"2026-09-20T10:06:00Z"},
  {"id":4,"head_branch":"ops/issue-378-af-unix-socket-mask","status":"in_progress","conclusion":null,"created_at":"2026-09-20T10:09:00Z"},
  {"id":5,"head_branch":"ops/issue-378-af-unix-socket-mask","status":"in_progress","conclusion":null,"created_at":"2026-09-20T10:11:00Z"}
]'
write_runs "$test_dir/burst.json" "$burst"
run_guard "$test_dir/burst.json" 4 | jq -e '.result == "notify" and .trigger == "review_burst" and .run_count == 4' > /dev/null
run_guard "$test_dir/burst.json" 5 | jq -e '.result == "no_notify" and .run_count == 5' > /dev/null

rerun='[
  {"id":6,"run_attempt":1,"head_branch":"ops/issue-rerun","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T09:59:00Z"},
  {"id":6,"run_attempt":2,"head_branch":"ops/issue-rerun","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:00:00Z"},
  {"id":6,"run_attempt":3,"head_branch":"ops/issue-rerun","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:04:00Z"},
  {"id":6,"run_attempt":4,"head_branch":"ops/issue-rerun","status":"in_progress","conclusion":null,"created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:08:00Z"}
]'
write_runs "$test_dir/rerun.json" "$rerun"
run_guard "$test_dir/rerun.json" 6 | jq -e '.result == "notify" and .trigger == "review_burst" and .run_count == 4' > /dev/null

rerun_timestamp='[
  {"id":7,"run_attempt":1,"head_branch":"ops/issue-rerun-timestamp","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T09:00:00Z"},
  {"id":7,"run_attempt":2,"head_branch":"ops/issue-rerun-timestamp","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:00:00Z"},
  {"id":7,"run_attempt":3,"head_branch":"ops/issue-rerun-timestamp","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:04:00Z"},
  {"id":7,"run_attempt":4,"head_branch":"ops/issue-rerun-timestamp","status":"in_progress","conclusion":null,"created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:08:00Z"}
]'
write_runs "$test_dir/rerun-timestamp.json" "$rerun_timestamp"
run_guard "$test_dir/rerun-timestamp.json" 7 | jq -e '.result == "no_notify" and .run_count == 3' > /dev/null

cancel_storm='[
  {"id":11,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:00:00Z"},
  {"id":12,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:04:00Z"},
  {"id":13,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:08:00Z"},
  {"id":14,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:10:00Z"}
]'
write_runs "$test_dir/cancel-storm.json" "$cancel_storm"
run_guard "$test_dir/cancel-storm.json" 13 | jq -e '.result == "notify" and .trigger == "cancel_storm" and .cancelled_count == 3' > /dev/null
run_guard "$test_dir/cancel-storm.json" 14 | jq -e '.result == "no_notify" and .cancelled_count == 4' > /dev/null

skipped='[
  {"id":21,"head_branch":"ai/issue-390","status":"completed","conclusion":"skipped","created_at":"2026-09-20T12:00:00Z"},
  {"id":22,"head_branch":"ai/issue-390","status":"completed","conclusion":"skipped","created_at":"2026-09-20T12:03:00Z"},
  {"id":23,"head_branch":"ai/issue-390","status":"completed","conclusion":"skipped","created_at":"2026-09-20T12:06:00Z"},
  {"id":24,"head_branch":"ai/issue-390","status":"in_progress","conclusion":null,"created_at":"2026-09-20T12:09:00Z"}
]'
write_runs "$test_dir/skipped.json" "$skipped"
run_guard "$test_dir/skipped.json" 24 | jq -e '.result == "no_notify" and .run_count == 1' > /dev/null

different_branch='[
  {"id":31,"head_branch":"ai/issue-a","status":"completed","conclusion":"success","created_at":"2026-09-20T13:00:00Z"},
  {"id":32,"head_branch":"ai/issue-b","status":"completed","conclusion":"success","created_at":"2026-09-20T13:02:00Z"},
  {"id":33,"head_branch":"ai/issue-c","status":"completed","conclusion":"success","created_at":"2026-09-20T13:04:00Z"},
  {"id":34,"head_branch":"ai/issue-d","status":"in_progress","conclusion":null,"created_at":"2026-09-20T13:06:00Z"}
]'
write_runs "$test_dir/different-branch.json" "$different_branch"
run_guard "$test_dir/different-branch.json" 34 | jq -e '.result == "no_notify" and .run_count == 1' > /dev/null

foreign='[{"id":35,"run_attempt":1,"head_branch":"feature/fork","status":"in_progress","conclusion":null,"created_at":"2026-09-20T13:07:00Z","run_started_at":"2026-09-20T13:07:00Z","head_repository":{"full_name":"fork/repo"}}]'
jq -cn --argjson runs "$foreign" '{workflow_runs: $runs}' > "$test_dir/foreign.json"
run_guard "$test_dir/foreign.json" 35 | jq -e '.result == "ignored" and .reason == "current_run_head_repository_not_current_repository"' > /dev/null

printf '%s\n' '{"workflow_runs":[{"id":41,"status":"in_progress"}]}' > "$test_dir/malformed.json"
run_guard "$test_dir/malformed.json" 41 | jq -e '.result == "diagnostic" and .reason == "workflow_run_metadata_incomplete"' > /dev/null

echo 'Claude Review Cost Guard fixture tests passed.'
