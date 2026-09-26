#!/usr/bin/env bash
set -euo pipefail

# Run this file from the current base commit, resolved by the caller before
# execution. The base tip is fetched again below; a changed tip stops the gate.
# stdin: {pr_number, validated_sha, round}. The dispatch body is untrusted.
# The common evaluate-claude-review-entry-gate.sh remains a separate gate.

emit() {
  jq -cn --arg action "$1" --arg code "$2" --arg reason "$3" \
    '{action:$action,code:$code,reason:$reason}'
}
human() { emit human_required "$1" "$2"; exit 0; }
ignore() { emit ignore "$1" "$2"; exit 0; }

[ "$#" -eq 3 ] || human invalid_context 'Expected repository, reviewer App slug, and trusted base SHA.'
repo="$1"
reviewer="$2"
trusted_base="$3"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || human invalid_context 'Invalid repository.'
[[ "$reviewer" =~ ^[A-Za-z0-9_-]+$ ]] \
  || human invalid_context 'Invalid reviewer identity.'
[[ "$trusted_base" =~ ^[0-9a-f]{40}$ ]] \
  || human invalid_context 'Invalid trusted base SHA.'

payload="$(cat)" || human invalid_payload 'Could not read dispatch payload.'
parsed="$(jq -cse '
  def positive: type == "number" and floor == . and . > 0;
  def sha: type == "string" and test("^[0-9a-f]{40}$");
  if length != 1 or (.[0] | type) != "object" then error("payload")
  elif (.[0] | keys | sort) != ["pr_number","round","validated_sha"] then error("payload")
  elif (.[0].pr_number | positive | not) or (.[0].round | positive | not)
       or (.[0].validated_sha | sha | not) then error("payload")
  else .[0] end
' <<< "$payload" 2>/dev/null)" || human invalid_payload 'Invalid dispatch payload.'
pr_number="$(jq -r '.pr_number' <<< "$parsed")"
validated_sha="$(jq -r '.validated_sha' <<< "$parsed")"
round="$(jq -r '.round' <<< "$parsed")"

pr="$(gh api "repos/${repo}/pulls/${pr_number}")" \
  || human pr_unavailable 'Could not fetch the current PR.'
pr_facts="$(jq -cse --arg repo "$repo" --argjson number "$pr_number" '
  def sha: type == "string" and test("^[0-9a-f]{40}$");
  if length != 1 or (.[0] | type) != "object" then error("pr")
  else .[0] as $p |
    if $p.number != $number or ($p.state != "open" and $p.state != "closed")
       or ($p.draft | type) != "boolean"
       or ($p.merged | type) != "boolean"
       or ($p.head.sha | sha | not)
       or ($p.head.ref | type) != "string"
       or ($p.head.repo.full_name | type) != "string"
       or $p.head.repo.full_name != $repo
       or ($p.base.ref | type) != "string"
       or ($p.base.repo.full_name | type) != "string"
       or $p.base.repo.full_name != $repo
       or ($p.labels | type) != "array"
       or ([$p.labels[] | type == "object" and (.name | type == "string")] | all | not)
    then error("pr")
    else {state:$p.state, merged:$p.merged, draft:$p.draft,
          head:$p.head.sha, head_ref:$p.head.ref, base_ref:$p.base.ref,
          labels:[$p.labels[].name]}
    end
  end
' <<< "$pr" 2>/dev/null)" || human invalid_pr 'Current PR metadata is inconsistent.'

state="$(jq -r '.state' <<< "$pr_facts")"
merged="$(jq -r '.merged' <<< "$pr_facts")"
if [ "$state" = closed ]; then
  ignore terminal_pr 'PR is closed or merged.'
fi
[ "$merged" = false ] || human invalid_pr 'Open PR has a merged state.'

base_ref="$(jq -r '.base_ref' <<< "$pr_facts")"
[[ "$base_ref" =~ ^[A-Za-z0-9_./-]+$ && "$base_ref" != *..* ]] \
  || human invalid_pr 'Invalid base ref.'
base="$(gh api "repos/${repo}/git/ref/heads/${base_ref}")" \
  || human base_unavailable 'Could not resolve current base.'
base_sha="$(jq -rse 'if length == 1 and (.[0].object.sha | type) == "string"
  and (.[0].object.sha | test("^[0-9a-f]{40}$")) then .[0].object.sha
  else error("base") end' <<< "$base" 2>/dev/null)" \
  || human invalid_base 'Invalid current base SHA.'
[ "$base_sha" = "$trusted_base" ] \
  || human base_changed 'Current base changed after trusted helper selection.'

relation="$(gh pr view "$pr_number" --repo "$repo" \
  --json number,headRefOid,closingIssuesReferences)" \
  || human relation_unavailable 'Could not fetch closing Issue relation.'
issue_number="$(jq -rse --arg repo "$repo" --arg head "$(jq -r '.head' <<< "$pr_facts")" \
  --arg branch "$(jq -r '.head_ref' <<< "$pr_facts")" \
  --argjson number "$pr_number" '
  def positive: type == "number" and floor == . and . > 0;
  if length != 1 or (.[0] | type) != "object" then error("relation")
  else .[0] as $p |
    if $p.number != $number or $p.headRefOid != $head
       or ($p.closingIssuesReferences | type) != "array"
       or ([$p.closingIssuesReferences[] | type == "object"
             and (.number | positive) and (.url | type == "string")] | all | not)
    then error("relation")
    else ($branch | if test("^ai/issue-[1-9][0-9]*$")
         then capture("^ai/issue-(?<n>[1-9][0-9]*)$").n | tonumber
         else error("branch") end) as $branch_issue |
      [$p.closingIssuesReferences[] |
      select(.url == ("https://github.com/" + $repo + "/issues/" + (.number | tostring))) |
      .number] | unique |
      if index($branch_issue) != null then $branch_issue else error("relation") end
    end
  end
' <<< "$relation" 2>/dev/null)" || human invalid_relation 'PR closing Issue relation is invalid.'
issue="$(gh api "repos/${repo}/issues/${issue_number}")" \
  || human issue_unavailable 'Could not fetch closing Issue.'
issue_paused="$(jq -rs --argjson number "$issue_number" '
  if length != 1 or (.[0] | type) != "object" then error("issue")
  else .[0] as $i |
    if $i.number != $number or $i.state != "open" or ($i | has("pull_request"))
       or ($i.labels | type) != "array"
       or ([$i.labels[] | type == "object" and (.name | type == "string")] | all | not)
    then error("issue")
    else [$i.labels[].name] | index("human-review-required") != null end
  end
' <<< "$issue" 2>/dev/null)" || human invalid_issue 'Closing Issue metadata is invalid.'

current_head="$(jq -r '.head' <<< "$pr_facts")"
if [ "$current_head" != "$validated_sha" ]; then
  ignore stale_head 'Dispatch validation belongs to an older HEAD.'
fi

[ "$(jq -r '.draft' <<< "$pr_facts")" = false ] \
  || human draft_pr 'Current PR is draft.'
[ "$issue_paused" = false ] \
  || human human_pause 'Closing Issue has a human pause.'
if jq -e '.labels | index("human-review-required") != null' <<< "$pr_facts" >/dev/null; then
  human human_pause 'PR has a human pause.'
fi

reviews="$(gh api --paginate "repos/${repo}/pulls/${pr_number}/reviews")" \
  || human reviews_unavailable 'Could not fetch review history.'
review_facts="$(jq -cs --arg slug "$reviewer" --arg head "$current_head" '
  def valid: type == "array" and all(.[]; type == "object"
    and (.id | type == "number" and floor == . and . > 0)
    and (.user.login | type == "string") and (.state | type == "string")
    and (.commit_id | type == "string" and test("^[0-9a-f]{40}$")));
  if all(.[]; valid) | not then error("reviews")
  else [ .[][] | select(.user.login == $slug or .user.login == ($slug + "[bot]")
                    or .user.login == ("app/" + $slug)) ] as $mine |
    {round: ([$mine[] | select(.state == "CHANGES_REQUESTED")] | length),
     approved_head: ([$mine[] | select(.commit_id == $head)] as $head_reviews |
       ($head_reviews | length) == 1 and $head_reviews[0].state == "APPROVED")}
  end
' <<< "$reviews" 2>/dev/null)" || human invalid_reviews 'Review history is invalid.'
actual_round="$(jq -r '.round' <<< "$review_facts")"
[ "$actual_round" -eq "$round" ] \
  || human round_mismatch 'Dispatch round differs from current review history.'
[ "$actual_round" -le 2 ] \
  || human round_limit 'Automated review round limit was reached.'
if ! jq -e '.labels | index("ai-followup-in-progress") != null' <<< "$pr_facts" >/dev/null; then
  if [ "$(jq -r '.approved_head' <<< "$review_facts")" = true ]; then
    ignore duplicate_review 'Current HEAD already has an approving reviewer result.'
  fi
  human missing_machine_state 'Current PR lacks the follow-up in-progress label.'
fi

final_pr="$(gh api "repos/${repo}/pulls/${pr_number}")" \
  || human pr_unavailable 'Could not recheck the current PR.'
if ! jq -es --argjson number "$pr_number" '
  length == 1 and (.[0] | type == "object" and .number == $number
    and (.head.sha | type == "string" and test("^[0-9a-f]{40}$")))
' <<< "$final_pr" >/dev/null; then
  human invalid_pr 'Final PR metadata is invalid.'
fi
if [ "$(jq -r '.head.sha' <<< "$final_pr")" != "$validated_sha" ]; then
  ignore stale_head 'PR HEAD changed while evaluating the dispatch.'
fi
if ! jq -e --argjson before "$pr" '. == $before' <<< "$final_pr" >/dev/null; then
  human state_changed 'PR state changed while evaluating the dispatch.'
fi

emit proceed ready 'Current PR and dispatch state permit automated re-review.'
