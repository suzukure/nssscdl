#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import itertools
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

repo = Path(sys.argv[1])
source = repo / '.github/scripts/systemd-transient-lifecycle.py'
spec = importlib.util.spec_from_file_location('lifecycle', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
unit = 'ai-lifecycle-' + 'a' * 32 + '.service'
private = 'PRIVATE-RAW-COMMAND-PATH-EXCEPTION'
argv = ['/synthetic/' + private, '--unit=' + unit, private]


def outcome(kind):
    if kind == 'timeout':
        raise subprocess.TimeoutExpired(private, 1, output=private, stderr=private)
    if kind == 'exec-error':
        raise OSError(private)
    if kind == 'python-error':
        raise RuntimeError(private)
    if kind == 'interrupt':
        raise KeyboardInterrupt(private)
    if kind == 'invalid-rc':
        return None
    return {'zero': 0, 'nonzero': 2, 'signal': -15, 'one': 1}[kind]


def run(launch='zero', stop='zero', show='zero', data=b'not-found\n'):
    calls = []
    def fake_run(command, **options):
        index = len(calls)
        calls.append((command, options))
        assert index < 3, 'retry/fallback must never occur'
        if index == 2:
            options['stdout'].write(data)
        return subprocess.CompletedProcess(command, outcome((launch, stop, show)[index]),
                                           private, private)
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.object(helper.subprocess, 'run', side_effect=fake_run), \
         redirect_stdout(stdout), redirect_stderr(stderr):
        result = helper.execute(unit, argv, 23)
    assert not stdout.getvalue() and not stderr.getvalue()
    assert [c for c, _ in calls] == [tuple(argv),
        ['sudo', '-n', '/usr/bin/systemctl', 'stop', unit],
        ['sudo', '-n', '/usr/bin/systemctl', 'show', unit,
         '--property=LoadState', '--value']]
    assert [o['timeout'] for _, o in calls] == [23, 10, 10]
    # Verify outside invoke's exception normalizer so assertion errors cannot be
    # mistaken for the expected exec-error in a negative case.
    for index, (_, options) in enumerate(calls):
        assert options['stdin'] == options['stderr'] == subprocess.DEVNULL
        assert options['shell'] is False and options['check'] is False
        assert options['env'] == {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
        if index < 2:
            assert options['stdout'] == subprocess.DEVNULL
    assert set(result) == {'schema', 'version', 'status', 'launch_exit_class',
                           'launch_status', 'cleanup_status', 'residual_class'}
    assert result['schema'] == 'systemd-transient-lifecycle' and type(result['version']) is int
    assert result['version'] == 1
    assert result['status'] in ('pass', 'fail') and result['launch_status'] in ('pass', 'fail')
    assert result['launch_exit_class'] in ('zero', 'nonzero', 'signal', 'timeout', 'exec-error')
    assert result['cleanup_status'] in ('confirmed', 'unconfirmed', 'stop-nonzero',
                                       'stop-signal', 'stop-timeout', 'stop-exec-error')
    assert result['residual_class'] in ('not-found', 'present', 'malformed', 'nonzero',
                                       'signal', 'timeout', 'exec-error', 'unconfirmed')
    encoded = json.dumps(result, sort_keys=True).encode()
    assert len(encoded) < 512
    assert all(value.encode() not in encoded for value in (private, unit, argv[0]))
    return result


# All launch failures still stop AND show, even when both cleanup operations fail.
kinds = ('zero', 'nonzero', 'signal', 'timeout', 'exec-error', 'python-error',
         'interrupt', 'invalid-rc')
normalize = lambda kind: ('exec-error' if kind in ('python-error', 'invalid-rc')
                          else 'signal' if kind == 'interrupt' else kind)
for launch, stop, show in itertools.product(kinds, repeat=3):
    result = run(launch, stop, show)
    assert result['launch_exit_class'] == normalize(launch)
    assert result['launch_status'] == ('pass' if launch == 'zero' else 'fail')
    assert result['residual_class'] == ('not-found' if show == 'zero' else normalize(show))
    expected_cleanup = ('stop-' + normalize(stop) if stop != 'zero' else
                        'confirmed' if show == 'zero' else 'unconfirmed')
    assert result['cleanup_status'] == expected_cleanup
    assert result['status'] == ('pass' if launch == stop == show == 'zero' else 'fail')

for data in (b'not-found', b'not-found\n'):
    assert run(show='one', data=data)['status'] == 'pass'
for data in (b'loaded', b'loaded\n', b'masked\n', b'error\n'):
    result = run(data=data)
    assert result['residual_class'] == 'present' and result['status'] == 'fail'
for data in (b'', b' not-found\n', b'not-found\n\n', b'not-found\r\n',
             b'LoadState=not-found\n', b'not-found\0', b'\xff', b'x' * 33,
             b'not-found\n' + b'x' * 100000, private.encode()):
    for show in ('zero', 'one'):
        result = run(show=show, data=data)
        assert result['residual_class'] == 'malformed' and result['status'] == 'fail'
assert run(show='nonzero')['status'] == 'fail', 'absence text cannot override rc 2'

# Bounds and exact unit validation reject input before any privileged transport.
valid = (unit, argv, 23)
bad_units = ('', unit.upper(), unit + '\n', unit + '/extra', unit[:-1],
             'ai-lifecycle-' + 'a' * 31 + '.service', '../' + unit, None)
bad_argv = ([], 'shell command', [None], [''], ['x\0y'], ['\ud800'],
            ['x'] * 257, ['x' * 8193], ['x' * 8192] * 9)
bad_timeouts = (0, -1, 701, True, 1.5, float('nan'), float('inf'), None)
with patch.object(helper.subprocess, 'run', side_effect=AssertionError('unexpected execution')) as runner:
    for field, values in enumerate((bad_units, bad_argv, bad_timeouts)):
        for value in values:
            inputs = list(valid)
            inputs[field] = value
            result = helper.execute(*inputs)
            assert result['status'] == result['launch_status'] == 'fail'
            assert result['cleanup_status'] == result['residual_class'] == 'unconfirmed'
    runner.assert_not_called()
for timeout in (1, 700):
    assert helper.valid_inputs(unit, ['x'], timeout)
assert helper.valid_inputs(unit, ['x'] * 256, 1)
assert helper.valid_inputs(unit, ['x' * 8192] * 8, 1)
assert not helper.valid_inputs(unit, ['界' * 3000], 1), 'bound is UTF-8 bytes'
names = {helper.new_unit() for _ in range(64)}
assert len(names) == 64 and all(helper.valid_inputs(name, ['x'], 1) for name in names)

# Cleanup-local file/subprocess errors are normalized and cannot leak text.
with patch.object(helper.tempfile, 'TemporaryFile', side_effect=OSError(private)), \
     patch.object(helper.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as runner:
    result = helper.execute(unit, argv, 23)
    assert runner.call_count == 2 and result['status'] == 'fail'
    assert result['residual_class'] == 'exec-error' and private not in json.dumps(result)

# Prepared-only: no CLI, no caller beyond fixture and declarative selector mapping.
tree = ast.parse(source.read_text())
assert not any(isinstance(node, ast.If) and '__name__' in ast.unparse(node.test)
               for node in tree.body)
for directory in ('.github/scripts', '.github/workflows'):
    for path in (repo / directory).rglob('*'):
        if not path.is_file() or path.suffix not in ('.py', '.sh', '.js', '.yml', '.yaml'):
            continue
        if path == source or (directory == '.github/scripts' and path.parent == source.parent
                              and path.name.startswith('test-')):
            continue
        text = path.read_text()
        if path.name == 'select-ai-workflow-fixtures.py':
            expected = '(SCRIPTS + "systemd-transient-lifecycle.py", ("ai-developer-codex",))'
            assert text.count(expected) == 1
            text = text.replace(expected, '')
            extension = '"systemd-transient-lifecycle"'
            assert text.count(extension) == 1
            text = text.replace(extension, '')
        assert source.stem not in text, ('unexpected prepared helper caller', path.relative_to(repo))
print('systemd transient lifecycle: synthetic exit/cleanup matrix, bounded result, exact calls, prepared-only passed')
PY
