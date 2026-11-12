#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from unittest.mock import patch
import yaml

repo = Path(sys.argv[1])
source = repo / '.github/scripts/validate-codex-usage-identity.py'
spec = importlib.util.spec_from_file_location('usage_identity', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
identity = dict(schema='codex-usage-evidence-identity', version=1,
                repository='suzukure/nssscdl', run_id=37268676016, run_attempt=1,
                issue_number=780, job='develop-from-issue', pr_number=None,
                base_sha='66d677e8f8a278e3ab98f980992791ae9735baf6',
                selected_model='gpt-6.1-sol', cli_version='0.159.3',
                reasoning_effort='medium', invocation_mode='fresh_exec')
canary = 'secretless identity canary'


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def check(value=identity, raw=None):
    data = encoded(value) if raw is None else raw
    before = data[:]
    first, second = helper.validate_identity(data), helper.validate_identity(data)
    assert type(first) is dict and first == second == value
    assert first is not second and data == before
    first['run_id'] = 99
    assert second == value and helper.validate_identity(data) == value


def rejected(data):
    try:
        helper.validate_identity(data)
    except Exception as error:
        assert type(error) is ValueError and error.args == ('invalid_identity',)
        assert error.__cause__ is None and error.__context__ is None
        assert canary not in str(error) + repr(error)
    else:
        raise AssertionError('invalid identity accepted')


check()
workflow = yaml.safe_load((repo / '.github/workflows/ai-developer.yml').read_text())
assert set(helper.JOBS) == {'develop-from-issue', 'respond-to-claude'}
assert set(helper.JOBS) <= set(workflow['jobs']), 'identity job differs from actual workflow'
for job in ('develop-from-issue', 'respond-to-claude'):
    for pr in (None, 1, 2**53 - 1):
        check({**identity, 'job': job, 'pr_number': pr})

# Every adopted integer is strict (including version); JSON floats never qualify.
for key in ('run_id', 'run_attempt', 'issue_number', 'pr_number'):
    for value in (1, 2**53 - 1):
        check({**identity, key: value})
    for value in (True, False, 0, -1, 2**53, 1.0, 1.5, '1', [], {}, canary):
        rejected(encoded({**identity, key: value}))
    if key != 'pr_number':
        rejected(encoded({**identity, key: None}))
for value in (True, False, 1.0, 0, 2, -1, '1', None, [], {}):
    rejected(encoded({**identity, 'version': value}))

for key in identity:
    rejected(encoded({k: v for k, v in identity.items() if k != key}))
    for value in (None, True, 1.0, [], {}, canary):
        if key == 'pr_number' and value is None:
            continue
        rejected(encoded({**identity, key: value}))
    # Duplicate keys (including escaped spellings) cannot override invalid data.
    prefix = encoded({key: canary})[:-1] + b','
    rejected(prefix + encoded(identity)[1:])
    escaped_key = '\\u%04x' % ord(key[0]) + key[1:]
    rejected(b'{"' + escaped_key.encode() + b'":"' + canary.encode()
             + b'",' + encoded(identity)[1:])
for key in ('extra', 'usage', 'stream', 'prompt', canary):
    rejected(encoded({**identity, key: canary}))
for key, values in {
        'schema': ('unknown', 'codex-exec-usage-context'),
        'repository': ('other/nssscdl', 'Suzukure/nssscdl', 'suzukure/nssscdl\n'),
        'job': ('unknown', 'Develop-from-issue', 'respond-to-claude\n'),
        'reasoning_effort': ('low', 'high', 'Medium', 'medium\n'),
        'invocation_mode': ('resume', 'exec', 'fresh_exec\n'),
        'base_sha': ('a' * 39, 'a' * 41, 'A' * 40, 'g' * 40, '0' * 40 + '\n'),
        'selected_model': ('', 'x' * 129, '.model', '-model', '_model', ':model',
                           'é', 'ｍodel', 'a\n', 'a b', 'a/b', '$(model)'),
        'cli_version': ('', '1.2', '1.2.3.4', '1000000.2.3', '1.1000000.3',
                        '1.2.1000000', '+1.2.3', '1.2.-3', '1.2.3\n', '１.2.3'),
}.items():
    for value in values:
        rejected(encoded({**identity, key: value}))
for model in ('a', 'Z' * 128, '0model', 'gpt-6-luna', 'Any_Model.1:trial-2'):
    check({**identity, 'selected_model': model})
for sha in ('0' * 40, 'abcdef0123' * 4):
    check({**identity, 'base_sha': sha})
for version in ('0.0.0', '000001.000002.000003', '999999.999999.999999'):
    check({**identity, 'cli_version': version})

# Noncanonical whitespace/order/escapes are permitted; byte bounds are inclusive.
raw = encoded(identity)
check(raw=b' \t\r\n' + json.dumps(dict(reversed(list(identity.items()))), indent=2).encode() + b'\n')
check(raw=raw.replace(b'"schema"', b'"\\u0073chema"'))
check(raw=raw.replace(b'gpt-6.1-sol', b'gpt-6.1-\\u0073ol'))
exact = raw + b' ' * (4096 - len(raw))
check(raw=exact)
rejected(exact + b' ')
for data in (None, raw.decode(), bytearray(raw), memoryview(raw), {}, [], 1, True,
             b'', b'{', b'null', b'[]', b'1', b'true', b'"' + canary.encode() + b'"',
             raw + b'{}', raw + b'\nnull', b'\xef\xbb\xbf' + raw,
             raw + b'\xff', raw.replace(b'gpt-6.1-sol', b'\xc0\xaf'),
             b'{"' + canary.encode() + b'":NaN}',
             b'[' * 1500 + b'0' + b']' * 1500,
             raw.replace(b'"job":"develop-from-issue"',
                         b'"job":' + b'[' * 1200 + b'0' + b']' * 1200)):
    rejected(data)
for key in identity:
    for constant in ('NaN', 'Infinity', '-Infinity', '1e999', '1e-999'):
        value = json.dumps(identity)
        target = json.dumps(identity[key])
        value = value.replace(json.dumps(key) + ': ' + target,
                              json.dumps(key) + ': ' + constant, 1)
        rejected(value.encode())

# A closed import/call surface proves there is no CLI, loader or side effect.
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import json', 'import re'}
assert not any(isinstance(n, (ast.ClassDef, ast.If)) for n in tree.body)
allowed_calls = {'require', 'ValueError', 'len', 'type', 'set', 'dict', 'positive_integer',
                 'json.loads', 'identity_bytes.decode', 're.fullmatch', '_validate'}
assert all(ast.unparse(n.func) in allowed_calls for n in ast.walk(tree) if isinstance(n, ast.Call))
output = io.StringIO()
with patch('builtins.open', side_effect=AssertionError('pure API attempted IO')), \
     contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
    check()
    rejected(b'{"' + canary.encode() + b'":NaN}')
assert output.getvalue() == ''
print('Codex usage identity: pure / strict schema / bounded / fixed unchained rejection PASS')
PY
