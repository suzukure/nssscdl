#!/usr/bin/env bash
set -euo pipefail

message="${1:?notification message is required}"

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo 'SLACK_WEBHOOK_URL is not configured; GitHub escalation remains active.' >&2
  exit 0
fi

jq -n --arg text "$message" '{text: $text}' \
  | curl --fail-with-body --silent --show-error \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      "$SLACK_WEBHOOK_URL"
