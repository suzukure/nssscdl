#!/usr/bin/env bash
set -euo pipefail

# Handles one completed Claude Review run. Ordinary reads use the workflow token;
# App identity lookup and the pause producer use the reviewer installation token.
repo="${1:?repository required}"
run_id="${2:?run ID required}"
event_attempt="${3:?run attempt required}"
app_slug="${4:?reviewer App slug required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "handle-claude-review-failure: $1" >&2; exit 1; }
positive() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
positive "$run_id" && positive "$event_attempt" || fail '起点の識別情報が不正です'
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'リポジトリ指定が不正です'
[[ "$app_slug" =~ ^[a-zA-Z0-9-]+$ ]] || fail 'App slugが不正です'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh api "/repos/$repo/actions/runs/$run_id" > "$tmp/run.json" || fail '起点runを取得できません'
jq -e --arg repo "$repo" --argjson id "$run_id" --argjson attempt "$event_attempt" '
  .id == $id and .name == "Claude Review" and .event == "pull_request"
  and (.path | type == "string" and test("^\\.github/workflows/claude-review\\.yml(@|$)"))
  and .head_repository.full_name == $repo and .status == "completed"
  and (.head_branch | type == "string" and length > 0)
  and .run_attempt == $attempt and (.workflow_id | type == "number")
  and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.pull_requests == null or (.pull_requests | type == "array"))
' "$tmp/run.json" > /dev/null || fail '起点runの識別情報が不整合か古い状態です'
source_head="$(jq -r '.head_sha' "$tmp/run.json")"
source_branch="$(jq -r '.head_branch' "$tmp/run.json")"
workflow_id="$(jq -r '.workflow_id' "$tmp/run.json")"

# workflow_run.pull_requests can be empty after merge. Resolve from the run's
# same-repository branch and exact HEAD, then cross-check any run association.
head_query="$(jq -rn --arg head "${repo%%/*}:$source_branch" '$head | @uri')"
gh api --paginate --slurp "/repos/$repo/pulls?state=all&head=$head_query&per_page=100" \
  > "$tmp/pulls.json" || fail '起点PRの検索結果を取得できません'
jq -e 'type == "array" and all(.[]; type == "array")' "$tmp/pulls.json" > /dev/null \
  || fail '起点PRの検索結果が不正です'
jq -c --arg repo "$repo" --arg branch "$source_branch" --arg head "$source_head" '
  [.[][] | select(.head.repo.full_name == $repo and .head.ref == $branch and .head.sha == $head)]
' "$tmp/pulls.json" > "$tmp/matches.json" || fail '起点PRの検索結果が不正です'
case "$(jq 'length' "$tmp/matches.json")" in
  0) echo '{"result":"stale_pr"}'; exit 0 ;;
  1) ;;
  *) fail '起点PRの候補が複数あります' ;;
esac
pr_number="$(jq -r '.[0].number' "$tmp/matches.json")"
positive "$pr_number" || fail '起点PR番号が不正です'
jq -e --argjson pr "$pr_number" --arg head "$source_head" '
  (.pull_requests // []) as $associations
  | ($associations | length == 0)
    or ($associations | length == 1 and .[0].number == $pr and .[0].head.sha == $head)
' "$tmp/run.json" > /dev/null || fail '起点PRの関連付けが一致しません'

gh api "/repos/$repo/actions/runs/$run_id/attempts/$event_attempt" > "$tmp/attempt.json" \
  || fail '起点attemptを取得できません'
jq -e --argjson id "$run_id" --argjson attempt "$event_attempt" '
  .id == $id and .run_attempt == $attempt and .status == "completed"
' "$tmp/attempt.json" > /dev/null || fail '起点attemptが不整合です'

source_conclusion="$(jq -r '.conclusion // empty' "$tmp/run.json")"
case "$source_conclusion" in
  success|skipped) echo '{"result":"ignored"}'; exit 0 ;;
  failure|cancelled|timed_out|stale) ;;
  *) fail '不明な起点runの終了結果です' ;;
esac

gh api --paginate --slurp "/repos/$repo/actions/runs/$run_id/attempts/$event_attempt/jobs?per_page=100" \
  > "$tmp/jobs.json" || fail '起点jobを取得できません'
jq -e 'type == "array" and all(.[]; .jobs | type == "array")' "$tmp/jobs.json" > /dev/null \
  || fail '起点jobの形式が不正です'
retirement=false
[ "$source_branch" != submission/issue-1180-retirement ] || retirement=true
jq -c '[.[] .jobs[] | select(.name == "Review")]' "$tmp/jobs.json" > "$tmp/review.json"
case "$(jq 'length' "$tmp/review.json")" in
  0) [ "$retirement" = true ] || fail 'Review jobが存在しません'
     conclusion=missing ;;
  1) conclusion="$(jq -r '.[0].conclusion // empty' "$tmp/review.json")" ;;
  *) fail 'Review jobが重複しています' ;;
esac
case "$conclusion" in
  skipped)
    if [ "$retirement" = false ]; then
      echo '{"result":"ignored"}'; exit 0
    fi
    ;;
  success) echo '{"result":"ignored"}'; exit 0 ;;
  failure|cancelled|timed_out|stale|missing) ;;
  *) fail '不明なReviewの終了結果です' ;;
esac

gh api "/repos/$repo/pulls/$pr_number" > "$tmp/pr.json" || fail 'PRを取得できません'
jq -e --arg repo "$repo" --arg head "$source_head" --argjson number "$pr_number" '
  .number == $number and .state == "open" and .draft == false
  and .head.repo.full_name == $repo and .head.sha == $head
' "$tmp/pr.json" > /dev/null || { echo '{"result":"stale_pr"}'; exit 0; }

# An edited review workflow can spoof marker steps. Verify its absence in the
# source PR and the two fixed marker definitions in the source run commit.
gh api --paginate --slurp "/repos/$repo/pulls/$pr_number/files?per_page=100" > "$tmp/files.json" \
  || fail 'PRのファイル一覧を取得できません'
jq -e 'type == "array" and all(.[]; type == "array")' "$tmp/files.json" > /dev/null \
  || fail 'PRのファイル一覧が不正です'
if jq -e 'any(.[][]; .filename == ".github/workflows/claude-review.yml")' "$tmp/files.json" > /dev/null; then
  fail '起点PRがReview workflowを変更しているため、明示的な分類を信頼できません'
fi
gh api "/repos/$repo/contents/.github/workflows/claude-review.yml?ref=$source_head" \
  > "$tmp/workflow-content.json" || fail '起点workflowを取得できません'
jq -er '.content | select(type == "string")' "$tmp/workflow-content.json" | base64 -d \
  > "$tmp/source-workflow.yml" || fail '起点workflowが不正です'
# These diagnostics do not produce a paid-failure pause. Require terminal
# evidence, since a missing or interrupted paid step cannot establish non-use.
if [ "$retirement" = true ] &&
   grep -Fqx '    name: Authorize retirement-1180' "$tmp/source-workflow.yml" &&
   grep -Fqx '    needs: retirement-preflight' "$tmp/source-workflow.yml"; then
  if [[ "$conclusion" = skipped || "$conclusion" = missing ]]; then
    preflight="$(jq -er '
      [.[] .jobs[] | select(.name == "Authorize retirement-1180")]
      | if length == 1 then .[0].conclusion else empty end
    ' "$tmp/jobs.json")" || fail '限定preflightの終端証拠が不明です'
    case "$conclusion:$preflight" in
      skipped:failure|skipped:cancelled|skipped:timed_out|skipped:skipped|skipped:success|missing:failure|missing:cancelled|missing:timed_out)
        jq -cn --arg status "$preflight" '{result:"retirement_paid_not_started",preflight:$status}'
        exit 0 ;;
      *) fail '限定preflight後の有料実行有無を確定できません' ;;
    esac
  fi
  paid="$(jq -r '
    [.[0].steps[]? | select(.name == "Run Claude review")]
    | if length == 1 then .[0].conclusion // "unknown" else "unknown" end
  ' "$tmp/review.json")"
  if [ "$paid" = skipped ]; then
    echo '{"result":"retirement_paid_not_started","review":"paid_step_skipped"}'
    exit 0
  fi
  case "$paid" in
    success|failure) echo 'retirement-1180: paid action reached; checking existing failure classification' >&2 ;;
    *) echo 'retirement-1180: paid execution unknown; preserving existing failure classification' >&2 ;;
  esac
elif [ "$conclusion" = skipped ]; then
  echo '{"result":"ignored"}'; exit 0
elif [ "$conclusion" = missing ]; then
  fail 'Review jobが存在せず有料実行有無を確定できません'
fi

explicit_count=0
for reason in RUN_BUDGET_LIMIT_REACHED ACCOUNT_SPEND_LIMIT_REACHED; do
  grep -Fqx "      - name: Signal $reason" "$tmp/source-workflow.yml" \
    || fail '起点workflowに信頼済み分類signalがありません'
  grep -Fqx "        if: always() && steps.validate-attempt-1.outputs.reason == '$reason'" \
    "$tmp/source-workflow.yml" || fail '起点workflowのsignal条件が異なります'
done

grep -Fqx '      - name: Signal Claude classification complete' "$tmp/source-workflow.yml" \
  || fail '起点workflowに分類境界がありません'
grep -Fqx "        if: always() && steps.validate-attempt-1.outcome == 'success'" \
  "$tmp/source-workflow.yml" || fail '起点workflowの分類境界が異なります'
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
    *) fail '分類signalが不整合です' ;;
  esac
done
[ "$explicit_count" -le 1 ] || fail '明示的な分類signalが競合しています'
if [ "$explicit_count" -eq 1 ]; then
  [ "$validation" = success ] || fail '検証成功を伴わない明示的なsignalです'
  echo '{"result":"explicit_limit"}'; exit 0
fi
case "$validation:$complete" in
  success:success) [ "$missing_markers" -eq 0 ] || fail '分類stepがありません' ;;
  skipped:skipped|skipped:missing|failure:skipped|failure:missing|missing:missing|missing:skipped) ;;
  *) fail '分類境界が完了していません' ;;
esac

# Scan every run page. Any later same-HEAD Review that was eligible to run
# supersedes this failure, including an in-progress run. For the retirement
# route require evidence the newer run reached the paid step. Unknown newer
# state is an inconsistency, never evidence to create a pause.
gh api --paginate --slurp "/repos/$repo/actions/workflows/$workflow_id/runs?event=pull_request&per_page=100" \
  > "$tmp/runs.json" || fail 'review run履歴を取得できません'
jq -e 'type == "array" and all(.[]; .workflow_runs | type == "array")' "$tmp/runs.json" > /dev/null \
  || fail 'review run履歴が不正です'
jq -r --argjson id "$run_id" --argjson attempt "$event_attempt" \
  --argjson pr "$pr_number" --arg head "$source_head" --arg branch "$source_branch" \
  --arg repo "$repo" --argjson retirement "$retirement" '
  .[].workflow_runs[]
  | select(.id > $id or (.id == $id and .run_attempt > $attempt))
  | select(any(.pull_requests[]?; .number == $pr and .head.sha == $head)
      or (.head_branch == $branch and .head_repository.full_name == $repo))
  | if any(.pull_requests[]?; .number == $pr and .head.sha == $head) then .
    elif $retirement and .head_branch == $branch and .head_repository.full_name == $repo
        and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
        and ((.pull_requests // []) | length == 0) then select(.head_sha == $head)
    else error("newer same-branch run has no matching PR and HEAD") end
  | [.id, .run_attempt] | @tsv
' "$tmp/runs.json" > "$tmp/newer.tsv"
while IFS=$'\t' read -r newer_id newer_attempt; do
  [ -n "$newer_id" ] || continue
  positive "$newer_id" && positive "$newer_attempt" || fail '後続runの識別情報が不正です'
  gh api --paginate --slurp "/repos/$repo/actions/runs/$newer_id/attempts/$newer_attempt/jobs?per_page=100" \
    > "$tmp/newer-jobs.json" || fail '後続jobを取得できません'
  newer="$(jq -r --argjson retirement "$retirement" '
    [.[] .jobs[]] as $jobs
    | [$jobs[] | select(.name == "Review")] as $review
    | if ($review | length) == 1 then
        $review[0] as $job
        | if $retirement and $job.conclusion != "skipped" then
            [$job.steps[]? | select(.name == "Run Claude review")] as $paid
            | if ($paid | length) > 1 then "ambiguous"
              elif ($paid | length) == 1 and $paid[0].conclusion == "skipped" then "skipped"
              elif ($paid | length) == 1 and ($paid[0].started_at | type) == "string" then "pending"
              elif $job.status == "queued" or $job.status == "in_progress" then "skipped"
              else "ambiguous" end
          else $job.conclusion // "pending" end
      elif $retirement and ($review | length) == 0 then
        [$jobs[] | select(.name == "Authorize retirement-1180")] as $preflight
        | if ($preflight | length) == 1 and
             ($preflight[0] | .conclusion == "failure" or .conclusion == "cancelled" or
              .conclusion == "timed_out" or .conclusion == "skipped" or .status == "queued" or
              .status == "in_progress") then "skipped" else "ambiguous" end
      else "ambiguous" end
  ' "$tmp/newer-jobs.json")" || fail '後続jobが不正です'
  case "$newer" in
    skipped) ;;
    success|failure|cancelled|timed_out|stale|pending)
      echo '{"result":"superseded"}'; exit 0 ;;
    *) fail '後続Review jobが曖昧です' ;;
  esac
done < "$tmp/newer.tsv"

# Recheck the mutable PR immediately before creating the root record.
gh api "/repos/$repo/pulls/$pr_number" > "$tmp/pr-now.json" || fail 'PRの最新情報を取得できません'
jq -e --arg repo "$repo" --arg head "$source_head" '
  .state == "open" and .draft == false and .head.repo.full_name == $repo and .head.sha == $head
' "$tmp/pr-now.json" > /dev/null || { echo '{"result":"stale_pr"}'; exit 0; }
GH_TOKEN="${REVIEW_APP_TOKEN:?reviewer App token required}" \
  gh api "/apps/$app_slug" > "$tmp/app.json" 2>/dev/null || fail 'reviewer App IDを取得できません'
app_id="$(jq -ser --arg slug "$app_slug" '
  select(length == 1) | .[0] | select(type == "object" and .slug == $slug)
  | .id | select(type == "number" and floor == . and . > 0)
' "$tmp/app.json" 2>/dev/null)" || fail 'reviewer Appの識別情報が不正です'
positive "$app_id" || fail 'reviewer App IDが不正です'
GH_TOKEN="${REVIEW_APP_TOKEN:?reviewer App token required}" \
  bash "$script_dir/create-human-pause.sh" create "$repo" - "$pr_number" "$app_id" \
  claude_execution_failed 'Claude Review jobが正常完了しませんでした。実行結果を確認してください。' "$source_head"
