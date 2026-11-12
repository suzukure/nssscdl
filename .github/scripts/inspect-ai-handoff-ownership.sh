#!/usr/bin/env bash
set -euo pipefail

# #1097 PREPARED ONLY. This read-only inspector is not connected to the
# production Issue entry gate until #1098.  Trusted App provenance comes
# from list-human-pause-records.sh, not from a caller-supplied boolean.
fail_closed() { echo "inspect-ai-handoff-ownership: $1" >&2; exit 1; }
[ "$#" -eq 3 ] || fail_closed 'usage: <repo> <issue-number> <trusted-app-id>'
repo="$1"; issue="$2"; app="$3"
[ "$repo" = 'suzukure/nssscdl' ] || fail_closed 'repository mismatch'
[[ "$issue" =~ ^[1-9][0-9]*$ && "$app" =~ ^[1-9][0-9]*$ ]] \
  || fail_closed 'invalid Issue or App ID'
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)" || fail_closed 'scratch unavailable'
trap 'rm -rf "$work"' EXIT

bash "$root/list-human-pause-records.sh" "$repo" "$issue" - "$app" > "$work/list.json" \
  || fail_closed 'trusted source unavailable'
# The generic listing deliberately skips schema-invalid App comments.  That
# is appropriate for normal history enumeration, but *not* sufficient proof
# that the handoff ownership gate can safely report "no handoff". Reconcile
# all record-bearing trusted App comments with the listing before deciding.
# The second read must match the first read; new/interleaved comments fail
# closed and are not silently interpreted as an absence of ownership.
gh api --paginate --slurp -H 'Accept: application/vnd.github+json' \
  "/repos/$repo/issues/$issue/comments" > "$work/raw-comments.json" \
  || fail_closed 'trusted raw Conversation unavailable'
jq -ces --arg app "$app" '
  def record_candidate:
    (.body | type) == "string" and
    ((.body | contains("<!-- ai-human-pause-record:start -->")) or
     (.body | contains("<!-- ai-human-pause-record:end -->")) or
     (.body | contains("ai-resume-accepted")));
  if length != 1 or (.[0] | type) != "array"
     or ([.[0][] | type == "array"] | all | not)
     or ([.[0][][] | type == "object"] | all | not)
  then error("invalid trusted Conversation snapshot") end
  | [.[0][][]
      | select((.performed_via_github_app.id | tostring) == $app)
      # Require unedited, timestamped *all* trusted App comments here, before
      # record_candidate selection: an edited record can have its markers
      # removed altogether. Two consistent reads alone cannot detect edits
      # made before both reads. This is stricter than generic enumeration.
      | if ((.created_at | type) != "string"
            or (.updated_at | type) != "string"
            or .created_at == ""
            or .created_at != .updated_at)
        then error("trusted App comment edited or timestamp unavailable")
        else . end
      | select(record_candidate)
      | if (.id | type) != "number" or .id < 1 or (.id | floor) != .id
        then error("bad trusted comment identity")
        else {pause_id:(.id | tostring), body:.body} end
    ]
' "$work/raw-comments.json" > "$work/raw-candidates.json" \
  || fail_closed 'trusted raw Conversation is invalid'
: > "$work/raw-parsed.jsonl"
while IFS= read -r candidate; do
  comment_id="$(jq -er '.pause_id' <<< "$candidate")" || fail_closed 'bad trusted ID'
  jq -er '.body' <<< "$candidate" > "$work/raw-record.md" \
    || fail_closed 'trusted body unavailable'
  parsed="$(bash "$root/human-pause-record.sh" parse "$work/raw-record.md")" \
    || fail_closed 'malformed trusted App record must not be ignored'
  jq -cn --arg pause_id "$comment_id" --argjson record "$parsed" \
    '{pause_id:$pause_id,record:$record}' >> "$work/raw-parsed.jsonl" \
    || fail_closed 'trusted record canonicalization failed'
done < <(jq -c '.[]' "$work/raw-candidates.json")
# Compare *contents*, not just IDs: GitHub comments may be edited between the
# two snapshots. Any changed accepted action or record body fails closed.
jq -es --arg issue "$issue" --slurpfile list "$work/list.json" '
  if ($list | length) != 1
     or $list[0].target != ("issue:" + $issue)
     or ($list[0].records | type) != "array"
  then error("trusted listing malformed") end
  | if (sort_by(.pause_id) == ($list[0].records | sort_by(.pause_id)))
    then true else error("trusted records incomplete or changed") end
' "$work/raw-parsed.jsonl" > /dev/null \
  || fail_closed 'trusted record listing is incomplete or changed'

for stage in validate-human-pause-record-graph decompose-human-pause-record-graph \
             derive-human-pause-pre-resume-state reconcile-human-pause-resume-acceptance \
             reconcile-human-pause-active-pause; do
  if [ "$stage" = validate-human-pause-record-graph ]; then
    cp "$work/list.json" "$work/current.json"
  fi
  bash "$root/$stage.sh" < "$work/current.json" > "$work/next.json" \
    || fail_closed "trusted graph invalid at $stage"
  mv "$work/next.json" "$work/current.json"
done

jq -e ' .result != "state_inconsistent"' "$work/current.json" > /dev/null \
  || fail_closed 'ambiguous active pause state'

jq -cse --arg issue "$issue" '
  def sha: type == "string" and test("^[0-9a-f]{40}$");
  def exact($expected): (type == "object") and ((. | keys) == ($expected | sort));
  if length != 1 then error("bad trusted listing") else .[0] end
  | . as $v
  | if $v.target != ("issue:" + $issue)
       or ($v.records | type) != "array" then error("wrong source") end
  # A schema-valid accepted record may still lack payload.action: the generic
  # record validator does not enforce action.  Never treat an unknown or
  # malformed trusted acceptance as evidence that handoff ownership is absent.
  | [$v.records[] | select(.record.kind == "ai-resume-accepted")] as $accepted_all
  | if any($accepted_all[];
      (.record.payload.action | type) != "string"
      or ((.record.payload.action | IN("develop","validate","review","fix",
                                     "follow-up","no-action","handoff")) | not)
      or (.record.payload.action != "handoff" and
           ((.record.payload | has("pr_head")) or (.record.payload | has("pr_number")))))
    then error("unrecognized trusted accepted action") end
  | [$accepted_all[] | select(.record.payload.action == "handoff")] as $matches
  | if ($matches | length) == 0 then
      {result: "no_handoff_record", deny_develop: false}
    elif ($matches | length) != 1 then error("ambiguous handoff")
    else $matches[0] as $accepted
      | [ $v.records[] | select(.pause_id == $accepted.record.source_pause_id) ] as $sources
      | if ($sources | length) != 1
        or $sources[0].record.kind != "pause"
        or $sources[0].record.reason != "developer_execution_failed"
        or $sources[0].record.payload.failed_action != "develop"
        or $accepted.record.reason != "developer_execution_failed"
        or $accepted.record.target != $v.target
        or ($accepted.record.payload | exact(["action","actor","pr_head","pr_number"]) | not)
        or ($accepted.record.payload.actor | type != "string")
        or ($accepted.record.payload.actor | test("^[A-Za-z0-9][A-Za-z0-9-]{0,38}$") | not)
        or ($accepted.record.payload.pr_number | type != "number")
        or ($accepted.record.payload.pr_number < 1)
        or ($accepted.record.payload.pr_number | floor) != $accepted.record.payload.pr_number
        or ($accepted.record.payload.pr_head | sha | not)
        then error("invalid accepted handoff binding") end
      | {result: "handoff_owned", deny_develop: true,
         source_pause_id: $accepted.record.source_pause_id,
         accepted_record_id: $accepted.pause_id,
         pr_number: $accepted.record.payload.pr_number,
         pr_head: $accepted.record.payload.pr_head}
    end
' "$work/list.json" || fail_closed 'handoff evidence invalid; caller must fail closed'
