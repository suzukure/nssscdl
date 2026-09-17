#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/parse-ai-resume-command.sh"

command_input() {
  jq -cn --arg body "$1" --arg association "${2:-OWNER}" \
    '{body: $body, actor: "suzukure", author_association: $association}'
}

assert_result() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"
  local expected="${3:?expected JSON is required}"
  local output

  output="$(printf '%s' "$input" | bash "$helper")"
  jq -e --argjson expected "$expected" '. == $expected' <<< "$output" > /dev/null \
    || { echo "Expected $name to produce the expected result." >&2; exit 1; }
}

assert_rejected() {
  local name="${1:?name is required}"
  local input="${2:?input is required}"

  if printf '%s' "$input" | bash "$helper" > /dev/null 2>&1; then
    echo "Expected $name to be rejected." >&2
    exit 1
  fi
}

for action in develop validate review fix no-action; do
  assert_result "$action" "$(command_input "/ai resume $action")" \
    "$(jq -cn --arg action "$action" \
      '{result: "accepted", actor: "suzukure", action: $action}')"
done
assert_result follow-up "$(command_input '/ai resume follow-up #123')" \
  '{"result":"accepted","actor":"suzukure","action":"follow-up","follow_up_issue":123}'

for association in OWNER MEMBER COLLABORATOR; do
  assert_result "trusted association: $association" \
    "$(command_input '/ai resume develop' "$association")" \
    '{"result":"accepted","actor":"suzukure","action":"develop"}'
done
assert_result unrelated "$(command_input '/codex develop')" '{"result":"ignore"}'
assert_result untrusted "$(command_input '/ai resume develop' CONTRIBUTOR)" '{"result":"ignore"}'

for malformed in \
  ' /ai resume develop' \
  '/ai resume develop ' \
  $'/ai resume develop\nextra' \
  '/ai resume develop extra' \
  $'```\n/ai resume develop\n```' \
  ' /ai resume follow-up #1' \
  '/ai resume follow-up #1 ' \
  $'/ai resume follow-up #1\n' \
  $'/ai resume follow-up #1\nextra' \
  $'prefix\n/ai resume follow-up #1' \
  $'```\n/ai resume follow-up #1\n```' \
  '/ai resume deploy' \
  '/AI resume develop' \
  '/ai  resume develop' \
  '/ai resume follow-up #0' \
  '/ai resume follow-up #0123' \
  '/ai resume follow-up #12x' \
  '/ai resume'; do
  assert_result "malformed command: $malformed" "$(command_input "$malformed")" \
    '{"result":"reject","code":"invalid_command"}'
done

assert_rejected invalid-json '{'
assert_rejected array-input '[]'
assert_rejected null-input 'null'
assert_rejected missing-body '{"actor":"suzukure","author_association":"OWNER"}'
assert_rejected missing-actor '{"body":"/ai resume develop","author_association":"OWNER"}'
assert_rejected missing-association '{"body":"/ai resume develop","actor":"suzukure"}'
assert_rejected invalid-body-type '{"body":null,"actor":"suzukure","author_association":"OWNER"}'
assert_rejected invalid-actor-type '{"body":"/ai resume develop","actor":1,"author_association":"OWNER"}'
assert_rejected invalid-association-type '{"body":"/ai resume develop","actor":"suzukure","author_association":[]}'
assert_rejected multiple-json-values $'{"body":"/ai resume develop","actor":"suzukure","author_association":"OWNER"}\n{}'

echo 'parse-ai-resume-command tests passed.'
