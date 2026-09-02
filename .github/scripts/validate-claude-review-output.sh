#!/usr/bin/env bash
set -euo pipefail

review_json="${1-}"

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
