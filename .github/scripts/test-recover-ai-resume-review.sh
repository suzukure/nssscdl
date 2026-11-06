#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/scripts"
cp "$root/.github/scripts/recover-ai-resume-review.sh" \
  "$root/.github/scripts/human-pause-record.sh" "$tmp/scripts/"
cat > "$tmp/scripts/prepare-ai-resume-review-recovery.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
state="$(cat "$MOCK_STATE")"
case "$state" in
  owner) echo '{"result":"normal_review_owns","actions":[]}' ;;
  before)
    jq -cn --argjson issue "$(cat "$MOCK_ISSUE_LABEL")" \
      --argjson pr "$(cat "$MOCK_PR_LABEL")" '
      {result:"pre_acceptance",actions:
        ([if $issue == false then {action:"add_issue_human_label",number:36} else empty end]
         + [if $pr == false then {action:"add_pr_human_label",number:37} else empty end])}' ;;
  *)
    jq -cn --arg state "$state" --argjson issue "$(cat "$MOCK_ISSUE_LABEL")" \
      --argjson pr "$(cat "$MOCK_PR_LABEL")" '
      {result:"recover",accepted_record_id:"201",
       actions:([if $state == "accepted" then
         {action:"create_or_reconcile_replacement_pause",source_pause_id:"201"},
         {action:"revalidate_record_graph"} else empty end]
         + [if $issue == false then {action:"add_issue_human_label",number:36} else empty end]
         + [if $pr == false then {action:"add_pr_human_label",number:37} else empty end])}
       + if $state == "replacement" then {replacement_pause_id:"301"} else {} end'
    ;;
esac
STUB
export MOCK_STATE="$tmp/state" MOCK_ISSUE_LABEL="$tmp/issue-label" \
  MOCK_PR_LABEL="$tmp/pr-label" MOCK_LOG="$tmp/gh.log" MOCK_LOSS=false \
  MOCK_NO_CREATE=false MOCK_LABEL_LOSS=none MOCK_LABEL_NO_WRITE=none
gh() {
  printf '%s\n' "$*" >> "$MOCK_LOG"
  case "$*" in
    'api /apps/developer --jq .id') echo 99 ;;
    'api -X POST /repos/owner/repo/issues/37/comments '*)
      [ "$MOCK_NO_CREATE" != true ] || return 1
      printf 'replacement' > "$MOCK_STATE"
      [ "$MOCK_LOSS" != true ] ;;
    'issue edit 36 --repo owner/repo --add-label human-review-required')
      [ "$MOCK_LABEL_NO_WRITE" != issue ] || return 1
      printf true > "$MOCK_ISSUE_LABEL"
      [ "$MOCK_LABEL_LOSS" != issue ] ;;
    'issue edit 37 --repo owner/repo --add-label human-review-required')
      [ "$MOCK_LABEL_NO_WRITE" != pr ] || return 1
      printf true > "$MOCK_PR_LABEL"
      [ "$MOCK_LABEL_LOSS" != pr ] ;;
    *) echo "Unexpected write: $*" >&2; return 1 ;;
  esac
}
export -f gh
run() { bash "$tmp/scripts/recover-ai-resume-review.sh" owner/repo 500 2 developer 37 36 101; }
assert_no_write() {
  local rc
  if grep -Eq 'api -X|issue edit' "$MOCK_LOG"; then rc=0; else rc=$?; fi
  case "$rc" in
    0) echo 'Unexpected repository write.' >&2; exit 1 ;;
    1) ;;
    *) echo 'Write log search failed.' >&2; exit 1 ;;
  esac
}
assert_write_count() {
  local count rc
  if count="$(grep -Fc -- "$1" "$MOCK_LOG")"; then rc=0; else rc=$?; fi
  case "$rc" in
    0) [ "$count" = "$2" ] || { echo "Unexpected write count for $1: $count" >&2; exit 1; } ;;
    1) [ "$2" = 0 ] || { echo "Missing write: $1" >&2; exit 1; } ;;
    *) echo 'Write log search failed.' >&2; exit 1 ;;
  esac
}
printf owner > "$MOCK_STATE"; printf true > "$MOCK_ISSUE_LABEL"
printf true > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
run
assert_no_write
printf before > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"
printf false > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
run
[ "$(cat "$MOCK_STATE")" = before ]
grep -Fq 'issue edit 36 --repo owner/repo --add-label human-review-required' "$MOCK_LOG"
grep -Fq 'issue edit 37 --repo owner/repo --add-label human-review-required' "$MOCK_LOG"
printf accepted > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"
printf false > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
MOCK_NO_CREATE=true; export MOCK_NO_CREATE
if run >/dev/null 2>&1; then
  echo 'Unconfirmed replacement POST was accepted.' >&2
  exit 1
fi
[ "$(cat "$MOCK_ISSUE_LABEL")" = false ]
[ "$(cat "$MOCK_PR_LABEL")" = false ]
MOCK_NO_CREATE=false; export MOCK_NO_CREATE
printf accepted > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"
printf false > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
MOCK_LOSS=true; export MOCK_LOSS
run
[ "$(cat "$MOCK_STATE")" = replacement ]
[ "$(cat "$MOCK_ISSUE_LABEL")" = true ]
[ "$(cat "$MOCK_PR_LABEL")" = true ]
assert_write_count 'api -X POST' 1
MOCK_LOSS=false; export MOCK_LOSS
: > "$MOCK_LOG"
run
assert_no_write

# A lost label response is reconciled from fresh facts without a second write.
printf replacement > "$MOCK_STATE"; printf false > "$MOCK_ISSUE_LABEL"
printf false > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
MOCK_LABEL_LOSS=issue; export MOCK_LABEL_LOSS
run
assert_write_count 'issue edit 36 --repo owner/repo --add-label human-review-required' 1
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 1
[ "$(cat "$MOCK_ISSUE_LABEL")" = true ]
[ "$(cat "$MOCK_PR_LABEL")" = true ]

printf true > "$MOCK_ISSUE_LABEL"; printf false > "$MOCK_PR_LABEL"
: > "$MOCK_LOG"
MOCK_LABEL_LOSS=pr; export MOCK_LABEL_LOSS
run
assert_write_count 'issue edit 36 --repo owner/repo --add-label human-review-required' 0
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 1
[ "$(cat "$MOCK_PR_LABEL")" = true ]

MOCK_LABEL_LOSS=none; MOCK_LABEL_NO_WRITE=issue
export MOCK_LABEL_LOSS MOCK_LABEL_NO_WRITE
printf false > "$MOCK_ISSUE_LABEL"; printf false > "$MOCK_PR_LABEL"
: > "$MOCK_LOG"
if run >/dev/null 2>&1; then
  echo 'Unconfirmed Issue label write was accepted.' >&2
  exit 1
fi
assert_write_count 'issue edit 36 --repo owner/repo --add-label human-review-required' 1
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 0
[ "$(cat "$MOCK_ISSUE_LABEL")" = false ]

MOCK_LABEL_NO_WRITE=pr; export MOCK_LABEL_NO_WRITE
printf true > "$MOCK_ISSUE_LABEL"; printf false > "$MOCK_PR_LABEL"
: > "$MOCK_LOG"
if run >/dev/null 2>&1; then
  echo 'Unconfirmed PR label write was accepted.' >&2
  exit 1
fi
assert_write_count 'issue edit 37 --repo owner/repo --add-label human-review-required' 1
[ "$(cat "$MOCK_PR_LABEL")" = false ]

MOCK_LABEL_NO_WRITE=none; export MOCK_LABEL_NO_WRITE
printf true > "$MOCK_PR_LABEL"; : > "$MOCK_LOG"
run
assert_no_write
workflow="$root/.github/workflows/ai-resume-review-recovery.yml"
grep -Fq 'workflows: [AI Resume Review Consumer]' "$workflow"
grep -Fq 'group: codex-writer-ai/issue-${{ needs.resolve.outputs.issue }}' "$workflow"
grep -Fq 'ref: ${{ github.event.repository.default_branch }}' "$workflow"
grep -Fq 'permission-issues: write' "$workflow"
grep -Fq 'permission-pull-requests: write' "$workflow"
echo 'recover-ai-resume-review fixture passed.'

# Exercise the exceptional consumer's real functions. Mock only process/API
# boundaries; record schema, listing provenance and lifecycle stages stay real.
python3 -I -B - "$root" <<'PY'
import ast
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

root = Path(sys.argv[1])
scripts = root / '.github/scripts'
text = (scripts / 'recover-pr1110-claude-pause.sh').read_text()
source = text.split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
tree = ast.parse(source)
assert isinstance(tree.body[-1], ast.Try)
tree.body.pop()  # Definitions only; each case invokes the actual main below.
with patch.object(sys, 'argv', ['-', 'apply', str(scripts)]):
    module = {}
    exec(compile(tree, '<recovery implementation>', 'exec'), module)

HEAD = '50ac09107c1d80fdcdbb03dc0e0a63e012be9137'
OLD = 'ad90e514aeac5789f7fdb4af600e6c3f60b6c4b1'
BASE = '17f63a0a9e9ebf2ecd03c1e9329f8200362aebc5'
ANCHOR = '637278268f8269d31187674c21adb69dc4f55aac'
PATCH_BASE = 'c9ed0a3c4e6963e1fece9d96d2c3588c38cd3107'
READ_FIX_BASE = '09759be3c42eb00b3120a4e777715d3c2a9b4bda'
AUTH_FIX_BASE = '035dfa0677fa980c204e500ab9420aae6ec8d67f'
CONTEXT_FIX_BASE = 'f4a152780f76d8cf8dfaa6143646e4cba93dfd45'
RESUME_FIX_BASE = '82a3ca6cfc394341eb4b9c8d8fcdb1a6e10ab496'
ADJUDICATED_RUN = 42033641429
PREVIOUS_APPLY_RUN = 42046727170
FAILED_REVIEW = 42158784510
TRUSTED_MAIN = '8888888888888888888888888888888888888888'
MERGED_TREE = '7777777777777777777777777777777777777777'
ANCHOR_PATHS = {
    '.github/scripts/recover-pr1110-claude-pause.sh',
    '.github/scripts/test-recover-ai-resume-review.sh',
    '.github/workflows/recover-pr1110-claude-pause.yml',
    'docs/30_operations/ai-development-workflow.md',
}
PATCH_PATHS = {
    '.github/scripts/recover-pr1110-claude-pause.sh',
    '.github/scripts/test-recover-ai-resume-review.sh',
    'docs/30_operations/ai-development-workflow.md',
}
CURRENT_PATHS = PATCH_PATHS | {'.github/workflows/claude-review.yml'}
CONTEXT_PATHS = PATCH_PATHS | {'.github/scripts/build-review-context.sh',
                              '.github/scripts/test-build-review-context.sh'}
PARENT = '5cc1448038e0963b6bb826b53f44870376fc94c4'
REPO = 'suzukure/nssscdl'
BRANCH = 'docs/issue-1108-student-booking-ux-contract'
ACCEPTED = {'version': 1, 'kind': 'ai-resume-accepted', 'reason': 'claude_execution_failed',
            'target': 'pr:1110', 'source_pause_id': '6676369307', 'paused_head': HEAD,
            'payload': {'action': 'review', 'recovery_issue': 1111}}
PREVIOUS_ACCEPTED = dict(ACCEPTED, source_pause_id='6625324624')
SECOND_ACCEPTED = dict(ACCEPTED, source_pause_id='6660775078')
PREVIOUS_PAUSE = {'version': 1, 'kind': 'pause', 'reason': 'claude_execution_failed',
    'target': 'pr:1110', 'paused_head': OLD,
    'payload': {'detail': 'Claude Review jobが正常完了しませんでした。実行結果を確認してください。'}}
# Independent inventory from Issue #1109 and Checkpoint #6626149389.
paths = ['docs/00_requirements/' + p for p in (
    '00_RevisionHistory.md', '04_FunctionalRequirements.md', '07_TraceabilityMatrix.md', 'validation_report.json')]
paths += ['docs/20_detailed_design/01_StudentReservationApplication.md']
paths += ['docs/40_test/' + p for p in ('01_TestPlan.md', '02_FunctionalTestSpecification.md',
    '04_RequirementsTestTraceability.md', '04b_BulkReservationTraceability.md', 'README.md')]
paths += ['docs/diagrams/' + p for p in ('plantuml/c4-student-reservation-components.puml',
    'plantuml/student-reservation-sequence.puml', 'rendered/c4-student-reservation-components.svg',
    'rendered/student-reservation-sequence.svg')]


def record_comment(id, record, app=4777865):
    return {'id': id, 'performed_via_github_app': {'id': app},
            'created_at': {6625324624: '2026-11-04T07:34:10Z',
                           6660744739: '2026-11-05T14:38:36Z',
                           6660775078: '2026-11-05T14:39:58Z',
                           6676352162: '2026-11-06T03:48:48Z',
                           6676369307: '2026-11-06T03:50:08Z'}.get(id, '2026-11-06T04:00:00Z'),
            'body': '<!-- ai-human-pause-record:start -->\n' + json.dumps(record)
                    + '\n<!-- ai-human-pause-record:end -->'}


class Crash(BaseException):
    pass


real_run = subprocess.run
count = 0


class Case:
    def __init__(self, fault=''):
        self.fault = fault
        self.comments = [record_comment(6676369307, {'version': 1, 'kind': 'pause',
            'reason': 'claude_execution_failed', 'target': 'pr:1110', 'paused_head': HEAD}),
            record_comment(6625324624, PREVIOUS_PAUSE), record_comment(6660744739, PREVIOUS_ACCEPTED),
            record_comment(6660775078, dict(PREVIOUS_PAUSE, paused_head=HEAD)),
            record_comment(6676352162, SECOND_ACCEPTED)]
        self.label = {1109: True, 1110: True}
        self.writes = []
        self.builder = 0
        self.reads = []
        self.owner = 'entered'
        self.pr = {'number': 1110, 'state': 'open', 'draft': False, 'changed_files': 14,
                   'head': {'sha': HEAD, 'ref': BRANCH, 'repo': {'full_name': REPO}},
                   'base': {'sha': BASE, 'ref': 'main', 'repo': {'full_name': REPO}}}
        self.run = {'id': 800, 'run_number': 8, 'run_attempt': 1,
                    'path': '.github/workflows/recover-pr1110-claude-pause.yml',
                    'event': 'workflow_dispatch', 'head_repository': {'full_name': REPO}}
        if fault == 'app': self.comments[0]['performed_via_github_app']['id'] = 4777726
        if fault == 'source-id': self.comments[0]['id'] = 123
        if fault == 'old-head': self.comments[0]['body'] = self.comments[0]['body'].replace(HEAD, OLD)
        if fault == 'reason': self.comments[0]['body'] = self.comments[0]['body'].replace('claude_execution_failed', 'state_inconsistent')
        if fault == 'target': self.comments[0]['body'] = self.comments[0]['body'].replace('pr:1110', 'pr:1112')
        if fault == 'schema': self.comments[0]['body'] = self.comments[0]['body'].replace('"version": 1', '"version": 99')
        if fault == 'head': self.pr['head']['sha'] = OLD
        if fault == 'pr-base': self.pr['base']['sha'] = TRUSTED_MAIN
        if fault == 'branch': self.pr['head']['ref'] = 'ai/issue-1109'
        if fault == 'fork': self.pr['head']['repo']['full_name'] = 'other/repo'
        if fault == 'draft': self.pr['draft'] = True
        if fault == 'closed': self.pr['state'] = 'closed'
        if fault == 'missing-label': self.label[1109] = False
        if fault == 'multiple-active':
            self.comments.append(record_comment(42, {'version': 1, 'kind': 'pause',
                'reason': 'state_inconsistent', 'target': 'pr:1110'}))
        if fault == 'broken-graph':
            self.comments.append(record_comment(43, ACCEPTED))
            self.comments[-1]['body'] = self.comments[-1]['body'].replace('6676369307', '999')
        if fault == 'previous-source-missing': self.comments.pop(1)
        if fault == 'previous-accepted-missing': self.comments.pop(2)
        if fault == 'previous-accepted-id': self.comments[2]['id'] = 6660744740
        if fault == 'previous-accepted-body': self.comments[2]['body'] = self.comments[2]['body'].replace('1111', '1112')
        if fault == 'previous-source-head': self.comments[1]['body'] = self.comments[1]['body'].replace(OLD, HEAD)
        if fault == 'previous-accepted-app': self.comments[2]['performed_via_github_app'] = None
        if fault == 'previous-record-duplicate': self.comments.append(deepcopy(self.comments[2]))
        if fault == 'old-accepted-only': self.comments.pop(0)
        if fault == 'source-before-failure': self.comments[0]['created_at'] = '2026-11-05T14:38:40Z'
        if fault == 'previous-accepted-late': self.comments[2]['created_at'] = '2026-11-05T14:39:00Z'
        if fault == 'second-source-missing': self.comments.pop(3)
        if fault == 'second-accepted-missing': self.comments.pop(4)
        if fault == 'second-accepted-id': self.comments[4]['id'] = 999
        if fault == 'second-accepted-app': self.comments[4]['performed_via_github_app'] = None
        if fault == 'second-accepted-body': self.comments[4]['body'] = self.comments[4]['body'].replace('1111', '1112')
        if fault == 'second-source-head': self.comments[3]['body'] = self.comments[3]['body'].replace(HEAD, OLD)
        if fault == 'second-accepted-late': self.comments[4]['created_at'] = '2026-11-06T03:49:30Z'
        if fault == 'source-time-invalid': self.comments[0]['created_at'] = 'not-a-time'

    def api(self, path):
        self.reads.append(path)
        page = int(path.rsplit('page=', 1)[1]) if 'page=' in path else 1
        query = path.split('?', 1)[1] if '?' in path else ''
        path = path.split('?', 1)[0]
        if path == '': return {'default_branch': 'main'}
        if path == 'collaborators/suzukure/permission':
            return {'user': {'login': 'suzukure'}, 'permission': 'read' if self.fault == 'permission' else 'admin'}
        if path == 'git/ref/heads/main':
            drift = self.fault == 'main-before' or (self.writes and self.fault == 'base-drift')
            return {'object': {'sha': OLD if drift else TRUSTED_MAIN}}
        if path == 'pulls/1110':
            value = deepcopy(self.pr)
            if self.writes and self.fault == 'head-after-post': value['head']['sha'] = OLD
            if len(self.writes) >= 2 and self.fault == 'head-after-issue': value['head']['sha'] = OLD
            return value
        if path.startswith('issues/comments/'):
            raise AssertionError('single-comment endpoint must not be used')
        if path == 'issues/1110/comments':
            if self.fault == 'list-api':
                raise subprocess.CalledProcessError(1, ['gh', 'api'], stderr='SECRET_API_BODY')
            if self.fault == 'list-bound': return [{}] * 100
            if self.fault == 'list-shape': return {}
            value = deepcopy(self.comments)
            if self.fault == 'list-missing': value = []
            if self.fault == 'list-duplicate': value += deepcopy(value)
            if self.fault == 'list-nonobject': value += [None]
            for comment in value:
                if not isinstance(comment, dict): continue
                if comment['id'] == 6676369307:
                    if self.fault == 'list-app-null': comment['performed_via_github_app'] = None
                    if self.fault == 'list-app-missing': del comment['performed_via_github_app']
                    if self.fault == 'list-app-wrong': comment['performed_via_github_app']['id'] = 4777726
                    if self.fault == 'list-app-type': comment['performed_via_github_app']['id'] = '4777865'
                    if self.fault == 'list-id-type': comment['id'] = '6676369307'
                    if self.fault == 'list-body': comment['body'] = 'SECRET_INVALID_BODY'
                    if self.fault == 'list-target': comment['body'] = comment['body'].replace('pr:1110', 'pr:1112')
                    if self.fault == 'source-body-drift':
                        comment['body'] = comment['body'].replace('"kind": "pause"',
                            '"payload": {"detail": "changed"}, "kind": "pause"')
                if comment['id'] == 700:
                    if self.fault == 'accepted-app-null': comment['performed_via_github_app'] = None
                    if self.fault == 'accepted-app-wrong': comment['performed_via_github_app']['id'] = 4777726
                    if self.fault == 'accepted-body': comment['body'] = comment['body'].replace('1111', '1112')
                    if self.fault == 'accepted-time-missing': del comment['created_at']
                    if self.fault == 'accepted-time-type': comment['created_at'] = 42
                    if self.fault == 'accepted-time-invalid': comment['created_at'] = '2026-02-30T10:00:00Z'
                    if self.fault == 'accepted-time-offset': comment['created_at'] = '2026-11-05T14:41:00+00:00'
                    if self.fault == 'accepted-time-late': comment['created_at'] = '2026-11-06T04:02:00Z'
            if self.fault == 'list-second-page':
                value = [{'id': n + 10000} for n in range(100)] + value
            return value[(page - 1) * 100:page * 100]
        if path in ('issues/1109', 'issues/1110'):
            number = int(path.split('/')[1])
            return {'number': number, 'state': 'open', 'labels':
                    [{'name': 'human-review-required'}] if self.label[number] else []}
        if path == 'pulls/1110/files':
            return [{'filename': p, 'status': 'modified'} for p in
                    (paths[:-1] + ['.github/workflows/claude-review.yml'] if self.fault == 'files' else paths)]
        if path == 'pulls/1110/reviews': return [{}] if self.fault == 'verdict' else []
        if path == 'commits/' + BASE: return {'commit': {'committer': {'date': '2026-10-30T07:51:29Z'}}}
        if path == 'actions/runs/42047011487':
            return {'id': 42047011487, 'workflow_id': 346485833,
                    'path': '.github/workflows/claude-review.yml', 'event': 'pull_request',
                    'head_branch': BRANCH, 'head_repository': {'full_name': REPO}, 'head_sha': HEAD,
                    'created_at': '2026-11-05T14:38:47Z', 'updated_at': '2026-11-05T14:39:06Z',
                    'status': 'completed', 'run_attempt': 1, 'conclusion': 'failure',
                    'pull_requests': [{'number': 1110, 'head': {'sha': HEAD}}]}
        if path == 'actions/runs/42047011487/attempts/1/jobs':
            return {'total_count': 1, 'jobs': [{'name': 'Review', 'id': 127312601026,
                'status': 'completed', 'conclusion': 'failure', 'steps': [
                {'name': n, 'status': 'completed', 'conclusion': c} for n, c in (
                ('Build review context', 'failure'), ('Select Claude review model', 'skipped'),
                ('Run Claude review', 'skipped'), ('Submit reviewer verdict', 'skipped'))]}]}
        if path == 'actions/runs/42158784510':
            value = {'id': FAILED_REVIEW, 'workflow_id': 346485833,
                    'path': '.github/workflows/claude-review.yml', 'event': 'pull_request',
                    'head_branch': BRANCH, 'head_repository': {'full_name': REPO}, 'head_sha': HEAD,
                    'created_at': '2026-11-06T03:48:57Z', 'updated_at': '2026-11-06T03:49:52Z',
                    'status': 'completed', 'run_attempt': 1, 'conclusion': 'failure',
                    'pull_requests': [{'number': 1110, 'head': {'sha': HEAD}}]}
            if self.fault == 'failed-head': value['head_sha'] = OLD
            if self.fault == 'failed-id': value['id'] = 999
            if self.fault == 'failed-attempt': value['run_attempt'] = 2
            if self.fault == 'failed-workflow': value['workflow_id'] = 999
            if self.fault == 'failed-not-complete': value['status'] = 'in_progress'
            if self.fault == 'failed-time-invalid': value['created_at'] = 42
            return value
        if path == 'actions/runs/42158784510/attempts/1/jobs':
            steps = [{'name': n, 'status': 'completed', 'conclusion': c} for n, c in (
                ('Build review context', 'success'), ('Gate Claude review entry', 'success'),
                ('Select Claude review model', 'success'), ('Prepare native review schema', 'success'),
                ('Run Claude review', 'success'), ('Validate Claude review', 'success'),
                ('Save structured review', 'failure'), ('Submit reviewer verdict', 'skipped'),
                ('Post Create developer App token for identity allowlist', 'success'),
                ('Post Create reviewer App token', 'success'))]
            if self.fault == 'model-ran': steps[6]['conclusion'] = 'success'
            if self.fault == 'failed-step-duplicate': steps.append(deepcopy(steps[0]))
            if self.fault == 'failed-step-missing': steps.pop()
            if self.fault == 'failed-step-running': steps[0]['status'] = 'in_progress'
            return {'total_count': 1, 'jobs': [{'name': 'Review', 'steps': steps,
                    'id': 123 if self.fault == 'failed-job-id' else 127699190932,
                    'status': 'completed', 'conclusion': 'failure'}]}
        if path == 'actions/runs':
            runs = [{'id': n, 'path': '.github/workflows/' + w, 'event': 'pull_request',
                     'head_sha': HEAD, 'head_repository': {'full_name': REPO},
                     'pull_requests': [{'number': 1110, 'head': {'sha': HEAD}, 'base': {'sha': BASE}}],
                     'status': 'completed', 'conclusion': 'success', 'created_at': '2026-11-04T07:45:00Z'}
                    for n, w in enumerate(('product-ci.yml', 'traceability-check.yml'), 1)]
            if self.fault == 'ci': runs[0]['conclusion'] = 'failure'
            if self.fault == 'stale-ci': runs[0]['created_at'] = '2026-10-29T00:00:00Z'
            if self.fault == 'base-ci': runs[0]['pull_requests'][0]['base']['sha'] = OLD
            runs.append(self.api('actions/runs/42047011487'))
            runs.append(self.api('actions/runs/42158784510'))
            if 'event=pull_request' in query:
                assert ('head_sha=' + HEAD) in query, 'ownership query must bind HEAD at the API'
                if self.owner != 'none':
                    runs.append({'id': 900, 'head_sha': HEAD, 'head_branch': BRANCH,
                        'created_at': '2026-11-06T04:01:00Z', 'event': 'pull_request', 'run_attempt': 1,
                        'path': '.github/workflows/claude-review.yml', 'head_repository': {'full_name': REPO},
                        'pull_requests': [{'number': 1110, 'head': {'sha': HEAD}}]})
                    candidate = runs[-1]
                    if self.owner == 'duplicate': runs.append(dict(candidate, id=901))
                    if self.owner == 'rerun': candidate['run_attempt'] = 2
                    if self.owner == 'old': candidate['created_at'] = '2026-11-06T03:49:00Z'
                    if self.owner == 'wrong-pr': candidate['pull_requests'][0]['number'] = 1112
                    if self.owner == 'wrong-branch': candidate['head_branch'] = 'other'
                    if self.owner == 'wrong-head': candidate['head_sha'] = OLD
                    if self.owner == 'wrong-repo': candidate['head_repository']['full_name'] = 'other/repo'
                    if self.owner == 'wrong-workflow': candidate['path'] = '.github/workflows/product-ci.yml'
                # Other PRs can grow without changing this API's scoped result.
                # The unscoped workflow endpoint below is deliberately forbidden.
            else:
                assert 'head_sha=' + HEAD in query
            if self.fault == 'extra-review': runs.append(dict(runs[-1], id=901))
            if self.fault == 'truncated-api': return {'total_count': len(runs) + 1, 'workflow_runs': runs}
            return {'total_count': len(runs), 'workflow_runs': runs}
        if path == 'actions/runs/41793316677':
            return {'path': '.github/workflows/render-plantuml.yml', 'event': 'push',
                    'conclusion': 'failure' if self.fault == 'renderer' else 'success',
                    'head_repository': {'full_name': REPO}, 'head_branch': BRANCH,
                    'run_attempt': 1, 'head_sha': PARENT}
        if path == 'actions/runs/42033641429':
            value = {'id': ADJUDICATED_RUN, 'run_number': 3, 'run_attempt': 1,
                'workflow_id': 407813204, 'path': '.github/workflows/recover-pr1110-claude-pause.yml',
                'event': 'workflow_dispatch', 'head_branch': 'main', 'head_sha': READ_FIX_BASE,
                'head_repository': {'full_name': REPO}, 'actor': {'login': 'suzukure'},
                'triggering_actor': {'login': 'suzukure'}, 'status': 'completed', 'conclusion': 'failure'}
            if self.fault == 'retired-head': value['head_sha'] = PATCH_BASE
            if self.fault == 'retired-actor': value['triggering_actor']['login'] = 'other'
            if self.fault == 'retired-number': value['run_number'] = 2
            if self.fault == 'retired-rerun': value['run_attempt'] = 2
            if self.fault == 'retired-workflow': value['workflow_id'] = 999
            if self.fault == 'retired-repo': value['head_repository']['full_name'] = 'other/repo'
            if self.fault == 'retired-result': value['conclusion'] = 'success'
            return value
        if path == 'actions/runs/42033641429/attempts/1/jobs':
            def step(name, result): return {'name': name, 'status': 'completed', 'conclusion': result}
            jobs = [
                {'id': 127266077905, 'name': 'Read-only qualification', 'status': 'completed',
                 'started_at': '2026-11-05T13:12:00Z', 'conclusion': 'success',
                 'steps': [step('Check fixed recovery target', 'success')]},
                {'id': 127266269509, 'name': 'Apply fixed recovery', 'status': 'completed',
                 'started_at': '2026-11-05T13:12:33Z', 'conclusion': 'failure',
                 'steps': [step('Recheck after writer wait', 'success'),
                    step('Create reviewer App token', 'success'), step('Consume and hand off once', 'failure'),
                    step('Post Create reviewer App token', 'success')]},
            ]
            if self.fault == 'retired-job-id': jobs[1]['id'] = 123
            if self.fault == 'retired-check': jobs[0]['conclusion'] = 'failure'
            if self.fault == 'retired-recheck': jobs[1]['steps'][0]['conclusion'] = 'failure'
            if self.fault == 'retired-token': jobs[1]['steps'][1]['conclusion'] = 'failure'
            if self.fault == 'retired-consume': jobs[1]['steps'][2]['conclusion'] = 'success'
            if self.fault == 'retired-cleanup': jobs[1]['steps'][3]['conclusion'] = 'failure'
            if self.fault == 'retired-step-duplicate': jobs[1]['steps'].append(deepcopy(jobs[1]['steps'][0]))
            if self.fault == 'retired-step-missing': jobs[1]['steps'].pop()
            if self.fault == 'retired-jobs-missing': jobs.pop()
            return {'total_count': len(jobs), 'jobs': jobs}
        if path == 'actions/runs/42046727170':
            value = {'id': PREVIOUS_APPLY_RUN, 'run_number': 5, 'run_attempt': 1,
                'workflow_id': 407813204, 'path': '.github/workflows/recover-pr1110-claude-pause.yml',
                'event': 'workflow_dispatch', 'head_branch': 'main', 'head_sha': AUTH_FIX_BASE,
                'head_repository': {'full_name': REPO}, 'actor': {'login': 'suzukure'},
                'triggering_actor': {'login': 'suzukure'}, 'status': 'completed', 'conclusion': 'failure'}
            if self.fault == 'previous-run-id': value['id'] = 999
            if self.fault == 'previous-run-head': value['head_sha'] = READ_FIX_BASE
            if self.fault == 'previous-run-actor': value['actor']['login'] = 'other'
            if self.fault == 'previous-run-attempt': value['run_attempt'] = 2
            if self.fault == 'previous-run-result': value['conclusion'] = 'success'
            return value
        if path == 'actions/runs/42046727170/attempts/1/jobs':
            def step(name, result='success'):
                return {'name': name, 'status': 'completed', 'conclusion': result}
            value = [
                {'id': 127311590060, 'name': 'Read-only qualification', 'status': 'completed',
                 'started_at': '2026-11-05T14:37:01Z', 'conclusion': 'success', 'steps': [
                    step('Check fixed recovery target'), step('Authenticate reviewer identity with read-only token'),
                    step('Verify authenticated reviewer identity'), step('Post Authenticate reviewer identity with read-only token')]},
                {'id': 127311939569, 'name': 'Apply fixed recovery', 'status': 'completed',
                 'started_at': '2026-11-05T14:37:40Z', 'conclusion': 'failure', 'steps': [
                    step('Recheck after writer wait'), step('Create reviewer App token'),
                    step('Consume and hand off once', 'failure'), step('Post Create reviewer App token')]},
            ]
            if self.fault == 'previous-job-id': value[1]['id'] = 999
            if self.fault == 'previous-job-state': value[1]['status'] = 'in_progress'
            if self.fault == 'previous-read-identity': value[0]['steps'][2]['conclusion'] = 'failure'
            if self.fault == 'previous-read-cleanup': value[0]['steps'][3]['conclusion'] = 'failure'
            if self.fault == 'previous-recheck': value[1]['steps'][0]['conclusion'] = 'failure'
            if self.fault == 'previous-token': value[1]['steps'][1]['conclusion'] = 'failure'
            if self.fault == 'previous-consume': value[1]['steps'][2]['conclusion'] = 'success'
            if self.fault == 'previous-cleanup': value[1]['steps'][3]['conclusion'] = 'failure'
            if self.fault == 'previous-step-duplicate': value[1]['steps'].append(deepcopy(value[1]['steps'][0]))
            if self.fault == 'previous-step-missing': value[1]['steps'].pop()
            if self.fault == 'previous-jobs-missing': value.pop()
            return {'total_count': len(value), 'jobs': value}
        if path == 'actions/runs/42158645486':
            value = self.api('actions/runs/42046727170')
            value.update(id=42158645486, run_number=7, head_sha=RESUME_FIX_BASE)
            if self.fault == 'latest-run-head': value['head_sha'] = CONTEXT_FIX_BASE
            if self.fault == 'latest-run-actor': value['actor']['login'] = 'other'
            if self.fault == 'latest-run-attempt': value['run_attempt'] = 2
            return value
        if path == 'actions/runs/42158645486/attempts/1/jobs':
            value = self.api('actions/runs/42046727170/attempts/1/jobs')
            value['jobs'][0]['id'] = 127698737202
            value['jobs'][1]['id'] = 127698881204
            if self.fault == 'latest-job-id': value['jobs'][1]['id'] = 999
            if self.fault == 'latest-read-cleanup': value['jobs'][0]['steps'][-1]['conclusion'] = 'failure'
            if self.fault == 'latest-write-cleanup': value['jobs'][1]['steps'][-1]['conclusion'] = 'failure'
            return value
        if path == 'actions/workflows/recover-pr1110-claude-pause.yml/runs':
            if self.fault == 'history-api':
                raise subprocess.CalledProcessError(1, ['gh', 'api'], stderr='SECRET_HISTORY')
            runs = [deepcopy(self.run), dict(self.run, id=ADJUDICATED_RUN, run_number=3),
                    dict(self.run, id=PREVIOUS_APPLY_RUN, run_number=5),
                    dict(self.run, id=42155234932, run_number=6),
                    dict(self.run, id=42158645486, run_number=7),
                    dict(self.run, id=42046054836, run_number=4),
                    dict(self.run, id=42032705936, run_number=2), dict(self.run, id=42006744571, run_number=1)]
            if self.fault == 'retired-missing': runs.pop(1)
            if self.fault == 'retired-zero-attempt': runs[1]['run_attempt'] = 0
            if self.fault == 'retired-attempt-type': runs[1]['run_attempt'] = '1'
            if self.fault in ('prior-apply', 'check-before-apply', 'deleted-history'):
                runs[0]['run_number'] = 9
                if self.fault != 'deleted-history':
                    runs.append(dict(self.run, id=799, run_number=8))
            if self.fault == 'previous-history-missing': runs.pop(2)
            if self.fault == 'previous-history-rerun': runs[2]['run_attempt'] = 2
            if self.fault == 'prefix-id-changed': runs[-3]['id'] = 123
            return {'total_count': len(runs), 'workflow_runs': runs}
        if path in ('actions/runs/42006744571/attempts/1/jobs',
                    'actions/runs/42032705936/attempts/1/jobs',
                    'actions/runs/42046054836/attempts/1/jobs',
                    'actions/runs/42155234932/attempts/1/jobs'):
            if self.fault == 'job-history-empty': return {'total_count': 0, 'jobs': []}
            return {'total_count': 1, 'jobs': [{'name': 'Apply fixed recovery',
                'started_at': '2026-11-05T10:00:00Z', 'conclusion': 'skipped'}]}
        if path == 'actions/runs/799/attempts/1/jobs':
            return {'total_count': 1, 'jobs': [{'name': 'Apply fixed recovery',
                'started_at': '2026-11-04T09:00:00Z',
                'conclusion': 'skipped' if self.fault == 'check-before-apply' else 'cancelled'}]}
        if path == 'actions/workflows/claude-review.yml/runs':
            raise AssertionError('unscoped Review history must not be fetched')
        if path == 'actions/runs/900/attempts/1/jobs':
            steps = [{'name': 'Select Claude review model', 'status': 'completed', 'conclusion': 'success'},
                     {'name': 'Run Claude review', 'status': 'in_progress', 'conclusion': None},
                     {'name': 'Save structured review', 'status': 'queued', 'conclusion': None}]
            if self.owner in ('queued', 'model-only'):
                steps[1]['status'] = 'queued'
            if self.owner in ('outer-success', 'saved', 'invalid-output'):
                steps[1].update(status='completed', conclusion='success')
            if self.owner == 'saved': steps[2].update(status='completed', conclusion='success')
            if self.owner == 'invalid-output': steps[2].update(status='completed', conclusion='failure')
            if self.owner == 'duplicate-step': steps.append(deepcopy(steps[1]))
            return {'total_count': 1, 'jobs': [{'name': 'Review', 'status': 'in_progress',
                'conclusion': 'failure' if self.owner == 'failed' else None, 'steps': steps}]}
        raise AssertionError('unexpected API: ' + path)

    def process(self, args, **kw):
        env = kw.get('env') or os.environ
        def result(value='', rc=0):
            value = value if isinstance(value, str) else json.dumps(value)
            if rc and kw.get('check'): raise subprocess.CalledProcessError(rc, args)
            return subprocess.CompletedProcess(args, rc, value, '')
        if args[0] == 'gh':
            if '-X' in args:
                assert env['GH_TOKEN'] == 'mock-write'
                method = args[args.index('-X') + 1]
                path = args[4].split('/' + REPO + '/', 1)[1]
                self.writes.append((method, path))
                if method == 'POST':
                    body = args[-1].split('=', 1)[1]
                    parsed = json.loads(body.split('\n')[1])
                    assert parsed == ACCEPTED
                    assert self.label == {1109: True, 1110: True}
                    if self.fault != 'post-no-commit': self.comments.append(record_comment(700, parsed))
                    if self.fault == 'source-after-post':
                        self.comments[0]['body'] = self.comments[0]['body'].replace('"kind": "pause"',
                            '"payload": {"detail": "changed"}, "kind": "pause"')
                    if self.fault == 'crash-post': raise Crash()
                    return result(rc=1 if self.fault in ('post-loss', 'post-no-commit') else 0)
                number = int(path.split('/')[1])
                assert any(c['id'] == 700 for c in self.comments), 'remove before acceptance'
                if number == 1110: assert not self.label[1109], 'wrong label order'
                if self.fault != 'delete-no-commit': self.label[number] = False
                if self.fault == 'source-after-issue' and number == 1109:
                    self.comments[0]['body'] = self.comments[0]['body'].replace('"kind": "pause"',
                        '"payload": {"detail": "changed"}, "kind": "pause"')
                if self.fault == 'crash-issue' and number == 1109: raise Crash()
                return result(rc=1 if self.fault in ('delete-loss', 'delete-no-commit') else 0)
            assert env['GH_TOKEN'] == 'mock-read' and 'GH_WRITE_TOKEN' not in env
            if args[1:3] == ['pr', 'view']:
                return result({'closingIssuesReferences': [{'number': 1112 if self.fault == 'relation' else 1109}]})
            if args[-1].startswith('/apps/'):
                raise AssertionError('App GET with repository token is forbidden')
            if self.fault == 'api-unknown' and '/pulls/1110' in args[-1]: return result(rc=1)
            repository_endpoint = '/repos/' + REPO
            if args[-1] == repository_endpoint + '/':
                return result(rc=1)  # GitHub REST returns 404 for the trailing slash.
            if args[-1] == repository_endpoint:
                return result(rc=1) if self.fault == 'repository-api' else result(self.api(''))
            assert args[-1].startswith(repository_endpoint + '/'), args
            if '/issues/1110/comments?' in args[-1]:
                assert args[2:4] == ['-H', 'Accept: application/vnd.github+json']
            return result(self.api(args[-1][len(repository_endpoint) + 1:]))
        if args[0] == 'git':
            if '-C' in args: return result(TRUSTED_MAIN + '\n')
            if args[1:3] == ['rev-parse', 'HEAD']: return result(HEAD + '\n')
            if '--is-shallow-repository' in args: return result('false\n')
            if args[1] == 'rev-parse':
                commit = args[-1]
                if commit.endswith('^{commit}'):
                    value = commit[:-9]
                    if self.fault == 'unavailable-main' and value == TRUSTED_MAIN: value = OLD
                    return result(value + '\n')
                if commit == HEAD + '^': return result(PARENT + '\n')
            if args[1] == 'rev-list' and args[2:5] == ['--parents', '-n', '1']:
                commit = args[-1]
                if commit == ANCHOR:
                    return result(ANCHOR + ' ' + (OLD if self.fault == 'anchor-parent' else BASE))
                if commit == PATCH_BASE:
                    parent = BASE if self.fault == 'previous-parent' else ANCHOR
                    extra = ' ' + BASE if self.fault == 'previous-multiparent' else ''
                    return result(PATCH_BASE + ' ' + parent + extra)
                if commit == READ_FIX_BASE:
                    parent = ANCHOR if self.fault == 'read-fix-parent' else PATCH_BASE
                    return result(READ_FIX_BASE + ' ' + parent)
                if commit == AUTH_FIX_BASE:
                    parent = BASE if self.fault == 'auth-fix-parent' else READ_FIX_BASE
                    return result(AUTH_FIX_BASE + ' ' + parent)
                if commit == CONTEXT_FIX_BASE:
                    parent = BASE if self.fault == 'context-fix-parent' else AUTH_FIX_BASE
                    return result(CONTEXT_FIX_BASE + ' ' + parent)
                if commit == RESUME_FIX_BASE:
                    return result(RESUME_FIX_BASE + ' ' + (BASE if self.fault == 'resume-fix-parent' else CONTEXT_FIX_BASE))
                if commit == TRUSTED_MAIN:
                    parent = BASE if self.fault == 'main-parent' else RESUME_FIX_BASE
                    extra = ' ' + BASE if self.fault == 'main-multiparent' else ''
                    return result(TRUSTED_MAIN + ' ' + parent + extra)
            if args[1] == 'merge-base':
                return result(OLD if self.fault == 'merge-base' else BASE)
            if args[1] == 'merge-tree':
                return result(MERGED_TREE, rc=1 if self.fault == 'merge-conflict' else 0)
            if args[1] == 'diff':
                if '--name-only' in args:
                    before, after = args[-2:]
                    if (before, after) == (BASE, ANCHOR):
                        changes = ANCHOR_PATHS
                    elif (before, after) == (ANCHOR, PATCH_BASE):
                        changes = PATCH_PATHS | ({'.github/workflows/claude-review.yml'}
                                                if self.fault == 'previous-paths' else set())
                    elif (before, after) == (PATCH_BASE, READ_FIX_BASE):
                        changes = PATCH_PATHS | ({'.github/workflows/product-ci.yml'}
                                                if self.fault == 'read-fix-paths' else set())
                    elif (before, after) == (READ_FIX_BASE, AUTH_FIX_BASE):
                        changes = ANCHOR_PATHS | ({'.github/workflows/claude-review.yml'}
                                                if self.fault == 'auth-fix-paths' else set())
                    elif (before, after) == (AUTH_FIX_BASE, CONTEXT_FIX_BASE):
                        changes = CONTEXT_PATHS | ({'.github/workflows/claude-review.yml'}
                                                 if self.fault == 'context-fix-paths' else set())
                    elif (before, after) == (CONTEXT_FIX_BASE, RESUME_FIX_BASE):
                        changes = PATCH_PATHS | ({'.github/workflows/claude-review.yml'} if self.fault == 'resume-fix-paths' else set())
                    elif (before, after) == (RESUME_FIX_BASE, TRUSTED_MAIN):
                        changes = CURRENT_PATHS | ({'docs/40_test/README.md'} if self.fault == 'main-overlap'
                                               else {'.github/workflows/product-ci.yml'} if self.fault == 'main-extra-file'
                                               else set())
                    elif (before, after) == (BASE, HEAD):
                        changes = set(paths[:-1]) if self.fault == 'pr-diff' else set(paths)
                    elif (before, after) == (BASE, TRUSTED_MAIN):
                        changes = ANCHOR_PATHS | CONTEXT_PATHS | CURRENT_PATHS | (
                            {paths[0]} if self.fault == 'main-oldbase-overlap' else set())
                    else:
                        raise AssertionError(args)
                    return result('\0'.join(sorted(changes)) + '\0')
                if '--quiet' in args:
                    if args[4:6] == [HEAD, MERGED_TREE]:
                        return result(rc=1 if self.fault == 'merged-pr-changed' else 0)
                    if args[4:6] == [TRUSTED_MAIN, MERGED_TREE]:
                        assert set(args[7:]) == ANCHOR_PATHS | CONTEXT_PATHS | CURRENT_PATHS
                        return result(rc=1 if self.fault == 'merged-main-changed' else 0)
                raise AssertionError(args)
            if args[1] == 'show' and '--format=%an%n%ae%n%cn%n%ce%n%s' in args:
                return result('github-actions[bot]\n41898282+github-actions[bot]@users.noreply.github.com\n' * 2 + 'Render PlantUML diagrams\n')
            if args[1] == 'show':
                if args[-1].endswith(':.github/workflows/claude-review.yml'):
                    value = (root / '.github/workflows/claude-review.yml').read_text()
                    if self.fault == 'bot-old-allowlist':
                        value = value.replace(',${{ steps.review-token.outputs.app-slug }}[bot]', '')
                    if self.fault == 'bot-wildcard':
                        value = value.replace('allowed_bots: ${{ steps.dev-token.outputs.app-slug }}[bot],${{ steps.review-token.outputs.app-slug }}[bot]', 'allowed_bots: *')
                    if self.fault == 'bot-wrong-pin': value = value.replace('8ce9314fa9a404564fa7e954cd84f25bcba2b829', '0' * 40)
                    if self.fault == 'bot-nonwrite-bypass': value += '\n          allowed_non_write_users: *\n'
                    if self.fault == 'bot-wrong-token': value = value.replace('github_token: ${{ steps.review-token.outputs.token }}', 'github_token: other')
                    return result(value)
                return result('# trusted builder mock\n')
            if args[1] == 'log': return result(OLD if self.fault == 'svg' else HEAD)
            raise AssertionError(args)
        if args[0] == 'bash' and Path(args[1]).name == 'builder.sh':
            assert env['GH_TOKEN'] == 'mock-read' and 'GH_WRITE_TOKEN' not in env
            # Preflight must use the same trusted-main identity as normal Review.
            assert env['BASE_SHA'] == env['SOURCE_BASE_SHA'] == TRUSTED_MAIN
            assert self.pr['base']['sha'] == BASE and BASE != TRUSTED_MAIN
            assert args[-1] == HEAD
            assert args[5] == ('nssscdl-chatgpt-dev,nssscdl-chatgpt-dev[bot],app/nssscdl-chatgpt-dev,'
                               'nssscdl-claude-review,nssscdl-claude-review[bot],app/nssscdl-claude-review')
            assert args[6] == 'nssscdl-claude-review,nssscdl-claude-review[bot],app/nssscdl-claude-review'
            assert Path(args[1]).read_text() == '# trusted builder mock\n'
            self.builder += 1
            return result(rc=1 if self.fault == 'builder' else 0)
        if args[0] == 'bash' and Path(args[1]).name == 'list-human-pause-records.sh':
            # Execute the actual provenance/schema listing with an offline gh
            # function, then execute all graph stages unchanged.
            assert args[-1] == '4777865'
            with tempfile.TemporaryDirectory() as directory:
                comments = Path(directory) / 'comments.json'
                comments.write_text(json.dumps([{}] * 100 if self.fault == 'truncated-comments' else self.comments))
                child_env = dict(env, CASE_COMMENTS=str(comments))
                return real_run(['bash', '-c', 'gh() { cat "$CASE_COMMENTS"; }; export -f gh; bash "$@"',
                                 '--', *args[1:]], **dict(kw, env=child_env))
        if args[0] == 'bash': return real_run(args, **kw)
        raise AssertionError('unexpected process: ' + repr(args))

    def invoke(self, mode='apply'):
        global count
        count += 1
        env = dict(os.environ, GITHUB_REPOSITORY=REPO, GITHUB_EVENT_NAME='workflow_dispatch',
            GITHUB_REF='refs/heads/main', GITHUB_ACTOR='suzukure', GITHUB_TRIGGERING_ACTOR='suzukure',
            GITHUB_SHA=TRUSTED_MAIN, GITHUB_RUN_ID='800', GITHUB_RUN_ATTEMPT='1', RECOVERY_SOURCE='/mock/source',
            GH_TOKEN='mock-read', GH_WRITE_TOKEN='mock-write', REVIEWER_APP_SLUG='nssscdl-claude-review')
        env['REVIEWER_INSTALLATION_ID'] = '12345'
        if self.fault == 'writer-app': env['REVIEWER_APP_SLUG'] = 'other'
        if self.fault == 'installation-missing': del env['REVIEWER_INSTALLATION_ID']
        if self.fault == 'installation-invalid': env['REVIEWER_INSTALLATION_ID'] = '0'
        if self.fault == 'actor': env['GITHUB_ACTOR'] = 'outsider'
        if self.fault == 'rerun-actor': env['GITHUB_TRIGGERING_ACTOR'] = 'outsider'
        if self.fault == 'rerun': env['GITHUB_RUN_ATTEMPT'] = '2'
        module['MODE'] = mode
        try:
            with patch.dict(os.environ, env, clear=True), patch.object(subprocess, 'run', self.process), \
                    patch.object(module['time'], 'sleep', lambda _: None):
                module['main']()
            return True
        except (ValueError, KeyError, subprocess.SubprocessError, Crash) as error:
            self.error = repr(error)
            if isinstance(error, subprocess.CalledProcessError):
                self.error += ': ' + str(error.stderr)
            return False


expected = [('POST', 'issues/1110/comments'), ('DELETE', 'issues/1109/labels/human-review-required'),
            ('DELETE', 'issues/1110/labels/human-review-required')]
case = Case()
assert case.invoke('check') and case.writes == [] and case.builder == 1, getattr(case, 'error', case.reads)
case = Case()
assert case.invoke('identity') and case.writes == [] and case.builder == 0
assert not any(path.startswith('actions/') for path in case.reads)
for fault in ('writer-app', 'installation-missing', 'installation-invalid', 'rerun', 'main-before'):
    case = Case(fault)
    assert not case.invoke('identity') and case.writes == [], fault
for fault in ('', 'post-loss', 'delete-loss', 'check-before-apply', 'list-second-page'):
    case = Case(fault)
    assert case.invoke(), (fault, getattr(case, 'error', ''))
    assert case.writes == expected and not any(case.label.values()), fault
    case.writes.clear()
    assert case.invoke() and case.writes == [], 'completed replay: ' + fault
for fault in ('actor', 'rerun-actor', 'permission', 'app', 'source-id', 'old-head', 'reason', 'target', 'schema', 'head', 'branch',
              'fork', 'draft', 'closed', 'pr-base', 'missing-label', 'multiple-active', 'broken-graph', 'files',
              'verdict', 'relation', 'model-ran', 'ci', 'stale-ci', 'base-ci', 'renderer', 'svg', 'builder',
              'writer-app', 'api-unknown', 'repository-api', 'truncated-api', 'truncated-comments', 'prior-apply', 'deleted-history', 'rerun',
               'main-before', 'unavailable-main', 'anchor-parent', 'previous-parent',
               'previous-multiparent', 'previous-paths', 'read-fix-parent', 'read-fix-paths',
               'main-parent', 'main-multiparent',
               'merge-base', 'merge-conflict', 'main-overlap', 'main-extra-file', 'pr-diff',
               'main-oldbase-overlap', 'merged-pr-changed', 'merged-main-changed',
               'list-api', 'list-bound', 'list-shape', 'list-missing', 'list-duplicate', 'list-nonobject',
               'list-app-null', 'list-app-missing', 'list-app-wrong', 'list-app-type', 'list-id-type',
               'list-body', 'list-target', 'source-body-drift', 'installation-missing', 'installation-invalid'):
    case = Case(fault)
    assert not case.invoke() and case.writes == [], fault
    if fault == 'source-body-drift':
        assert 'source_record_changed_during_read' in case.error, case.error
    if fault in ('list-api', 'list-body'):
        assert 'SECRET' not in case.error, case.error
# The original single-comment API may return null App provenance. It is never
# called: the mock rejects it, while source AND accepted use the verified list.
case = Case()
assert case.invoke() and case.writes == expected
assert not any(path.startswith('issues/comments/') for path in case.reads)
for fault in ('retired-missing', 'retired-zero-attempt', 'retired-attempt-type',
              'retired-head', 'retired-actor', 'retired-number', 'retired-rerun',
              'retired-workflow', 'retired-repo', 'retired-result', 'retired-job-id', 'retired-check',
              'retired-recheck', 'retired-token', 'retired-consume', 'retired-cleanup',
              'retired-step-duplicate', 'retired-step-missing', 'retired-jobs-missing',
              'history-api', 'prior-apply'):
    # Check must detect a blocked fence BEFORE the workflow can issue its token.
    for mode in ('check', 'apply'):
        case = Case(fault)
        assert not case.invoke(mode) and case.writes == [], (mode, fault)
        if fault == 'history-api':
            assert 'recovery_history_read_failed' in case.error and 'SECRET' not in case.error
# The old accepted record cannot authorize the new source. Both complete chains
# and the exact completed previous apply / pre-model failure remain mandatory.
for fault in ('previous-source-missing', 'previous-accepted-missing', 'previous-accepted-id',
              'previous-accepted-body', 'previous-source-head', 'previous-accepted-app',
              'previous-record-duplicate', 'old-accepted-only', 'source-before-failure',
              'previous-accepted-late', 'source-time-invalid',
              'failed-head', 'failed-id', 'failed-attempt', 'failed-workflow', 'failed-not-complete',
              'failed-time-invalid', 'failed-job-id', 'failed-step-duplicate', 'failed-step-missing',
              'failed-step-running', 'extra-review',
              'previous-run-id', 'previous-run-head', 'previous-run-actor', 'previous-run-attempt',
              'previous-run-result', 'previous-job-id', 'previous-job-state', 'previous-read-identity',
              'previous-read-cleanup', 'previous-recheck', 'previous-token', 'previous-consume',
              'previous-cleanup', 'previous-step-duplicate', 'previous-step-missing', 'previous-jobs-missing',
              'previous-history-missing', 'previous-history-rerun', 'prefix-id-changed', 'job-history-empty',
              'auth-fix-parent', 'context-fix-parent', 'auth-fix-paths', 'context-fix-paths'):
    for mode in ('check', 'apply'):
        case = Case(fault)
        assert not case.invoke(mode) and case.writes == [], (mode, fault, getattr(case, 'error', ''))
for fault in ('accepted-app-null', 'accepted-app-wrong', 'accepted-body',
              'accepted-time-missing', 'accepted-time-type', 'accepted-time-invalid',
              'accepted-time-offset', 'accepted-time-late'):
    case = Case(fault)
    case.comments.append(record_comment(700, ACCEPTED))
    case.label = {1109: False, 1110: False}
    assert not case.invoke() and case.writes == [], fault
    # These same faults after new acceptance must not resend the POST/labels.
    case = Case(fault)
    assert not case.invoke() and case.writes == expected, fault
    case.writes.clear()
    assert not case.invoke() and case.writes == [], fault
for fault, writes in [('post-no-commit', expected[:1]), ('head-after-post', expected[:1]),
                      ('source-after-post', expected[:1]), ('source-after-issue', expected[:2]),
                      ('head-after-issue', expected[:2]), ('base-drift', expected[:1]),
                      ('delete-no-commit', expected[:2]), ('crash-post', expected[:1]), ('crash-issue', expected[:2])]:
    case = Case(fault)
    assert not case.invoke() and case.writes == writes, fault
    # A second serialized dispatcher must not resend a write. An unconfirmed
    # POST without a record is fenced by the preceding started apply attempt.
    case.fault = 'prior-apply' if fault == 'post-no-commit' else ''
    case.writes.clear()
    assert not case.invoke() and case.writes == [], 'interrupted replay: ' + fault
case = Case('main-before')
case.comments.append(record_comment(700, ACCEPTED))
case.label = {1109: False, 1110: False}
assert not case.invoke() and case.writes == [], 'accepted replay after main drift'
for issue, pr in ((True, True), (False, True), (True, False), (False, False)):
    case = Case()
    case.comments.append(record_comment(700, ACCEPTED))
    case.label = {1109: issue, 1110: pr}
    case.owner = 'none'
    assert not case.invoke() and case.writes == [], ('partial/unknown', issue, pr)
for owner in ('none', 'queued', 'failed', 'model-only', 'outer-success', 'invalid-output',
              'duplicate', 'rerun', 'old', 'wrong-pr', 'wrong-branch', 'wrong-head',
              'wrong-repo', 'wrong-workflow', 'duplicate-step'):
    case = Case()
    case.owner = owner
    assert not case.invoke() and case.writes == expected, owner
    case.writes.clear()
    assert not case.invoke() and case.writes == [], ('owner replay', owner)
for duplicate in (True, False):
    case = Case()
    case.comments.append(record_comment(700, ACCEPTED))
    case.comments.append(record_comment(701, ACCEPTED if duplicate else {
        'version': 1, 'kind': 'pause', 'reason': 'resume_transition_failed', 'target': 'pr:1110',
        'source_pause_id': '700', 'payload': {'failed_action': 'review'}}))
    assert not case.invoke() and case.writes == [], 'duplicate/replacement'

for fault in ('bot-old-allowlist', 'bot-wildcard', 'bot-wrong-pin', 'bot-nonwrite-bypass', 'bot-wrong-token',
              'second-source-missing', 'second-accepted-missing', 'second-accepted-id', 'second-accepted-app',
              'second-accepted-body', 'second-source-head', 'second-accepted-late',
              'latest-run-head', 'latest-run-actor', 'latest-run-attempt', 'latest-job-id',
              'latest-read-cleanup', 'latest-write-cleanup', 'resume-fix-parent', 'resume-fix-paths'):
    for mode in ('check', 'apply'):
        case = Case(fault)
        assert not case.invoke(mode) and case.writes == [], (fault, mode, getattr(case, 'error', ''))
case = Case()
case.owner = 'saved'
assert case.invoke() and case.writes == expected
assert any('head_sha=' + HEAD + '&event=pull_request' in path for path in case.reads)
assert not any(path.startswith('actions/workflows/claude-review.yml/runs') for path in case.reads)

workflow = (root / '.github/workflows/recover-pr1110-claude-pause.yml').read_text()
assert 'workflow_run:' not in workflow and 'pull_request:' not in workflow
assert 'options: [check, apply]' in workflow and 'default: check' in workflow
assert 'group: codex-writer-ai/issue-1109' in workflow
assert 'cancel-in-progress: false' in workflow
assert workflow.index('Recheck after writer wait') < workflow.index('Create reviewer App token')
assert 'GH_WRITE_TOKEN:' not in workflow.split('  apply:', 1)[0]
assert 'permission-actions: write' not in workflow
assert 'ANTHROPIC' not in workflow and 'claude-code-action' not in workflow
def identity_contract(text):
    check, apply = text.split('  apply:', 1)
    return (text.count("app-id: '4777865'") == 2 and 'client-id:' not in text
        and text.count('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1') == 2
        and text.count('private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}') == 2
        and 'github.run_attempt == 1' in check
        and check.index('Check fixed recovery target') < check.index('Authenticate reviewer identity')
        and 'permission-issues: read' in check and 'permission-pull-requests: read' in check
        and 'permission-issues: write' not in check and 'permission-pull-requests: write' not in check
        and 'reviewer_check.outputs.token' not in check and 'GH_WRITE_TOKEN:' not in check
        and 'reviewer_check.outputs.installation-id' in check and 'recover-pr1110-claude-pause.sh identity' in check
        and 'permission-issues: write' in apply and 'permission-pull-requests: write' in apply
        and 'reviewer.outputs.installation-id' in apply and 'skip-token-revoke: true' not in text)
assert identity_contract(workflow)
for broken in (workflow.replace("app-id: '4777865'", "app-id: '4777726'", 1),
               workflow.replace("app-id: '4777865'", "client-id: wrong", 1),
               workflow.replace('permission-issues: read', 'permission-issues: write', 1),
               workflow.replace('reviewer_check.outputs.installation-id', 'reviewer_check.outputs.token', 1),
               workflow.replace('github.run_attempt == 1', 'github.run_attempt >= 1')):
    assert not identity_contract(broken)
print(f'PR1110 exceptional recovery: {count} offline invocations passed')
PY
