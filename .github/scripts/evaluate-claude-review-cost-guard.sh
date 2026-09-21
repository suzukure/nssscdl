#!/usr/bin/env bash
set -euo pipefail

runs_file="${1:?workflow runs JSON file is required}"
current_run_id="${2:?current workflow run ID is required}"
repository="${3:?repository is required}"

emit_diagnostic() {
  jq -cn --arg reason "$1" '{result:"diagnostic", reason:$reason}'
}

if ! [[ "$current_run_id" =~ ^[0-9]+$ ]] || [[ ! "$repository" =~ ^[^/]+/[^/]+$ ]]; then
  emit_diagnostic 'current_run_id_invalid'
  exit 0
fi

if ! evaluation="$(jq -ce --argjson current_run_id "$current_run_id" --arg repository "$repository" '
  def valid_run:
    type == "object" and
    (.id | type == "number") and
    (.head_branch | type == "string" and length > 0) and
    (.head_repository | type == "object" and (.full_name | type == "string" and length > 0)) and
    (.status | type == "string") and
    ((.conclusion == null) or (.conclusion | type == "string")) and
    (.created_at | type == "string") and
    (.created_at | fromdateiso8601? != null);
  if type != "object" or (.workflow_runs | type) != "array" then
    {result:"diagnostic", reason:"workflow_runs_invalid"}
  elif any(.workflow_runs[]; valid_run | not) then
    {result:"diagnostic", reason:"workflow_run_metadata_incomplete"}
  else
    (.workflow_runs | map(. + {created_epoch: (.created_at | fromdateiso8601)})) as $runs
    | ($runs | map(select(.id == $current_run_id))) as $current_runs
    | if ($current_runs | length) != 1 then
        {result:"diagnostic", reason:"current_run_not_found"}
      elif $current_runs[0].head_repository.full_name != $repository then
        {result:"ignored", reason:"current_run_head_repository_not_current_repository"}
      else
        $current_runs[0] as $current
        | ($runs
           | map(select(
               .head_repository.full_name == $repository and
               .head_branch == $current.head_branch and
               .created_epoch >= ($current.created_epoch - 900) and
               .created_epoch <= $current.created_epoch
             ))) as $window
        | ($window | map(select(.status != "completed" or .conclusion != "skipped"))) as $paid_capable
        | ($window | map(select(.conclusion == "cancelled"))) as $cancelled
        | {
            result: "no_notify",
            head_branch: $current.head_branch,
            run_count: ($paid_capable | length),
            cancelled_count: ($cancelled | length),
            trigger: null
          }
        | if ($current.status == "in_progress" and ($paid_capable | length) == 4) then
            .result = "notify" | .trigger = "review_burst"
          elif ($current.status == "completed" and $current.conclusion == "cancelled" and ($cancelled | length) == 3) then
            .result = "notify" | .trigger = "cancel_storm"
          else . end
      end
  end
' "$runs_file")"; then
  emit_diagnostic 'workflow_run_metadata_unreadable'
  exit 0
fi

printf '%s\n' "$evaluation"
