#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts" "$tmp/state"
cp "$root/.github/scripts/consume-ai-resume-review.sh" "$tmp/scripts/"
cat > "$tmp/scripts/prepare-ai-resume-review-consumer.sh" <<'STUB'
#!/usr/bin/env bash
jq -cn '{result:"accepted_candidate",identity:{closing_issue_number:36,pr_number:37,source_pause_id:"101",
 head:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
 accepted_record:{version:1,kind:"ai-resume-accepted",reason:"claude_execution_failed",
 target:"pr:37",source_pause_id:"101",payload:{action:"review",accepted_actor:"alice"}}}'
STUB
cat > "$tmp/scripts/human-pause-record.sh" <<'STUB'
#!/usr/bin/env bash
printf 'accepted-body\n'
STUB
cat > "$tmp/scripts/list-human-pause-records.sh" <<'STUB'
#!/usr/bin/env bash
[ -f "$GH_STATE/accepted" ] || exit 1
jq -cn '{target:"pr:37",chains:[{effective:{status:"consumed",pause_id:"101",accepted_record_id:"201"},
  records:[{pause_id:"201",record:{version:1,kind:"ai-resume-accepted",
   reason:"claude_execution_failed",target:"pr:37",source_pause_id:"101",
   payload:{action:"review",accepted_actor:"alice"}}}]}]}'
STUB
for name in validate-human-pause-record-graph decompose-human-pause-record-graph \
  derive-human-pause-pre-resume-state reconcile-human-pause-resume-acceptance; do
  printf '#!/usr/bin/env bash\ncat\n' > "$tmp/scripts/$name.sh"
done
cat > "$tmp/scripts/reconcile-human-pause-active-pause.sh" <<'STUB'
#!/usr/bin/env bash
printf '{"result":"no_active_pause"}\n'
STUB
export GH_STATE="$tmp/state" GH_LOG="$tmp/gh.log" GH_TOKEN=dummy
export GITHUB_WORKFLOW='AI Resume Review Consumer' GITHUB_RUN_ID=500
: > "$GH_LOG"
printf 'present' > "$GH_STATE/issue"
printf 'present' > "$GH_STATE/pr"
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$*" in
    'api /apps/dev --jq .id') echo 99 ;;
    'api -X POST /repos/owner/repo/issues/37/comments -f body=accepted-body')
      touch "$GH_STATE/accepted"
      [ "${LOSS_POST:-false}" = true ] && return 1
      echo '{"id":201}' ;;
    'api /repos/owner/repo/issues/36')
      if [ "$(cat "$GH_STATE/issue")" = present ]; then
        echo '{"number":36,"state":"open","labels":[{"name":"human-review-required"}]}'
      else echo '{"number":36,"state":"open","labels":[]}' ; fi ;;
    'api /repos/owner/repo/issues/37')
      if [ "$(cat "$GH_STATE/pr")" = present ]; then
        echo '{"number":37,"state":"open","labels":[{"name":"human-review-required"}]}'
      else echo '{"number":37,"state":"open","labels":[]}' ; fi ;;
    'api /repos/owner/repo/issues/comments/201')
      echo '{"id":201,"performed_via_github_app":{"id":99},"created_at":"2026-01-01T00:00:00Z"}' ;;
    'api --paginate --slurp /repos/owner/repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100')
      if [ "${GH_REVIEW:-entered}" = unrelated ]; then echo '[{"workflow_runs":[]}]'; return; fi
      echo '[{"workflow_runs":[{"id":600,"run_attempt":1,"name":"Claude Review","event":"pull_request",
        "path":".github/workflows/claude-review.yml@refs/heads/main",
        "head_repository":{"full_name":"owner/repo"},
        "head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "created_at":"2026-01-01T00:01:00Z","pull_requests":[{"number":37,
        "head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]}]}]' ;;
    'api --paginate --slurp /repos/owner/repo/actions/runs/600/attempts/1/jobs?per_page=100')
      if [ "${GH_REVIEW:-entered}" = skipped ]; then
        echo '[{"jobs":[{"name":"Review","status":"completed","conclusion":"success",
          "steps":[{"name":"Select Claude review model","status":"completed","conclusion":"skipped"}]}]}]'
        return
      fi
      echo '[{"jobs":[{"name":"Review","status":"in_progress","conclusion":null,
        "steps":[{"name":"Select Claude review model","status":"in_progress","conclusion":null}]}]}]' ;;
    'issue edit 36 --repo owner/repo --remove-label human-review-required')
      printf 'absent' > "$GH_STATE/issue"
      [ "${LOSS_ISSUE:-false}" = true ] && return 1 ;;
    'issue edit 37 --repo owner/repo --remove-label human-review-required')
      printf 'absent' > "$GH_STATE/pr"
      [ "${LOSS_PR:-false}" = true ] && return 1 ;;
    *) echo "unexpected gh: $*" >&2; return 1 ;;
  esac
}
export -f gh
run() {
  printf '{"version":1,"dispatch":{"action":"review"}}\n' |
    bash "$tmp/scripts/consume-ai-resume-review.sh" owner/repo dev
}
for loss in none post issue pr; do
  rm -f "$GH_STATE/accepted"
  printf 'present' > "$GH_STATE/issue"
  printf 'present' > "$GH_STATE/pr"
  : > "$GH_LOG"
  export LOSS_POST=false LOSS_ISSUE=false LOSS_PR=false
  case "$loss" in
    post) LOSS_POST=true ;;
    issue) LOSS_ISSUE=true ;;
    pr) LOSS_PR=true ;;
  esac
  run
  [ "$(cat "$GH_STATE/issue")" = absent ]
  [ "$(cat "$GH_STATE/pr")" = absent ]
  [ "$(grep -c 'api -X POST' "$GH_LOG")" = 1 ]
  python3 - "$GH_LOG" <<'PY'
import sys
lines=open(sys.argv[1]).read().splitlines()
post=next(i for i,x in enumerate(lines) if 'api -X POST' in x)
issue=next(i for i,x in enumerate(lines) if 'issue edit 36' in x)
pr=next(i for i,x in enumerate(lines) if 'issue edit 37' in x)
assert post < issue < pr
assert any('api /repos/owner/repo/issues/36' in x for x in lines[issue+1:pr])
PY
done
sleep() { :; }
export -f sleep
for review in skipped unrelated; do
  export GH_REVIEW="$review"
  printf 'present' > "$GH_STATE/issue"
  printf 'present' > "$GH_STATE/pr"
  if run >/dev/null 2>&1; then echo "Unexpected handoff: $review" >&2; exit 1; fi
done
: > "$GH_LOG"
if printf '{}\n' | bash "$tmp/scripts/consume-ai-resume-review.sh" owner/repo dev >/dev/null 2>&1; then exit 1; fi
[ ! -s "$GH_LOG" ]
: > "$GH_LOG"
if printf '{"version":1,"dispatch":{},"extra":1}\n' |
  bash "$tmp/scripts/consume-ai-resume-review.sh" owner/repo dev >/dev/null 2>&1; then exit 1; fi
[ ! -s "$GH_LOG" ]
grep -Fq 'group: codex-writer-ai/issue-' "$root/.github/workflows/ai-resume-review-consumer.yml"
grep -Fq 'group: codex-writer-ai/issue-' "$root/.github/workflows/ai-resume-review-recovery.yml"
echo 'consume-ai-resume-review fixture passed.'
