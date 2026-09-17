#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
producer="$repo_root/.github/scripts/reconcile-human-pause-resume-acceptance.sh"
consumer="$repo_root/.github/scripts/reconcile-human-pause-active-pause.sh"

input="$(jq -cn '
  {
    target: "issue:289",
    chains: [
      {
        records: [
          {pause_id: "101", record: {kind: "pause", reason: "requirements_change"}},
          {pause_id: "102", record: {kind: "ai-resume-accepted", reason: "requirements_change", source_pause_id: "101"}}
        ],
        pre_resume: {status: "active", pause_id: "101", reason: "requirements_change"}
      },
      {
        records: [
          {pause_id: "201", record: {kind: "pause", reason: "validation_failed"}}
        ],
        pre_resume: {status: "active", pause_id: "201", reason: "validation_failed"}
      }
    ]
  }
')"

output="$(printf '%s\n' "$input" | bash "$producer" | bash "$consumer")"
expected='{"target":"issue:289","result":"active","active_pause":{"pause_id":"201","reason":"validation_failed"}}'

jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
  || { echo 'Expected producer stdout to be accepted directly by the active-pause consumer.' >&2; exit 1; }

echo 'reconcile-human-pause resume-acceptance to active-pause pipeline tests passed.'
