#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && ( $1 == check || $1 == apply ) ]] || exit 64
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Embedded implementation keeps the exceptional consumer within the frozen path.
# No PR code is executed. Existing schema and lifecycle primitives remain canonical.
python3 -I -B - "$1" "$script_dir" <<'PY'
import json
from datetime import datetime
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

MODE, SCRIPTS = sys.argv[1], Path(sys.argv[2])
REPO = 'suzukure/nssscdl'
HEAD = '50ac09107c1d80fdcdbb03dc0e0a63e012be9137'
OLD = 'ad90e514aeac5789f7fdb4af600e6c3f60b6c4b1'
BRANCH = 'docs/issue-1108-student-booking-ux-contract'
SOURCE = '6625324624'
APP = 4777865
WORKFLOW = '.github/workflows/recover-pr1110-claude-pause.yml'
BASE = '17f63a0a9e9ebf2ecd03c1e9329f8200362aebc5'
ANCHOR = '637278268f8269d31187674c21adb69dc4f55aac'
# This one-off consumer is valid only for the next single-parent squash on ANCHOR.
# Future main commits require another explicit qualification decision.
ANCHOR_FILES = {
    '.github/scripts/recover-pr1110-claude-pause.sh',
    '.github/scripts/test-recover-ai-resume-review.sh',
    '.github/workflows/recover-pr1110-claude-pause.yml',
    'docs/30_operations/ai-development-workflow.md',
}
PATCH_FILES = {
    '.github/scripts/recover-pr1110-claude-pause.sh',
    '.github/scripts/test-recover-ai-resume-review.sh',
    'docs/30_operations/ai-development-workflow.md',
}
FILES = {
    'docs/00_requirements/00_RevisionHistory.md',
    'docs/00_requirements/04_FunctionalRequirements.md',
    'docs/00_requirements/07_TraceabilityMatrix.md',
    'docs/00_requirements/validation_report.json',
    'docs/20_detailed_design/01_StudentReservationApplication.md',
    'docs/40_test/01_TestPlan.md',
    'docs/40_test/02_FunctionalTestSpecification.md',
    'docs/40_test/04_RequirementsTestTraceability.md',
    'docs/40_test/04b_BulkReservationTraceability.md',
    'docs/40_test/README.md',
    'docs/diagrams/plantuml/c4-student-reservation-components.puml',
    'docs/diagrams/plantuml/student-reservation-sequence.puml',
    'docs/diagrams/rendered/c4-student-reservation-components.svg',
    'docs/diagrams/rendered/student-reservation-sequence.svg',
}
ACCEPTED = dict(version=1, kind='ai-resume-accepted',
                reason='claude_execution_failed', target='pr:1110',
                source_pause_id=SOURCE, paused_head=HEAD,
                payload=dict(action='review', recovery_issue=1111))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(args, data=None, cwd=None, env=None):
    return subprocess.run(args, input=data, text=True, encoding='utf-8', stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True, cwd=cwd,
                          env=env or read_env()).stdout


def read_env():
    # In particular the isolated context builder never receives the write token.
    env = dict(os.environ)
    env.pop('GH_WRITE_TOKEN', None)
    return env


def api(path):
    endpoint = '/repos/' + REPO + ('/' + path if path else '')
    return json.loads(run(['gh', 'api', endpoint]))


def pages(path, key=None):
    result = []
    total = None
    for page in range(1, 11):
        value = api(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        items = value if key is None else value[key]
        require(isinstance(items, list) and len(items) <= 100, 'invalid API page')
        if key:
            if total is None:
                total = value['total_count']
            require(type(total) is int and total >= 0 and value['total_count'] == total,
                    'history changed while reading')
        result.extend(items)
        if len(items) < 100:
            require(total is None or total == len(result), 'incomplete history')
            return result
    raise ValueError('history exceeds bound')


def helper(name, data, *args):
    return run(['bash', str(SCRIPTS / (name + '.sh')), *args], data)


def graph():
    value = helper('list-human-pause-records', None, REPO, '1109', '1110', str(APP))
    for stage in ('validate-human-pause-record-graph', 'decompose-human-pause-record-graph',
                  'derive-human-pause-pre-resume-state', 'reconcile-human-pause-resume-acceptance'):
        value = helper(stage, value)
    chains = json.loads(value)['chains']
    active = json.loads(helper('reconcile-human-pause-active-pause', value))
    require(active['result'] != 'state_inconsistent', 'ambiguous active graph')
    matching = [c for c in chains if c['pre_resume']['pause_id'] == SOURCE]
    require(len(matching) == 1, 'source chain is not unique')
    chain = matching[0]
    source = [r for r in chain['records'] if r['pause_id'] == SOURCE]
    require(len(source) == 1 and source[0]['record']['kind'] == 'pause'
            and source[0]['record']['paused_head'] == OLD
            and chain['pre_resume']['reason'] == 'claude_execution_failed', 'source identity')
    accepted = [r for c in chains for r in c['records']
                if r['record']['kind'] == 'ai-resume-accepted']
    if accepted:
        require(len(accepted) == 1 and accepted[0]['record'] == ACCEPTED,
                'different or duplicate acceptance')
        require(chain['effective']['status'] == 'consumed'
                and chain['effective']['accepted_record_id'] == accepted[0]['pause_id']
                and active['result'] == 'no_active_pause', 'acceptance not consumed / replacement exists')
        return accepted[0]['pause_id']
    require(active.get('active_pause', {}).get('pause_id') == SOURCE
            and chain['effective']['status'] == 'active', 'source not sole active pause')
    return None


def labels(number):
    value = api(f'issues/{number}')
    require(value['number'] == number and value['state'] == 'open', 'issue state')
    require(isinstance(value['labels'], list)
            and all(isinstance(x['name'], str) for x in value['labels']), 'invalid labels')
    return any(x['name'] == 'human-review-required' for x in value['labels'])


def current(trusted_main):
    pr = api('pulls/1110')
    require(pr['number'] == 1110 and pr['state'] == 'open' and pr['draft'] is False
            and pr['head']['sha'] == HEAD and pr['head']['ref'] == BRANCH
            and pr['head']['repo']['full_name'] == REPO
            and pr['base']['repo']['full_name'] == REPO
            and pr['base']['ref'] == 'main' and pr['base']['sha'] == BASE
            and api('git/ref/heads/main')['object']['sha'] == trusted_main,
            'PR/head/base drift')
    return pr


def authorize():
    require(os.environ['GITHUB_REPOSITORY'] == REPO
            and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch'
            and os.environ['GITHUB_REF'] == 'refs/heads/main'
            and os.environ['GITHUB_ACTOR'] == 'suzukure'
            and os.environ['GITHUB_TRIGGERING_ACTOR'] == 'suzukure', 'untrusted invocation')
    require(api('')['default_branch'] == 'main', 'default branch')
    permission = api('collaborators/suzukure/permission')
    require(permission['user']['login'] == 'suzukure'
            and permission['permission'] in ('admin', 'write'), 'actor permission')
    base = api('git/ref/heads/main')['object']['sha']
    require(base == os.environ['GITHUB_SHA'], 'dispatch code is no longer current main')
    require(run(['git', '-C', str(SCRIPTS.parent.parent), 'rev-parse', 'HEAD']).strip() == base,
            'trusted checkout mismatch')
    return base


def changed_paths(source, before, after):
    value = run(['git', 'diff', '--no-renames', '--name-only', '-z', before, after], cwd=source)
    require(not value or value.endswith('\0'), 'invalid diff framing')
    paths = value.split('\0')[:-1] if value else []
    require(all(paths) and len(paths) == len(set(paths)), 'invalid changed paths')
    return set(paths)


def verify_relation(trusted_main):
    # A fresh, unshallow checkout of the fixed PR HEAD is the only source of
    # git ancestry and merged-tree evidence; neither branch is modified.
    source = os.environ['RECOVERY_SOURCE']
    require(run(['git', 'rev-parse', 'HEAD'], cwd=source).strip() == HEAD
            and run(['git', 'rev-parse', '--is-shallow-repository'], cwd=source).strip() == 'false',
            'qualification checkout mismatch')
    for commit in (BASE, ANCHOR, trusted_main):
        require(run(['git', 'rev-parse', commit + '^{commit}'], cwd=source).strip() == commit,
                'qualification commit unavailable')
    require(run(['git', 'rev-list', '--parents', '-n', '1', ANCHOR], cwd=source).split()
            == [ANCHOR, BASE], 'anchor ancestry drift')
    require(run(['git', 'rev-list', '--parents', '-n', '1', trusted_main], cwd=source).split()
            == [trusted_main, ANCHOR], 'main is not the single approved squash')
    require(run(['git', 'merge-base', BASE, HEAD], cwd=source).strip() == BASE
            and run(['git', 'merge-base', trusted_main, HEAD], cwd=source).strip() == BASE,
            'PR/main common ancestor changed')
    require(changed_paths(source, BASE, ANCHOR) == ANCHOR_FILES
            and changed_paths(source, ANCHOR, trusted_main) == PATCH_FILES,
            'unexpected main changes')
    require(changed_paths(source, BASE, HEAD) == FILES
            and not (changed_paths(source, BASE, trusted_main) & FILES),
            'PR diff or path isolation changed')
    # Git's actual merge engine must produce a clean tree. Verify every PR doc
    # blob comes from HEAD and every trusted recovery blob comes from main.
    merged_tree = run(['git', 'merge-tree', '--write-tree', trusted_main, HEAD],
                      cwd=source).strip()
    require(len(merged_tree) == 40 and all(c in '0123456789abcdef' for c in merged_tree),
            'invalid merged tree')
    run(['git', 'diff', '--quiet', '--no-ext-diff', HEAD, merged_tree, '--', *sorted(FILES)],
        cwd=source)
    run(['git', 'diff', '--quiet', '--no-ext-diff', trusted_main, merged_tree, '--',
         *sorted(ANCHOR_FILES)], cwd=source)


def jobs(run_id, attempt):
    return pages(f'actions/runs/{run_id}/attempts/{attempt}/jobs', 'jobs')


def normal_review(accepted):
    fact = api('issues/comments/' + accepted)
    require(fact['id'] == int(accepted) and fact['performed_via_github_app']['id'] == APP,
            'accepted provenance')
    candidates = [r for r in pages('actions/workflows/claude-review.yml/runs?event=pull_request', 'workflow_runs')
                  if r['head_sha'] == HEAD and r['head_branch'] == BRANCH
                  and r['created_at'] >= fact['created_at']
                  and r['event'] == 'pull_request' and r['path'] == '.github/workflows/claude-review.yml'
                  and r['head_repository']['full_name'] == REPO
                  and any(p['number'] == 1110 and p['head']['sha'] == HEAD for p in r['pull_requests'])]
    # No re-run or second candidate is interpreted as permission for another event.
    require(len(candidates) <= 1, 'multiple normal Review candidates')
    if not candidates:
        return False
    candidate = candidates[0]
    require(candidate['run_attempt'] == 1, 'normal Review rerun requires human inspection')
    review = [j for j in jobs(candidate['id'], 1) if j['name'] == 'Review']
    require(len(review) <= 1, 'ambiguous Review job')
    if not review:
        return False
    review = review[0]
    if review['conclusion'] in ('failure', 'cancelled', 'timed_out', 'stale'):
        raise ValueError('normal Review failed; retain normal failure-handler pause')
    steps = [s for s in review['steps'] if s['name'] == 'Select Claude review model']
    require(len(steps) <= 1, 'ambiguous model-selection step')
    return bool(steps and (steps[0]['status'] == 'in_progress'
                          or steps[0]['conclusion'] == 'success'))


def first_apply():
    # Persisted Actions attempts are the conservative cross-run fence. Missing
    # history is NOT proof that an uncertain earlier POST never committed.
    own = int(os.environ['GITHUB_RUN_ID'])
    require(os.environ['GITHUB_RUN_ATTEMPT'] == '1', 're-run cannot make a new acceptance')
    runs = pages('actions/workflows/recover-pr1110-claude-pause.yml/runs', 'workflow_runs')
    require(sum(r['id'] == own for r in runs) == 1, 'current recovery run missing')
    numbers = [r['run_number'] for r in runs]
    require(numbers and all(type(n) is int and n > 0 for n in numbers)
            and len(numbers) == len(set(numbers))
            and set(numbers) == set(range(1, len(numbers) + 1)),
            'deleted or expired recovery history; no new acceptance')
    for value in runs:
        require(value['path'] == WORKFLOW and value['event'] == 'workflow_dispatch'
                and value['head_repository']['full_name'] == REPO, 'recovery history identity')
        if value['id'] == own:
            continue
        # A job created for apply may already have sent a write, even after a
        # crash or lost response. Check-only dispatches have no started apply job.
        require(value['run_attempt'] <= 20, 'attempt history exceeds bound')
        for attempt in range(1, value['run_attempt'] + 1):
            for job in jobs(value['id'], attempt):
                require(not (job['name'] == 'Apply fixed recovery'
                             and job.get('started_at') is not None
                             and job['conclusion'] != 'skipped'), 'prior apply may have written; human inspection required')


def qualify(trusted_main):
    pr = current(trusted_main)
    metadata = json.loads(run(['gh', 'pr', 'view', '1110', '--repo', REPO,
                              '--json', 'closingIssuesReferences']))
    require([i['number'] for i in metadata['closingIssuesReferences']] == [1109], 'closing issue relation')
    files = pages('pulls/1110/files')
    require(pr['changed_files'] == len(files) == len(FILES)
            and {f['filename'] for f in files} == FILES
            and all(f['status'] == 'modified' for f in files), 'PR file inventory changed')
    require(pages('pulls/1110/reviews') == [], 'unexpected formal review')
    base_date = datetime.fromisoformat(api('commits/' + BASE)['commit']['committer']['date'].replace('Z', '+00:00'))
    source = api('issues/comments/' + SOURCE)
    require(source['id'] == int(SOURCE) and source['performed_via_github_app']['id'] == APP,
            'source App provenance')
    with tempfile.TemporaryDirectory() as directory:
        record = Path(directory) / 'source.md'
        record.write_text(source['body'], encoding='utf-8')
        parsed = json.loads(helper('human-pause-record', None, 'parse', str(record)))
    require(parsed['kind'] == 'pause' and parsed['target'] == 'pr:1110'
            and parsed['reason'] == 'claude_execution_failed' and parsed['paused_head'] == OLD,
            'source record changed')
    failed = api('actions/runs/41793021156')
    require(failed['path'] == '.github/workflows/claude-review.yml'
            and failed['event'] == 'pull_request' and failed['head_branch'] == BRANCH
            and failed['head_repository']['full_name'] == REPO
            and failed['head_sha'] == OLD
            and failed['run_attempt'] == 1 and failed['conclusion'] == 'failure'
            and any(p['number'] == 1110 for p in failed['pull_requests']),
            'failed Review identity')
    review = [j for j in jobs(41793021156, 1) if j['name'] == 'Review']
    require(len(review) == 1, 'failed Review job missing')
    for name, conclusion in [('Build review context', 'failure'), ('Select Claude review model', 'skipped'),
                             ('Run Claude review', 'skipped'), ('Submit reviewer verdict', 'skipped')]:
        steps = [s for s in review[0]['steps'] if s['name'] == name]
        require(len(steps) == 1 and steps[0]['conclusion'] == conclusion, 'pre-model failure not proven')
    runs = pages(f'actions/runs?head_sha={HEAD}', 'workflow_runs')
    for workflow in ('product-ci.yml', 'traceability-check.yml'):
        matches = [r for r in runs if r['path'] == '.github/workflows/' + workflow
                   and r['event'] == 'pull_request' and r['head_sha'] == HEAD
                   and r['head_repository']['full_name'] == REPO
                   and any(p['number'] == 1110 and p['head']['sha'] == HEAD
                           and p['base']['sha'] == BASE for p in r['pull_requests'])]
        require(matches, 'no CI evidence for current base')
        latest = max(matches, key=lambda r: r['id'])
        require(latest['status'] == 'completed' and latest['conclusion'] == 'success', 'CI is not successful')
        require(datetime.fromisoformat(latest['created_at'].replace('Z', '+00:00')) >= base_date,
                'CI predates current base; requalification required')
    source_dir = os.environ['RECOVERY_SOURCE']
    require(run(['git', 'rev-parse', 'HEAD'], cwd=source_dir).strip() == HEAD
            and run(['git', 'rev-parse', '--is-shallow-repository'], cwd=source_dir).strip() == 'false',
            'qualification checkout mismatch')
    renderer = api('actions/runs/41793316677')
    require(renderer['path'] == '.github/workflows/render-plantuml.yml'
            and renderer['event'] == 'push' and renderer['conclusion'] == 'success'
            and renderer['head_repository']['full_name'] == REPO
            and renderer['head_branch'] == BRANCH and renderer['run_attempt'] == 1
            and renderer['head_sha'] == '5cc1448038e0963b6bb826b53f44870376fc94c4', 'renderer run provenance')
    identity = run(['git', 'show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%s', HEAD], cwd=source_dir).splitlines()
    require(identity == ['github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com',
                         'github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com',
                         'Render PlantUML diagrams'], 'renderer commit provenance')
    require(run(['git', 'rev-parse', HEAD + '^'], cwd=source_dir).strip() == renderer['head_sha'],
            'renderer source parent')
    for path in sorted(FILES):
        if path.endswith('.svg'):
            require(run(['git', 'log', '-1', '--format=%H', HEAD, '--', path], cwd=source_dir).strip() == HEAD,
                    'generated SVG last commit mismatch')
    with tempfile.TemporaryDirectory() as directory:
        builder = Path(directory) / 'builder.sh'
        builder.write_text(run(['git', 'show', trusted_main + ':.github/scripts/build-review-context.sh'],
                               cwd=source_dir), encoding='utf-8')
        env = read_env()
        env.update(SOURCE_BASE_SHA=trusted_main, BASE_SHA=trusted_main)
        run(['bash', str(builder), REPO, '1110', str(Path(directory) / 'review.md'),
             'nssscdl-chatgpt-dev[bot],nssscdl-claude-review[bot]',
             'nssscdl-claude-review[bot]', '', HEAD], cwd=source_dir, env=env)
    current(trusted_main)


def write_once(path, method, body=None):
    env = read_env()
    env['GH_TOKEN'] = os.environ['GH_WRITE_TOKEN']
    args = ['gh', 'api', '-X', method, '/repos/' + REPO + '/' + path]
    if body is not None:
        args += ['-f', 'body=' + body]
    # Never retry, including a malformed/lost response. The caller reconciles
    # through fresh GETs. A hard kill leaves no automatic write continuation.
    result = subprocess.run(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        print('write response unknown; reconciling without retry', file=sys.stderr)


def main():
    os.environ['AI_RESUME_MAX_HISTORY_PAGES'] = '10'
    trusted_main = authorize()
    current(trusted_main)
    verify_relation(trusted_main)
    accepted = graph()
    if accepted:
        current(trusted_main)
        if not labels(1109) and not labels(1110) and normal_review(accepted):
            print('normal_review_owns; no writes')
            return
        raise ValueError('accepted transition interrupted or ownership unknown; no automatic continuation')
    require(labels(1109) and labels(1110), 'both pause labels required')
    qualify(trusted_main)
    require(graph() is None and labels(1109) and labels(1110), 'state changed during qualification')
    if MODE == 'check':
        print('check passed; no writes; production execution requires separate human Go')
        return
    first_apply()
    slug = os.environ['REVIEWER_APP_SLUG']
    require(slug == 'nssscdl-claude-review', 'writer App slug mismatch')
    app = json.loads(run(['gh', 'api', '/apps/' + slug]))
    require(app['id'] == APP, 'writer App ID mismatch')
    body = helper('human-pause-record', None, 'create', json.dumps(ACCEPTED))
    current(trusted_main)
    require(graph() is None and labels(1109) and labels(1110), 'state changed before acceptance')
    write_once('issues/1110/comments', 'POST', body)
    accepted = graph()
    require(accepted is not None, 'acceptance outcome unknown; never re-POST')
    for number in (1109, 1110):
        current(trusted_main)
        require(graph() == accepted and labels(number), 'state changed before label removal')
        if number == 1110:
            require(not labels(1109), 'Issue must be cleared before PR')
        write_once(f'issues/{number}/labels/human-review-required', 'DELETE')
        require(not labels(number), 'label outcome unknown; never re-DELETE')
    for poll in range(9):
        current(trusted_main)
        require(graph() == accepted and not labels(1109) and not labels(1110), 'handoff state changed')
        if normal_review(accepted):
            print('normal_review_owns; no automatic paid retry or merge')
            return
        if poll < 8:
            time.sleep(10)
    raise ValueError('normal Review ownership unknown; no further writes')


try:
    main()
except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
    # Do not echo API bodies, environment values, or subprocess stderr.
    print('recover-pr1110: stopped; inspect qualification/graph/attempt/labels; no automatic retry', file=sys.stderr)
    if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError):
        print(str(error), file=sys.stderr)
    sys.exit(1)
PY
