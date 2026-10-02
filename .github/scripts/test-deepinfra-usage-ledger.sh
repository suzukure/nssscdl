#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONDONTWRITEBYTECODE=1
python3 - "$repo_root" <<'PY'
import copy
import importlib.util
import io
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import zipfile
from unittest.mock import patch

root = pathlib.Path(sys.argv[1])
path = root / '.github/scripts/deepinfra-usage-ledger.py'
spec = importlib.util.spec_from_file_location('ledger_fixture', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
repo = 'owner/repo'
repository = {'id': 11, 'full_name': repo, 'default_branch': 'main'}
run = {'id': 123, 'run_attempt': 2, 'workflow_id': 7, 'name': 'DeepInfra Investigator',
       'repository': repository, 'head_repository': repository, 'head_branch': 'main',
       'head_sha': 'a' * 40, 'status': 'completed', 'conclusion': 'success', 'event': 'issue_comment'}
event = {'action': 'completed', 'repository': repository, 'workflow_run': run}
artifact = {'id': 44, 'name': 'deepinfra-usage-investigator-123-2', 'expired': False,
            'size_in_bytes': 1000, 'workflow_run': {'id': 123, 'head_sha': 'a' * 40,
                                                 'repository_id': 11, 'head_repository_id': 11}}

# Real producer output is the consumer's compatibility input, without paid calls.
with tempfile.TemporaryDirectory() as tmp:
    producer = m.producer.UsageSidecar(str(pathlib.Path(tmp) / 'usage.json'), 'investigator',
                                     'deepseek-ai/DeepSeek-V4-Flash-0731')
    first = producer.start()
    producer.received(first, {'usage': {'prompt_tokens': 100, 'completion_tokens': 20,
                                      'total_tokens': 120, 'estimated_cost': 0.001}})
    valid = json.loads(producer.path.read_text())
    second = producer.start()
    producer.failed(second, 'network_error')
    partial = json.loads(producer.path.read_text())
    producer = m.producer.UsageSidecar(str(producer.path), 'investigator', valid['model'])
    first = producer.start()
    unavailable = json.loads(producer.path.read_text())
    producer.received(first, {'usage': {}})
    missing_usage = json.loads(producer.path.read_text())

def archive(value=valid, filename='deepinfra-usage.json', extra=None, raw=None, symlink=False):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as z:
        member = zipfile.ZipInfo(filename)
        if symlink:
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
        z.writestr(member, json.dumps(value).encode() if raw is None else raw)
        if extra:
            z.writestr(extra, 'raise RuntimeError("must never execute")')
    return stream.getvalue()

def fails(call, code):
    try:
        call()
    except m.LedgerError as exc:
        assert str(exc) == code, (str(exc), code)
    else:
        raise AssertionError('boundary accepted invalid input: ' + code)

class Github:
    def __init__(self, source=event, artifacts=None, raw=None, comments=None):
        self.source = copy.deepcopy(source)
        self.run = self.source['workflow_run']
        self.artifacts = copy.deepcopy([artifact] if artifacts is None else artifacts)
        self.raw = archive() if raw is None else raw
        self.comments = [] if comments is None else comments
        self.writes = []
        self.reads = []
        self.lost_post = False
        self.fail_post = False
        self.fail_read = False
    def api(self, path, payload=None, binary=False):
        if payload is not None:
            assert path == '/repos/owner/repo/issues/665/comments'
            self.writes.append(payload)
            if self.fail_post:
                raise m.LedgerError('github_api_failed')
            comment = {'id': 999, 'body': payload['body'], 'user': {'login': 'github-actions[bot]', 'type': 'Bot'}}
            self.comments.append(comment)
            if self.lost_post:
                raise m.LedgerError('github_api_failed')
            return comment
        self.reads.append(path)
        if self.fail_read:
            raise m.LedgerError('github_api_failed')
        if path == '/repos/owner/repo/actions/runs/123/attempts/2':
            return self.run
        if path == '/repos/owner/repo/actions/workflows/7':
            return {'path': '.github/workflows/' + m.WORKFLOWS[self.run['name']][1]}
        if path.startswith('/repos/owner/repo/actions/runs/123/artifacts?'):
            return {'artifacts': self.artifacts}
        if path == '/repos/owner/repo/actions/artifacts/44/zip':
            assert binary
            return self.raw
        if path.startswith('/repos/owner/repo/issues/665/comments?'):
            page = int(path.rsplit('=', 1)[1])
            return self.comments[(page - 1) * 100:page * 100]
        raise AssertionError('unexpected API read: ' + path)
    def consume(self):
        with patch.object(m, 'api', self.api):
            return m.consume(self.source, repo)
    def record(self):
        body = self.writes[-1]['body']
        prefix, value = body.split('\n', 1)
        assert prefix == 'deepinfra-usage-ledger:v1 / 123 / 2'
        return json.loads(value)

# Each allowlisted workflow and success/failure uses the same independent consumer.
for name, (kind, filename, trigger) in m.WORKFLOWS.items():
    for conclusion in ('success', 'failure', 'cancelled', 'timed_out'):
        source = copy.deepcopy(event)
        source['workflow_run'].update(name=name, event=trigger, conclusion=conclusion)
        usage = copy.deepcopy(valid)
        usage['usage_kind'] = kind
        a = copy.deepcopy(artifact)
        a['name'] = f'deepinfra-usage-{kind}-123-2'
        g = Github(source, [a], archive(usage))
        assert g.consume() == 'recorded_valid'
        record = g.record()
        assert record['run_conclusion'] == conclusion and record['workflow_name'] == name
        assert record['provider_estimated_cost_usd'] == 0.001 and record['request_count'] == 1
        assert record['usage_availability'] == 'complete' and 'requests' not in record
        assert g.consume() == 'already_recorded' and len(g.writes) == 1

# Investigator ordinary-comment gate skips (and other producer skips) never
# read the ledger/artifacts or write, even if an artifact is unexpectedly listed.
for name, (kind, filename, trigger) in m.WORKFLOWS.items():
    source = copy.deepcopy(event)
    source['workflow_run'].update(name=name, event=trigger, conclusion='skipped')
    for artifacts in ([], [artifact]):
        g = Github(source, artifacts=artifacts)
        assert g.consume() == 'skipped_run_ignored' and not g.writes
        assert g.reads == ['/repos/owner/repo/actions/runs/123/attempts/2',
                           '/repos/owner/repo/actions/workflows/7']
    # A failure after entry, including checkout/model/credential failure before
    # the paid step, remains unknown rather than being silently discarded.
    source['workflow_run']['conclusion'] = 'failure'
    g = Github(source, artifacts=[])
    assert g.consume() == 'recorded_unavailable'
    assert g.record()['telemetry_reason_code'] == 'artifact_missing'
    assert all(g.record()[key] is None for key in m.FIELDS)

# Skip does not bypass exact-attempt or repository validation.
g = Github()
g.source['workflow_run']['conclusion'] = 'skipped'
g.run = {**g.run, 'conclusion': 'success'}
fails(g.consume, 'run_identity_mismatch')
assert not g.writes
g = Github()
g.run.update(conclusion='skipped', head_repository={**repository, 'id': 12})
fails(g.consume, 'repository_mismatch')
assert not g.reads and not g.writes

for usage, expected in ((partial, 'partial'), (unavailable, 'unavailable'), (missing_usage, 'unavailable')):
    g = Github(raw=archive(usage))
    assert g.consume() == 'recorded_valid'
    assert g.record()['usage_availability'] == expected
    assert g.record()['provider_estimated_cost_usd'] == (0.001 if expected == 'partial' else None)

# Wrong attempt/result artifacts are listed but never downloaded or executed.
wrong = copy.deepcopy(artifact)
wrong['name'] = 'deepinfra-usage-investigator-123-1'
result = {**wrong, 'name': 'deepinfra-investigation-123'}
g = Github(artifacts=[wrong, result, artifact])
assert g.consume() == 'recorded_valid'
assert [p for p in g.reads if p.endswith('/zip')] == ['/repos/owner/repo/actions/artifacts/44/zip']
for items, reason in (([], 'artifact_missing'), ([wrong, result], 'artifact_missing'),
                      ([{**artifact, 'expired': True}], 'artifact_expired')):
    g = Github(artifacts=items)
    assert g.consume() == 'recorded_unavailable'
    assert g.record()['telemetry_reason_code'] == reason
    assert all(g.record()[key] is None for key in m.FIELDS)

# Strict schema rejects payloads, secret-like strings, non-numbers and bogus totals.
bad_inputs = []
for key, value in (('prompt', 'secret-fixture'), ('model', 'github_pat_fixture'), ('usage_kind', 'other'),
                   ('request_count', True), ('schema_version', True), ('total_tokens', 121),
                   ('response_count', 0), ('usage_availability', 'complete-secret')):
    bad = copy.deepcopy(valid)
    bad[key] = value
    bad_inputs.append(bad)
for key, value in (('prompt_tokens', True), ('total_tokens', 1.5), ('completion_tokens', -1),
                   ('provider_estimated_cost_usd', float('nan')), ('provider_estimated_cost_usd', float('inf')),
                   ('error_reason_code', 'raw provider secret error'), ('response_received', 1),
                   ('request_index', 2)):
    bad = copy.deepcopy(valid)
    bad['requests'][0][key] = value
    bad_inputs.append(bad)
for bad in bad_inputs:
    g = Github(raw=archive(bad))
    assert g.consume() == 'recorded_invalid'
    assert g.record()['provider_estimated_cost_usd'] is None
    assert 'secret' not in g.writes[0]['body'] and 'NaN' not in g.writes[0]['body']
for raw in (archive(raw=b'{}{}'), archive(raw=b'{"schema_version":1,"schema_version":1}'),
            archive(raw=b'x' * (m.MAX_USAGE_BYTES + 1)), archive(filename='../deepinfra-usage.json'),
            archive(extra='execute.py'), archive(symlink=True), b'bad zip', b'x' * (m.MAX_ARCHIVE_BYTES + 1)):
    g = Github(raw=raw)
    assert g.consume() == 'recorded_invalid' and g.record()['model'] is None

# Unknown workflows ignore; malformed metadata rejects before any write.
g = Github()
g.source['workflow_run']['name'] = 'Unknown'
assert g.consume() == 'unknown_workflow_ignored' and not g.reads and not g.writes
for section in ('repository', 'head_repository'):
    g = Github()
    g.source['workflow_run'][section] = {**repository, 'id': 12}
    fails(g.consume, 'repository_mismatch')
    assert not g.writes
g = Github()
g.run['head_branch'] = 'untrusted'
fails(g.consume, 'untrusted_source_branch')
g = Github()
g.run = {**g.run, 'run_attempt': 3}
fails(g.consume, 'run_identity_mismatch')
g = Github(artifacts=[artifact, artifact])
fails(g.consume, 'artifact_identity_ambiguous')
g = Github(artifacts=[{**artifact, 'workflow_run': {**artifact['workflow_run'], 'id': 456}}])
fails(g.consume, 'artifact_identity_mismatch')

# Human copies do not suppress recording; full pagination finds old machine records.
g = Github()
assert g.consume() == 'recorded_valid'
machine = g.comments[0]
human = {**machine, 'user': {'login': 'human', 'type': 'User'}}
g = Github(comments=[human])
assert g.consume() == 'recorded_valid' and len(g.writes) == 1
g = Github(comments=[human] * 200 + [machine])
assert g.consume() == 'already_recorded' and not g.writes
assert any(p.endswith('page=3') for p in g.reads)
g = Github(comments=[machine, machine])
fails(g.consume, 'duplicate_existing_records')
g = Github(comments=[{**machine, 'body': machine['body'].split('\n')[0] + '\n{}'}])
fails(g.consume, 'existing_record_invalid')
g = Github()
g.lost_post = True
assert g.consume() == 'recorded_valid' and g.consume() == 'already_recorded' and len(g.writes) == 1
g = Github()
g.fail_post = True
fails(g.consume, 'comment_write_unconfirmed')
assert len(g.writes) == 1
g.fail_post = False
assert g.consume() == 'recorded_valid'
g = Github()
g.fail_read = True
fails(g.consume, 'github_api_failed')
assert not g.writes

# Integration contract discovers *all* paid workflows, including future additions.
consumer = (root / '.github/workflows/deepinfra-usage-ledger.yml').read_text()
paid_names = set()
for workflow in (root / '.github/workflows').glob('*.yml'):
    source = workflow.read_text()
    if 'secrets.DEEPINFRA_API_KEY' not in source:
        continue
    name = source.splitlines()[0].removeprefix('name: ')
    paid_names.add(name)
    assert name in m.WORKFLOWS, 'paid workflow has no ledger connection: ' + name
    kind, filename, trigger = m.WORKFLOWS[name]
    assert workflow.name == filename and f'DEEPINFRA_USAGE_KIND: {kind}' in source
    assert f'name: deepinfra-usage-{kind}-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}' in source
    assert ': write' not in source and 'write-all' not in source
assert paid_names == set(m.WORKFLOWS)
assert 'workflows: [' + ', '.join(m.WORKFLOWS) + ']' in consumer
assert 'types: [completed]' in consumer and '  workflow_run:' in consumer
assert '\nconcurrency:' not in consumer, 'skipped events must not enter workflow-level writer concurrency'
assert "    if: github.event.workflow_run.conclusion != 'skipped'\n" in consumer
assert '    concurrency:\n      group: deepinfra-usage-ledger-665\n      cancel-in-progress: false' in consumer
assert '  actions: read\n  contents: read\n  issues: write' in consumer
assert 'ref: ${{ github.sha }}' in consumer and 'persist-credentials: false' in consumer
assert 'secrets.' not in consumer and 'vars.' not in consumer and 'DEEPINFRA_API_KEY' not in consumer
assert 'download-artifact' not in consumer and 'github.event.workflow_run.head_sha' not in consumer
assert 'python3 .github/scripts/deepinfra-usage-ledger.py' in consumer
assert 'if: failure()' in consumer and 'GITHUB_STEP_SUMMARY' in consumer
source = path.read_text()
assert 'shell=True' not in source and 'extractall' not in source and 'extract(' not in source
assert 'DEEPINFRA_API_KEY' not in source and 'deepinfra_request(' not in source

# gh transport uses a fixed argument vector and bounded reads, with no raw stderr.
def gh_response(args, **kwargs):
    assert args == ['gh', 'api', '/repos/owner/repo/issues/665/comments', '--method', 'POST', '--input', '-']
    assert json.loads(kwargs['input']) == {'body': 'fixture'}
    assert kwargs['stderr'] == subprocess.DEVNULL and kwargs['timeout'] == 60
    kwargs['stdout'].write(b'{"id":999}')
    return subprocess.CompletedProcess(args, 0)
with patch.object(m.subprocess, 'run', gh_response):
    assert m.api('/repos/owner/repo/issues/665/comments', {'body': 'fixture'}) == {'id': 999}
def too_big(args, **kwargs):
    kwargs['stdout'].write(b'x' * (m.MAX_ARCHIVE_BYTES + 1))
    return subprocess.CompletedProcess(args, 0)
with patch.object(m.subprocess, 'run', too_big):
    fails(lambda: m.api('/repos/owner/repo/actions/artifacts/44/zip', binary=True), 'telemetry_oversized')
with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired('gh', 60)):
    fails(lambda: m.api('/repos/owner/repo/actions/artifacts/44/zip', binary=True), 'github_api_failed')

# Executable entry records bounded reason codes in Japanese summary, never raw errors.
with tempfile.TemporaryDirectory() as tmp:
    summary = pathlib.Path(tmp) / 'summary'
    with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'wrong', 'GITHUB_STEP_SUMMARY': str(summary)}):
        assert m.main() == 1
    assert 'event_invalid' in summary.read_text()
print('DeepInfra usage ledger fixture tests passed.')
PY
