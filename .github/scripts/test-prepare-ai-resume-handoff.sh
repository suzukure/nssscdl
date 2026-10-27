#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$root/prepare-ai-resume-handoff.sh"
head_sha="$(printf 'a%.0s' {1..40})"
input="$(jq -cn --arg sha "$head_sha" '{
  command:{result:"accepted",action:"handoff",actor:"suzukure",pause_id:"101",pr_number:500,head_sha:$sha},
  target:"issue:278",closing_issue:{number:278,state:"open"},
  pause:{result:"active",pause_id:"101",reason:"developer_execution_failed",
    record:{version:1,kind:"pause",target:"issue:278",reason:"developer_execution_failed",
      payload:{failed_action:"develop",diagnostic_code:"developer_timeout"}}},
  pull_request:{number:500,state:"open",draft:true,author_login:"suzukure",
    head_repo:"suzukure/nssscdl",base_repo:"suzukure/nssscdl",base_ref:"main",head_sha:$sha,
    closing_issue_numbers:[278],writer_runs_terminal:true,checks:{current_head:$sha,result:"success"}}
}')"
output="$(printf '%s\n' "$input" | bash "$helper")"
jq -e --arg sha "$head_sha" '. == {
  result:"prepared_snapshot_only",write_authorized:false,target:"issue:278",actor:"suzukure",
  source_pause_id:"101",pr_number:500,pr_head:$sha,closing_issue_number:278}' <<< "$output" >/dev/null
fail() { if printf '%s\n' "$2" | bash "$helper" > /dev/null 2>&1; then echo "accepted invalid case: $1" >&2; exit 1; fi; }
for row in \
  '.command.actor = "stranger"' \
  '.command.action = "develop"' \
  '.command.pause_id = "0101"' \
  '.command.pr_number = 0' \
  '.command.head_sha = "bad"' \
  '.target = "pr:278"' \
  '.closing_issue.number = 279' \
  '.closing_issue.state = "closed"' \
  '.pause.reason = "round_limit"' \
  '.pause.record.payload.failed_action = "review"' \
  '.pause.record.target = "pr:278"' \
  '.pause.record.kind = "ai-resume-accepted"' \
  '.pull_request.author_login = "developer[bot]"' \
  '.pull_request.state = "closed"' \
  '.pull_request.draft = false' \
  '.pull_request.base_ref = "feature"' \
  '.pull_request.head_repo = "other/repo"' \
  '.pull_request.head_sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' \
  '.pull_request.closing_issue_numbers = [278,279]' \
  '.pull_request.writer_runs_terminal = false' \
  '.pull_request.checks.result = "pending"' \
  '.pull_request.checks.current_head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' \
  '.pull_request.extra = 1' \
  '.command.unknown = true'; do
  fail "$row" "$(jq -c "$row" <<< "$input")"
done
fail multiple-json $'{}\n{}'
echo 'prepare-ai-resume-handoff tests passed.'
