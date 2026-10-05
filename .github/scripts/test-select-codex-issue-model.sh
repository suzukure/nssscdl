#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

repo = Path(sys.argv[1])
source = repo / '.github/scripts/select-codex-issue-model.py'
policy_path = repo / '.github/scripts/codex-issue-model-policy.json'
spec = importlib.util.spec_from_file_location('model_selector', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
policy = json.loads(policy_path.read_bytes())
assert policy == {'schema': 'codex-issue-model-policy', 'version': 1,
                  'repository': 'suzukure/nssscdl',
                  'entries': [dict(issue=635, model='gpt-6-luna')]}
empty_policy = {**policy, 'entries': []}
request = dict(repository='suzukure/nssscdl', issue=745, normal_model='gpt-6-sol')
opt_in = {**policy, 'entries': [dict(issue=745, model='gpt-6-luna')]}

def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()

def select(p=policy, r=request):
    return helper.select(encoded(p), encoded(r))

def expected(model, selection, issue=745):
    return dict(schema='codex-issue-model-selection', version=1,
                issue=issue, model=model, selection=selection)

def rejected(p=policy, r=request, raw_policy=None, raw_request=None):
    try:
        helper.select(encoded(p) if raw_policy is None else raw_policy,
                      encoded(r) if raw_request is None else raw_request)
    except (ValueError, TypeError, RecursionError):
        return
    raise AssertionError('invalid model selection accepted')

assert select() == expected('gpt-6-sol', 'default')
assert select(empty_policy, {**request, 'issue': 635}) == expected('gpt-6-sol', 'default', 635)
for issue in (634, 636, 745, 802, 1635, helper.MAX_ISSUE):
    for normal in ('gpt-6-sol', 'gpt-6.1-sol'):
        assert select(policy, {**request, 'issue': issue, 'normal_model': normal}) == expected(normal, 'default', issue)
assert select(opt_in) == expected('gpt-6-luna', 'opt_in')
# initial / follow-up / resume use the same gated identity contract, no phase state.
for phase in ('initial', 'follow-up', 'resume'):
    for normal in ('gpt-6-sol', 'gpt-6.1-sol'):
        assert select(policy, {**request, 'issue': 635, 'normal_model': normal}) == expected('gpt-6-luna', 'opt_in', 635)
    assert select(opt_in, copy.deepcopy(request)) == expected('gpt-6-luna', 'opt_in')
    assert select(opt_in, {**request, 'normal_model': 'gpt-6.1-sol'}) == expected('gpt-6-luna', 'opt_in')
    assert select(policy, {**request, 'normal_model': 'gpt-6.1-sol'}) == expected('gpt-6.1-sol', 'default')
assert select(opt_in, {**request, 'issue': 74}) == expected('gpt-6-sol', 'default', 74)
assert select(opt_in, {**request, 'issue': 1745}) == expected('gpt-6-sol', 'default', 1745)
for bad in (True, False, 0, -1, 745.0, '745', '74', 'issue:745', '745-extra',
            None, [], {}, helper.MAX_ISSUE + 1):
    rejected(r={**request, 'issue': bad})
    rejected(p={**policy, 'entries': [dict(issue=bad, model='gpt-6-luna')]})
for repository in ('other/nssscdl', 'suzukure/other', 'Suzukure/nssscdl', '', None):
    rejected(r={**request, 'repository': repository})
    rejected(p={**policy, 'repository': repository})
for model in ('gpt-6-sol', 'gpt-6-luna-extra', '', None, [], True):
    rejected(p={**policy, 'entries': [dict(issue=745, model=model)]})
for normal in ('', ' ', 'gpt-6-sol\n', 'x' * 129, None, [], True, '$(private-marker)'):
    rejected(r={**request, 'normal_model': normal})
for value in (policy, request, opt_in['entries'][0]):
    for key in value:
        bad = {k: v for k, v in value.items() if k != key}
        if value is policy:
            rejected(p=bad)
        elif value is request:
            rejected(r=bad)
        else:
            rejected(p={**policy, 'entries': [bad]})
for extra in ('model', 'effort', 'phase', 'prompt', 'private-marker'):
    rejected(p={**policy, extra: 'private-marker'})
    rejected(r={**request, extra: 'private-marker'})
    rejected(p={**policy, 'entries': [{**opt_in['entries'][0], extra: 'private-marker'}]})
for version in (True, 1.0, '1', 2, None):
    rejected(p={**policy, 'version': version})
rejected(p={**policy, 'schema': 'unknown'})
rejected(p={**policy, 'entries': opt_in['entries'] * 2})
for entries in (None, {}, 'unknown', [None], [True], [[]]):
    rejected(p={**policy, 'entries': entries})
bounded = {**policy, 'entries': [dict(issue=n, model='gpt-6-luna')
                               for n in range(1, helper.MAX_ENTRIES + 1)]}
assert select(bounded) == expected('gpt-6-sol', 'default')
rejected(p={**bounded, 'entries': bounded['entries'] + [dict(issue=999, model='gpt-6-luna')]})
for raw in (b'', b'{', b'null', b'[]', b'{} {}', b'\xff', b'{"private-marker":NaN}',
            b'{"repository":"private-marker","repository":"suzukure/nssscdl"}'):
    rejected(raw_policy=raw)
    rejected(raw_request=raw)
rejected(raw_policy=encoded({**policy, 'entries': []})[:-1] + b',"entries":[]}')
rejected(raw_policy=encoded(opt_in).replace(b'"issue":745', b'"issue":1,"issue":745'))
rejected(raw_request=encoded(request).replace(b'"issue":745', b'"issue":1,"issue":745'))
for role, limit in (('policy', helper.MAX_POLICY_BYTES), ('request', helper.MAX_REQUEST_BYTES)):
    raw = encoded(policy if role == 'policy' else request)
    exact = raw + b' ' * (limit - len(raw))
    assert helper.select(exact if role == 'policy' else encoded(policy),
                         exact if role == 'request' else encoded(request)) == expected('gpt-6-sol', 'default')
    rejected(**{'raw_' + role: exact + b' '})

# Pure API cannot acquire provenance, execute commands, persist or call a service.
with patch('builtins.open', side_effect=AssertionError('pure API attempted IO')):
    assert select(opt_in) == expected('gpt-6-luna', 'opt_in')
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import json', 'import re', 'import sys'}
assert not any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in ('eval', 'exec', '__import__') for n in ast.walk(tree))

# CLI outputs exactly one canonical record; every failure has empty stdout and
# fixed non-reflecting stderr, including unknown identity / unavailable policy.
with tempfile.TemporaryDirectory() as temporary:
    fixture_policy = Path(temporary) / 'private-marker.json'
    command = [sys.executable, '-B', str(source), '--policy', str(fixture_policy)]
    def run(raw_policy, raw_request=encoded(request), arguments=command):
        fixture_policy.write_bytes(raw_policy)
        return subprocess.run(arguments, input=raw_request, capture_output=True)
    for p, r, want in ((policy, request, expected('gpt-6-sol', 'default')),
                       (empty_policy, request, expected('gpt-6-sol', 'default')),
                       (policy, {**request, 'issue': 635}, expected('gpt-6-luna', 'opt_in', 635)),
                       (opt_in, request, expected('gpt-6-luna', 'opt_in'))):
        first, second = run(encoded(p), encoded(r)), run(encoded(p), encoded(r))
        canonical = (json.dumps(want, sort_keys=True, separators=(',', ':')) + '\n').encode()
        assert first.returncode == second.returncode == 0
        assert first.stdout == second.stdout == canonical and not first.stderr and not second.stderr
        assert len(first.stdout) < 512
    for raw_policy, raw_request in ((b'private-marker', encoded(request)),
                                    (encoded(policy), b'private-marker'),
                                    (encoded(policy), encoded({**request, 'repository': None})),
                                    (b' ' * (helper.MAX_POLICY_BYTES + 1), encoded(request)),
                                    (encoded(policy), b' ' * (helper.MAX_REQUEST_BYTES + 1))):
        result = run(raw_policy, raw_request)
        assert result.returncode == 1 and not result.stdout
        assert result.stderr == 'モデル選択を拒否しました: invalid_policy_or_request\n'.encode()
    fixture_policy.unlink()
    for arguments, code in ((command, 1), (command + ['private-marker'], 2),
                            (command[:3], 2), (command[:3] + ['private-marker'], 2)):
        result = subprocess.run(arguments, input=encoded(request), capture_output=True)
        assert result.returncode == code and not result.stdout
        assert b'private-marker' not in result.stderr and len(result.stderr) < 128
print('Codex Issue model selector: pure / bounded / exact identity / fail-closed / canonical PASS')
PY
