#!/usr/bin/env bash
set -euo pipefail

# Decomposes the structurally validated graph emitted by
# validate-human-pause-record-graph.sh into deterministic causal chains.  It
# deliberately does not derive lifecycle status, effective reason, or active
# pause.  stdin and stdout make it directly composable with that validator.

fail_closed() {
  echo "decompose-human-pause-record-graph: $1" >&2
  exit 1
}

input="$(cat)" || fail_closed 'could not read input'

# The listing and graph-validation helpers own trust, schema, target, and
# graph validation.  This boundary checks only enough envelope and edge shape
# to fail closed rather than emit a partial or ambiguous decomposition.
jq -ce '
  def valid_envelope:
    type == "object"
    and (.target | type == "string")
    and (.records | type == "array")
    and all(.records[];
      type == "object"
      and (.pause_id | type == "string" and test("^[1-9][0-9]*$"))
      and (.record | type == "object")
      and ((.record | has("source_pause_id") | not)
        or (.record.source_pause_id | type == "string"))
    );
  def follow($entries; $successors; $pause_id):
    [$entries[$pause_id]]
    + if $successors[$pause_id] == null then []
      else follow($entries; $successors; $successors[$pause_id])
      end;
  . as $graph
  | [inputs] as $additional_values
  | if $additional_values != [] then
      error("expected one JSON value")
    elif valid_envelope | not then
      error("record graph envelope is invalid")
    else
      .records as $records
      | [$records[].pause_id] as $ids
      | (reduce $records[] as $entry ({};
          .[$entry.pause_id] = $entry
        )) as $entries
      | (reduce $records[] as $entry ({};
          if $entry.record | has("source_pause_id") then
            .[$entry.record.source_pause_id] = $entry.pause_id
          else .
          end
        )) as $successors
      | [$records[] | select(.record | has("source_pause_id") | not)]
        | sort_by([(.pause_id | length), .pause_id]) as $roots
      | if (($ids | length) != ($ids | unique | length))
        or any($records[];
          (.record.source_pause_id? // null) as $source
          | $source != null and ($ids | index($source)) == null
        )
        or ([ $records[]
              | .record.source_pause_id? // empty
              | select(. != null) ]
            | group_by(.) | any(.[]; length != 1))
        then error("record graph cannot be uniquely decomposed")
        else
          ($roots | map({records: follow($entries; $successors; .pause_id)}))
            as $chains
          | [$chains[].records[]] as $decomposed
          | if ($decomposed | length) != ($records | length)
            or ([$decomposed[].pause_id] | sort) != ($ids | sort)
            then error("record graph cannot be fully decomposed")
            else {target: $graph.target, chains: $chains}
            end
        end
    end
' <<< "$input" || fail_closed 'record graph cannot be uniquely decomposed'
