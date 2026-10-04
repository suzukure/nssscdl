#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from unittest.mock import patch

repo = Path(sys.argv[1])
scripts = repo / '.github/scripts'
source = scripts / 'supervise-codex-exec-stream.py'
extractor_source = scripts / 'extract-codex-exec-usage.py'


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper, extractor = load(source), load(extractor_source)
canary = 'SECRET_CANARY_761_argv_path_thread_error_model'
usage = dict(input_tokens=100, cached_input_tokens=70, cache_write_input_tokens=40,
             output_tokens=20, reasoning_output_tokens=10)
start = [dict(type='thread.started', thread_id=canary), dict(type='turn.started')]
completed = dict(type='turn.completed', usage=usage)
failed = dict(type='turn.failed', error=dict(message=canary))


def lines(events):
    return b''.join(json.dumps(e, separators=(',', ':')).encode() + b'\n' for e in events)


normal = lines(start + [dict(type='item.completed', item=dict(model=canary,
                        command=canary, output=canary)), completed])
command = [sys.executable, '-B', str(source), '--extractor', str(extractor_source), '--']
python_child = [sys.executable, '-B', '-c']


def check_record(data, rc, status, reason=None):
    assert type(data) is bytes and len(data) <= 4096 and canary.encode() not in data
    assert str(source).encode() not in data and str(extractor_source).encode() not in data
    value = json.loads(data)
    assert set(value) == {'schema', 'version', 'process_returncode',
                          'collection_status', 'usage_result'}
    assert value['schema'] == 'codex-exec-stream' and value['version'] == 1
    assert value['process_returncode'] == rc and value['collection_status'] == status
    canonical = json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()
    assert data in (canonical, canonical + b'\n')
    if status == 'collected':
        assert value['usage_result']['reason'] == reason
        if reason == 'terminal_cumulative':
            assert value['usage_result']['usage'] == usage
        else:
            assert value['usage_result']['usage'] is None
    else:
        assert value['usage_result'] is None
    return value


def run(code, raw=b'', rc=0, status='collected', reason='terminal_cumulative', extra=()):
    # Timeout belongs only to this finite synthetic proof, never the helper.
    result = subprocess.run(command + python_child + [code, *extra], input=raw,
                            capture_output=True, timeout=15)
    assert result.returncode == helper.exit_status(rc), result
    assert not result.stderr and result.stdout.count(b'\n') == 1
    return check_record(result.stdout, rc, status, reason)


echo = 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.exit(%d)'
for raw, rc, status, reason in (
        (normal, 0, 'collected', 'terminal_cumulative'),
        (lines(start + [dict(type='turn.completed', usage={k: 0 for k in usage})]),
         0, 'collected', 'zero_unverified'),
        (lines(start + [failed]), 0, 'collected', 'execution_failed'),
        (lines(start), 0, 'collected', 'missing_terminal'),
        (lines(start + [failed]), 7, 'collected', 'process_failed'),
        (lines(start), 255, 'collected', 'process_failed'),
        (normal, 7, 'invalid_input', None),  # completed contradicts process failure
        (b'{"error":"' + canary.encode(), 0, 'invalid_input', None),
        (b'\xff', 9, 'invalid_input', None),
        (b'', 0, 'invalid_input', None)):
    run(echo % rc, raw, rc, status, reason)

run('import sys,os,signal; sys.stdout.buffer.write(sys.stdin.buffer.read()); '
    'sys.stdout.buffer.flush(); os.kill(os.getpid(),signal.SIGTERM)',
    lines(start), -signal.SIGTERM, reason='process_failed')
run('import os,signal; os.kill(os.getpid(),signal.SIGTERM)',
    rc=-signal.SIGTERM, status='invalid_input', reason=None)
# Child stderr can exceed a pipe capacity; it is never captured or reflected.
run('import os,sys; os.write(2, (' + repr(canary) + '.encode()+b"x"*65536)*64); '
    'sys.stdout.buffer.write(sys.stdin.buffer.read())', normal)
run('raise RuntimeError(' + repr(canary) + ')', rc=1, status='invalid_input', reason=None)
run('import sys; assert sys.argv[1] == ' + repr(canary + ';$(false)') + '; '
    'sys.stdout.buffer.write(sys.stdin.buffer.read())', normal, extra=(canary + ';$(false)',))

# Exact real capture boundary uses blank lines within the existing parser limits.
limit = helper.MAX_CAPTURE_BYTES
assert limit == extractor.MAX_INPUT_BYTES == 16 * 1024 * 1024
assert helper.CHUNK_BYTES == 65536
remaining = limit - len(normal)
blank = b' ' * (extractor.MAX_LINE_BYTES - 1) + b'\n'
boundary = normal + blank * (remaining // len(blank)) + b' ' * (remaining % len(blank))
run(echo % 0, boundary)
for rc in (0, 11):
    run(echo % rc, boundary + b' ', rc, 'capture_limit_exceeded', None)
# Finite interleaved streams continue far beyond the cap. A stop-reading bug
# blocks child completion and is caught by the fixture's outer timeout.
run('import os,sys; '
    '[ (os.write(1,b"x"*65536),os.write(2,' + repr(canary) + '.encode()*2048)) '
    'for _ in range(320)]; sys.exit(13)', rc=13, status='capture_limit_exceeded', reason=None)

# API launch count/options and EOF -> wait -> parser ordering are observable.
class Stream(io.BytesIO):
    eof = False
    def read(self, size):
        assert size == 65536
        value = super().read(size)
        if not value:
            self.eof = True
        return value


class Child:
    def __init__(self, data, rc=0):
        self.stdout, self.rc, self.waited = Stream(data), rc, False
    def wait(self):
        assert self.stdout.eof and self.stdout.closed
        self.waited = True
        return self.rc


child = Child(normal)
calls = []
def parser(data, context):
    assert child.waited and data == normal
    calls.append(json.loads(context))
    return extractor.extract(data, context)


argv = python_child + [canary]
with patch.object(helper.subprocess, 'Popen', return_value=child) as launch, \
     patch('builtins.open', side_effect=AssertionError('unexpected persistence')):
    check_record(helper.supervise(argv, parser, extractor.validate_result),
                 0, 'collected', 'terminal_cumulative')
    launch.assert_called_once_with(argv, shell=False, stdin=None, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, bufsize=0)
assert calls == [dict(schema='codex-exec-usage-context', version=1,
                     mode='fresh_exec', process_outcome='success')]

for rc in (0, 4, -signal.SIGTERM):
    for malformed in (None, {}, canary.encode(), b'{}', b'x' * 4097,
                      extractor.extract(normal, json.dumps(calls[0]).encode()) + b'\n'):
        with patch.object(helper.subprocess, 'Popen', return_value=Child(normal, rc)):
            check_record(helper.supervise(argv, lambda *_: malformed, extractor.validate_result),
                         rc, 'invalid_input')
    def broken(*_):
        raise RuntimeError(canary)
    with patch.object(helper.subprocess, 'Popen', return_value=Child(normal, rc)):
        check_record(helper.supervise(argv, broken, extractor.validate_result), rc, 'invalid_input')
with patch.object(helper.subprocess, 'Popen', return_value=Child(boundary + b' ')), \
     patch.object(extractor, 'extract', side_effect=AssertionError('limit called parser')):
    check_record(helper.supervise(argv, extractor.extract, extractor.validate_result),
                 0, 'capture_limit_exceeded')

# No child on invalid invocation; failures never expose path/argv/error text.
for invalid in ([], (), 'string', [canary], [1], ['/bin/echo', '\0' + canary],
                ['/bin/echo', '\ud800'], ['/bin/echo'] + ['x'] * 128,
                ['/bin/echo', 'x' * 65537], ['/bin/echo', '\U0001f600' * 16384]):
    with patch.object(helper.subprocess, 'Popen') as launch:
        try:
            helper.supervise(invalid, extractor.extract, extractor.validate_result)
        except (ValueError, UnicodeError):
            pass
        else:
            raise AssertionError('invalid argv accepted')
        launch.assert_not_called()
assert helper.validate_argv(['/bin/echo', 'x' * (65536 - len('/bin/echo'))])
assert len(helper.validate_argv(['/bin/echo'] + [''] * 127)) == 128
with patch.object(helper.subprocess, 'Popen', side_effect=OSError(canary)) as launch:
    check_record(helper.supervise(argv, extractor.extract, extractor.validate_result),
                 None, 'execution_not_started')
    assert launch.call_count == 1
for invalid_args in ([], ['--unknown', canary], ['--extractor', canary, '--', '/bin/echo'],
                     ['--extractor', str(extractor_source), '--', 'relative-' + canary],
                     ['--extractor', str(extractor_source), '--']):
    result = subprocess.run(command[:3] + invalid_args, input=normal,
                            capture_output=True, timeout=15)
    assert result.returncode == 2 and not result.stdout
    assert result.stderr == 'stream収集を拒否しました: invalid_arguments\n'.encode()

with tempfile.TemporaryDirectory(prefix='supervisor-761-') as directory:
    scratch = Path(directory)
    missing = scratch / canary
    for argv in ([str(missing)], [str(scratch)]):
        result = subprocess.run(command + argv, capture_output=True, timeout=15)
        assert result.returncode == 2 and not result.stderr
        check_record(result.stdout, None, 'execution_not_started')
    # Caller cwd/env are inherited. CLI without -B still leaves no bytecode.
    child_code = ('import os,sys; assert os.getcwd()==sys.argv[1]; '
                  'assert os.environ["SUPERVISOR_FIXTURE"]==sys.argv[2]; '
                  'sys.stdout.buffer.write(sys.stdin.buffer.read())')
    result = subprocess.run([sys.executable, str(source), '--extractor', str(extractor_source), '--']
                            + python_child + [child_code, str(scratch), canary],
                            cwd=scratch, env={**os.environ, 'SUPERVISOR_FIXTURE': canary},
                            input=normal, capture_output=True, timeout=15)
    assert result.returncode == 0 and not result.stderr
    check_record(result.stdout, 0, 'collected', 'terminal_cumulative')
    assert not list(scratch.iterdir()), 'supervisor saved state/raw output'
    for contents in (None, 'raise RuntimeError(' + repr(canary) + ')\n', 'extract = None\n'):
        path = scratch / extractor_source.name
        if contents is not None:
            path.write_text(contents)
        result = subprocess.run(command[:4] + [str(path), '--'] + python_child + ['assert False'],
                                capture_output=True, timeout=15)
        assert result.returncode == 2 and not result.stderr
        check_record(result.stdout, None, 'execution_not_started')
        assert not (scratch / '__pycache__').exists()

# Closed stdlib/process surface: no communicate(raw accumulation), shell, env
# injection, extra process launcher, timeout, signal or persistence API.
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import importlib.util', 'import json', 'import os', 'import subprocess', 'import sys'}
launches = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
            and ast.unparse(n.func) == 'subprocess.Popen']
assert len(launches) == 1
assert {k.arg for k in launches[0].keywords} == {'shell', 'stdin', 'stdout', 'stderr', 'bufsize'}
assert not any(isinstance(n, ast.Call) and ast.unparse(n.func) in (
    'open', 'exec', 'eval', 'os.system', 'subprocess.run', 'subprocess.call',
    'child.communicate', 'child.kill', 'child.terminate') for n in ast.walk(tree))
print('Codex stream supervisor: bounded capture/drain/outcome/stdin/single child/non-reflection/prepared PASS')
PY
