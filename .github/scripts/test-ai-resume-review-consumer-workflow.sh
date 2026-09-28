#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$root/.github/workflows/ai-resume-review-consumer.yml"
recovery="$root/.github/workflows/ai-resume-review-recovery.yml"
developer="$root/.github/workflows/ai-developer.yml"
[ -f "$workflow" ] && [ -f "$recovery" ] && [ -f "$developer" ]

for expected in \
  'name: AI Resume Review Consumer' \
  'run-name: AI Resume Review Consumer pr:${{ github.event.client_payload.dispatch.pr_number }} pause:${{ github.event.client_payload.dispatch.source_pause_id }}' \
  'types: [ai-resume-review]' \
  'issue: ${{ steps.candidate.outputs.issue }}' \
  "if: \${{ needs.gate.outputs.issue != '' }}" \
  'group: codex-writer-ai/issue-${{ needs.gate.outputs.issue }}' \
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
grep -Fq 'types: [completed]' "$recovery"
grep -Fq '["failure","cancelled","timed_out"]' "$recovery"
grep -Fq 'group: codex-writer-ai/issue-${{ needs.resolve.outputs.issue }}' "$recovery"
grep -Fq 'AI\ Resume\ Review\ Consumer\ pr:([1-9][0-9]*)\ pause:([1-9][0-9]*)' "$recovery"

gate="$(sed -n '/^  gate:/,/^  inspect:/p' "$workflow" | sed '$d')"
inspect="$(sed -n '/^  inspect:/,$p' "$workflow")"
[ -n "$gate" ] && [ -n "$inspect" ]
if grep -Fq 'concurrency:' <<< "$gate"; then
  echo 'Untrusted pre-gate entered writer concurrency.' >&2
  exit 1
else
  search_rc=$?
  [ "$search_rc" -eq 1 ] || { echo "Pre-gate search failed (exit $search_rc)." >&2; exit 1; }
fi
for expected in \
  'id: candidate' \
  'result == "accepted_candidate" or .result == "ignore"' \
  'if [ "$(jq -r '\''.result'\'' <<< "$result")" = accepted_candidate ]; then' \
  'issue="$(jq -er '\''.identity.closing_issue_number | select(type == "number" and . > 0 and floor == .)'\'' <<< "$result")"' \
  "printf 'issue=%s\\n' \"\$issue\" >> \"\$GITHUB_OUTPUT\""; do
  grep -Fq "$expected" <<< "$gate"
done
for expected in \
  'needs: gate' \
  "if: \${{ needs.gate.outputs.issue != '' }}" \
  'group: codex-writer-ai/issue-${{ needs.gate.outputs.issue }}' \
  'TRUSTED_ISSUE: ${{ needs.gate.outputs.issue }}' \
  'bash .github/scripts/prepare-ai-resume-review-consumer.sh' \
  '.identity.closing_issue_number == $issue'; do
  grep -Fq "$expected" <<< "$inspect"
done
[ "$(grep -Fc 'bash .github/scripts/prepare-ai-resume-review-consumer.sh' "$workflow")" -eq 2 ]
[ "$(grep -Fc 'ref: ${{ github.event.repository.default_branch }}' "$workflow")" -eq 2 ]
[ "$(grep -Fc 'permission-issues: read' "$workflow")" -eq 2 ]
[ "$(grep -Fc 'permission-pull-requests: read' "$workflow")" -eq 2 ]

check_no_forbidden() {
  local search_rc file="${1:-$workflow}" content
  content="$(sed ':a; /\\$/ { N; s/\\\n[[:space:]]*/ /; ba; }' "$file")" || return 1
  if grep -Ein 'group: codex-writer-ai/issue-.*github\.event\.client_payload|permission-[a-z-]+: write|gh[[:space:]]+api([[:space:]]+[^[:space:]]+)*[[:space:]]+(-X|--method)[=[:space:]]*(POST|PATCH|PUT|DELETE)|gh[[:space:]]+api.*[[:space:]](-[fF]|--field|--raw-field|--input)([=[:space:][:alnum:]_-]|$)|gh[[:space:]]+issue[[:space:]]+(edit|comment)|gh[[:space:]]+pr[[:space:]]+(edit|comment|ready|review)|gh[[:space:]]+workflow[[:space:]]+run|dispatches|claude-review\.yml|claude-code-action|claude[[:space:]]+(-p|--print)|POST /repos/' <<< "$content"; then
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
if (grep() { return 127; }; check_no_forbidden >/dev/null 2>&1); then
  echo 'Missing workflow search tool was accepted.' >&2
  exit 1
fi

# Both jobs must use exactly the same envelope validation step.
check_envelope_symmetry() {
  local file="${1:-$workflow}" first second count
  first="$(awk -v wanted=1 '/^      - name: Validate dispatch envelope$/ {count++; if (count == wanted) active=1} active && /^      - name: Create read-only developer App token$/ {exit} active {print}' "$file")" || return 1
  count="$(grep -Fc '      - name: Validate dispatch envelope' "$file")" || return 1
  [ "$count" -eq 2 ] || return 1
  second="$(awk -v wanted=2 '/^      - name: Validate dispatch envelope$/ {count++; if (count == wanted) active=1} active && /^      - name: Create read-only developer App token$/ {exit} active {print}' "$file")" || return 1
  [ -n "$first" ] && [ "$first" = "$second" ]
}
check_envelope_symmetry
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sed '0,/\.version == 1/s//.version == 2/' "$workflow" > "$tmp"
if check_envelope_symmetry "$tmp"; then
  echo 'Envelope validation drift was accepted.' >&2
  exit 1
fi
for forbidden in \
  'gh api -X POST /repos/example/repo/issues' \
  'gh api --method PATCH /repos/example/repo/issues/1' \
  'gh api --method=PUT /repos/example/repo/issues/1' \
  'gh api -X DELETE /repos/example/repo/issues/1' \
  'gh api /repos/example/repo/issues -f title=x' \
  'gh api /repos/example/repo/issues -ftitle=x' \
  'gh api /repos/example/repo/issues -F title=x' \
  'gh api /repos/example/repo/issues --field title=x' \
  'gh api /repos/example/repo/issues --raw-field title=x' \
  'gh api /repos/example/repo/issues --input payload.json' \
  'gh issue comment 1 --body x' \
  'gh pr ready 1' \
  'gh workflow run claude-review.yml' \
  'claude -p review' \
  'gh api /repos/example/repo/dispatches' \
  'claude-code-action'; do
  printf '%s\n' "$forbidden" >> "$tmp"
  if check_no_forbidden "$tmp" >/dev/null 2>&1; then
    echo "Forbidden consumer operation was accepted: $forbidden" >&2
    exit 1
  fi
  sed -i '$d' "$tmp"
done
printf 'gh api /repos/example/repo/issues \\\n  --input payload.json\n' >> "$tmp"
if check_no_forbidden "$tmp" >/dev/null 2>&1; then
  echo 'Multiline implicit API write was accepted.' >&2
  exit 1
fi

operations="$root/docs/30_operations/ai-development-workflow.md"
for expected in \
  'consumerのfailure / cancelled / timed_outをsource' \
  'Recoveryは既存のIssue/PR pause invariantを修復するwrite' \
  'closing Issue / PR双方で欠けた `human-review-required` labelを再同期' \
  '新しいpendingが古いpendingをcancelし得る' \
  'run ID、run attempt、display title、conclusion' \
  'developer runではeventとsource identity' \
  'consumer `inspect`' \
  'Recovery `recover`' \
  '`pre_acceptance` の欠落Issue/PR label' \
  'AI Developer `develop-from-issue`' \
  '`issue_comment` の通常 `/codex develop`' \
  '`repository_dispatch: ai-resume-develop`' \
  'resume-gate前にpending cancelされ、source pauseが未consumed' \
  'PR側 `/ai resume develop` の再発行' \
  '通常 `/codex develop` へ切り替えない' \
  'resume acceptanceまたはrepository writeが始まった証拠があればgeneric retryせず' \
  'partial writeや所有者不明なら停止' \
  'current factsを再取得する'; do
  grep -Fq "$expected" "$operations"
done
for expected in \
  'types: [ai-resume-develop]' \
  "(github.event_name == 'issue_comment' && needs.gate-issue-entry.outputs.continue == 'true')" \
  "(github.event_name == 'repository_dispatch' && github.event.action == 'ai-resume-develop')" \
  'if: github.event_name == '\''repository_dispatch'\''' \
  'bash .github/scripts/consume-ai-resume-develop.sh'; do
  grep -Fq "$expected" "$developer"
done
followup="$(sed -n '/^  respond-to-claude:/,/^  handle-claude-followup-failure:/p' "$developer" | sed '$d')"
[ -n "$followup" ]
for expected in \
  "github.event_name == 'pull_request_review'" \
  "github.event.review.state == 'changes_requested'" \
  "startsWith(github.event.pull_request.head.ref, 'ai/issue-')" \
  'group: codex-writer-${{ github.event.pull_request.head.ref }}'; do
  grep -Fq "$expected" <<< "$followup"
done
grep -Fq "needs.respond-to-claude.result == 'failure'" "$developer"
for expected in \
  '`respond-to-claude` のgroup式は `codex-writer-${{ github.event.pull_request.head.ref }}`' \
  'AI Developer `respond-to-claude`（`pull_request_review` のchanges_requested）' \
  'eventとreview ID、review対象HEAD、current PR HEAD / Draft状態' \
  '`Run Codex follow-up` の開始・push有無' \
  '`cancelled` は `handle-claude-followup-failure` のfailure条件に該当せず' \
  '専用follow-up retry入口はないため' \
  'partial pushやwriter ownershipが曖昧ならfail-closed'; do
  grep -Fq "$expected" "$operations"
done

filter="$(sed -n "/          jq -ce '/,/          ' \"\$GITHUB_EVENT_PATH\" >\/dev\/null/p" "$workflow" |
  awk '/GITHUB_EVENT_PATH/ {exit} {print}' | sed '1d')"
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
