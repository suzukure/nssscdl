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
source = repo / '.github/scripts/build-codex-usage-evidence.py'
spec = importlib.util.spec_from_file_location('evidence', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
identity_validator = helper.load_identity_validator()
stream_validator = helper.load_stream_validator()
canary = 'secretless evidence canary'
identity = dict(schema='codex-usage-evidence-identity', version=1,
                repository='suzukure/nssscdl', run_id=37268676016, run_attempt=1,
                issue_number=782, job='develop-from-issue', pr_number=None,
                base_sha='c2982f9649528c30d1643b4a8489b8366c00a82a',
                selected_model='gpt-6.1-sol', cli_version='0.159.3',
                reasoning_effort='medium', invocation_mode='fresh_exec')


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(',', ':'), allow_nan=False).encode('ascii')


# Consume the real extractor API; usage internals remain its sole schema.
extractor = stream_validator.__globals__['load_validator']().__globals__['extract']
events = b'\n'.join(encoded(event) for event in (
    dict(type='thread.started', thread_id='synthetic'), dict(type='turn.started'),
    dict(type='turn.completed', usage=dict(input_tokens=9, cached_input_tokens=2,
         cache_write_input_tokens=1, output_tokens=4, reasoning_output_tokens=3))))
context = dict(schema='codex-exec-usage-context', version=1,
               mode='fresh_exec', process_outcome='success')
usage = json.loads(extractor(events, encoded(context)))
unavailable = json.loads(extractor(events.split(b'\n')[0] + b'\n' + events.split(b'\n')[1],
                                   encoded({**context, 'process_outcome': 'failed'})))
record = dict(schema='codex-exec-stream', version=1, process_returncode=0,
              collection_status='collected', usage_result=usage)
raw_identity, raw_stream = encoded(identity), encoded(record)


def check(data=raw_stream, identity_data=raw_identity):
    first = helper.build(identity_data, data)
    assert type(first) is bytes and first == helper.build(identity_data, data)
    assert first == encoded(json.loads(first)) and len(first) <= 8192 and b'\n' not in first
    value = json.loads(first)
    expected = dict(schema='codex-usage-evidence', version=1,
                    identity=identity_validator(identity_data),
                    source='codex_exec_jsonl_workload_reported', billing_status='unverified',
                    **stream_validator(data))
    assert value == expected and set(value) == set(expected)
    assert set(value['identity']) == set(identity)
    assert canary not in first.decode()
    return first


def rejected(identity_data, data, reason):
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            helper.build(identity_data, data)
        except Exception as error:
            assert type(error) is ValueError and error.args == (reason,)
            assert error.__cause__ is None and error.__context__ is None
            assert canary not in repr(error)
        else:
            raise AssertionError('failed build accepted')
    assert not output.getvalue()


check()
check(raw_stream + b'\n')
check(identity_data=json.dumps(dict(reversed(list(identity.items()))), indent=2).encode())
check(identity_data=encoded({**identity, 'job': 'respond-to-claude', 'pr_number': 787}))
for stream in (
        {**record, 'usage_result': unavailable},  # rc0 + process_failed stays recorded.
        {**record, 'process_returncode': 2, 'usage_result': unavailable},
        {**record, 'collection_status': 'capture_limit_exceeded', 'usage_result': None},
        {**record, 'collection_status': 'invalid_input', 'process_returncode': 2, 'usage_result': None},
        {**record, 'collection_status': 'execution_not_started',
         'process_returncode': None, 'usage_result': None}):
    result = json.loads(check(encoded(stream)))
    assert result['evidence_status'] == 'recorded' and result['stream_result'] == stream
    assert result['billing_status'] == 'unverified'
for data, status in ((b'', 'missing'), (canary.encode(), 'invalid'),
                     (encoded({**record, 'process_returncode': 2}), 'invalid'),
                     (raw_stream + b'\n\n', 'invalid'), (b'x' * 4097, 'invalid')):
    value = json.loads(check(data))
    assert value['evidence_status'] == status and value['stream_result'] is None
    assert value['billing_status'] == 'unverified'
for data in (b'', canary.encode(), None, raw_identity + b' ' * 4097):
    rejected(data, raw_stream, 'invalid_identity')

# Verify ordering, real return-object use and fixed, unchained dependency errors.
order = []
validated_identity = identity_validator(raw_identity)
validated_stream = stream_validator(raw_stream)
def validate_identity(data):
    order.append('identity')
    assert data == raw_identity
    return validated_identity
def validate_stream(data):
    order.append('stream')
    assert data == raw_stream
    return validated_stream
with patch.object(helper, 'load_identity_validator', return_value=validate_identity), \
     patch.object(helper, 'load_stream_validator', return_value=validate_stream):
    value = json.loads(helper.build(raw_identity, raw_stream))
    assert value['identity'] == validated_identity and value['stream_result'] == validated_stream['stream_result']
assert order == ['identity', 'stream']
with patch.object(helper, 'load_stream_validator', side_effect=AssertionError('stream called first')):
    rejected(b'bad', raw_stream, 'invalid_identity')
for loader in ('load_identity_validator', 'load_stream_validator'):
    for failure in (RuntimeError(canary), ValueError(canary)):
        with patch.object(helper, loader, side_effect=failure):
            rejected(raw_identity, b'', 'validator_unavailable')
        with patch.object(helper, loader, return_value=lambda data: (_ for _ in ()).throw(failure)):
            rejected(raw_identity, raw_stream, 'validator_unavailable')
    for broken in (None, [], {'evidence_status': 'recorded'},
                   {'evidence_status': 'missing', 'stream_result': {}},
                   {'evidence_status': 'recorded', 'stream_result': None},
                   {'evidence_status': canary, 'stream_result': None}):
        if loader == 'load_identity_validator' and type(broken) is dict:
            continue  # Identity schema belongs only to #780.
        with patch.object(helper, loader, return_value=lambda data: broken):
            rejected(raw_identity, raw_stream, 'validator_unavailable')
for failure in (FileNotFoundError(canary), ImportError(canary), SyntaxError(canary)):
    with patch.object(helper.importlib.util, 'spec_from_file_location', side_effect=failure):
        rejected(raw_identity, raw_stream, 'validator_unavailable')
for body in ('raise RuntimeError("secretless evidence canary")',
             'validate_identity = None\nvalidate_stream = None'):
    with patch('importlib.machinery.SourceFileLoader.get_source', return_value=body):
        rejected(raw_identity, raw_stream, 'validator_unavailable')
with patch.object(helper.json, 'dumps', side_effect=ValueError(canary)), \
     patch.object(helper, 'load_identity_validator', return_value=lambda data: validated_identity), \
     patch.object(helper, 'load_stream_validator', return_value=lambda data: validated_stream):
    rejected(raw_identity, raw_stream, 'validator_unavailable')

# Exercise the real fixed output cap at 8192 and 8193, using a synthetic validator
# output only to reach sizes the real closed schemas cannot currently produce.
assert helper.MAX_OUTPUT_BYTES == 8192 and helper.MAX_INPUT_BYTES == 4096
with patch.object(helper, 'load_stream_validator', return_value=lambda data: validated_stream):
    original = validated_stream['stream_result']
    validated_stream['stream_result'] = {'padding': ''}
    overhead = len(helper.build(raw_identity, raw_stream))
    validated_stream['stream_result']['padding'] = 'x' * (8192 - overhead)
    assert len(helper.build(raw_identity, raw_stream)) == 8192
    validated_stream['stream_result']['padding'] += 'x'
    rejected(raw_identity, raw_stream, 'invalid_evidence')
    validated_stream['stream_result'] = original

def diagnostic(reason):
    return ('usage evidenceの組み立てを拒否しました: ' + reason + '\n').encode()


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    identity_file = root / canary
    identity_file.write_bytes(raw_identity)
    command = [sys.executable, '-B', str(source), '--identity', str(identity_file)]
    for data in (raw_stream, b'', canary.encode(), b'x' * 4097):
        run = subprocess.run(command, input=data, capture_output=True, cwd=root)
        assert run.returncode == 0 and not run.stderr
        assert run.stdout == helper.build(raw_identity, data) + b'\n'
        assert run.stdout.count(b'\n') == 1 and canary.encode() not in run.stdout
    exact_identity = raw_identity + b' ' * (4096 - len(raw_identity))
    for data, rc, reason in ((exact_identity, 0, None),
                            (exact_identity + b' ', 1, 'invalid_identity'),
                            (canary.encode(), 1, 'invalid_identity')):
        identity_file.write_bytes(data)
        run = subprocess.run(command, input=raw_stream, capture_output=True)
        assert run.returncode == rc
        if reason:
            assert not run.stdout and run.stderr == diagnostic(reason)
        else:
            assert run.stdout == check() + b'\n' and not run.stderr
    for args, rc, reason in (([], 2, 'invalid_arguments'),
                            (['--wrong', canary], 2, 'invalid_arguments'),
                            (['--identity', canary, canary], 2, 'invalid_arguments'),
                            (['--identity', str(root / 'absent')], 1, 'input_unavailable'),
                            (['--identity', str(root)], 1, 'input_unavailable')):
        run = subprocess.run(command[:3] + args, input=b'', capture_output=True)
        assert run.returncode == rc and not run.stdout and run.stderr == diagnostic(reason)
    assert sorted(path.name for path in root.iterdir()) == [canary], 'CLI wrote state/cache'

    # Real CLI dependency failures, including stream -> extractor, remain fatal
    # even for missing/invalid streams; no fallback record or raw path leaks.
    isolated = root / 'modules'
    isolated.mkdir()
    copied_source = isolated / source.name
    copied_source.write_bytes(source.read_bytes())
    identity_file.write_bytes(raw_identity)
    isolated_command = [sys.executable, '-B', str(copied_source), '--identity', str(identity_file)]
    for dependency in (helper.IDENTITY_NAME, helper.STREAM_NAME, 'extract-codex-exec-usage.py'):
        for data in (raw_stream, b'', canary.encode()):
            run = subprocess.run(isolated_command, input=data, capture_output=True)
            assert run.returncode == 1 and not run.stdout
            assert run.stderr == diagnostic('validator_unavailable')
        (isolated / dependency).write_bytes((source.parent / dependency).read_bytes())
    run = subprocess.run(isolated_command, input=raw_stream, capture_output=True)
    assert run.returncode == 0 and run.stdout == check() + b'\n' and not run.stderr
    assert not list(isolated.glob('__pycache__')), 'module loader wrote cache'

# Bound reads are observable; no extra read/drain or record on API failure.
def main_fixture(data=raw_stream, identity_data=raw_identity, failure=None, stdout_failure=False):
    stdin = io.BytesIO(data)
    file_stream = io.BytesIO(identity_data)
    stdout, stderr = io.BytesIO(), io.StringIO()
    with patch.object(sys, 'argv', ['builder', '--identity', canary]), \
         patch.object(sys, 'stdin', SimpleNamespace(buffer=stdin)), \
         patch.object(sys, 'stdout', SimpleNamespace(buffer=stdout)), \
         contextlib.redirect_stderr(stderr), \
         patch('builtins.open', return_value=file_stream), \
         patch.object(file_stream, 'read', wraps=file_stream.read) as file_read, \
         patch.object(stdin, 'read', wraps=stdin.read) as stdin_read, \
         patch.object(helper, 'build', side_effect=failure, wraps=helper.build), \
         patch.object(stdout, 'write', side_effect=OSError(canary) if stdout_failure else None,
                      wraps=stdout.write):
        rc = helper.main()
        file_read.assert_called_once_with(4097)
        stdin_read.assert_called_once_with(4097)
    return rc, stdout.getvalue(), stderr.getvalue().encode()

assert main_fixture() == (0, check() + b'\n', b'')
for reason in ('invalid_identity', 'validator_unavailable', 'invalid_evidence'):
    assert main_fixture(failure=ValueError(reason)) == (1, b'', diagnostic(reason))
assert main_fixture(stdout_failure=True) == (1, b'', diagnostic('invalid_evidence'))

# Closed source surface: file reads only in CLI, exact sibling source loaders,
# no environment/network/subprocess/state writes or arbitrary import path.
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import importlib.util', 'import json', 'from pathlib import Path', 'import sys'}
allowed_calls = {'Path', 'Path(__file__).with_name', 'importlib.util.spec_from_file_location',
                 'importlib.util.module_from_spec', 'spec.loader.get_source', 'exec', 'compile',
                 'callable', 'ValueError', 'load_identity_validator', 'identity_validator',
                 'load_stream_validator', 'load_stream_validator()', 'type', 'set', 'dict',
                 'json.dumps', "json.dumps(record, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode",
                 'len', 'diagnostic', 'print', 'open', 'stream.read', 'sys.stdin.buffer.read',
                 'build', 'sys.stdout.buffer.write', 'main', 'sys.exit'}
assert all(ast.unparse(n.func) in allowed_calls for n in ast.walk(tree) if isinstance(n, ast.Call))
for function in (n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name != 'main'):
    assert not any(isinstance(n, ast.Call) and ast.unparse(n.func) in
                   {'open', 'stream.read', 'sys.stdin.buffer.read', 'sys.stdout.buffer.write'}
                   for n in ast.walk(function))
print('Codex usage evidence: real validators / preservation / canonical / bounds / CLI / fixed non-reflection PASS')
PY
