#!/usr/bin/env bash
set -euo pipefail

runs_file="${1:?workflow runs JSON file is required}"
current_run_id="${2:?current workflow run ID is required}"
repository="${3:?repository is required}"
activity="${4:?workflow run activity is required}"
current_run_attempt="${5:?current workflow run attempt is required}"

emit_diagnostic() {
  jq -cn --arg reason "$1" '{result:"diagnostic", reason:$reason}'
}

if ! [[ "$current_run_id" =~ ^[0-9]+$ ]] || ! [[ "$current_run_attempt" =~ ^[1-9][0-9]*$ ]] || [[ ! "$repository" =~ ^[^/]+/[^/]+$ ]] || [[ "$activity" != "in_progress" && "$activity" != "completed" ]]; then
  emit_diagnostic 'current_run_id_invalid'
  exit 0
fi

if ! evaluation="$(jq -ce --argjson current_run_id "$current_run_id" --argjson current_run_attempt "$current_run_attempt" --arg repository "$repository" --arg activity "$activity" '
  def valid_run:
    type == "object" and
    (.id | type == "number") and
    (.head_branch | type == "string" and length > 0) and
    (.head_repository | type == "object" and (.full_name | type == "string" and length > 0)) and
    (.status | type == "string") and
    ((.conclusion == null) or (.conclusion | type == "string")) and
    (.run_attempt | type == "number" and . >= 1 and floor == .) and
    (.run_started_at | type == "string") and
    (.run_started_at | fromdateiso8601? != null);
  if type == "object" and (.diagnostic_reason | type == "string" and length > 0) then
    {result:"diagnostic", reason:.diagnostic_reason}
  elif type != "object" or (.workflow_runs | type) != "array" then
    {result:"diagnostic", reason:"workflow_runs_invalid"}
  elif any(.workflow_runs[]; valid_run | not) then
    {result:"diagnostic", reason:"workflow_run_metadata_incomplete"}
  else
    (.workflow_runs
     | unique_by([.id, .run_attempt])
     | map(. + {started_epoch: (.run_started_at | fromdateiso8601)})) as $runs
    | ($runs | map(select(.id == $current_run_id and .run_attempt == $current_run_attempt)) | first) as $current
    | if $current == null then
        {result:"diagnostic", reason:"current_run_not_found"}
      elif $current.head_repository.full_name != $repository then
        {result:"ignored", reason:"current_run_head_repository_not_current_repository"}
      else
        ($runs
         | map(select(
             .head_repository.full_name == $repository and
             .head_branch == $current.head_branch
           ))
         | sort_by([.started_epoch, .id, .run_attempt])) as $series
        | ($series | map([.id, .run_attempt]) | index([$current_run_id, $current_run_attempt])) as $current_index
        | if $current_index == null then
            {result:"diagnostic", reason:"current_run_not_in_monitoring_series"}
          else
            ($series[$current_index - 1] // null) as $previous
        | ($series
           | map(select(
               .started_epoch >= ($current.started_epoch - 900) and
               .started_epoch <= $current.started_epoch
             ))) as $window
        | ($window | map(select(.status != "completed" or .conclusion != "skipped"))) as $paid_capable
        | ($window | map(select(.conclusion == "cancelled"))) as $cancelled
        | (if $previous == null then [] else
             $series
             | map(select(
                 .started_epoch >= ($previous.started_epoch - 900) and
                 .started_epoch <= $previous.started_epoch
               ))
           end) as $previous_window
        | ($previous_window | map(select(.status != "completed" or .conclusion != "skipped")) | length) as $previous_paid_count
        | ($previous_window | map(select(.conclusion == "cancelled")) | length) as $previous_cancelled_count
        | {
            result: "no_notify",
            head_branch: $current.head_branch,
            run_count: ($paid_capable | length),
            cancelled_count: ($cancelled | length),
            trigger: null
          }
        | if ($activity == "in_progress" and ($paid_capable | length) >= 4 and $previous_paid_count < 4) then
            .result = "notify" | .trigger = "review_burst"
          elif ($activity == "completed" and $current.conclusion == "cancelled" and ($cancelled | length) >= 3 and $previous_cancelled_count < 3) then
            .result = "notify" | .trigger = "cancel_storm"
          else . end
          end
      end
  end
' "$runs_file")"; then
  emit_diagnostic 'workflow_run_metadata_unreadable'
  exit 0
fi

printf '%s\n' "$evaluation"
