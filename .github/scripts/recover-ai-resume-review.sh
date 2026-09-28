#!/usr/bin/env bash
set -euo pipefail
repo="${1:?repository required}"
run="${2:?run ID required}"
attempt="${3:?attempt required}"
app_slug="${4:?developer App slug required}"
pr="${5:?PR number required}"
issue="${6:?closing Issue number required}"
source="${7:?source pause ID required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "recover-ai-resume-review: $1" >&2; exit 1; }
for value in "$run" "$attempt" "$pr" "$issue" "$source"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail 'invalid recovery identity'
done
app_id="$(gh api "/apps/$app_slug" --jq .id)" || fail 'App identity unavailable'
[[ "$app_id" =~ ^[1-9][0-9]*$ ]] || fail 'invalid App identity'
prepare() {
  GH_TOKEN="${READ_TOKEN:-$GH_TOKEN}" bash "$script_dir/prepare-ai-resume-review-recovery.sh" \
    "$repo" "$run" "$attempt" "$app_id" "$pr" "$issue" "$source"
}
plan="$(prepare)" || fail 'trusted recovery decision unavailable'
case "$(jq -r .result <<< "$plan")" in
  normal_review_owns) exit 0 ;;
  undetermined) fail 'Review entry is undetermined; no ownership transfer or write' ;;
  pre_acceptance)
    # This consumer never removes labels before the accepted record. A bad
    # dispatch must not cause a recovery write before acceptance.
    jq -e '.actions == []' <<< "$plan" >/dev/null || fail 'pre-acceptance labels are inconsistent'
    exit 0 ;;
  recover) ;;
  *) fail 'unknown recovery decision' ;;
esac
if jq -e 'any(.actions[]; .action == "create_or_reconcile_replacement_pause")' <<< "$plan" >/dev/null; then
  accepted="$(jq -r .accepted_record_id <<< "$plan")"
  [[ "$accepted" =~ ^[1-9][0-9]*$ ]] || fail 'invalid accepted ID'
  record="$(jq -cn --arg accepted "$accepted" --arg pr "$pr" \
    '{version:1,kind:"pause",reason:"resume_transition_failed",target:("pr:"+$pr),
      source_pause_id:$accepted,payload:{failed_action:"review"}}')"
  body="$(bash "$script_dir/human-pause-record.sh" create "$record")" || fail 'invalid replacement record'
  # A lost response is reconciled through the prepared helper. Never repeat POST.
  gh api -X POST "/repos/$repo/issues/$pr/comments" -f "body=$body" >/dev/null || true
  plan="$(prepare)" || fail 'replacement record could not be reconciled'
  [ "$(jq -r .result <<< "$plan")" = recover ] || fail 'recovery ownership changed'
  jq -e '.replacement_pause_id | type == "string" and test("^[1-9][0-9]*$")' \
    <<< "$plan" >/dev/null || fail 'replacement pause not uniquely active'
fi
# Reconcile both labels after the replacement is confirmed. The common helper
# checks the closing Issue relation and makes repeated recovery harmless.
bash "$script_dir/apply-human-pause.sh" "$repo" "$issue" "$pr" || fail 'label sync failed'
plan="$(prepare)" || fail 'recovery confirmation unavailable'
[ "$(jq -r .result <<< "$plan")" = recover ] || fail 'recovery ownership changed after labels'
jq -e '.actions == [] and (.replacement_pause_id | type == "string")' \
  <<< "$plan" >/dev/null || fail 'replacement pause or labels unconfirmed'
