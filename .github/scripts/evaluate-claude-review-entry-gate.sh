#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
reviewed_head="${3:?reviewed head SHA is required}"
event_action="${4:-}"
event_machine_state="${5:-false}"
[[ "$reviewed_head" =~ ^[0-9a-f]{40}$ ]] || { echo 'レビュー対象HEAD SHAが不正なため、Claudeレビューを停止します。' >&2; exit 1; }
[[ "$event_machine_state" = true || "$event_machine_state" = false ]] || { echo 'eventのmachine-state情報が不正なため、Claudeレビューを停止します。' >&2; exit 1; }

if ! metadata="$(gh pr view "$pr_number" --repo "$repo" --json number,state,isDraft,headRefOid,labels,closingIssuesReferences)"; then
  echo '現在のPRメタデータを取得できないため、Claudeレビューを停止します。' >&2
  exit 1
fi

emit_result() {
  jq -cn --argjson continue "$1" --arg reason "$2" \
    '{continue: $continue, reason: $reason}'
}

if ! pr_state="$(jq -er '.state | select(type == "string")' <<< "$metadata")"; then
  echo 'PR状態を確認できないため、Claudeレビューを停止します。' >&2
  exit 1
fi
case "$pr_state" in
  OPEN)
    ;;
  CLOSED|MERGED)
    emit_result false "PR状態が${pr_state}のため、Claudeレビューを実行しません。"
    exit 0
    ;;
  *)
    echo "未対応のPR状態${pr_state}のため、Claudeレビューを停止します。" >&2
    exit 1
    ;;
esac

if ! jq -es 'length == 1 and (.[0] | type == "object" and
    (.number | type == "number" and . > 0 and floor == .) and
    (.isDraft | type == "boolean") and
    (.headRefOid | type == "string" and test("^[0-9a-f]{40}$")) and
    (.labels | type == "array") and
    all(.labels[]; type == "object" and (.name | type == "string")) and
    (.closingIssuesReferences | type == "array") and
    all(.closingIssuesReferences[]; type == "object" and
      (.number | type == "number" and . > 0 and floor == .) and
      (.url | type == "string")))' <<< "$metadata" > /dev/null; then
  echo 'PRメタデータが不正なため、Claudeレビューを停止します。' >&2
  exit 1
fi
if [ "$(jq -r .number <<< "$metadata")" != "$pr_number" ]; then
  echo 'PR番号が一致しないため、Claudeレビューを停止します。' >&2
  exit 1
fi
if [ "$(jq -r .isDraft <<< "$metadata")" = true ]; then
  emit_result false 'Draft PRのため、Claudeレビューを実行しません。'
  exit 0
fi
if [ "$(jq -r .headRefOid <<< "$metadata")" != "$reviewed_head" ]; then
  emit_result false '現在のPR HEADがreview対象eventのHEADと異なるため、Claudeレビューを実行しません。'
  exit 0
fi

pr_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$metadata")"
if [ "$pr_paused" = true ]; then
  emit_result false 'PRにhuman-review-requiredラベルがあるため、Claudeレビューを停止しています。'
  exit 0
fi
if [ "$event_machine_state" = true ] ||
  [ "$(jq -r '.labels | any(.name == "ai-followup-in-progress")' <<< "$metadata")" = true ]; then
  emit_result false 'machine-state PRのため、通常のClaudeレビューを実行しません。'
  exit 0
fi

issue_prefix="https://github.com/${repo}/issues/"
if ! closing_issues="$(jq -r --arg prefix "$issue_prefix" \
    '.closingIssuesReferences[] | select(.url | startswith($prefix)) | .number' \
    <<< "$metadata")"; then
  echo 'closing Issueを抽出できないため、Claudeレビューを停止します。' >&2
  exit 1
fi
if [ -z "$closing_issues" ]; then
  echo '同じリポジトリのclosing Issueがないため、Claudeレビューを停止します。' >&2
  exit 1
fi

while IFS= read -r issue_number; do
  [ -n "$issue_number" ] || continue
  if ! issue_json="$(gh api "repos/${repo}/issues/${issue_number}")"; then
    echo "closing Issue #${issue_number}を取得できないため、Claudeレビューを停止します。" >&2
    exit 1
  fi
  if ! jq -es 'length == 1 and (.[0] | type == "object" and
      (.labels | type == "array") and
      all(.labels[]; type == "object" and (.name | type == "string")))' \
      <<< "$issue_json" > /dev/null; then
    echo "closing Issue #${issue_number}のラベル情報が不正なため、Claudeレビューを停止します。" >&2
    exit 1
  fi
  issue_paused="$(jq -r '.labels | any(.name == "human-review-required")' <<< "$issue_json")"
  if [ "$issue_paused" = true ]; then
    emit_result false "Issue #${issue_number}にhuman-review-requiredラベルがあるため、Claudeレビューを停止しています。"
    exit 0
  fi
done <<< "$closing_issues"

emit_result true ''
