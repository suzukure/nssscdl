#!/usr/bin/env bash
set -euo pipefail

# Pure classifier (#725), consumed by the Issue-origin post-Codex gate (#731).
# Success: exit 0 and one canonical classification. Any error: exit 2, no stdout.
if [ "$#" -ne 1 ] || [ -z "${1-}" ]; then
  echo 'Codex最終報告の通常ファイルpathを1つ指定してください。' >&2
  exit 2
fi
final_response="$1"
if [ ! -f "$final_response" ] || [ ! -r "$final_response" ]; then
  echo 'Codex最終報告のpathが存在しないか、読取可能な通常ファイルではありません。' >&2
  exit 2
fi
# An absolute operand prevents awk from interpreting relative names as stdin,
# options, or variable assignments. Do not change either primitive's parsing.
if [[ "$final_response" != /* ]]; then
  final_response="$PWD/$final_response"
fi
helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

requirements_status=0
if bash "$helper_dir/has-requirements-change-marker.sh" "$final_response" > /dev/null; then
  requirements_status=0
else
  requirements_status=$?
fi
case "$requirements_status" in
  0|1) ;;
  *) echo 'requirements marker helperの判定に失敗しました。' >&2; exit 2 ;;
esac

scope_status=0
if bash "$helper_dir/has-scope-decision-marker.sh" "$final_response" > /dev/null; then
  scope_status=0
else
  scope_status=$?
fi
case "$scope_status" in
  0|1) ;;
  *) echo 'scope marker helperの判定に失敗しました。' >&2; exit 2 ;;
esac

case "$requirements_status:$scope_status" in
  0:0) echo '両decision markerが存在するため分類できません。' >&2; exit 2 ;;
  0:1) printf 'requirements_change\n' ;;
  1:0) printf 'scope_decision\n' ;;
  1:1) printf 'none\n' ;;
esac
