#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
cp "$root/.github/scripts/consume-ai-resume-review.sh" "$tmp/scripts/"
helper="$tmp/scripts/consume-ai-resume-review.sh"
export MOCK_DIR="$tmp"
export MOCK_MODE=valid
export MOCK_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf 'no\n' > "$tmp/accepted"
printf 'present\n' > "$tmp/issue"
printf 'present\n' > "$tmp/pr"
: > "$tmp/writes"
cat > "$tmp/scripts/prepare-ai-resume-review-consumer.sh" <<'STUB'
#!/usr/bin/env bash
cat >/dev/null
if [ "$(cat "$MOCK_DIR/accepted")" = yes ]; then
  echo '{"result":"ignore","code":"stale_or_consumed"}'
else
  jq -cn --arg head "$MOCK_HEAD" '
    {result:"accepted_candidate",
     identity:{closing_issue_number:36,pr_number:37,source_pause_id:"101",head:$head},
     accepted_record:{version:1,kind:"ai-resume-accepted",reason:"claude_execution_failed",
       target:"pr:37",source_pause_id:"101",payload:{action:"review",accepted_actor:"alice"}}}'
fi
STUB
cat > "$tmp/scripts/human-pause-record.sh" <<'STUB'
#!/usr/bin/env bash
echo body
STUB
cat > "$tmp/scripts/list-human-pause-records.sh" <<'STUB'
#!/usr/bin/env bash
if [ "$(cat "$MOCK_DIR/accepted")" = yes ]; then
  jq -cn '{target:"pr:37",chains:[{effective:{status:"consumed",pause_id:"101",accepted_record_id:"201"},
    records:[{pause_id:"201",record:{version:1,kind:"ai-resume-accepted",reason:"claude_execution_failed",
      target:"pr:37",source_pause_id:"101",payload:{action:"review",accepted_actor:"alice"}}}]}]}'
else
  jq -cn '{target:"pr:37",chains:[{effective:{status:"active",pause_id:"101"},records:[]}]}'
fi
STUB
for stage in validate-human-pause-record-graph decompose-human-pause-record-graph \
  derive-human-pause-pre-resume-state reconcile-human-pause-resume-acceptance; do
  printf '#!/usr/bin/env bash\ncat\n' > "$tmp/scripts/$stage.sh"
done
cat > "$tmp/scripts/reconcile-human-pause-active-pause.sh" <<'STUB'
#!/usr/bin/env bash
cat >/dev/null
echo '{"target":"pr:37","result":"no_active_pause"}'
STUB
gh() {
  local args="$*" number
  case "$args" in
    'api /repos/owner/repo/pulls/37')
      jq -cn --arg head "$(cat "$MOCK_DIR/head")" --arg mode "$MOCK_MODE" '
        {number:37,state:(if $mode == "terminal" then "closed" else "open" end),
        draft:false,head:{repo:{full_name:"owner/repo"},
        ref:"ai/issue-36",sha:$head},base:{repo:{full_name:"owner/repo"},ref:"main"}}' ;;
    'api /repos/owner/repo/issues/36'|'api /repos/owner/repo/issues/37')
      number="${2##*/}"
      local key=pr
      [ "$number" = 36 ] && key=issue
      jq -cn --argjson number "$number" --arg label "$(cat "$MOCK_DIR/$key")" '
        {number:$number,state:"open",labels:(if $label == "present" then
        [{name:"human-review-required"}] else [] end)}' ;;
    'api -X POST /repos/owner/repo/issues/37/comments -f body=body')
      printf 'accepted\n' >> "$MOCK_DIR/writes"
      printf 'yes\n' > "$MOCK_DIR/accepted"
      [ "$MOCK_MODE" != post_loss ] || return 1
      echo '{"id":201}' ;;
    'issue edit 36 --repo owner/repo --remove-label human-review-required')
      printf 'issue\n' >> "$MOCK_DIR/writes"
      printf 'absent\n' > "$MOCK_DIR/issue"
      [ "$MOCK_MODE" != issue_loss ] ;;
    'issue edit 37 --repo owner/repo --remove-label human-review-required')
      printf 'pr\n' >> "$MOCK_DIR/writes"
      printf 'absent\n' > "$MOCK_DIR/pr"
      [ "$MOCK_MODE" != pr_loss ] ;;
    'api /repos/owner/repo/issues/comments/201')
      echo '{"id":201,"performed_via_github_app":{"id":99},"created_at":"2026-01-01T00:00:00Z"}' ;;
    'api --paginate --slurp /repos/owner/repo/pulls/37/files?per_page=100')
      if [ "$MOCK_MODE" = workflow_change ]; then
        echo '[[{"filename":".github/workflows/claude-review.yml"}]]'
      else
        echo '[[]]'
      fi ;;
    'api --paginate --slurp /repos/owner/repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100')
      jq -cn --arg head "$MOCK_HEAD" '
        [{workflow_runs:[{id:501,run_attempt:1,name:"Claude Review",event:"pull_request",
          path:".github/workflows/claude-review.yml",head_repository:{full_name:"owner/repo"},
          head_sha:$head,head_branch:"ai/issue-36",created_at:"2026-01-01T00:00:01Z",
          pull_requests:[{number:37,head:{sha:$head}}]}]}]' ;;
    'api --paginate --slurp /repos/owner/repo/actions/runs/501/attempts/1/jobs?per_page=100')
      jq -cn --arg mode "$MOCK_MODE" '
        [[{name:"Review",status:(if $mode == "queued" then "queued" else "in_progress" end),
          conclusion:(if $mode == "early_failure" then "failure" else null end),
          steps:[{name:"Select Claude review model",
            status:(if $mode == "queued" then "queued" else "completed" end),
            conclusion:(if $mode == "decline" then "skipped"
              elif $mode == "queued" then null else "success" end)}]}]] | [.[0] | {jobs:.}]' ;;
    *) echo "unexpected gh call: $args" >&2; return 1 ;;
  esac
}
sleep() { :; }
export -f gh sleep
run_case() {
  local mode="$1"
  export MOCK_MODE="$mode"
  printf 'no\n' > "$tmp/accepted"
  printf 'present\n' > "$tmp/issue"
  printf 'present\n' > "$tmp/pr"
  printf '%s\n' "$MOCK_HEAD" > "$tmp/head"
  : > "$tmp/writes"
  bash "$helper" owner/repo 99 36 <<< '{}' > "$tmp/out" 2> "$tmp/err"
}
for mode in valid post_loss issue_loss pr_loss early_failure; do
  run_case "$mode"
  [ "$(cat "$tmp/writes")" = "$(printf 'accepted\nissue\npr')" ]
  grep -Fq '通常Reviewが処理を担当します' "$tmp/out"
  [ "$(bash "$helper" owner/repo 99 36 <<< '{}')" = ignore:stale_or_consumed ]
done
for mode in queued decline; do
  if run_case "$mode"; then echo "Unentered Review succeeded: $mode" >&2; exit 1; fi
  [ "$(cat "$tmp/writes")" = "$(printf 'accepted\nissue\npr')" ]
done
for mode in head_change terminal; do
  if [ "$mode" = head_change ]; then
    # The current PR fact changes after the prepared snapshot.
    export MOCK_MODE="$mode"
    printf 'no\n' > "$tmp/accepted"
    printf 'present\n' > "$tmp/issue"
    printf 'present\n' > "$tmp/pr"
    printf '%s\n' cccccccccccccccccccccccccccccccccccccccc > "$tmp/head"
    : > "$tmp/writes"
    if bash "$helper" owner/repo 99 36 <<< '{}' > "$tmp/out" 2> "$tmp/err"; then exit 1; fi
  else
    if run_case "$mode"; then exit 1; fi
  fi
  [ ! -s "$tmp/writes" ]
done
if run_case workflow_change; then
  echo 'Changed Review workflow passed the trust check.' >&2
  exit 1
fi
grep -Fq 'Review workflowの証拠を信頼できません' "$tmp/err"
[ ! -s "$tmp/writes" ]
[ "$(cat "$tmp/accepted")" = no ]
[ "$(cat "$tmp/issue")" = present ]
[ "$(cat "$tmp/pr")" = present ]
echo 'consume-ai-resume-review fixture passed.'
