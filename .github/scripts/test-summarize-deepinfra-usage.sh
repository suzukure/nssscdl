#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONDONTWRITEBYTECODE=1
python3 - "$repo_root" <<'PY'
import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
from unittest.mock import patch
import zipfile

root = pathlib.Path(sys.argv[1])
path = root / '.github/scripts/summarize-deepinfra-usage.py'
spec = importlib.util.spec_from_file_location('aggregation_fixture', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
repo = 'owner/repo'
filters = {key: None for key in (*m.DIMENSIONS, 'since', 'until')}
bot = {'login': 'github-actions[bot]', 'type': 'Bot'}
model = 'deepseek-ai/DeepSeek-V4-Flash-0731'
repository = {'id': 11, 'full_name': repo, 'default_branch': 'main'}
run = {'id': 123, 'run_attempt': 2, 'workflow_id': 7, 'name': 'DeepInfra Investigator',
       'repository': repository, 'head_repository': repository, 'head_branch': 'main',
       'head_sha': 'a' * 40, 'status': 'completed', 'conclusion': 'success', 'event': 'issue_comment'}
event = {'action': 'completed', 'repository': repository, 'workflow_run': run}

# Use the real producer AND consumer to obtain the durable comment fixture.
with tempfile.TemporaryDirectory() as tmp:
    producer = m.ledger.producer.UsageSidecar(str(pathlib.Path(tmp) / 'usage.json'), 'investigator', model)
    entry = producer.start()
    producer.received(entry, {'usage': {'prompt_tokens': 100, 'completion_tokens': 20,
                                      'total_tokens': 120, 'estimated_cost': 0.1}})
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as z:
        z.writestr('deepinfra-usage.json', producer.path.read_bytes())
    comments = []
    def consumer_api(url, payload=None, binary=False):
        if payload:
            saved = {'id': 1, 'user': bot, 'body': payload['body']}
            comments.append(saved)
            return saved
        if '/attempts/' in url:
            return run
        if '/workflows/' in url:
            return {'path': '.github/workflows/deepinfra-investigator.yml'}
        if '/issues/665/comments?' in url:
            return comments
        if url.endswith('/zip'):
            assert binary
            return archive.getvalue()
        if '/artifacts?' in url:
            return {'artifacts': [{'id': 44, 'name': 'deepinfra-usage-investigator-123-2',
                                  'expired': False, 'size_in_bytes': 1000,
                                  'workflow_run': {'id': 123, 'head_sha': 'a' * 40,
                                                   'repository_id': 11, 'head_repository_id': 11}}]}
        raise AssertionError(url)
    with patch.object(m.ledger, 'api', consumer_api):
        assert m.ledger.consume(event, repo) == 'recorded_valid'
    base = json.loads(comments[0]['body'].split('\n', 1)[1])
    assert m.validate_record(base, m.ledger.marker(base), repo) == base
    entry = producer.start()  # Interrupted request: known aggregate is partial.
    partial_usage = m.ledger.validate_usage(producer.path.read_bytes(), 'investigator')

base['recorded_at'] = '2026-10-02T01:00:00+00:00'
def record(rid=123, **changes):
    value = {**copy.deepcopy(base), 'run_id': rid, **changes}
    value['run_url'] = f"https://github.com/{repo}/actions/runs/{rid}/attempts/{value['run_attempt']}"
    return value

def comment(value, **changes):
    return {'id': value['run_id'], 'user': bot,
            'body': m.ledger.marker(value) + '\n' + json.dumps(value), **changes}

def report(values, **changes):
    return m.aggregate(values, repo, {**filters, **changes})

def unknown(rid, status='unavailable', reason='artifact_missing'):
    return record(rid, model=None, request_count=None, response_count=None,
                  missing_usage_response_count=None, request_error_count=None,
                  **dict.fromkeys(m.ledger.FIELDS), usage_availability='unavailable',
                  telemetry_status=status, telemetry_reason_code=reason)

partial = record(125, **{key: value for key, value in partial_usage.items() if key not in ('schema_version', 'usage_kind')},
                 telemetry_reason_code='usage_partial')
values = [comment(base), comment(record(124, workflow_name='DeepInfra Diagnostic B', usage_kind='diagnostic_b',
                                       model='zai-org/GLM-5.3-Flash', run_conclusion='failure',
                                       provider_estimated_cost_usd=0.2, recorded_at='2026-10-03T00:00:00+00:00')),
          comment(partial), comment(unknown(126)), comment(unknown(127, 'invalid', 'telemetry_invalid'))]
r = report(values)
assert r['summary']['run_attempt_count'] == 5
assert r['summary']['usage_availability_counts'] == {'complete': 2, 'partial': 1, 'unavailable': 2}
assert r['summary']['totals']['total_tokens'] == {'known_sum': 360, 'known_records': 3, 'unknown_records': 2, 'partial_records': 1}
assert r['summary']['totals']['provider_estimated_cost_usd']['known_sum'] == '0.4'
assert r['diagnostics']['invalid_comments'] == 0, 'telemetry invalid is a valid unknown ledger record'
assert r['period'] == {'field': 'recorded_at', 'first': base['recorded_at'], 'last': '2026-10-03T00:00:00+00:00'}
assert [entry['run_id'] for entry in r['runs']] == [123, 124, 125, 126, 127]
assert r['groups']['model'][0]['value'] is None
assert {row['value']: row['run_attempt_count'] for row in r['groups']['workflow_name']} == {
    'DeepInfra Diagnostic B': 1, 'DeepInfra Investigator': 4}
assert {row['value']: row['run_attempt_count'] for row in r['groups']['usage_kind']} == {'diagnostic_b': 1, 'investigator': 4}
assert {row['value']: row['run_attempt_count'] for row in r['groups']['run_conclusion']} == {'failure': 1, 'success': 4}
assert r == report(list(reversed(values)))
assert m.markdown(r) == m.markdown(report(list(reversed(values))))
assert 'https://github.com/owner/repo/actions/runs/123/attempts/2' in m.markdown(r)
assert 'duplicate_identity_count' in m.markdown(r) and 'groups.model[0].value' in m.markdown(r)
assert report(values[:2])['summary']['totals']['provider_estimated_cost_usd']['known_sum'] == '0.3'
assert m.decimal_sum([1e-30, 0.1]) == '0.100000000000000000000000000001'
assert m.decimal_sum([1e-320, 1e300]) is not None

# Empty and unavailable-only inputs do not assert zero usage/cost.
for source in ([], [comment(unknown(126))]):
    s = report(source)['summary']
    assert all(total['known_sum'] is None for total in s['totals'].values())
    assert all(total['unknown_records'] == len(source) for total in s['totals'].values())
assert report([comment(record(provider_estimated_cost_usd=0, prompt_tokens=0, completion_tokens=0, total_tokens=0))])['summary']['totals']['total_tokens']['known_sum'] == 0
assert report([comment(record(provider_estimated_cost_usd=0))])['summary']['totals']['provider_estimated_cost_usd']['known_sum'] == '0'
missing = record(130, completion_tokens=None, usage_availability='partial',
                 missing_usage_response_count=1, telemetry_reason_code='usage_partial')
s = report([comment(missing)])['summary']
assert s['totals']['completion_tokens']['known_sum'] is None
assert s['totals']['prompt_tokens']['known_sum'] == 100
assert s['totals']['prompt_tokens']['partial_records'] == 1
valid_unknown = record(131, **dict.fromkeys(m.ledger.FIELDS), usage_availability='unavailable',
                       missing_usage_response_count=1, telemetry_reason_code='usage_unavailable')
assert report([comment(valid_unknown)])['summary']['usage_availability_counts']['unavailable'] == 1

# Each filter, inclusive since, exclusive until, and combined predicates.
assert report(values, since=base['recorded_at'], until='2026-10-03T00:00:00+00:00')['summary']['run_attempt_count'] == 4
assert report(values, since='2026-10-03T00:00:00+00:00')['summary']['run_attempt_count'] == 1
for field, value in (('workflow_name', 'DeepInfra Diagnostic B'), ('usage_kind', 'diagnostic_b'),
                     ('model', 'zai-org/GLM-5.3-Flash'), ('run_conclusion', 'failure'), ('usage_availability', 'partial')):
    assert report(values, **{field: value})['summary']['run_attempt_count'] == 1
assert report(values, run_conclusion='failure', usage_availability='complete')['summary']['run_attempt_count'] == 1
assert report(values, model=model, run_conclusion='failure')['summary']['run_attempt_count'] == 0

# Exact bot marker only; human copies and checkpoint prose do not enter the ledger.
human = comment(base, user={'login': 'human', 'type': 'User'})
noise = [human, {'user': bot, 'body': 'design checkpoint\n' + comment(base)['body']},
         comment(base, body=' ' + comment(base)['body']), comment(base, body=comment(base)['body'].replace(' / 123 /', ' / 0123 /')),
         {'body': 'ordinary human comment'}]
assert report(noise)['diagnostics']['ignored_comments'] == 5
assert report(noise)['summary']['run_attempt_count'] == 0

# Duplicate identity is entirely excluded, including conflicting, invalid, and
# out-of-range copies. Different attempts of the same run remain distinct.
for duplicate in (comment(base), comment(record(provider_estimated_cost_usd=99)),
                  comment(record(recorded_at='2026-10-03T00:00:00+00:00')), comment(base, body=m.ledger.marker(base) + '\n{}')):
    d = report([comment(base), duplicate], until='2026-10-03T00:00:00+00:00')
    assert d['summary']['run_attempt_count'] == 0
    assert d['diagnostics']['duplicate_identity_count'] == 1 and d['diagnostics']['duplicate_comments'] == 2
assert report([comment(base), comment(record(run_attempt=3))])['summary']['run_attempt_count'] == 2

# Strict schema/date/numeric checks, no raw data in diagnostics.
bad = []
for field, value in (('prompt', 'private-fixture'), ('schema_version', 2), ('schema_version', True),
                     ('workflow_name', 'unknown'), ('usage_kind', 'diagnostic_a'), ('run_id', True),
                     ('model', 'private-fixture'), ('head_sha', 'bad'), ('run_conclusion', 'unavailable'),
                     ('recorded_at', '2026-02-30T00:00:00+00:00'), ('recorded_at', '2026-10-02'),
                     ('recorded_at', '2026-10-02T01:00:00+01:00'), ('prompt_tokens', '100'), ('total_tokens', 1.5),
                     ('completion_tokens', -1), ('request_count', True), ('response_count', 0),
                     ('provider_estimated_cost_usd', float('inf')), ('provider_estimated_cost_usd', float('nan')),
                     ('provider_estimated_cost_usd', True), ('provider_estimated_cost_usd', -0.1),
                     ('usage_availability', 'unavailable'), ('total_tokens', None), ('telemetry_reason_code', 'private-fixture')):
    v = {**base, field: value}
    bad.append(comment(base, body=m.ledger.marker(base) + '\n' + json.dumps(v)))
bad += [comment(base, body=m.ledger.marker(record(999)) + '\n' + json.dumps(base)),
        comment(record(usage_availability='partial', telemetry_reason_code='usage_partial')),
        comment(base, body=m.ledger.marker(base) + '\n{}{}'),
        comment(base, body=m.ledger.marker(base) + '\n' + json.dumps(base)[:-1] + ',"run_id":123}'),
        comment(base, body=m.ledger.marker(base)),
        comment(base, body=m.ledger.marker(base) + '\n' + 'x' * m.ledger.MAX_USAGE_BYTES),
        comment(base, body=m.ledger.marker(base) + '\n' + json.dumps({**base, 'run_url': 'https://other.invalid'}))]
for candidate in bad:
    invalid = report([candidate])
    assert invalid['diagnostics']['invalid_comments'] == 1, candidate
    assert invalid['summary']['run_attempt_count'] == 0
    assert 'private-fixture' not in json.dumps(invalid)

# CLI local snapshot never calls gh; JSON and Markdown use the same report.
with tempfile.TemporaryDirectory() as tmp:
    snapshot = pathlib.Path(tmp) / 'comments.json'
    md = pathlib.Path(tmp) / 'summary.md'
    snapshot.write_text(json.dumps(values))
    out = io.StringIO()
    with patch.object(m.ledger.subprocess, 'run', side_effect=AssertionError('network forbidden')), contextlib.redirect_stdout(out):
        assert m.main(['--repo', repo, '--comments', str(snapshot), '--markdown', str(md)]) == 0
    cli = json.loads(out.getvalue())
    assert cli == r and md.read_text() == m.markdown(cli)
    with contextlib.redirect_stdout(io.StringIO()) as out:
        assert m.main(['--repo', repo, '--comments', str(snapshot), '--since', '2026-10-03T00:00:00Z']) == 0
    assert json.loads(out.getvalue())['summary']['run_attempt_count'] == 1
    for extra in (['--since', 'not-a-date'], ['--since', '2026-10-04T00:00:00Z', '--until', '2026-10-03T00:00:00Z']):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            assert m.main(['--repo', repo, '--comments', str(snapshot), *extra]) == 1
        assert not out.getvalue() and 'filter_' in err.getvalue()
    snapshot.write_text('{}')
    with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
        assert m.main(['--repo', repo, '--comments', str(snapshot)]) == 1
    assert not out.getvalue()

# Full GET pagination, fixed argument vector, no shell/POST/provider/artifacts.
reads = []
stream = noise * 40 + values
def gh_get(args, **kwargs):
    assert args[:2] == ['gh', 'api'] and len(args) == 3
    assert args[2].startswith('/repos/owner/repo/issues/665/comments?per_page=100&page=')
    assert kwargs['input'] is None and kwargs['stderr'] == subprocess.DEVNULL and kwargs['timeout'] == 60
    reads.append(args[2])
    page = int(args[2].rsplit('=', 1)[1])
    kwargs['stdout'].write(json.dumps(stream[(page-1)*100:page*100]).encode())
    return subprocess.CompletedProcess(args, 0)
with patch.object(m.ledger.subprocess, 'run', gh_get), contextlib.redirect_stdout(io.StringIO()) as out:
    assert m.main(['--repo', repo, '--fetch']) == 0
assert len(reads) == 3 and json.loads(out.getvalue())['summary'] == r['summary']
with patch.object(m.ledger.subprocess, 'run', side_effect=subprocess.TimeoutExpired('gh', 60)), contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
    assert m.main(['--repo', repo, '--fetch']) == 1
assert not out.getvalue() and 'github_api_failed' in err.getvalue()
for workflow in (root / '.github/workflows').glob('*.yml'):
    assert path.name not in workflow.read_text(), 'no production wiring authorized'
print('DeepInfra usage aggregation fixture tests passed.')
PY
