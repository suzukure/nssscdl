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
PARENT = '5cc1448038e0963b6bb826b53f44870376fc94c4'
REPO = 'suzukure/nssscdl'
BRANCH = 'docs/issue-1108-student-booking-ux-contract'
ACCEPTED = {'version': 1, 'kind': 'ai-resume-accepted', 'reason': 'claude_execution_failed',
            'target': 'pr:1110', 'source_pause_id': '6625324624', 'paused_head': HEAD,
            'payload': {'action': 'review', 'recovery_issue': 1111}}
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
            'created_at': '2026-11-04T10:00:00Z',
            'body': '<!-- ai-human-pause-record:start -->\n' + json.dumps(record)
                    + '\n<!-- ai-human-pause-record:end -->'}


class Crash(BaseException):
    pass


real_run = subprocess.run
count = 0


class Case:
    def __init__(self, fault=''):
        self.fault = fault
        self.comments = [record_comment(6625324624, {'version': 1, 'kind': 'pause',
            'reason': 'claude_execution_failed', 'target': 'pr:1110', 'paused_head': OLD})]
        self.label = {1109: True, 1110: True}
        self.writes = []
        self.builder = 0
        self.reads = []
        self.owner = 'entered'
        self.pr = {'number': 1110, 'state': 'open', 'draft': False, 'changed_files': 14,
                   'head': {'sha': HEAD, 'ref': BRANCH, 'repo': {'full_name': REPO}},
                   'base': {'sha': BASE, 'ref': 'main', 'repo': {'full_name': REPO}}}
        self.run = {'id': 800, 'run_number': 1, 'run_attempt': 1,
                    'path': '.github/workflows/recover-pr1110-claude-pause.yml',
                    'event': 'workflow_dispatch', 'head_repository': {'full_name': REPO}}
        if fault == 'app': self.comments[0]['performed_via_github_app']['id'] = 4777726
        if fault == 'source-id': self.comments[0]['id'] = 123
        if fault == 'old-head': self.comments[0]['body'] = self.comments[0]['body'].replace(OLD, HEAD)
        if fault == 'reason': self.comments[0]['body'] = self.comments[0]['body'].replace('claude_execution_failed', 'state_inconsistent')
        if fault == 'target': self.comments[0]['body'] = self.comments[0]['body'].replace('pr:1110', 'pr:1112')
        if fault == 'schema': self.comments[0]['body'] = self.comments[0]['body'].replace('"version": 1', '"version": 99')
        if fault == 'head': self.pr['head']['sha'] = OLD
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
            self.comments[-1]['body'] = self.comments[-1]['body'].replace('6625324624', '999')

    def api(self, path):
        self.reads.append(path)
        path = path.split('?', 1)[0]
        if path == '': return {'default_branch': 'main'}
        if path == 'collaborators/suzukure/permission':
            return {'user': {'login': 'suzukure'}, 'permission': 'read' if self.fault == 'permission' else 'admin'}
        if path == 'git/ref/heads/main':
            return {'object': {'sha': OLD if self.writes and self.fault == 'base-drift' else BASE}}
        if path == 'pulls/1110':
            value = deepcopy(self.pr)
            if self.writes and self.fault == 'head-after-post': value['head']['sha'] = OLD
            if len(self.writes) >= 2 and self.fault == 'head-after-issue': value['head']['sha'] = OLD
            return value
        if path.startswith('issues/comments/'):
            return next(c for c in self.comments if str(c['id']) == path.rsplit('/', 1)[1])
        if path in ('issues/1109', 'issues/1110'):
            number = int(path.split('/')[1])
            return {'number': number, 'state': 'open', 'labels':
                    [{'name': 'human-review-required'}] if self.label[number] else []}
        if path == 'pulls/1110/files':
            return [{'filename': p, 'status': 'modified'} for p in
                    (paths[:-1] + ['.github/workflows/claude-review.yml'] if self.fault == 'files' else paths)]
        if path == 'pulls/1110/reviews': return [{}] if self.fault == 'verdict' else []
        if path == 'commits/' + BASE: return {'commit': {'committer': {'date': '2026-10-30T07:51:29Z'}}}
        if path == 'actions/runs/41793021156':
            return {'path': '.github/workflows/claude-review.yml', 'event': 'pull_request',
                    'head_branch': BRANCH, 'head_repository': {'full_name': REPO}, 'head_sha': OLD,
                    'run_attempt': 1, 'conclusion': 'failure',
                    'pull_requests': [{'number': 1110, 'head': {'sha': HEAD}}]}
        if path == 'actions/runs/41793021156/attempts/1/jobs':
            steps = [{'name': n, 'conclusion': c} for n, c in (
                ('Build review context', 'failure'), ('Select Claude review model', 'skipped'),
                ('Run Claude review', 'skipped'), ('Submit reviewer verdict', 'skipped'))]
            if self.fault == 'model-ran': steps[2]['conclusion'] = 'success'
            return {'total_count': 1, 'jobs': [{'name': 'Review', 'steps': steps}]}
        if path == 'actions/runs':
            runs = [{'id': n, 'path': '.github/workflows/' + w, 'event': 'pull_request',
                     'head_sha': HEAD, 'head_repository': {'full_name': REPO},
                     'pull_requests': [{'number': 1110, 'head': {'sha': HEAD}, 'base': {'sha': BASE}}],
                     'status': 'completed', 'conclusion': 'success', 'created_at': '2026-11-04T07:45:00Z'}
                    for n, w in enumerate(('product-ci.yml', 'traceability-check.yml'), 1)]
            if self.fault == 'ci': runs[0]['conclusion'] = 'failure'
            if self.fault == 'stale-ci': runs[0]['created_at'] = '2026-10-29T00:00:00Z'
            if self.fault == 'base-ci': runs[0]['pull_requests'][0]['base']['sha'] = OLD
            if self.fault == 'truncated-api': return {'total_count': 3, 'workflow_runs': runs}
            return {'total_count': 2, 'workflow_runs': runs}
        if path == 'actions/runs/41793316677':
            return {'path': '.github/workflows/render-plantuml.yml', 'event': 'push',
                    'conclusion': 'failure' if self.fault == 'renderer' else 'success',
                    'head_repository': {'full_name': REPO}, 'head_branch': BRANCH,
                    'run_attempt': 1, 'head_sha': PARENT}
        if path == 'actions/workflows/recover-pr1110-claude-pause.yml/runs':
            runs = [deepcopy(self.run)]
            if self.fault in ('prior-apply', 'check-before-apply', 'deleted-history'):
                runs[0]['run_number'] = 2
                if self.fault != 'deleted-history':
                    runs.append(dict(self.run, id=799, run_number=1))
            return {'total_count': len(runs), 'workflow_runs': runs}
        if path == 'actions/runs/799/attempts/1/jobs':
            return {'total_count': 1, 'jobs': [{'name': 'Apply fixed recovery',
                'started_at': '2026-11-04T09:00:00Z',
                'conclusion': 'skipped' if self.fault == 'check-before-apply' else 'cancelled'}]}
        if path == 'actions/workflows/claude-review.yml/runs':
            runs = [] if self.owner == 'none' else [{'id': 900, 'head_sha': HEAD, 'head_branch': BRANCH,
                'created_at': '2026-11-04T10:01:00Z', 'event': 'pull_request', 'run_attempt': 1,
                'path': '.github/workflows/claude-review.yml', 'head_repository': {'full_name': REPO},
                'pull_requests': [{'number': 1110, 'head': {'sha': HEAD}}]}]
            return {'total_count': len(runs), 'workflow_runs': runs}
        if path == 'actions/runs/900/attempts/1/jobs':
            return {'total_count': 1, 'jobs': [{'name': 'Review', 'status': 'in_progress',
                'conclusion': 'failure' if self.owner == 'failed' else None,
                'steps': [{'name': 'Select Claude review model',
                           'status': 'in_progress' if self.owner == 'entered' else 'queued', 'conclusion': None}]}]}
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
                    if self.fault == 'crash-post': raise Crash()
                    return result(rc=1 if self.fault in ('post-loss', 'post-no-commit') else 0)
                number = int(path.split('/')[1])
                assert any(c['id'] == 700 for c in self.comments), 'remove before acceptance'
                if number == 1110: assert not self.label[1109], 'wrong label order'
                if self.fault != 'delete-no-commit': self.label[number] = False
                if self.fault == 'crash-issue' and number == 1109: raise Crash()
                return result(rc=1 if self.fault in ('delete-loss', 'delete-no-commit') else 0)
            assert env['GH_TOKEN'] == 'mock-read' and 'GH_WRITE_TOKEN' not in env
            if args[1:3] == ['pr', 'view']:
                return result({'closingIssuesReferences': [{'number': 1112 if self.fault == 'relation' else 1109}]})
            if args[-1].startswith('/apps/'):
                return result({'id': 4777726 if self.fault == 'writer-app' else 4777865})
            if self.fault == 'api-unknown' and '/pulls/1110' in args[-1]: return result(rc=1)
            repository_endpoint = '/repos/' + REPO
            if args[-1] == repository_endpoint + '/':
                return result(rc=1)  # GitHub REST returns 404 for the trailing slash.
            if args[-1] == repository_endpoint:
                return result(rc=1) if self.fault == 'repository-api' else result(self.api(''))
            assert args[-1].startswith(repository_endpoint + '/'), args
            return result(self.api(args[-1][len(repository_endpoint) + 1:]))
        if args[0] == 'git':
            if '-C' in args: return result(BASE + '\n')
            if args[1:3] == ['rev-parse', 'HEAD']: return result(HEAD + '\n')
            if '--is-shallow-repository' in args: return result('false\n')
            if args[1] == 'show' and '--format=%an%n%ae%n%cn%n%ce%n%s' in args:
                return result('github-actions[bot]\n41898282+github-actions[bot]@users.noreply.github.com\n' * 2 + 'Render PlantUML diagrams\n')
            if args[1] == 'show': return result('# trusted builder mock\n')
            if args[1] == 'log': return result(OLD if self.fault == 'svg' else HEAD)
            if args[-1] == HEAD + '^': return result(PARENT)
            raise AssertionError(args)
        if args[0] == 'bash' and Path(args[1]).name == 'builder.sh':
            assert env['GH_TOKEN'] == 'mock-read' and 'GH_WRITE_TOKEN' not in env
            assert env['BASE_SHA'] == BASE and args[-1] == HEAD
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
            GITHUB_SHA=BASE, GITHUB_RUN_ID='800', GITHUB_RUN_ATTEMPT='1', RECOVERY_SOURCE='/mock/source',
            GH_TOKEN='mock-read', GH_WRITE_TOKEN='mock-write', REVIEWER_APP_SLUG='nssscdl-claude-review')
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
for fault in ('', 'post-loss', 'delete-loss', 'check-before-apply'):
    case = Case(fault)
    assert case.invoke(), (fault, getattr(case, 'error', ''))
    assert case.writes == expected and not any(case.label.values()), fault
    case.writes.clear()
    assert case.invoke() and case.writes == [], 'completed replay: ' + fault
for fault in ('actor', 'rerun-actor', 'permission', 'app', 'source-id', 'old-head', 'reason', 'target', 'schema', 'head', 'branch',
              'fork', 'draft', 'closed', 'missing-label', 'multiple-active', 'broken-graph', 'files',
              'verdict', 'relation', 'model-ran', 'ci', 'stale-ci', 'base-ci', 'renderer', 'svg', 'builder',
              'writer-app', 'api-unknown', 'repository-api', 'truncated-api', 'truncated-comments', 'prior-apply', 'deleted-history', 'rerun'):
    case = Case(fault)
    assert not case.invoke() and case.writes == [], fault
for fault, writes in [('post-no-commit', expected[:1]), ('head-after-post', expected[:1]),
                      ('head-after-issue', expected[:2]), ('base-drift', expected[:1]),
                      ('delete-no-commit', expected[:2]), ('crash-post', expected[:1]), ('crash-issue', expected[:2])]:
    case = Case(fault)
    assert not case.invoke() and case.writes == writes, fault
    # A second serialized dispatcher must not resend a write. An unconfirmed
    # POST without a record is fenced by the preceding started apply attempt.
    case.fault = 'prior-apply' if fault == 'post-no-commit' else ''
    case.writes.clear()
    assert not case.invoke() and case.writes == [], 'interrupted replay: ' + fault
for issue, pr in ((True, True), (False, True), (True, False), (False, False)):
    case = Case()
    case.comments.append(record_comment(700, ACCEPTED))
    case.label = {1109: issue, 1110: pr}
    case.owner = 'none'
    assert not case.invoke() and case.writes == [], ('partial/unknown', issue, pr)
for owner in ('none', 'queued', 'failed'):
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

workflow = (root / '.github/workflows/recover-pr1110-claude-pause.yml').read_text()
assert 'workflow_run:' not in workflow and 'pull_request:' not in workflow
assert 'options: [check, apply]' in workflow and 'default: check' in workflow
assert 'group: codex-writer-ai/issue-1109' in workflow
assert 'cancel-in-progress: false' in workflow
assert workflow.index('Recheck after writer wait') < workflow.index('Create reviewer App token')
assert 'GH_WRITE_TOKEN:' not in workflow.split('  apply:', 1)[0]
assert 'permission-actions: write' not in workflow
assert 'ANTHROPIC' not in workflow and 'claude-code-action' not in workflow
print(f'PR1110 exceptional recovery: {count} offline invocations passed')
PY
