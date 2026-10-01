#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export WORK="$work" GH_TOKEN=fixture REVIEW_APP_TOKEN=fixture
head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
base=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export head base
jq -cn --arg head "$head" --arg base "$base" '
  {run_id:10,attempt:1,identity:{repo:"owner/repo",pr_number:37,validated_sha:$head,
    round:1,head_ref:"ai/issue-36",base_ref:"main",trusted_base_sha:$base,closing_issue_number:36}}
' > "$work/paid-start.json"
cp "$work/paid-start.json" "$work/accepted.json"
(cd "$work" && zip -q paid.zip paid-start.json && zip -q accepted.zip accepted.json)
: > "$work/pauses"
: > "$work/cleanups"

gh() {
  local endpoint="${*: -1}"
  case "$1 $2" in
    'api --paginate')
      case "$endpoint" in
        */artifacts\?*)
          if [[ "$endpoint" == *'/runs/11/'* ]]; then echo '[{"artifacts":[]}]'; return; fi
          case "${CASE:-}" in
            missing_artifact) echo '[{"artifacts":[]}]' ;;
            ambiguous_artifact) echo '[{"artifacts":[{"id":81,"name":"auto-accepted-10-1","expired":false},{"id":82,"name":"auto-accepted-10-1","expired":false}]}]' ;;
            no_paid|label_lost) echo '[{"artifacts":[{"id":81,"name":"auto-accepted-10-1","expired":false}]}]' ;;
            *) echo '[{"artifacts":[{"id":80,"name":"auto-paid-10-1","expired":false},{"id":81,"name":"auto-accepted-10-1","expired":false}]}]' ;;
          esac ;;
        */jobs\?*)
          if [[ "$endpoint" == *'/runs/11/'* ]]; then
            if [ "${CASE:-}" = normal_paid ]; then
              echo '[{"jobs":[{"name":"Review","conclusion":"failure","steps":[{"name":"Run Claude review","conclusion":"failure"}]}]}]'
            else echo '[{"jobs":[{"name":"Review","conclusion":"skipped","steps":[]}]}]'; fi
            return
          fi
          local conclusion=failure classify=failure budget=skipped spend=skipped paid=failure suppress=missing pause=missing
          case "${CASE:-}" in
            success) conclusion=success ;;
            skipped) conclusion=skipped ;;
            timeout) conclusion=timed_out ;;
            cancel) conclusion=cancelled ;;
            budget) budget=success ;;
            spend) spend=success ;;
            classified|verdict_posted) classify=success ;;
            no_paid|label_lost) paid=missing ;;
            suppressed) suppress=success ;;
            paused) pause=success ;;
          esac
          jq -cn --arg conclusion "$conclusion" --arg classify "$classify" \
            --arg budget "$budget" --arg spend "$spend" --arg paid "$paid" \
            --arg suppress "$suppress" --arg pause "$pause" \
            '[{jobs:[{name:"Auto Review",conclusion:$conclusion,steps:[
              {name:"Run Claude review",conclusion:$paid},
              {name:"Signal verdict suppressed",conclusion:$suppress},
              {name:"Pause for human decision",conclusion:$pause},
              {name:"Classify and validate review",conclusion:$classify},
              {name:"Signal RUN_BUDGET_LIMIT_REACHED",conclusion:$budget},
              {name:"Signal ACCOUNT_SPEND_LIMIT_REACHED",conclusion:$spend}]}]}]' ;;
        */reviews\?*)
          [ "${CASE:-}" != reviews_failure ] || return 1
          if [ "${CASE:-}" = verdict_posted ]; then
            jq -cn --arg head "$head" '[[{commit_id:$head,user:{login:"reviewer[bot]"},state:"APPROVED",submitted_at:"2026-09-28T01:01:00Z"}]]'
          else echo '[[]]'; fi ;;
        */runs\?*)
          if [ "${CASE:-}" = newer ] && [[ "$endpoint" == *'/workflows/7/'* ]]; then
            echo '[{"workflow_runs":[{"id":11,"run_attempt":1,"status":"queued"}]}]'
          elif [[ "${CASE:-}" == normal_skipped || "${CASE:-}" == normal_paid || "${CASE:-}" == normal_ambiguous ]] && [[ "$endpoint" == *'claude-review.yml'* ]]; then
            if [ "${CASE:-}" = normal_ambiguous ]; then
              echo '[{"workflow_runs":[{"id":11,"run_attempt":1,"head_branch":"ai/issue-36","head_repository":{"full_name":"owner/repo"},"pull_requests":[]}]}]'
              return
            fi
            jq -cn --arg head "$head" '[{workflow_runs:[{id:11,run_attempt:1,pull_requests:[{number:37,head:{sha:$head}}]}]}]'
          else echo '[{"workflow_runs":[]}]'; fi ;;
        *) echo "unexpected paginated API: $endpoint" >&2; return 2 ;;
      esac ;;
    'api /repos/owner/repo') echo main ;;
    'api /repos/owner/repo/actions/runs/10')
      jq -cn --arg head "$base" --arg case "${CASE:-}" '
        {id:10,run_attempt:1,name:"Claude Auto Rereview",event:"repository_dispatch",
         status:"completed",run_started_at:"2026-09-28T01:00:00Z",head_repository:{full_name:"owner/repo"},head_branch:"main",
         head_sha:$head,path:".github/workflows/claude-auto-rereview.yml@refs/heads/main",workflow_id:7}
        | if $case == "wrong_source" then .event="pull_request" else . end' ;;
    'api /repos/owner/repo/actions/runs/10/attempts/1') echo '{"id":10,"run_attempt":1,"status":"completed"}' ;;
    'api /repos/owner/repo/actions/artifacts/80/zip') cat "$WORK/paid.zip" ;;
    'api /repos/owner/repo/actions/artifacts/81/zip') cat "$WORK/accepted.zip" ;;
    'api /repos/owner/repo/pulls/37')
      [ "${CASE:-}" != api_failure ] || return 1
      local current="$head"
      [ "${CASE:-}" = old_head ] && current=cccccccccccccccccccccccccccccccccccccccc
      local labels='[]'
      [ "${CASE:-}" = no_paid ] && labels='[{"name":"ai-followup-in-progress"}]'
      jq -cn --arg head "$current" --argjson labels "$labels" '{number:37,state:"open",draft:false,labels:$labels,
        head:{sha:$head,ref:"ai/issue-36",repo:{full_name:"owner/repo"}}}' ;;
    'api /apps/reviewer') echo 99 ;;
    'pr view')
      if [ "${CASE:-}" = ambiguous_relation ]; then echo '{"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","closingIssuesReferences":[]}' ; return; fi
      jq -cn --arg head "$head" '{headRefOid:$head,
        closingIssuesReferences:[{number:36,url:"https://github.com/owner/repo/issues/36"}]}' ;;
    'issue edit') echo "$3" >> "$WORK/cleanups" ;;
    *) echo "unexpected gh call: $*" >&2; return 2 ;;
  esac
}
bash() {
  if [[ "$1" == */create-human-pause.sh ]]; then
    if [ "$2" = inspect ]; then echo '{"result":"already_active","pause_id":"101"}'; return; fi
    if [ -s "$WORK/pauses" ]; then echo '{"result":"already_active","pause_id":"101"}'; return; fi
    echo "$*" >> "$WORK/pauses"
    echo '{"result":"created","pause_id":"101"}'
  elif [[ "$1" == */list-human-pause-records.sh ]]; then
    echo '{}'
  elif [[ "$1" == */reconcile-human-pause-active-pause.sh ]]; then
    cat >/dev/null
    if [ "${CASE:-}" = paused_record ]; then
      echo '{"result":"active","active_pause":{"pause_id":"101","reason":"human_pause"}}'
    else echo '{"result":"no_active_pause"}'; fi
  elif [[ "$1" == */validate-human-pause-record-graph.sh || "$1" == */decompose-human-pause-record-graph.sh || "$1" == */derive-human-pause-pre-resume-state.sh || "$1" == */reconcile-human-pause-resume-acceptance.sh ]]; then
    cat
  else command bash "$@"; fi
}
export -f gh bash
run_case() { CASE="$1"; export CASE; command bash "$script_dir/handle-claude-auto-rereview-failure.sh" owner/repo 10 1 reviewer; }
for pair in 'success:ignored' 'skipped:ignored' 'budget:explicit_limit' 'spend:explicit_limit' \
  'suppressed:verdict_suppressed' 'paused:paused' 'paused_record:paused' 'verdict_posted:verdict_posted' \
  'old_head:stale_pr' 'normal_paid:superseded' 'no_paid:no_paid_execution' \
  'missing_artifact:no_accepted_identity'; do
  case_name="${pair%%:*}" expected="${pair#*:}"
  result="$(run_case "$case_name")"
  jq -e --arg result "$expected" '.result == $result' <<< "$result" >/dev/null
  [ ! -s "$work/pauses" ]
  if [ "$case_name" = paused_record ]; then
    [ "$(wc -l < "$work/cleanups")" -eq 1 ]
    : > "$work/cleanups"
  else [ ! -s "$work/cleanups" ]; fi
done
if run_case newer >/dev/null 2>&1; then
  echo 'Pending newer dispatch was ignored.' >&2; exit 1
fi
for bad_case in api_failure ambiguous_relation ambiguous_artifact reviews_failure normal_ambiguous; do
  if run_case "$bad_case" >/dev/null 2>&1; then
    echo "$bad_case reached an unsafe pause." >&2; exit 1
  fi
  [ ! -s "$work/pauses" ] && [ ! -s "$work/cleanups" ]
done
if run_case wrong_source >/dev/null 2>&1; then
  echo 'Untrusted source workflow was accepted.' >&2; exit 1
fi
for case_name in failure timeout cancel classified normal_skipped label_lost; do
  : > "$work/pauses"; : > "$work/cleanups"
  run_case "$case_name" >/dev/null
  [ "$(wc -l < "$work/pauses")" -eq 1 ]
  [ "$(wc -l < "$work/cleanups")" -eq 1 ]
  if [ "$case_name" = label_lost ]; then grep -Fq 'state_inconsistent' "$work/pauses"; fi
done
: > "$work/pauses"; : > "$work/cleanups"
run_case failure >/dev/null
[ "$(wc -l < "$work/pauses")" -eq 1 ]
grep -Fq 'claude_execution_failed' "$work/pauses"
grep -Fq 'Claude自動再レビューが正常完了しませんでした。' "$work/pauses"
grep -Fq 'Claude auto-rereview execution did not complete.' "$work/pauses"
echo 'Claude auto-rereview independent failure fixtures passed.'
