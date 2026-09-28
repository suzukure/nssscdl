#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts" "$tmp/state"
cp "$root/.github/scripts/recover-ai-resume-review.sh" "$tmp/scripts/"
cat > "$tmp/scripts/prepare-ai-resume-review-recovery.sh" <<'STUB'
#!/usr/bin/env bash
case "$(cat "$GH_STATE/mode")" in
  pre_acceptance) echo '{"result":"pre_acceptance","actions":[]}' ;;
  normal_review_owns) echo '{"result":"normal_review_owns","actions":[]}' ;;
  undetermined) echo '{"result":"undetermined","actions":[]}' ;;
  recover)
    if [ ! -f "$GH_STATE/replacement" ]; then
      echo '{"result":"recover","accepted_record_id":"201","actions":[{"action":"create_or_reconcile_replacement_pause"}]}'
    elif [ ! -f "$GH_STATE/labels" ]; then
      echo '{"result":"recover","replacement_pause_id":"301","actions":[{"action":"add_issue_human_label"}]}'
    else
      echo '{"result":"recover","replacement_pause_id":"301","actions":[]}'
    fi ;;
esac
STUB
cat > "$tmp/scripts/human-pause-record.sh" <<'STUB'
#!/usr/bin/env bash
printf 'replacement-body\n'
STUB
cat > "$tmp/scripts/apply-human-pause.sh" <<'STUB'
#!/usr/bin/env bash
touch "$GH_STATE/labels"
STUB
export GH_STATE="$tmp/state" GH_LOG="$tmp/gh.log" GH_TOKEN=dummy
: > "$GH_LOG"
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$*" in
    'api /apps/dev --jq .id') echo 99 ;;
    'api -X POST /repos/owner/repo/issues/37/comments -f body=replacement-body')
      touch "$GH_STATE/replacement"
      [ "${LOSS_POST:-false}" = true ] && return 1
      echo '{"id":301}' ;;
    *) return 1 ;;
  esac
}
export -f gh
run() { bash "$tmp/scripts/recover-ai-resume-review.sh" owner/repo 500 2 dev 37 36 101; }
for loss in false true; do
  rm -f "$GH_STATE/replacement" "$GH_STATE/labels"
  printf 'recover' > "$GH_STATE/mode"
  : > "$GH_LOG"
  export LOSS_POST="$loss"
  run
  [ -f "$GH_STATE/replacement" ] && [ -f "$GH_STATE/labels" ]
  [ "$(grep -c 'api -X POST' "$GH_LOG")" = 1 ]
  run
  [ "$(grep -c 'api -X POST' "$GH_LOG")" = 1 ]
done
for mode in pre_acceptance normal_review_owns undetermined; do
  printf '%s' "$mode" > "$GH_STATE/mode"
  rm -f "$GH_STATE/labels"
  : > "$GH_LOG"
  if [ "$mode" = undetermined ]; then
    if run >/dev/null 2>&1; then exit 1; fi
  else run; fi
  ! grep -q 'api -X POST' "$GH_LOG"
  [ ! -f "$GH_STATE/labels" ]
done
grep -Fq 'workflow_run:' "$root/.github/workflows/ai-resume-review-recovery.yml"
echo 'recover-ai-resume-review fixture passed.'
