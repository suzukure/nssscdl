#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
for script in prepare-ai-resume-validate-recovery prepare-ai-resume-validate-cycle \
  evaluate-current-head-validation validate-human-pause-record-graph \
  decompose-human-pause-record-graph derive-human-pause-pre-resume-state \
  reconcile-human-pause-resume-acceptance reconcile-human-pause-active-pause; do
  cp "$root/.github/scripts/$script.sh" "$tmp/scripts/"
done
helper="$tmp/scripts/prepare-ai-resume-validate-recovery.sh"
a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export MODE=accepted ISSUE_LABEL=false PR_LABEL=false REVIEW=none HEAD_MODE=current \
  RUN_MODE=valid RELATION=valid DRAFT=false MACHINE=true API_MODE=valid NOW=1767225650
date() {
  if [ "$*" = '-u +%s' ]; then printf '%s\n' "$NOW"; else command date "$@"; fi
}
export -f date
export GH_LOG="$tmp/gh.log"
: > "$GH_LOG"
cat > "$tmp/scripts/resolve-ai-resume-target.sh" <<'STUB'
#!/usr/bin/env bash
jq -cn --arg relation "$RELATION" --arg head "$HEAD_MODE" '
  {target:"pr:37",closing_issue:{number:(if $relation == "wrong" then 99 else 36 end),state:"open"},
   pull_request:{number:37,state:(if $relation == "terminal" then "closed" else "open" end),
    base_ref:"main",head_ref:"ai/issue-36",
    head_sha:(if $head == "stale" then "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" else
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" end)}}'
STUB
cat > "$tmp/scripts/list-human-pause-records.sh" <<'STUB'
#!/usr/bin/env bash
jq -cn --arg mode "$MODE" '
  {target:"pr:37",records:
    ([{pause_id:"101",record:{version:1,kind:"pause",reason:"validation_failed",
      target:"pr:37",paused_head:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]
    + if $mode == "before" then [] else
        [{pause_id:"201",record:{version:1,kind:"ai-resume-accepted",
          reason:"validation_failed",target:"pr:37",source_pause_id:"101",
          payload:{action:"validate",accepted_actor:"alice",command_comment_id:"150",
            accepted_head:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}] end
    + if $mode == "replacement" then
        [{pause_id:"301",record:{version:1,kind:"pause",reason:"resume_transition_failed",
          target:"pr:37",source_pause_id:"201",payload:{failed_action:"validate"}}}]
      elif $mode == "validation_pause" then
        [{pause_id:"301",record:{version:1,kind:"pause",reason:"validation_failed",
          target:"pr:37",paused_head:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]
      else [] end)}'
STUB
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  [ "$API_MODE" = valid ] || { echo 'API unavailable' >&2; return 1; }
  case "$*" in
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
assert_result() {
  local expected="$1" actual
  actual="$(run | jq -r .result)"
  [ "$actual" = "$expected" ] || { echo "expected $expected, got $actual" >&2; exit 1; }
}
MODE=before; assert_result pre_acceptance
[ "$(run | jq -c '[.actions[].action]')" = '["add_issue_human_label","add_pr_human_label"]' ]
MODE=accepted; ISSUE_LABEL=false; PR_LABEL=false
assert_result cycle_wait
NOW=1767226200
[ "$(run | jq -r '.actions[0].reason')" = validation_timeout ]
NOW=1767225650
jq '.validation.now = 1767225650 | .validation.checks[0].status = "failure"' \
  "$tmp/durable.json" > "$tmp/new.json"
mv "$tmp/new.json" "$tmp/durable.json"
[ "$(run | jq -r '.actions[0].reason')" = validation_failed ]
MODE=replacement; ISSUE_LABEL=true
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
RELATION=valid; RUN_MODE=wrong
if run >/dev/null 2>&1; then echo 'Wrong source workflow was accepted.' >&2; exit 1; fi
RUN_MODE=valid; API_MODE=fail
if run >/dev/null 2>&1; then echo 'API failure was accepted.' >&2; exit 1; fi
API_MODE=valid
first="$(run)"; second="$(run)"; [ "$first" = "$second" ]
if grep -Eq 'api -X|issue edit|pr edit|dispatch' "$GH_LOG"; then
  echo 'Recovery helper attempted a write.' >&2; exit 1
fi
if rg -l 'prepare-ai-resume-validate-recovery\.sh' "$root/.github/workflows" >/dev/null; then
  echo 'Prepared recovery became reachable.' >&2; exit 1
fi
echo 'prepare-ai-resume-validate-recovery fixture passed.'
