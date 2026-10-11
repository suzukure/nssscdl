#!/usr/bin/env bash
set -euo pipefail

# Dormant until a workflow owns codex-writer-ai/issue-<Issue> on the default branch.
# The caller supplies durable evidence; acquisition and provenance are upstream.
repo="${1:?repository required}"
run_id="${2:?source run required}"
attempt="${3:?source attempt required}"
app_slug="${4:?trusted App slug required}"
pr="${5:?PR required}"
issue="${6:?closing Issue required}"
source="${7:?source pause required}"
evidence="${8:--}"
[ "$#" -le 8 ] || { echo 'unexpected argument' >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "recover-ai-resume-validate: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
[[ "$app_slug" =~ ^[A-Za-z0-9-]+$ ]] || fail 'invalid App slug'
for value in "$run_id" "$attempt" "$pr" "$issue" "$source"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail 'invalid numeric identity'
done
app_id="$(gh api "/apps/$app_slug" --jq .id)" || fail 'App identity unavailable'
[[ "$app_id" =~ ^[1-9][0-9]*$ ]] || fail 'invalid App identity'
prepare() {
  bash "$script_dir/prepare-ai-resume-validate-recovery.sh" \
    "$repo" "$run_id" "$attempt" "$app_id" "$pr" "$issue" "$source" "$evidence"
}
# Validate the complete action sequence before any write, including actions
# after the first one. An isolated graph check is never an executable action.
check_plan() {
  jq -e --arg repo "$repo" --argjson run "$run_id" \
    --argjson attempt "$attempt" --argjson pr "$pr" --argjson issue "$issue" \
    --arg source "$source" '
    def id: type == "string" and test("^[1-9][0-9]*$");
    def head: type == "string" and test("^[0-9a-f]{40}$");
    def label_action($name;$number):
      (keys | sort) == ["action","number"] and .action == $name and .number == $number;
    def machine:
      (keys | sort) == ["action","requires"] and .action == "remove_machine_label"
      and .requires == "fresh graph active and both human labels present";
    def pause:
      if .action == "create_or_reconcile_replacement_pause" then
        (keys | sort) == ["action","failed_action","reason","source_pause_id"]
        and .reason == "resume_transition_failed" and .failed_action == "validate"
        and (.source_pause_id | id)
      elif .action == "create_or_reconcile_validation_pause" then
        (keys | sort) == ["accepted_record_id","action","paused_head","reason"]
        and (.accepted_record_id | id) and (.paused_head | head)
        and (.reason | IN("validation_failed","validation_timeout","round_limit"))
      else false end;
    def graph($name):
      (keys | sort) == ["action","requires"] and .action == "revalidate_record_graph"
      and .requires == $name;
    . as $plan
    | (.diagnostics.target == {repository:$repo,issue_number:$issue,pr_number:$pr})
      and .diagnostics.source.run_id == $run
      and .diagnostics.source.attempt == $attempt
      and .diagnostics.source.pause_id == $source
      and (.actions | type == "array")
      and (([.actions[].action] | length) == ([.actions[].action] | unique | length))
      and (if .result == "normal_review_owns" or .result == "cycle_wait" then
             .actions == []
           elif .result == "manual_reconcile" then
             .actions == [] and (.code | type == "string" and length > 0)
           elif .result == "pre_acceptance" then
             .actions == ([if .diagnostics.current.issue_human_label == false then
               {action:"add_issue_human_label",number:$issue} else empty end,
               if .diagnostics.current.pr_human_label == false then
               {action:"add_pr_human_label",number:$pr} else empty end])
           elif .result == "paused" then
             (.accepted_record_id | id)
             and (.diagnostics.current.active_pause_id | id)
             and ((.replacement_pause_id // .active_pause_id) == .diagnostics.current.active_pause_id)
             and ((has("replacement_pause_id") and has("active_pause_id")) | not)
             and .actions == ([if .diagnostics.current.issue_human_label == false then
               {action:"add_issue_human_label",number:$issue} else empty end,
               if .diagnostics.current.pr_human_label == false then
               {action:"add_pr_human_label",number:$pr} else empty end,
               if .diagnostics.current.machine_state == true then
               {action:"remove_machine_label",requires:"fresh graph active and both human labels present"}
               else empty end])
           elif .result == "recover" then
             (.accepted_record_id | id)
             and (.actions | length >= 2)
             and (.actions[0] | pause)
             and (.actions[0].source_pause_id // .actions[0].accepted_record_id) == .accepted_record_id
             and (if .actions[0].action == "create_or_reconcile_replacement_pause" then
                    (.actions[1] | graph("one matching active replacement pause"))
                  else (.actions[0].paused_head == .diagnostics.current.head)
                    and (.actions[1] | graph("one active validation pause")) end)
             and .actions[2:] == ([if .diagnostics.current.issue_human_label == false then
               {action:"add_issue_human_label",number:$issue} else empty end,
               if .diagnostics.current.pr_human_label == false then
               {action:"add_pr_human_label",number:$pr} else empty end,
               if .diagnostics.current.machine_state == true then
               {action:"remove_machine_label",requires:"fresh graph active and both human labels present"}
               else empty end])
           else false end)
      and all(.actions[];
        if .action == "add_issue_human_label" then label_action("add_issue_human_label";$issue)
        elif .action == "add_pr_human_label" then label_action("add_pr_human_label";$pr)
        elif .action == "remove_machine_label" then machine
        elif .action == "revalidate_record_graph" then
          .requires == "one matching active replacement pause" or .requires == "one active validation pause"
        else pause end)
  ' <<< "$1" >/dev/null || fail 'invalid recovery plan'
}
plan="$(prepare)" || fail 'recovery facts unavailable'
for ((iteration = 0; iteration < 5; iteration++)); do
  check_plan "$plan"
  result="$(jq -r .result <<< "$plan")"
  if [ "$result" = manual_reconcile ]; then
    jq -c '{code,diagnostics}' <<< "$plan" >&2
    fail 'manual reconcile required'
  fi
  action="$(jq -r '.actions[0].action // "done"' <<< "$plan")"
  [ "$action" != "done" ] || exit 0
  case "$action" in
    create_or_reconcile_replacement_pause|create_or_reconcile_validation_pause)
      pause_action="$(jq -c .actions[0] <<< "$plan")"
      record="$(bash "$script_dir/prepare-ai-resume-validate-pause-record.sh" "$pr" \
        <<< "$pause_action")" || fail 'pause conversion failed'
      body="$(bash "$script_dir/human-pause-record.sh" create "$record")" \
        || fail 'pause record invalid'
      gh api -X POST "/repos/$repo/issues/$pr/comments" -f "body=$body" >/dev/null || true
      fresh="$(prepare)" || fail 'pause POST outcome unavailable'
      check_plan "$fresh"
      jq -e --arg action "$action" --argjson prior "$plan" '
        .result == "paused" and .accepted_record_id == $prior.accepted_record_id
        and (.actions | all(.[]; .action != $action and .action != "revalidate_record_graph"))
        and (.diagnostics.current.active_pause_record | type == "object")
        and (if $action == "create_or_reconcile_replacement_pause" then
               (.replacement_pause_id | type == "string")
               and .diagnostics.current.active_pause_record.reason == "resume_transition_failed"
               and .diagnostics.current.active_pause_record.source_pause_id == $prior.accepted_record_id
               and .diagnostics.current.active_pause_record.payload.failed_action == "validate"
             else (.active_pause_id | type == "string")
               and .diagnostics.current.active_pause_record.reason == $prior.actions[0].reason
               and .diagnostics.current.active_pause_record.paused_head == $prior.actions[0].paused_head
               and (.diagnostics.current.active_pause_record | has("source_pause_id") | not)
             end)
      ' <<< "$fresh" >/dev/null || fail 'pause is not uniquely active'
      ;;
    add_issue_human_label)
      gh issue edit "$issue" --repo "$repo" --add-label human-review-required || true
      fresh="$(prepare)" || fail 'Issue label outcome unavailable'
      ;;
    add_pr_human_label)
      gh issue edit "$pr" --repo "$repo" --add-label human-review-required || true
      fresh="$(prepare)" || fail 'PR label outcome unavailable'
      ;;
    remove_machine_label)
      if [ "$result" != paused ] || [ "$(jq -r '.actions | length' <<< "$plan")" != 1 ] \
        || [ "$(jq -r '.diagnostics.current.issue_human_label and .diagnostics.current.pr_human_label' <<< "$plan")" != true ]; then
        fail 'machine removal requires fresh human labels'
      fi
      gh issue edit "$pr" --repo "$repo" --remove-label ai-followup-in-progress || true
      fresh="$(prepare)" || fail 'machine label outcome unavailable'
      ;;
    *) fail 'unexpected action' ;;
  esac
  check_plan "$fresh"
  jq -e --arg action "$action" 'all(.actions[]; .action != $action)' \
    <<< "$fresh" >/dev/null || fail 'write outcome not confirmed'
  plan="$fresh"
done
fail 'recovery did not converge'
