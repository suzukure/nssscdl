#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
helper="$script_dir/prepare-claude-auto-rereview-consumer.sh"
base_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
head_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
old_sha=cccccccccccccccccccccccccccccccccccccccc
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
export GH_LOG="$work_dir/gh.log" PR_JSON FINAL_PR_JSON BASE_JSON RELATION_JSON ISSUE_JSON REVIEWS_JSON
PR_JSON="$(jq -cn --arg sha "$head_sha" '{number:37,state:"open",draft:false,merged:false,
  user:{login:"developer[bot]"},head:{sha:$sha,ref:"ai/issue-36",repo:{full_name:"owner/repo"}},
  base:{ref:"main",repo:{full_name:"owner/repo"}},labels:[{name:"ai-followup-in-progress"}]}')"
BASE_JSON="$(jq -cn --arg sha "$base_sha" '{object:{sha:$sha}}')"
RELATION_JSON="$(jq -cn --arg sha "$head_sha" '{number:37,headRefOid:$sha,
  closingIssuesReferences:[{number:36,url:"https://github.com/owner/repo/issues/36"}]}')"
ISSUE_JSON='{"number":36,"state":"open","labels":[]}'
REVIEWS_JSON="$(jq -cn --arg sha "$old_sha" '[{id:1,user:{login:"review[bot]"},
  state:"CHANGES_REQUESTED",commit_id:$sha,submitted_at:"2026-01-01T00:00:00Z"}]')"
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$*" in
    'api repos/owner/repo/pulls/37')
      if [ "$(grep -Fc 'api repos/owner/repo/pulls/37' "$GH_LOG")" -eq 2 ] && [ -n "${FINAL_PR_JSON:-}" ]; then
        printf '%s\n' "$FINAL_PR_JSON"
      else printf '%s\n' "$PR_JSON"; fi ;;
    'api repos/owner/repo/git/ref/heads/main') printf '%s\n' "$BASE_JSON" ;;
    'pr view 37 --repo owner/repo --json number,headRefOid,closingIssuesReferences') printf '%s\n' "$RELATION_JSON" ;;
    'api repos/owner/repo/issues/36') printf '%s\n' "$ISSUE_JSON" ;;
    'api --paginate repos/owner/repo/pulls/37/reviews') printf '%s\n' "$REVIEWS_JSON" ;;
    *) return 2 ;;
  esac
}
export -f gh
payload="$(jq -cn --arg sha "$head_sha" '{pr_number:37,validated_sha:$sha,round:1}')"
entry=(bash "$helper" entry owner/repo review developer "$base_sha")
run_entry() { : > "$GH_LOG"; printf '%s\n' "$1" | "${entry[@]}"; }
assert() {
  local name="$1" actual="$2" filter="$3"
  if ! jq -e "$filter" <<< "$actual" >/dev/null; then
    printf 'Wrong consumer decision for %s: %s\n' "$name" "$actual" >&2
    exit 1
  fi
}

accepted="$(run_entry "$payload")"
assert accepted "$accepted" '.action == "accepted" and .next == "consume_machine_state"
  and .identity == {repo:"owner/repo",pr_number:37,validated_sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    round:1,head_ref:"ai/issue-36",base_ref:"main",trusted_base_sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    closing_issue_number:36}'
identity="$(jq -c .identity <<< "$accepted")"
assert malformed "$(run_entry '{}')" '.action == "pause_record" and .code == "invalid_payload"'
[ ! -s "$GH_LOG" ]
assert stale "$(run_entry "$(jq -c --arg sha "$old_sha" '.validated_sha=$sha' <<< "$payload")")" \
  '.action == "ignore" and .code == "stale_head"'
if grep -Eq 'pr view|pulls/37/reviews' "$GH_LOG"; then
  echo 'Initial stale input fetched relation or reviews.' >&2; exit 1
fi
RELATION_JSON="$(jq -c --arg sha "$old_sha" '.headRefOid=$sha' <<< "$RELATION_JSON")"
assert relation-race "$(run_entry "$payload")" '.action == "ignore" and .code == "stale_head"'
if grep -q 'pulls/37/reviews' "$GH_LOG"; then
  echo 'Relation HEAD race fetched reviews.' >&2; exit 1
fi
RELATION_JSON="$(jq -c --arg sha "$head_sha" '.headRefOid=$sha' <<< "$RELATION_JSON")"
PR_JSON="$(jq -c '.state="closed"' <<< "$PR_JSON")"
assert terminal "$(run_entry "$payload")" '.action == "ignore" and .code == "terminal_pr"'
PR_JSON="$(jq -c '.state="open"' <<< "$PR_JSON")"
REVIEWS_JSON="$(jq -c --arg sha "$head_sha" '. + [{id:2,user:{login:"review[bot]"},
  state:"APPROVED",commit_id:$sha,submitted_at:"2026-01-02T00:00:00Z"}]' <<< "$REVIEWS_JSON")"
assert duplicate "$(run_entry "$payload")" '.action == "ignore" and .code == "duplicate_review"'
REVIEWS_JSON="$(jq -c '.[0:1]' <<< "$REVIEWS_JSON")"
ISSUE_JSON="$(jq -c '.labels=[{name:"human-review-required"}]' <<< "$ISSUE_JSON")"
assert paused "$(run_entry "$payload")" '.action == "pause_record" and .code == "human_pause"'
ISSUE_JSON='{"number":36,"state":"open","labels":[]}'
PR_JSON="$(jq -c '.labels=[]' <<< "$PR_JSON")"
assert missing-state "$(run_entry "$payload")" '.action == "pause_record" and .code == "missing_machine_state"'
PR_JSON="$(jq -c '.labels=[{name:"ai-followup-in-progress"}]' <<< "$PR_JSON")"
REVIEWS_JSON="$(jq -c --arg sha "$head_sha" '.[0].commit_id=$sha' <<< "$REVIEWS_JSON")"
assert no-diff "$(run_entry "$payload")" '.action == "accepted" and .next == "consume_machine_state"'
FINAL_PR_JSON="$(jq -c '.updated_at="2026-02-01T00:00:00Z" | .labels += [{name:"unrelated"}]' <<< "$PR_JSON")"
assert volatile-metadata "$(run_entry "$payload")" '.action == "accepted"'
FINAL_PR_JSON=''

result="$(jq -cn --argjson identity "$identity" '{identity:$identity,label_removed:true}')"
assert consumed "$(bash "$helper" machine_state_result <<< "$result")" \
  '.action == "paid_review" and .identity.pr_number == 37'
assert consumption-failed "$(bash "$helper" machine_state_result <<< "$(jq -c '.label_removed=false' <<< "$result")")" \
  '.action == "pause_record" and .code == "state_inconsistent"'
assert invalid-identity "$(bash "$helper" pre_verdict <<< '{"pr_number":37}')" \
  '.action == "pause_record" and .code == "invalid_identity"'
assert verdict-current "$(bash "$helper" pre_verdict <<< "$identity")" \
  '.action == "submit_verdict" and .identity.validated_sha == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
PR_JSON="$(jq -c --arg sha "$old_sha" '.head.sha=$sha' <<< "$PR_JSON")"
assert verdict-stale "$(bash "$helper" pre_verdict <<< "$identity")" \
  '.action == "suppress_verdict" and .code == "stale_head"'
PR_JSON="$(jq -c --arg sha "$head_sha" '.head.sha=$sha' <<< "$PR_JSON")"
merge_request="$(jq -cn --argjson identity "$identity" '{identity:$identity,verdict:"approve"}')"
assert merge-unapproved "$(bash "$helper" merge_inputs <<< "$(jq -c '.verdict="request_changes"' <<< "$merge_request")")" \
  '.action == "pause_record" and .code == "invalid_verdict"'
assert merge-inputs "$(bash "$helper" merge_inputs <<< "$merge_request")" \
  '.action == "verify_merge_gates" and .gate_mode == "merge" and
   .pr_number == 37 and .head_ref == "ai/issue-36" and .base_ref == "main" and
   .trusted_base_sha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and
   .match_head_commit == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'

# The prepared helper is not reachable from any production workflow.
if grep -Eq 'prepare-claude-auto-rereview-consumer|evaluate-claude-auto-rereview-entry-gate|claude-auto-rereview' \
  "$repo_root"/.github/workflows/*.yml; then
  echo 'Prepared consumer became reachable from a production workflow.' >&2; exit 1
fi
echo 'Prepared Claude auto-rereview consumer fixtures passed.'
