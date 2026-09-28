#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$root/.github/workflows/ai-resume-review-consumer.yml"
recovery="$root/.github/workflows/ai-resume-review-recovery.yml"
[ -f "$workflow" ] && [ -f "$recovery" ]

for expected in \
  'name: AI Resume Review Consumer' \
  'run-name: AI Resume Review Consumer pr:${{ github.event.client_payload.dispatch.pr_number }} pause:${{ github.event.client_payload.dispatch.source_pause_id }}' \
  'types: [ai-resume-review]' \
  'group: codex-writer-ai/issue-${{ github.event.client_payload.dispatch.closing_issue_number }}' \
  'cancel-in-progress: false' \
  'ref: ${{ github.event.repository.default_branch }}' \
  'persist-credentials: false' \
  'permission-contents: read' \
  'permission-issues: read' \
  'permission-pull-requests: read' \
  'bash .github/scripts/prepare-ai-resume-review-consumer.sh'; do
  grep -Fq "$expected" "$workflow"
done
grep -Fq 'workflows: [AI Resume Review Consumer]' "$recovery"
grep -Fq 'group: codex-writer-ai/issue-${{ needs.resolve.outputs.issue }}' "$recovery"
grep -Fq 'AI\ Resume\ Review\ Consumer\ pr:([1-9][0-9]*)\ pause:([1-9][0-9]*)' "$recovery"

check_no_forbidden() {
  local search_rc
  if rg -n 'permission-[a-z-]+: write|gh api -X|gh issue (edit|comment)|gh pr (edit|ready)|dispatches|claude-review\.yml|claude-code-action|POST /repos/' "$workflow"; then
    search_rc=0
  else
    search_rc=$?
  fi
  case "$search_rc" in
    0) echo 'Consumer workflow contains a write or paid review path.' >&2; return 1 ;;
    1) return 0 ;;
    *) echo "Consumer workflow search failed (exit $search_rc)." >&2; return 1 ;;
  esac
}
check_no_forbidden
if (rg() { return 127; }; check_no_forbidden >/dev/null 2>&1); then
  echo 'Missing workflow search tool was accepted.' >&2
  exit 1
fi

filter="$(sed -n "/          jq -ce '/,/          ' \"\$GITHUB_EVENT_PATH\" >\/dev\/null/p" "$workflow" |
  sed '1d;$d')"
[ -n "$filter" ]
valid='{"action":"ai-resume-review","client_payload":{"version":1,"dispatch":{"pr_number":37}}}'
jq -e "$filter" <<< "$valid" >/dev/null
for malformed in \
  '{"action":"ai-resume-review","client_payload":{"version":2,"dispatch":{}}}' \
  '{"action":"ai-resume-review","client_payload":{"version":1,"dispatch":{},"extra":true}}' \
  '{"action":"ai-resume-review","client_payload":{"version":1,"dispatch":null}}' \
  '{"action":"other","client_payload":{"version":1,"dispatch":{}}}'; do
  if jq -e "$filter" <<< "$malformed" >/dev/null 2>&1; then
    echo 'Malformed dispatch envelope was accepted.' >&2
    exit 1
  fi
done
echo 'AI Resume Review Consumer workflow fixture passed.'
