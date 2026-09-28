#!/usr/bin/env bash
set -euo pipefail

# Prepared contract only. Load this file and the entry gate from the trusted
# base commit. The caller owns GitHub writes and carries only the identity
# returned by entry into later phases; never reconstruct it from dispatch.
# Follow entry -> pre_consume -> machine_state_result -> paid review -> pre_verdict. Call
# merge_inputs only after an approving verdict was posted. A pause_record
# instruction uses the existing common pause path.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
phase="${1:-}"
stop() { jq -cn --arg code "$1" '{action:"stop",code:$code}'; exit 0; }
pause() {
  [ -n "${identity:-}" ] || stop "$1"
  jq -cn --arg code "$1" --argjson identity "$identity" \
    '{action:"pause_record",code:$code,identity:$identity}'
  exit 0
}

if [ "$phase" = entry ]; then
  shift
  decision="$(bash "$script_dir/evaluate-claude-auto-rereview-entry-gate.sh" "$@")" \
    || stop entry_gate_failed
  case "$(jq -r '.action // empty' <<< "$decision")" in
    ignore) printf '%s\n' "$decision" ;;
    human_required)
      if [ "$(jq -r .code <<< "$decision")" = state_changed ]; then
        stop state_changed
      elif jq -e '.identity | type == "object"' <<< "$decision" >/dev/null; then
        jq -c '{action:"pause_record",code,reason,identity}' <<< "$decision"
      else
        jq -c '{action:"stop",code,reason}' <<< "$decision"
      fi ;;
    proceed)
      jq -c '{action:"accepted",identity, next:"pre_consume"}' \
        <<< "$decision" ;;
    *) stop entry_gate_failed ;;
  esac
  exit 0
fi

input="$(cat)" || pause invalid_identity
identity="$(jq -cse '
  def positive: type == "number" and floor == . and . > 0;
  def sha: type == "string" and test("^[0-9a-f]{40}$");
  if length != 1 or (.[0] | type) != "object" then error("input")
  else (if (.[0] | has("identity")) then .[0].identity else .[0] end) as $i |
    if ($i | type) != "object" or ($i | keys | sort) !=
      ["base_ref","closing_issue_number","head_ref","pr_number","repo","round","trusted_base_sha","validated_sha"]
      or ($i.repo | type != "string" or (test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not))
      or ($i.pr_number | positive | not) or ($i.closing_issue_number | positive | not)
      or ($i.round | positive | not) or ($i.validated_sha | sha | not)
      or ($i.trusted_base_sha | sha | not)
      or ($i.head_ref | type != "string" or (test("^ai/issue-[1-9][0-9]*$") | not))
      or ($i.base_ref | type != "string" or (test("^[A-Za-z0-9_./-]+$") | not) or contains(".."))
      or (($i.head_ref | split("-") | last | tonumber) != $i.closing_issue_number)
    then error("identity") else $i end
  end
' <<< "$input" 2>/dev/null)" || pause invalid_identity

case "$phase" in
  pre_consume)
    [ "$#" -eq 3 ] || stop invalid_context
    reviewer="$2"
    developer="$3"
    payload="$(jq -cn --argjson identity "$identity" \
      '{pr_number:$identity.pr_number,validated_sha:$identity.validated_sha,round:$identity.round}')"
    decision="$(printf '%s\n' "$payload" | bash "$script_dir/evaluate-claude-auto-rereview-entry-gate.sh" \
      "$(jq -r .repo <<< "$identity")" "$reviewer" "$developer" \
      "$(jq -r .trusted_base_sha <<< "$identity")")" || stop entry_gate_failed
    case "$(jq -r '.action // empty' <<< "$decision")" in
      ignore) printf '%s\n' "$decision" ;;
      human_required)
        if [ "$(jq -r .code <<< "$decision")" = state_changed ]; then
          stop state_changed
        elif [ "$(jq -c '.identity // null' <<< "$decision")" = "$identity" ]; then
          jq -c '{action:"pause_record",code,reason,identity}' <<< "$decision"
        else
          stop state_changed
        fi ;;
      proceed)
        if [ "$(jq -c '.identity // null' <<< "$decision")" = "$identity" ]; then
          jq -cn --argjson identity "$identity" \
            '{action:"remove_machine_state",identity:$identity}'
        else
          stop state_changed
        fi ;;
      *) stop entry_gate_failed ;;
    esac
    ;;
  machine_state_result)
    [ "$(jq -r 'keys == ["identity","label_removed"] and (.label_removed | type == "boolean")' <<< "$input")" = true ] \
      || pause state_inconsistent
    [ "$(jq -r .label_removed <<< "$input")" = true ] || pause state_inconsistent
    jq -cn --argjson identity "$identity" '{action:"paid_review",identity:$identity}'
    ;;
  pre_verdict)
    # Re-read the PR immediately before posting. A changed HEAD suppresses
    # the stale verdict, including a no-diff same-HEAD re-review verdict.
    repo="$(jq -r .repo <<< "$identity")"
    number="$(jq -r .pr_number <<< "$identity")"
    pr="$(gh api "repos/${repo}/pulls/${number}")" || pause pr_unavailable
    current="$(jq -cse --arg repo "$repo" --argjson number "$number" '
      if length != 1 or (.[0] | type) != "object" then error("pr") else .[0] end |
      if .number != $number or (.head.sha | type) != "string"
         or (.head.sha | test("^[0-9a-f]{40}$") | not)
         or (.head.ref | type) != "string" or (.base.ref | type) != "string"
         or (.head.repo.full_name != $repo) or (.base.repo.full_name != $repo)
         or (.draft | type) != "boolean" or (.state | type) != "string"
         or (.labels | type) != "array"
         or ([.labels[] | type == "object" and (.name | type) == "string"] | all | not)
      then error("pr") else
        {head:.head.sha,head_ref:.head.ref,base_ref:.base.ref,
         ready:(.state == "open" and (.draft | not)
           and ([.labels[].name] | index("human-review-required") == null))}
      end
    ' <<< "$pr" 2>/dev/null)" || pause invalid_pr
    [ "$(jq -r .head <<< "$current")" = "$(jq -r .validated_sha <<< "$identity")" ] \
      || { jq -cn '{action:"suppress_verdict",code:"stale_head"}'; exit 0; }
    [ "$(jq -r .ready <<< "$current")" = true ] \
      && [ "$(jq -r .head_ref <<< "$current")" = "$(jq -r .head_ref <<< "$identity")" ] \
      && [ "$(jq -r .base_ref <<< "$current")" = "$(jq -r .base_ref <<< "$identity")" ] \
      || pause state_changed
    jq -cn --argjson identity "$identity" '{action:"submit_verdict",identity:$identity}'
    ;;
  merge_inputs)
    # The caller still runs verify-pr-gates.sh in merge mode and uses
    # gh pr merge --match-head-commit. Protected paths remain human-only.
    [ "$(jq -r 'keys == ["identity","verdict"] and .verdict == "approve"' <<< "$input")" = true ] \
      || pause invalid_verdict
    jq -cn --argjson identity "$identity" \
      '{action:"verify_merge_gates",repo:$identity.repo,
        pr_number:$identity.pr_number,head_ref:$identity.head_ref,
        base_ref:$identity.base_ref,trusted_base_sha:$identity.trusted_base_sha,
        match_head_commit:$identity.validated_sha,gate_mode:"merge"}'
    ;;
  *) pause invalid_phase ;;
esac
