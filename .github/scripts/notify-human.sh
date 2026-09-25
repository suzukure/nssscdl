#!/usr/bin/env bash
set -euo pipefail

message="${1:?notification message is required}"

if [ -z "${NOTIFICATION_WEBHOOK_URL:-}" ]; then
  echo 'NOTIFICATION_WEBHOOK_URL is not configured; GitHub escalation remains active.' >&2
  exit 0
fi

# Discord content is bounded even for callers outside the pause formatter.
[ "$(LC_ALL=C printf '%s' "$message" | wc -c)" -le 1800 ] || {
  echo 'Notification content exceeds 1800 bytes.' >&2
  exit 1
}

jq -n --arg content "$message" '{content: $content, allowed_mentions: {parse: []}}' \
  | curl --fail-with-body --silent --show-error \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      "$NOTIFICATION_WEBHOOK_URL"
