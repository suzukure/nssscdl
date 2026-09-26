#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$script_dir/evaluate-claude-auto-rereview-entry-gate.sh"
base_sha="$(printf 'a%.0s' {1..40})"
head_sha="$(printf 'b%.0s' {1..40})"
old_sha="$(printf 'c%.0s' {1..40})"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
export GH_LOG="$work_dir/gh.log"

export PR_JSON BASE_JSON RELATION_JSON ISSUE_JSON REVIEWS_JSON
PR_JSON="$(jq -cn --arg head "$head_sha" '
  {number:37,state:"open",draft:false,merged:false,
   head:{sha:$head,ref:"ai/issue-36",repo:{full_name:"owner/repo"}},
   base:{ref:"main",repo:{full_name:"owner/repo"}},
   labels:[{name:"ai-followup-in-progress"}]}
')"
BASE_JSON="$(jq -cn --arg sha "$base_sha" '{object:{sha:$sha}}')"
RELATION_JSON="$(jq -cn --arg head "$head_sha" '
  {number:37,headRefOid:$head,closingIssuesReferences:[
    {number:36,url:"https://github.com/owner/repo/issues/36"}]}
')"
ISSUE_JSON='{"number":36,"state":"open","labels":[]}'
REVIEWS_JSON="$(jq -cn --arg sha "$old_sha" '
  [{id:1,user:{login:"review[bot]"},state:"CHANGES_REQUESTED",commit_id:$sha,
    submitted_at:"2026-01-01T00:00:00Z"}]
')"

gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$*" in
    'api repos/owner/repo/pulls/37') [ "${GH_FAIL:-}" != pr ] || return 1; printf '%s\n' "$PR_JSON" ;;
    'api repos/owner/repo/git/ref/heads/main') [ "${GH_FAIL:-}" != base ] || return 1; printf '%s\n' "$BASE_JSON" ;;
    'pr view 37 --repo owner/repo --json number,headRefOid,closingIssuesReferences')
      [ "${GH_FAIL:-}" != relation ] || return 1; printf '%s\n' "$RELATION_JSON" ;;
    'api repos/owner/repo/issues/36') [ "${GH_FAIL:-}" != issue ] || return 1; printf '%s\n' "$ISSUE_JSON" ;;
    'api --paginate repos/owner/repo/pulls/37/reviews')
      [ "${GH_FAIL:-}" != reviews ] || return 1; printf '%s\n' "$REVIEWS_JSON" ;;
    *) return 2 ;;
  esac
}
export -f gh

payload="$(jq -cn --arg sha "$head_sha" '{pr_number:37,validated_sha:$sha,round:1}')"
assert_decision() {
  local name="$1" action="$2" code="$3" input="$4" result
  shift 4
  : > "$GH_LOG"
  result="$(printf '%s\n' "$input" | "$@")"
  if ! jq -e --arg action "$action" --arg code "$code" \
    'keys == ["action","code","reason"] and .action == $action and .code == $code
     and (.reason | type == "string" and length > 0)' <<< "$result" >/dev/null; then
    printf 'Unexpected decision for %s: %s\n' "$name" "$result" >&2
    exit 1
  fi
  if [ "$action" = ignore ] && [ "$code" = stale_head ] \
      && grep -q 'pulls/37/reviews' "$GH_LOG"; then
    echo 'Stale dispatch consumed review state.' >&2
    exit 1
  fi
}
gate=(bash "$helper" owner/repo review "$base_sha")
assert_decision ready proceed ready "$payload" "${gate[@]}"
assert_decision malformed human_required invalid_payload '{}' "${gate[@]}"
assert_decision extra-payload human_required invalid_payload \
  "$(jq -c '.token="untrusted"' <<< "$payload")" "${gate[@]}"
if [ -s "$GH_LOG" ]; then
  echo 'Malformed payload reached GitHub.' >&2
  exit 1
fi
assert_decision wrong-base human_required base_changed "$payload" \
  bash "$helper" owner/repo review "$old_sha"

PR_JSON="$(jq -c '.state="closed"' <<< "$PR_JSON")"
assert_decision terminal ignore terminal_pr "$payload" "${gate[@]}"
PR_JSON="$(jq -c '.state="open" | .draft=true' <<< "$PR_JSON")"
assert_decision draft human_required draft_pr "$payload" "${gate[@]}"
PR_JSON="$(jq -c '.draft=false' <<< "$PR_JSON")"
assert_decision stale ignore stale_head \
  "$(jq -c --arg sha "$old_sha" '.validated_sha=$sha' <<< "$payload")" "${gate[@]}"

PR_JSON="$(jq -c '.head.repo.full_name="other/repo"' <<< "$PR_JSON")"
assert_decision fork human_required invalid_pr "$payload" "${gate[@]}"
PR_JSON="$(jq -c '.head.repo.full_name="owner/repo" | .head.ref="ai/issue-35"' <<< "$PR_JSON")"
assert_decision branch human_required invalid_relation "$payload" "${gate[@]}"
PR_JSON="$(jq -c '.head.ref="ai/issue-36"' <<< "$PR_JSON")"
RELATION_JSON="$(jq -c '.closingIssuesReferences=[]' <<< "$RELATION_JSON")"
assert_decision relation human_required invalid_relation "$payload" "${gate[@]}"
RELATION_JSON="$(jq -c '.closingIssuesReferences=[{number:36,url:"https://github.com/owner/repo/issues/36"}]' <<< "$RELATION_JSON")"
RELATION_JSON="$(jq -c '.closingIssuesReferences += [{number:99,url:"https://github.com/owner/repo/issues/99"}]' <<< "$RELATION_JSON")"
assert_decision multiple-closing-issues proceed ready "$payload" "${gate[@]}"
RELATION_JSON="$(jq -c '.closingIssuesReferences |= map(select(.number == 36))' <<< "$RELATION_JSON")"

ISSUE_JSON="$(jq -c '.labels=[{name:"human-review-required"}]' <<< "$ISSUE_JSON")"
assert_decision issue-pause human_required human_pause "$payload" "${gate[@]}"
ISSUE_JSON="$(jq -c '.labels=[]' <<< "$ISSUE_JSON")"
PR_JSON="$(jq -c '.labels=[{name:"human-review-required"},{name:"ai-followup-in-progress"}]' <<< "$PR_JSON")"
assert_decision pr-pause human_required human_pause "$payload" "${gate[@]}"
PR_JSON="$(jq -c '.labels=[{name:"ai-followup-in-progress"}]' <<< "$PR_JSON")"

assert_decision round-mismatch human_required round_mismatch \
  "$(jq -c '.round=2' <<< "$payload")" "${gate[@]}"
REVIEWS_JSON="$(jq -cn --arg sha "$old_sha" '[range(1;4) |
  {id:.,user:{login:"review[bot]"},state:"CHANGES_REQUESTED",commit_id:$sha,
   submitted_at:("2026-01-0" + (.|tostring) + "T00:00:00Z")}]')"
assert_decision round-limit human_required round_limit \
  "$(jq -c '.round=3' <<< "$payload")" "${gate[@]}"
REVIEWS_JSON="$(jq -c --arg sha "$head_sha" '
  . + [{id:4,user:{login:"review[bot]"},state:"APPROVED",commit_id:$sha,
         submitted_at:"2026-01-04T00:00:00Z"}]' <<< "$REVIEWS_JSON")"
assert_decision round-limit-before-duplicate human_required round_limit \
  "$(jq -c '.round=3' <<< "$payload")" "${gate[@]}"
REVIEWS_JSON="$(jq -cn --arg sha "$old_sha" '
  [{id:1,user:{login:"review[bot]"},state:"CHANGES_REQUESTED",commit_id:$sha,
    submitted_at:"2026-01-01T00:00:00Z"}]')"
PR_JSON="$(jq -c '.labels=[]' <<< "$PR_JSON")"
assert_decision missing-label human_required missing_machine_state "$payload" "${gate[@]}"
REVIEWS_JSON="$(jq -c --arg sha "$head_sha" \
  '. + [{id:2,user:{login:"review[bot]"},state:"APPROVED",commit_id:$sha,
         submitted_at:"2026-01-02T00:00:00Z"}]' <<< "$REVIEWS_JSON")"
assert_decision duplicate-no-label ignore duplicate_review "$payload" "${gate[@]}"
PR_JSON="$(jq -c '.labels=[{name:"ai-followup-in-progress"}]' <<< "$PR_JSON")"
assert_decision duplicate-with-label ignore duplicate_review "$payload" "${gate[@]}"
REVIEWS_JSON="$(jq -c --arg sha "$head_sha" '.[0].commit_id=$sha' <<< "$REVIEWS_JSON")"
assert_decision no-diff-change-request-then-approved ignore duplicate_review \
  "$payload" "${gate[@]}"
REVIEWS_JSON="$(jq -c --arg sha "$head_sha" '
  . + [{id:3,user:{login:"review[bot]"},state:"CHANGES_REQUESTED",commit_id:$sha,
         submitted_at:"2026-01-03T00:00:00Z"}]' <<< "$REVIEWS_JSON")"
assert_decision newer-change-request proceed ready \
  "$(jq -c '.round=2' <<< "$payload")" "${gate[@]}"
REVIEWS_JSON="$(jq -c '.[2].submitted_at="2026-01-02T00:00:00Z"' <<< "$REVIEWS_JSON")"
assert_decision ambiguous-verdict human_required invalid_reviews \
  "$(jq -c '.round=2' <<< "$payload")" "${gate[@]}"
REVIEWS_JSON="$(jq -c '.[2].submitted_at="invalid"' <<< "$REVIEWS_JSON")"
assert_decision invalid-timestamp human_required invalid_reviews \
  "$(jq -c '.round=2' <<< "$payload")" "${gate[@]}"
REVIEWS_JSON='[{"id":1,"user":{},"state":"APPROVED","commit_id":"bad"}]'
assert_decision malformed-reviews human_required invalid_reviews "$payload" "${gate[@]}"

GH_FAIL=pr assert_decision pr-fetch human_required pr_unavailable "$payload" "${gate[@]}"
GH_FAIL=base assert_decision base-fetch human_required base_unavailable "$payload" "${gate[@]}"
GH_FAIL=relation assert_decision relation-fetch human_required relation_unavailable "$payload" "${gate[@]}"
GH_FAIL=issue assert_decision issue-fetch human_required issue_unavailable "$payload" "${gate[@]}"
GH_FAIL=reviews assert_decision reviews-fetch human_required reviews_unavailable "$payload" "${gate[@]}"

echo 'Claude automatic re-review entry gate tests passed.'
