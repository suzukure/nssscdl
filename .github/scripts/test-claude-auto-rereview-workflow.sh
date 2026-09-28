#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
auto="$repo_root/.github/workflows/claude-auto-rereview.yml"
normal="$repo_root/.github/workflows/claude-review.yml"
handler="$repo_root/.github/workflows/claude-review-failure-handler.yml"
developer="$repo_root/.github/workflows/ai-developer.yml"

grep -Fqx '    types: [claude-auto-rereview]' "$auto"
grep -Fqx '      group: claude-review-${{ github.event.client_payload.pr_number }}' "$auto"
grep -Fqx '      group: claude-review-${{ github.event.pull_request.number }}' "$normal"
grep -Fqx '      cancel-in-progress: false' "$auto"
grep -Fqx '      cancel-in-progress: false' "$normal"
grep -Fq 'and ((.machine_state or .event_machine_state) | not)' "$normal"
grep -Fq 'workflows: [Claude Review, Claude Auto Rereview]' "$handler"
grep -Fq 'handle-claude-auto-rereview-failure.sh' "$handler"
if grep -Fq 'prepare-claude-followup-producer.sh' "$developer"; then
  echo 'Producer was activated before its separate gate.' >&2; exit 1
fi
[ "$(grep -Fc 'uses: anthropics/claude-code-action@9ca9355b36297178e28d37c799d1c9c8a28e6507' "$auto")" -eq 1 ]
for step in 'Upload accepted identity' 'Recheck accepted identity before machine state consumption' \
  'Check out accepted PR HEAD' \
  'Consume machine state' 'Upload paid review boundary' 'Run Claude review' \
  'Recheck verdict identity' 'Signal verdict suppressed' 'Submit reviewer verdict' 'Pause for human decision' \
  'Verify merge gates' 'Squash merge as reviewer'; do
  grep -Fq "      - name: $step" "$auto"
done
line() { grep -Fn "      - name: $1" "$auto" | head -1 | cut -d: -f1; }
[ "$(line 'Upload accepted identity')" -lt "$(line 'Consume machine state')" ]
[ "$(line 'Upload paid review boundary')" -lt "$(line 'Consume machine state')" ]
[ "$(line 'Consume machine state')" -lt "$(line 'Run Claude review')" ]
[ "$(line 'Upload paid review boundary')" -lt "$(line 'Run Claude review')" ]
[ "$(line 'Recheck verdict identity')" -lt "$(line 'Submit reviewer verdict')" ]
grep -Fq 'prepare-claude-auto-rereview-consumer.sh pre_verdict' "$auto" || \
  grep -Fq 'prepare-claude-auto-rereview-consumer.sh" pre_verdict' "$auto"
grep -Fq '| bash "$RUNNER_TEMP/prepare-claude-auto-rereview-consumer.sh" machine_state_result)' "$auto"
if awk '
  /^      - name: Check out accepted PR HEAD$/ { after_pr_checkout = 1; next }
  /^  merge:$/ { after_pr_checkout = 0 }
  after_pr_checkout && /bash[[:space:]]+\.github\/scripts\// { found = 1 }
  END { exit !found }
' "$auto"; then
  echo 'Auto review runs a PR HEAD helper after checkout.' >&2; exit 1
fi
grep -Fq 'bash .github/scripts/verify-pr-gates.sh "$GITHUB_REPOSITORY" "$PR_NUMBER" merge "$DEV_APP_SLUG"' "$auto"
grep -Fq -- '--match-head-commit "$HEAD_SHA"' "$auto"
bash -n "$repo_root/.github/scripts/handle-claude-auto-rereview-failure.sh" \
  "$repo_root/.github/scripts/prepare-claude-auto-rereview-consumer.sh"
echo 'Claude auto-rereview workflow wiring fixtures passed.'
