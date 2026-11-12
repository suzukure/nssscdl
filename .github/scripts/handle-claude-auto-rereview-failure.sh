#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository required}"
run_id="${2:?run ID required}"
attempt="${3:?attempt required}"
app_slug="${4:?reviewer App slug required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "handle-claude-auto-rereview-failure: $1" >&2; exit 1; }
positive() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
positive "$run_id" && positive "$attempt" || fail '起点runの識別情報が不正です'
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'リポジトリ指定が不正です'
[[ "$app_slug" =~ ^[A-Za-z0-9-]+$ ]] || fail 'reviewer App slugが不正です'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh api "/repos/$repo/actions/runs/$run_id" > "$tmp/run.json" || fail '起点runを取得できません'
default_branch="$(gh api "/repos/$repo" --jq .default_branch)" || fail 'default branchを取得できません'
jq -e --arg repo "$repo" --arg branch "$default_branch" --argjson id "$run_id" --argjson attempt "$attempt" '
  .id == $id and .run_attempt == $attempt and .name == "Claude Auto Rereview"
  and .event == "repository_dispatch" and .status == "completed"
  and .head_repository.full_name == $repo and .head_branch == $branch
  and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.path | type == "string" and test("^\\.github/workflows/claude-auto-rereview\\.yml(@|$)"))
  and (.workflow_id | type == "number")
' "$tmp/run.json" >/dev/null || fail '起点workflow・run・attemptが不整合です'
workflow_id="$(jq -r .workflow_id "$tmp/run.json")"

# Accepted identity is durable before any machine-state write. The paid
# boundary is additional evidence; its absence cannot erase an accepted run.
gh api --paginate --slurp "/repos/$repo/actions/runs/$run_id/artifacts?per_page=100" > "$tmp/artifacts.json" \
  || fail '起点artifact一覧を取得できません'
jq -e 'type == "array" and all(.[]; .artifacts | type == "array")' "$tmp/artifacts.json" >/dev/null \
  || fail '起点artifact一覧が不正です'
artifact_id() {
  jq -r --arg name "$1" '[.[] .artifacts[] | select(.name == $name)] |
    if length == 0 then empty
    elif length == 1 and .[0].expired == false then .[0].id
    else error("ambiguous or expired identity artifact") end' "$tmp/artifacts.json"
}
accepted_id="$(artifact_id "auto-accepted-${run_id}-${attempt}")"
paid_id="$(artifact_id "auto-paid-${run_id}-${attempt}")"
if [ -z "$accepted_id" ]; then
  [ -z "$paid_id" ] || fail '受理情報のない有料実行境界です'
  echo '{"result":"no_accepted_identity"}'
  exit 0
fi
positive "$accepted_id" || fail '受理artifact IDが不正です'
gh api "/repos/$repo/actions/artifacts/$accepted_id/zip" > "$tmp/accepted.zip" || fail '受理artifactを取得できません'
unzip -p "$tmp/accepted.zip" accepted.json > "$tmp/accepted.json" || fail '受理artifactが不正です'
jq -e --arg repo "$repo" --argjson id "$run_id" --argjson attempt "$attempt" '
  (keys == ["attempt","identity","run_id"]) and .run_id == $id and .attempt == $attempt
  and (.identity | keys == ["base_ref","closing_issue_number","head_ref","pr_number","repo","round","trusted_base_sha","validated_sha"])
  and .identity.repo == $repo
  and (.identity.pr_number | type == "number" and floor == . and . > 0)
  and (.identity.closing_issue_number | type == "number" and floor == . and . > 0)
  and (.identity.round | type == "number" and floor == . and . > 0)
  and (.identity.validated_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.identity.trusted_base_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and .identity.head_ref == ("ai/issue-" + (.identity.closing_issue_number | tostring))
' "$tmp/accepted.json" >/dev/null || fail '受理artifactの識別情報が不正です'
if [ -n "$paid_id" ]; then
  positive "$paid_id" || fail '有料実行artifact IDが不正です'
  gh api "/repos/$repo/actions/artifacts/$paid_id/zip" > "$tmp/paid.zip" || fail '有料実行artifactを取得できません'
  unzip -p "$tmp/paid.zip" paid-start.json > "$tmp/paid.json" || fail '有料実行artifactが不正です'
  cmp -s "$tmp/accepted.json" "$tmp/paid.json" || fail '有料実行境界と受理情報の識別情報が一致しません'
fi
pr_number="$(jq -r .identity.pr_number "$tmp/accepted.json")"
head_sha="$(jq -r .identity.validated_sha "$tmp/accepted.json")"
issue_number="$(jq -r .identity.closing_issue_number "$tmp/accepted.json")"

gh api "/repos/$repo/actions/runs/$run_id/attempts/$attempt" > "$tmp/attempt.json" || fail '起点attemptを取得できません'
jq -e --argjson id "$run_id" --argjson attempt "$attempt" '
  .id == $id and .run_attempt == $attempt and .status == "completed"' "$tmp/attempt.json" >/dev/null \
  || fail '起点attemptの識別情報が不正です'
gh api --paginate --slurp "/repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100" > "$tmp/jobs.json" \
  || fail '起点jobを取得できません'
jq -e 'type == "array" and all(.[]; .jobs | type == "array")' "$tmp/jobs.json" >/dev/null \
  || fail '起点jobの形式が不正です'
jq -c '[.[] .jobs[] | select(.name == "Auto Review")]' "$tmp/jobs.json" > "$tmp/review.json"
[ "$(jq 'length' "$tmp/review.json")" -eq 1 ] || fail 'Auto Review jobが曖昧です'
conclusion="$(jq -r '.[0].conclusion // empty' "$tmp/review.json")"
case "$conclusion" in
  success|skipped) echo '{"result":"ignored"}'; exit 0 ;;
  failure|cancelled|timed_out|stale) ;;
  *) fail '不明なAuto Reviewの終了結果です' ;;
esac
step_conclusion() {
  jq -r --arg name "$1" '[.[0].steps[]? | select(.name == $name)] |
    if length == 1 then .[0].conclusion // .[0].status // "missing"
    elif length == 0 then "missing" else "duplicate" end' "$tmp/review.json"
}
paid_step="$(step_conclusion 'Run Claude review')"
case "$paid_step" in
  success|failure|cancelled|timed_out|stale|in_progress|skipped|missing) ;;
  *) fail '有料actionの状態が曖昧です' ;;
esac
for reason in RUN_BUDGET_LIMIT_REACHED ACCOUNT_SPEND_LIMIT_REACHED; do
  case "$(step_conclusion "Signal $reason")" in
    success) echo '{"result":"explicit_limit"}'; exit 0 ;;
    skipped|missing) ;;
    *) fail '上限分類markerが曖昧です' ;;
  esac
done
case "$(step_conclusion 'Classify and validate review')" in
  success|skipped|failure|missing) ;;
  *) fail '分類状態が曖昧です' ;;
esac
case "$(step_conclusion 'Signal verdict suppressed')" in
  success) echo '{"result":"verdict_suppressed"}'; exit 0 ;;
  skipped|missing) ;;
  *) fail '判定抑止markerが曖昧です' ;;
esac
case "$(step_conclusion 'Pause for human decision')" in
  success) echo '{"result":"paused"}'; exit 0 ;;
  skipped|missing|failure|cancelled|timed_out|stale) ;;
  *) fail '共通停止stepが曖昧です' ;;
esac

# A later dispatch (including a pending gate) or normal Review for this PR
# supersedes the failed attempt. Unknown newer dispatch identity fails closed.
gh api --paginate --slurp "/repos/$repo/actions/workflows/$workflow_id/runs?event=repository_dispatch&per_page=100" > "$tmp/runs.json" \
  || fail 'dispatch履歴を取得できません'
jq -e 'type == "array" and all(.[]; .workflow_runs | type == "array")' "$tmp/runs.json" >/dev/null \
  || fail 'dispatch履歴が不正です'
mapfile -t newer_runs < <(jq -r --argjson id "$run_id" --argjson attempt "$attempt" '
  .[].workflow_runs[] | select(.id > $id or (.id == $id and .run_attempt > $attempt)) | .id' "$tmp/runs.json")
for newer_id in "${newer_runs[@]}"; do
  positive "$newer_id" || fail '後続dispatch IDが不正です'
  gh api --paginate --slurp "/repos/$repo/actions/runs/$newer_id/artifacts?per_page=100" > "$tmp/newer-artifacts.json" \
    || fail '後続dispatchのartifactを取得できません'
  jq -e 'type == "array" and all(.[]; .artifacts | type == "array")' "$tmp/newer-artifacts.json" >/dev/null \
    || fail '後続dispatchのartifactが不正です'
  newer_count="$(jq '[.[] .artifacts[] | select(.name | startswith("auto-accepted-"))] | length' "$tmp/newer-artifacts.json")"
  [ "$newer_count" -le 1 ] || fail '後続の受理情報の識別情報が曖昧です'
  newer_artifact="$(jq -r '[.[] .artifacts[] | select(.name | startswith("auto-accepted-"))] |
    if length == 1 then .[0].id else empty end' "$tmp/newer-artifacts.json")"
  if [ -z "$newer_artifact" ]; then
    newer_status="$(jq -r --argjson id "$newer_id" '[.[].workflow_runs[] | select(.id == $id)] | first | .status' "$tmp/runs.json")"
    [ "$newer_status" = completed ] || fail '後続dispatchがこのPRを受理する可能性があります'
    continue
  fi
  gh api "/repos/$repo/actions/artifacts/$newer_artifact/zip" > "$tmp/newer.zip" || fail '後続の受理artifactを取得できません'
  unzip -p "$tmp/newer.zip" accepted.json > "$tmp/newer.json" || fail '後続の受理artifactが不正です'
  newer_pr="$(jq -er '.identity.pr_number | select(type == "number" and floor == . and . > 0)' "$tmp/newer.json")" \
    || fail '後続の受理情報の識別情報が不正です'
  if [ "$newer_pr" = "$pr_number" ]; then echo '{"result":"superseded"}'; exit 0; fi
done

# A newer normal Review on the same PR and HEAD may already be running after
# this job released the shared per-PR concurrency group.
gh api --paginate --slurp "/repos/$repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100" > "$tmp/normal-runs.json" \
  || fail '通常Reviewの履歴を取得できません'
jq -e 'type == "array" and all(.[]; .workflow_runs | type == "array")' "$tmp/normal-runs.json" >/dev/null \
  || fail '通常Reviewの履歴が不正です'
jq -r --argjson id "$run_id" --argjson pr "$pr_number" --arg head "$head_sha" \
  --arg repo "$repo" --arg branch "$(jq -r .identity.head_ref "$tmp/accepted.json")" '
  .[].workflow_runs[] | select(.id > $id)
  | if any(.pull_requests[]?; .number == $pr and .head.sha == $head) then .id
    elif .head_branch == $branch and .head_repository.full_name == $repo
      then error("newer normal run has ambiguous PR identity")
    else empty end
' "$tmp/normal-runs.json" > "$tmp/normal-ids" || fail '通常Reviewの関連付けが曖昧です'
mapfile -t normal_ids < "$tmp/normal-ids"
for normal_id in "${normal_ids[@]}"; do
  positive "$normal_id" || fail '通常run IDが不正です'
  normal_attempt="$(jq -r --argjson id "$normal_id" '[.[].workflow_runs[] | select(.id == $id)] |
    if length == 1 then .[0].run_attempt else empty end' "$tmp/normal-runs.json")"
  positive "$normal_attempt" || fail '通常run attemptが不正です'
  gh api --paginate --slurp "/repos/$repo/actions/runs/$normal_id/attempts/$normal_attempt/jobs?per_page=100" \
    > "$tmp/normal-jobs.json" || fail '通常Review jobを取得できません'
  jq -e 'type == "array" and all(.[]; .jobs | type == "array")' "$tmp/normal-jobs.json" >/dev/null \
    || fail '通常Review jobが不正です'
  normal_paid="$(jq -r '[.[] .jobs[] | select(.name == "Review")] |
    if length == 0 then "pending" elif length != 1 then "ambiguous"
    elif .[0].conclusion == "skipped" then "skipped"
    else ([.[0].steps[]? | select(.name == "Run Claude review")] |
      if length == 1 then .[0].conclusion // .[0].status // "pending"
      elif length == 0 then "missing" else "ambiguous" end) end' "$tmp/normal-jobs.json")"
  case "$normal_paid" in
    success|failure|cancelled|timed_out|stale|in_progress)
      echo '{"result":"superseded"}'; exit 0 ;;
    skipped|missing|pending) ;;
    *) fail '通常Reviewの有料実行が曖昧です' ;;
  esac
done

# Current PR/HEAD and relation must still match the trusted accepted identity.
gh api "/repos/$repo/pulls/$pr_number" > "$tmp/pr.json" || fail '現在のPRを取得できません'
if ! jq -e --arg repo "$repo" --arg head "$head_sha" --argjson number "$pr_number" \
  --arg branch "$(jq -r .identity.head_ref "$tmp/accepted.json")" '
  .number == $number and .state == "open" and .draft == false
  and .head.repo.full_name == $repo and .head.sha == $head and .head.ref == $branch
' "$tmp/pr.json" >/dev/null; then
  echo '{"result":"stale_pr"}'; exit 0
fi
jq -e '.labels | type == "array" and all(.[]; type == "object" and (.name | type) == "string")' \
  "$tmp/pr.json" >/dev/null || fail '現在のPRラベルを取得できません'
machine_present="$(jq -r '[.labels[].name] | index("ai-followup-in-progress") != null' "$tmp/pr.json")"
relation="$(gh pr view "$pr_number" --repo "$repo" --json headRefOid,closingIssuesReferences)" \
  || fail 'closing Issueの関連付けを取得できません'
jq -e --arg repo "$repo" --arg head "$head_sha" --argjson issue "$issue_number" '
  .headRefOid == $head and (.closingIssuesReferences | type) == "array"
  and any(.closingIssuesReferences[]; .number == $issue and
    .url == ("https://github.com/" + $repo + "/issues/" + ($issue | tostring)))
' <<< "$relation" >/dev/null || fail 'closing Issueの関連付けが変化したか曖昧です'

# A pause write may have succeeded even when the job lost its response.
# Only App identity lookup switches from the workflow token to the reviewer token.
GH_TOKEN="${REVIEW_APP_TOKEN:?reviewer App token required}" \
  gh api "/apps/$app_slug" > "$tmp/app.json" 2>/dev/null || fail 'reviewer App IDを取得できません'
app_id="$(jq -ser --arg slug "$app_slug" '
  select(length == 1) | .[0] | select(type == "object" and .slug == $slug)
  | .id | select(type == "number" and floor == . and . > 0)
' "$tmp/app.json" 2>/dev/null)" || fail 'reviewer Appの識別情報が不正です'
positive "$app_id" || fail 'reviewer App IDが不正です'
active="$(
  GH_TOKEN="${REVIEW_APP_TOKEN:?reviewer App token required}" \
    bash "$script_dir/list-human-pause-records.sh" "$repo" "$pr_number" "$pr_number" "$app_id" \
    | bash "$script_dir/validate-human-pause-record-graph.sh" \
    | bash "$script_dir/decompose-human-pause-record-graph.sh" \
    | bash "$script_dir/derive-human-pause-pre-resume-state.sh" \
    | bash "$script_dir/reconcile-human-pause-resume-acceptance.sh" \
    | bash "$script_dir/reconcile-human-pause-active-pause.sh"
)" || fail '共通停止履歴を取得できません'
case "$(jq -r .result <<< "$active")" in
  active)
    GH_TOKEN="$REVIEW_APP_TOKEN" bash "$script_dir/create-human-pause.sh" inspect \
      "$repo" "$issue_number" "$pr_number" "$app_id" \
      "$(jq -r .active_pause.pause_id <<< "$active")" || fail '有効な停止記録の確認に失敗しました'
    GH_TOKEN="$REVIEW_APP_TOKEN" gh issue edit "$pr_number" --repo "$repo" --remove-label ai-followup-in-progress
    echo '{"result":"paused"}'; exit 0 ;;
  no_active_pause) ;;
  *) fail '共通停止履歴が不整合です' ;;
esac

# A completed review is observed from trusted review history, including the
# case where the POST succeeded but its response was lost.
gh api --paginate --slurp "/repos/$repo/pulls/$pr_number/reviews?per_page=100" > "$tmp/reviews.json" \
  || fail 'review履歴を取得できません'
jq -e 'type == "array" and all(.[]; type == "array")
  and all(.[][]; type == "object" and (.commit_id | type) == "string"
    and (.user.login | type) == "string" and (.state | type) == "string"
    and (.submitted_at == null or (.submitted_at | type) == "string"))' "$tmp/reviews.json" >/dev/null \
  || fail 'review履歴が不正です'
started="$(jq -r '.run_started_at // empty' "$tmp/run.json")"
[[ "$started" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail '起点の開始時刻を取得できません'
if jq -e --arg head "$head_sha" --arg login "${app_slug}[bot]" --arg started "$started" '
  any(.[][]; .commit_id == $head and .user.login == $login
    and (.state == "APPROVED" or .state == "CHANGES_REQUESTED")
    and (.submitted_at | type == "string" and . >= $started))
' "$tmp/reviews.json" >/dev/null; then
  echo '{"result":"verdict_posted"}'; exit 0
fi
if [ "$paid_step" = skipped ] || [ "$paid_step" = missing ]; then
  if [ "$machine_present" = true ]; then
    echo '{"result":"no_paid_execution"}'; exit 0
  fi
  pause_reason=state_inconsistent
else
  [ -n "$paid_id" ] || fail '永続的な境界記録がない有料actionです'
  [ "$machine_present" = false ] || fail '有料action後も機械状態が残っています'
  pause_reason=claude_execution_failed
fi

# Recheck immediately before the common pause write; the helper deduplicates
# an existing matching root and sends the common notification only on creation.
gh api "/repos/$repo/pulls/$pr_number" > "$tmp/pr-now.json" || fail 'PRの最新情報を取得できません'
jq -e --arg head "$head_sha" '.state == "open" and .head.sha == $head' "$tmp/pr-now.json" >/dev/null \
  || { echo '{"result":"stale_pr"}'; exit 0; }
jq -e --argjson present "$machine_present" '
  ([.labels[].name] | index("ai-followup-in-progress") != null) == $present
' "$tmp/pr-now.json" >/dev/null || fail '照合中に機械状態が変化しました'
GH_TOKEN="${REVIEW_APP_TOKEN:?reviewer App token required}" \
  bash "$script_dir/create-human-pause.sh" create "$repo" "$issue_number" "$pr_number" "$app_id" \
    "$pause_reason" 'Claude自動再レビューが正常完了しませんでした。実行結果を確認してください。' "$head_sha" \
    --notification-detail 'Claude auto-rereview execution did not complete.'
GH_TOKEN="$REVIEW_APP_TOKEN" gh issue edit "$pr_number" --repo "$repo" --remove-label ai-followup-in-progress
