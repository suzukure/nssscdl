#!/usr/bin/env bash
set -euo pipefail

# Validates only the causal structure of the trusted, schema-valid records
# emitted by list-human-pause-records.sh.  It deliberately does not derive a
# lifecycle status, effective reason, or active pause.  stdin and stdout make
# it directly composable with the listing helper.

fail_closed() {
  echo "validate-human-pause-record-graph: $1" >&2
  exit 1
}

input="$(cat)" || fail_closed 'could not read input'

# The listing helper owns trust, schema, and target validation.  This boundary
# only requires the envelope fields needed to resolve graph edges.  A record
# with no source_pause_id is a root; record order has no meaning here.
jq -e -s '
  def valid_envelope:
    type == "object"
    and (.target | type == "string")
    and (.records | type == "array")
    and all(.records[];
      type == "object"
      and (.pause_id | type == "string")
      and (.record | type == "object")
      and ((.record | has("source_pause_id") | not)
        or (.record.source_pause_id | type == "string"))
    );
  def source_map:
    reduce .records[] as $entry ({};
      .[$entry.pause_id] = ($entry.record.source_pause_id // null)
    );
  def has_cycle($sources):
    def walk($current; $seen):
      if $current == null then false
      elif ($seen | index($current)) != null then true
      else walk($sources[$current] // null; $seen + [$current])
      end;
    any($sources | keys[]; walk(.; []));
  length == 1 and (.[0] |
    ([.records[].pause_id]) as $ids
    | (source_map) as $sources
    | valid_envelope
    and (($ids | length) == ($ids | unique | length))
    and all(.records[];
      (.record.source_pause_id? // null) as $source
      | $source == null or ($ids | index($source)) != null
    )
    and all(.records[];
      (.record.source_pause_id? // null) as $source
      | $source == null or $source != .pause_id
    )
    and ([.records[] | .record.source_pause_id? // empty]
      | group_by(.) | all(length == 1))
    and (has_cycle($sources) | not)
  )
' > /dev/null <<< "$input" || fail_closed 'record graph is structurally invalid'

jq -c -s 'if length == 1 then .[0] else error("expected one JSON value") end' \
  <<< "$input"
