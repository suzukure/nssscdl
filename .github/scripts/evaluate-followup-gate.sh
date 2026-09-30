#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
reviewer_app_slug="${3:?reviewer App slug is required}"
developer_app_slug="${4:?developer App slug is required}"
review_body="${5:-}"

emit_result() {
  jq -cn \
    --argjson continue "$1" \
    --argjson escalate "$2" \
    --argjson notify "$3" \
    --arg reason "$4" \
    '{continue: $continue, escalate: $escalate, notify: $notify, reason: $reason}'
}

metadata="$(gh pr view "$pr_number" --repo "$repo" --json author,reviews,labels,closingIssuesReferences 2>/dev/null)" || {
  emit_result false false false 'フォローアップに必要なメタデータを取得できなかったため、処理をスキップします。'
  exit 0
}
if ! jq -es 'length == 1 and (.[0] | type == "object" and
    (.author.login | type == "string") and
    (.reviews | type == "array") and
    (.labels | type == "array") and
    all(.labels[]; type == "object" and (.name | type == "string")) and
    (.closingIssuesReferences | type == "array") and
    all(.closingIssuesReferences[]; type == "object" and
      (.number | type == "number" and . > 0 and floor == .) and
      (.url | type == "string")))' <<< "$metadata" > /dev/null; then
  emit_result false false false 'フォローアップに必要なメタデータが不正なため、処理をスキップします。'
  exit 0
fi
author_login="$(jq -r '.author.login' <<< "$metadata")"

normal_followup_reason() {
  printf '%s\n' 'Codexの自動フォローアップは入口条件を満たしました。信頼済みの処理が正常終了すると、PRをReady for reviewにして再レビューを依頼します。'
}

human_decision_pause_reason() {
  printf '%s\n' 'Codexフォローアップを停止しました。人間が次の対応を判断してください。'
}

if [ "$author_login" != "$developer_app_slug" ] \
    && [ "$author_login" != "${developer_app_slug}[bot]" ] \
    && [ "$author_login" != "app/${developer_app_slug}" ]; then
  emit_result false false false "PRの作成者を信頼できないため、自動フォローアップをスキップします: ${author_login}"
  exit 0
fi

pr_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$metadata")"
if [ "$pr_paused" = true ]; then
  emit_result false false false 'human-review-requiredラベルによりCodexフォローアップは停止中です。'
  exit 0
fi

issue_prefix="https://github.com/${repo}/issues/"
if ! closing_issues="$(jq -r --arg prefix "$issue_prefix" \
    '.closingIssuesReferences[] | select(.url | startswith($prefix)) | .number' \
    <<< "$metadata")"; then
  emit_result false false false 'closing Issueのメタデータを取得できなかったため、処理をスキップします。'
  exit 0
fi
while IFS= read -r issue_number; do
  [ -n "$issue_number" ] || continue
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    emit_result false false false "Closing Issue #${issue_number} を取得できなかったため、処理をスキップします。"
    exit 0
  fi
  if ! jq -es 'length == 1 and (.[0] | type == "object" and
      (.labels | type == "array") and
      all(.labels[]; type == "object" and (.name | type == "string")))' \
      <<< "$issue_json" > /dev/null; then
    emit_result false false false "Closing Issue #${issue_number} のメタデータが不正なため、処理をスキップします。"
    exit 0
  fi
  issue_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$issue_json")"
  if [ "$issue_paused" = true ]; then
    emit_result false false false "Issueのhuman-review-requiredラベルによりCodexフォローアップは停止中です: Issue #${issue_number}。"
    exit 0
  fi
done <<< "$closing_issues"

review_count="$(
  jq --arg slug "$reviewer_app_slug" \
    '[.reviews[]? | select((.author.login == $slug or .author.login == ($slug + "[bot]") or .author.login == ("app/" + $slug)) and .state == "CHANGES_REQUESTED")] | length' \
    <<< "$metadata"
)"

if ! grep -Fxq -- '--- BEGIN REVIEW SUMMARY DATA ---' <<< "$review_body" \
    || ! grep -Fxq -- '--- END REVIEW SUMMARY DATA ---' <<< "$review_body"; then
  emit_result false true false "信頼済みレビュアーの要約を解析できなかったため、自動フォローアップを停止します。 $(human_decision_pause_reason)"
  exit 0
fi
review_summary="$(
  sed -n '/^--- BEGIN REVIEW SUMMARY DATA ---$/,/^--- END REVIEW SUMMARY DATA ---$/{
    /^SUMMARY| /{s/^SUMMARY| //; p;}
  }' <<< "$review_body"
)"
human_escalation=false
while IFS= read -r summary_line || [ -n "$summary_line" ]; do
  summary_line="${summary_line%$'\r'}"
  case "$summary_line" in
    '[REQUIREMENTS_CHANGE_REQUIRED]'|'[HUMAN_ESCALATION_RECOMMENDED]')
      human_escalation=true
      break
      ;;
  esac
done <<< "$review_summary"

if [ "$human_escalation" = true ]; then
  emit_result false true false "Claudeが人間の判断を求めています。 $(human_decision_pause_reason)"
elif [ "$review_count" -ge 3 ]; then
  emit_result false true true "自動レビューが${review_count}回の変更要求に達しました。 $(human_decision_pause_reason)"
else
  emit_result true false false "$(normal_followup_reason)"
fi
