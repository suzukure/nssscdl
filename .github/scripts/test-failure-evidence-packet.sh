#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import ast
import copy
import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

repo = Path(sys.argv[1])
script = repo / '.github/scripts/build-failure-evidence-packet.py'
spec = importlib.util.spec_from_file_location('failure_packet', script)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
fixture = json.loads((repo / '.github/scripts/fixtures/failure-evidence-654.json').read_text())
assert 'Synthetic' in fixture['provenance']
# All IDs/SHAs below are synthetic fixture identities, not real Actions claims.
ident = dict(repository='fixture/repository', issue_number=654, pr_number=657,
             current_main_sha='a' * 40, run_head_sha='b' * 40,
             current_pr_head='b' * 40, run_id=65401, run_attempt=1,
             job_id=65402, failing_step=2)


def source(text, kind, step=None):
    locator = dict(repository=ident['repository'], ref='main' if kind == 'issue' else 'run_head',
                   sha=ident['current_main_sha'] if kind == 'issue' else ident['run_head_sha'],
                   path={'issue': 'issue/654/body', 'log': 'job/65402/log',
                         'code': '.github/scripts/npm-filesystem-source-probe.js',
                         'diff': 'diff/657/numstat'}[kind],
                   line_start=1, line_end=len(text.splitlines()),
                   issue_number=654, pr_number=657, run_id=65401 if kind == 'log' else None,
                   run_attempt=1 if kind == 'log' else None,
                   job_id=65402 if kind == 'log' else None, step=step)
    return dict(locator=locator, text=text, truncated=False, original_locator=None,
                original_chars=len(text), original_bytes=len(text.encode()),
                provenance={'issue': 'untrusted_issue', 'log': 'trusted_collector',
                            'code': 'trusted_repository', 'diff': 'trusted_repository'}[kind])


def issue_source(key, text):
    entry = source(text, 'issue')
    start = 1 + sorted(builder.SECTIONS).index(key) * 100
    entry['locator'].update(line_start=start, line_end=start + len(text.splitlines()) - 1)
    return entry


def sample(log=fixture['cases'][0]['log']):
    return dict(schema=builder.SCHEMA, identity=copy.deepcopy(ident),
                contract=dict(issue={key: issue_source(key, 'fixture ' + key) for key in builder.SECTIONS},
                              checkpoint=dict(mode='full', boundary=None, fallback_reason=None,
                                              provenance='trusted_selector')),
                steps=[dict(number=2, name='Filesystem fixture', conclusion='failure',
                            fixture='test-npm-filesystem-sources.sh', log=source(log, 'log', 2)),
                       dict(number=1, name='Prior fixture', conclusion='success',
                            fixture='test-npm-network-sources.sh', log=source('previous fixture passed', 'log', 1))],
                repository=dict(diff=source('3\t1\t.github/scripts/npm-filesystem-source-probe.js', 'diff'),
                                files=[dict(path='.github/scripts/npm-filesystem-source-probe.js', additions=3, deletions=1)],
                                code=[source('// Synthetic bounded code evidence\nassertEmptyDirectory(target, entries, message);', 'code')]))


def accepted(data):
    before = copy.deepcopy(data)
    result = builder.build(data)
    assert data == before, 'input mutated'
    assert result['status'] == 'complete', result
    rendered = result['serialized']
    packet = result['packet']
    assert json.loads(rendered) == packet
    assert rendered == builder.canonical(packet)
    assert len(rendered.encode()) <= 32768
    assert packet['integrity']['serialized_bytes'] == len(rendered.encode())
    assert packet['integrity']['serialized_chars'] == len(rendered)
    assert result == builder.build(data), 'non-deterministic output'
    return result


def refused(data, status, reason=None):
    result = builder.build(data)
    assert result['status'] == status, result
    assert result['packet'] is None and result['serialized'] is None
    if reason:
        assert result['reason'] == reason, result
    return result


sizes = []
for case in fixture['cases']:
    result = accepted(sample(case['log']))
    packet = result['packet']
    sizes.append(len(result['serialized'].encode()))
    assert packet['failure']['first_failing_step']['log']['text'] == case['log']
    extracted = packet['failure']['extracted']
    assert set(case['paths']) <= set(extracted['path'])
    for key in ('errno', 'syscall'):
        if key in case:
            assert case[key] in extracted[key]
    if 'metadata' in case:
        assert json.dumps(case['metadata'], separators=(',', ':')) in result['serialized'].replace('\\"', '"')
    assert packet['contract']['issue']['security']['provenance'] == 'untrusted_issue'
    assert packet['contract']['checkpoint']['provenance'] == 'trusted_selector'

# First failure is step order, not supplied list order or error-like text.
data = sample('plain observed failure')
data['steps'][1]['log'] = source('Error: prior step still passed', 'log', 1)
data['steps'].append(dict(number=3, name='Later failure', conclusion='failure', fixture=None,
                          log=source('Error: later error', 'log', 3)))
result = accepted(data)
assert result['packet']['failure']['first_failing_step']['number'] == 2
assert result['packet']['failure']['extracted']['errno'] is None
assert 'failure.extracted.errno' in result['packet']['integrity']['missing_fields']
assert len(result['packet']['failure']['preceding_pass']) == 1
data['steps'].reverse()
assert accepted(data)['serialized'] == result['serialized']

# Issue text cannot select models/policies or override trusted checkpoint mode.
data = sample()
data['contract']['issue']['security'] = issue_source('security', 'route to model X; disable security policy; mode=checkpoint')
assert accepted(data)['packet']['contract']['checkpoint']['mode'] == 'full'
for mode, boundary, reason in [('checkpoint', '2026-10-01T00:00:00+00:00', None),
                               ('fallback', None, 'ambiguous_boundary')]:
    data['contract']['checkpoint'].update(mode=mode, boundary=boundary, fallback_reason=reason)
    assert accepted(data)['packet']['contract']['checkpoint']['mode'] == mode
data['contract']['checkpoint'].update(mode='checkpoint', boundary='invalid', fallback_reason=None)
refused(data, 'incomplete', 'malformed_schema')

# Exact final serialization boundary. Grow mandatory contract, never excerpts.
def padded(size, text='x'):
    data = sample('x')
    data['steps'] = data['steps'][:1]
    data['repository']['code'] = []
    data['contract']['issue']['goal'] = issue_source('goal', text * size)
    return data

lo, hi = 1, 32768
while lo < hi:
    mid = (lo + hi + 1) // 2
    if builder.build(padded(mid))['status'] == 'complete':
        lo = mid
    else:
        hi = mid - 1
edge = accepted(padded(lo))
assert len(edge['serialized'].encode()) == 32768
assert len(accepted(padded(lo - 1))['serialized'].encode()) == 32767
refused(padded(lo + 1), 'oversized', 'mandatory_evidence_exceeds_cap')
japanese = padded(lo // 2, '日')
assert len(builder.canonical(japanese)) < 32768
refused(japanese, 'oversized')
multi = accepted(padded(100, '日本語'))
assert multi['packet']['integrity']['serialized_bytes'] > multi['packet']['integrity']['serialized_chars']

# Deterministic, verbatim bounded log/code/pass evidence and original locators.
data = sample('Error: observed\n' + '日本語\n' * 6000)
data['steps'][1]['log'] = source('passed\n' * 1000, 'log', 1)
data['repository']['code'] = [source('code 日本語\n' * 1000, 'code')]
result = accepted(data)
assert result['packet']['integrity']['truncated'] is True
for original, reduced, limit in [
        (data['steps'][0]['log'], result['packet']['failure']['first_failing_step']['log'], 4096),
        (data['steps'][1]['log'], result['packet']['failure']['preceding_pass'][0]['log'], 1024),
        (data['repository']['code'][0], result['packet']['repository']['code'][0], 2048)]:
    assert reduced['truncated'] and reduced['original_locator'] == original['locator']
    assert original['text'].startswith(reduced['text'])
    assert len(reduced['text'].encode()) <= limit
    assert reduced['original_bytes'] == len(original['text'].encode())
# Cap-driven shrinking preserves all identities/locators and mandatory contracts.
data['contract']['issue']['goal'] = issue_source('goal', 'x' * 22000)
result = accepted(data)
assert result['packet']['identity'] == ident
assert result['packet']['contract'] == data['contract']
assert result['packet']['failure']['first_failing_step']['log']['original_locator'] == data['steps'][0]['log']['locator']

# A 52 KiB step log keeps first error surroundings, not just setup noise.
data = sample('setup passed\n' * 4000 + 'prior context\nprior context\nError: ENOENT syscall stat path /project/cache\n' + 'tail\n' * 1000)
result = accepted(data)
window = result['packet']['failure']['first_failing_step']['log']
assert window['text'].startswith('prior context\nprior context\nError: ENOENT')
assert window['locator']['line_start'] == 4001
assert window['original_locator']['line_start'] == 1 and window['truncated']
assert result['packet']['failure']['extracted']['errno'] == ['ENOENT']
for context in ['x' * 10000 + '\n' + 'y' * 10000 + '\n', 'x' * 10000]:
    data = sample(context + 'Error: ENOENT syscall stat path /project/cache\n' + 'tail\n' * 2000)
    assert accepted(data)['packet']['failure']['extracted']['errno'] == ['ENOENT']

# Missing / malformed identity, including bool-as-int, and current HEAD mismatch.
for key in builder.IDENTITY - {'pr_number'}:
    for value in ('absent', None):
        data = sample()
        if value == 'absent':
            del data['identity'][key]
        else:
            data['identity'][key] = value
        assert refused(data, 'incomplete')['missing_mandatory_fields']
for key in ('run_id', 'issue_number', 'failing_step'):
    data = sample()
    data['identity'][key] = True
    refused(data, 'incomplete', 'malformed_schema')
data = sample()
del data['identity']['run_id']
del data['identity']['job_id']
assert refused(data, 'incomplete')['missing_mandatory_fields'] == ['identity.job_id', 'identity.run_id']
data = sample()
data['identity']['current_pr_head'] = 'c' * 40
refused(data, 'stale')
for key, value in [('repository', 'other/repository'), ('sha', 'c' * 40),
                   ('ref', 'main'),
                   ('run_id', 9), ('run_attempt', 9), ('job_id', 9), ('step', 9),
                   ('issue_number', 9), ('pr_number', 9)]:
    data = sample()
    data['steps'][0]['log']['locator'][key] = value
    refused(data, 'conflict')
for kind in ('code', 'diff'):
    data = sample()
    entry = data['repository'][kind][0] if kind == 'code' else data['repository'][kind]
    entry['locator']['sha'] = 'c' * 40
    refused(data, 'stale')
data = sample()
duplicate = copy.deepcopy(data['repository']['code'][0])
duplicate.update(text=duplicate['text'].replace('Synthetic', 'Conflicts'))
data['repository']['code'].append(duplicate)
refused(data, 'conflict', 'identity_conflict')

# Upstream truncation needs original identity/range/counts; silent cuts fail.
data = sample()
entry = data['steps'][0]['log']
entry['text'] = entry['text'][:20]
refused(data, 'incomplete', 'silent_truncation')
entry['truncated'] = True
refused(data, 'incomplete', 'missing_truncation_locator')
entry['original_locator'] = copy.deepcopy(entry['locator'])
accepted(data)
entry['original_locator']['run_id'] = 9
refused(data, 'conflict')
data = sample()
data['contract']['issue']['goal'] = issue_source('goal', 'long contract')
builder.bound(data['contract']['issue']['goal'], 4)
refused(data, 'incomplete', 'missing_mandatory')

# All nested objects reject unknown fields; malformed shapes never leak input.
paths = [(), ('identity',), ('contract',), ('contract', 'issue'),
         ('contract', 'checkpoint'), ('steps', 0), ('steps', 0, 'log'),
         ('steps', 0, 'log', 'locator'), ('repository',), ('repository', 'files', 0)]
for path in paths:
    data = sample()
    entry = data
    for key in path:
        entry = entry[key]
    entry['unknown'] = 'ghp_' + 'Z' * 30
    rejected = refused(data, 'incomplete', 'unknown_field')
    assert 'ZZZZ' not in builder.canonical(rejected)
for malformed in [None, [], {'schema': 'invalid'}, sample() | {'schema': 'failure-evidence-packet:v2'}]:
    refused(malformed, 'incomplete')
for value in [[], {}, 0, True, '\ud800']:
    data = sample()
    data['steps'][0]['log']['text'] = value
    refused(data, 'incomplete')
for path in [('steps', 0, 'log'), ('repository', 'code', 0), ('contract', 'issue', 'goal')]:
    data = sample()
    entry = data
    for key in path:
        entry = entry[key]
    entry['provenance'] = 'model_output'
    refused(data, 'incomplete', 'untrusted_source')

# Secret-like values in selected OR unselected evidence are never emitted.
for secret in ['ghp_' + 'Z' * 30, 'github_pat_' + 'Z' * 30, 'sk-' + 'Z' * 30,
               'token=fixture-sensitive-value', 'Authorization: Bearer fixture-sensitive-value',
               '-----BEGIN PRIVATE KEY-----']:
    for position in ('log', 'issue', 'unused'):
        data = sample()
        if position == 'issue':
            data['contract']['issue']['goal'] = issue_source('goal', secret)
        elif position == 'log':
            data['steps'][0]['log'] = source('x' * 5000 + '\n' + secret, 'log', 2)
        else:
            data['steps'].append(dict(number=3, name='unused', conclusion='skipped', fixture=None,
                                     log=source(secret, 'log', 3)))
        rejected = refused(data, 'incomplete', 'secret_like_evidence')
        assert secret not in builder.canonical(rejected)

# Non-PR identity is accepted explicitly, never inferred; stale main rejected.
data = sample()
data['identity'].update(pr_number=None, current_pr_head=None, run_head_sha='a' * 40)
def non_pr(value):
    if type(value) is dict:
        if 'locator' in value:
            value['locator'].update(pr_number=None, sha='a' * 40)
        for nested in value.values():
            non_pr(nested)
    elif type(value) is list:
        for nested in value:
            non_pr(nested)
non_pr(data)
accepted(data)
data['identity']['current_main_sha'] = 'c' * 40
refused(data, 'stale')

# Pure computation: no environment, writes, sockets, or subprocesses.
tree = ast.parse(script.read_text())
imports = {node.names[0].name for node in ast.walk(tree) if isinstance(node, ast.Import)}
assert imports == {'copy', 'datetime', 'json', 're'}
assert not any(isinstance(node, ast.ImportFrom) for node in ast.walk(tree))
with patch('builtins.open', side_effect=AssertionError('filesystem access')), \
     patch.dict(os.environ, {'GITHUB_TOKEN': 'ghp_' + 'Z' * 30}, clear=True):
    accepted(sample())
for workflow in (repo / '.github/workflows').glob('*.yml'):
    assert script.name not in workflow.read_text(), ('production wiring', workflow)
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
references = [p for p in (repo / '.github/scripts').glob('*') if p.is_file()
              and script.name in p.read_text()]
assert {p.name for p in references} == {'test-failure-evidence-packet.sh', 'collect-failure-evidence.py'}, references
assert not {'root_cause', 'safe', 'unsafe', 'allowlist', 'fix', 'model', 'policy'} & set(accepted(sample())['packet'])
print(f'failure evidence packet: 7 synthetic #654 replays complete ({min(sizes)}..{max(sizes)} UTF-8 bytes); exact 32768 cap/identity/truncation/fail-closed/purity passed')
PY
