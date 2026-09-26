#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
developer="$root/.github/workflows/ai-developer.yml"
review="$root/.github/workflows/claude-review.yml"
snapshot="$root/.github/scripts/snapshot-current-head-validation.py"

line() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }
label_line="$(line "$developer" '      - name: Mark automated follow-up in progress')"
codex_line="$(line "$developer" '      - name: Run Codex follow-up')"
write_line="$(line "$developer" '      - name: Commit and answer review')"
ready_line="$(line "$developer" '      - name: Ready PR for current-head traceability')"
validate_line="$(line "$developer" '      - name: Validate current HEAD and dispatch re-review')"
test "$label_line" -lt "$codex_line"
test "$codex_line" -lt "$write_line"
test "$write_line" -lt "$ready_line"
test "$ready_line" -lt "$validate_line"
grep -Fq 'result=no_diff' "$developer"
grep -Fq 'result=pushed' "$developer"
grep -Fq 'deadline=$((STARTED_AT + 600))' "$developer"
grep -Fq 'evaluate-current-head-validation.sh' "$developer"
grep -Fq 'event_type:"claude-auto-rereview",client_payload:$payload' "$developer"
grep -Fq '{pr_number:$pr_number,validated_sha:$validated_sha,round:$round}' "$developer"
grep -Fq 'ai-followup-in-progress' "$developer"

grep -Fq 'types: [claude-auto-rereview]' "$review"
grep -Fq "!contains(github.event.pull_request.labels.*.name, 'ai-followup-in-progress')" "$review"
grep -Fq 'group: claude-review-${{ github.event.client_payload.pr_number || github.event.pull_request.number }}' "$review"
grep -Fq 'cancel-in-progress: false' "$review"
grep -Fq 'evaluate-claude-auto-rereview-entry-gate.sh' "$review"
grep -Fq 'evaluate-claude-review-entry-gate.sh' "$review"
grep -Fq 'echo '\''accepted=true'\'' >> "$GITHUB_OUTPUT"' "$review"
grep -Fq 'Reviewed HEAD changed before verdict submission.' "$review"

grep -Fq '"name": "PR Traceability / Linked Issue"' "$snapshot"
grep -Fq 'run.get("workflow_id") == workflow["id"]' "$snapshot"
grep -Fq 'job.get("name") == "Linked Issue"' "$snapshot"
grep -Fq 'run.get("id") == current_run_id' "$snapshot"

# The three trusted gates express one fixed two-follow-up limit. Any drift
# in one representation must fail this cross-fixture.
grep -Fq 'review_count" -ge 3' "$root/.github/scripts/evaluate-followup-gate.sh"
grep -Fq 'automated_followup_count > 2' "$root/.github/scripts/evaluate-current-head-validation.sh"
grep -Fq 'actual_round" -le 2' "$root/.github/scripts/evaluate-claude-auto-rereview-entry-gate.sh"
echo 'Automatic re-review wiring tests passed.'
