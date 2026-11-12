#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

repo = Path(sys.argv[1])
source = repo / '.github/scripts/extract-codex-exec-usage.py'
spec = importlib.util.spec_from_file_location('exec_usage', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
canary = 'SECRET_CANARY_753_prompt_command_error'
context = dict(schema='codex-exec-usage-context', version=1,
               mode='fresh_exec', process_outcome='success')
usage = dict(input_tokens=100, cached_input_tokens=70, cache_write_input_tokens=40,
             output_tokens=20, reasoning_output_tokens=10)
start = [dict(type='thread.started', thread_id=canary), dict(type='turn.started')]
completed = dict(type='turn.completed', usage=usage)
failed = dict(type='turn.failed', error=dict(message=canary))
error = dict(type='error', message=canary)
normal = start + [completed]


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()


def lines(events):
    return b'\n'.join(encoded(event) for event in events) + b'\n'


def expected(reason='terminal_cumulative', tokens=usage):
    reported = reason == 'terminal_cumulative'
    return dict(schema='codex-exec-usage', version=1,
                source='codex_exec_jsonl_workload_reported',
                availability='reported' if reported else 'unavailable', reason=reason,
                usage=tokens if reported else None)


def check(events=normal, c=context, want=None, raw=None, raw_context=None):
    result = helper.extract(lines(events) if raw is None else raw,
                            encoded(c) if raw_context is None else raw_context)
    want = expected() if want is None else want
    assert type(result) is bytes and json.loads(result) == want
    assert result == encoded_canonical(want)
    assert helper.validate_result(result) == want
    assert len(result) <= 1024 and b'\n' not in result
    assert canary.encode() not in result
    return result


def encoded_canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def rejected(events=normal, c=context, raw=None, raw_context=None):
    try:
        helper.extract(lines(events) if raw is None else raw,
                       encoded(c) if raw_context is None else raw_context)
    except ValueError as exc:
        assert str(exc) == 'invalid_input'
        return
    raise AssertionError('invalid input accepted')


check()
# No additive accounting: cached/cache-write and reasoning are inner counts;
# cached+cache-write may exceed input, but each must be <= input separately.
check(start + [dict(type='turn.completed', usage={**usage, 'input_tokens': 70})],
      want=expected(tokens={**usage, 'input_tokens': 70}))
for kind in ('item.started', 'item.updated', 'item.completed'):
    for payload in (dict(command=canary, output=canary, usage={k: 999999 for k in usage},
                         type='turn.completed', thread_id=canary),
                    canary, None, [True, 1, {'tokens': 888}], 1.25):
        check(start + [dict(type=kind, item=payload), completed])
zero = {k: 0 for k in usage}
check(start + [dict(type='turn.completed', usage=zero)], want=expected('zero_unverified'))
check(start + [error, dict(type='turn.completed', usage=zero)],
      want=expected('execution_failed'))
for field in usage:
    tokens = {**zero, field: 1}
    if field in ('cached_input_tokens', 'cache_write_input_tokens'):
        tokens['input_tokens'] = 1
    if field == 'reasoning_output_tokens':
        tokens['output_tokens'] = 1
    check(start + [dict(type='turn.completed', usage=tokens)], want=expected(tokens=tokens))
maximum = {k: 2**53 - 1 for k in usage}
check(start + [dict(type='turn.completed', usage=maximum)], want=expected(tokens=maximum))

# Process precedence, then error/failed terminal, then missing terminal.
for outcome in ('cancelled', 'failed', 'unknown'):
    c = {**context, 'process_outcome': outcome}
    for events in (start, start + [failed], start + [error], start + [error, failed]):
        check(events, c, expected('process_' + outcome))
    if outcome == 'unknown':
        check(normal, c, expected('process_unknown'))
    else:
        rejected(normal, c)
for events in (start + [failed], start + [error], start + [error, failed],
               start + [error, completed], [error] + start + [completed]):
    check(events, want=expected('execution_failed'))
check(start, want=expected('missing_terminal'))
check(raw=b' \t\r\n' + lines(normal).replace(b'\n', b'\r\n') + b'\t\n')
check(raw=lines(normal).rstrip(b'\n'))
check(raw=lines(start).rstrip(b'\n'), want=expected('missing_terminal'))

# Closed context: no identity, model, secret, or provenance authority fields.
for key in context:
    rejected(c={k: v for k, v in context.items() if k != key})
for key in ('model', 'repository', 'issue', 'run', 'credential', 'prompt', 'trusted'):
    rejected(c={**context, key: canary})
for key, values in (
        ('schema', ('unknown', None, True, [])),
        ('version', (True, 1.0, '1', 2, None)),
        ('mode', ('resume', 'fresh_exec_extra', None, True)),
        ('process_outcome', ('SUCCESS', 'success_extra', None, True, []))):
    for value in values:
        rejected(c={**context, key: value})

# Source closed fields / exact discriminator and five exact bounded integers.
for event in (start[0], start[1], completed, failed, error,
              dict(type='item.updated', item={'message': canary})):
    before = [] if event is start[0] else [start[0]] if event is start[1] else start
    after = [start[1], completed] if event is start[0] else [completed] if event is start[1] else []
    for key in event:
        rejected(before + [{k: v for k, v in event.items() if k != key}] + after)
    rejected(before + [{**event, 'extra': canary}] + after)
for key in usage:
    for value in (True, False, -1, 2**53, 1.0, '1', None, [], {}):
        rejected(start + [dict(type='turn.completed', usage={**usage, key: value})])
    rejected(start + [dict(type='turn.completed', usage={k: v for k, v in usage.items()
                                                       if k != key})])
rejected(start + [dict(type='turn.completed', usage={**usage, 'extra': 0})])
for field, bound in (('cached_input_tokens', 100), ('cache_write_input_tokens', 100),
                     ('reasoning_output_tokens', 20)):
    rejected(start + [dict(type='turn.completed', usage={**usage, field: bound + 1})])
for value in ('', 'x' * 129, None, True, [], 1):
    rejected([{**start[0], 'thread_id': value}, start[1], completed])
check([{**start[0], 'thread_id': '\U0001f600' * 128}, start[1], completed])
for value in (None, True, {}, 1):
    rejected(start + [dict(type='error', message=value)])
    rejected(start + [dict(type='turn.failed', error=dict(message=value))])
for value in (None, canary, {}, {'message': canary, 'extra': canary}):
    rejected(start + [dict(type='turn.failed', error=value)])
for kind in ('unknown', 'turn.completed.extra', 'Turn.completed', 'turn.completed ',
             'usage', '', None, True, []):
    rejected(start + [dict(type=kind, usage=usage)])
for events in ([], [start[0]], [start[1]], [completed], start + [start[0]],
               start + [start[1]], normal + [completed], normal + [failed],
               start + [failed, completed], normal + [error], normal + [start[0]],
               normal + [dict(type='item.completed', item=canary)],
               [start[1], start[0], completed], [start[0], completed, start[1]],
               [dict(type='item.started', item=None)] + start):
    rejected(events)

# Strict JSON validity applies inside opaque items too; malformed final lines
# cannot become a valid missing-terminal result.
bad_records = (b'{', b'null', b'[]', b'1', b'{} {}', b'\xff',
               b'{"type":"error","message":"a","message":"b"}',
               b'{"type":"error","type":"turn.started","message":"x"}',
               b'{"type":"item.updated","item":{"x":1,"x":2}}',
               b'{"type":"item.updated","item":NaN}',
               b'{"type":"item.updated","item":Infinity}',
               b'{"type":"item.updated","item":-Infinity}',
               b'{"type":"item.updated","item":"raw\x01control"}')
for bad in bad_records:
    rejected(raw=lines(start) + bad)
    rejected(raw_context=bad)
for number in (b'1e999', b'1e' + b'9' * 5000, b'9' * 5000):
    check(raw=lines(start) + b'{"type":"item.updated","item":' + number + b'}\n'
          + encoded(completed))
    rejected(raw=lines(start) + encoded(completed).replace(b'"input_tokens":100',
                                                         b'"input_tokens":' + number))
    rejected(raw=lines(start) + b'{"type":"error","message":' + number + b'}')
rejected(raw=lines(start) + encoded(completed)[:-2])
rejected(raw=lines(start) + b'\xff\n')
rejected(raw_context=encoded(context)[:-1] + b',"version":1}')
rejected(raw=lines(start) + encoded(completed).replace(b'"input_tokens":100',
                                                     b'"input_tokens":0,"input_tokens":100'))
with patch.object(helper, 'parse', side_effect=RecursionError(canary)):
    rejected()
for value in ('text', bytearray(b''), None, [], 1):
    # API accepts bytes only, even when the alternative could be coerced.
    try:
        helper.extract(value, encoded(context))
    except ValueError:
        pass
    else:
        raise AssertionError('non-bytes JSONL accepted')
    try:
        helper.extract(lines(normal), value)
    except ValueError:
        pass
    else:
        raise AssertionError('non-bytes context accepted')

# Real production-sized bounds, including exact accepted boundary and +1.
assert (helper.MAX_INPUT_BYTES, helper.MAX_LINE_BYTES, helper.MAX_RECORDS) == (
    16 * 1024 * 1024, 1024 * 1024, 50000)
assert helper.MAX_CONTEXT_BYTES == 4096
prefix = lines(start)
item = encoded(dict(type='item.updated', item=canary))
long_line = item + b' ' * (helper.MAX_LINE_BYTES - len(item))
check(raw=prefix + long_line + b'\n' + encoded(completed))
rejected(raw=prefix + long_line + b' \n' + encoded(completed))
rejected(raw=prefix + b' ' * (helper.MAX_LINE_BYTES + 1))
base = lines(normal)
remaining = helper.MAX_INPUT_BYTES - len(base)
blank = b' ' * (helper.MAX_LINE_BYTES - 1) + b'\n'
tail = blank * (remaining // len(blank)) + b' ' * (remaining % len(blank))
check(raw=base + tail)
rejected(raw=base + tail + b' ')
records = prefix + (item + b'\n') * (helper.MAX_RECORDS - 3) + encoded(completed)
check(raw=records)
rejected(raw=prefix + (item + b'\n') * (helper.MAX_RECORDS - 2) + encoded(completed))
ctx = encoded(context)
ctx_bound = ctx + b' ' * (helper.MAX_CONTEXT_BYTES - len(ctx))
check(raw_context=ctx_bound)
rejected(raw_context=ctx_bound + b' ')

# Pure API has a closed import/call surface: no implicit IO or dynamic execution.
with patch('builtins.open', side_effect=AssertionError('pure API attempted IO')):
    check()
    check(start + [error, failed], want=expected('execution_failed'))
    rejected(raw=b'\xff')
tree = ast.parse(source.read_text())
assert {ast.unparse(n) for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))} == {
    'import json', 'import sys'}
pure_calls = {'ValueError', 'require', 'unique_object', 'reject_constant', 'int',
              'json.loads', 'json.dumps', 'fields', 'set', 'usage.items',
              'type', 'len', 'all', 'any', 'dict', 'parse', 'validate_usage', '_extract',
              'data.decode', 'data.split', 'line.strip', 'event.get', 'usage.values',
              "result['usage'].values"}
# ast.unparse uses single-quoted strings; compare the encode call structurally.
pure = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name != 'main']
for function in pure:
    for call in (n for n in ast.walk(function) if isinstance(n, ast.Call)):
        if isinstance(call.func, ast.Attribute) and call.func.attr == 'encode':
            assert isinstance(call.func.value, ast.Call)
            assert ast.unparse(call.func.value.func) == 'json.dumps'
        else:
            assert ast.unparse(call.func) in pure_calls, ast.unparse(call.func)

# Result validation shares schema and usage checks, and rejects reflected data.
for value in (None, {}, bytearray(check()), b'{}', check() + b'\n',
              encoded_canonical({**expected(), 'extra': canary}),
              encoded_canonical({**expected(), 'version': True}),
              encoded_canonical({**expected(), 'usage': zero}),
              encoded_canonical({**expected(), 'usage': {**usage, 'input_tokens': True}}),
              encoded_canonical({**expected(), 'reason': canary}),
              encoded_canonical({**expected('missing_terminal'), 'usage': usage}),
              encoded_canonical({**expected('missing_terminal'), 'reason': canary}),
              encoded_canonical({**expected(), 'source': canary}),
              encoded_canonical({**expected(), 'schema': canary}),
              encoded_canonical({**expected(), 'availability': canary})):
    try:
        helper.validate_result(value)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid parser result accepted')

# Raw synthetic JSONL stays in fixture memory/stdin, never a saved artifact.
with tempfile.TemporaryDirectory() as temporary:
    path = Path(temporary) / (canary + '.json')
    command = [sys.executable, '-B', str(source), '--context', str(path)]
    def run(raw=lines(normal), ctx=encoded(context), args=command):
        path.write_bytes(ctx)
        return subprocess.run(args, input=raw, capture_output=True)
    for events, want in ((normal, expected()), (start + [error, completed], expected('execution_failed')),
                         (start + [dict(type='item.updated', item={'command': canary,
                                                                  'usage': maximum}), completed], expected()),
                         (start + [failed], expected('execution_failed')),
                         (start, expected('missing_terminal')),
                         (start + [dict(type='turn.completed', usage=zero)], expected('zero_unverified'))):
        raw = lines(events)
        first, second = run(raw), run(raw)
        assert first.returncode == second.returncode == 0
        assert first.stdout == second.stdout == encoded_canonical(want) + b'\n'
        assert not first.stderr and not second.stderr
        assert canary.encode() not in first.stdout
    for raw, ctx in ((lines(start) + b'{"type":"error","message":"' + canary.encode(), encoded(context)),
                     (lines(start + [dict(type='item.updated', item=canary, extra=canary)]), encoded(context)),
                     (lines(start) + b'{"type":"item.started","item":{"x":NaN}}', encoded(context)),
                     (lines(normal), encoded({**context, 'credential': canary})),
                     (lines(normal), b' ' * (helper.MAX_CONTEXT_BYTES + 1)),
                     (b' ' * (helper.MAX_INPUT_BYTES + 1), encoded(context))):
        result = run(raw, ctx)
        assert result.returncode == 1 and not result.stdout
        assert result.stderr == 'usage抽出を拒否しました: invalid_input\n'.encode()
    path.unlink()
    for args, code in ((command, 1), (command + [canary], 2),
                       (command[:3], 2), (command[:3] + ['--unknown', canary], 2)):
        result = subprocess.run(args, input=lines(normal), capture_output=True)
        assert result.returncode == code and not result.stdout
        assert canary.encode() not in result.stderr and len(result.stderr) < 128
print('Codex exec usage: synthetic pure / bounded / exact schema / unavailable / non-reflecting CLI PASS')
PY
