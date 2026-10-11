#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
cp "$root/.github/scripts/recover-ai-resume-validate.sh" \
  "$root/.github/scripts/prepare-ai-resume-validate-pause-record.sh" \
  "$root/.github/scripts/human-pause-record.sh" "$tmp/scripts/"
cat > "$tmp/scripts/prepare-ai-resume-validate-recovery.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" = 8 ] && [ "$8" = "$MOCK_EVIDENCE" ] || exit 1
mode="$(cat "$MOCK_MODE")"
issue_label="$(cat "$MOCK_ISSUE")"
pr_label="$(cat "$MOCK_PR")"
machine="$(cat "$MOCK_MACHINE")"
active="$(cat "$MOCK_ACTIVE")"
if [ -f "$MOCK_OVERRIDE" ]; then cat "$MOCK_OVERRIDE"; exit 0; fi
if [ "$mode" = oscillate ]; then
  writes="$(awk '/issue edit/{n++} END{print n+0}' "$MOCK_LOG")"
  jq -cn --argjson writes "$writes" '
    {result:"pre_acceptance",diagnostics:{
      target:{repository:"owner/repo",issue_number:36,pr_number:37},
      source:{run_id:500,attempt:2,pause_id:"101"},
      current:{issue_human_label:($writes % 2 == 1),pr_human_label:($writes % 2 == 0)}},
      actions:[if $writes % 2 == 0 then {action:"add_issue_human_label",number:36}
        else {action:"add_pr_human_label",number:37} end]}'
  exit 0
fi
jq -cn --arg mode "$mode" --argjson il "$issue_label" --argjson pl "$pr_label" \
  --argjson machine "$machine" --arg active "$active" '
  def labels: [if $il == false then {action:"add_issue_human_label",number:36} else empty end,
    if $pl == false then {action:"add_pr_human_label",number:37} else empty end];
  def removal: [if $machine then {action:"remove_machine_label",
    requires:"fresh graph active and both human labels present"} else empty end];
  def replacement: {action:"create_or_reconcile_replacement_pause",source_pause_id:"201",
    reason:"resume_transition_failed",failed_action:"validate"};
  def validation: {action:"create_or_reconcile_validation_pause",accepted_record_id:"201",
    paused_head:("a" * 40),reason:$mode};
  ({diagnostics:{target:{repository:"owner/repo",issue_number:36,pr_number:37},
    source:{run_id:500,attempt:2,pause_id:"101"},
    current:{head:("a" * 40),issue_human_label:$il,pr_human_label:$pl,
      machine_state:$machine,active_pause_id:(if $active == "none" then null else "301" end),
      active_pause_record:(if $active == "none" then null
        elif $active == "replacement" then {reason:"resume_transition_failed",
          source_pause_id:"201",payload:{failed_action:"validate"}}
        else {reason:$active,paused_head:("a" * 40),payload:{accepted_record_id:"201"}} end)}}})
  + (if $mode == "owner" then {result:"normal_review_owns",actions:[]}
    elif $mode == "wait" then {result:"cycle_wait",actions:[]}
    elif $mode == "manual" then {result:"manual_reconcile",code:"durable_validation_evidence_missing",actions:[]}
    elif $mode == "before" then {result:"pre_acceptance",actions:labels}
    elif $active != "none" then
      {result:"paused",accepted_record_id:"201",actions:(labels + removal)}
      + (if $active == "replacement" then {replacement_pause_id:"301"} else {active_pause_id:"301"} end)
    else {result:"recover",accepted_record_id:"201",
      actions:([if $mode == "replacement" then replacement else validation end,
        {action:"revalidate_record_graph",requires:(if $mode == "replacement" then
          "one matching active replacement pause" else "one active validation pause" end)}]
        + labels + removal)} end)'
STUB
export MOCK_MODE="$tmp/mode" MOCK_ISSUE="$tmp/issue" MOCK_PR="$tmp/pr" \
  MOCK_MACHINE="$tmp/machine" MOCK_ACTIVE="$tmp/active" MOCK_OVERRIDE="$tmp/override" \
  MOCK_LOG="$tmp/log" MOCK_EVIDENCE="$tmp/evidence" MOCK_LOSS=none MOCK_APPLY=true
printf x > "$MOCK_EVIDENCE"
gh() {
  printf '%s\n' "$*" >> "$MOCK_LOG"
  case "$*" in
    'api /apps/developer --jq .id') echo 99 ;;
    'api -X POST /repos/owner/repo/issues/37/comments '*)
      if [ "$MOCK_APPLY" = true ]; then
        record="$(printf '%s\n' "$*" | sed -n '/body=/,$p')"
        case "$record" in
          *'"reason":"resume_transition_failed"'*) printf replacement > "$MOCK_ACTIVE" ;;
          *'"reason":"validation_failed"'*) printf validation_failed > "$MOCK_ACTIVE" ;;
          *'"reason":"validation_timeout"'*) printf validation_timeout > "$MOCK_ACTIVE" ;;
          *'"reason":"round_limit"'*) printf round_limit > "$MOCK_ACTIVE" ;;
          *) return 1 ;;
        esac
      fi
      [ "$MOCK_LOSS" != post ] ;;
    'issue edit 36 --repo owner/repo --add-label human-review-required')
      [ "$MOCK_APPLY" != true ] || printf true > "$MOCK_ISSUE"
      [ "$MOCK_LOSS" != issue ] && [ "$MOCK_APPLY" = true ] ;;
    'issue edit 37 --repo owner/repo --add-label human-review-required')
      [ "$MOCK_APPLY" != true ] || printf true > "$MOCK_PR"
      [ "$MOCK_LOSS" != pr ] && [ "$MOCK_APPLY" = true ] ;;
    'issue edit 37 --repo owner/repo --remove-label ai-followup-in-progress')
      [ "$MOCK_APPLY" != true ] || printf false > "$MOCK_MACHINE"
      [ "$MOCK_LOSS" != machine ] && [ "$MOCK_APPLY" = true ] ;;
    *) echo "unexpected API: $*" >&2; return 1 ;;
  esac
}
export -f gh
run() { bash "$tmp/scripts/recover-ai-resume-validate.sh" owner/repo 500 2 developer 37 36 101 "$MOCK_EVIDENCE"; }
reset() {
  printf '%s' "$1" > "$MOCK_MODE"
  printf '%s' "${2:-true}" > "$MOCK_ISSUE"
  printf '%s' "${3:-true}" > "$MOCK_PR"
  printf '%s' "${4:-false}" > "$MOCK_MACHINE"
  printf '%s' "${5:-none}" > "$MOCK_ACTIVE"
  : > "$MOCK_LOG"
  rm -f "$MOCK_OVERRIDE"
  MOCK_LOSS=none MOCK_APPLY=true
  export MOCK_LOSS MOCK_APPLY
}
count() {
  local n rc
  if n="$(grep -Fc -- "$1" "$MOCK_LOG")"; then rc=0; else rc=$?; fi
  case "$rc" in
    0) [ "$n" = "$2" ] || { echo "Unexpected count: $1 ($n)" >&2; exit 1; } ;;
    1) [ "$2" = 0 ] || { echo "Missing write: $1" >&2; exit 1; } ;;
    *) echo 'Write log search failed.' >&2; exit 1 ;;
  esac
}
no_write() {
  count 'api -X POST' 0
  count 'issue edit' 0
}
reject() { if run > "$tmp/out" 2>&1; then echo 'Unsafe plan accepted.' >&2; exit 1; fi; }
for mode in owner wait; do reset "$mode"; run; no_write; done
reset replacement true true false replacement; run; no_write
reset before false false; run
count 'issue edit 36' 1; count 'issue edit 37' 1
reset replacement false false true
MOCK_LOSS=post; export MOCK_LOSS
run
count 'api -X POST' 1; count 'issue edit 36' 1; count 'issue edit 37 --repo owner/repo --add-label' 1
count 'issue edit 37 --repo owner/repo --remove-label' 1
awk '/issue edit 36/{issue=NR} /issue edit 37.*add-label/{pr=NR} /issue edit 37.*remove-label/{machine=NR}
  END{exit !(issue > 0 && issue < pr && pr < machine)}' "$MOCK_LOG"
for reason in validation_failed validation_timeout round_limit; do
  reset "$reason" false false true
  run
  count 'api -X POST' 1
  [ "$(cat "$MOCK_ACTIVE")" = "$reason" ]
done
reset replacement false false true
MOCK_APPLY=false; export MOCK_APPLY
reject
count 'api -X POST' 1; count 'issue edit' 0
for loss in issue pr machine; do
  reset replacement false false true replacement
  MOCK_LOSS="$loss"; export MOCK_LOSS
  run
  count "issue edit 36 --repo owner/repo --add-label" 1
  count "issue edit 37 --repo owner/repo --add-label" 1
  count "issue edit 37 --repo owner/repo --remove-label" 1
done
for failed in issue pr machine; do
  reset replacement false false true replacement
  MOCK_APPLY=false; export MOCK_APPLY
  if [ "$failed" = pr ]; then printf true > "$MOCK_ISSUE"; fi
  if [ "$failed" = machine ]; then printf true > "$MOCK_ISSUE"; printf true > "$MOCK_PR"; fi
  reject
  count 'issue edit' 1
done
reset manual
reject
no_write
grep -Fq 'durable_validation_evidence_missing' "$tmp/out"
for invalid in '{"result":"bogus","actions":[]}' \
  '{"result":"manual_reconcile","code":"x","actions":[{"action":"add_issue_human_label","number":36}]}' \
  '{"result":"recover","actions":[{"action":"revalidate_record_graph"}]}' ; do
  reset before
  printf '%s\n' "$invalid" > "$MOCK_OVERRIDE"
  reject; no_write
done
# A syntactically valid but out-of-order plan must also be rejected before writing.
reset before false false
bash "$tmp/scripts/prepare-ai-resume-validate-recovery.sh" owner/repo 500 2 99 37 36 101 "$MOCK_EVIDENCE" |
  jq '.actions |= reverse' > "$tmp/plan"
mv "$tmp/plan" "$MOCK_OVERRIDE"
reject; no_write
reset replacement false false true
bash "$tmp/scripts/prepare-ai-resume-validate-recovery.sh" owner/repo 500 2 99 37 36 101 "$MOCK_EVIDENCE" > "$tmp/base"
for filter in '.actions[0].reason = "unknown"' \
  '.actions[0].source_pause_id = "202"' \
  '.actions[1].requires = "unknown"' \
  '.actions[2].number = 37' \
  '.actions |= (.[1:] + [.[0]])' \
  '.actions[0].action = "create_or_reconcile_validation_pause"'; do
  jq "$filter" "$tmp/base" > "$MOCK_OVERRIDE"
  reject; no_write
done
# An adversarial helper that never changes its plan cannot cause a second write.
reset before false true
bash "$tmp/scripts/prepare-ai-resume-validate-recovery.sh" owner/repo 500 2 99 37 36 101 "$MOCK_EVIDENCE" > "$tmp/plan"
mv "$tmp/plan" "$MOCK_OVERRIDE"
reject
count 'issue edit 36' 1
reset oscillate
reject
count 'issue edit' 5
# The prepared caller has no production workflow entry, and the check itself fails closed.
check_dormant_workflows() {
  local directory="$1" workflow rc
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  local workflows=()
  shopt -s nullglob
  workflows=("$directory"/*.yml "$directory"/*.yaml)
  [ "${#workflows[@]}" -gt 0 ] || return 1
  for workflow in "${workflows[@]}"; do
    [ -f "$workflow" ] && [ -r "$workflow" ] && [ ! -L "$workflow" ] || return 1
    if grep -Eq 'recover-ai-resume-validate\.sh' "$workflow"; then rc=0; else rc=$?; fi
    case "$rc" in 0) return 1 ;; 1) ;; *) return 1 ;; esac
  done
}
check_dormant_workflows "$root/.github/workflows"
mkdir "$tmp/empty" "$tmp/invalid"
if check_dormant_workflows "$tmp/empty"; then exit 1; fi
printf 'run: recover-ai-resume-validate.sh\n' > "$tmp/invalid/reachable.yml"
if check_dormant_workflows "$tmp/invalid"; then exit 1; fi
if (grep() { return 127; }; check_dormant_workflows "$root/.github/workflows"); then exit 1; fi
echo 'recover-ai-resume-validate fixture passed.'
