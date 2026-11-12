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

source = Path(sys.argv[1]) / '.github/scripts/extract-codex-rollout-usage.py'
spec = importlib.util.spec_from_file_location('rollout_usage', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
canary = 'SECRET_CANARY_1061_response_prompt_tool_path'


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def lines(*records):
    return b'\n'.join(encoded(record) for record in records) + b'\n'


def record(tokens=272001, response_id=canary, **optional):
    return dict(type='token_usage_record', payload=dict(response_id=response_id,
                usage=dict(input_tokens=tokens, **optional)))


def check(data, expected=None, reason='invalid_input'):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), patch(
            'builtins.open', side_effect=AssertionError('unexpected I/O')):
        raw = helper.extract(data)
        assert helper.extract(data) == raw
    assert not out.getvalue() and not err.getvalue()
    assert type(raw) is bytes and len(raw) <= 1024 and canary.encode() not in raw
    result = json.loads(raw)
    assert raw == encoded(dict(sorted(result.items())))
    assert result == dict(schema='codex-rollout-usage', version=1,
        source='codex_0.159.3_rollout_token_usage_record',
        availability='observed' if expected else 'unknown',
        reason='observed_completed' if expected else reason,
        coverage='observed_only', billing_status='unverified',
        recorded_completed_response_count=expected[0] if expected else None,
        max_observed_response_input_tokens=expected[1] if expected else None,
        observed_above_272k_completed_response_count=expected[2] if expected else None)
    assert 'long_context_request_count' not in result


# Issue #1061: strict > 272000, no cumulative-session threshold or USD claim.
check(b'', reason='no_records')
check(b' \t\r\n', reason='no_records')
for tokens, above in ((0, 0), (271999, 0), (272000, 0), (272001, 1)):
    check(lines(record(tokens)), (1, tokens, above))
check(lines(record(271999, 'a'), record(272000, 'b'), record(272001, 'c')),
      (3, 272001, 1))
check(lines(record(200000, 'a'), record(200000, 'b')), (2, 200000, 0))
check(lines(record()).rstrip(b'\n'), (1, 272001, 1))
# Existing exec contract bounds cached/cache-write independently, no sum bound.
check(lines(record(100, cached_input_tokens=70, cache_write_input_tokens=40,
                   output_tokens=20, reasoning_output_tokens=10, total_tokens=120)),
      (1, 100, 0))
for optional in ({}, dict(cached_input_tokens=0), dict(cache_write_input_tokens=0),
                 dict(output_tokens=0, reasoning_output_tokens=0, total_tokens=100)):
    check(lines(record(100, **optional)), (1, 100, 0))
check(lines(record(helper.MAX_TOKENS)), (1, 2**53 - 1, 1))

# Ignore non-adopted rollout metadata and nested token-like fields.
opaque = [dict(type=kind, payload=dict(message=canary, response_id=canary,
          usage=dict(input_tokens=999999))) for kind in
          ('session_meta', 'response_item', 'event_msg', 'turn_context', 'tool', 'prompt')]
check(lines(*opaque), reason='no_records')
check(lines(*opaque, record(10), *opaque), (1, 10, 0))
extra = record(10)
extra.update(timestamp=canary, message=canary)
extra['payload'].update(model=canary, metadata=dict(tool=canary))
check(lines(extra), (1, 10, 0))
check(b'{"type":"event_msg","payload":{"huge":' + b'9' * 5000 + b'}}\n',
      reason='no_records')
check(b'{"type":"event_msg","payload":1e99999}\n', reason='no_records')

# Every failure, including a trailing failure, suppresses ALL partial metrics.
bad = [b'\xff', b'{', b'{"type":"token_usage_record"', b'null', b'[]',
       b'{"type":true}', b'{"type":1}', b'{}',
       b'{"type":"event_msg","x":NaN}',
       b'{"type":"event_msg","type":"event_msg"}',
       lines(dict(type='token_usage_record')), lines(dict(type='token_usage_record', payload=[]))]
for value in (True, False, None, '10', 1.0, -1, 2**53, [], {}):
    bad.append(lines(record(value)))
for response_id in ('', True, None, 1, [], {}, 'x' * 513):
    bad.append(lines(record(response_id=response_id)))
for key in ('cached_input_tokens', 'cache_write_input_tokens', 'output_tokens',
            'reasoning_output_tokens', 'total_tokens'):
    for value in (-1, True, None, '1', 1.5, 2**53):
        bad.append(lines(record(**{key: value})))
for optional in (dict(cached_input_tokens=101), dict(cache_write_input_tokens=101),
                 dict(reasoning_output_tokens=1),
                 dict(output_tokens=2, reasoning_output_tokens=3),
                 dict(total_tokens=100), dict(output_tokens=2, total_tokens=101),
                 dict(unknown=1)):
    bad.append(lines(record(100, **optional)))
bad.extend((lines(record(2**53 - 1, output_tokens=1, total_tokens=2**53 - 1)),
            lines(record(), record()), lines(record(10), record(11)),
            b'{"type":"token_usage_record","payload":{"response_id":"a",'
            b'"usage":{"input_tokens":10,"input_tokens":10}}}',
            lines(record()).replace(b'272001', b'9' * 5000)))
for index, data in enumerate(bad):
    try:
        check(data)
        check(lines(record(response_id='prefix')) + data)
    except AssertionError:
        raise AssertionError(('invalid fixture index', index)) from None
for data in (None, '', bytearray(), 1):
    check(data)

# Actual file/line/record ceilings, including whitespace and ignored records.
check(b' ' * (helper.MAX_INPUT_BYTES + 1))
check(b' ' * helper.MAX_LINE_BYTES, reason='no_records')
check(b' ' * (helper.MAX_LINE_BYTES + 1))
check(b'\n' * helper.MAX_LINES, reason='no_records')
check(b'\n' * (helper.MAX_LINES + 1))
many = lines(*(record(1, str(i)) for i in range(helper.MAX_RECORDS)))
check(many, (4096, 1, 0))
check(many + lines(record(1, 'overflow')))
with patch.object(helper, 'MAX_INPUT_BYTES', len(lines(record()))):
    check(lines(record()), (1, 272001, 1))
    check(lines(record()) + b' ')

# Pure surface has no filesystem / network / subprocess / env / CLI access.
tree = ast.parse(source.read_text())
assert [ast.unparse(n) for n in ast.walk(tree)
        if isinstance(n, (ast.Import, ast.ImportFrom))] == ['import json']
assert not any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in ('open', 'print', 'eval', 'exec', '__import__')
               for n in ast.walk(tree))
print('Codex rollout usage: finite synthetic / boundaries / fail-closed / non-reflection / pure PASS')
PY
