#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/list-human-pause-records.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

record_start='<!-- ai-human-pause-record:start -->'
record_end='<!-- ai-human-pause-record:end -->'
pause_body="$record_start
{\"version\":1,\"kind\":\"pause\",\"reason\":\"requirements_change\",\"target\":\"pr:37\"}
$record_end"
issue_body="$record_start
{\"version\":1,\"kind\":\"pause\",\"reason\":\"requirements_change\",\"target\":\"issue:36\"}
$record_end"
other_pr_body="$record_start
{\"version\":1,\"kind\":\"pause\",\"reason\":\"requirements_change\",\"target\":\"pr:38\"}
$record_end"

gh() {
  [ "$1" = api ] || { echo "Unexpected gh invocation: $*" >&2; return 2; }
  [[ "$*" == *'--paginate --slurp'* ]] || { echo 'Expected paginated slurped REST request.' >&2; return 2; }
  case "$*" in
    */issues/37/comments*) printf '%s\n' "$MOCK_PR_COMMENTS" ;;
    */issues/36/comments*) printf '%s\n' "$MOCK_ISSUE_COMMENTS" ;;
    */issues/38/comments*) printf '%s\n' "$MOCK_EMPTY_COMMENTS" ;;
    *) echo "Unexpected Conversation endpoint: $*" >&2; return 2 ;;
  esac
}
export -f gh

MOCK_PR_COMMENTS="$(jq -cn --arg pause "$pause_body" --arg other_pr "$other_pr_body" '
  [[
    {id:101, node_id:"MDQ6", body:$pause, performed_via_github_app:{id:99}},
    {id:102, body:$pause, performed_via_github_app:{id:88}},
    {id:103, body:"not a record", performed_via_github_app:{id:99}},
    {id:104, body:( $pause | sub("pr:37"; "issue:36")), performed_via_github_app:{id:99}},
    {id:105, body:$pause, performed_via_github_app:null},
    {id:107, body:$other_pr, performed_via_github_app:{id:99}}
  ], [
    {id:106, body:$pause, performed_via_github_app:{id:99}}
  ]]
')"
MOCK_ISSUE_COMMENTS="$(jq -cn --arg issue "$issue_body" '[[{id:201, body:$issue, performed_via_github_app:{id:99}}]]')"
MOCK_EMPTY_COMMENTS='[[]]'
export MOCK_PR_COMMENTS MOCK_ISSUE_COMMENTS MOCK_EMPTY_COMMENTS

bash "$helper" owner/repo 36 37 99 > "$test_dir/pr.json"
jq -e '
  .target == "pr:37"
  and [.records[].pause_id] == ["101", "106"]
  and all(.records[]; .record.target == "pr:37")
' "$test_dir/pr.json" > /dev/null

bash "$helper" owner/repo 36 - 99 > "$test_dir/issue.json"
jq -e '.target == "issue:36" and [.records[].pause_id] == ["201"]' "$test_dir/issue.json" > /dev/null

# No trusted, schema-valid, target-matching records is a normal history, not
# an API or lifecycle error.
bash "$helper" owner/repo 38 - 99 > "$test_dir/empty.json"
jq -e '.target == "issue:38" and .records == []' "$test_dir/empty.json" > /dev/null

echo 'list-human-pause-records tests passed.'
