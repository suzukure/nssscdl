#!/usr/bin/env bash
set -euo pipefail
helper="$(dirname "$0")/submit-claude-review.sh"
work="$(mktemp -d)"
trap 'python3 -c '\''import shutil,sys; shutil.rmtree(sys.argv[1])'\'' "$work"' EXIT
head_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
old_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s\n' '{"verdict":"approve","summary":"ok","blocking_findings":[],"non_blocking_findings":[],"linked_issues_checked":[]}' > "$work/review.json"
export MOCK_HEAD="$old_sha" GH_LOG="$work/gh.log"
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  if [ "$1 $2" = 'api repos/owner/repo/pulls/37' ]; then
    printf '%s\n' "$MOCK_HEAD"
  elif [ "$1 $2 $3" = 'api --method POST' ]; then
    cat >/dev/null
    printf '%s\n' '{}'
  else
    return 2
  fi
}
export -f gh
if bash "$helper" owner/repo 37 "$work/review.json" "$head_sha" > "$work/out" 2>&1; then
  echo 'Stale review was accepted.' >&2
  exit 1
fi
if grep -q -- '--method POST' "$GH_LOG"; then
  echo 'Stale review reached verdict POST.' >&2
  exit 1
fi
MOCK_HEAD="$head_sha" bash "$helper" owner/repo 37 "$work/review.json" "$head_sha" > "$work/out"
grep -q -- '--method POST' "$GH_LOG"
echo 'Claude verdict current-head tests passed.'
