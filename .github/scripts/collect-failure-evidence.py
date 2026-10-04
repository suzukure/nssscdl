#!/usr/bin/env python3
"""Trusted read-only AI Workflow Regression consumer (#687). No source execution."""

import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('failure_packet', 'build-failure-evidence-packet.py')
selector = load('context_selector', 'build-development-context.py')
WORKFLOW = 'AI Workflow Regression'
WORKFLOW_PATH = '.github/workflows/ai-workflow-regression.yml'
# #751 prepared topology; production sharding/aggregate implementation is #698.
SHARD_WORKERS = {'Fixture shard 1', 'Fixture shard 2'}
SHARD_TERMINAL = 'Regression Result'
API_CAP = 2 * 1024 * 1024
LOG_CAP = 16 * 1024 * 1024
# Exact headings only; never infer a missing contract from prose/model output.
HEADINGS = {
    'goal': {'目的', 'Goal', '利用者、完了する業務、価値'},
    'scope': {'対象', 'Scope', '実装・DB・テスト・運用の範囲', '対象IDと設計'},
    'security': {'Security', 'Security boundary', 'Permissions', 'セキュリティ境界'},
    'non_goals': {'Non-goals', '対象外', '依存関係と対象外'},
    'done': {'完了条件', 'Done', '完了条件と残課題'},
    'product_impact': {'Product impact', 'Product impact / traceability', 'Product影響'},
}


class Refusal(Exception):
    def __init__(self, reason, status='incomplete'):
        self.reason, self.status = reason, status


def require(condition, reason, status='incomplete'):
    if not condition:
        raise Refusal(reason, status)


def integer(value):
    return type(value) is int and value > 0


def sha(value):
    return type(value) is str and builder.SHA.fullmatch(value) is not None


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'malformed_response')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: require(False, 'malformed_response'))
    except (ValueError, UnicodeError, RecursionError):
        raise Refusal('malformed_response') from None


def command(args, cap=API_CAP):
    # Fixed argv, no shell. Full logs may exist only in this disposable tempfile,
    # never in the output directory/artifact; stderr is never echoed.
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(args, stdout=output, stderr=subprocess.DEVNULL,
                                    timeout=45, check=False)
            require(result.returncode == 0, 'read_failed')
            require(output.tell() <= cap, 'response_oversized', 'oversized')
            output.seek(0)
            return output.read(cap + 1)
    except (OSError, subprocess.TimeoutExpired):
        raise Refusal('read_failed') from None


def api(path):
    return parse(command(['gh', 'api', '--method', 'GET', path]))


def pages(path, key=None):
    result = []
    for page in range(1, 32):
        response = api(f'{path}?per_page=100&page={page}')
        if key:
            require(type(response) is dict and type(response.get('total_count')) is int
                    and response['total_count'] >= 0, 'malformed_response')
            entries = response.get(key)
        else:
            entries = response
        require(type(entries) is list and len(entries) <= 100
                and all(type(item) is dict for item in entries), 'malformed_response')
        result.extend(entries)
        if len(entries) < 100:
            if key:
                require(len(result) == response['total_count'], 'pagination_incomplete')
            return result
    raise Refusal('pagination_limit', 'oversized')


def repository(value, expected):
    require(type(value) is dict and integer(value.get('id')) and value.get('id') == expected['id']
            and value.get('full_name') == expected['full_name'], 'repository_mismatch', 'conflict')


def run_identity(run, expected, repo):
    require(type(run) is dict, 'malformed_response')
    for key in ('id', 'run_attempt', 'workflow_id'):
        require(integer(run.get(key)) and integer(expected.get(key)) and run[key] == expected.get(key),
                'run_identity_mismatch', 'conflict')
    repository(run.get('repository'), repo)
    # Fork code is evidence only; never checked out or executed.
    require(type(run.get('head_repository')) is dict
            and integer(run['head_repository'].get('id'))
            and type(run['head_repository'].get('full_name')) is str, 'malformed_response')
    for key, value in [('name', WORKFLOW), ('path', WORKFLOW_PATH),
                       ('event', 'pull_request'), ('status', 'completed'), ('conclusion', 'failure')]:
        require(run.get(key) == value and expected.get(key) == value,
                'workflow_identity_mismatch', 'conflict')
    require(sha(run.get('head_sha')) and run['head_sha'] == expected.get('head_sha'),
            'run_identity_mismatch', 'conflict')
    require(type(run.get('pull_requests')) is list, 'malformed_response')


def pr_snapshot(repo, number, expected_repo):
    pr = api(f'/repos/{repo}/pulls/{number}')
    require(type(pr) is dict and pr.get('number') == number and type(pr.get('head')) is dict
            and type(pr.get('base')) is dict and sha(pr['head'].get('sha')), 'malformed_response')
    repository(pr['base'].get('repo'), expected_repo)
    require(pr['base'].get('ref') == 'main', 'pr_base_mismatch', 'conflict')
    return pr


def closing_issue(repo, number, head):
    value = parse(command(['gh', 'pr', 'view', str(number), '--repo', repo,
                          '--json', 'number,headRefOid,closingIssuesReferences']))
    require(type(value) is dict and value.get('number') == number
            and value.get('headRefOid') == head, 'pr_snapshot_changed', 'stale')
    refs = value.get('closingIssuesReferences')
    require(type(refs) is list and all(type(ref) is dict and integer(ref.get('number'))
            and ref.get('url') == f"https://github.com/{repo}/issues/{ref['number']}"
            for ref in refs), 'issue_relation_invalid', 'conflict')
    require(len(refs) != 0, 'issue_relation_missing')
    require(len(refs) == 1, 'issue_relation_ambiguous', 'conflict')
    return refs[0]['number']


def evidence(text, kind, ident, path, start=1, step=None):
    require(type(text) is str and text.strip(), 'evidence_missing')
    require(not builder.SECRET.search(text), 'secret_like_evidence')
    loc = dict(repository=ident['repository'], ref='main' if kind == 'issue' else 'run_head',
               sha=ident['current_main_sha'] if kind == 'issue' else ident['run_head_sha'],
               path=path, line_start=start, line_end=start + len(text.splitlines()) - 1,
               issue_number=ident['issue_number'], pr_number=ident['pr_number'],
               run_id=ident['run_id'] if kind == 'log' else None,
               run_attempt=ident['run_attempt'] if kind == 'log' else None,
               job_id=ident['job_id'] if kind == 'log' else None, step=step)
    return dict(locator=loc, provenance={'issue': 'untrusted_issue', 'log': 'trusted_collector',
                'code': 'trusted_repository', 'diff': 'trusted_repository'}[kind], text=text,
                truncated=False, original_locator=None, original_chars=len(text),
                original_bytes=len(text.encode('utf-8')))


def issue_contract(body, ident):
    require(type(body) is str and not builder.SECRET.search(body), 'issue_body_invalid')
    lines = body.splitlines(keepends=True)
    sections = []
    impacts = []
    fence = None
    heading = None
    for index, line in enumerate(lines):
        marker = re.fullmatch(r'\s*(`{3,}|~{3,})(.*)', line.rstrip('\r\n'))
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            continue
        if marker:
            fence = marker[1]
            continue
        match = re.match(r'^## (.+?)\s*$', line)
        if match:
            heading = match[1]
            sections.append((index, heading))
        impact = re.fullmatch(
            r'(?:- )?(Product POL / BR / REQ / AC / TC / CON / OOS (?:impact|影響)'
            r'|Product影響):[ \t]*(.*?)[ \t]*', line.rstrip('\r\n'))
        if impact and (impact[1] != 'Product影響' or heading in HEADINGS['done']):
            impacts.append((index, line, impact[2]))
    require(fence is None, 'issue_body_invalid')
    found = {}
    for pos, (start, heading) in enumerate(sections):
        end = sections[pos + 1][0] if pos + 1 < len(sections) else len(lines)
        for key, names in HEADINGS.items():
            if heading in names:
                require(key not in found, 'issue_section_ambiguous', 'conflict')
                require(any(line.strip() for line in lines[start + 1:end]), 'issue_section_missing')
                found[key] = evidence(''.join(lines[start:end]), 'issue', ident,
                                      f"issue/{ident['issue_number']}/body", start + 1)
    # Count all explicit declarations, including heading + inline duplicates.
    require(len(impacts) + ('product_impact' in found) <= 1,
            'issue_section_ambiguous', 'conflict')
    if impacts:
        start, line, value = impacts[0]
        require(bool(value.strip()), 'issue_section_missing')
        found['product_impact'] = evidence(line, 'issue', ident,
                                          f"issue/{ident['issue_number']}/body", start + 1)
    require(set(found) == builder.SECTIONS, 'issue_section_missing')
    return found


def checkpoint(comments):
    metadata = {'comments': []}
    for comment in comments:
        require(type(comment.get('user')) is dict, 'comment_metadata_invalid')
        metadata['comments'].append(dict(author={'login': comment['user'].get('login')},
            authorAssociation=comment.get('author_association'), body=comment.get('body'),
            createdAt=comment.get('created_at')))
    try:
        mode, _, boundary = selector.select(metadata)
        reason = None
    except selector.SelectionError as exc:
        try:
            selector.fallback_comments(metadata)
        except selector.SelectionError:
            raise Refusal('comment_metadata_invalid') from None
        mode, boundary, reason = 'fallback', None, exc.code
    return dict(mode=mode, boundary=boundary.isoformat() if boundary else None,
                fallback_reason=reason, provenance='trusted_selector')


def failed_job(jobs, run_id, attempt):
    require(bool(jobs), 'jobs_missing')
    for job in jobs:
        require(integer(job.get('id')) and integer(job.get('run_id'))
                and integer(job.get('run_attempt')) and job.get('run_id') == run_id
                and job.get('run_attempt') == attempt, 'job_identity_mismatch', 'conflict')
        require(job.get('status') == 'completed' and type(job.get('steps')) is list
                and job.get('conclusion') in {'success', 'failure', 'cancelled', 'timed_out',
                    'neutral', 'skipped', 'stale', 'action_required', 'startup_failure'},
                'job_metadata_invalid')
    require(len({job['id'] for job in jobs}) == len(jobs), 'job_identity_mismatch', 'conflict')
    failures = [job for job in jobs if job.get('conclusion') == 'failure']
    require(bool(failures), 'failed_job_missing')
    if len(failures) == 1:
        job = failures[0]
    else:
        # Inspect the entire attempt, including successful/non-failure jobs.
        # Exact unique names only; API order never selects the evidence source.
        names = [job.get('name') for job in jobs]
        require(all(type(name) is str and name in SHARD_WORKERS | {SHARD_TERMINAL}
                    for name in names)
                and len(set(names)) == len(names)
                and names.count(SHARD_TERMINAL) == 1,
                'failed_job_ambiguous', 'conflict')
        job = next(job for job in jobs if job['name'] == SHARD_TERMINAL)
        require(job['conclusion'] == 'failure', 'failed_job_ambiguous', 'conflict')
    steps = job['steps']
    for step in steps:
        require(type(step) is dict and integer(step.get('number')) and type(step.get('name')) is str
                and step['name'].strip() and '\t' not in step['name']
                and step.get('status') == 'completed'
                and step.get('conclusion') in {'success', 'failure', 'skipped', 'cancelled'},
                'step_metadata_invalid')
    require(len({step['number'] for step in steps}) == len(steps)
            and len({step['name'] for step in steps}) == len(steps), 'step_ambiguous', 'conflict')
    failures = sorted((step for step in steps if step['conclusion'] == 'failure'), key=lambda s: s['number'])
    require(bool(failures), 'failed_step_missing')
    return job, failures[0]


def logs(raw, job, first, ident):
    try:
        text = raw.decode('utf-8')
    except UnicodeError:
        raise Refusal('log_invalid') from None
    require(not builder.SECRET.search(text), 'secret_like_evidence')
    require(type(job.get('name')) is str and '\t' not in job['name'], 'job_metadata_invalid')
    # gh run view --log prefixes physical lines with job<TAB>step<TAB>.
    # Retain those prefixes verbatim; unknown/ambiguous boundaries fail closed.
    lines = text.splitlines(keepends=True)
    spans = {}
    known = {s['name'] for s in job['steps']}
    for index, line in enumerate(lines):
        parts = line.split('\t', 2)
        require(len(parts) == 3 and parts[0] == job['name'] and parts[1] in known, 'log_boundary_invalid')
        spans.setdefault(parts[1], []).append(index)
    previous = sorted((s for s in job['steps'] if s['number'] < first['number']
                       and s['conclusion'] == 'success'), key=lambda s: s['number'])[-1:]
    selected = [first] + previous
    result = []
    for step in selected:
        indexes = spans.get(step['name'], [])
        if not indexes and step is not first:
            continue
        require(bool(indexes), 'failed_step_log_missing')
        require(indexes == list(range(indexes[0], indexes[-1] + 1)), 'log_boundary_invalid')
        entry = evidence(''.join(lines[indexes[0]:indexes[-1] + 1]), 'log', ident,
                         f"job/{job['id']}/log", indexes[0] + 1, step['number'])
        builder.bound(entry, 4096 if step is first else 1024, failure_window=step is first)
        # A fixture group is only an observed locator, never a command.
        fixture = re.findall(r'::group::Fixture: (\.github/scripts/test-[A-Za-z0-9_-]+\.sh)', entry['text'])
        result.append(dict(number=step['number'], name=step['name'], conclusion=step['conclusion'],
                           fixture=fixture[-1] if fixture else None, log=entry))
    return result


def code_ranges(repo, ident, log):
    # Traceback paths and explicit path:line locators; never local filesystem reads.
    pattern = r'(\.github/scripts/[A-Za-z0-9_./-]+)(?:["\'], line |:)([0-9]+)'
    matches = sorted(set((path, int(line)) for path, line in re.findall(pattern, log)))
    result = []
    for path, line in matches[:3]:
        require('..' not in path.split('/') and line > 0, 'code_locator_invalid')
        blob = api(f"/repos/{repo}/contents/{quote(path, safe='/')}?ref={ident['run_head_sha']}")
        require(type(blob) is dict and blob.get('type') == 'file' and blob.get('path') == path
                and blob.get('encoding') == 'base64' and type(blob.get('content')) is str,
                'code_response_invalid')
        try:
            content = base64.b64decode(blob['content'].replace('\n', ''), validate=True).decode('utf-8')
        except (ValueError, UnicodeError):
            raise Refusal('code_response_invalid') from None
        require(not builder.SECRET.search(content), 'secret_like_evidence')
        lines = content.splitlines(keepends=True)
        require(line <= len(lines), 'code_locator_invalid')
        start, end = max(1, line - 4), min(len(lines), line + 4)
        entry = evidence(''.join(lines[start - 1:end]), 'code', ident, path, start)
        builder.bound(entry, 2048)
        result.append(entry)
    return result


def collect(event, repo):
    require(type(repo) is str and re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo), 'repository_invalid')
    require(type(event) is dict and event.get('action') == 'completed'
            and type(event.get('repository')) is dict and type(event.get('workflow_run')) is dict, 'event_invalid')
    expected = event['workflow_run']
    fresh_repo = api(f'/repos/{repo}')
    require(type(fresh_repo) is dict and integer(fresh_repo.get('id'))
            and fresh_repo.get('full_name') == repo and fresh_repo.get('default_branch') == 'main',
            'repository_mismatch', 'conflict')
    repository(event['repository'], fresh_repo)
    require(integer(expected.get('id')) and integer(expected.get('run_attempt')), 'event_invalid')
    run_id, attempt = expected['id'], expected['run_attempt']
    run = api(f'/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}')
    run_identity(run, expected, fresh_repo)
    # Also reject a delayed event from a superseded attempt.
    run_identity(api(f'/repos/{repo}/actions/runs/{run_id}'), expected, fresh_repo)
    workflow = api(f"/repos/{repo}/actions/workflows/{run['workflow_id']}")
    require(type(workflow) is dict and workflow.get('id') == run['workflow_id']
            and workflow.get('name') == WORKFLOW and workflow.get('path') == WORKFLOW_PATH,
            'workflow_identity_mismatch', 'conflict')
    associations = run['pull_requests']
    require(bool(associations), 'pr_relation_missing')
    require(len(associations) == 1, 'pr_relation_ambiguous', 'conflict')
    relation = associations[0]
    require(type(relation) is dict and integer(relation.get('number')), 'pr_relation_invalid')
    number = relation['number']
    pr = pr_snapshot(repo, number, fresh_repo)
    repository(pr['head'].get('repo'), run['head_repository'])
    require(run['head_sha'] == pr['head']['sha'], 'pr_head_changed', 'stale')
    require(type(relation.get('head')) is dict and relation['head'].get('sha') == run['head_sha'],
            'pr_relation_invalid', 'conflict')
    main = api(f'/repos/{repo}/git/ref/heads/main')
    require(type(main) is dict and main.get('ref') == 'refs/heads/main'
            and type(main.get('object')) is dict and sha(main['object'].get('sha')), 'main_identity_invalid')
    issue_number = closing_issue(repo, number, pr['head']['sha'])
    issue = api(f'/repos/{repo}/issues/{issue_number}')
    require(type(issue) is dict and issue.get('number') == issue_number and 'pull_request' not in issue
            and issue.get('url') == f'https://api.github.com/repos/{repo}/issues/{issue_number}', 'issue_identity_invalid')
    jobs = pages(f'/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs', 'jobs')
    job, first = failed_job(jobs, run_id, attempt)
    fresh_job = api(f"/repos/{repo}/actions/jobs/{job['id']}")
    failed_job([fresh_job], run_id, attempt)
    require(type(fresh_job) is dict and all(fresh_job.get(key) == job.get(key) for key in
            ('id', 'run_id', 'run_attempt', 'name', 'status', 'conclusion', 'steps')),
            'job_identity_mismatch', 'conflict')
    ident = dict(repository=repo, issue_number=issue_number, pr_number=number,
                 current_main_sha=main['object']['sha'], run_head_sha=run['head_sha'],
                 current_pr_head=pr['head']['sha'], run_id=run_id, run_attempt=attempt,
                 job_id=job['id'], failing_step=first['number'])
    contract = dict(issue=issue_contract(issue.get('body'), ident),
                    checkpoint=checkpoint(pages(f'/repos/{repo}/issues/{issue_number}/comments')))
    raw = command(['gh', 'run', 'view', str(run_id), '--repo', repo, '--attempt', str(attempt),
                   '--job', str(job['id']), '--log'], LOG_CAP)
    steps = logs(raw, job, first, ident)
    files = pages(f'/repos/{repo}/pulls/{number}/files')
    require(bool(files) and type(pr.get('changed_files')) is int
            and len(files) == pr['changed_files'], 'diff_incomplete')
    summary = []
    for item in files:
        path = item.get('filename')
        require(type(path) is str and path.strip() and not any(c in path for c in '\n\r\t'), 'diff_invalid')
        require(all(type(item.get(k)) is int and item[k] >= 0 for k in ('additions', 'deletions')), 'diff_invalid')
        summary.append(dict(path=path, additions=item['additions'], deletions=item['deletions']))
    summary.sort(key=lambda item: item['path'])
    diff_text = '\n'.join(f"{item['additions']}\t{item['deletions']}\t{item['path']}" for item in summary)
    data = dict(schema=builder.SCHEMA, identity=ident, contract=contract, steps=steps,
                repository=dict(files=summary, diff=evidence(diff_text, 'diff', ident,
                    f'diff/{number}/numstat'), code=code_ranges(repo, ident, steps[0]['log']['text'])))
    # No retries: mutable snapshots must still agree immediately before building.
    require(pr_snapshot(repo, number, fresh_repo) == pr, 'pr_snapshot_changed', 'stale')
    require(api(f'/repos/{repo}/git/ref/heads/main') == main, 'main_snapshot_changed', 'stale')
    require(closing_issue(repo, number, pr['head']['sha']) == issue_number, 'issue_relation_changed', 'conflict')
    require(api(f'/repos/{repo}/issues/{issue_number}') == issue, 'issue_snapshot_changed')
    run_identity(api(f'/repos/{repo}/actions/runs/{run_id}'), expected, fresh_repo)
    return builder.build(data)


def outcome(event, repo):
    try:
        return collect(event, repo)
    except Refusal as exc:
        return dict(status=exc.status, reason=exc.reason, packet=None, serialized=None)
    except Exception:
        # No raw exception/API/source text may reach the summary or artifact.
        return dict(status='incomplete', reason='collector_internal_error', packet=None, serialized=None)


def save(result, directory):
    # A refusal is a schema-tagged status record, never current complete evidence.
    rendered = result['serialized'] if result['status'] == 'complete' else builder.canonical(
        dict(schema=builder.SCHEMA, status=result['status'], reason=result['reason'], packet=None))
    require(len(rendered.encode('utf-8')) <= builder.CAP, 'packet_oversized', 'oversized')
    target = Path(directory)
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    (target / 'failure-evidence-packet.json').write_text(rendered, encoding='utf-8')


def main():
    result = dict(status='incomplete', reason='event_invalid', packet=None, serialized=None)
    try:
        require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_run', 'event_invalid')
        with open(os.environ['GITHUB_EVENT_PATH'], 'rb') as stream:
            raw = stream.read(API_CAP + 1)
        require(len(raw) <= API_CAP, 'event_invalid')
        result = outcome(parse(raw), os.environ['GITHUB_REPOSITORY'])
    except Exception:
        pass
    try:
        save(result, os.environ['EVIDENCE_OUTPUT_DIR'])
    except Exception:
        result = dict(status='incomplete', reason='artifact_write_failed')
    summary = f"Failure evidence収集: `{result['status']}`。派生証拠のため正本ではありません。\n"
    print(summary, end='')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
        stream.write(summary)
    return 0 if result['status'] == 'complete' else 1


if __name__ == '__main__':
    sys.exit(main())
