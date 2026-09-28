#!/usr/bin/env bash
set -euo pipefail

# Called only inside the canonical Issue writer group, from the default branch.
repo="${1:?repository required}"
run_id="${2:?source run required}"
attempt="${3:?source attempt required}"
app_slug="${4:?trusted App slug required}"
pr="${5:?PR required}"
issue="${6:?closing Issue required}"
source="${7:?source pause required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "recover-ai-resume-review: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
[[ "$app_slug" =~ ^[A-Za-z0-9-]+$ ]] || fail 'invalid App slug'
for value in "$run_id" "$attempt" "$pr" "$issue" "$source"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail 'invalid numeric identity'
done
app_id="$(gh api "/apps/$app_slug" --jq .id)" || fail 'App identity unavailable'
[[ "$app_id" =~ ^[1-9][0-9]*$ ]] || fail 'invalid App identity'
prepare() {
  bash "$script_dir/prepare-ai-resume-review-recovery.sh" \
    "$repo" "$run_id" "$attempt" "$app_id" "$pr" "$issue" "$source"
}
plan="$(prepare)" || fail 'recovery facts unavailable'
result="$(jq -er '.result | select(IN("pre_acceptance","normal_review_owns","recover"))' \
  <<< "$plan")" || fail 'invalid recovery result'
if [ "$result" = normal_review_owns ]; then
  jq -e '.actions == []' <<< "$plan" >/dev/null || fail 'normal Review action mismatch'
  exit 0
fi

# A lost POST response is resolved by a fresh trusted graph read. Never retry
# an uncertain write: a later recovery invocation can recheck its outcome.
if jq -e 'any(.actions[]; .action == "create_or_reconcile_replacement_pause")' \
  <<< "$plan" >/dev/null; then
  [ "$result" = recover ] || fail 'replacement requested before acceptance'
  accepted="$(jq -er '.accepted_record_id | select(type == "string" and test("^[1-9][0-9]*$"))' \
    <<< "$plan")" || fail 'accepted identity unavailable'
  record="$(jq -cn --arg target "pr:$pr" --arg accepted "$accepted" \
    '{version:1,kind:"pause",reason:"resume_transition_failed",target:$target,
      source_pause_id:$accepted,payload:{failed_action:"review"}}')"
  body="$(bash "$script_dir/human-pause-record.sh" create "$record")" \
    || fail 'replacement record invalid'
  gh api -X POST "/repos/$repo/issues/$pr/comments" -f "body=$body" >/dev/null || true
  plan="$(prepare)" || fail 'replacement POST outcome cannot be reconciled'
  jq -e --arg accepted "$accepted" '
    .result == "recover" and .accepted_record_id == $accepted
    and (.replacement_pause_id | type == "string" and test("^[1-9][0-9]*$"))
    and (any(.actions[]; .action == "create_or_reconcile_replacement_pause" or
                              .action == "revalidate_record_graph") | not)
  ' <<< "$plan" >/dev/null || fail 'replacement is not uniquely active'
fi

# Re-read mutable facts after each write, applying only labels still missing.
for iteration in 1 2 3; do
  action="$(jq -er '
    if .result == "normal_review_owns" and .actions == [] then "done"
    elif (.result == "recover" or .result == "pre_acceptance") and
         (.actions | type) == "array" then
      if (.actions | length) == 0 then "done"
      elif ([.actions[] | select(.action == "add_issue_human_label" or
                                    .action == "add_pr_human_label")] | length) ==
           (.actions | length) then .actions[0].action
      else error("unexpected recovery action") end
    else error("invalid recovery state") end
  ' <<< "$plan")" || fail 'invalid recovery action'
  [ "$action" != done ] || exit 0
  case "$action" in
    add_issue_human_label) number="$issue" ;;
    add_pr_human_label) number="$pr" ;;
    *) fail 'unknown label action' ;;
  esac
  jq -e --argjson number "$number" '.actions[0].number == $number' \
    <<< "$plan" >/dev/null || fail 'label target mismatch'
  # The server may have applied the label even when its response was lost.
  # Reconcile once from fresh facts; never resend an uncertain write here.
  gh issue edit "$number" --repo "$repo" --add-label human-review-required \
    || true
  plan="$(prepare)" || fail 'label repair cannot be verified'
  jq -e --arg action "$action" --argjson number "$number" '
    any(.actions[]; .action == $action and .number == $number) | not
  ' <<< "$plan" >/dev/null || fail 'label repair is not confirmed'
done
fail 'recovery did not converge'
