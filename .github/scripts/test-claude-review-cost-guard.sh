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
  local activity attempt
  if [ "$#" -ge 3 ]; then
    activity="$3"
  elif ! activity="$(jq -er --argjson id "$2" '.workflow_runs | map(select(.id == $id)) | max_by(.run_attempt).status | select(type == "string")' "$1")"; then
    echo "Unable to derive workflow activity for fixture $1." >&2
    return 1
  fi
  if ! attempt="$(jq -er --argjson id "$2" '.workflow_runs | map(select(.id == $id)) | max_by(.run_attempt).run_attempt | select(type == "number")' "$1")"; then
    echo "Unable to derive workflow attempt for fixture $1." >&2
    return 1
  fi
  bash "$guard" "$1" "$2" owner/repo "$activity" "$attempt"
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

rolling_burst='[
  {"id":101,"head_branch":"ops/issue-rolling-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:00:00Z"},
  {"id":102,"head_branch":"ops/issue-rolling-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:04:30Z"},
  {"id":103,"head_branch":"ops/issue-rolling-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:09:00Z"},
  {"id":104,"head_branch":"ops/issue-rolling-burst","status":"in_progress","conclusion":null,"created_at":"2026-09-20T10:13:30Z"},
  {"id":105,"head_branch":"ops/issue-rolling-burst","status":"in_progress","conclusion":null,"created_at":"2026-09-20T10:18:00Z"},
  {"id":106,"head_branch":"ops/issue-rolling-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:40:00Z"},
  {"id":107,"head_branch":"ops/issue-rolling-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:44:30Z"},
  {"id":108,"head_branch":"ops/issue-rolling-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:49:00Z"},
  {"id":109,"head_branch":"ops/issue-rolling-burst","status":"in_progress","conclusion":null,"created_at":"2026-09-20T10:53:30Z"}
]'
write_runs "$test_dir/rolling-burst.json" "$rolling_burst"
run_guard "$test_dir/rolling-burst.json" 104 | jq -e '.result == "notify" and .trigger == "review_burst" and .run_count == 4' > /dev/null
run_guard "$test_dir/rolling-burst.json" 105 | jq -e '.result == "no_notify" and .run_count == 4' > /dev/null
run_guard "$test_dir/rolling-burst.json" 109 | jq -e '.result == "notify" and .trigger == "review_burst" and .run_count == 4' > /dev/null

completed_burst='[
  {"id":51,"head_branch":"ops/issue-completed-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:00:00Z"},
  {"id":52,"head_branch":"ops/issue-completed-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:03:00Z"},
  {"id":53,"head_branch":"ops/issue-completed-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:06:00Z"},
  {"id":54,"head_branch":"ops/issue-completed-burst","status":"completed","conclusion":"success","created_at":"2026-09-20T10:09:00Z"}
]'
write_runs "$test_dir/completed-burst.json" "$completed_burst"
run_guard "$test_dir/completed-burst.json" 54 in_progress | jq -e '.result == "notify" and .trigger == "review_burst" and .run_count == 4' > /dev/null
run_guard "$test_dir/completed-burst.json" 54 completed | jq -e '.result == "no_notify" and .run_count == 4' > /dev/null

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

prior_rerun='[
  {"id":8,"run_attempt":1,"head_branch":"ops/issue-prior-rerun","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:00:00Z"},
  {"id":8,"run_attempt":2,"head_branch":"ops/issue-prior-rerun","status":"completed","conclusion":"success","created_at":"2026-09-20T09:00:00Z","run_started_at":"2026-09-20T10:05:00Z"},
  {"id":9,"head_branch":"ops/issue-prior-rerun","status":"completed","conclusion":"success","created_at":"2026-09-20T10:10:00Z"},
  {"id":10,"head_branch":"ops/issue-prior-rerun","status":"in_progress","conclusion":null,"created_at":"2026-09-20T10:12:00Z"}
]'
write_runs "$test_dir/prior-rerun.json" "$prior_rerun"
run_guard "$test_dir/prior-rerun.json" 10 | jq -e '.result == "notify" and .trigger == "review_burst" and .run_count == 4' > /dev/null

cancel_storm='[
  {"id":11,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:00:00Z"},
  {"id":12,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:04:00Z"},
  {"id":13,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:08:00Z"},
  {"id":14,"head_branch":"ops/issue-365-service-local-production-hardening","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T11:10:00Z"}
]'
write_runs "$test_dir/cancel-storm.json" "$cancel_storm"
run_guard "$test_dir/cancel-storm.json" 13 | jq -e '.result == "notify" and .trigger == "cancel_storm" and .cancelled_count == 3' > /dev/null
run_guard "$test_dir/cancel-storm.json" 14 | jq -e '.result == "no_notify" and .cancelled_count == 4' > /dev/null

rolling_cancel_storm='[
  {"id":121,"head_branch":"ops/issue-rolling-cancel","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T12:00:00Z"},
  {"id":122,"head_branch":"ops/issue-rolling-cancel","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T12:06:00Z"},
  {"id":123,"head_branch":"ops/issue-rolling-cancel","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T12:12:00Z"},
  {"id":124,"head_branch":"ops/issue-rolling-cancel","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T12:18:00Z"},
  {"id":125,"head_branch":"ops/issue-rolling-cancel","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T12:40:00Z"},
  {"id":126,"head_branch":"ops/issue-rolling-cancel","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T12:46:00Z"},
  {"id":127,"head_branch":"ops/issue-rolling-cancel","status":"completed","conclusion":"cancelled","created_at":"2026-09-20T12:52:00Z"}
]'
write_runs "$test_dir/rolling-cancel-storm.json" "$rolling_cancel_storm"
run_guard "$test_dir/rolling-cancel-storm.json" 123 | jq -e '.result == "notify" and .trigger == "cancel_storm" and .cancelled_count == 3' > /dev/null
run_guard "$test_dir/rolling-cancel-storm.json" 124 | jq -e '.result == "no_notify" and .cancelled_count == 3' > /dev/null
run_guard "$test_dir/rolling-cancel-storm.json" 127 | jq -e '.result == "notify" and .trigger == "cancel_storm" and .cancelled_count == 3' > /dev/null

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

printf '%s\n' '{"workflow_runs":[{"id":41,"run_attempt":1,"status":"in_progress"}]}' > "$test_dir/malformed.json"
run_guard "$test_dir/malformed.json" 41 | jq -e '.result == "diagnostic" and .reason == "workflow_run_metadata_incomplete"' > /dev/null

printf '%s\n' '{"diagnostic_reason":"attempt_retrieval_limit_exceeded"}' > "$test_dir/retrieval-limit.json"
bash "$guard" "$test_dir/retrieval-limit.json" 41 owner/repo in_progress 1 | jq -e '.result == "diagnostic" and .reason == "attempt_retrieval_limit_exceeded"' > /dev/null

echo 'Claude Review Cost Guard fixture tests passed.'
