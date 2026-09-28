#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
cp "$root/.github/scripts/prepare-ai-resume-review-recovery.sh" "$tmp/scripts/"
for stage in validate-human-pause-record-graph decompose-human-pause-record-graph \
  derive-human-pause-pre-resume-state reconcile-human-pause-resume-acceptance \
  reconcile-human-pause-active-pause; do
  cp "$root/.github/scripts/$stage.sh" "$tmp/scripts/"
done
helper="$tmp/scripts/prepare-ai-resume-review-recovery.sh"
export MODE=accepted ISSUE_LABEL=true PR_LABEL=true REVIEW=none HEAD_MODE=current \
  RUN_MODE=valid RELATION=valid
export GH_LOG="$tmp/gh.log"
: > "$GH_LOG"
cat > "$tmp/scripts/resolve-ai-resume-target.sh" <<'STUB'
#!/usr/bin/env bash
jq -cn --arg relation "$RELATION" --arg head "$HEAD_MODE" '
  {target:"pr:37",closing_issue:{number:(if $relation == "wrong" then 99 else 36 end),state:"open"},
   pull_request:{number:37,state:(if $relation == "terminal" then "closed" else "open" end),
    base_ref:"main",head_ref:"ai/issue-36",
    head_sha:(if $head == "stale" then "cccccccccccccccccccccccccccccccccccccccc" else "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" end)}}'
STUB
cat > "$tmp/scripts/list-human-pause-records.sh" <<'STUB'
#!/usr/bin/env bash
jq -cn --arg mode "$MODE" '
  {target:"pr:37",records:
    ([{pause_id:"101",record:{version:1,kind:"pause",reason:"claude_execution_failed",
      target:"pr:37",paused_head:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]
    + if $mode == "before" then [] else
        [{pause_id:"201",record:{version:1,kind:"ai-resume-accepted",
          reason:"claude_execution_failed",target:"pr:37",source_pause_id:"101",
          payload:{action:"review",accepted_actor:"alice"}}}] end
    + if $mode == "replacement" then
        [{pause_id:"301",record:{version:1,kind:"pause",reason:"resume_transition_failed",
          target:"pr:37",source_pause_id:"201",payload:{failed_action:"review"}}}]
      else [] end
    + if $mode == "normalpause" then
        [{pause_id:"401",record:{version:1,kind:"pause",reason:"claude_execution_failed",
          target:"pr:37",paused_head:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]
      else [] end)}'
STUB
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$*" in
    'api /repos/owner/repo/actions/runs/500')
      jq -cn --arg mode "$RUN_MODE" '
        {id:500,run_attempt:2,name:(if $mode == "wrong" then "Other" else "AI Resume Review Consumer" end),
         display_title:"AI Resume Review Consumer pr:37 pause:101",
         event:"repository_dispatch",path:".github/workflows/ai-resume-review-consumer.yml@refs/heads/main",
         head_repository:{full_name:"owner/repo"},status:"completed",conclusion:"failure",
         created_at:"2025-12-31T23:59:00Z",updated_at:"2026-01-01T00:02:00Z",
         head_sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' ;;
    'api /repos/owner/repo/actions/runs/500/attempts/2')
      echo '{"id":500,"run_attempt":2,"status":"completed","conclusion":"failure","created_at":"2025-12-31T23:59:00Z","updated_at":"2026-01-01T00:02:00Z"}' ;;
    'api /repos/owner/repo/issues/comments/201')
      echo '{"id":201,"performed_via_github_app":{"id":99},"created_at":"2026-01-01T00:00:00Z"}' ;;
    'api --paginate --slurp /repos/owner/repo/pulls/37/files?per_page=100')
      echo '[[]]' ;;
    'api --paginate --slurp /repos/owner/repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100')
      jq -cn --arg mode "$REVIEW" '
        [{workflow_runs:(if $mode == "none" then [] else
          [{id:600,run_attempt:1,name:"Claude Review",event:"pull_request",
            path:".github/workflows/claude-review.yml@refs/heads/main",
            head_repository:{full_name:"owner/repo"},head_sha:(if $mode == "unrelated" then
              "dddddddddddddddddddddddddddddddddddddddd" else
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" end),
            head_branch:"ai/issue-36",created_at:"2026-01-01T00:01:00Z",
            pull_requests:[{number:37,head:{sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]}] end)}]' ;;
    'api --paginate --slurp /repos/owner/repo/actions/runs/600/attempts/1/jobs?per_page=100')
      jq -cn --arg mode "$REVIEW" '
        [{jobs:[{name:"Review",
          status:(if ($mode | IN("pending","pending_entered","pending_skipped"))
            then "in_progress" else "completed" end),
          conclusion:(if $mode == "early_failure" then "failure"
            elif $mode == "job_skipped" then "skipped"
            elif ($mode | IN("cancelled","timed_out","stale")) then $mode
            elif ($mode | IN("pending","pending_entered","pending_skipped"))
              then null else "success" end),
          steps:(if $mode == "job_skipped" or $mode == "pending" then [] else
            [{name:"Select Claude review model",status:"completed",
              conclusion:(if ($mode | IN("skipped","early_failure","pending_skipped"))
                then "skipped" else "success" end)}] end)}]}]' ;;
    'api /repos/owner/repo/issues/36'|'api /repos/owner/repo/issues/37')
      local number="${2##*/}" present="$ISSUE_LABEL"
      [ "$number" = 37 ] && present="$PR_LABEL"
      jq -cn --argjson number "$number" --arg present "$present" '
        {number:$number,state:"open",labels:(if $present == "true" then
          [{name:"human-review-required"}] else [] end)}' ;;
    *) echo "unexpected API read: $*" >&2; return 1 ;;
  esac
}
export -f gh
run() { bash "$helper" owner/repo 500 2 99 37 36 101; }
assert_actions() {
  local expected="$1" actual
  actual="$(run | jq -c '[.actions[].action]')"
  [ "$actual" = "$expected" ] || { echo "expected $expected, got $actual" >&2; exit 1; }
}
MODE=before; assert_actions '[]'
ISSUE_LABEL=false; assert_actions '["add_issue_human_label"]'
ISSUE_LABEL=true
MODE=accepted; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph"]'
ISSUE_LABEL=false; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph","add_issue_human_label"]'
PR_LABEL=false; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph","add_issue_human_label","add_pr_human_label"]'
ISSUE_LABEL=true; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph","add_pr_human_label"]'
MODE=replacement; assert_actions '["add_pr_human_label"]'
PR_LABEL=true; assert_actions '[]'
MODE=accepted; REVIEW=entered; assert_actions '[]'
[ "$(run | jq -r .result)" = normal_review_owns ]
for REVIEW in early_failure cancelled timed_out stale pending_entered; do
  assert_actions '[]'
  [ "$(run | jq -r .result)" = normal_review_owns ]
done
REVIEW=pending
if run >/dev/null 2>&1; then
  echo 'Pending Review without model entry was treated as owned.' >&2
  exit 1
fi
REVIEW=pending_skipped; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph"]'
REVIEW=entered
MODE=normalpause; assert_actions '[]'
REVIEW=none
if run >/dev/null 2>&1; then exit 1; fi
MODE=accepted
REVIEW=skipped; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph"]'
REVIEW=job_skipped; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph"]'
REVIEW=unrelated; assert_actions '["create_or_reconcile_replacement_pause","revalidate_record_graph"]'
REVIEW=none; HEAD_MODE=stale
if run >/dev/null 2>&1; then exit 1; fi
HEAD_MODE=current; RELATION=terminal
if run >/dev/null 2>&1; then exit 1; fi
RELATION=wrong
if run >/dev/null 2>&1; then exit 1; fi
RELATION=valid; RUN_MODE=wrong
if run >/dev/null 2>&1; then exit 1; fi
RUN_MODE=valid
for bad in '0 2 99 37 36 101' '500 02 99 37 36 101' '500 2 99 37 36 0101'; do
  if bash "$helper" owner/repo $bad >/dev/null 2>&1; then exit 1; fi
done
first="$(run)"
second="$(run)"
[ "$first" = "$second" ]
check_read_only_log() {
  local search_rc
  if grep -Eq 'api -X|issue edit|pr edit|dispatch' "$GH_LOG"; then
    search_rc=0
  else
    search_rc=$?
  fi
  case "$search_rc" in
    0) echo 'Recovery helper attempted a write.' >&2; return 1 ;;
    1) return 0 ;;
    *) echo "Repository write log search failed (exit $search_rc)." >&2; return 1 ;;
  esac
}
check_read_only_log
printf '%s\n' 'api -X POST /repos/owner/repo/issues/37/comments' >> "$GH_LOG"
if check_read_only_log >/dev/null 2>&1; then
  echo 'Repository write log was accepted.' >&2
  exit 1
fi
if (grep() { return 127; }; check_read_only_log >/dev/null 2>&1); then
  echo 'Missing repository write log search tool was accepted.' >&2
  exit 1
fi
# The recovery source is absent even after its independent workflow is wired.
check_dormant_workflows() {
  local directory="$1" workflow search_rc
  local -a workflows
  shopt -s nullglob
  workflows=("$directory"/*.yml "$directory"/*.yaml)
  if [ "${#workflows[@]}" -eq 0 ]; then
    echo "No production workflows found in $directory." >&2
    return 1
  fi
  for workflow in "${workflows[@]}"; do
    if [ ! -f "$workflow" ] || [ ! -r "$workflow" ] || [ -L "$workflow" ]; then
      echo "Production workflow is not a readable regular file: $workflow" >&2
      return 1
    fi
    if grep -Eq 'repository_dispatch:.*ai-resume-review|ai-resume-review-consumer\.yml' "$workflow"; then
      search_rc=0
    else
      search_rc=$?
    fi
    case "$search_rc" in
      0) echo "Resume Review consumer became reachable from $workflow." >&2; return 1 ;;
      1) ;;
      *) echo "Production workflow search failed for $workflow (exit $search_rc)." >&2; return 1 ;;
    esac
  done
}
check_dormant_workflows "$root/.github/workflows"
if [ -e "$root/.github/workflows/ai-resume-review-consumer.yml" ]; then
  echo 'Production consumer exists before activation.' >&2
  exit 1
fi
grep -Fq 'workflows: [AI Resume Review Consumer]' \
  "$root/.github/workflows/ai-resume-review-recovery.yml"
mkdir "$tmp/empty-workflows" "$tmp/invalid-workflows"
if check_dormant_workflows "$tmp/empty-workflows" >/dev/null 2>&1; then exit 1; fi
ln -s "$root/.github/workflows/ai-workflow-regression.yml" "$tmp/invalid-workflows/link.yml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
rm "$tmp/invalid-workflows/link.yml"
mkdir "$tmp/invalid-workflows/dir.yaml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
rmdir "$tmp/invalid-workflows/dir.yaml"
printf 'name: unreadable\n' > "$tmp/invalid-workflows/unreadable.yml"
chmod 000 "$tmp/invalid-workflows/unreadable.yml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
chmod 600 "$tmp/invalid-workflows/unreadable.yml"
printf 'run: ai-resume-review-consumer.yml\n' > "$tmp/invalid-workflows/reachable.yaml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
if (grep() { return 127; }; check_dormant_workflows "$root/.github/workflows" >/dev/null 2>&1); then
  echo 'Missing workflow search tool was accepted.' >&2
  exit 1
fi
echo 'prepare-ai-resume-review-recovery fixture passed.'
