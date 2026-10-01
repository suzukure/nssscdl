#!/usr/bin/env bash
set -euo pipefail

# Run only in the canonical Issue writer, with a trusted default-branch helper.
repo="${1:?リポジトリ指定が必要です}"
app_id="${2:?App IDが必要です}"
issue="${3:?信頼済みclosing Issueの指定が必要です}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "consume-ai-resume-review: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ &&
   "$app_id" =~ ^[1-9][0-9]*$ && "$issue" =~ ^[1-9][0-9]*$ ]] || fail '識別情報が不正です'
dispatch="$(cat)" || fail 'dispatchを読み取れません'
candidate="$(bash "$script_dir/prepare-ai-resume-review-consumer.sh" "$repo" "$app_id" <<< "$dispatch")" \
  || fail '準備済みgateを利用できません'
case "$(jq -er '.result' <<< "$candidate")" in
  ignore) echo "ignore:$(jq -r .code <<< "$candidate")"; exit 0 ;;
  accepted_candidate) ;;
  *) fail '準備結果が不正です' ;;
esac
jq -e --argjson issue "$issue" '.identity.closing_issue_number == $issue' \
  <<< "$candidate" >/dev/null || fail '書き込み主体の識別情報が変化しました'
pr="$(jq -er '.identity.pr_number' <<< "$candidate")"
source="$(jq -er '.identity.source_pause_id' <<< "$candidate")"
head="$(jq -er '.identity.head' <<< "$candidate")"
record="$(jq -c '.accepted_record' <<< "$candidate")"
body="$(bash "$script_dir/human-pause-record.sh" create "$record")" || fail '記録を取得できません'
export AI_RESUME_MAX_HISTORY_PAGES=10

graph() {
  bash "$script_dir/list-human-pause-records.sh" "$repo" "$issue" "$pr" "$app_id" |
    bash "$script_dir/validate-human-pause-record-graph.sh" |
    bash "$script_dir/decompose-human-pause-record-graph.sh" |
    bash "$script_dir/derive-human-pause-pre-resume-state.sh" |
    bash "$script_dir/reconcile-human-pause-resume-acceptance.sh"
}
current() {
  local facts
  facts="$(gh api "/repos/$repo/pulls/$pr")" || return 1
  jq -e --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" --arg head "$head" '
    .number == $pr and .state == "open" and .draft == false
    and .head.repo.full_name == $repo and .base.repo.full_name == $repo
    and .head.ref == ("ai/issue-" + $issue) and .base.ref == "main"
    and .head.sha == $head
  ' <<< "$facts" >/dev/null
}
label() {
  local number="$1" facts
  facts="$(gh api "/repos/$repo/issues/$number")" || return 1
  jq -er --argjson number "$number" '
    if .number == $number and .state == "open" and (.labels | type) == "array"
       and all(.labels[]; type == "object" and (.name | type) == "string")
    then if any(.labels[]; .name == "human-review-required") then "present" else "absent" end
    else error("ラベルの現在情報が不正です") end
  ' <<< "$facts"
}
accepted_id() {
  jq -er --argjson record "$record" '
    [.chains[].records[] | select(.record == $record) | .pause_id]
    | if length == 1 then .[0] else error("受理記録がないか曖昧です") end
  ' <<< "$1"
}
verify_graph() {
  local state active id
  state="$(graph)" || return 1
  id="$(accepted_id "$state")" || return 1
  jq -e --arg source "$source" --arg id "$id" '
    [.chains[] | select(.effective.pause_id == $source and
      .effective.status == "consumed" and .effective.accepted_record_id == $id)]
    | length == 1
  ' <<< "$state" >/dev/null || return 1
  active="$(bash "$script_dir/reconcile-human-pause-active-pause.sh" <<< "$state")" || return 1
  jq -e --arg target "pr:$pr" '.target == $target and .result == "no_active_pause"' \
    <<< "$active" >/dev/null || return 1
  printf '%s\n' "$id"
}

# Review step names are trusted only when this PR leaves the workflow intact.
# Check the pinned HEAD before acceptance so Recovery can retain the source pause.
current || fail 'Reviewの信頼確認前に対象が変化しました'
files="$(gh api --paginate --slurp "/repos/$repo/pulls/$pr/files?per_page=100")" \
  || fail 'PRのファイル一覧を取得できません'
jq -e 'type == "array" and all(.[]; type == "array" and
  all(.[]; type == "object" and (.filename | type) == "string"))
  and (any(.[][]; .filename == ".github/workflows/claude-review.yml") | not)' \
  <<< "$files" >/dev/null || fail 'Review workflowの証拠を信頼できません'

# A failed POST may have committed. Re-list once and never repeat an uncertain write.
before="$(graph)" || fail '起点の記録グラフを取得できません'
if accepted_id "$before" >/dev/null 2>&1; then fail '受理記録が既に存在します'; fi
current && [ "$(label "$issue")" = present ] && [ "$(label "$pr")" = present ] \
  || fail '対象または停止ラベルが変化しました'
if ! posted="$(gh api -X POST "/repos/$repo/issues/$pr/comments" -f "body=$body")"; then
  echo '受理記録のPOST応答が不明です。信頼済みグラフを照合します' >&2
else
  jq -e '.id | type == "number" and floor == . and . > 0' <<< "$posted" >/dev/null \
    || fail '受理記録の応答が不正です'
fi
accepted="$(verify_graph)" || fail '受理記録またはグラフを確認できません'

# Each removal is followed by a fresh absence check, including response loss.
current && [ "$(label "$issue")" = present ] || fail 'Issueの遷移情報が変化しました'
if ! gh issue edit "$issue" --repo "$repo" --remove-label human-review-required; then
  echo 'Issueラベルの書き込み応答が不明です。現在の状態を確認します' >&2
fi
[ "$(label "$issue")" = absent ] || fail 'Issueラベルの解除を確認できません'
current && [ "$(verify_graph)" = "$accepted" ] && [ "$(label "$pr")" = present ] \
  || fail 'PRの遷移情報が変化しました'
if ! gh issue edit "$pr" --repo "$repo" --remove-label human-review-required; then
  echo 'PRラベルの書き込み応答が不明です。現在の状態を確認します' >&2
fi
current && [ "$(label "$issue")" = absent ] && [ "$(label "$pr")" = absent ] \
  || fail 'PRラベルの解除を確認できません'

# The App's PR-unlabeled event enters the existing normal Review. Observe the
# same HEAD's Review job and model-selection step; queued runs are not ownership.
accepted_fact="$(gh api "/repos/$repo/issues/comments/$accepted")" || fail '受理時刻を取得できません'
since="$(jq -er --argjson id "$accepted" --argjson app "$app_id" '
  select(.id == $id and .performed_via_github_app.id == $app)
  | .created_at | select(type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
' <<< "$accepted_fact")" || fail '受理記録の出所を確認できません'
for poll in {1..9}; do
  current || fail 'Reviewへの引継ぎ中にHEADが変化しました'
  runs="$(gh api --paginate --slurp "/repos/$repo/actions/workflows/claude-review.yml/runs?event=pull_request&per_page=100")" \
    || fail 'Review runを取得できません'
  candidates="$(jq -r --arg repo "$repo" --argjson pr "$pr" --arg issue "$issue" \
    --arg head "$head" --arg since "$since" '
    if type != "array" or any(.[]; (.workflow_runs | type) != "array") then error("run一覧が不正です") end
    | [.[] .workflow_runs[] | select(.name == "Claude Review" and .event == "pull_request"
      and (.path | type == "string" and test("^\\.github/workflows/claude-review\\.yml(@|$)"))
      and .head_repository.full_name == $repo and .head_sha == $head
      and .head_branch == ("ai/issue-" + $issue) and .created_at >= $since
      and any(.pull_requests[]?; .number == $pr and .head.sha == $head))]
    | unique_by(.id) | .[]
    | [.id,.run_attempt] | @tsv
  ' <<< "$runs")" || fail 'Reviewの識別情報が曖昧です'
  entered=0
  waiting=0
  while IFS=$'\t' read -r review_id review_attempt; do
    [ -n "$review_id" ] || continue
    [[ "$review_id" =~ ^[1-9][0-9]*$ && "$review_attempt" =~ ^[1-9][0-9]*$ ]] \
      || fail 'Review attemptが不正です'
    jobs="$(gh api --paginate --slurp \
      "/repos/$repo/actions/runs/$review_id/attempts/$review_attempt/jobs?per_page=100")" \
      || fail 'Review jobを取得できません'
    state="$(jq -er '
      if type != "array" or any(.[]; (.jobs | type) != "array") then error("job一覧が不正です") end
      | [.[] .jobs[] | select(.name == "Review")]
      | if length == 0 then "waiting"
        elif length != 1 then error("Review jobが一意ではありません")
        else .[0] | if (.conclusion | IN("failure","cancelled","timed_out","stale"))
          then "entered"
          elif .conclusion == "skipped" then "declined"
          else [.steps[]? | select(.name == "Select Claude review model")]
            | if length == 0 then "waiting"
              elif length != 1 then error("入口stepが一意ではありません")
              elif .[0].status == "in_progress" or
                   (.[0].conclusion | IN("success","failure","cancelled","timed_out"))
              then "entered"
              elif .[0].conclusion == "skipped" then "declined"
              else "waiting" end
          end end
    ' <<< "$jobs")" || fail 'Reviewの所有関係が曖昧です'
    case "$state" in
      entered) entered=$((entered + 1)); owner="$review_id" ;;
      waiting) waiting=$((waiting + 1)) ;;
      declined) ;;
    esac
  done <<< "$candidates"
  [ "$entered" -le 1 ] || fail '通常Reviewが複数開始されました'
  if [ "$entered" -eq 1 ] && [ "$waiting" -eq 0 ]; then
    echo "通常Reviewが処理を担当します。pr:$pr head:$head run:$owner"
    exit 0
  fi
  [ "$poll" -lt 9 ] || break
  sleep 10
done
fail '通常Reviewの開始を判定できません'
