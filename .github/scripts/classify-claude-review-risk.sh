#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository is required}"
pr_number="${2:?pull request number is required}"
mode="${3:-risk}"

changed_paths="$(gh pr diff "$pr_number" --repo "$repo" --name-only)"
protected_paths="$(
  grep -E '(^|/)(AGENTS\.md|AGENTS\.override\.md|CLAUDE\.md|CLAUDE\.local\.md|CODEOWNERS|\.mcp\.json)$|(^|/)\.(claude|codex|github)(/|$)' \
    <<< "$changed_paths" \
    || true
)"

case "$mode" in
  risk)
    if [ -n "$protected_paths" ]; then
      echo high
    else
      echo standard
    fi
    ;;
  list)
    printf '%s\n' "$protected_paths"
    ;;
  *)
    echo "Unsupported classification mode: ${mode}" >&2
    exit 1
    ;;
esac
