#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && ( $1 == check || $1 == apply || $1 == identity ) ]] || exit 64
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Embedded implementation keeps the exceptional consumer within the frozen path.
# No PR code is executed. Existing schema and lifecycle primitives remain canonical.
python3 -I -B - "$1" "$script_dir" <<'PY'
import json
import base64
import hashlib
from datetime import datetime
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

MODE, SCRIPTS = sys.argv[1], Path(sys.argv[2])
REPO = 'suzukure/nssscdl'
HEAD = '50ac09107c1d80fdcdbb03dc0e0a63e012be9137'
OLD = 'ad90e514aeac5789f7fdb4af600e6c3f60b6c4b1'
BRANCH = 'docs/issue-1108-student-booking-ux-contract'
SOURCE = '6677464836'
THIRD_SOURCE = '6676369307'
THIRD_ACCEPTED_ID = '6677446829'
PREVIOUS_SOURCE = '6625324624'
PREVIOUS_ACCEPTED_ID = '6660744739'
SECOND_SOURCE = '6660775078'
SECOND_ACCEPTED_ID = '6676352162'
FAILED_REVIEW = 42166545359
APP = 4777865
WORKFLOW = '.github/workflows/recover-pr1110-claude-pause.yml'
BASE = '17f63a0a9e9ebf2ecd03c1e9329f8200362aebc5'
ANCHOR = '637278268f8269d31187674c21adb69dc4f55aac'
PATCH_BASE = 'c9ed0a3c4e6963e1fece9d96d2c3588c38cd3107'
READ_FIX_BASE = '09759be3c42eb00b3120a4e777715d3c2a9b4bda'
AUTH_FIX_BASE = '035dfa0677fa980c204e500ab9420aae6ec8d67f'
CONTEXT_FIX_BASE = 'f4a152780f76d8cf8dfaa6143646e4cba93dfd45'
RESUME_FIX_BASE = '82a3ca6cfc394341eb4b9c8d8fcdb1a6e10ab496'
BOT_FIX_BASE = 'dc166e971b8ba66f1eb67a04004e439b3837a8fc'
HUMAN = 'suzukure'
EXECUTION_REF = 'refs/pull/1110/merge'
WORKFLOW_BLOBS = {'bfa3a7c0e87674fd03a07aebc7f67457a8c81360',
                  '8d500ae7882c25bac29057a46fbdee672535b970'}
ADJUDICATED_RUN = 42033641429
PREVIOUS_APPLY_RUN = 42046727170
LATEST_APPLY_RUN = 42158645486
HANDOFF_APPLY_RUN = 42166385390
HISTORY_PREFIX = {1: 42006744571, 2: 42032705936, 3: ADJUDICATED_RUN,
                  4: 42046054836, 5: PREVIOUS_APPLY_RUN,
                  6: 42155234932, 7: LATEST_APPLY_RUN,
                  8: 42165919982, 9: HANDOFF_APPLY_RUN}
# This one-off consumer is valid only for the next single-parent squash on BOT_FIX_BASE.
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
CONTEXT_FILES = PATCH_FILES | {'.github/scripts/build-review-context.sh',
                               '.github/scripts/test-build-review-context.sh'}
CURRENT_FILES = PATCH_FILES | {'.github/workflows/claude-review.yml'}
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
                payload=dict(action='review', recovery_issue=1111,
                             handoff='human-final-unlabel', actor=HUMAN))
LEGACY_PAYLOAD = dict(action='review', recovery_issue=1111)
PREVIOUS_ACCEPTED = dict(ACCEPTED, source_pause_id=PREVIOUS_SOURCE, payload=LEGACY_PAYLOAD)
SECOND_ACCEPTED = dict(ACCEPTED, source_pause_id=SECOND_SOURCE, payload=LEGACY_PAYLOAD)
THIRD_ACCEPTED = dict(ACCEPTED, source_pause_id=THIRD_SOURCE, payload=LEGACY_PAYLOAD)
PREVIOUS_PAUSE = dict(version=1, kind='pause', reason='claude_execution_failed',
                      target='pr:1110', paused_head=OLD,
                      payload=dict(detail='Claude Review jobが正常完了しませんでした。実行結果を確認してください。'))
SECOND_PAUSE = dict(PREVIOUS_PAUSE, paused_head=HEAD)


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


def api(path, *, comments=False):
    endpoint = '/repos/' + REPO + ('/' + path if path else '')
    args = ['gh', 'api']
    if comments:
        args += ['-H', 'Accept: application/vnd.github+json']
    return json.loads(run([*args, endpoint]))


def pages(path, key=None, *, comments=False):
    result = []
    total = None
    for page in range(1, 11):
        value = api(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}',
                    comments=comments)
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


def listed_record(comment_id):
    # Match the proven Conversation-list reader, including its Accept header.
    # A null App on the single-comment endpoint is never a trust fallback.
    require(isinstance(comment_id, str) and re.fullmatch(r'[1-9][0-9]*', comment_id),
            'comment_id_invalid')
    try:
        comments = pages('issues/1110/comments', comments=True)
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        raise ValueError('comment_list_read_failed') from None
    require(all(isinstance(c, dict) for c in comments), 'comment_list_invalid')
    matches = [c for c in comments if type(c.get('id')) is int and c['id'] == int(comment_id)]
    require(len(matches) == 1, 'comment_missing_or_duplicate')
    fact = matches[0]
    app = fact.get('performed_via_github_app')
    require(isinstance(app, dict) and type(app.get('id')) is int and app['id'] == APP,
            'comment_app_unverified')
    require(isinstance(fact.get('body'), str), 'comment_body_invalid')
    with tempfile.TemporaryDirectory() as directory:
        file = Path(directory) / 'record.md'
        file.write_text(fact['body'], encoding='utf-8')
        try:
            record = json.loads(helper('human-pause-record', None, 'parse', str(file)))
        except (ValueError, subprocess.SubprocessError):
            raise ValueError('comment_record_invalid') from None
    require(record['target'] == 'pr:1110', 'comment_target_mismatch')
    return fact, record


def graph(expected_source=None):
    value = helper('list-human-pause-records', None, REPO, '1109', '1110', str(APP))
    for stage in ('validate-human-pause-record-graph', 'decompose-human-pause-record-graph',
                  'derive-human-pause-pre-resume-state', 'reconcile-human-pause-resume-acceptance'):
        value = helper(stage, value)
    chains = json.loads(value)['chains']
    active = json.loads(helper('reconcile-human-pause-active-pause', value))
    require(active['result'] != 'state_inconsistent', 'ambiguous active graph')
    previous = [c for c in chains if c['pre_resume']['pause_id'] == PREVIOUS_SOURCE]
    require(len(chains) == 4 and len(previous) == 1, 'previous/current chains changed')
    previous = previous[0]
    require({r['pause_id']: r['record'] for r in previous['records']}
            == {PREVIOUS_SOURCE: PREVIOUS_PAUSE, PREVIOUS_ACCEPTED_ID: PREVIOUS_ACCEPTED}
            and len(previous['records']) == 2
            and previous['effective']['status'] == 'consumed'
            and previous['effective']['accepted_record_id'] == PREVIOUS_ACCEPTED_ID,
            'previous consumption changed')
    second = [c for c in chains if c['pre_resume']['pause_id'] == SECOND_SOURCE]
    require(len(second) == 1, 'second chain changed')
    second = second[0]
    require({r['pause_id']: r['record'] for r in second['records']}
            == {SECOND_SOURCE: SECOND_PAUSE, SECOND_ACCEPTED_ID: SECOND_ACCEPTED}
            and len(second['records']) == 2
            and second['effective']['status'] == 'consumed'
            and second['effective']['accepted_record_id'] == SECOND_ACCEPTED_ID,
            'second consumption changed')
    third = [c for c in chains if c['pre_resume']['pause_id'] == THIRD_SOURCE]
    require(len(third) == 1, 'third chain changed')
    third = third[0]
    require({r['pause_id']: r['record'] for r in third['records']}
            == {THIRD_SOURCE: SECOND_PAUSE, THIRD_ACCEPTED_ID: THIRD_ACCEPTED}
            and len(third['records']) == 2
            and third['effective']['status'] == 'consumed'
            and third['effective']['accepted_record_id'] == THIRD_ACCEPTED_ID,
            'third consumption changed')
    matching = [c for c in chains if c['pre_resume']['pause_id'] == SOURCE]
    require(len(matching) == 1, 'source chain is not unique')
    chain = matching[0]
    source = [r for r in chain['records'] if r['pause_id'] == SOURCE]
    require(len(source) == 1 and source[0]['record']['kind'] == 'pause'
            and source[0]['record']['paused_head'] == HEAD
            and chain['pre_resume']['reason'] == 'claude_execution_failed'
            and source[0]['record'] == SECOND_PAUSE, 'source identity')
    require(expected_source is None or source[0]['record'] == expected_source,
            'source_record_changed_during_read')
    accepted = [r for r in chain['records'] if r['record']['kind'] == 'ai-resume-accepted']
    require(len(chain['records']) == 1 + len(accepted), 'current chain has replacement or extra record')
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
            and isinstance(pr['labels'], list)
            and all(isinstance(x, dict) and isinstance(x.get('name'), str) for x in pr['labels'])
            and not any(x['name'] == 'ai-followup-in-progress' for x in pr['labels'])
            and api('git/ref/heads/main')['object']['sha'] == trusted_main,
            'PR/head/base drift')
    return pr


def authorize():
    require(os.environ['GITHUB_REPOSITORY'] == REPO
            and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch'
            and os.environ['GITHUB_REF'] == 'refs/heads/main'
            and os.environ['GITHUB_ACTOR'] == 'suzukure'
            and os.environ['GITHUB_TRIGGERING_ACTOR'] == 'suzukure'
            and os.environ['GITHUB_RUN_ATTEMPT'] == '1', 'untrusted invocation')
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
    transitions = ((BASE, ANCHOR, ANCHOR_FILES), (ANCHOR, PATCH_BASE, PATCH_FILES),
                   (PATCH_BASE, READ_FIX_BASE, PATCH_FILES),
                   (READ_FIX_BASE, AUTH_FIX_BASE, ANCHOR_FILES),
                   (AUTH_FIX_BASE, CONTEXT_FIX_BASE, CONTEXT_FILES),
                   (CONTEXT_FIX_BASE, RESUME_FIX_BASE, PATCH_FILES),
                   (RESUME_FIX_BASE, BOT_FIX_BASE, CURRENT_FILES),
                   (BOT_FIX_BASE, trusted_main, PATCH_FILES))
    for commit in (BASE, ANCHOR, PATCH_BASE, READ_FIX_BASE, AUTH_FIX_BASE, CONTEXT_FIX_BASE,
                   RESUME_FIX_BASE, BOT_FIX_BASE, trusted_main):
        require(run(['git', 'rev-parse', commit + '^{commit}'], cwd=source).strip() == commit,
                'qualification commit unavailable')
    for before, after, paths in transitions:
        require(run(['git', 'rev-list', '--parents', '-n', '1', after], cwd=source).split()
                == [after, before], 'approved main ancestry drift')
        require(changed_paths(source, before, after) == paths, 'unexpected main changes')
    require(run(['git', 'merge-base', BASE, HEAD], cwd=source).strip() == BASE
            and run(['git', 'merge-base', trusted_main, HEAD], cwd=source).strip() == BASE,
            'PR/main common ancestor changed')
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
         *sorted(ANCHOR_FILES | CONTEXT_FILES | CURRENT_FILES)], cwd=source)


def verify_review_entry(trusted_main):
    # The event's immutable merge commit, not main's YAML, selects its inputs.
    fact = api('git/ref/pull/1110/merge')
    require(fact['ref'] == EXECUTION_REF, 'execution ref changed')
    merge = fact['object']['sha']
    require(isinstance(merge, str) and re.fullmatch(r'[0-9a-f]{40}', merge), 'invalid execution SHA')
    commit = api('git/commits/' + merge)
    require(commit['sha'] == merge and len(commit['parents']) == 2
            and commit['parents'][0]['sha'] in (CONTEXT_FIX_BASE, RESUME_FIX_BASE, BOT_FIX_BASE, trusted_main)
            and commit['parents'][1]['sha'] == HEAD, 'execution merge ancestry changed')
    path = '.github/workflows/claude-review.yml'
    file = api('contents/' + path + '?ref=' + merge)
    require(file['path'] == path and file['type'] == 'file' and file['encoding'] == 'base64'
            and file['sha'] in WORKFLOW_BLOBS and isinstance(file['content'], str),
            'unqualified execution workflow')
    raw = base64.b64decode(file['content'].replace('\n', ''), validate=True)
    require(file['size'] == len(raw)
            and hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == file['sha'],
            'execution workflow blob mismatch')
    workflow = raw.decode('utf-8')
    require(workflow.count('uses: anthropics/claude-code-action@'
                           '8ce9314fa9a404564fa7e954cd84f25bcba2b829') == 1
            and workflow.count('github_token: ${{ steps.review-token.outputs.token }}') == 1
            and re.search(r'^\s*allowed_non_write_users:', workflow, re.MULTILINE) is None,
            'normal Review Action contract changed')
    # These two exact blobs have the existing unlabeled/open/Ready/head/Issue
    # gates. Their bot allowlists differ, but both admit User suzukure after
    # GitHub's independent write/admin check. No bot wildcard is introduced.
    require(api('git/ref/pull/1110/merge')['object']['sha'] == merge, 'execution ref drift')
    return dict(execution_ref=EXECUTION_REF, merge_sha=merge, workflow_blob=file['sha'])


def jobs(run_id, attempt):
    return pages(f'actions/runs/{run_id}/attempts/{attempt}/jobs', 'jobs')


def normal_review(accepted, *, waiting=False):
    fact, record = listed_record(accepted)
    require(record == ACCEPTED, 'accepted_record_mismatch')
    created = fact.get('created_at')
    require(isinstance(created, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', created),
            'accepted_timestamp_invalid')
    try:
        datetime.fromisoformat(created.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('accepted_timestamp_invalid') from None
    # Fetch only this HEAD/event. Unrelated PRs must not change pagination's
    # total_count or exhaust the bounded reader before client-side filtering.
    runs = pages(f'actions/runs?head_sha={HEAD}&event=pull_request', 'workflow_runs')
    require(all(r['head_sha'] == HEAD and r['event'] == 'pull_request'
                and r['head_repository']['full_name'] == REPO for r in runs),
            'normal Review query scope changed')
    candidates = [r for r in runs
                  if r['path'] == '.github/workflows/claude-review.yml'
                  and r['head_sha'] == HEAD and r['head_branch'] == BRANCH
                  and r['created_at'] >= created
                  and r['event'] == 'pull_request' and r['path'] == '.github/workflows/claude-review.yml'
                  and r['head_repository']['full_name'] == REPO
                  and any(p['number'] == 1110 and p['head']['sha'] == HEAD for p in r['pull_requests'])]
    # No re-run or second candidate is interpreted as permission for another event.
    require(len(candidates) <= 1, 'multiple normal Review candidates')
    if not candidates:
        return False
    require(not waiting, 'Review already requested; inspect human handoff')
    candidate = candidates[0]
    require(candidate['actor']['login'] == candidate['triggering_actor']['login'] == HUMAN
            and candidate['actor']['type'] == candidate['triggering_actor']['type'] == 'User',
            'normal Review actor is not the designated human')
    require(candidate['run_attempt'] == 1, 'normal Review rerun requires human inspection')
    review = [j for j in jobs(candidate['id'], 1) if j['name'] == 'Review']
    require(len(review) <= 1, 'ambiguous Review job')
    if not review:
        return False
    review = review[0]
    if review['conclusion'] in ('failure', 'cancelled', 'timed_out', 'stale'):
        raise ValueError('normal Review failed; retain normal failure-handler pause')
    steps = [s for s in review['steps'] if s['name'] == 'Run Claude review']
    saved = [s for s in review['steps'] if s['name'] == 'Save structured review']
    require(len(steps) <= 1 and len(saved) <= 1, 'ambiguous Claude handoff steps')
    require(not any(s['conclusion'] in ('failure', 'cancelled') for s in steps + saved),
            'normal Review execution failed; retain normal failure-handler pause')
    # Ownership while the Action is running does not claim inference success.
    # An outer Action "success" alone is insufficient: its internal preparation
    # can have failed. Once it ends, require the validated structured result.
    return bool((steps and steps[0]['status'] == 'in_progress')
                or (saved and saved[0]['status'] == 'completed'
                    and saved[0]['conclusion'] == 'success'))


def reviewer_identity():
    # Both token steps use the same pinned Action, numeric app-id=APP and key.
    # GitHub authenticates that issuer/key before returning the installation's
    # slug. These outputs are never used as an alternative to that authentication.
    require(os.environ.get('REVIEWER_APP_SLUG') == 'nssscdl-claude-review',
            'reviewer_app_slug_mismatch')
    require(re.fullmatch(r'[1-9][0-9]*', os.environ.get('REVIEWER_INSTALLATION_ID', '')),
            'reviewer_installation_invalid')


def ended_apply(value, snapshot, run_id, number, main_sha, check_id, apply_id, check_steps,
                *, result='failure'):
    # Fixed historical runs only. No reset or wildcard exemption for prior writes.
    fact = api('actions/runs/' + str(run_id))
    require(value['id'] == fact['id'] == run_id
            and value['run_attempt'] == fact['run_attempt'] == 1
            and value['run_number'] == fact['run_number'] == number
            and fact['workflow_id'] == 407813204 and fact['path'] == WORKFLOW
            and fact['event'] == 'workflow_dispatch' and fact['head_branch'] == 'main'
            and fact['head_sha'] == main_sha
            and fact['head_repository']['full_name'] == REPO
            and fact['actor']['login'] == fact['triggering_actor']['login'] == 'suzukure'
            and fact['status'] == 'completed' and fact['conclusion'] == result,
            'historical_apply_run_changed')
    require(len(snapshot) == 2
            and {j['id'] for j in snapshot} == {check_id, apply_id},
            'historical_apply_jobs_changed')
    for name, job_id, conclusion, expected in (
        ('Read-only qualification', check_id, 'success', [(n, 'success') for n in check_steps]),
        ('Apply fixed recovery', apply_id, result,
         [('Recheck after writer wait', 'success'), ('Create reviewer App token', 'success'),
          ('Consume and hand off once', result), ('Post Create reviewer App token', 'success')]),
    ):
        matching = [j for j in snapshot if j['name'] == name and j['id'] == job_id]
        require(len(matching) == 1 and matching[0]['status'] == 'completed'
                and matching[0]['conclusion'] == conclusion and matching[0]['started_at'] is not None,
                'historical_apply_job_changed')
        for step_name, result in expected:
            steps = [s for s in matching[0]['steps'] if s['name'] == step_name]
            require(len(steps) == 1 and steps[0]['status'] == 'completed'
                    and steps[0]['conclusion'] == result, 'historical_apply_step_changed')


def first_apply():
    try:
        inspect_apply_history()
    except (KeyError, TypeError, OSError, json.JSONDecodeError, subprocess.SubprocessError):
        raise ValueError('recovery_history_read_failed') from None


def inspect_apply_history():
    # Persisted Actions attempts are the conservative cross-run fence. Missing
    # history is NOT proof that an uncertain earlier POST never committed.
    own = int(os.environ['GITHUB_RUN_ID'])
    require(os.environ['GITHUB_RUN_ATTEMPT'] == '1', 're-run cannot make a new acceptance')
    runs = pages('actions/workflows/recover-pr1110-claude-pause.yml/runs', 'workflow_runs')
    require(sum(r['id'] == own for r in runs) == 1, 'current recovery run missing')
    require(own not in HISTORY_PREFIX.values()
            and len({r['id'] for r in runs}) == len(runs), 'historical/current recovery identity')
    for number, run_id in HISTORY_PREFIX.items():
        prefix = [r for r in runs if r['run_number'] == number]
        require(len(prefix) == 1 and prefix[0]['id'] == run_id
                and type(prefix[0]['run_attempt']) is int and prefix[0]['run_attempt'] == 1,
                'historical_prefix_changed')
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
        require(type(value['run_attempt']) is int and 1 <= value['run_attempt'] <= 20,
                'attempt history exceeds bound')
        for attempt in range(1, value['run_attempt'] + 1):
            snapshot = jobs(value['id'], attempt)
            require(snapshot, 'recovery job history missing')
            if value['id'] == ADJUDICATED_RUN:
                ended_apply(value, snapshot, ADJUDICATED_RUN, 3, READ_FIX_BASE,
                            127266077905, 127266269509, ['Check fixed recovery target'])
                continue
            if value['id'] == PREVIOUS_APPLY_RUN:
                # Its accepted record and the subsequent pre-model failure are
                # separately bound to the two exact chains and qualification.
                ended_apply(value, snapshot, PREVIOUS_APPLY_RUN, 5, AUTH_FIX_BASE,
                            127311590060, 127311939569,
                            ['Check fixed recovery target', 'Authenticate reviewer identity with read-only token',
                             'Verify authenticated reviewer identity',
                             'Post Authenticate reviewer identity with read-only token'])
                continue
            if value['id'] == LATEST_APPLY_RUN:
                ended_apply(value, snapshot, LATEST_APPLY_RUN, 7, RESUME_FIX_BASE,
                            127698737202, 127698881204,
                            ['Check fixed recovery target', 'Authenticate reviewer identity with read-only token',
                             'Verify authenticated reviewer identity',
                             'Post Authenticate reviewer identity with read-only token'])
                continue
            if value['id'] == HANDOFF_APPLY_RUN:
                ended_apply(value, snapshot, HANDOFF_APPLY_RUN, 9, BOT_FIX_BASE,
                            127723727029, 127723904663,
                            ['Check fixed recovery target', 'Authenticate reviewer identity with read-only token',
                             'Verify authenticated reviewer identity',
                             'Post Authenticate reviewer identity with read-only token'], result='success')
                continue
            for job in snapshot:
                require(not (job['name'] == 'Apply fixed recovery'
                             and job.get('started_at') is not None
                             and job['conclusion'] != 'skipped'),
                        'prior apply may have written; human inspection required')


def failed_review(accepted_id, source_id, run_id, job_id, expected_steps):
    previous_fact, previous_record = listed_record(accepted_id)
    expected_record = {PREVIOUS_ACCEPTED_ID: PREVIOUS_ACCEPTED, SECOND_ACCEPTED_ID: SECOND_ACCEPTED,
                       THIRD_ACCEPTED_ID: THIRD_ACCEPTED}[accepted_id]
    require(previous_record == expected_record, 'previous acceptance identity')
    source_fact, _ = listed_record(source_id)
    failed = api('actions/runs/' + str(run_id))
    require(failed['id'] == run_id and failed['workflow_id'] == 346485833
            and failed['path'] == '.github/workflows/claude-review.yml'
            and failed['event'] == 'pull_request' and failed['head_branch'] == BRANCH
            and failed['head_repository']['full_name'] == REPO
            and failed['head_sha'] == HEAD and failed['status'] == 'completed'
            and failed['run_attempt'] == 1 and failed['conclusion'] == 'failure'
            and any(p['number'] == 1110 and p['head']['sha'] == HEAD for p in failed['pull_requests']),
            'failed Review identity')
    def utc(value):
        require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value),
                'source_failure_timestamp_invalid')
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(utc(previous_fact['created_at']) < utc(failed['created_at'])
            <= utc(failed['updated_at']) < utc(source_fact['created_at']),
            'source_failure_order_changed')
    review = [j for j in jobs(run_id, 1) if j['name'] == 'Review']
    require(len(review) == 1 and review[0]['id'] == job_id
            and review[0]['status'] == 'completed' and review[0]['conclusion'] == 'failure',
            'failed Review job changed')
    for name, conclusion in expected_steps:
        steps = [s for s in review[0]['steps'] if s['name'] == name]
        require(len(steps) == 1 and steps[0]['status'] == 'completed'
                and steps[0]['conclusion'] == conclusion, 'failed Review steps changed')
    return failed


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
    source_fact, parsed = listed_record(SOURCE)
    require(parsed['kind'] == 'pause' and parsed['target'] == 'pr:1110'
            and parsed['reason'] == 'claude_execution_failed' and parsed['paused_head'] == HEAD,
            'source record changed')
    failed_review(PREVIOUS_ACCEPTED_ID, SECOND_SOURCE, 42047011487, 127312601026,
                  [('Build review context', 'failure'), ('Select Claude review model', 'skipped'),
                   ('Run Claude review', 'skipped'), ('Submit reviewer verdict', 'skipped')])
    # The outer Action step reports success even when its internal actor check
    # fails. Bind the known failure to Save structured review, never infer a
    # successful model call from that outer step.
    failed_review(SECOND_ACCEPTED_ID, THIRD_SOURCE, 42158784510, 127699190932,
                  [('Build review context', 'success'), ('Gate Claude review entry', 'success'),
                   ('Select Claude review model', 'success'), ('Prepare native review schema', 'success'),
                   ('Run Claude review', 'success'), ('Validate Claude review', 'success'),
                   ('Save structured review', 'failure'), ('Submit reviewer verdict', 'skipped'),
                   ('Post Create developer App token for identity allowlist', 'success'),
                   ('Post Create reviewer App token', 'success')])
    failed = failed_review(THIRD_ACCEPTED_ID, SOURCE, FAILED_REVIEW, 127724240242,
                  [('Build review context', 'success'), ('Gate Claude review entry', 'success'),
                   ('Select Claude review model', 'success'), ('Prepare native review schema', 'success'),
                   ('Run Claude review', 'success'), ('Validate Claude review', 'success'),
                   ('Save structured review', 'failure'), ('Submit reviewer verdict', 'skipped'),
                   ('Post Create developer App token for identity allowlist', 'success'),
                   ('Post Create reviewer App token', 'success')])
    runs = pages(f'actions/runs?head_sha={HEAD}', 'workflow_runs')
    reviews = [r for r in runs if r['path'] == '.github/workflows/claude-review.yml'
               and r['created_at'] >= failed['created_at']]
    require(len(reviews) == 1 and reviews[0]['id'] == FAILED_REVIEW
            and reviews[0]['run_attempt'] == 1, 'unexpected subsequent Review')
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
        # Match normal Review's caller identity. The builder separately binds
        # SVG provenance to metadata's PR base and proves main/PR isolation.
        env.update(SOURCE_BASE_SHA=trusted_main, BASE_SHA=trusted_main)
        run(['bash', str(builder), REPO, '1110', str(Path(directory) / 'review.md'),
             'nssscdl-chatgpt-dev,nssscdl-chatgpt-dev[bot],app/nssscdl-chatgpt-dev,'
             'nssscdl-claude-review,nssscdl-claude-review[bot],app/nssscdl-claude-review',
             'nssscdl-claude-review,nssscdl-claude-review[bot],app/nssscdl-claude-review',
             '', HEAD], cwd=source_dir, env=env)
    current(trusted_main)
    return parsed


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
    if MODE == 'identity':
        reviewer_identity()
        print('reviewer App identity verified; no writes')
        return
    verify_relation(trusted_main)
    entry = verify_review_entry(trusted_main)
    ACCEPTED['payload'] = dict(ACCEPTED['payload'], **entry)

    def unchanged_entry():
        current(trusted_main)
        require(verify_review_entry(trusted_main) == entry, 'execution workflow changed during handoff')

    def waiting(accepted):
        require(not labels(1109) and labels(1110), 'not an intentional human waiting state')
        require(not normal_review(accepted, waiting=True), 'unexpected Review before human handoff')
        unchanged_entry()
        require(graph() == accepted and not labels(1109) and labels(1110), 'human handoff state changed')
        print('awaiting_human_unlabel; PR label retained; read-only recheck required before human action')

    accepted = graph()
    if accepted:
        if not labels(1109) and labels(1110):
            # Intent is part of the exact accepted payload. No DELETE is ever
            # repeated, including after a lost response or crash after Issue removal.
            qualify(trusted_main)
            waiting(accepted)
            return
        if not labels(1109) and not labels(1110) and normal_review(accepted):
            unchanged_entry()
            print('normal_review_owns; no writes')
            return
        raise ValueError('accepted transition interrupted or ownership unknown; no automatic continuation')
    require(labels(1109) and labels(1110), 'both pause labels required')
    qualified_source = qualify(trusted_main)
    require(graph(qualified_source) is None and labels(1109) and labels(1110),
            'state changed during qualification')
    first_apply()
    unchanged_entry()
    if MODE == 'check':
        print('qualification/history passed; no writes; reviewer identity preflight follows')
        return
    reviewer_identity()
    body = helper('human-pause-record', None, 'create', json.dumps(ACCEPTED))
    unchanged_entry()
    require(graph(qualified_source) is None and labels(1109) and labels(1110),
            'state changed before acceptance')
    write_once('issues/1110/comments', 'POST', body)
    accepted = graph(qualified_source)
    require(accepted is not None, 'acceptance outcome unknown; never re-POST')
    unchanged_entry()
    require(graph(qualified_source) == accepted and labels(1109) and labels(1110),
            'state changed before Issue label removal')
    write_once('issues/1109/labels/human-review-required', 'DELETE')
    require(not labels(1109), 'label outcome unknown; never re-DELETE')
    waiting(accepted)


try:
    main()
except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
    # Do not echo API bodies, environment values, or subprocess stderr.
    print('recover-pr1110: stopped; inspect qualification/graph/attempt/labels; no automatic retry', file=sys.stderr)
    if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError):
        print(str(error), file=sys.stderr)
    sys.exit(1)
PY
