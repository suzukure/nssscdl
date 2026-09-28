#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
cp "$root/.github/scripts/recover-ai-resume-review.sh" \
  "$root/.github/scripts/human-pause-record.sh" "$tmp/scripts/"
cat > "$tmp/scripts/prepare-ai-resume-review-recovery.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
state="$(cat "$MOCK_STATE")"
case "$state" in
  owner) echo '{"result":"normal_review_owns","actions":[]}' ;;
  before)
    jq -cn --argjson issue "$(cat "$MOCK_ISSUE_LABEL")" '
      {result:"pre_acceptance",actions:
        [if $issue == false then {action:"add_issue_human_label",number:36} else empty end]}' ;;
  *)
    jq -cn --arg state "$state" --argjson issue "$(cat "$MOCK_ISSUE_LABEL")" \
      --argjson pr "$(cat "$MOCK_PR_LABEL")" '
      {result:"recover",accepted_record_id:"201",
       actions:([if $state == "accepted" then
         {action:"create_or_reconcile_replacement_pause",source_pause_id:"201"},
         {action:"revalidate_record_graph"} else empty end]
         + [if $issue == false then {action:"add_issue_human_label",number:36} else empty end]
         + [if $pr == false then {action:"add_pr_human_label",number:37} else empty end])}
       + if $state == "replacement" then {replacement_pause_id:"301"} else {} end'
    ;;
esac
STUB
export MOCK_STATE="$tmp/state" MOCK_ISSUE_LABEL="$tmp/issue-label" \
  MOCK_PR_LABEL="$tmp/pr-label" MOCK_LOG="$tmp/gh.log" MOCK_LOSS=false \
  MOCK_NO_CREATE=false MOCK_LABEL_LOSS=none MOCK_LABEL_NO_WRITE=none
gh() {
  printf '%s\n' "$*" >> "$MOCK_LOG"
  case "$*" in
    'api /apps/developer --jq .id') echo 99 ;;
    'api -X POST /repos/owner/repo/issues/37/comments '*)
      [ "$MOCK_NO_CREATE" != true ] || return 1
      printf 'replacement' > "$MOCK_STATE"
      [ "$MOCK_LOSS" != true ] ;;
    'issue edit 36 --repo owner/repo --add-label human-review-required')
      [ "$MOCK_LABEL_NO_WRITE" != issue ] || return 1
      printf true > "$MOCK_ISSUE_LABEL"
      [ "$MOCK_LABEL_LOSS" != issue ] ;;
    'issue edit 37 --repo owner/repo --add-label human-review-required')
      [ "$MOCK_LABEL_NO_WRITE" != pr ] || return 1
      printf true > "$MOCK_PR_LABEL"
      [ "$MOCK_LABEL_LOSS" != pr ] ;;
    *) echo "Unexpected write: $*" >&2; return 1 ;;
  esac
}
export -f gh
run() { bash "$tmp/scripts/recover-ai-resume-review.sh" owner/repo 500 2 developer 37 36 101; }
assert_no_write() {
  local rc
  if grep -Eq 'api -X|issue edit' "$MOCK_LOG"; then rc=0; else rc=$?; fi
  case "$rc" in
    0) echo 'Unexpected repository write.' >&2; exit 1 ;;
    1) ;;
    *) echo 'Write log search failed.' >&2; exit 1 ;;
  esac
}
assert_write_count() {
  local count rc
  if count="$(grep -Fc -- "$1" "$MOCK_LOG")"; then rc=0; else rc=$?; fi
  case "$rc" in
    0) [ "$count" = "$2" ] || { echo "Unexpected write count for $1: $count" >&2; exit 1; } ;;
    1) [ "$2" = 0 ] || { echo "Missing write: $1" >&2; exit 1; } ;;
    *) echo 'Write log search failed.' >&2; exit 1 ;;
  esac
}
printf owner > "$MOCK_STATE"; printf true > "$MOCK_ISSUE_LABEL"
printf true > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
run
assert_no_write
printf before > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"; : > "$MOCK_LOG"
run
[ "$(cat "$MOCK_STATE")" = before ]
grep -Fq 'issue edit 36 --repo owner/repo --add-label human-review-required' "$MOCK_LOG"
printf accepted > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"
printf false > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
MOCK_NO_CREATE=true; export MOCK_NO_CREATE
if run >/dev/null 2>&1; then
  echo 'Unconfirmed replacement POST was accepted.' >&2
  exit 1
fi
[ "$(cat "$MOCK_ISSUE_LABEL")" = false ]
[ "$(cat "$MOCK_PR_LABEL")" = false ]
MOCK_NO_CREATE=false; export MOCK_NO_CREATE
printf accepted > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"
printf false > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
MOCK_LOSS=true; export MOCK_LOSS
run
[ "$(cat "$MOCK_STATE")" = replacement ]
[ "$(cat "$MOCK_ISSUE_LABEL")" = true ]
[ "$(cat "$MOCK_PR_LABEL")" = true ]
assert_write_count 'api -X POST' 1
MOCK_LOSS=false; export MOCK_LOSS
: > "$MOCK_LOG"
run
assert_no_write

# A lost label response is reconciled from fresh facts without a second write.
printf replacement > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"
printf false > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
MOCK_LABEL_LOSS=issue; export MOCK_LABEL_LOSS
run
assert_write_count 'issue edit 36 --repo owner/repo --add-label human-review-required' 1
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 1
[ "$(cat "$MOCK_ISSUE_LABEL")" = true ]
[ "$(cat "$MOCK_PR_LABEL")" = true ]

printf true > "$MOCK_ISSUE_LABEL"; printf false > "$MOCK_PR_LABEL"
: > "$MOCK_LOG"
MOCK_LABEL_LOSS=pr; export MOCK_LABEL_LOSS
run
assert_write_count 'issue edit 36 --repo owner/repo --add-label human-review-required' 0
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 1
[ "$(cat "$MOCK_PR_LABEL")" = true ]

MOCK_LABEL_LOSS=none; MOCK_LABEL_NO_WRITE=issue
export MOCK_LABEL_LOSS MOCK_LABEL_NO_WRITE
printf false > "$MOCK_ISSUE_LABEL"; printf false > "$MOCK_PR_LABEL"
: > "$MOCK_LOG"
if run >/dev/null 2>&1; then
  echo 'Unconfirmed Issue label write was accepted.' >&2
  exit 1
fi
assert_write_count 'issue edit 36 --repo owner/repo --add-label human-review-required' 1
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 0
[ "$(cat "$MOCK_ISSUE_LABEL")" = false ]

MOCK_LABEL_NO_WRITE=pr; export MOCK_LABEL_NO_WRITE
printf true > "$MOCK_ISSUE_LABEL"; printf false > "$MOCK_PR_LABEL"
: > "$MOCK_LOG"
if run >/dev/null 2>&1; then
  echo 'Unconfirmed PR label write was accepted.' >&2
  exit 1
fi
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 1
[ "$(cat "$MOCK_PR_LABEL")" = false ]

MOCK_LABEL_NO_WRITE=none; export MOCK_LABEL_NO_WRITE
printf true > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
run
assert_no_write
workflow="$root/.github/workflows/ai-resume-review-recovery.yml"
grep -Fq 'workflows: [AI Resume Review Consumer]' "$workflow"
grep -Fq 'group: codex-writer-ai/issue-${{ needs.resolve.outputs.issue }}' "$workflow"
grep -Fq 'ref: ${{ github.event.repository.default_branch }}' "$workflow"
grep -Fq 'permission-issues: write' "$workflow"
grep -Fq 'permission-pull-requests: write' "$workflow"
echo 'recover-ai-resume-review fixture passed.'
