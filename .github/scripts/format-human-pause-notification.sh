#!/usr/bin/env bash
set -euo pipefail

# Presentation only. The reason code, never the human detail, selects the text.
reason="${1:?reason code is required}"
target="${2:?target is required}"
detail="${3:?decision detail is required}"
url="${4:?GitHub URL is required}"
pause_id="${5:?pause ID is required}"

case "$reason" in
  requirements_change) reason_text='要求の変更が必要'; action='要求または上流の判断をIssueに記録してください。' ;;
  scope_decision) reason_text='スコープの判断が必要'; action='対象範囲をIssueに記録してください。' ;;
  diff_guard_exceeded) reason_text='差分の上限を超過'; action='変更の分割または範囲を判断してください。' ;;
  diff_guard_error) reason_text='差分の検証に失敗'; action='差分と検証結果を確認してください。' ;;
  non_blocking_decision) reason_text='指摘事項の判断が必要'; action='指摘事項への対応を判断してください。' ;;
  round_limit) reason_text='自動修正の回数上限に到達'; action='レビュー履歴を確認し、次の対応を判断してください。' ;;
  validation_failed) reason_text='検証に失敗'; action='失敗した検証を確認してください。' ;;
  validation_timeout) reason_text='検証が時間切れ'; action='検証状況を確認してください。' ;;
  claude_execution_failed) reason_text='Claudeレビューの実行に失敗'; action='実行結果を確認し、再実行を判断してください。' ;;
  developer_execution_failed) reason_text='開発処理の実行に失敗'; action='実行結果を確認し、再実行を判断してください。' ;;
  explicit_human_escalation) reason_text='人間による判断が必要'; action='停止理由を確認し、判断を記録してください。' ;;
  review_disagreement_decision) reason_text='レビュー判断の不一致'; action='レビュー内容を確認し、採用する判断を記録してください。' ;;
  resume_transition_failed) reason_text='再開処理に失敗'; action='再開状態を確認してから対応を判断してください。' ;;
  state_inconsistent) reason_text='停止状態に不整合'; action='Issue・PRの記録とラベルを確認してください。' ;;
  *) echo 'Unknown human pause reason code.' >&2; exit 1 ;;
esac

[[ "$target" =~ ^(issue|pr):[1-9][0-9]*$ ]] || exit 1
[[ "$pause_id" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ "$url" =~ ^https://github\.com/[^/]+/[^/]+/(issues|pull)/[1-9][0-9]*$ ]] || exit 1
printf '人間の確認が必要です。\n対象: %s\n停止理由: %s (%s)\n判断が必要な内容: %s\n次の対応: %s\nGitHub: %s\npause_id: %s\n' \
  "$target" "$reason_text" "$reason" "$detail" "$action" "$url" "$pause_id"
