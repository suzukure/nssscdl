#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

repo = Path(sys.argv[1])
prefix = '.github/scripts/'
source = repo / prefix / 'plan-ai-workflow-shards.py'
spec = importlib.util.spec_from_file_location('planner', source)
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)
actual = sorted(prefix + path.name for path in (repo / prefix).glob('test-*.sh'))
previous = [path for path in actual if path != prefix + 'test-plan-ai-workflow-shards.sh']
assert len(previous) == 77 and len(actual) == 78


def encode(paths):
    return b''.join(path.encode('utf-8') + b'\0' for path in paths)


def coverage(result, paths):
    assert set(result) == {'schema', 'version', 'policy', 'shard_count', 'shards'}
    assert result['schema'] == 'ai-workflow-shard-plan'
    assert type(result['version']) is int and result['version'] == 1
    assert result['policy'] == 'observed-lpt-v1'
    assert type(result['shard_count']) is int and result['shard_count'] == 2
    assert len(result['shards']) == 2
    for index, shard in enumerate(result['shards'], 1):
        assert set(shard) == {'id', 'fixtures'}
        assert type(shard['id']) is int and shard['id'] == index
        assert shard['fixtures'] and shard['fixtures'] == sorted(set(shard['fixtures']))
    a, b = (shard['fixtures'] for shard in result['shards'])
    assert not set(a) & set(b)
    assert set(a) | set(b) == set(paths)
    assert len(a) + len(b) == len(paths)
    return a, b


def rejected(data):
    try:
        planner.plan(data)
    except (ValueError, UnicodeError):
        pass
    else:
        raise AssertionError('invalid input/assignment accepted')


# Independently enumerate full inventory, including the pre-Issue 76 fixtures.
for paths in (previous, actual):
    result = planner.plan(encode(paths))
    a, b = coverage(result, paths)
    for reordered in (paths[::-1], paths[::2] + paths[1::2], paths[1:] + paths[:1]):
        assert planner.plan(encode(reordered)) == result
    # The two largest observed poles must be on different shards. Approximate
    # weights are an efficiency assertion only, never an eligibility oracle.
    heavy = prefix + 'test-product-npm-production-session.sh'
    second = prefix + 'test-npm-network-sources.sh'
    assert (heavy in a) != (second in a)
    observed = {
        heavy: 171.7, second: 56.4,
        prefix + 'test-product-npm-bootstrap-preparation.sh': 34.6,
        prefix + 'test-npm-offline-ci.sh': 30.4,
        prefix + 'test-npm-registry-lock.sh': 26.7,
    }
    totals = [sum(observed.get(path, 3.0) for path in shard) for shard in (a, b)]
    assert max(totals) / sum(totals) < 0.55, totals

small = [prefix + 'test-' + name + '.sh' for name in ('a', 'b', 'c', 'd')]
equal = planner.plan(encode(small))
assert coverage(equal, small) == (small[::2], small[1::2])
coverage(planner.plan(encode(small[:2])), small[:2])
unknown = prefix + 'test-future-unobserved.sh'
coverage(planner.plan(encode(actual + [unknown])), actual + [unknown])
with patch.object(planner, 'RUNTIME_HINTS', {}):
    a, b = coverage(planner.plan(encode(actual + [unknown])), actual + [unknown])
    assert abs(len(a) - len(b)) <= 1
with patch.object(planner, 'RUNTIME_HINTS', {small[0]: 999999}):
    coverage(planner.plan(encode(actual)), actual)  # A stale hint cannot add a fixture.

bad_paths = (
    '/.github/scripts/test-a.sh', './.github/scripts/test-a.sh',
    '.github/../scripts/test-a.sh', '.github//scripts/test-a.sh',
    prefix + '../test-a.sh', prefix + 'test-../a.sh', prefix + 'test-a/../b.sh',
    prefix + 'test-dir/a.sh', prefix + 'test-a.sh/', prefix + 'test-a.sh\\',
    prefix + 'test-a\\b.sh', prefix + 'test-.sh', prefix + 'other.sh',
    prefix + 'test-a.py', 'test-a.sh', '',
)
invalid = [encode([small[0], path]) for path in bad_paths]
invalid += [b'', b'\0', encode(small[:1]), encode(small + small[:1]),
            encode(small)[:-1], encode(small) + b'\0', encode(small) + b'tail',
            b'\xff\0' + encode(small), encode(small) + b'\xc0\x80\0']
for data in invalid + [None, 'text', [], bytearray(encode(small))]:
    rejected(data)
rejected(encode([small[0], prefix + 'test-a\0b.sh']))

# Internal contradictions never reach stdout as a success record.
for broken in ([small[:2], small[1:]], [small[:2], small[3:]],
               [small, []], [small[:1], small[1:3], small[3:]],
               [small[:2], small[2:] + [unknown]],
               [small[:2][::-1], small[2:]], None, [small, 'invalid']):
    with patch.object(planner, 'assign', return_value=broken):
        rejected(encode(small))
        output, error = io.StringIO(), io.StringIO()
        with patch.object(sys, 'argv', [str(source)]), \
             patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(encode(small)))), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            assert planner.main() == 1
        assert not output.getvalue() and error.getvalue()
for hints in (None, {small[0]: 0}, {small[0]: -1}, {small[0]: True},
              {small[0]: float('nan')}, {small[0]: '1'}, {'../bad': 10}):
    with patch.object(planner, 'RUNTIME_HINTS', hints):
        rejected(encode(small))
for fallback in (0, -1, None, True, 1.5):
    with patch.object(planner, 'FALLBACK_WEIGHT', fallback):
        rejected(encode(small))

# Real CLI emits exactly one canonical JSON line; cwd, locale and env are not
# policy inputs. Nonexistent fixture paths are data, not filesystem requests.
command = [sys.executable, '-B', str(source)]
with tempfile.TemporaryDirectory() as temporary:
    literal = [prefix + 'test-$(touch EXECUTED).sh', prefix + 'test-space name.sh',
               prefix + 'test-line\nbreak.sh', prefix + 'test-;echo literal.sh',
               prefix + 'test-*.sh', prefix + 'test-日本語.sh']
    expected = json.dumps(planner.plan(encode(actual)), sort_keys=True,
                          ensure_ascii=True, separators=(',', ':')).encode() + b'\n'
    for order, overrides in ((actual, {}), (actual[::-1], {
            'LC_ALL': 'C', 'SHARD_COUNT': '99', 'RUNTIME_HINTS': '{}',
            'GITHUB_WORKSPACE': '/absent', 'PLANNER_POLICY': 'untrusted'})):
        run = subprocess.run(command, input=encode(order), cwd=temporary,
                             env={**os.environ, **overrides}, capture_output=True, check=True)
        assert run.stdout == expected and not run.stderr
    run = subprocess.run(command, input=encode(literal), cwd=temporary,
                         capture_output=True, check=True)
    coverage(json.loads(run.stdout), literal)
    assert not list(Path(temporary).iterdir()), 'planner executed or wrote input paths'
    for data in invalid:
        run = subprocess.run(command, input=data, cwd=temporary, capture_output=True)
        assert run.returncode == 1 and not run.stdout
        assert run.stderr == 'AI workflow shard planを確定できませんでした。\n'.encode()
    run = subprocess.run(command + ['private argument'], input=encode(small), capture_output=True)
    assert run.returncode == 2 and not run.stdout and b'private argument' not in run.stderr

# Closed module surface forbids filesystem, env, shell, API and dynamic execution.
tree = ast.parse(source.read_text())
assert sorted(ast.unparse(node) for node in ast.walk(tree)
              if isinstance(node, (ast.Import, ast.ImportFrom))) == ['import json', 'import sys']
allowed_calls = {
    'all', 'assign', 'dict', 'enumerate', 'fixture_path', 'isinstance', 'json.dumps',
    'len', 'main', 'min', 'parse_paths', 'plan', 'print', 'range', 'set', 'sorted',
    'sys.exit', 'sys.stdin.buffer.read', 'type', 'path.encode', 'path.startswith',
    'path.endswith', 'data.endswith', 'data[:-1].decode',
    "data[:-1].decode('utf-8', 'strict').split", 'RUNTIME_HINTS.items',
    'RUNTIME_HINTS.get', 'shards[index].append',
}
assert all(ast.unparse(node.func) in allowed_calls for node in ast.walk(tree)
           if isinstance(node, ast.Call)), 'planner is no longer pure'

# Only fixture callers and exact selector data registration are allowed.
def dormant(path, text):
    if path == prefix + 'select-ai-workflow-fixtures.py':
        mapping = '(SCRIPTS + "plan-ai-workflow-shards.py", ("common",))'
        assert text.count(mapping) == 1
        text = text.replace(mapping, '').replace('"plan-ai-workflow-shards"', '', 1)
    assert 'plan-ai-workflow-shards' not in text, ('production caller', path)


for workflow in (repo / '.github/workflows').glob('*.yml'):
    dormant(workflow.relative_to(repo).as_posix(), workflow.read_text())
for script in (repo / prefix).iterdir():
    if (script.is_file() and script.suffix in ('.py', '.sh', '.js')
            and script != source and not script.name.startswith('test-')):
        dormant(script.relative_to(repo).as_posix(), script.read_text())
for path, text in (('.github/workflows/ai-workflow-regression.yml', 'python3 ' + source.name),
                   (prefix + 'consumer.py', 'import plan-ai-workflow-shards'),
                   (prefix + 'select-ai-workflow-fixtures.py',
                    (repo / prefix / 'select-ai-workflow-fixtures.py').read_text()
                    + '\nrun("plan-ai-workflow-shards.py")\n')):
    try:
        dormant(path, text)
    except AssertionError:
        pass
    else:
        raise AssertionError('production planner caller accepted')
print('AI workflow shard planner: 77/78 inventory, exact coverage, balance, canonical, fail-closed, pure/dormant PASS')
PY
