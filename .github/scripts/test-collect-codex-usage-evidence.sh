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
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

repo = Path(sys.argv[1])
source = repo / '.github/scripts/collect-codex-usage-evidence.py'
spec = importlib.util.spec_from_file_location('collector', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
canary = 'secretless collector raw canary'
identity = dict(schema='codex-usage-evidence-identity', version=1,
                repository='suzukure/nssscdl', run_id=37304766026, run_attempt=2,
                issue_number=796, job='develop-from-issue', pr_number=None,
                base_sha='3e3b3be40bf6208404c7f4f4c16eb4ee8d23eb2c',
                selected_model='gpt-6.1-sol', cli_version='0.159.3',
                reasoning_effort='medium', invocation_mode='fresh_exec')


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(',', ':'), allow_nan=False).encode('ascii')


builder = helper.load_sibling(helper.BUILDER_NAME)
selector = helper.load_sibling(helper.SELECTOR_NAME)
extractor = selector.load_stream_validator().__globals__['load_validator']().__globals__['extract']
context = dict(schema='codex-exec-usage-context', version=1,
               mode='fresh_exec', process_outcome='success')
events = b'\n'.join(encoded(e) for e in (
    dict(type='thread.started', thread_id='synthetic'), dict(type='turn.started'),
    dict(type='item.completed', item={'text': canary}),
    dict(type='turn.completed', usage=dict(input_tokens=9, cached_input_tokens=2,
         cache_write_input_tokens=1, output_tokens=4, reasoning_output_tokens=3))))
record = dict(schema='codex-exec-stream', version=1, process_returncode=0,
              collection_status='collected', usage_result=json.loads(extractor(events, encoded(context))))
raw = encoded(record)
journal = canary.encode() + b'\n' + events + b'\n' + raw + b'\n'
real_popen = subprocess.Popen
limit = 16 * 1024 * 1024
assert selector.MAX_JOURNAL_BYTES == limit


def child(body):
    # Secretless finite stand-in only. The helper's actual command is asserted
    # before interception; journalctl and external services are never contacted.
    return 'import os,sys,time\n' + body


def exercise(body, status, value=identity, timeout=helper.ACQUISITION_SECONDS):
    processes, calls = [], []
    def launch(args, **kwargs):
        calls.append((args, kwargs))
        prefix = 'codex-developer' if value['job'] == 'develop-from-issue' else 'codex-followup'
        assert args == ['/usr/bin/journalctl',
                        f"--unit={prefix}-{value['run_id']}-{value['run_attempt']}",
                        '--no-pager', '--output=cat', '--quiet']
        assert kwargs == dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, shell=False)
        process = real_popen([sys.executable, '-B', '-c', child(body)], **kwargs)
        processes.append(process)
        return process
    output = io.StringIO()
    with patch.object(helper.subprocess, 'Popen', side_effect=launch), \
         patch.object(helper, 'ACQUISITION_SECONDS', timeout), \
         contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        result = helper.collect(encoded(value))
    assert len(calls) == 1 and not output.getvalue()
    assert processes[0].poll() is not None and processes[0].stdout.closed
    assert result == encoded(json.loads(result)) and b'\n' not in result
    evidence = json.loads(result)
    assert evidence['identity'] == value and evidence['evidence_status'] == status
    assert evidence['billing_status'] == 'unverified'
    assert canary.encode() not in result and events not in result
    if status != 'recorded':
        assert evidence['stream_result'] is None
    return result


for value in (identity, {**identity, 'job': 'respond-to-claude', 'pr_number': 801}):
    result = exercise(f'sys.stdout.buffer.write({journal!r})\n'
                      f'sys.stderr.write({canary!r})', 'recorded', value)
    assert result == builder.build(encoded(value), raw)
    assert json.loads(result)['stream_result'] == record
for data in (b'', canary.encode(), b'\xff diagnostics\n', events):
    exercise(f'sys.stdout.buffer.write({data!r})', 'missing')
for outcome in ('failed', 'cancelled', 'unknown'):
    unavailable = json.loads(extractor(b'\n'.join(events.split(b'\n')[:2]),
                             encoded({**context, 'process_outcome': outcome})))
    data = encoded({**record, 'usage_result': unavailable})
    result = exercise(f'sys.stdout.buffer.write({data!r})', 'recorded')
    assert json.loads(result)['stream_result']['usage_result']['usage'] is None
for data in (b'{broken ' + canary.encode(), raw + b'\n' + raw, raw + b'\n{',
             raw.replace(b'"version":1', b'"version":2')):
    exercise(f'sys.stdout.buffer.write({data!r})', 'invalid')
exercise(f'sys.stdout.buffer.write({raw!r})\nsys.exit(7)', 'invalid')
exercise(f'sys.stderr.write({canary!r})\ntime.sleep(2)', 'invalid', timeout=0.1)
# EOF without process completion and a valid prefix followed by a stalled writer
# must both be invalid, never recorded from a partial journal.
exercise('os.close(1)\ntime.sleep(2)', 'invalid', timeout=0.1)
exercise(f'sys.stdout.buffer.write({raw!r})\nsys.stdout.buffer.flush()\ntime.sleep(2)',
         'invalid', timeout=0.1)
for size in (limit - 1, limit, limit + 1):
    body = (f'sys.stdout.buffer.write(b"x" * ({size} - {len(raw)} - 1) + b"\\n" + {raw!r})')
    exercise(body, 'recorded' if size <= limit else 'invalid')
# Overflow after a valid candidate cannot be truncated and accepted.
exercise(f'sys.stdout.buffer.write({raw!r} + b"\\n" + b"x" * {limit})', 'invalid')

for failure in (FileNotFoundError(canary), PermissionError(canary), OSError(canary)):
    with patch.object(helper.subprocess, 'Popen', side_effect=failure) as launch:
        result = helper.collect(encoded(identity))
        assert result == builder.build(encoded(identity), b'invalid')
        assert canary.encode() not in result
        launch.assert_called_once()


def rejected(data, reason):
    with patch.object(helper.subprocess, 'Popen', side_effect=AssertionError('acquisition before validation')):
        try:
            helper.collect(data)
        except ValueError as error:
            assert error.args == (reason,)
            assert error.__cause__ is None and error.__context__ is None
        else:
            raise AssertionError('invalid input accepted')


for data in (b'', canary.encode(), encoded({**identity, 'unit': canary}),
             encoded({**identity, 'path': canary}), encoded({**identity, 'command': canary}),
             encoded({**identity, 'job': canary}), encoded({**identity, 'run_id': canary}),
             encoded(identity) + b' ' * 4097):
    rejected(data, 'invalid_identity')

# Exact source dependencies, including transitive siblings, no search/cache.
names = {helper.SELECTOR_NAME, helper.BUILDER_NAME, helper.IDENTITY_NAME,
         'validate-codex-usage-stream.py', 'extract-codex-exec-usage.py'}
original_source = importlib.machinery.SourceFileLoader.get_source
seen = set()
def observe(loader, name):
    path = Path(loader.path)
    assert path.parent == source.parent and path.name in names
    seen.add(path.name)
    return original_source(loader, name)
with patch('importlib.machinery.SourceFileLoader.get_source', observe), \
     patch('importlib.machinery.SourceFileLoader.set_data', side_effect=AssertionError('cache write')), \
     patch('builtins.open', side_effect=AssertionError('raw file write')), \
     patch.object(Path, 'write_bytes', side_effect=AssertionError('raw file write')), \
     patch.object(Path, 'write_text', side_effect=AssertionError('raw file write')), \
     patch.object(helper, '_acquire', return_value=journal):
    assert helper.collect(encoded(identity)) == builder.build(encoded(identity), raw)
assert seen == names
for dependency in names:
    def missing(loader, name):
        if Path(loader.path).name == dependency:
            raise FileNotFoundError(canary)
        return original_source(loader, name)
    with patch('importlib.machinery.SourceFileLoader.get_source', missing):
        rejected(encoded(identity), 'validator_unavailable')
for name in ('arbitrary.py', '../candidate.py', '/candidate.py'):
    try:
        helper.load_sibling(name)
    except ValueError as error:
        assert error.args == ('validator_unavailable',)
    else:
        raise AssertionError('arbitrary loader accepted')


def cli(data, args=(), failure=None):
    stdin, stdout, stderr = io.BytesIO(data), io.BytesIO(), io.StringIO()
    with patch.object(sys, 'argv', ['collector', *args]), \
         patch.object(sys, 'stdin', SimpleNamespace(buffer=stdin)), \
         patch.object(sys, 'stdout', SimpleNamespace(buffer=stdout)), \
         contextlib.redirect_stderr(stderr), \
         patch.object(stdin, 'read', wraps=stdin.read) as read, \
         patch.object(helper, '_acquire', side_effect=failure, return_value=journal):
        rc = helper.main()
        if not args:
            read.assert_called_once_with(4097)
        else:
            read.assert_not_called()
    assert canary not in stderr.getvalue() and canary.encode() not in stdout.getvalue()
    return rc, stdout.getvalue(), stderr.getvalue()


assert cli(encoded(identity)) == (0, builder.build(encoded(identity), raw) + b'\n', '')
for args in (['--unit', canary], ['--identity', canary], ['--command', canary], [canary]):
    assert cli(b'', args) == (2, b'', 'usage evidence収集を拒否しました: invalid_arguments\n')
assert cli(b'bad') == (1, b'', 'usage evidence収集を拒否しました: invalid_identity\n')
assert cli(encoded(identity), failure=RuntimeError(canary)) == (
    1, b'', 'usage evidence収集を拒否しました: collection_unavailable\n')
# Identity byte MAX/MAX+1 boundary is delegated to #780.
padded = encoded(identity) + b' ' * (4096 - len(encoded(identity)))
assert cli(padded)[0] == 0
assert cli(padded + b' ')[0:2] == (1, b'')

# Real CLI rejects path/unit/command input and missing fixed dependencies without
# exposing raw input; isolated directory contains source code only, never data.
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    copied = root / source.name
    copied.write_bytes(source.read_bytes())
    before = sorted(root.iterdir())
    for args in ([], ['--unit', canary], ['--path', canary], ['--command', canary]):
        run = subprocess.run([sys.executable, '-B', str(copied), *args],
                             input=encoded(identity), capture_output=True, cwd=root)
        assert run.returncode == (2 if args else 1) and not run.stdout
        assert canary.encode() not in run.stderr and str(root).encode() not in run.stderr
    assert sorted(root.iterdir()) == before

# Closed surface: no raw-file/network/env lookup, arbitrary executable, or
# unbounded communicate/read; all output writes are the canonical CLI record.
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import importlib.util', 'import os', 'from pathlib import Path', 'import selectors',
    'import subprocess', 'import sys', 'import time'}
allowed = {'ValueError', 'Path', 'Path(__file__).with_name',
           'importlib.util.spec_from_file_location', 'importlib.util.module_from_spec',
           'spec.loader.get_source', 'exec', 'compile', 'time.monotonic', 'subprocess.Popen',
           'bytearray', 'selectors.DefaultSelector', 'readiness.register', 'readiness.select',
           'os.read', 'process.stdout.fileno', 'min', 'len', 'data.extend', 'process.wait',
           'bytes', 'process.poll', 'process.kill', 'process.stdout.close', 'load_sibling',
           'validator', 'type', 'selector.load_stream_validator', 'selector.load_stream_validator()',
           'builder.load_identity_validator', 'builder.load_stream_validator', '_acquire',
           'selector.select_stream', 'builder.build', 'print', 'sys.stdin.buffer.read',
           'collect', 'sys.stdout.buffer.write', 'main', 'sys.exit'}
assert all(ast.unparse(n.func) in allowed for n in ast.walk(tree) if isinstance(n, ast.Call))
print('Codex usage collector: exact units / bounded EOF / failures / unknown != 0 / no raw storage / fixed loaders PASS')
PY
