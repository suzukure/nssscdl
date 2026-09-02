#!/usr/bin/env bash
set -euo pipefail

final_response="${1:?Codex final response path is required}"

grep -Fxq -- '[REQUIREMENTS_CHANGE_REQUIRED]' "$final_response"
