#!/usr/bin/env bash
set -euo pipefail

final_response="${1:?Codex final response path is required}"

# Dormant primitive (#721): no production caller. Preserve exact line matching
# and CRLF normalization; ignore Markdown fenced code without trimming markers.
awk '
  {
    line = $0
    sub(/\r$/, "", line)
    fence_line = line
    sub(/^ ? ? ?/, "", fence_line)
    if (match(fence_line, /^```+|^~~~+/)) {
      delimiter = substr(fence_line, 1, RLENGTH)
      tail = substr(fence_line, RLENGTH + 1)
      if (fence_char != "") {
        if (substr(delimiter, 1, 1) == fence_char &&
            length(delimiter) >= fence_length && tail ~ /^[ \t]*$/)
          fence_char = ""
      } else if (substr(delimiter, 1, 1) == "~" || tail !~ /`/) {
        fence_char = substr(delimiter, 1, 1)
        fence_length = length(delimiter)
      }
      next
    }
    if (fence_char == "" && line == "[SCOPE_DECISION_REQUIRED]") found = 1
  }
  END { exit(found ? 0 : 1) }
' "$final_response"
