#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$root/.github/workflows/ai-developer.yml"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.github/scripts" "$tmp/bin" "$tmp/runner"
cp "$root/.github/scripts/parse-ai-resume-command.sh" "$tmp/.github/scripts/"
awk '
  /^      - name: Prepare and dispatch trusted resume command$/ { step = 1; next }
  step && /^  [[:alnum:]_-]+:$/ { exit }
  step && /^      - name: / { exit }
  step && /^        run: \|$/ { run = 1; next }
  run { sub(/^          /, ""); print }
' "$workflow" > "$tmp/producer.sh"
[ -s "$tmp/producer.sh" ]
grep -Fq "github.event.comment.body == '/ai resume develop'" "$workflow"
grep -Fq "github.event.comment.body == '/ai resume review'" "$workflow"
if grep -Fq "github.event.comment.body == '/ai resume validate'" "$workflow"; then
  echo 'Validate command was activated.' >&2
  exit 1
fi

cat > "$tmp/.github/scripts/build-ai-resume-prepare-context.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[ "$MOCK_CASE" != closed_target ]
cat
STUB
cat > "$tmp/.github/scripts/prepare-ai-resume.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
command="$(cat)"
action="$(jq -r .action <<< "$command")"
if [ "$MOCK_CASE" = reject ]; then
  echo '{"result":"reject","code":"action_not_allowed"}'
  exit 0
fi
if [ "$action" = review ]; then
  target=pr:37
  pr=37
  head="$(printf 'a%.0s' {1..40})"
  reason=claude_execution_failed
else
  target=issue:36
  pr=null
  head=null
  reason=requirements_change
fi
case "$MOCK_CASE" in
  wrong_reason) reason=validation_failed ;;
  malformed) head=null ;;
esac
jq -cn --arg action "$action" --arg target "$target" --arg reason "$reason" \
  --arg actor alice --arg head "$head" --argjson pr "$pr" \
  '{result:"prepared",dispatch:{version:1,target:$target,action:$action,actor:$actor,
    source_pause_id:"150",reason:$reason,closing_issue_number:36,pr_number:$pr,
    paused_head:(if $head == "null" then null else $head end),
    prepared_head:(if $head == "null" then null else $head end),
    pause_issue_body_fingerprint:null,prepared_issue_body_fingerprint:"sha256:test",
    follow_up_issue:null}}'
STUB
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = api ] && [ "$2" = /apps/dev ]; then
  echo 123
elif [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = POST ] &&
     [ "$4" = repos/owner/repo/dispatches ] && [ "$5" = --input ]; then
  cp "$6" "$MOCK_DISPATCH"
  echo dispatch >> "$MOCK_GH_LOG"
  [ "$MOCK_CASE" != api_failure ]
else
  echo "Unexpected gh operation" >&2
  exit 2
fi
STUB
chmod +x "$tmp/bin/gh"

run_case() {
  local scenario="$1" body="$2" association="${3:-OWNER}" expected="$4"
  : > "$tmp/calls"
  rm -f "$tmp/dispatch.json"
  local status=0
  (
    cd "$tmp"
    PATH="$tmp/bin:$PATH" MOCK_CASE="$scenario" MOCK_GH_LOG="$tmp/calls" \
      MOCK_DISPATCH="$tmp/dispatch.json" GITHUB_REPOSITORY=owner/repo \
      GITHUB_RUN_ID=500 GITHUB_RUN_ATTEMPT=1 RUNNER_TEMP="$tmp/runner" \
      APP_SLUG=dev COMMENT_BODY="$body" COMMENT_ACTOR=alice \
      COMMENT_ASSOCIATION="$association" TARGET_NUMBER=37 TARGET_KIND=pr \
      bash "$tmp/producer.sh" > "$tmp/stdout" 2> "$tmp/stderr"
  ) || status=$?
  if [ "$expected" = success ]; then
    if [ "$status" -ne 0 ]; then cat "$tmp/stderr" >&2; fi
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$tmp/calls")" -eq 1 ]
    jq -e --arg action "$(case "$body" in *develop) echo develop;; *) echo review;; esac)" '
      (keys == ["client_payload","event_type"]) and
      .event_type == ("ai-resume-" + $action) and
      (.client_payload | keys == ["dispatch","version"]) and
      .client_payload.version == 1 and .client_payload.dispatch.action == $action
    ' "$tmp/dispatch.json" >/dev/null
  else
    [ "$status" -ne 0 ]
    [ ! -s "$tmp/calls" ]
  fi
}
run_case valid '/ai resume review' OWNER success
run_case valid '/ai resume develop' OWNER success
run_case valid '/ai resume review ' OWNER failure
run_case valid '/ai resume review' CONTRIBUTOR failure
run_case closed_target '/ai resume review' OWNER failure
run_case reject '/ai resume review' OWNER failure
run_case wrong_reason '/ai resume review' OWNER failure
run_case malformed '/ai resume review' OWNER failure
: > "$tmp/calls"
if (
  cd "$tmp"
  PATH="$tmp/bin:$PATH" MOCK_CASE=api_failure MOCK_GH_LOG="$tmp/calls" \
    MOCK_DISPATCH="$tmp/dispatch.json" GITHUB_REPOSITORY=owner/repo \
    GITHUB_RUN_ID=500 GITHUB_RUN_ATTEMPT=1 RUNNER_TEMP="$tmp/runner" \
    APP_SLUG=dev COMMENT_BODY='/ai resume review' COMMENT_ACTOR=alice \
    COMMENT_ASSOCIATION=OWNER TARGET_NUMBER=37 TARGET_KIND=pr \
    bash "$tmp/producer.sh" > "$tmp/stdout" 2> "$tmp/stderr"
); then
  echo 'Dispatch API failure was accepted.' >&2
  exit 1
fi
[ "$(wc -l < "$tmp/calls")" -eq 1 ]
grep -Fq '結果は不明です。producerから再試行しません。' "$tmp/stderr"
if grep -Eq 'gh (issue|pr)|ai-resume-accepted|human-review-required|claude-code-action|claude -p' "$tmp/producer.sh"; then
  echo 'Producer crossed the consumer ownership boundary.' >&2
  exit 1
fi
echo 'AI Resume Review producer fixture passed.'
