#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

review_json="${1-}"

if [ "$review_json" = '--execution-file' ]; then
  execution_file="${2:?execution file is required}"
  selection="$(jq -c '
    if type != "array" then
      {status: "invalid_json"}
    else
      [
        .[]
        | select(
            type == "object" and
            .type == "result" and
            .subtype == "success" and
            .is_error == false and
            (.result | type == "string")
          )
      ] as $results
      | if ($results | length) == 0 then
          {status: "missing_result"}
        elif ($results | length) > 1 then
          {status: "ambiguous_result"}
        else
          {status: "ok", result: $results[0].result}
        end
    end
  ' "$execution_file" 2> /dev/null)" || fail invalid_json

  case "$(jq -r '.status' <<< "$selection")" in
    ok) review_json="$(jq -r '.result' <<< "$selection")" ;;
    missing_result|ambiguous_result|invalid_json) fail "$(jq -r '.status' <<< "$selection")" ;;
    *) fail invalid_json ;;
  esac
fi

fence_state=outside
fence_count=0
fenced_json=''
while IFS= read -r line || [ -n "$line" ]; do
  normalized_line="${line%$'\r'}"
  if [[ "$normalized_line" =~ ^\`\`\`json[[:blank:]]*$ ]]; then
    [ "$fence_state" = outside ] || fail ambiguous_result
    fence_state=inside
    fence_count=$((fence_count + 1))
  elif [[ "$normalized_line" =~ ^\`\`\`[[:blank:]]*$ ]]; then
    [ "$fence_state" = inside ] || fail invalid_json
    fence_state=closed
  elif [ "$fence_state" = inside ]; then
    fenced_json+="$line"$'\n'
  fi
done <<< "$review_json"

if [ "$fence_count" -gt 0 ]; then
  [ "$fence_count" -eq 1 ] && [ "$fence_state" = closed ] || fail ambiguous_result
  review_json="$fenced_json"
fi

parsed_json="$(printf '%s' "$review_json" | jq -sc '
  if length == 1 then .[0] else error("expected one JSON value") end
' 2> /dev/null)" || fail invalid_json

if ! jq -e '
type == "object" and
  (keys | sort) == [
    "blocking_findings",
    "linked_issues_checked",
    "non_blocking_findings",
    "summary",
    "verdict"
  ] and
  (.verdict == "approve" or .verdict == "request_changes") and
  (.summary | type == "string") and
  (.blocking_findings | type == "array" and all(.[]; type == "string")) and
  (.non_blocking_findings | type == "array" and all(.[]; type == "string")) and
  (.linked_issues_checked | type == "array" and all(.[]; type == "string"))
  ' <<< "$parsed_json" > /dev/null 2> /dev/null; then
  fail schema_mismatch
fi

jq -c . <<< "$parsed_json"
