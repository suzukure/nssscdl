#!/usr/bin/env bash
set -euo pipefail

# Callers pass only the extracted Claude structured summary as plain text.
awk '
  {
    line = $0
    sub(/\r$/, "", line)
    if (line == "[REQUIREMENTS_CHANGE_REQUIRED]") requirements = 1
    if (line == "[HUMAN_ESCALATION_RECOMMENDED]") human = 1
  }
  END {
    if (requirements && human) print "{\"result\":\"state_inconsistent\"}"
    else if (requirements) print "{\"result\":\"pause\",\"reason\":\"requirements_change\"}"
    else if (human) print "{\"result\":\"pause\",\"reason\":\"explicit_human_escalation\"}"
    else print "{\"result\":\"none\"}"
  }
'
