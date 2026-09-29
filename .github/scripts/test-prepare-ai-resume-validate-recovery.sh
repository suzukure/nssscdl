#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
for script in prepare-ai-resume-validate-recovery prepare-ai-resume-validate-cycle \
  evaluate-current-head-validation validate-human-pause-record-graph \
  decompose-human-pause-record-graph derive-human-pause-pre-resume-state \
  reconcile-human-pause-resume-acceptance reconcile-human-pause-active-pause \
  resolve-ai-resume-target inspect-ai-resume-target list-human-pause-records \
  human-pause-record; do
  cp "$root/.github/scripts/$script.sh" "$tmp/scripts/"
done
helper="$tmp/scripts/prepare-ai-resume-validate-recovery.sh"
a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export MODE=accepted ISSUE_LABEL=false PR_LABEL=false REVIEW=none HEAD_MODE=current \
  RUN_MODE=valid RELATION=valid RECORD_MODE=valid DRAFT=false MACHINE=true \
  API_MODE=valid NOW=1767225650
date() {
  if [ "$*" = '-u +%s' ]; then printf '%s\n' "$NOW"; else command date "$@"; fi
}
export -f date
export GH_LOG="$tmp/gh.log"
: > "$GH_LOG"
pause_record="$(jq -cn --arg head "$a" \
  '{version:1,kind:"pause",reason:"validation_failed",target:"pr:37",paused_head:$head}')"
accepted_record="$(jq -cn --arg head "$a" \
  '{version:1,kind:"ai-resume-accepted",reason:"validation_failed",target:"pr:37",
   source_pause_id:"101",payload:{action:"validate",accepted_actor:"alice",
   command_comment_id:"150",accepted_head:$head}}')"
replacement_record='{"version":1,"kind":"pause","reason":"resume_transition_failed","target":"pr:37","source_pause_id":"201","payload":{"failed_action":"validate"}}'
validation_record="$(jq -cn --arg head "$a" \
  '{version:1,kind:"pause",reason:"validation_failed",target:"pr:37",paused_head:$head}')"
export PAUSE_BODY="$(bash "$tmp/scripts/human-pause-record.sh" create "$pause_record")"
export ACCEPTED_BODY="$(bash "$tmp/scripts/human-pause-record.sh" create "$accepted_record")"
export REPLACEMENT_BODY="$(bash "$tmp/scripts/human-pause-record.sh" create "$replacement_record")"
export VALIDATION_BODY="$(bash "$tmp/scripts/human-pause-record.sh" create "$validation_record")"
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  [ "$API_MODE" = valid ] || { echo 'API unavailable' >&2; return 1; }
  if [ "$1 $2 ${3:-}" = 'pr view 37' ]; then
    jq -cn --arg relation "$RELATION" --arg head "$HEAD_MODE" '
      {number:37,state:(if $relation == "terminal" then "CLOSED" else "OPEN" end),
       baseRefName:"main",headRefName:"ai/issue-36",
       headRefOid:(if $head == "stale" then "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
         else "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" end),
       closingIssuesReferences:[{number:(if $relation == "wrong" then 99 else 36 end),
         url:(if $relation == "wrong" then "https://github.com/owner/repo/issues/99"
           else "https://github.com/owner/repo/issues/36" end)}]}'
    return
  fi
  case "$*" in
    'api repos/owner/repo/issues/36')
      echo '{"number":36,"state":"open"}' ;;
    'api -H Accept: application/vnd.github+json /repos/owner/repo/issues/37/comments?per_page=100&page=1')
      if [ "$RECORD_MODE" = malformed ]; then echo '{}'; return; fi
      jq -cn --arg mode "$MODE" --arg pause "$PAUSE_BODY" \
        --arg accepted "$ACCEPTED_BODY" --arg replacement "$REPLACEMENT_BODY" \
        --arg validation "$VALIDATION_BODY" '
        [{id:101,body:$pause,performed_via_github_app:{id:99}}]
        + (if $mode == "before" then [] else
            [{id:201,body:$accepted,performed_via_github_app:{id:99}}] end)
        + (if $mode == "replacement" then
            [{id:301,body:$replacement,performed_via_github_app:{id:99}}]
          elif $mode == "validation_pause" then
            [{id:301,body:$validation,performed_via_github_app:{id:99}}]
          else [] end)' ;;
    'api /repos/owner/repo/actions/runs/500')
      jq -cn --arg mode "$RUN_MODE" '
        {id:500,run_attempt:2,name:(if $mode == "wrong" then "Other" else "AI Resume Validate Consumer" end),
         display_title:"AI Resume Validate Consumer pr:37 pause:101",event:"repository_dispatch",
         path:".github/workflows/ai-resume-validate-consumer.yml@refs/heads/main",
         head_repository:{full_name:"owner/repo"},status:"completed",conclusion:"failure",
         created_at:"2025-12-31T23:59:00Z",updated_at:"2026-01-01T00:02:00Z"}' ;;
    'api /repos/owner/repo/actions/runs/500/attempts/2')
      echo '{"id":500,"run_attempt":2,"status":"completed","conclusion":"failure","created_at":"2025-12-31T23:59:00Z","updated_at":"2026-01-01T00:02:00Z"}' ;;
    'api /repos/owner/repo/pulls/37')
      jq -cn --arg head "$HEAD_MODE" --arg draft "$DRAFT" --arg machine "$MACHINE" --arg label "$PR_LABEL" '
        {number:37,state:"open",draft:($draft == "true"),
         head:{repo:{full_name:"owner/repo"},ref:"ai/issue-36",
           sha:(if $head == "stale" then "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" else
             "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" end)},
         base:{repo:{full_name:"owner/repo"},ref:"main"},
         labels:([if $machine == "true" then {name:"ai-followup-in-progress"} else empty end,
           if $label == "true" then {name:"human-review-required"} else empty end])}' ;;
    'api /repos/owner/repo/issues/comments/201')
      echo '{"id":201,"performed_via_github_app":{"id":99},"created_at":"2026-01-01T00:00:00Z"}' ;;
    'api --paginate --slurp /repos/owner/repo/pulls/37/files?per_page=100')
      echo '[[]]' ;;
    'api --paginate --slurp /repos/owner/repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100')
      jq -cn --arg mode "$REVIEW" '
        [{workflow_runs:(if $mode == "none" then [] else
          [{id:600,run_attempt:1,name:"Claude Review",event:"pull_request",
            path:".github/workflows/claude-review.yml@refs/heads/main",
            head_repository:{full_name:"owner/repo"},
            head_sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            head_branch:"ai/issue-36",created_at:"2026-01-01T00:01:00Z",
            pull_requests:[{number:37,head:{sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]}] end)}]' ;;
    'api --paginate --slurp /repos/owner/repo/actions/runs/600/attempts/1/jobs?per_page=100')
      jq -cn --arg mode "$REVIEW" '
        [{jobs:[{name:"Review",status:(if $mode == "queued" then "in_progress" else "completed" end),
          conclusion:(if $mode == "early_failure" then "failure"
            elif $mode == "skip" then "skipped"
            elif $mode == "queued" then null else "success" end),
          steps:(if $mode == "skip" or $mode == "queued" then [] else
            [{name:"Select Claude review model",status:"completed",conclusion:"success"}] end)}]}]' ;;
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
started=1767225600
jq -cn --arg a "$a" --argjson now "$((started + 50))" '
  {source_run_id:500,source_attempt:2,accepted_record_id:"201",cycle:null,
   validation:{automated_followup_count:1,branch_mutating_runs:[],branch_mutating_runs_complete:true,
     checks:[{id:20,name:"PR Traceability / Linked Issue",sha:$a,
       created_at:($now - 20),started_at:($now - 19),status:"pending"}],checks_complete:true,
     current_head_sha:$a,diff_guard_passed:true,followup_gate_passed:true,
     human_pause:false,now:$now,ready_started_at:($now - 30),repository_write:"pushed",
     requirements_gate_passed:true,validation_sha:$a}}' > "$tmp/durable.json"
run() { bash "$helper" owner/repo 500 2 99 37 36 101 "$tmp/durable.json"; }
list_records() {
  AI_RESUME_MAX_HISTORY_PAGES=10 \
    bash "$tmp/scripts/list-human-pause-records.sh" owner/repo 36 37 99
}
assert_result() {
  local expected="$1" actual
  actual="$(run | jq -r .result)"
  [ "$actual" = "$expected" ] || { echo "expected $expected, got $actual" >&2; exit 1; }
}
MODE=before
list_records | jq -e '.target == "pr:37" and [.records[].pause_id] == ["101"]' >/dev/null
assert_result pre_acceptance
[ "$(run | jq -c '[.actions[].action]')" = '["add_issue_human_label","add_pr_human_label"]' ]
MODE=accepted; ISSUE_LABEL=false; PR_LABEL=false
list_records | jq -e '.target == "pr:37" and [.records[].pause_id] == ["101","201"]
  and .records[1].record.payload.action == "validate"' >/dev/null
assert_result cycle_wait
NOW=1767226200
[ "$(run | jq -r '.actions[0].reason')" = validation_timeout ]
NOW=1767225650
jq '.validation.now = 1767225650 | .validation.checks[0].status = "failure"' \
  "$tmp/durable.json" > "$tmp/new.json"
mv "$tmp/new.json" "$tmp/durable.json"
[ "$(run | jq -r '.actions[0].reason')" = validation_failed ]
MODE=replacement; ISSUE_LABEL=true
list_records | jq -e '[.records[].pause_id] == ["101","201","301"]
  and .records[2].record.reason == "resume_transition_failed"' >/dev/null
[ "$(run | jq -c '[.actions[].action]')" = '["add_pr_human_label","remove_machine_label"]' ]
PR_LABEL=true
assert_result paused
MODE=validation_pause
assert_result paused
MODE=accepted; ISSUE_LABEL=false; PR_LABEL=false
REVIEW=early_failure; assert_result normal_review_owns
REVIEW=entered; assert_result normal_review_owns
REVIEW=queued
if run >/dev/null 2>&1; then echo 'Queued Review gained ownership.' >&2; exit 1; fi
REVIEW=skip; assert_result recover
REVIEW=none
jq '.validation.checks[0].status = "success"' "$tmp/durable.json" > "$tmp/new.json"
mv "$tmp/new.json" "$tmp/durable.json"
[ "$(run | jq -r '.actions[0].reason')" = resume_transition_failed ]
MACHINE=false
[ "$(run | jq -r '.actions[0].reason')" = resume_transition_failed ]
DRAFT=true
[ "$(run | jq -r '.actions[0].reason')" = resume_transition_failed ]
DRAFT=false
MACHINE=true
ISSUE_LABEL=true; PR_LABEL=false
[ "$(run | jq -r .result)" = recover ]
ISSUE_LABEL=false
run_without_evidence() { bash "$helper" owner/repo 500 2 99 37 36 101; }
[ "$(run_without_evidence | jq -r .code)" = durable_validation_evidence_missing ]
REVIEW=none; HEAD_MODE=stale
if run >/dev/null 2>&1; then echo 'HEAD change was accepted.' >&2; exit 1; fi
HEAD_MODE=current; RELATION=terminal
if run >/dev/null 2>&1; then echo 'Terminal target was accepted.' >&2; exit 1; fi
RELATION=wrong
if run >/dev/null 2>&1; then echo 'Wrong closing Issue relation was accepted.' >&2; exit 1; fi
RELATION=valid; RECORD_MODE=malformed
if run >/dev/null 2>&1; then echo 'Malformed record API response was accepted.' >&2; exit 1; fi
RECORD_MODE=valid; RUN_MODE=wrong
if run >/dev/null 2>&1; then echo 'Wrong source workflow was accepted.' >&2; exit 1; fi
RUN_MODE=valid; API_MODE=fail
if run >/dev/null 2>&1; then echo 'API failure was accepted.' >&2; exit 1; fi
API_MODE=valid
first="$(run)"; second="$(run)"; [ "$first" = "$second" ]
check_read_only_log() {
  local rc
  if grep -Eq 'api -X|issue edit|pr edit|dispatch' "$GH_LOG"; then rc=0; else rc=$?; fi
  case "$rc" in
    0) echo 'Recovery helper attempted a write.' >&2; return 1 ;;
    1) return 0 ;;
    *) echo "Repository write log search failed (exit $rc)." >&2; return 1 ;;
  esac
}
check_read_only_log
if (grep() { return 127; }; check_read_only_log >/dev/null 2>&1); then
  echo 'Missing repository write log search tool was accepted.' >&2; exit 1
fi
check_dormant_workflows() {
  local directory="$1" workflow rc
  local -a workflows
  if [ ! -d "$directory" ] || [ ! -r "$directory" ] || [ -L "$directory" ]; then
    echo "Production workflow directory is unavailable: $directory" >&2; return 1
  fi
  shopt -s nullglob
  workflows=("$directory"/*.yml "$directory"/*.yaml)
  if [ "${#workflows[@]}" -eq 0 ]; then
    echo "No production workflows found in $directory." >&2; return 1
  fi
  for workflow in "${workflows[@]}"; do
    if [ ! -f "$workflow" ] || [ ! -r "$workflow" ] || [ -L "$workflow" ]; then
      echo "Production workflow is not a readable regular file: $workflow" >&2
      return 1
    fi
    if grep -Eq 'prepare-ai-resume-validate-recovery\.sh' "$workflow"; then
      rc=0
    else
      rc=$?
    fi
    case "$rc" in
      0) echo "Prepared recovery became reachable from $workflow." >&2; return 1 ;;
      1) ;;
      *) echo "Production workflow search failed for $workflow (exit $rc)." >&2; return 1 ;;
    esac
  done
}
check_dormant_workflows "$root/.github/workflows"
mkdir "$tmp/empty-workflows" "$tmp/invalid-workflows"
if check_dormant_workflows "$tmp/empty-workflows" >/dev/null 2>&1; then exit 1; fi
ln -s "$root/.github/workflows" "$tmp/workflow-link"
if check_dormant_workflows "$tmp/workflow-link" >/dev/null 2>&1; then exit 1; fi
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
printf 'run: prepare-ai-resume-validate-recovery.sh\n' > "$tmp/invalid-workflows/reachable.yaml"
if check_dormant_workflows "$tmp/invalid-workflows" >/dev/null 2>&1; then exit 1; fi
if (grep() { return 127; }; check_dormant_workflows "$root/.github/workflows" >/dev/null 2>&1); then
  echo 'Missing workflow search tool was accepted.' >&2; exit 1
fi
echo 'prepare-ai-resume-validate-recovery fixture passed.'
