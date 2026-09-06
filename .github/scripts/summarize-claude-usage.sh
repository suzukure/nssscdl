#!/usr/bin/env bash
set -euo pipefail

execution_file="${1:?execution file is required}"

jq -ce '
  def object_number($field):
    if (type == "object" and (.[$field] | type == "number")) then .[$field] else null end;
  def top_level_usage($field):
    .usage | object_number($field);
  def token_usage($models; $model_field; $usage_field):
    if ($models | length) > 0 then
      if all($models[]; object_number($model_field) != null)
      then ($models | map(.[$model_field]) | add)
      else null
      end
    else top_level_usage($usage_field)
    end;
  [.[] | select(type == "object" and .type == "result")] | last as $result
  | if $result == null then error("Claude execution has no result event") else $result end
  | (if (.modelUsage | type) == "object" then [.modelUsage[]] else [] end) as $models
  | {
      result_subtype: (.subtype // "unavailable"),
      is_error: (if has("is_error") then .is_error else null end),
      turns: (.num_turns // null),
      duration_ms: (.duration_ms // null),
      estimated_cost_usd: (
        if (.total_cost_usd | type) == "number" then .total_cost_usd
        elif ($models | length) > 0 and all($models[]; object_number("costUSD") != null)
        then ($models | map(.costUSD) | add)
        else null
        end
      ),
      input_tokens: token_usage($models; "inputTokens"; "input_tokens"),
      output_tokens: token_usage($models; "outputTokens"; "output_tokens"),
      cache_creation_input_tokens: token_usage($models; "cacheCreationInputTokens"; "cache_creation_input_tokens"),
      cache_read_input_tokens: token_usage($models; "cacheReadInputTokens"; "cache_read_input_tokens")
    }
' "$execution_file"
