#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/parse-ai-resume-command.sh"
workflow="$repo_root/.github/workflows/ai-developer.yml"

# Run the producer's actual shell expression and capture its parser input.
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
awk '
  /^          command="\$\(jq -cn --arg body / { in_command = 1 }
  in_command { sub(/^          /, ""); print; if (/parse-ai-resume-command.sh\)"$/) exit }
' "$workflow" > "$test_dir/producer.sh"
[ "$(wc -l < "$test_dir/producer.sh")" -eq 3 ]
(
  cd "$repo_root"
  COMMENT_BODY='/ai resume develop'
  COMMENT_ACTOR=alice
  COMMENT_ASSOCIATION=OWNER
  bash() {
    if [ "$1" = .github/scripts/parse-ai-resume-command.sh ]; then
      cat > "$test_dir/envelope.json"
      command bash "$@" < "$test_dir/envelope.json"
    else
      command bash "$@"
    fi
  }
  source "$test_dir/producer.sh"
  jq -e '. == {result:"accepted",actor:"alice",action:"develop"}' <<< "$command" > /dev/null
)
jq -e '. == {body:"/ai resume develop",actor:"alice",author_association:"OWNER"}' \
  "$test_dir/envelope.json" > /dev/null

# #1097 Prepared: the real producer admits develop/review only, even though
# its pure parser recognizes handoff for the later #1098 Activation.
awk '
  /^      - name: Prepare and dispatch trusted resume command$/ { in_step = 1; next }
  in_step && /^  [[:alnum:]_-]+:$/ { exit }
  in_step && /^      - name: / { exit }
  in_step && /^          if ! jq -e / && /action == "develop"/ && /action == "review"/ {
    in_gate = 1
    gates++
  }
  in_gate {
    sub(/^          /, "")
    print
    if ($0 == "fi") in_gate = 0
  }
  END { if (gates != 1 || in_gate) exit 1 }
' "$workflow" > "$test_dir/producer-action-gate.sh"
[ "$(wc -l < "$test_dir/producer-action-gate.sh")" -eq 4 ]

assert_producer_action() {
  local name="$1" body="$2" expected="$3" actual=0
  (
    cd "$repo_root"
    COMMENT_BODY="$body"
    COMMENT_ACTOR=alice
    COMMENT_ASSOCIATION=OWNER
    source "$test_dir/producer.sh"
    source "$test_dir/producer-action-gate.sh"
  ) > /dev/null 2>&1 || actual=$?
  if [ "$expected" = accepted ]; then
    [ "$actual" -eq 0 ] || { echo "Production producer rejected $name." >&2; exit 1; }
  else
    [ "$actual" -ne 0 ] || { echo "Production producer activated $name." >&2; exit 1; }
  fi
}
assert_producer_action develop '/ai resume develop' accepted
assert_producer_action review '/ai resume review' accepted
assert_producer_action handoff \
  "/ai resume handoff pause:101 pr:500 head:$(printf 'a%.0s' {1..40})" rejected
assert_producer_action validate '/ai resume validate' rejected

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

# #1097 Prepared handoff parser. No production job consumes this result yet.
head_sha="$(printf 'a%.0s' {1..40})"
assert_result handoff "$(command_input "/ai resume handoff pause:101 pr:500 head:$head_sha")" \
  "$(jq -cn --arg head "$head_sha" '{result:"accepted",actor:"suzukure",action:"handoff",pause_id:"101",pr_number:500,head_sha:$head}')"
for assoc in MEMBER COLLABORATOR; do
  assert_result "trusted handoff association $assoc" \
    "$(command_input "/ai resume handoff pause:101 pr:500 head:$head_sha" "$assoc")" \
    "$(jq -cn --arg head "$head_sha" '{result:"accepted",actor:"suzukure",action:"handoff",pause_id:"101",pr_number:500,head_sha:$head}')"
done
assert_result untrusted-handoff "$(command_input "/ai resume handoff pause:101 pr:500 head:$head_sha" CONTRIBUTOR)" '{"result":"ignore"}'
for malformed_handoff in \
  "/ai resume handoff pause:0 pr:500 head:$head_sha" \
  "/ai resume handoff pause:01 pr:500 head:$head_sha" \
  "/ai resume handoff pause:101 pr:0500 head:$head_sha" \
  "/ai resume handoff pause:101 pr:0 head:$head_sha" \
  "/ai resume handoff pause:101 pr:500 head:ZZZZ" \
  "/ai resume handoff pause:101 pr:500 head:$head_sha extra" \
  " /ai resume handoff pause:101 pr:500 head:$head_sha" \
  "/ai resume handoff pause:101 pr:500 head:$head_sha " \
  $'/ai resume handoff pause:101 pr:500 head:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nextra'; do
  assert_result "bad handoff $malformed_handoff" "$(command_input "$malformed_handoff")" '{"result":"reject","code":"invalid_command"}'
done

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
