#!/usr/bin/env bash
set -euo pipefail

review_json="${1-}"

if [ "$review_json" = '--execution-file' ]; then
  execution_file="${2:?execution file is required}"
  review_json="$(jq -er '
    [
      .[]
      | select(
          .type == "result" and
          .subtype == "success" and
          .is_error == false and
          (.result | type == "string")
        )
    ]
    | if length == 1 then .[0].result else error("expected exactly one successful result") end
  ' "$execution_file")"
fi

jq -ce '
if type == "object" and
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
then .
else error("Claude review does not match the required schema")
end
' <<< "$review_json"
