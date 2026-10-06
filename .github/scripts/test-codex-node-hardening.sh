#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
python3 - "$repo_root" <<'PY'
import ctypes
import errno
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
from unittest.mock import patch

workflow = (Path(sys.argv[1]) / '.github/workflows/ai-developer.yml').read_text()
expected = 'SystemCallFilter=~io_uring_setup:EPERM io_uring_enter:EPERM io_uring_register:EPERM'
def assert_filter(step):
    filters = re.findall(r'--property="(SystemCallFilter=[^"]+)"', step)
    assert filters == [expected], filters
    assert 'SystemCallErrorNumber=' not in step

steps = []
for name in ('Run Codex developer', 'Run Codex follow-up'):
    step = workflow.split('      - name: ' + name + '\n', 1)[1].split('      - name:', 1)[0]
    assert_filter(step)
    for replacement in ('', expected.replace(':EPERM', ''),
                        expected.replace('~', ''), expected.replace('io_uring_enter:EPERM', '')):
        try:
            assert_filter(step.replace(expected, replacement))
        except AssertionError:
            pass
        else:
            raise AssertionError((name, 'filter regression accepted', replacement))
    launcher = textwrap.dedent(step.split("<<'CODEX_RUN'\n", 1)[1].split('          CODEX_RUN\n', 1)[0])
    probe = launcher.split('import ctypes\n', 1)[1].split('\nprint(\n', 1)[0]
    probe = 'import ctypes\n' + probe
    root = step.split("/bin/sh -c '\n", 1)[1].split("            ' codex-", 1)[0]
    steps.append((name, launcher, probe, textwrap.dedent(root)))
assert steps[0][1:] == steps[1][1:], 'developer/follow-up hardening drift'
probe = steps[0][2]
compile(probe, '<production Node/io_uring preflight>', 'exec')

# Exercise the production probe without issuing blocked syscalls locally.
# Any one allowed syscall, wrong errno, or failed tooling must fail closed.
class Libc:
    def __init__(self, allowed=None, error=errno.EPERM):
        self.allowed, self.error, self.calls = allowed, error, []
        self.syscall = self.call

    def call(self, number, *args):
        self.calls.append(number.value)
        ctypes.set_errno(self.error if number.value != self.allowed else errno.EBADF)
        return -1

def exercise(allowed=None, error=errno.EPERM, failure=None):
    libc = Libc(allowed, error)
    # Use a mock callable so the production restype assignment remains valid.
    from unittest.mock import Mock
    libc.syscall = Mock(side_effect=libc.call)
    commands = []
    def run(command, **kwargs):
        assert kwargs['cwd'] == '/' and kwargs['timeout'] == 20
        commands.append(command)
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(command, 20)
        return subprocess.CompletedProcess(command, -31 if command[0] == failure else 0,
                                           '24.0.0\n', '')
    with patch('ctypes.CDLL', return_value=libc), patch('platform.machine', return_value='x86_64'), \
         patch('subprocess.run', side_effect=run), patch('builtins.print'):
        exec(probe, {'errno': errno, 'os': os})
    assert libc.calls == [425, 426, 427]
    assert commands == [('node', '--version'), ('npm', '--version')]

exercise()
for kwargs in ([{'allowed': n} for n in (425, 426, 427)] +
               [{'error': errno.ENOSYS}] + [{'failure': n} for n in ('node', 'npm', 'timeout')]):
    try:
        exercise(**kwargs)
    except SystemExit:
        pass
    else:
        raise AssertionError(('unsafe probe accepted', kwargs))
print('Node/io_uring static and fail-closed fixtures passed')

# A Codex child cannot replace its inherited SIGSYS filter or create units.
# Do not claim a runtime pass when executing under that existing boundary.
if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP same-unit runtime: inherited Codex filter; systemd/sudo boundary unavailable')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('same-unit runtime requires systemd on the regression runner')
    print('SKIP same-unit runtime: systemd is not PID 1')
    sys.exit(0)
subprocess.run(['sudo', '-n', 'true'], check=True)

# Select an already installed Node 24; never download a runtime or packages.
node_bins = sorted(Path('/opt/hostedtoolcache/node').glob('24.*/x64/bin'), reverse=True)
runtime_path = str(node_bins[0]) + ':' + os.environ['PATH'] if node_bins else os.environ['PATH']
version = subprocess.check_output(['node', '--version'], env={'PATH': runtime_path}, text=True).strip()
assert version.startswith('v24.'), ('Node 24 unavailable', version)

def snapshot():
    paths = re.search(r'protected_unix_socket_paths="([^"]+)"', steps[0][3]).group(1).split()
    metadata = []
    for path in paths:
        try:
            st = os.stat(path)
        except FileNotFoundError:
            continue
        metadata.append((path, st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode))
    resolver = subprocess.check_output(['systemctl', 'show', 'systemd-resolved.service', '--no-pager',
                                       '--property=ActiveState', '--property=SubState',
                                       '--property=MainPID', '--property=NRestarts'], text=True)
    return metadata, resolver

with tempfile.TemporaryDirectory(prefix='node-hardening-') as tmp:
    directory = Path(tmp)
    launcher = directory / 'launcher.sh'
    # Run the full production privilege/socket/io_uring/Node preflight, then
    # exit before native Codex/model execution. Keep the production root shell.
    launcher.write_text(steps[0][1].split('\nexec env \\\n', 1)[0] + '\nexit 0\n')
    root = directory / 'root.sh'
    root.write_text(steps[0][3])
    unit = f'node-hardening-fixture-{os.getpid()}'
    before = snapshot()
    uid = str(os.getuid())
    gid = subprocess.check_output(['id', '-g', 'nobody'], text=True).strip()
    args = [os.environ.get('USER', 'runner'), uid, gid, tmp, runtime_path, tmp, '60', unit,
            str(launcher), tmp, tmp, str(directory / 'final'), str(directory / 'prompt'),
            'unused', '/usr/bin/true', tmp, 'unused', 'unused-supervisor', 'unused-extractor']
    try:
        subprocess.run(['sudo', '-n', '/bin/sh', str(root), *args], check=True, timeout=80)
    finally:
        assert snapshot() == before, 'host socket/resolver integrity changed'
print('Node 24/npm and io_uring EPERM same-unit runtime fixture passed')
PY
