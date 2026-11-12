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
source = repo / '.github/scripts/validate-codex-usage-stream.py'
spec = importlib.util.spec_from_file_location('usage_stream', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
validator = helper.load_validator()
canary = 'secretless stream canary'
usage = dict(schema='codex-exec-usage', version=1,
             source='codex_exec_jsonl_workload_reported', availability='reported',
             reason='terminal_cumulative', usage=dict(input_tokens=9, cached_input_tokens=2,
             cache_write_input_tokens=1, output_tokens=4, reasoning_output_tokens=3))
record = dict(schema='codex-exec-stream', version=1, process_returncode=0,
              collection_status='collected', usage_result=usage)


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(',', ':'), allow_nan=False).encode('ascii')


def check(value=record, raw=None):
    data = encoded(value) if raw is None else raw
    first, second = helper.validate_stream(data), helper.validate_stream(data)
    assert first == second == dict(evidence_status='recorded', stream_result=value)
    assert first is not second and first['stream_result'] is not second['stream_result']
    first['stream_result']['usage_result'] = None
    assert helper.validate_stream(data) == second


def rejected(data):
    result = helper.validate_stream(data)
    assert result == dict(evidence_status='invalid', stream_result=None)
    assert canary not in repr(result)


check()
check(raw=encoded(record) + b'\n')
assert helper.validate_stream(b'') == dict(evidence_status='missing', stream_result=None)
for status in ('capture_limit_exceeded', 'invalid_input'):
    for rc in (-255, -2, -1, 0, 2, 255):
        check({**record, 'collection_status': status, 'process_returncode': rc, 'usage_result': None})
    rejected(encoded({**record, 'collection_status': status}))
check({**record, 'collection_status': 'execution_not_started',
       'process_returncode': None, 'usage_result': None})
for rc in (-255, -1, 0, 2, 255, True):
    rejected(encoded({**record, 'collection_status': 'execution_not_started',
                      'process_returncode': rc, 'usage_result': None}))
rejected(encoded({**record, 'collection_status': 'execution_not_started', 'process_returncode': None}))
for reason in ('process_cancelled', 'process_failed', 'process_unknown',
               'execution_failed', 'missing_terminal', 'zero_unverified'):
    unavailable = {**usage, 'availability': 'unavailable', 'reason': reason, 'usage': None}
    for rc in (-255, -2, 0, 2, 255):
        check({**record, 'process_returncode': rc, 'usage_result': unavailable})
for rc in (-255, -1, 2, 255):
    rejected(encoded({**record, 'process_returncode': rc}))
for status in ('collected', 'capture_limit_exceeded', 'invalid_input'):
    for rc in (None, True, False, -256, 256, 0.0, '0', [], {}):
        rejected(encoded({**record, 'collection_status': status, 'process_returncode': rc,
                          'usage_result': usage if status == 'collected' else None}))
for version in (True, False, 1.0, 0, 2, '1', None):
    rejected(encoded({**record, 'version': version}))
for key in record:
    rejected(encoded({k: v for k, v in record.items() if k != key}))
    for value in (canary, [], {}, True):
        rejected(encoded({**record, key: value}))
    raw = encoded(record)
    rejected(b'{"' + key.encode() + b'":null,' + raw[1:])
    escaped = ('\\u%04x' % ord(key[0]) + key[1:]).encode()
    rejected(b'{"' + escaped + b'":null,' + raw[1:])
rejected(encoded({**record, canary: canary}))

# Usage internals remain the extractor's contract; exercise delegation and its
# returned dict rather than reproducing that validator in this module.
with patch.object(helper, 'load_validator', return_value=validator):
    with patch.object(helper, '_validate', wraps=helper._validate) as validate:
        check()
        assert all(call.args[1] is validator for call in validate.call_args_list)
    calls = []
    def existing_validator(data):
        calls.append(data)
        return validator(data)
    with patch.object(helper, 'load_validator', return_value=existing_validator):
        check()
    assert calls and all(data == encoded(usage) for data in calls)
for bad_usage in (None, {}, {**usage, 'reason': canary}, {**usage, 'extra': canary},
                  {**usage, 'version': True}, {**usage, 'usage': {**usage['usage'], 'input_tokens': -1}},
                  {**usage, 'usage': {**usage['usage'], 'cached_input_tokens': 10}},
                  {**usage, 'usage': {**usage['usage'], 'output_tokens': 2**53}},
                  {**usage, 'usage': dict.fromkeys(usage['usage'], 0)}):
    rejected(encoded({**record, 'usage_result': bad_usage}))
raw = encoded(record)
for data in (None, raw.decode(), bytearray(raw), memoryview(raw), {}, [], True,
             b' ', b'\n', b'{', b'null', b'[]', b'1', b'true', b'"canary"',
             raw + b'{}', raw + b'\nnull', b'\xef\xbb\xbf' + raw, raw + b'\xff',
             raw + b'\n\n', raw + b'\r\n', b' ' + raw, raw + b' ',
             json.dumps(record, indent=2).encode(),
             json.dumps(dict(reversed(list(record.items()))), separators=(',', ':')).encode(),
             raw.replace(b'"schema"', b'"\\u0073chema"'),
             raw.replace(b'codex-exec-stream', b'codex-exec-\\u0073tream'),
             raw.replace(b'"process_returncode":0', b'"process_returncode":-0'),
             b'[' * 1500 + b'0' + b']' * 1500,
             raw.replace(b'"process_returncode":0', b'"process_returncode":' + b'[' * 1200 + b'0' + b']' * 1200)):
    rejected(data)
for constant in (b'NaN', b'Infinity', b'-Infinity', b'1e999', b'1e-999'):
    rejected(raw.replace(b'"process_returncode":0', b'"process_returncode":' + constant))
    rejected(raw.replace(b'"input_tokens":9', b'"input_tokens":' + constant))

# All schema-valid records are smaller than the cap. A 4096-byte padded record
# reaches structural/canonical validation; 4097 fails before JSON parsing.
for lf in (b'', b'\n'):
    exact = raw + b' ' * (4096 - len(raw) - len(lf)) + lf
    with patch.object(helper.json, 'loads', wraps=json.loads) as parse:
        rejected(exact)
        assert parse.call_count == 2  # Outer record + existing usage validator.
    with patch.object(helper.json, 'loads', side_effect=AssertionError('oversize parsed')):
        rejected(exact + b' ')
        rejected(b'x' * 4097)

# No import bytecode, user paths, environment search, CLI or output/state writes.
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import importlib.util', 'import json', 'from pathlib import Path'}
assert not any(isinstance(n, (ast.If, ast.ClassDef)) for n in tree.body)
allowed_calls = {'Path', 'Path(__file__).with_name', 'importlib.util.spec_from_file_location',
                 'importlib.util.module_from_spec', 'spec.loader.get_source', 'exec', 'compile',
                 'callable', 'ValueError', 'require', 'len', 'type', 'set', 'dict',
                 'json.dumps', 'json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(\',\', \':\'), allow_nan=False).encode',
                 'json.loads', 'data.endswith', 'payload.decode', 'validator', 'canonical',
                 'load_validator', '_validate'}
assert all(ast.unparse(n.func) in allowed_calls for n in ast.walk(tree) if isinstance(n, ast.Call))
output = io.StringIO()
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), \
     patch('pathlib.Path.write_bytes', side_effect=AssertionError('state write')), \
     patch('pathlib.Path.write_text', side_effect=AssertionError('state write')):
    check()
    rejected(encoded({**record, 'reason': canary}))
assert output.getvalue() == ''
for failure in (FileNotFoundError(canary), ImportError(canary), SyntaxError(canary)):
    with patch.object(helper.importlib.util, 'spec_from_file_location', side_effect=failure):
        for data in (raw, b'', b'bad'):
            try:
                helper.validate_stream(data)
            except ValueError as error:
                assert error.args == ('validator_unavailable',)
                assert error.__cause__ is None and error.__context__ is None
            else:
                raise AssertionError('validator failure hidden')
for body in ('raise RuntimeError("secretless stream canary")', 'validate_result = None'):
    with patch('importlib.machinery.SourceFileLoader.get_source', return_value=body):
        try:
            helper.validate_stream(raw)
        except ValueError as error:
            assert error.args == ('validator_unavailable',) and error.__context__ is None
        else:
            raise AssertionError('bad import accepted')
print('Codex usage stream: pure / canonical / bounded / unknown classification / delegation / non-reflection PASS')
PY
