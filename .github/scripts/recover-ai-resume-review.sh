#!/usr/bin/env bash
set -euo pipefail

# Called only inside the canonical Issue writer group, from the default branch.
repo="${1:?リポジトリ指定が必要です}"
run_id="${2:?起点runが必要です}"
attempt="${3:?起点attemptが必要です}"
app_slug="${4:?信頼済みApp slugが必要です}"
pr="${5:?PRの指定が必要です}"
issue="${6:?closing Issueの指定が必要です}"
source="${7:?起点の停止記録が必要です}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "recover-ai-resume-review: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'リポジトリ指定が不正です'
[[ "$app_slug" =~ ^[A-Za-z0-9-]+$ ]] || fail 'App slugが不正です'
for value in "$run_id" "$attempt" "$pr" "$issue" "$source"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail '数値の識別情報が不正です'
done
app_id="$(gh api "/apps/$app_slug" --jq .id)" || fail 'Appの識別情報を取得できません'
[[ "$app_id" =~ ^[1-9][0-9]*$ ]] || fail 'Appの識別情報が不正です'
prepare() {
  bash "$script_dir/prepare-ai-resume-review-recovery.sh" \
    "$repo" "$run_id" "$attempt" "$app_id" "$pr" "$issue" "$source"
}
plan="$(prepare)" || fail '復旧に必要な情報を取得できません'
result="$(jq -er '.result | select(IN("pre_acceptance","normal_review_owns","recover"))' \
  <<< "$plan")" || fail '復旧結果が不正です'
if [ "$result" = normal_review_owns ]; then
  jq -e '.actions == []' <<< "$plan" >/dev/null || fail '通常Reviewのactionが一致しません'
  exit 0
fi

# A lost POST response is resolved by a fresh trusted graph read. Never retry
# an uncertain write: a later recovery invocation can recheck its outcome.
if jq -e 'any(.actions[]; .action == "create_or_reconcile_replacement_pause")' \
  <<< "$plan" >/dev/null; then
  [ "$result" = recover ] || fail '受理前に置換が要求されました'
  accepted="$(jq -er '.accepted_record_id | select(type == "string" and test("^[1-9][0-9]*$"))' \
    <<< "$plan")" || fail '受理記録の識別情報を取得できません'
  record="$(jq -cn --arg target "pr:$pr" --arg accepted "$accepted" \
    '{version:1,kind:"pause",reason:"resume_transition_failed",target:$target,
      source_pause_id:$accepted,payload:{failed_action:"review"}}')"
  body="$(bash "$script_dir/human-pause-record.sh" create "$record")" \
    || fail '置換記録が不正です'
  gh api -X POST "/repos/$repo/issues/$pr/comments" -f "body=$body" >/dev/null || true
  plan="$(prepare)" || fail '置換記録のPOST結果を照合できません'
  jq -e --arg accepted "$accepted" '
    .result == "recover" and .accepted_record_id == $accepted
    and (.replacement_pause_id | type == "string" and test("^[1-9][0-9]*$"))
    and (any(.actions[]; .action == "create_or_reconcile_replacement_pause" or
                              .action == "revalidate_record_graph") | not)
  ' <<< "$plan" >/dev/null || fail '置換記録が一意に有効ではありません'
fi

# Re-read mutable facts after each write, applying only labels still missing.
for iteration in 1 2 3; do
  action="$(jq -er '
    if .result == "normal_review_owns" and .actions == [] then "done"
    elif (.result == "recover" or .result == "pre_acceptance") and
         (.actions | type) == "array" then
      if (.actions | length) == 0 then "done"
      elif ([.actions[] | select(.action == "add_issue_human_label" or
                                    .action == "add_pr_human_label")] | length) ==
           (.actions | length) then .actions[0].action
      else error("想定外の復旧actionです") end
    else error("復旧状態が不正です") end
  ' <<< "$plan")" || fail '復旧actionが不正です'
  [ "$action" != done ] || exit 0
  case "$action" in
    add_issue_human_label) number="$issue" ;;
    add_pr_human_label) number="$pr" ;;
    *) fail '不明なラベルactionです' ;;
  esac
  jq -e --argjson number "$number" '.actions[0].number == $number' \
    <<< "$plan" >/dev/null || fail 'ラベル対象が一致しません'
  # The server may have applied the label even when its response was lost.
  # Reconcile once from fresh facts; never resend an uncertain write here.
  gh issue edit "$number" --repo "$repo" --add-label human-review-required \
    || true
  plan="$(prepare)" || fail 'ラベルの修復を確認できません'
  jq -e --arg action "$action" --argjson number "$number" '
    any(.actions[]; .action == $action and .number == $number) | not
  ' <<< "$plan" >/dev/null || fail 'ラベルの修復を確認できません'
done
fail '復旧が収束しませんでした'
