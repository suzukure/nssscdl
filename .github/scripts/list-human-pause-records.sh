#!/usr/bin/env bash
set -euo pipefail

# Lists trusted, schema-valid human-pause records from exactly one GitHub
# Conversation. The REST Issue-comments endpoint is also the PR Conversation
# endpoint, so callers select its number: a PR when one exists, otherwise the
# Issue. Output is one JSON object containing the selected target and records
# in the API response order. This helper deliberately does not reconcile
# lifecycle state or infer an active pause from the number of records.

repo="${1:?repository is required}"
issue_number="${2:?Issue number is required}"
pr_number="${3:--}"
trusted_app_id="${4:?trusted GitHub App ID is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
record_helper="$script_dir/human-pause-record.sh"

fail_closed() {
  echo "list-human-pause-records: $1" >&2
  exit 1
}

is_positive_decimal() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_positive_decimal "$issue_number" || fail_closed 'Issue number must be a positive decimal integer'
is_positive_decimal "$trusted_app_id" || fail_closed 'trusted GitHub App ID must be a positive decimal integer'
if [ "$pr_number" = '-' ]; then
  target="issue:$issue_number"
  conversation_number="$issue_number"
else
  is_positive_decimal "$pr_number" || fail_closed 'PR number must be - or a positive decimal integer'
  target="pr:$pr_number"
  conversation_number="$pr_number"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
comments_json="$tmp_dir/comments.json"
records_jsonl="$tmp_dir/records.jsonl"
# An empty trusted history is a valid result.  Create the JSONL input before
# filtering so jq --slurpfile below consistently produces an empty array.
: > "$records_jsonl"

# --slurp preserves pagination boundaries. The nested arrays are validated
# below before flattening so an unexpected API response cannot become state.
gh api --paginate --slurp -H 'Accept: application/vnd.github+json' \
  "/repos/$repo/issues/$conversation_number/comments" > "$comments_json" \
  || fail_closed 'could not fetch Conversation comments'

jq -e '
  type == "array" and all(.[]; type == "array" and all(.[]; type == "object"))
' "$comments_json" > /dev/null || fail_closed 'comment API response has an unexpected shape'

# The REST fixture/API fields establish both required boundary facts: .id is
# the REST comment identifier, and performed_via_github_app.id is provenance.
# Names, bot flags, and comment prose never participate in the trust decision.
while IFS= read -r comment; do
  comment_id="$(jq -r '.id | tostring' <<< "$comment")"
  comment_body="$(jq -er '.body' <<< "$comment")" || continue
  record_file="$tmp_dir/comment-$comment_id.md"
  printf '%s' "$comment_body" > "$record_file"
  if ! record="$(bash "$record_helper" parse "$record_file" 2>/dev/null)"; then
    continue
  fi
  if [ "$(jq -r '.target' <<< "$record")" != "$target" ]; then
    continue
  fi
  jq -cn --arg pause_id "$comment_id" --argjson record "$record" \
    '{pause_id: $pause_id, record: $record}' >> "$records_jsonl"
done < <(
  jq -c --arg app_id "$trusted_app_id" '
    .[] | .[]
    | select(
        type == "object"
        and (.id | type == "number" and . >= 1 and floor == .)
        and ((.id | tostring) | test("^[1-9][0-9]*$"))
        and (.performed_via_github_app | type == "object")
        and (.performed_via_github_app.id | type == "number" and . >= 1 and floor == .)
        and ((.performed_via_github_app.id | tostring) == $app_id)
      )
  ' "$comments_json"
)

jq -cn --arg target "$target" --slurpfile records "$records_jsonl" \
  '{target: $target, records: $records}'
