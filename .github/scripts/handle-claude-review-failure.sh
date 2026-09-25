#!/usr/bin/env bash
set -euo pipefail

# Handles one completed Claude Review run. All API reads use the workflow token;
# only the existing pause producer receives the reviewer App installation token.
repo="${1:?repository required}"
run_id="${2:?run ID required}"
event_attempt="${3:?run attempt required}"
app_slug="${4:?reviewer App slug required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "handle-claude-review-failure: $1" >&2; exit 1; }
positive() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
positive "$run_id" && positive "$event_attempt" || fail 'invalid source identity'
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
[[ "$app_slug" =~ ^[a-zA-Z0-9-]+$ ]] || fail 'invalid App slug'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh api "/repos/$repo/actions/runs/$run_id" > "$tmp/run.json" || fail 'source run unavailable'
jq -e --arg repo "$repo" --argjson id "$run_id" --argjson attempt "$event_attempt" '
  .id == $id and .name == "Claude Review" and .event == "pull_request"
  and (.path | type == "string" and test("^\\.github/workflows/claude-review\\.yml(@|$)"))
  and .head_repository.full_name == $repo and .status == "completed"
  and (.head_branch | type == "string" and length > 0)
  and .run_attempt == $attempt and (.workflow_id | type == "number")
  and (.pull_requests | type == "array" and length == 1)
  and (.pull_requests[0].number | type == "number" and . > 0)
  and (.pull_requests[0].head.sha | type == "string" and test("^[0-9a-f]{40}$"))
' "$tmp/run.json" > /dev/null || fail 'source run identity is inconsistent or stale'
pr_number="$(jq -r '.pull_requests[0].number' "$tmp/run.json")"
source_head="$(jq -r '.pull_requests[0].head.sha' "$tmp/run.json")"
source_branch="$(jq -r '.head_branch' "$tmp/run.json")"
workflow_id="$(jq -r '.workflow_id' "$tmp/run.json")"
run_head="$(jq -r '.head_sha' "$tmp/run.json")"
[[ "$run_head" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid source run commit'

gh api "/repos/$repo/actions/runs/$run_id/attempts/$event_attempt" > "$tmp/attempt.json" \
  || fail 'source attempt unavailable'
jq -e --argjson id "$run_id" --argjson attempt "$event_attempt" '
  .id == $id and .run_attempt == $attempt and .status == "completed"
' "$tmp/attempt.json" > /dev/null || fail 'source attempt is inconsistent'

gh api --paginate --slurp "/repos/$repo/actions/runs/$run_id/attempts/$event_attempt/jobs?per_page=100" \
  > "$tmp/jobs.json" || fail 'source jobs unavailable'
jq -e 'type == "array" and all(.[]; .jobs | type == "array")' "$tmp/jobs.json" > /dev/null \
  || fail 'source jobs malformed'
jq -c '[.[] .jobs[] | select(.name == "Review")]' "$tmp/jobs.json" > "$tmp/review.json"
[ "$(jq 'length' "$tmp/review.json")" -eq 1 ] || fail 'missing or duplicate Review job'
conclusion="$(jq -r '.[0].conclusion // empty' "$tmp/review.json")"
case "$conclusion" in
  success|skipped) echo '{"result":"ignored"}'; exit 0 ;;
  failure|cancelled|timed_out|stale) ;;
  *) fail 'unknown Review conclusion' ;;
esac

gh api "/repos/$repo/pulls/$pr_number" > "$tmp/pr.json" || fail 'PR unavailable'
jq -e --arg repo "$repo" --arg head "$source_head" --argjson number "$pr_number" '
  .number == $number and .state == "open" and .draft == false
  and .head.repo.full_name == $repo and .head.sha == $head
' "$tmp/pr.json" > /dev/null || { echo '{"result":"stale_pr"}'; exit 0; }

# An edited review workflow can spoof marker steps. Verify its absence in the
# source PR and the two fixed marker definitions in the source run commit.
gh api --paginate --slurp "/repos/$repo/pulls/$pr_number/files?per_page=100" > "$tmp/files.json" \
  || fail 'PR files unavailable'
jq -e 'type == "array" and all(.[]; type == "array")' "$tmp/files.json" > /dev/null \
  || fail 'PR files malformed'
if jq -e 'any(.[][]; .filename == ".github/workflows/claude-review.yml")' "$tmp/files.json" > /dev/null; then
  fail 'source PR changes the Review workflow; explicit classification is untrusted'
fi
gh api "/repos/$repo/contents/.github/workflows/claude-review.yml?ref=$run_head" \
  > "$tmp/workflow-content.json" || fail 'source workflow unavailable'
jq -er '.content | select(type == "string")' "$tmp/workflow-content.json" | base64 -d \
  > "$tmp/source-workflow.yml" || fail 'source workflow malformed'
explicit_count=0
for reason in RUN_BUDGET_LIMIT_REACHED ACCOUNT_SPEND_LIMIT_REACHED; do
  grep -Fqx "      - name: Signal $reason" "$tmp/source-workflow.yml" \
    || fail 'source workflow lacks trusted classification signal'
  grep -Fqx "        if: always() && steps.validate-attempt-1.outputs.reason == '$reason'" \
    "$tmp/source-workflow.yml" || fail 'source workflow signal condition differs'
done

grep -Fqx '      - name: Signal Claude classification complete' "$tmp/source-workflow.yml" \
  || fail 'source workflow lacks classification boundary'
grep -Fqx "        if: always() && steps.validate-attempt-1.outcome == 'success'" \
  "$tmp/source-workflow.yml" || fail 'source classification boundary differs'
step_conclusion() {
  jq -r --arg name "$1" '
    [.[0].steps[]? | select(.name == $name)]
    | if length == 1 then .[0].conclusion // "missing" elif length == 0 then "missing" else "duplicate" end
  ' "$tmp/review.json"
}
validation="$(step_conclusion 'Validate Claude review')"
complete="$(step_conclusion 'Signal Claude classification complete')"
missing_markers=0
for reason in RUN_BUDGET_LIMIT_REACHED ACCOUNT_SPEND_LIMIT_REACHED; do
  marker="$(step_conclusion "Signal $reason")"
  case "$marker" in
    success) explicit_count=$((explicit_count + 1)) ;;
    skipped) ;;
    missing) missing_markers=$((missing_markers + 1)) ;;
    *) fail 'classification signal inconsistent' ;;
  esac
done
[ "$explicit_count" -le 1 ] || fail 'conflicting explicit classification signals'
if [ "$explicit_count" -eq 1 ]; then
  [ "$validation" = success ] || fail 'explicit signal without successful validation'
  echo '{"result":"explicit_limit"}'; exit 0
fi
case "$validation:$complete" in
  success:success) [ "$missing_markers" -eq 0 ] || fail 'classification steps missing' ;;
  skipped:skipped|skipped:missing|failure:skipped|failure:missing|missing:missing|missing:skipped) ;;
  *) fail 'classification boundary incomplete' ;;
esac

# Scan every run page. Any later same-HEAD Review that was eligible to run
# supersedes this failure, including an in-progress run. An unknown newer job
# state is an inconsistency, never evidence to create a pause.
gh api --paginate --slurp "/repos/$repo/actions/workflows/$workflow_id/runs?event=pull_request&per_page=100" \
  > "$tmp/runs.json" || fail 'review run history unavailable'
jq -e 'type == "array" and all(.[]; .workflow_runs | type == "array")' "$tmp/runs.json" > /dev/null \
  || fail 'review run history malformed'
jq -r --argjson id "$run_id" --argjson attempt "$event_attempt" \
  --argjson pr "$pr_number" --arg head "$source_head" --arg branch "$source_branch" \
  --arg repo "$repo" '
  .[].workflow_runs[]
  | select(.id > $id or (.id == $id and .run_attempt > $attempt))
  | select(any(.pull_requests[]?; .number == $pr and .head.sha == $head)
      or (.head_branch == $branch and .head_repository.full_name == $repo))
  | if any(.pull_requests[]?; .number == $pr and .head.sha == $head) then .
    else error("newer same-branch run has no matching PR and HEAD") end
  | [.id, .run_attempt] | @tsv
' "$tmp/runs.json" > "$tmp/newer.tsv"
while IFS=$'\t' read -r newer_id newer_attempt; do
  [ -n "$newer_id" ] || continue
  positive "$newer_id" && positive "$newer_attempt" || fail 'newer run identity malformed'
  gh api --paginate --slurp "/repos/$repo/actions/runs/$newer_id/attempts/$newer_attempt/jobs?per_page=100" \
    > "$tmp/newer-jobs.json" || fail 'newer jobs unavailable'
  newer="$(jq -r '[.[] .jobs[] | select(.name == "Review")] |
    if length == 1 then .[0].conclusion // "pending" else "ambiguous" end' "$tmp/newer-jobs.json")" \
    || fail 'newer jobs malformed'
  case "$newer" in
    skipped) ;;
    success|failure|cancelled|timed_out|stale|pending)
      echo '{"result":"superseded"}'; exit 0 ;;
    *) fail 'newer Review job ambiguous' ;;
  esac
done < "$tmp/newer.tsv"

# Recheck the mutable PR immediately before creating the root record.
gh api "/repos/$repo/pulls/$pr_number" > "$tmp/pr-now.json" || fail 'PR refresh unavailable'
jq -e --arg repo "$repo" --arg head "$source_head" '
  .state == "open" and .draft == false and .head.repo.full_name == $repo and .head.sha == $head
' "$tmp/pr-now.json" > /dev/null || { echo '{"result":"stale_pr"}'; exit 0; }
app_id="$(gh api "/apps/$app_slug" --jq '.id')" || fail 'reviewer App ID unavailable'
positive "$app_id" || fail 'invalid reviewer App ID'
head_ref="$(jq -r '.head.ref' "$tmp/pr-now.json")"
if [[ "$head_ref" =~ ^ai/issue-([1-9][0-9]*)$ ]]; then issue="${BASH_REMATCH[1]}"; else issue='-'; fi
GH_TOKEN="${REVIEW_APP_TOKEN:?reviewer App token required}" \
  bash "$script_dir/create-human-pause.sh" create "$repo" "$issue" "$pr_number" "$app_id" \
  claude_execution_failed 'Claude Review jobが正常完了しませんでした。実行結果を確認してください。' "$source_head"
