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
export TEST_DIR="$test_dir" GH_TOKEN=workflow-fixture REVIEW_APP_TOKEN=reviewer-fixture
export NOTIFICATION_WEBHOOK_URL='https://discord.invalid/webhook'
head_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export HEAD_SHA="$head_sha"
base64 -w0 "$script_dir/../workflows/claude-review.yml" > "$test_dir/workflow.b64"
printf '[]\n' > "$test_dir/comments.json"
: > "$test_dir/events"
: > "$test_dir/edits"

gh() {
  local endpoint="${*: -1}" body='' arg id expected_token=workflow-fixture
  if [ "$2" = /apps/reviewer ] || [ "$1" != api ] || [ "$2" = -X ] || [[ "$endpoint" == */comments ]]; then
    expected_token=reviewer-fixture
  fi
  [ "${GH_TOKEN:-}" = "$expected_token" ] || { echo 'Incorrect token boundary.' >&2; return 2; }
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
        */pulls\?*)
          branch=ai/issue-36
          [ "${MOCK_CASE:-}" = branch_issue_999 ] && branch=ai/issue-999
          current_head="$HEAD_SHA"
          [ "${MOCK_CASE:-}" = old_head ] && current_head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
          jq -cn --arg head "$current_head" --arg branch "$branch" --arg case "${MOCK_CASE:-}" '
            {number:37,head:{repo:{full_name:"owner/repo"},ref:$branch,sha:$head}} as $pr
            | [[ $pr ] + (if $case == "multiple_matches" then [$pr + {number:38}] else [] end)]
          ' ;;
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
      branch=ai/issue-36
      [ "${MOCK_CASE:-}" = branch_issue_999 ] && branch=ai/issue-999
      jq -cn --arg head "$HEAD_SHA" --argjson attempt "$attempt" \
        --arg branch "$branch" --arg case "${MOCK_CASE:-}" \
        '{id:10,name:"Claude Review",path:".github/workflows/claude-review.yml@refs/pull/37/merge",event:"pull_request",head_repository:{full_name:"owner/repo"},head_branch:$branch,head_sha:$head,status:"completed",run_attempt:$attempt,workflow_id:5,pull_requests:[{number:37,head:{sha:$head}}]}
         | if $case == "empty_association" or $case == "empty_association_closed" then .pull_requests = []
           elif $case == "association_mismatch" then .pull_requests[0].number = 38 else . end' ;;
    'api /repos/owner/repo/actions/runs/10/attempts/1')
      echo '{"id":10,"run_attempt":1,"status":"completed"}' ;;
    'api /repos/owner/repo/pulls/37')
      state=open draft=false current_head="$HEAD_SHA"
      [[ "${MOCK_CASE:-}" == closed || "${MOCK_CASE:-}" == empty_association_closed ]] && state=closed
      [ "${MOCK_CASE:-}" = draft ] && draft=true
      [ "${MOCK_CASE:-}" = old_head ] && current_head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      branch=ai/issue-36
      [ "${MOCK_CASE:-}" = branch_issue_999 ] && branch=ai/issue-999
      jq -cn --arg state "$state" --argjson draft "$draft" --arg head "$current_head" --arg branch "$branch" \
        '{number:37,state:$state,draft:$draft,head:{repo:{full_name:"owner/repo"},sha:$head,ref:$branch}}' ;;
    'api /repos/owner/repo/contents/.github/workflows/claude-review.yml?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      if [ "${MOCK_CASE:-}" = legacy ]; then
        echo '{"content":"bGVnYWN5"}'
      else jq -Rs '{content:.}' "$TEST_DIR/workflow.b64"; fi ;;
    'api /apps/reviewer')
      case "${MOCK_CASE:-}" in
        app_403) echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; return 1 ;;
        app_malformed) echo '{raw-app-response' ;;
        app_empty) : ;;
        app_multiple) printf '%s\n' '{"slug":"reviewer","id":99}' '{"slug":"reviewer","id":99}' ;;
        app_slug) echo '{"slug":"other","id":99,"fixture":"raw-app-response"}' ;;
        app_no_slug) echo '{"id":99}' ;;
        app_string) echo '{"slug":"reviewer","id":"99"}' ;;
        app_null) echo '{"slug":"reviewer","id":null}' ;;
        app_zero) echo '{"slug":"reviewer","id":0}' ;;
        app_negative) echo '{"slug":"reviewer","id":-1}' ;;
        app_fraction) echo '{"slug":"reviewer","id":1.5}' ;;
        *) echo '{"slug":"reviewer","id":99}' ;;
      esac ;;
    'pr view') echo '{"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}]}' ;;
    'label create') : ;;
    'issue edit') echo "$3" >> "$TEST_DIR/edits" ;;
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
assert_result empty_association_closed stale_pr
assert_result draft stale_pr
assert_result old_head stale_pr
assert_result newer superseded
if run_case association_mismatch > /dev/null 2>&1; then echo 'Conflicting PR association was trusted.' >&2; exit 1; fi
if run_case multiple_matches > /dev/null 2>&1; then echo 'Ambiguous PR lookup was trusted.' >&2; exit 1; fi
if run_case workflow_changed > /dev/null 2>&1; then echo 'Changed source workflow was trusted.' >&2; exit 1; fi
if run_case legacy > /dev/null 2>&1; then echo 'Legacy source workflow was trusted.' >&2; exit 1; fi
if run_case older_attempt > /dev/null 2>&1; then echo 'Old attempt was trusted.' >&2; exit 1; fi
for bad_case in missing_review duplicate_review unknown; do
  if run_case "$bad_case" > /dev/null 2>&1; then echo "Invalid $bad_case job was trusted." >&2; exit 1; fi
done
if run_case newer_unassociated > /dev/null 2>&1; then echo 'Unassociated newer run was ignored.' >&2; exit 1; fi
if run_case incomplete > /dev/null 2>&1; then echo 'Incomplete classification was trusted.' >&2; exit 1; fi

for bad_case in app_403 app_malformed app_empty app_multiple app_slug app_no_slug \
  app_string app_null app_zero app_negative app_fraction; do
  if run_case "$bad_case" > "$test_dir/app-error" 2>&1; then
    echo "$bad_case was trusted." >&2; exit 1
  fi
  grep -Fq 'reviewer App' "$test_dir/app-error"
  if grep -Eq 'raw-app-response|workflow-fixture|reviewer-fixture' "$test_dir/app-error"; then
    echo 'App lookup leaked response or credentials.' >&2; exit 1
  fi
  [ "$(jq 'length' "$test_dir/comments.json")" -eq 0 ]
  [ ! -s "$test_dir/events" ] && [ ! -s "$test_dir/edits" ]
done

for case_name in failure cancelled timed_out interrupted; do
  printf '[]\n' > "$test_dir/comments.json"; : > "$test_dir/events"
  jq -e '.result == "created"' <<< "$(run_case "$case_name")" > /dev/null
  jq -e --arg head "$head_sha" '.[0].body | contains("\"paused_head\":\"" + $head + "\"")' \
    "$test_dir/comments.json" > /dev/null
  [ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]
  jq -e '.result == "already_active"' <<< "$(run_case "$case_name")" > /dev/null
  [ "$(grep -c '^notify$' "$test_dir/events")" -eq 1 ]
done
printf '[]\n' > "$test_dir/comments.json"; : > "$test_dir/events"; : > "$test_dir/edits"
jq -e '.result == "created"' <<< "$(run_case empty_association)" > /dev/null
printf '[]\n' > "$test_dir/comments.json"; : > "$test_dir/events"; : > "$test_dir/edits"
jq -e '.result == "created"' <<< "$(run_case branch_issue_999)" > /dev/null
sort -nu "$test_dir/edits" | diff -u <(printf '36\n37\n') -
echo 'Claude Review failure handler tests passed.'
