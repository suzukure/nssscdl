#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
cp "$root/.github/scripts/prepare-ai-resume-review-consumer.sh" "$tmp/scripts/"
cp "$root/.github/scripts/prepare-ai-resume.sh" "$tmp/scripts/"
helper="$tmp/scripts/prepare-ai-resume-review-consumer.sh"
export HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export FINGERPRINT=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export REASON=claude_execution_failed
export FAILED_ACTION=review
export PR_MODE=valid
export LABEL_MODE=valid
export COMMENT_MODE=valid
export PAUSE_MODE=active
dispatch() {
  jq -cn --arg reason "$REASON" --arg head "$HEAD_SHA" --arg fp "$FINGERPRINT" \
    '{version:1,target:"pr:37",action:"review",actor:"alice",source_pause_id:"101",
      reason:$reason,closing_issue_number:36,pr_number:37,paused_head:$head,
      prepared_head:$head,pause_issue_body_fingerprint:null,
      prepared_issue_body_fingerprint:$fp,follow_up_issue:null}'
}
cat > "$tmp/scripts/build-ai-resume-prepare-context.sh" <<'STUB'
#!/usr/bin/env bash
command="$(cat)"
jq -cn --argjson command "$command" --arg reason "$REASON" --arg head "$HEAD_SHA" \
  --arg fp "$FINGERPRINT" --arg failed "$FAILED_ACTION" '
  {command:$command,target:"pr:37",closing_issue:{number:36,state:"open",body_fingerprint:$fp},
   pull_request:{number:37,state:"open",base_ref:"main",head_ref:"ai/issue-36",head_sha:$head},
   follow_up_issue:null,pause:{result:"active",pause_id:"101",reason:$reason,
     record:{version:1,kind:"pause",reason:$reason,target:"pr:37",paused_head:$head,
       payload:{failed_action:$failed,decided_action:$failed}}}}
  | if env.PAUSE_MODE == "consumed" then .pause = {result:"no_active_pause"} else . end
  '
STUB
export GH_LOG="$tmp/gh.log"
: > "$GH_LOG"
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$*" in
    'api /repos/owner/repo/pulls/37')
      jq -cn --arg mode "$PR_MODE" --arg head "$HEAD_SHA" '
        {number:37,state:(if $mode == "closed" then "closed" else "open" end),
         draft:($mode == "draft"),head:{repo:{full_name:(if $mode == "fork" then "fork/repo" else "owner/repo" end)},
         ref:(if $mode == "branch" then "ai/issue-99" else "ai/issue-36" end),
         sha:(if $mode == "head" then "cccccccccccccccccccccccccccccccccccccccc" else $head end)},
         base:{repo:{full_name:"owner/repo"},ref:"main"}}' ;;
    'api /repos/owner/repo/issues/36'|'api /repos/owner/repo/issues/37')
      local number="${2##*/}"
      jq -cn --argjson number "$number" --arg mode "$LABEL_MODE" '
        {number:$number,labels:(if $mode == "issue" and $number == 36 or
                                   $mode == "pr" and $number == 37
                              then [] else [{name:"human-review-required"}] end)}' ;;
    *'/issues/37/comments?per_page=100&page=1')
      jq -cn --arg mode "$COMMENT_MODE" '
        [{id:(if $mode == "before" then 100 else 150 end),
          body:(if $mode == "body" then "/ai resume review " else "/ai resume review" end),
          user:{login:(if $mode == "actor" then "bob" else "alice" end)},
          author_association:(if $mode == "outsider" then "NONE" else "OWNER" end)}]' ;;
    *) echo "unexpected GitHub call: $*" >&2; return 1 ;;
  esac
}
export -f gh
accept() {
  local result
  result="$(dispatch | bash "$helper" owner/repo 99)"
  jq -e --arg reason "$REASON" --arg head "$HEAD_SHA" '
    .result == "accepted_candidate" and .identity.reason == $reason
    and .identity.command_comment_id == "150" and .identity.head == $head
    and .accepted_record.source_pause_id == "101"
    and .accepted_record.payload.action == "review"
    and .reconciliation.trusted_app_record_required == true
    and [.sequence[].action] == ["create_or_reconcile_accepted_record",
      "revalidate_record_graph","remove_issue_label","confirm_issue_label_absent",
      "remove_pr_label","handoff_normal_claude_review"]
  ' <<< "$result" >/dev/null
}
for REASON in claude_execution_failed review_disagreement_decision resume_transition_failed; do
  export REASON
  accept
done
export REASON=review_disagreement_decision FAILED_ACTION=develop
[ "$(dispatch | bash "$helper" owner/repo 99 | jq -r .result)" = ignore ]
export FAILED_ACTION=review REASON=wrong_reason
if dispatch | bash "$helper" owner/repo 99 >/dev/null 2>&1; then exit 1; fi
export REASON=claude_execution_failed
export PAUSE_MODE=consumed
[ "$(dispatch | bash "$helper" owner/repo 99 | jq -r .result)" = ignore ]
export PAUSE_MODE=active
for malformed in '{}' 'null' '[]' 'not-json'; do
  if bash "$helper" owner/repo 99 <<< "$malformed" >/dev/null 2>&1; then exit 1; fi
done
if head -c 10001 /dev/zero | tr '\0' x | bash "$helper" owner/repo 99 >/dev/null 2>&1; then exit 1; fi
if dispatch | jq '.prepared_head="cccccccccccccccccccccccccccccccccccccccc"' | \
  bash "$helper" owner/repo 99 >/dev/null 2>&1; then exit 1; fi
[ "$(dispatch | jq '.pr_number=38 | .target="pr:38"' | bash "$helper" owner/repo 99 | jq -r .result)" = ignore ]
for PR_MODE in closed draft fork branch head; do
  export PR_MODE
  [ "$(dispatch | bash "$helper" owner/repo 99 | jq -r .result)" = ignore ]
done
export PR_MODE=valid
for LABEL_MODE in issue pr; do
  export LABEL_MODE
  [ "$(dispatch | bash "$helper" owner/repo 99 | jq -r .result)" = ignore ]
done
export LABEL_MODE=valid
for COMMENT_MODE in before body actor outsider; do
  export COMMENT_MODE
  [ "$(dispatch | bash "$helper" owner/repo 99 | jq -r .result)" = ignore ]
done
export COMMENT_MODE=valid
first="$(dispatch | bash "$helper" owner/repo 99)"
second="$(dispatch | bash "$helper" owner/repo 99)"
[ "$first" = "$second" ]
check_read_only_log() {
  local search_rc
  if grep -Eq 'api -X|issue edit|pr ready|dispatch' "$GH_LOG"; then
    search_rc=0
  else
    search_rc=$?
  fi
  case "$search_rc" in
    0) echo 'Prepared review consumer attempted a repository write.' >&2; return 1 ;;
    1) return 0 ;;
    *) echo "Repository write log search failed (exit $search_rc)." >&2; return 1 ;;
  esac
}
check_read_only_log
printf '%s\n' 'api -X POST /repos/owner/repo/issues/37/comments' >> "$GH_LOG"
if check_read_only_log >/dev/null 2>&1; then
  echo 'Repository write log was accepted.' >&2
  exit 1
fi
if (grep() { return 127; }; check_read_only_log >/dev/null 2>&1); then
  echo 'Missing repository write log search tool was accepted.' >&2
  exit 1
fi
grep -Fq 'types: [ai-resume-review]' "$root/.github/workflows/ai-resume-review-consumer.yml"
grep -Fq 'consume-ai-resume-review.sh' "$root/.github/workflows/ai-resume-review-consumer.yml"
# The comment producer remains disconnected.
if rg -l '/ai resume review' "$root/.github/workflows" | grep -v 'ai-resume-review-consumer.yml' >/dev/null; then
  echo 'Review comment producer became reachable.' >&2
  exit 1
fi
echo 'prepare-ai-resume-review-consumer fixture passed.'
