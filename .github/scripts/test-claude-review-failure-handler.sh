#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workflow="$script_dir/../workflows/claude-review-failure-handler.yml"
grep -Fq 'types: [completed]' "$workflow"
grep -Fq 'ref: ${{ github.event.repository.default_branch }}' "$workflow"
grep -Fq 'persist-credentials: false' "$workflow"
grep -Fq 'cancel-in-progress: false' "$workflow"
if grep -Eq 'pull_request.head.sha|workflow_run.head_sha|gh run rerun|workflow_dispatch|raw.*Claude' "$workflow"; then
  echo 'Handler workflow crosses the trusted boundary or retries.' >&2; exit 1
fi
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export TEST_DIR="$test_dir" GH_TOKEN=fixture REVIEW_APP_TOKEN=fixture
export NOTIFICATION_WEBHOOK_URL='https://discord.invalid/webhook'
head_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export HEAD_SHA="$head_sha"
base64 -w0 "$script_dir/../workflows/claude-review.yml" > "$test_dir/workflow.b64"
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"

gh() {
  local endpoint="${*: -1}" body='' arg id
  case "$1 $2" in
    'api -X')
      for arg in "$@"; do case "$arg" in body=*) body="${arg#body=}" ;; esac; done
      id="$(jq 'length + 101' "$TEST_DIR/comments.json")"
      jq --arg body "$body" --argjson id "$id" \
        '. + [{id:$id,body:$body,performed_via_github_app:{id:99}}]' \
        "$TEST_DIR/comments.json" > "$TEST_DIR/next.json"
      mv "$TEST_DIR/next.json" "$TEST_DIR/comments.json"
      echo record >> "$TEST_DIR/events"
      jq -cn --argjson id "$id" '{id:$id}' ;;
    'api --paginate')
      case "$endpoint" in
        */jobs\?*)
          if [[ "$endpoint" == *'/runs/11/'* ]]; then
            echo '[{"jobs":[{"name":"Review","conclusion":"success"}]}]'
          else
            case "${MOCK_CASE:-failure}" in
              success) conclusion=success ;; skipped) conclusion=skipped ;;
              cancelled) conclusion=cancelled ;; timed_out) conclusion=timed_out ;;
              unknown) conclusion=neutral ;;
              *) conclusion=failure ;;
            esac
            steps='[{"name":"Validate Claude review","conclusion":"success"},{"name":"Signal RUN_BUDGET_LIMIT_REACHED","conclusion":"skipped"},{"name":"Signal ACCOUNT_SPEND_LIMIT_REACHED","conclusion":"skipped"},{"name":"Signal Claude classification complete","conclusion":"success"}]'
            case "${MOCK_CASE:-}" in
              budget) steps='[{"name":"Validate Claude review","conclusion":"success"},{"name":"Signal RUN_BUDGET_LIMIT_REACHED","conclusion":"success"},{"name":"Signal ACCOUNT_SPEND_LIMIT_REACHED","conclusion":"skipped"},{"name":"Signal Claude classification complete","conclusion":"success"}]' ;;
              spend) steps='[{"name":"Validate Claude review","conclusion":"success"},{"name":"Signal RUN_BUDGET_LIMIT_REACHED","conclusion":"skipped"},{"name":"Signal ACCOUNT_SPEND_LIMIT_REACHED","conclusion":"success"},{"name":"Signal Claude classification complete","conclusion":"success"}]' ;;
              interrupted) steps='[]' ;;
              incomplete) steps='[{"name":"Validate Claude review","conclusion":"success"}]' ;;
            esac
            case "${MOCK_CASE:-}" in
              missing_review) echo '[{"jobs":[{"name":"Merge approved PR","conclusion":"failure"}]}]' ;;
              duplicate_review) jq -cn --arg conclusion "$conclusion" --argjson steps "$steps" \
                '[{jobs:[{name:"Review",conclusion:$conclusion,steps:$steps},{name:"Review",conclusion:$conclusion,steps:$steps}]}]' ;;
              *) jq -cn --arg conclusion "$conclusion" --argjson steps "$steps" \
                '[{jobs:[{name:"Review",conclusion:$conclusion,steps:$steps},{name:"Merge approved PR",conclusion:"failure"}]}]' ;;
            esac
          fi ;;
        */files\?*)
          if [ "${MOCK_CASE:-}" = workflow_changed ]; then
            echo '[[{"filename":".github/workflows/claude-review.yml"}]]'
          else echo '[[{"filename":"src/example.txt"}]]'; fi ;;
        */runs\?*)
          if [ "${MOCK_CASE:-}" = newer ]; then
            jq -cn --arg head "$HEAD_SHA" '[{workflow_runs:[{id:11,run_attempt:1,pull_requests:[{number:37,head:{sha:$head}}]}]}]'
          elif [ "${MOCK_CASE:-}" = newer_unassociated ]; then
            echo '[{"workflow_runs":[{"id":11,"run_attempt":1,"head_branch":"ai/issue-36","head_repository":{"full_name":"owner/repo"},"pull_requests":[]}]}]'
          else echo '[{"workflow_runs":[]}]'; fi ;;
        */comments)
          jq -c '[.]' "$TEST_DIR/comments.json" ;;
        *) echo "Unexpected paginated API: $endpoint" >&2; return 2 ;;
      esac ;;
    'api /repos/owner/repo/actions/runs/10')
      attempt=1
      [ "${MOCK_CASE:-}" = older_attempt ] && attempt=2
      jq -cn --arg head "$HEAD_SHA" --argjson attempt "$attempt" \
        '{id:10,name:"Claude Review",path:".github/workflows/claude-review.yml@refs/pull/37/merge",event:"pull_request",head_repository:{full_name:"owner/repo"},head_branch:"ai/issue-36",head_sha:$head,status:"completed",run_attempt:$attempt,workflow_id:5,pull_requests:[{number:37,head:{sha:$head}}]}' ;;
    'api /repos/owner/repo/actions/runs/10/attempts/1')
      echo '{"id":10,"run_attempt":1,"status":"completed"}' ;;
    'api /repos/owner/repo/pulls/37')
      state=open draft=false current_head="$HEAD_SHA"
      [ "${MOCK_CASE:-}" = closed ] && state=closed
      [ "${MOCK_CASE:-}" = draft ] && draft=true
      [ "${MOCK_CASE:-}" = old_head ] && current_head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      jq -cn --arg state "$state" --argjson draft "$draft" --arg head "$current_head" \
        '{number:37,state:$state,draft:$draft,head:{repo:{full_name:"owner/repo"},sha:$head,ref:"ai/issue-36"}}' ;;
    'api /repos/owner/repo/contents/.github/workflows/claude-review.yml?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      if [ "${MOCK_CASE:-}" = legacy ]; then
        echo '{"content":"bGVnYWN5"}'
      else jq -Rs '{content:.}' "$TEST_DIR/workflow.b64"; fi ;;
    'api /apps/reviewer') echo 99 ;;
    'pr view') echo '{"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}' ;;
    'label create') : ;;
    'issue edit') : ;;
    *) echo "Unexpected gh invocation: $*" >&2; return 2 ;;
  esac
}
curl() { echo notify >> "$TEST_DIR/events"; cat > "$TEST_DIR/notification.json"; }
export -f gh curl

run_case() {
  MOCK_CASE="$1"; export MOCK_CASE
  bash "$script_dir/handle-claude-review-failure.sh" owner/repo 10 1 reviewer
}
assert_result() {
  local case_name="$1" expected="$2" result
  result="$(run_case "$case_name")"
  jq -e --arg expected "$expected" '.result == $expected' <<< "$result" > /dev/null
  [ "$(jq 'length' "$test_dir/comments.json")" -eq 0 ]
  [ ! -s "$test_dir/events" ]
}
assert_result success ignored
assert_result skipped ignored
assert_result budget explicit_limit
assert_result spend explicit_limit
assert_result closed stale_pr
assert_result draft stale_pr
assert_result old_head stale_pr
assert_result newer superseded
if run_case workflow_changed > /dev/null 2>&1; then echo 'Changed source workflow was trusted.' >&2; exit 1; fi
if run_case legacy > /dev/null 2>&1; then echo 'Legacy source workflow was trusted.' >&2; exit 1; fi
if run_case older_attempt > /dev/null 2>&1; then echo 'Old attempt was trusted.' >&2; exit 1; fi
for bad_case in missing_review duplicate_review unknown; do
  if run_case "$bad_case" > /dev/null 2>&1; then echo "Invalid $bad_case job was trusted." >&2; exit 1; fi
done
if run_case newer_unassociated > /dev/null 2>&1; then echo 'Unassociated newer run was ignored.' >&2; exit 1; fi
if run_case incomplete > /dev/null 2>&1; then echo 'Incomplete classification was trusted.' >&2; exit 1; fi

for case_name in failure cancelled timed_out interrupted; do
  printf '[]\n' > "$test_dir/comments.json"; : > "$test_dir/events"
  jq -e '.result == "created"' <<< "$(run_case "$case_name")" > /dev/null
  jq -e --arg head "$head_sha" '.[0].body | contains("\"paused_head\":\"" + $head + "\"")' \
    "$test_dir/comments.json" > /dev/null
  [ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]
  jq -e '.result == "already_active"' <<< "$(run_case "$case_name")" > /dev/null
  [ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]
done
echo 'Claude Review failure handler tests passed.'
