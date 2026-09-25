#!/usr/bin/env bash
set -euo pipefail

# Pure policy boundary for one final PREPARE context. No GitHub writes or reads.
fail_closed() {
  echo "prepare-ai-resume: invalid PREPARE context" >&2
  exit 1
}

[ "$#" -eq 0 ] || fail_closed
input="$(cat)" || fail_closed
jq -cse '
  def keys_are($expected): type == "object" and (keys == $expected);
  def positive: type == "number" and floor == . and . >= 1;
  def sha: type == "string" and test("\\A[0-9a-f]{40}\\z");
  def fingerprint: type == "string" and test("\\Asha256:[0-9a-f]{64}\\z");
  def pause_id: type == "string" and test("\\A[1-9][0-9]*\\z");
  def reject($code): {result:"reject", code:$code};
  def valid_record:
    keys_unsorted | all(IN("version", "kind", "reason", "target",
                            "paused_head", "source_pause_id", "payload"));
  if length != 1 or (.[0] | keys_are(["closing_issue","command","follow_up_issue",
                                      "pause","pull_request","target"]) | not) then
    error("invalid snapshot envelope")
  else .[0] as $s
    | $s.command as $c | $s.pause as $p | $s.closing_issue as $issue
    | $s.pull_request as $pr | $s.follow_up_issue as $follow
    | if (($c | keys_are(if .action == "follow-up"
                          then ["action","actor","follow_up_issue","result"]
                          else ["action","actor","result"] end)) | not)
         or $c.result != "accepted" or ($c.actor | type) != "string"
         or $c.actor == "" or ($c.action | IN("develop","validate","review","fix",
                                              "follow-up","no-action") | not)
         or ($c.action == "follow-up" and ($c.follow_up_issue | positive | not))
         or ($s.target | type) != "string"
         or ($p | type) != "object"
         or ($p.result | IN("active","no_active_pause","state_inconsistent") | not)
         or ($p.result != "active" and ($p | keys) != ["result"])
         or ($p.result == "active" and ($p | keys) != ["pause_id","reason","record","result"])
         or ($issue | keys_are(["body_fingerprint","number","state"]) | not)
         or ($issue.number | positive | not)
         or ($issue.state | IN("open","closed") | not)
         or ($issue.body_fingerprint | fingerprint | not)
         or ($pr != null and (($pr | keys_are(["base_ref","head_ref","head_sha",
                                               "number","state"]) | not)
                              or ($pr.number | positive | not)
                              or ($pr.state | IN("open","closed","merged") | not)
                              or ($pr.base_ref | type) != "string"
                              or ($pr.head_ref | type) != "string"
                              or ($pr.head_sha | type) != "string"))
         or ($c.action != "follow-up" and $follow != null)
         or ($follow != null and (($follow | keys_are(["explicitly_recorded","kind",
                                                     "number","state"]) | not)
                                 or ($follow.number | positive | not)
                                 or ($follow.kind | IN("issue","pr") | not)
                                 or ($follow.state | IN("open","closed") | not)
                                 or ($follow.explicitly_recorded | type) != "boolean"))
      then error("invalid snapshot shape")
      elif $p.result == "no_active_pause" then reject("no_active_pause")
      elif $p.result == "state_inconsistent" then reject("state_inconsistent")
      elif ($p.pause_id | pause_id | not)
           or ($p.reason | type) != "string"
           or ($p.record | type) != "object"
           or ($p.record | valid_record | not)
           or $p.record.version != 1
           or ($p.record.kind | IN("pause","pause-normalization") | not)
           or $p.record.reason != $p.reason or $p.record.target != $s.target
           or ($p.record | has("source_pause_id") and
               (.source_pause_id | pause_id | not))
           or ($p.record.kind == "pause-normalization" and
               ($p.record | has("source_pause_id") | not))
           or ($p.record | has("payload") and (.payload | type) != "object")
           or ($p.record | has("paused_head") and (.paused_head | sha | not))
           or ($p.record.payload | has("issue_body_fingerprint") and
               (.issue_body_fingerprint | fingerprint | not))
        then reject("invalid_pause_payload")
      elif ($s.target | test("\\A(issue|pr):[1-9][0-9]*\\z") | not)
           or ($s.target == ("issue:" + ($issue.number | tostring)) and $pr != null)
           or ($s.target | startswith("pr:")) and
              ($pr == null or $s.target != ("pr:" + ($pr.number | tostring)))
           or ($s.target | startswith("issue:")) and
              $s.target != ("issue:" + ($issue.number | tostring))
           or $issue.state != "open"
           or ($pr != null and ($pr.state != "open" or $pr.base_ref != "main"
                               or ($pr.head_sha | sha | not)))
        then reject("invalid_target")
      else
        $p.reason as $reason | $c.action as $action
        | (if $reason == "requirements_change" or $reason == "scope_decision"
                 or $reason == "diff_guard_exceeded" or $reason == "diff_guard_error"
           then ["develop"]
           elif $reason == "non_blocking_decision" then ["fix","follow-up","no-action"]
           elif $reason == "validation_failed" then ["validate","develop"]
           elif $reason == "validation_timeout" then ["validate"]
           elif $reason == "claude_execution_failed" then ["review"]
           elif $reason == "developer_execution_failed" then
             if ($p.record.payload.failed_action | IN("develop","fix"))
             then [$p.record.payload.failed_action] else null end
           elif $reason == "review_disagreement_decision" then
             if ($p.record.payload.decided_action | IN("develop","review"))
             then [$p.record.payload.decided_action] else null end
           elif $reason == "resume_transition_failed" then
             if ($p.record.payload.failed_action | IN("develop","validate","review",
                                                     "fix","follow-up","no-action"))
             then [$p.record.payload.failed_action] else null end
           elif $reason | IN("round_limit","explicit_human_escalation","state_inconsistent")
           then [] else null end) as $allowed
        | if $allowed == null then reject("invalid_pause_payload")
          elif ($allowed | index($action)) == null then reject("action_not_allowed")
          elif $action != "develop" and $pr == null then reject("invalid_target")
          elif ($reason | IN("requirements_change","scope_decision","diff_guard_exceeded"))
               and ($p.record.payload.issue_body_fingerprint | fingerprint | not)
            then reject("invalid_pause_payload")
          elif ($reason | IN("requirements_change","scope_decision","diff_guard_exceeded"))
               and $p.record.payload.issue_body_fingerprint == $issue.body_fingerprint
            then reject("issue_body_not_updated")
          elif ($action | IN("fix","review","follow-up","no-action"))
               and ($p.record.paused_head | sha | not)
            then reject("invalid_pause_payload")
          elif ($action | IN("fix","review","follow-up","no-action"))
               and $p.record.paused_head != $pr.head_sha
            then reject("stale_head")
          elif $action == "follow-up" and
               ($follow == null or $follow.number != $c.follow_up_issue
                or $follow.kind != "issue" or $follow.state != "open"
                or $follow.explicitly_recorded != true)
            then reject("invalid_follow_up")
          else {result:"prepared", dispatch:{version:1, target:$s.target,
                 action:$action, actor:$c.actor, source_pause_id:$p.pause_id,
                 reason:$reason, closing_issue_number:$issue.number,
                 pr_number:(if $pr == null then null else $pr.number end),
                 paused_head:($p.record.paused_head // null),
                 prepared_head:(if $pr == null then null else $pr.head_sha end),
                 pause_issue_body_fingerprint:($p.record.payload.issue_body_fingerprint // null),
                 prepared_issue_body_fingerprint:$issue.body_fingerprint,
                 follow_up_issue:(if $action == "follow-up" then $c.follow_up_issue else null end)}}
          end
      end
  end
' <<< "$input" || fail_closed
