#!/usr/bin/env bash
set -euo pipefail

final_response="${1:?Codex final response path is required}"

# The marker is valid only as an unindented, whitespace-free line.  Normalize
# the CR of a CRLF line terminator so GitHub Action output written on Windows
# remains ordinary plain text; do not otherwise trim or parse Markdown.
awk '
  {
    line = $0
    sub(/\r$/, "", line)
    if (line == "[REQUIREMENTS_CHANGE_REQUIRED]") found = 1
  }
  END { exit(found ? 0 : 1) }
' "$final_response"
