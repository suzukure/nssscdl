#!/usr/bin/env bash
set -euo pipefail

execution_file="${1:?execution file is required}"

jq -ce '
  def token_usage($models; $model_field; $usage_field):
    if ($models | length) > 0 and all($models[]; .[$model_field] | type == "number")
    then ($models | map(.[$model_field]) | add)
    else (.usage[$usage_field] | if type == "number" then . else null end)
    end;
  [.[] | select(type == "object" and .type == "result")] | last as $result
  | if $result == null then error("Claude execution has no result event") else $result end
  | (.modelUsage // {} | to_entries | map(.value)) as $models
  | {
      result_subtype: (.subtype // "unavailable"),
      is_error: (if has("is_error") then .is_error else null end),
      turns: (.num_turns // null),
      duration_ms: (.duration_ms // null),
      estimated_cost_usd: (
        .total_cost_usd
        // (if ($models | length) > 0 then ($models | map(.costUSD // 0) | add) else null end)
      ),
      input_tokens: token_usage($models; "inputTokens"; "input_tokens"),
      output_tokens: token_usage($models; "outputTokens"; "output_tokens"),
      cache_creation_input_tokens: token_usage($models; "cacheCreationInputTokens"; "cache_creation_input_tokens"),
      cache_read_input_tokens: token_usage($models; "cacheReadInputTokens"; "cache_read_input_tokens")
    }
' "$execution_file"
