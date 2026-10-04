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
import pwd
import signal
import subprocess
import sys
import tempfile
import time
import uuid
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

# #764 reuses only the existing launch hardening/lifecycle contract. No API,
# proxy/socket preflight, native binary, workspace isolation or paid-path proof.
properties = ('Type=exec', 'TimeoutStopSec=5s', 'KillMode=control-group',
              'SendSIGKILL=yes', 'NoNewPrivileges=yes', 'SystemCallArchitectures=native',
              'SystemCallFilter=~io_uring_setup:EPERM io_uring_enter:EPERM io_uring_register:EPERM')
privileges = ('--clear-groups', '--no-new-privs', '--bounding-set=-all',
              '--inh-caps=-all', '--ambient-caps=-all')
workflow = (repo / '.github/workflows/ai-developer.yml').read_text()
for launch in workflow.split('/usr/bin/systemd-run \\\n')[1:]:
    launch = launch.split('rc=$?', 1)[0]
    for value in properties:
        assert ('--property=' + value + ' ' in launch
                or '--property="' + value + '" ' in launch)
    assert '--property="RuntimeMaxSec=${runtime_max_sec}s"' in launch
    assert '/usr/bin/setpriv' in launch and '/usr/bin/env -i' in launch
    assert '--reuid="$uid"' in launch and '--regid="$nobody_gid"' in launch
    assert all(value in launch for value in privileges)
assert workflow.count('/usr/bin/systemd-run \\\n') == 2
assert 'uid="$(id -u)"' in workflow and 'nobody_gid="$(id -g nobody)"' in workflow

# Fixed child source stays inside this fixture; only PID readiness metadata is
# saved. Raw stdout/stderr are generated in memory and never saved by the test.
runtime_child = r'''
import json, os, signal, subprocess, sys, time
from pathlib import Path
base, mode = Path(sys.argv[1]), sys.argv[2]
if mode == 'descendant':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (base / 'descendant').write_text(str(os.getpid()))
    time.sleep(60)
    sys.exit(99)
assert sys.stdin.buffer.read() == b'finite-stdin-764\n'
if mode == 'timeout':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    subprocess.Popen([sys.executable, '-B', __file__, str(base), 'descendant'])
(base / 'ready').write_text(json.dumps([os.getppid(), os.getpid()]))
deadline = time.monotonic() + 30
while not (base / 'release').exists():
    assert time.monotonic() < deadline
    time.sleep(0.02)
canary = 'SECRET_CANARY_764_command_body_error_stderr'
os.write(2, canary.encode() * 8192)
if mode == 'timeout':
    time.sleep(60)
    sys.exit(99)
if mode == 'limit':
    for _ in range(320):
        os.write(1, (canary.encode() + b'x' * 65536)[:65536])
    sys.exit(0)
events = [dict(type='thread.started', thread_id='synthetic-764'), dict(type='turn.started'),
          dict(type='item.completed', item=dict(command=canary, body=canary, error=canary))]
if mode == 'rc0':
    events.append(dict(type='turn.completed', usage=dict(input_tokens=100,
        cached_input_tokens=70, cache_write_input_tokens=40,
        output_tokens=20, reasoning_output_tokens=10)))
else:
    events.append(dict(type='turn.failed', error=dict(message=canary)))
for event in events:
    sys.stdout.buffer.write(json.dumps(event).encode() + b'\n')
sys.stdout.buffer.flush()
sys.exit(int(mode[2:]))
'''
compile(runtime_child, '<fixed-supervisor-fixture>', 'exec')
runtime_canary = b'SECRET_CANARY_764_command_body_error_stderr'
independent = (Path('/proc/1/comm').read_text().strip() == 'systemd'
               and 'codex-' not in Path('/proc/self/cgroup').read_text())
if not independent:
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('FAIL supervisor runtime: independent systemd runner required; SKIP forbidden')
    print('SKIP supervisor runtime: 独立systemd runnerが必要です（local checksのみ）')
    sys.exit(0)


def checked(args):
    # Never reflect systemd/journal/child diagnostics on failure.
    result = subprocess.run(['sudo', '-n', *args], capture_output=True, timeout=10)
    assert result.returncode == 0, 'runtime control command failed'
    return result.stdout


def show(unit, names):
    data = checked(['systemctl', 'show', unit, *['--property=' + n for n in names]])
    return dict(line.split('=', 1) for line in data.decode().splitlines())


def until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError('runtime observation deadline exceeded')


def identity(pid, cgroup):
    proc = Path('/proc') / str(pid)
    assert proc.joinpath('cgroup').read_text().strip() == '0::' + cgroup
    status = dict(line.split(':', 1) for line in proc.joinpath('status').read_text().splitlines())
    assert set(map(int, status['Uid'].split())) == {os.getuid()}
    assert set(map(int, status['Gid'].split())) == {pwd.getpwnam('nobody').pw_gid}
    assert not status['Groups'].strip() and status['NoNewPrivs'].strip() == '1'
    assert all(int(status[key].strip(), 16) == 0
               for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'))
    # PID reuse must not be mistaken for a surviving fixture process.
    return proc.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19]


def gone(pid, started):
    try:
        return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19] != started
    except FileNotFoundError:
        return True


assert os.getuid() != 0, 'runtime requires the existing non-root runner identity'
checked(['true'])
with tempfile.TemporaryDirectory(prefix='supervisor-764-', dir='/tmp') as directory:
    scratch = Path(directory)
    scratch.chmod(0o755)
    child_source = scratch / 'child.py'
    child_source.write_text(runtime_child)
    finite_input = scratch / 'stdin'
    finite_input.write_bytes(b'finite-stdin-764\n')
    for mode in ('rc0', 'rc7', 'not-started', 'rc2', 'limit', 'timeout'):
        base = scratch / mode
        base.mkdir()
        unit = 'supervisor-764-' + uuid.uuid4().hex + '.service'
        processes = {}
        waiter = None
        try:
            argv = ([str(base / 'absent-executable')] if mode == 'not-started' else
                    [sys.executable, '-B', str(child_source), str(base), mode])
            # Retain the finished unit for property/status observations. Unlike
            # production --collect, release it in finally after unit-only proof.
            launch = ['sudo', '-n', '/usr/bin/systemd-run', '--quiet', '--wait', '--unit=' + unit,
                      *['--property=' + p for p in properties],
                      '--property=RuntimeMaxSec=' + ('8s' if mode == 'timeout' else '20s'),
                      '--property=RemainAfterExit=yes', '--property=StandardOutput=journal',
                      '--property=StandardError=journal', '--property=StandardInput=file:' + str(finite_input),
                      '/usr/bin/setpriv', '--reuid=' + str(os.getuid()),
                      '--regid=' + str(pwd.getpwnam('nobody').pw_gid), *privileges,
                      '--', '/usr/bin/env', '-i', *command, *argv]
            waiter = subprocess.Popen(launch, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if mode != 'not-started':
                until(lambda: (base / 'ready').exists() and (base / 'ready').stat().st_size > 0)
                pids = json.loads((base / 'ready').read_text())
                if mode == 'timeout':
                    until(lambda: (base / 'descendant').exists() and (base / 'descendant').stat().st_size > 0)
                    pids.append(int((base / 'descendant').read_text()))
                observed = show(unit, ('MainPID', 'ControlGroup', 'Type', 'KillMode',
                                      'SendSIGKILL', 'NoNewPrivileges', 'TimeoutStopUSec',
                                      'SystemCallArchitectures', 'SystemCallFilter'))
                assert int(observed['MainPID']) == pids[0] and len(set(pids)) == len(pids)
                assert observed['Type'] == 'exec' and observed['KillMode'] == 'control-group'
                assert observed['SendSIGKILL'] == observed['NoNewPrivileges'] == 'yes'
                assert observed['TimeoutStopUSec'] == '5s'
                assert observed['SystemCallArchitectures'] == 'native'
                assert observed['SystemCallFilter'].startswith('~')
                assert all(name in observed['SystemCallFilter'] for name in
                           ('io_uring_setup', 'io_uring_enter', 'io_uring_register'))
                cgroup = observed['ControlGroup']
                assert cgroup == '/system.slice/' + unit
                processes = {pid: identity(pid, cgroup) for pid in pids}
                (base / 'release').touch()
            # --wait with RemainAfterExit needs a bounded status poll before
            # stopping successful retained units; it cannot define child rc.
            def finished():
                value = show(unit, ('ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus'))
                if value['ActiveState'] in ('active', 'failed', 'inactive') and value['SubState'] != 'running':
                    return value
            outcome = until(finished, seconds=25)
            expected_rc = None if mode == 'not-started' else int(mode[2:]) if mode.startswith('rc') else 0
            if mode == 'timeout':
                assert outcome['Result'] == 'timeout'
                assert outcome['ExecMainCode'] == '2' and outcome['ExecMainStatus'] == str(signal.SIGTERM)
            else:
                assert outcome['ExecMainCode'] == '1'
                assert int(outcome['ExecMainStatus']) == helper.exit_status(expected_rc)
            until(lambda: all(gone(pid, started) for pid, started in processes.items()))
            if mode != 'not-started':
                members = Path('/sys/fs/cgroup' + cgroup) / 'cgroup.procs'
                assert not members.exists() or not members.read_text().strip()
            checked(['systemctl', 'stop', unit])
            waiter.wait(timeout=10)
            if mode == 'timeout':
                assert waiter.returncode != 0
            else:
                assert waiter.returncode == helper.exit_status(expected_rc)
            # Synchronize journal delivery; never read/clear the host journal.
            def delivered():
                data = checked(['journalctl', '--unit=' + unit, '--no-pager', '--output=json'])
                if data and (mode == 'timeout' or any(json.loads(line).get('_TRANSPORT') == 'stdout'
                                                     for line in data.splitlines())):
                    return data
            journal = until(delivered)
            assert len(journal) <= 65536 and runtime_canary not in journal
            entries = [json.loads(line) for line in journal.splitlines()]
            assert all(type(e['MESSAGE']) is str and len(e['MESSAGE'].encode()) <= 4096 for e in entries)
            outputs = [e for e in entries if e.get('_TRANSPORT') == 'stdout']
            assert all(e.get('_SYSTEMD_UNIT') == unit for e in outputs)
            if mode != 'not-started':
                assert all(e.get('_PID') == str(pids[0]) and e.get('_SYSTEMD_CGROUP') == cgroup for e in outputs)
            records = [e['MESSAGE'].encode() for e in outputs]
            if mode == 'timeout':
                assert records == [], 'external termination must not fabricate a result'
                availability = 'unknown' if not records else 'reported'
                assert availability == 'unknown'  # Never success or usage=0.
            else:
                assert len(records) == 1
                status = ('execution_not_started' if mode == 'not-started' else
                          'capture_limit_exceeded' if mode == 'limit' else 'collected')
                reason = 'terminal_cumulative' if mode == 'rc0' else 'process_failed'
                value = check_record(records[0], expected_rc, status, reason)
                if status == 'collected':
                    extractor.validate_result(json.dumps(value['usage_result'], sort_keys=True,
                                              separators=(',', ':')).encode())
            assert {p.name for p in base.iterdir()} <= {'ready', 'release', 'descendant'}
            print('supervisor systemd: ' + mode + ' PASS（synthetic stream/lifecycleのみ）', flush=True)
        finally:
            # Stop/reset only the unique fixture unit, including outer timeout
            # or assertion failures. Never kill by username or touch other units.
            subprocess.run(['sudo', '-n', 'systemctl', 'stop', unit], capture_output=True, timeout=10)
            if waiter is not None:
                waiter.wait(timeout=10)
            subprocess.run(['sudo', '-n', 'systemctl', 'reset-failed', unit], capture_output=True, timeout=10)
            state = subprocess.run(['sudo', '-n', 'systemctl', 'show', unit,
                                    '--property=LoadState', '--value'], capture_output=True, timeout=10)
            assert state.returncode in (0, 1) and state.stdout.strip() == b'not-found', 'unit cleanup unconfirmed'
            until(lambda: all(gone(pid, started) for pid, started in processes.items()))
print('supervisor systemd runtime: 同一cgroup / sanitized journal / drain / control-group終了 PASS')
PY
