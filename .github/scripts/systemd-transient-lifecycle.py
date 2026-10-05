#!/usr/bin/env python3
"""#783 prepared-only transient-unit lifecycle; no CLI or production caller.

Trusted callers generate a fresh unit with new_unit(), build a closed launch
argv containing that identity, then call execute(unit, argv, timeout_seconds).
The caller owns argv/unit binding, target exit propagation, executable/property/
environment authority and any RootDirectory trust. This helper does not inspect
or construct the target command. It must not be connected to PR privileged
execution or promoted to an actual proof by this prepared-only Issue.

Inputs: exact ai-lifecycle-<32 lowercase hex>.service; list/tuple of 1..256
nonempty NUL-free UTF-8 arguments, each <=8192 bytes and total <=65536 bytes;
integer execution timeout 1..700 seconds. Invalid input makes no subprocess call.
Transport uses the existing runner's fixed PATH/LC_ALL; target environment policy
is the trusted closed launch's responsibility. Cleanup reuses its sudo -n
systemctl stop/show transport, each with a fixed 10-second timeout.

For admitted inputs: launch once, stop once, show once, including after failure.
No retry/fallback. Launch/stop output is discarded. Show output is spooled, only
33 bytes are read, and neither bytes nor exceptions are returned. Exact
not-found (optionally one LF) with show rc 0 or 1 reuses the existing runner's
absence check. Stop must independently return zero. This is synthetic-tested
cleanup semantics, not evidence about an actual manager or target execution.

Return schema systemd-transient-lifecycle version 1: status and launch_status
are pass/fail; launch_exit_class is zero/nonzero/signal/timeout/exec-error;
cleanup_status is confirmed/unconfirmed/stop-nonzero/stop-signal/stop-timeout/
stop-exec-error; residual_class is not-found/present/malformed/nonzero/signal/
timeout/exec-error/unconfirmed. status passes only when launch and cleanup pass.
Invalid input uses exec-error/fail/unconfirmed/unconfirmed. KeyboardInterrupt
is normalized to signal, still allowing subsequent cleanup attempts. Process
kill/runner loss cannot be proven or recovered by this in-process helper.
"""

import re
import subprocess
import tempfile
import uuid


ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
CLEANUP_TIMEOUT = 10


def new_unit():
    return 'ai-lifecycle-' + uuid.uuid4().hex + '.service'


def valid_inputs(unit, argv, timeout_seconds):
    if (type(unit) is not str
            or re.fullmatch(r'ai-lifecycle-[0-9a-f]{32}\.service', unit) is None
            or type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 700
            or type(argv) not in (list, tuple) or not 1 <= len(argv) <= 256):
        return False
    try:
        if any(type(arg) is not str or not arg or '\0' in arg for arg in argv):
            return False
        sizes = [len(arg.encode('utf-8', 'strict')) for arg in argv]
        return max(sizes) <= 8192 and sum(sizes) <= 65536
    except UnicodeError:
        return False


def invoke(argv, timeout_seconds, stdout):
    """Normalize subprocess and Python errors without retaining raw evidence."""
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=stdout,
                                stderr=subprocess.DEVNULL, timeout=timeout_seconds,
                                env=ENV.copy(), shell=False, check=False)
        rc = result.returncode
        if type(rc) is not int:
            return 'exec-error', None
        return ('zero' if rc == 0 else 'signal' if rc < 0 else 'nonzero'), rc
    except subprocess.TimeoutExpired:
        return 'timeout', None
    except KeyboardInterrupt:
        return 'signal', None
    except Exception:
        return 'exec-error', None


def residual(unit):
    try:
        with tempfile.TemporaryFile() as output:
            kind, rc = invoke(['sudo', '-n', '/usr/bin/systemctl', 'show', unit,
                               '--property=LoadState', '--value'], CLEANUP_TIMEOUT, output)
            if kind in ('timeout', 'exec-error', 'signal'):
                return kind
            if rc not in (0, 1):
                return 'nonzero'
            output.seek(0)
            data = output.read(33)
            if data in (b'not-found', b'not-found\n'):
                return 'not-found'
            if re.fullmatch(rb'[a-z-]{1,32}\n?', data) and len(data) <= 32:
                return 'present'
            return 'malformed'
    except KeyboardInterrupt:
        return 'signal'
    except Exception:
        return 'exec-error'


def execute(unit, launch_argv, timeout_seconds):
    """Own only bounded launch/stop/residual state, returning a closed record."""
    result = dict(schema='systemd-transient-lifecycle', version=1, status='fail',
                  launch_exit_class='exec-error', launch_status='fail',
                  cleanup_status='unconfirmed', residual_class='unconfirmed')
    if not valid_inputs(unit, launch_argv, timeout_seconds):
        return result
    launch = tuple(launch_argv)
    try:
        kind, _ = invoke(launch, timeout_seconds, subprocess.DEVNULL)
        result['launch_exit_class'] = kind
        result['launch_status'] = 'pass' if kind == 'zero' else 'fail'
    finally:
        stop, _ = invoke(['sudo', '-n', '/usr/bin/systemctl', 'stop', unit],
                         CLEANUP_TIMEOUT, subprocess.DEVNULL)
        result['residual_class'] = residual(unit)
        result['cleanup_status'] = (
            'stop-' + stop if stop != 'zero' else
            'confirmed' if result['residual_class'] == 'not-found' else 'unconfirmed')
    if result['launch_status'] == 'pass' and result['cleanup_status'] == 'confirmed':
        result['status'] = 'pass'
    return result
