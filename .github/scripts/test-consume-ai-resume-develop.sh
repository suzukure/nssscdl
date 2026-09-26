#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/consume-ai-resume-develop.sh"
workflow="$repo_root/.github/workflows/ai-developer.yml"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

gh() { echo 'Malformed dispatch reached GitHub.' >&2; return 1; }
export -f gh
for malformed in '{}' 'null' '[]' '{"action":"fix"}' 'not-json'; do
  if bash "$helper" owner/repo dev "$test_dir/output" <<< "$malformed" > /dev/null 2>&1; then
    echo 'Malformed resume dispatch was accepted.' >&2
    exit 1
  fi
done
[ ! -e "$test_dir/output" ]

grep -Fq 'types: [ai-resume-develop]' "$workflow"
grep -Fq 'bash .github/scripts/parse-ai-resume-command.sh' "$workflow"
grep -Fq 'bash .github/scripts/build-ai-resume-prepare-context.sh' "$workflow"
grep -Fq 'bash .github/scripts/prepare-ai-resume.sh' "$workflow"
grep -Fq 'group: codex-issue-${{ github.event_name == '\''repository_dispatch'\'' && github.event.client_payload.closing_issue_number || github.event.issue.number }}' "$workflow"
grep -Fq 'bash .github/scripts/consume-ai-resume-develop.sh' "$workflow"
grep -Fq 'needs.develop-from-issue.outputs.resume_accepted' "$workflow"
python3 - "$helper" <<'PY'
from pathlib import Path
import sys
body = Path(sys.argv[1]).read_text()
required = [
    'build-ai-resume-prepare-context.sh', 'prepare-ai-resume.sh',
    'human-pause-record.sh" create', 'list-human-pause-records.sh',
    'validate-human-pause-record-graph.sh', 'decompose-human-pause-record-graph.sh',
    'derive-human-pause-pre-resume-state.sh',
    'reconcile-human-pause-resume-acceptance.sh',
    'reconcile-human-pause-active-pause.sh',
    'gh pr ready "$pr"', 'gh issue edit "$issue"', 'gh issue edit "$pr"',
]
for token in required:
    assert token in body, token
assert body.index('prepare-ai-resume.sh') < body.index('human-pause-record.sh" create')
assert body.index('gh pr ready "$pr"') < body.index('human-pause-record.sh" create')
assert body.index('reconcile-human-pause-active-pause.sh') < body.index('gh issue edit "$issue"')
assert body.index('gh issue edit "$issue"') < body.index('gh issue edit "$pr"')
PY

echo 'consume-ai-resume-develop fixture passed.'

# Run a complete local transition with mocked GitHub facts and lifecycle
# stages. The second dispatch must stop before posting another acceptance.
mkdir "$test_dir/scripts"
cp "$helper" "$test_dir/scripts/consume-ai-resume-develop.sh"
for stage in build-ai-resume-prepare-context prepare-ai-resume human-pause-record \
  list-human-pause-records validate-human-pause-record-graph \
  decompose-human-pause-record-graph derive-human-pause-pre-resume-state \
  reconcile-human-pause-resume-acceptance reconcile-human-pause-active-pause \
  apply-human-pause; do
  cat > "$test_dir/scripts/$stage.sh" <<'STUB'
#!/usr/bin/env bash
case "${0##*/}" in
  build-ai-resume-prepare-context.sh) printf '{}\n' ;;
  prepare-ai-resume.sh) jq -cn --argjson dispatch "$MOCK_DISPATCH" '{result:"prepared",dispatch:$dispatch}' ;;
  human-pause-record.sh) printf 'validated record\n' ;;
  list-human-pause-records.sh) printf '{}\n' ;;
  validate-human-pause-record-graph.sh|decompose-human-pause-record-graph.sh|derive-human-pause-pre-resume-state.sh) cat ;;
  reconcile-human-pause-resume-acceptance.sh)
    jq -cn --arg target pr:37 --argjson record "$(jq -cn --arg target pr:37 --arg source 101 --arg reason requirements_change --arg actor alice '{version:1,kind:"ai-resume-accepted",reason:$reason,target:$target,source_pause_id:$source,payload:{action:"develop",accepted_actor:$actor}}')" \
      '{target:$target,chains:[{effective:{status:"consumed",pause_id:"101",accepted_record_id:"200"},records:[{pause_id:"200",record:$record}]}]}' ;;
  reconcile-human-pause-active-pause.sh) printf '{"target":"pr:37","result":"no_active_pause"}\n' ;;
  apply-human-pause.sh) printf 'restore labels\n' >> "$MOCK_LOG" ;;
esac
STUB
  chmod +x "$test_dir/scripts/$stage.sh"
done
MOCK_DISPATCH='{"version":1,"target":"pr:37","action":"develop","actor":"alice","source_pause_id":"101","reason":"requirements_change","closing_issue_number":36,"pr_number":37,"paused_head":null,"prepared_head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pause_issue_body_fingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","prepared_issue_body_fingerprint":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","follow_up_issue":null}'
MOCK_LOG="$test_dir/gh.log"
MOCK_REMOVED="$test_dir/removed"
MOCK_DRAFT="$test_dir/draft"
printf 'false\n' > "$MOCK_DRAFT"
export MOCK_DISPATCH MOCK_LOG MOCK_REMOVED MOCK_DRAFT
gh() {
  printf '%s\n' "$*" >> "$MOCK_LOG"
  case "$*" in
    'api /apps/dev --jq .id') printf '99\n' ;;
    *'/issues/37/comments?per_page=100&page=1'*) printf '[{"id":150,"body":"/ai resume develop","user":{"login":"alice"},"author_association":"OWNER"}]\n' ;;
    *'/issues/37/comments'*) printf '{"id":200}\n' ;;
    'pr view 37 --repo owner/repo --json number,state,isDraft')
      jq -cn --argjson draft "$(cat "$MOCK_DRAFT")" '{number:37,state:"OPEN",isDraft:$draft}' ;;
    'pr ready 37 --repo owner/repo --undo')
      [ "${MOCK_FAIL_DRAFT:-false}" != true ] || return 1
      printf 'true\n' > "$MOCK_DRAFT" ;;
    'issue view 36'*|'issue view 37'*)
      number="$3"
      if grep -Fxq "$number" "$MOCK_REMOVED" 2>/dev/null; then
        printf '{"labels":[]}\n'
      else
        printf '{"labels":[{"name":"human-review-required"}]}\n'
      fi ;;
    'issue edit 36'*|'issue edit 37'*)
      if [ "${MOCK_FAIL_PR:-false}" = true ] && [ "$3" = 37 ]; then return 1; fi
      printf '%s\n' "$3" >> "$MOCK_REMOVED" ;;
    *) echo "Unexpected mocked GitHub call: $*" >&2; return 1 ;;
  esac
}
export -f gh
bash "$test_dir/scripts/consume-ai-resume-develop.sh" owner/repo dev "$test_dir/output" \
  <<< "$MOCK_DISPATCH"
grep -Fxq 'issue_number=36' "$test_dir/output"
grep -Fxq 'accepted=true' "$test_dir/output"
[ "$(cat "$MOCK_REMOVED")" = $'36\n37' ]
[ "$(grep -c 'api -X POST /repos/owner/repo/issues/37/comments ' "$MOCK_LOG")" -eq 1 ]
python3 - "$MOCK_LOG" <<'PY'
from pathlib import Path
import sys
lines = Path(sys.argv[1]).read_text().splitlines()
draft = lines.index('pr ready 37 --repo owner/repo --undo')
ack = next(i for i, line in enumerate(lines) if line.startswith('api -X POST /repos/owner/repo/issues/37/comments '))
issue = next(i for i, line in enumerate(lines) if line.startswith('issue edit 36 '))
pr = next(i for i, line in enumerate(lines) if line.startswith('issue edit 37 '))
assert draft < lines.index('pr view 37 --repo owner/repo --json number,state,isDraft', draft + 1) < ack < issue < pr
PY
if bash "$test_dir/scripts/consume-ai-resume-develop.sh" owner/repo dev "$test_dir/duplicate" \
  <<< "$MOCK_DISPATCH" >/dev/null 2>&1; then
  echo 'Duplicate dispatch passed the paused label gate.' >&2
  exit 1
fi
[ "$(grep -c 'api -X POST /repos/owner/repo/issues/37/comments ' "$MOCK_LOG")" -eq 1 ]
printf '' > "$MOCK_REMOVED"
printf '' > "$MOCK_LOG"
printf 'false\n' > "$MOCK_DRAFT"
export MOCK_FAIL_DRAFT=true
if bash "$test_dir/scripts/consume-ai-resume-develop.sh" owner/repo dev "$test_dir/draft-failed" \
  <<< "$MOCK_DISPATCH" >/dev/null 2>&1; then
  echo 'Draft transition failure incorrectly consumed the pause.' >&2
  exit 1
fi
[ ! -e "$test_dir/draft-failed" ]
! grep -Eq 'api -X POST|issue edit' "$MOCK_LOG"
unset MOCK_FAIL_DRAFT
printf '' > "$MOCK_REMOVED"
printf '' > "$MOCK_LOG"
printf 'true\n' > "$MOCK_DRAFT"
bash "$test_dir/scripts/consume-ai-resume-develop.sh" owner/repo dev "$test_dir/already-draft" \
  <<< "$MOCK_DISPATCH"
grep -Fxq 'accepted=true' "$test_dir/already-draft"
! grep -Fq 'pr ready ' "$MOCK_LOG"
printf '' > "$MOCK_REMOVED"
printf '' > "$MOCK_LOG"
printf 'false\n' > "$MOCK_DRAFT"
export MOCK_FAIL_PR=true
if bash "$test_dir/scripts/consume-ai-resume-develop.sh" owner/repo dev "$test_dir/failed" \
  <<< "$MOCK_DISPATCH" >/dev/null 2>&1; then
  echo 'PR label removal failure incorrectly started development.' >&2
  exit 1
fi
[ ! -e "$test_dir/failed" ]
[ "$(grep -c 'api -X POST /repos/owner/repo/issues/37/comments ' "$MOCK_LOG")" -eq 2 ]
grep -Fxq 'restore labels' "$MOCK_LOG"
echo 'consume-ai-resume-develop transition fixture passed.'
