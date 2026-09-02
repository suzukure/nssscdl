#!/usr/bin/env bash
set -euo pipefail

execution_file="${1:?execution file is required}"

jq -ce '
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
      input_tokens: (
        if ($models | length) > 0
        then ($models | map(.inputTokens // 0) | add)
        else (.usage.input_tokens // null)
        end
      ),
      output_tokens: (
        if ($models | length) > 0
        then ($models | map(.outputTokens // 0) | add)
        else (.usage.output_tokens // null)
        end
      ),
      cache_creation_input_tokens: (
        if ($models | length) > 0
        then ($models | map(.cacheCreationInputTokens // 0) | add)
        else (.usage.cache_creation_input_tokens // null)
        end
      ),
      cache_read_input_tokens: (
        if ($models | length) > 0
        then ($models | map(.cacheReadInputTokens // 0) | add)
        else (.usage.cache_read_input_tokens // null)
        end
      )
    }
' "$execution_file"
