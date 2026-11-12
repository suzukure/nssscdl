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

repo = Path(sys.argv[1])
source = repo / '.github/scripts/select-codex-usage-journal.py'
spec = importlib.util.spec_from_file_location('journal_selector', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
validator = helper.load_stream_validator()
# Real extractor owns usage shape; no independent schema validator in this test.
extractor_path = source.with_name('extract-codex-exec-usage.py')
spec = importlib.util.spec_from_file_location('extractor', extractor_path)
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)
canary = b'secretless journal canary'


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(',', ':'), allow_nan=False).encode('ascii')


context = dict(schema='codex-exec-usage-context', version=1, mode='fresh_exec',
               process_outcome='success')
events = [dict(type='thread.started', thread_id='synthetic'), dict(type='turn.started'),
          dict(type='turn.completed', usage=dict(input_tokens=9, cached_input_tokens=2,
               cache_write_input_tokens=1, output_tokens=4, reasoning_output_tokens=3))]
jsonl = b'\n'.join(encoded(event) for event in events)
reported = json.loads(extractor.extract(jsonl, encoded(context)))
record = dict(schema='codex-exec-stream', version=1, process_returncode=0,
              collection_status='collected', usage_result=reported)
raw = encoded(record)


def check(journal, expected):
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        first = helper.select_stream(journal)
        assert helper.select_stream(journal) == first == expected, (repr(journal)[:160], first, expected)
    assert not output.getvalue() and canary not in first
    evidence = validator(first)
    status = 'missing' if expected == b'' else 'invalid' if expected == b'invalid' else 'recorded'
    assert evidence['evidence_status'] == status
    if status == 'recorded':
        assert evidence['stream_result'] == json.loads(expected)
    else:
        assert evidence['stream_result'] is None


for data in (raw, raw + b'\n', b'preflight ok\n\n' + raw + b'\ntimeout diagnostic',
             b'\xff non-JSON diagnostic\n' + raw,
             b'{"schema":"other","value":1}\n' + raw + b'\n{}',
             b'{"n":' + b'9' * 5000 + b',"f":1e999}\n' + raw):
    check(data, raw)
for outcome in ('failed', 'cancelled', 'unknown'):
    unavailable = json.loads(extractor.extract(b'\n'.join(encoded(e) for e in events[:2]),
                             encoded({**context, 'process_outcome': outcome})))
    for rc in (-255, -1, 0, 7, 255):
        value = encoded({**record, 'process_returncode': rc, 'usage_result': unavailable})
        check(b'preflight\n' + value + b'\n', value)
for status in ('capture_limit_exceeded', 'invalid_input', 'execution_not_started'):
    value = encoded({**record, 'collection_status': status, 'usage_result': None,
                     'process_returncode': None if status == 'execution_not_started' else 7})
    check(value, value)
for data in (b'', b'\n \t\r\n', b'preflight\ntimeout', canary, b'\xff',
             b'null\n[]\n42\n"text"', b'{"schema":"other"}\n{}'):
    check(data, b'')
for data in (raw + b'\n' + raw, raw + b'\n{}\n' + raw,
             raw + b'\n' + encoded({**record, 'collection_status': 'invalid_input', 'usage_result': None}),
             b'{', b' \t{broken ' + canary, raw + b'\n{', b'{\xff}',
             b'{"schema":"other","x":1,"x":2}', b'{"x":{"a":1,"a":2}}',
             b'{"schema":"other","x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}',
             b'{}{}', b'{} trailing', b'{"x":' + b'[' * 20000 + b'0' + b']' * 20000 + b'}',
             b' ' + raw, b'\t' + raw, raw + b' ', raw + b'\r\n',
             raw.replace(b'"schema"', b'"\\u0073chema"'),
             json.dumps(record, indent=2).encode(),
             raw.replace(b'"version":1', b'"version":2'),
             raw.replace(b'"process_returncode":0', b'"process_returncode":7'),
             raw.replace(b'"input_tokens":9', b'"input_tokens":-1'),
             b'{"schema":"codex-exec-stream","schema":"other"}',
             b'{"schema":"other","\\u0073chema":"codex-exec-stream"}',
             None, raw.decode(), bytearray(raw), memoryview(raw), {}, [], True):
    check(data, b'invalid')

# Delegation passes the original LF-delimited line, without normalization.
calls = []
def observed(data):
    calls.append(data)
    return validator(data)
with patch.object(helper, 'load_stream_validator', return_value=observed):
    check(b'diagnostic\n' + raw + b'\n', raw)
    check(b' ' + raw, b'invalid')
    for size in (4095, 4096, 4097):
        padded = raw + b' ' * (size - len(raw))
        check(padded + b'\n', b'invalid')
        assert calls[-1] == padded
assert calls[:2] == [raw, raw] and calls[2:4] == [b' ' + raw, b' ' + raw]

# Whole journal cap is an API acceptance limit, not acquisition completeness.
limit = 16 * 1024 * 1024
for size in (limit - 1, limit):
    check(b'x' * (size - len(raw) - 1) + b'\n' + raw, raw)
    check(b'x' * size, b'')
check(b'x' * (limit + 1), b'invalid')
check(b'x' * (limit - len(raw)) + b'\n' + raw, b'invalid')
check(b'{"schema":"codex-exec-stream","x":"' + b'x' * 5000 + b'"}', b'invalid')

# Fixed errors never carry paths, input, or an exception chain.
def unavailable(data=raw):
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            helper.select_stream(data)
        except ValueError as error:
            assert error.args == ('validator_unavailable',)
            assert error.__cause__ is None and error.__context__ is None
        else:
            raise AssertionError('dependency failure hidden')
    assert not output.getvalue()

for failure in (FileNotFoundError(canary), ImportError(canary), SyntaxError(canary)):
    with patch.object(helper.importlib.util, 'spec_from_file_location', side_effect=failure):
        for data in (raw, b'', b'bad'):
            unavailable(data)
for body in ('raise RuntimeError("secretless journal canary")', 'validate_stream = None'):
    with patch('importlib.machinery.SourceFileLoader.get_source', return_value=body):
        unavailable()
# Nested extractor dependency errors also remain fixed and unchained.
original_source = importlib.machinery.SourceFileLoader.get_source
def missing_extractor(loader, name):
    if loader.path.endswith('extract-codex-exec-usage.py'):
        raise FileNotFoundError(canary)
    return original_source(loader, name)
with patch('importlib.machinery.SourceFileLoader.get_source', missing_extractor):
    unavailable()
with patch.object(helper, 'load_stream_validator', return_value=lambda data: None):
    unavailable()

# Closed surface permits only the exact source loader and pure selection calls.
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import importlib.util', 'import json', 'from pathlib import Path'}
assert not any(isinstance(n, (ast.If, ast.ClassDef)) for n in tree.body)
allowed = {'Path', 'Path(__file__).with_name', 'importlib.util.spec_from_file_location',
           'importlib.util.module_from_spec', 'spec.loader.get_source', 'exec', 'compile',
           'callable', 'ValueError', 'type', 'len', 'set', 'json.loads', 'line.decode',
           'line.lstrip', "line.lstrip(b' \\t\\r\\x0b\\x0c').startswith", 'value.get',
           'journal_bytes.split', 'load_stream_validator', 'validator'}
assert all(ast.unparse(n.func) in allowed for n in ast.walk(tree) if isinstance(n, ast.Call))
with patch('pathlib.Path.write_bytes', side_effect=AssertionError('state write')), \
     patch('pathlib.Path.write_text', side_effect=AssertionError('state write')), \
     patch('importlib.machinery.SourceFileLoader.set_data', side_effect=AssertionError('cache write')):
    check(raw, raw)
print('Codex journal selection: finite pure / strict / unique / canonical / bounded / delegation / non-reflection PASS')
PY
