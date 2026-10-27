#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$root/inspect-ai-handoff-ownership.sh"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
sha="$(printf 'a%.0s' {1..40})"
create_comment() {
  local id="$1" app_id="$2" record="$3"
  local body
  body="$(bash "$root/human-pause-record.sh" create "$record")"
  jq -cn --argjson id "$id" --argjson app_id "$app_id" --arg body "$body" \
    '{id:$id,performed_via_github_app:{id:$app_id},body:$body,created_at:"2026-10-21T00:00:00Z",updated_at:"2026-10-21T00:00:00Z"}'
}
pause='{"version":1,"kind":"pause","target":"issue:278","reason":"developer_execution_failed","payload":{"failed_action":"develop"}}'
accepted="$(jq -cn --arg sha "$sha" '{version:1,kind:"ai-resume-accepted",target:"issue:278",
  reason:"developer_execution_failed",source_pause_id:"101",
  payload:{action:"handoff",actor:"suzukure",pr_number:500,pr_head:$sha}}')"
pause_comment="$(create_comment 101 42 "$pause")"
accepted_comment="$(create_comment 102 42 "$accepted")"
export MOCK_COMMENTS="$work/comments.json"
gh() {
  if [ "$1" != api ]; then return 96; fi
  if [ "$2" != --paginate ] || [ "$3" != --slurp ]; then return 96; fi
  local comment_source="$MOCK_COMMENTS"
  if [ -n "${MOCK_SECOND_COMMENTS:-}" ]; then
    if [ -e "$MOCK_GH_MARKER" ]; then
      comment_source="$MOCK_SECOND_COMMENTS"
    else
      : > "$MOCK_GH_MARKER"
    fi
  fi
  jq -cn --slurpfile comments "$comment_source" '[$comments[0]]'
}
export -f gh
printf '[%s]\n' "$pause_comment" > "$MOCK_COMMENTS"
answer="$(bash "$helper" suzukure/nssscdl 278 42)"
jq -e '. == {result:"no_handoff_record",deny_develop:false}' <<< "$answer" >/dev/null
printf '[%s,%s]\n' "$pause_comment" "$accepted_comment" > "$MOCK_COMMENTS"
answer="$(bash "$helper" suzukure/nssscdl 278 42)"
jq -e --arg sha "$sha" '. == {result:"handoff_owned",deny_develop:true,
  source_pause_id:"101",accepted_record_id:"102",pr_number:500,pr_head:$sha}' <<< "$answer" >/dev/null
reject() { if bash "$helper" suzukure/nssscdl 278 42 > /dev/null 2>&1; then echo "incorrectly accepted $1" >&2; exit 1; fi; }
# App provenance and record-shape are checked in the trusted listing helper.
printf '[%s,%s]\n' "$pause_comment" "$(create_comment 102 42 "$(jq -c '.payload.pr_head = "wrong"' <<< "$accepted")")" > "$MOCK_COMMENTS"
reject malformed-head
printf '[%s,%s,%s]\n' "$pause_comment" "$accepted_comment" "$(create_comment 103 42 "$accepted")" > "$MOCK_COMMENTS"
reject duplicate-accepted
printf '[%s,%s]\n' "$pause_comment" "$(create_comment 102 42 "$(jq -c '.source_pause_id = "999"' <<< "$accepted")")" > "$MOCK_COMMENTS"
reject missing-source
# An acceptance that the generic record schema allows may have an unknown or
# absent action; it must never silently become "no_handoff_record".
for broken in missing unknown; do
  if [ "$broken" = missing ]; then
    invalid="$(jq -c 'del(.payload.action)' <<< "$accepted")"
  else
    invalid="$(jq -c '.payload.action="unknown"' <<< "$accepted")"
  fi
  printf '[%s,%s]\n' "$pause_comment" "$(create_comment 102 42 "$invalid")" > "$MOCK_COMMENTS"
  reject "trusted-accepted-action-$broken"
done
# Existing recognized non-handoff acceptances remain distinguishable.
normal="$(jq -c '.payload={action:"develop",actor:"suzukure"}' <<< "$accepted")"
printf '[%s,%s]\n' "$pause_comment" "$(create_comment 102 42 "$normal")" > "$MOCK_COMMENTS"
answer="$(bash "$helper" suzukure/nssscdl 278 42)"
jq -e '.result == "no_handoff_record" and .deny_develop == false' <<< "$answer" > /dev/null
# A trusted App comment with record markers can be silently dropped by the
# generic list helper if its schema is invalid. The inspector must detect it.
malformed_body='<!-- ai-human-pause-record:start -->
{"version":1,"kind":"ai-resume-accepted","target":"issue:278","unknown":true}
<!-- ai-human-pause-record:end -->'
malformed_comment="$(jq -cn --arg body "$malformed_body" '{id:102,performed_via_github_app:{id:42},body:$body,created_at:"2026-10-21T00:00:00Z",updated_at:"2026-10-21T00:00:00Z"}')"
printf '[%s,%s]\n' "$pause_comment" "$malformed_comment" > "$MOCK_COMMENTS"
reject malformed-trusted-app-comment
# An edit between the trusted listing and the second raw read must be refused,
# even if the GitHub comment identifier stays unchanged.
printf '[%s,%s]\n' "$pause_comment" "$accepted_comment" > "$MOCK_COMMENTS"
MOCK_SECOND_COMMENTS="$work/changed-raw.json"
MOCK_GH_MARKER="$work/first-read.marker"
export MOCK_SECOND_COMMENTS MOCK_GH_MARKER
mutated="$(jq -c '.payload.actor="different"' <<< "$accepted")"
printf '[%s,%s]\n' "$pause_comment" "$(create_comment 102 42 "$mutated")" > "$MOCK_SECOND_COMMENTS"
reject edited-trusted-record-between-reads
unset MOCK_SECOND_COMMENTS MOCK_GH_MARKER
# T1: edits made *before both reads* must be refused, even if both
# snapshots are identical. The listing alone does not check timestamps.
for edited in accepted pause; do
  if [ "$edited" = accepted ]; then
    bad="$(jq -c '.updated_at="2026-10-22T00:00:00Z"' <<< "$accepted_comment")"
    printf '[%s,%s]\n' "$pause_comment" "$bad" > "$MOCK_COMMENTS"
  else
    bad="$(jq -c '.updated_at="2026-10-22T00:00:00Z"' <<< "$pause_comment")"
    printf '[%s,%s]\n' "$bad" "$accepted_comment" > "$MOCK_COMMENTS"
  fi
  reject "edited-before-both-reads-$edited"
done
# If all record markers were removed by editing, the edited trusted App
# comment must still be detected; selecting record candidates first fails.
stripped="$(jq -c '.body="ordinary note" | .updated_at="2026-10-22T00:00:00Z"' <<< "$accepted_comment")"
printf '[%s,%s]\n' "$pause_comment" "$stripped" > "$MOCK_COMMENTS"
reject edited-record-markers-stripped
for bad_field in \
  'del(.created_at)' \
  'del(.updated_at)' \
  '.created_at=42' \
  '.updated_at=null' \
  '.created_at=""'; do
  bad="$(jq -c "$bad_field" <<< "$accepted_comment")"
  printf '[%s,%s]\n' "$pause_comment" "$bad" > "$MOCK_COMMENTS"
  reject "trusted-record-timestamp-$bad_field"
done
# Unedited plain App prose is fine: it is not a handoff record.
plain="$(jq -c '.body="ordinary note"' <<< "$accepted_comment")"
printf '[%s,%s]\n' "$pause_comment" "$plain" > "$MOCK_COMMENTS"
answer="$(bash "$helper" suzukure/nssscdl 278 42)"
jq -e '. == {result:"no_handoff_record",deny_develop:false}' <<< "$answer" >/dev/null
# Rejected schema-valid record with misleading handoff PR fields.
spoof="$(jq -c '.payload.action="develop"' <<< "$accepted")"
printf '[%s,%s]\n' "$pause_comment" "$(create_comment 102 42 "$spoof")" > "$MOCK_COMMENTS"
reject disguised-handoff-fields
# A forged bot name is not sufficient: app-id mismatch excludes the record.
printf '[%s,%s]\n' "$pause_comment" "$(create_comment 102 99 "$accepted")" > "$MOCK_COMMENTS"
answer="$(bash "$helper" suzukure/nssscdl 278 42)"
jq -e '.result == "no_handoff_record" and (.deny_develop | not)' <<< "$answer" >/dev/null
if bash "$helper" other/repo 278 42 > /dev/null 2>&1; then exit 1; fi
if bash "$helper" suzukure/nssscdl 0278 42 > /dev/null 2>&1; then exit 1; fi
echo 'inspect-ai-handoff-ownership tests passed.'
