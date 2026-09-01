#!/usr/bin/env bash
set -euo pipefail

message="${1:?notification message is required}"

if [ -z "${NOTIFICATION_WEBHOOK_URL:-}" ]; then
  echo 'NOTIFICATION_WEBHOOK_URL is not configured; GitHub escalation remains active.' >&2
  exit 0
fi

jq -n --arg content "$message" '{content: $content}' \
  | curl --fail-with-body --silent --show-error \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      "$NOTIFICATION_WEBHOOK_URL"
