#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/scripts" "$tmp/bin" "$tmp/state"
cp "$root/consume-ai-resume-handoff.sh" "$tmp/scripts/"
export MOCK_DIR="$tmp/state"
export MOCK_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

cat > "$tmp/scripts/mock-helper.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
kind="$(basename "$0" .sh)"
accepted=no; [ ! -e "$MOCK_DIR/accepted" ] || accepted=yes
pause='{"version":1,"kind":"pause","target":"issue:36","reason":"developer_execution_failed","payload":{"failed_action":"develop"}}'
record="$(jq -nc --arg bad "${MOCK_BAD:-}" --arg h "$MOCK_HEAD" '{version:1,kind:"ai-resume-accepted",target:"issue:36",reason:"developer_execution_failed",source_pause_id:"101",payload:{action:"handoff",actor:(if $bad=="accepted_wrong_actor" then "other-user" else "suzukure" end),pr_number:37,pr_head:$h}}')"
case "$kind" in
  parse-ai-resume-command)
    jq -e --arg h "$MOCK_HEAD" 'if .body == ("/ai resume handoff pause:101 pr:37 head:"+$h) and .actor=="suzukure" and .author_association=="OWNER" then {result:"accepted",action:"handoff",actor:"suzukure",pause_id:"101",pr_number:37,head_sha:$h} else error("wrong command") end' ;;
  human-pause-record)
    case "$1" in validate) jq -en --argjson x "$2" '$x.version == 1' >/dev/null;;
      create) printf '%s\n' '<!-- ai-human-pause-record:start -->' "$2" '<!-- ai-human-pause-record:end -->';;
      *) exit 1;; esac ;;
  prepare-ai-resume-handoff)
    jq -e 'if .pause.result == "active" and .pull_request.checks.result == "success" then {result:"prepared_snapshot_only",write_authorized:false} else error("not eligible") end' ;;
  inspect-ai-handoff-ownership)
    [ "${MOCK_BAD:-}" != edited ] || exit 1
    if [ "$accepted" = yes ]; then
      jq -cn --arg h "$MOCK_HEAD" '{result:"handoff_owned",deny_develop:true,source_pause_id:"101",accepted_record_id:"102",pr_number:37,pr_head:$h}'
    else echo '{"result":"no_handoff_record","deny_develop":false}'; fi ;;
  list-human-pause-records)
    if [ "$accepted" = yes ]; then
      jq -cn --arg bad "${MOCK_BAD:-}" --argjson p "$pause" --argjson r "$record" '{target:(if $bad=="wrong_record_target" then "issue:99" else "issue:36" end),records:([{pause_id:"101",record:$p},{pause_id:"102",record:$r}] + (if $bad=="duplicate_accepted" then [{pause_id:"103",record:$r}] else [] end))}'
    else jq -cn --arg bad "${MOCK_BAD:-}" --argjson p "$pause" '{target:(if $bad=="wrong_record_target" then "issue:99" else "issue:36" end),records:[{pause_id:"101",record:$p}]}'; fi ;;
  validate-human-pause-record-graph) cat ;;
  decompose-human-pause-record-graph) jq '{target,chains:[{records:.records}]}' ;;
  derive-human-pause-pre-resume-state) jq '.chains |= map(. + {pre_resume:{status:"active",pause_id:"101",reason:"developer_execution_failed"}})' ;;
  reconcile-human-pause-resume-acceptance)
    if [ "${MOCK_BAD:-}" = historical_consumed_chain ]; then
      jq --argjson accepted "$(if [ "$accepted" = yes ]; then echo true; else echo false; fi)" '
        .chains |= map(. + {effective:(if $accepted then
          {status:"consumed",pause_id:"101",reason:"developer_execution_failed",accepted_record_id:"102"}
          else {status:"active",pause_id:"101",reason:"developer_execution_failed"} end)})
        | .chains += [{records:[{pause_id:"88",record:{kind:"pause",reason:"developer_execution_failed"}}],
                      pre_resume:{status:"active",pause_id:"88",reason:"developer_execution_failed"},
                      effective:{status:"consumed",pause_id:"88",reason:"developer_execution_failed",accepted_record_id:"89"}}]'
    elif [ "$accepted" = yes ]; then
      jq '.chains |= map(. + {effective:{status:"consumed",pause_id:"101",reason:"developer_execution_failed",accepted_record_id:"102"}})'
    else jq '.chains |= map(. + {effective:{status:"active",pause_id:"101",reason:"developer_execution_failed"}})'; fi ;;
  reconcile-human-pause-active-pause)
    if [ "$accepted" = yes ]; then echo '{"target":"issue:36","result":"no_active_pause"}'
    elif [ "${MOCK_BAD:-}" = different_active_pause ]; then echo '{"target":"issue:36","result":"active","active_pause":{"pause_id":"999","reason":"developer_execution_failed"}}'
    else echo '{"target":"issue:36","result":"active","active_pause":{"pause_id":"101","reason":"developer_execution_failed"}}'; fi ;;
  *) echo "unexpected helper: $kind" >&2; exit 7;;
esac
STUB
for name in parse-ai-resume-command human-pause-record prepare-ai-resume-handoff \
  inspect-ai-handoff-ownership list-human-pause-records validate-human-pause-record-graph \
  decompose-human-pause-record-graph derive-human-pause-pre-resume-state \
  reconcile-human-pause-resume-acceptance reconcile-human-pause-active-pause; do
  cp "$tmp/scripts/mock-helper.sh" "$tmp/scripts/$name.sh"
done

cat > "$tmp/bin/gh" <<'GHMOCK'
#!/usr/bin/env bash
set -euo pipefail
repo=suzukure/nssscdl; sha="$MOCK_HEAD"
if [ "$1" = api ] && [ "$2" = graphql ]; then
  jq -cn --arg h "$sha" --arg bad "${MOCK_BAD:-}" '
    [{data:{repository:{pullRequests:{nodes:([
      {number:37,state:"OPEN",isDraft:true,headRefOid:$h,baseRefName:"main",author:{login:(if $bad=="canonical_wrong_author" then "someone-else" else "suzukure" end)},
       headRepository:{nameWithOwner:"suzukure/nssscdl"},baseRepository:{nameWithOwner:"suzukure/nssscdl"},
       closingIssuesReferences:{nodes:([{number:36,repository:{nameWithOwner:"suzukure/nssscdl"}}]
         + (if $bad=="two_closings" then [{number:35,repository:{nameWithOwner:"suzukure/nssscdl"}}] else [] end)),
         pageInfo:{hasNextPage:false}}}]
      + (if $bad=="duplicate_pr" then [{number:40,state:"OPEN",isDraft:true,headRefOid:$h,baseRefName:"main",
         closingIssuesReferences:{nodes:[{number:36,repository:{nameWithOwner:"suzukure/nssscdl"}}],pageInfo:{hasNextPage:false}}}] else [] end)),
        pageInfo:{hasNextPage:($bad=="incomplete_pages"),endCursor:(if $bad=="incomplete_pages" then "cursor-x" else null end)}}}}}]
  | if $bad=="pagination_bound" then .[0] as $page | [range(0;11) | $page]
    elif $bad=="pr_count_bound" then .[0] as $base |
      [range(0;10) as $i |
        ($base
         | .data.repository.pullRequests.nodes =
             [range(0;100) as $j |
              ($base.data.repository.pullRequests.nodes[0]
               | .number = (1000 + $i*100 + $j)
               | .closingIssuesReferences.nodes = [])]
         | .data.repository.pullRequests.pageInfo =
             {hasNextPage:($i < 9),endCursor:(if $i < 9 then ("cursor"+($i|tostring)) else null end)})]
    else . end
  ' ; exit
fi
if [ "$1" = api ] && [ "$2" = --paginate ]; then
  jq -cn --arg h "$sha" --arg bad "${MOCK_BAD:-}" '[{total_count:2,check_runs:[
    {id:1,head_sha:$h,name:"Product CI",status:"completed",conclusion:(if $bad=="failed_ci" then "failure" else "success" end),
     app:{id:(if $bad=="spoof_ci_app" then 88 else 15368 end),slug:(if $bad=="spoof_ci_app" then "other-app" else "github-actions" end)},
     details_url:"https://github.com/suzukure/nssscdl/actions/runs/600/job/1"},
    {id:2,head_sha:$h,name:"Linked Issue",status:"completed",conclusion:"skipped"}]}]'; exit
fi
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = POST ]; then
  echo 'POST' >> "$MOCK_DIR/posts"
  if [ "${MOCK_BAD:-}" != post_no_record ]; then : > "$MOCK_DIR/accepted"; fi
  if [ "${MOCK_BAD:-}" = unknown_post ] || [ "${MOCK_BAD:-}" = post_no_record ]; then exit 1; fi
  echo '{"id":102}'; exit
fi
if [ "$1" = api ]; then
  endpoint="$2"
  case "$endpoint" in
    /repos/$repo/issues/comments/201)
      jq -cn --arg h "$sha" --arg bad "${MOCK_BAD:-}" '{id:201,issue_url:"https://api.github.com/repos/suzukure/nssscdl/issues/36",user:{login:"suzukure"},author_association:"OWNER",created_at:(if $bad=="missing_command_timestamp" then null else "2026-10-27T03:00:00Z" end),updated_at:(if $bad=="edited_command" then "2026-10-27T03:01:00Z" else "2026-10-27T03:00:00Z" end),body:("/ai resume handoff pause:101 pr:37 head:"+$h)}' ;;
    /repos/$repo/issues/comments/101)
      jq -cn --arg bad "${MOCK_BAD:-}" '{id:101,issue_url:"https://api.github.com/repos/suzukure/nssscdl/issues/36",performed_via_github_app:{id:(if $bad=="wrong_app" then 99 else 42 end)},created_at:(if $bad=="missing_source_timestamp" then null else "2026-10-27T02:00:00Z" end),updated_at:"2026-10-27T02:00:00Z"}' ;;
    /repos/$repo/issues/36|/repos/$repo/issues/37)
      number="${endpoint##*/}"; if [ "$number" = 36 ]; then state=issue; else state=pr; fi
      if [ -e "$MOCK_DIR/$state-label" ]; then label='[{"name":"human-review-required"}]'; else label='[]'; fi
      jq -cn --argjson n "$number" --argjson labels "$label" '{number:$n,state:"open",labels:$labels}' ;;
    /repos/$repo/pulls/37)
      jq -cn --arg h "$sha" --arg bad "${MOCK_BAD:-}" '{number:37,state:(if $bad=="closed_pr" then "closed" else "open" end),draft:true,user:{login:(if $bad=="rest_wrong_author" then "someone-else" else "suzukure" end)},head:{sha:(if $bad=="stale_head" then "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" else $h end),ref:(if $bad=="untrusted_branch" then "ai/other-36-work" else "human/issue-36-work" end),repo:{full_name:"suzukure/nssscdl"}},base:{ref:"main",repo:{full_name:"suzukure/nssscdl"}}}' ;;
    /repos/$repo/actions/runs/600)
      jq -cn --arg h "$sha" --arg bad "${MOCK_BAD:-}" '{id:600,head_sha:(if $bad=="stale_ci_run" then "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" else $h end),
        path:(if $bad=="wrong_ci_workflow" then ".github/workflows/other.yml" else ".github/workflows/product-ci.yml" end),
        status:"completed",conclusion:"success",event:"pull_request",
        head_branch:(if $bad=="foreign_branch_ci" then "human/issue-999-work" else "human/issue-36-work" end),
        repository:{full_name:"suzukure/nssscdl",id:1348220387},head_repository:{full_name:"suzukure/nssscdl",id:1348220387},
        pull_requests:(if $bad=="no_pr_ci" then [] else [{number:(if $bad=="foreign_pr_ci" then 999 else 37 end),
          head:{ref:"human/issue-36-work",sha:(if $bad=="foreign_pr_head_ci" then "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" else $h end),repo:{id:(if $bad=="foreign_head_repo_ci" then 12 else 1348220387 end)}},
          base:{ref:"main",repo:{id:(if $bad=="foreign_base_repo_ci" then 13 else 1348220387 end)}}}] end)}' ;;
    /repos/$repo/actions/workflows/ai-developer.yml/runs*)
      if [ "${MOCK_BAD:-}" = historic_action_required ] && [[ "$endpoint" == *'status=action_required' ]]; then
        echo '{"total_count":1,"workflow_runs":[{"id":888,"status":"completed","conclusion":"action_required"}]}'
      elif [ "${MOCK_BAD:-}" = active_writer ]; then echo '{"total_count":1,"workflow_runs":[{"id":887}]}'; else echo '{"total_count":0,"workflow_runs":[]}'; fi ;;
    *) echo "unexpected API: $endpoint" >&2; exit 7;;
  esac
  exit
fi
if [ "$1" = issue ] && [ "$2" = edit ]; then
  if [ "$3" = 36 ]; then state=issue; elif [ "$3" = 37 ]; then state=pr; else exit 7; fi
  echo "$state" >> "$MOCK_DIR/labels"
  if [ "${MOCK_BAD:-}" = label_still_present ]; then exit 1; fi
  rm -f "$MOCK_DIR/$state-label"
  if [ "${MOCK_BAD:-}" = label_response_unknown ]; then exit 1; fi
  exit
fi
exit 7
GHMOCK
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

reset_state() { rm -f "$MOCK_DIR"/*; touch "$MOCK_DIR/issue-label" "$MOCK_DIR/pr-label"; }
run_good() {
  local name="$1" mode="$2" posts="$3"
  reset_state
  if [ "$mode" = accepted ] || [ "$mode" = partial ]; then touch "$MOCK_DIR/accepted"; fi
  if [ "$mode" = partial ]; then rm "$MOCK_DIR/issue-label"; fi
  export MOCK_BAD="${4:-}"
  bash "$tmp/scripts/consume-ai-resume-handoff.sh" suzukure/nssscdl 36 201 42 > "$tmp/output" || { echo "unexpected failure $name" >&2; exit 1; }
  jq -e '.result == "handoff_consumer_complete" and .accepted_record_id=="102" and .draft_unchanged==true' "$tmp/output" >/dev/null
  actual=0
  if [ -f "$MOCK_DIR/posts" ]; then actual="$(grep -c '^POST$' "$MOCK_DIR/posts" || true)"; fi
  [ "$actual" = "$posts" ] || { echo "unexpected POST count $name: $actual" >&2; exit 1; }
  [ ! -f "$MOCK_DIR/issue-label" ]
  [ ! -f "$MOCK_DIR/pr-label" ]
  echo "$name: PASS"
}
run_bad() {
  local name="$1" bad="$2" posts="$3"
  reset_state; export MOCK_BAD="$bad"
  if [ "$bad" = duplicate_accepted ] || [ "$bad" = accepted_wrong_actor ] || [ "${4:-}" = accepted ]; then touch "$MOCK_DIR/accepted"; fi
  if bash "$tmp/scripts/consume-ai-resume-handoff.sh" suzukure/nssscdl 36 201 42 > "$tmp/output" 2> "$tmp/error"; then
    echo "unsafe success $name" >&2; exit 1
  fi
  actual=0
  if [ -f "$MOCK_DIR/posts" ]; then actual="$(grep -c '^POST$' "$MOCK_DIR/posts" || true)"; fi
  [ "$actual" = "$posts" ] || { echo "unexpected POST count $name: $actual" >&2; exit 1; }
  [ -f "$MOCK_DIR/issue-label" ]
  [ -f "$MOCK_DIR/pr-label" ]
  # Require the specific fail-closed decision, not a mock syntax/API failure.
  local reason=""
  case "$bad" in
    missing_command_timestamp) reason=command_provenance_invalid ;;
    missing_source_timestamp) reason=source_provenance_invalid ;;
    wrong_record_target) reason=wrong_record_target ;;
    different_active_pause) reason=different_active_pause ;;
    canonical_wrong_author) reason=pr_canonical_identity_mismatch ;;
    rest_wrong_author|closed_pr|stale_head) reason=stale_or_invalid_pr ;;
    pagination_bound) reason=pr_listing_incomplete ;;
    pr_count_bound) reason=pr_listing_bound ;;
    accepted_wrong_actor) reason=accepted_identity_mismatch ;;
  esac
  if [ -n "$reason" ]; then
    grep -Fq "consume-ai-resume-handoff: STOP $reason" "$tmp/error" || {
      echo "unexpected stop reason $name" >&2; cat "$tmp/error" >&2; exit 1;
    }
  fi
  case "$bad" in
    foreign_*_ci|no_pr_ci|untrusted_branch|missing_*_timestamp|wrong_record_target|different_active_pause|canonical_wrong_author|rest_wrong_author|pagination_bound|pr_count_bound|closed_pr|stale_head|accepted_wrong_actor)
      [ ! -f "$MOCK_DIR/labels" ] || { echo "unexpected label write $name" >&2; exit 1; } ;;
  esac
  echo "$name: PASS"
}
run_good normal normal 1
run_good unknown_post normal 1 unknown_post
run_good accepted_reentry accepted 0
run_good partially_synced_reentry partial 0
run_good label_response_unknown normal 1 label_response_unknown
run_good completed_action_required_not_writer normal 1 historic_action_required
run_good prior_consumed_history_is_legal normal 1 historical_consumed_chain
run_bad ambiguous_open_pr duplicate_pr 0
run_bad multiple_closing_issue two_closings 0
run_bad edited_trusted_comment edited 0
run_bad stale_head stale_head 0
run_bad edited_command edited_command 0
run_bad source_wrong_app wrong_app 0
run_bad incomplete_graphql_page incomplete_pages 0
run_bad product_ci_failure failed_ci 0
run_bad spoofed_product_ci_app spoof_ci_app 0
run_bad wrong_ci_workflow wrong_ci_workflow 0
run_bad stale_ci_run stale_ci_run 0
run_bad foreign_pr_ci foreign_pr_ci 0
run_bad foreign_branch_ci foreign_branch_ci 0
run_bad missing_pr_ci_relation no_pr_ci 0
run_bad foreign_head_repo_ci foreign_head_repo_ci 0
run_bad foreign_pr_head_ci foreign_pr_head_ci 0
run_bad foreign_base_repo_ci foreign_base_repo_ci 0
run_bad untrusted_head_branch untrusted_branch 0
run_bad active_writer active_writer 0
run_bad post_unknown_not_verified post_no_record 1
run_bad accepted_duplicate duplicate_accepted 0
run_bad label_removal_unconfirmed label_still_present 1
run_bad missing_command_created_at missing_command_timestamp 0
run_bad missing_source_created_at missing_source_timestamp 0
run_bad wrong_record_target wrong_record_target 0
run_bad different_active_pause different_active_pause 0
run_bad canonical_author_mismatch canonical_wrong_author 0
run_bad pr_author_mismatch rest_wrong_author 0
run_bad graphql_page_limit pagination_bound 0
run_bad graphql_pr_count_limit pr_count_bound 0
run_bad pr_closed closed_pr 0
run_bad accepted_wrong_actor accepted_wrong_actor 0
run_bad accepted_pr_closed closed_pr 0 accepted
run_bad accepted_head_changed stale_head 0 accepted

# Integration contract: use the *actual* main #1097 / human-pause helpers,
# retaining a secretless gh mock solely at the GitHub trust boundary. The
# standalone tests above intentionally stub the helpers for fault injection.
mkdir -p "$tmp/real"
cp "$tmp/scripts/consume-ai-resume-handoff.sh" "$tmp/real/"
for name in parse-ai-resume-command human-pause-record prepare-ai-resume-handoff \
  inspect-ai-handoff-ownership list-human-pause-records validate-human-pause-record-graph \
  decompose-human-pause-record-graph derive-human-pause-pre-resume-state \
  reconcile-human-pause-resume-acceptance reconcile-human-pause-active-pause; do
  cp "$root/$name.sh" "$tmp/real/$name.sh"
done
mv "$tmp/bin/gh" "$tmp/bin/gh-standalone"
cat > "$tmp/bin/gh" <<'REAL_GH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = api ] && [[ " $* " == *'/repos/suzukure/nssscdl/issues/36/comments'* ]] \
  && [[ " $* " == *' --paginate '* ]]; then
  p='{"version":1,"kind":"pause","target":"issue:36","reason":"developer_execution_failed","payload":{"failed_action":"develop"}}'
  r="$(jq -cn --arg h "$MOCK_HEAD" '{version:1,kind:"ai-resume-accepted",target:"issue:36",reason:"developer_execution_failed",source_pause_id:"101",payload:{action:"handoff",actor:"suzukure",pr_number:37,pr_head:$h}}')"
  jq -cn --arg p "$p" --arg r "$r" --arg bad "${REAL_BAD:-}" \
    --argjson accepted "$(if [ -f "$MOCK_DIR/accepted" ]; then echo true; else echo false; fi)" '
    def body($x): "<!-- ai-human-pause-record:start -->\n"+$x+"\n<!-- ai-human-pause-record:end -->";
    [[{id:101,issue_url:"https://api.github.com/repos/suzukure/nssscdl/issues/36",
       performed_via_github_app:{id:42},created_at:"2026-10-27T02:00:00Z",
       updated_at:(if $bad=="edited" then "2026-10-27T02:00:01Z" else "2026-10-27T02:00:00Z" end),body:body($p)}]
    + (if $accepted then [{id:102,issue_url:"https://api.github.com/repos/suzukure/nssscdl/issues/36",
         performed_via_github_app:{id:42},created_at:"2026-10-27T04:00:00Z",
         updated_at:"2026-10-27T04:00:00Z",body:body($r)}] else [] end)]'
  exit
fi
exec "$(dirname "$0")/gh-standalone" "$@"
REAL_GH
chmod +x "$tmp/bin/gh"
reset_state; unset MOCK_BAD REAL_BAD
bash "$tmp/real/consume-ai-resume-handoff.sh" suzukure/nssscdl 36 201 42 > "$tmp/real-output"
jq -e '.result=="handoff_consumer_complete" and .accepted_record_id=="102"' "$tmp/real-output" >/dev/null
[ "$(grep -c '^POST$' "$MOCK_DIR/posts")" = 1 ]
[ ! -f "$MOCK_DIR/issue-label" ]
[ ! -f "$MOCK_DIR/pr-label" ]
echo 'real_helpers_normal: PASS'
# After the accepted record exists, reentry verifies the real graph again;
# there must be no second POST and no accidental relapse into active-pause gate.
: > "$MOCK_DIR/posts"
bash "$tmp/real/consume-ai-resume-handoff.sh" suzukure/nssscdl 36 201 42 > "$tmp/real-output"
[ ! -s "$MOCK_DIR/posts" ] && echo 'real_helpers_accepted_reentry: PASS'
reset_state; export REAL_BAD=edited
if bash "$tmp/real/consume-ai-resume-handoff.sh" suzukure/nssscdl 36 201 42 > "$tmp/real-output" 2> "$tmp/real-error"; then
  echo 'real inspector accepted edited trusted App comment' >&2; exit 1
fi
[ ! -f "$MOCK_DIR/posts" ] && echo 'real_helpers_edited_trusted_comment: PASS'

printf '%s\n' 'consumer mock: 44 cases PASS (no real GitHub/API access)'
