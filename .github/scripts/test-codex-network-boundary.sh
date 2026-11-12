#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import errno
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import threading
import uuid
from unittest.mock import patch

repo = Path(sys.argv[1]).resolve()
source = repo / '.github/scripts/codex-network-boundary.py'
spec = importlib.util.spec_from_file_location('network_boundary', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
assert helper.PROPERTIES == ('IPAddressDeny=any', 'IPAddressAllow=localhost')
properties = subprocess.check_output([sys.executable, str(source), 'properties'], text=True)
assert properties.splitlines() == ['--property=' + value for value in helper.PROPERTIES]

def rejected(call, reason=None):
    try:
        call()
    except helper.Rejected as error:
        assert reason is None or str(error) == reason, error
        return
    raise AssertionError('unsafe input/result accepted')

address = '192.0.2.10'  # Mock-only: never send packets to this documentation IP.
unit = 'codex-network-probe-' + 'a' * 32 + '.service'
with patch.object(helper, 'local_addresses', return_value={address}):
    helper.validate_endpoint(address, 12345)
    for bad in ('example.test', '8.8.8.8', '127.0.0.1', '0.0.0.0', '224.0.0.1',
                '255.255.255.255', '::1', '192.000.2.10', address + '\n'):
        rejected(lambda: helper.validate_endpoint(bad, 12345))
    for port in (True, 0, 1023, 65536, '12345'):
        rejected(lambda: helper.validate_endpoint(address, port), 'invalid-port')

valid_properties = 'IPAddressAllow=127.0.0.0/8 ::1/128\nIPAddressDeny=0.0.0.0/0 ::/0\n'
with patch.object(helper.subprocess, 'run') as run:
    run.return_value = subprocess.CompletedProcess([], 0, valid_properties, '')
    helper.verify_properties(unit)
    for invalid in ('', valid_properties + 'IPAddressDeny=0.0.0.0/0 ::/0\n',
                    valid_properties.replace('::/0', ''),
                    valid_properties.replace('127.0.0.0/8', '0.0.0.0/0')):
        run.return_value = subprocess.CompletedProcess([], 0, invalid, '')
        rejected(lambda: helper.verify_properties(unit))
    for bad in ('codex-developer.service', unit + '\n', '--all'):
        rejected(lambda: helper.verify_properties(bad), 'invalid-unit')
    run.side_effect = subprocess.CalledProcessError(1, 'systemctl')
    try:
        helper.verify_properties(unit)
    except subprocess.CalledProcessError:
        pass
    else:
        raise AssertionError('unavailable property accepted')

allowed_tcp = {'result': 'connected'}
allowed_udp = {'result': 'received'}
denied = {'result': 'error', 'errno': errno.EPERM}
timeout = {'result': 'timeout'}
def exercise(tcp_result, udp_result, restricted=True, localhost=allowed_tcp):
    with patch.object(helper, 'local_addresses', return_value={address}), \
         patch.object(helper, 'verify_properties') as verification, \
         patch.object(helper.socket, 'socket'), \
         patch.object(helper, 'tcp', side_effect=[localhost, allowed_tcp, tcp_result]), \
         patch.object(helper, 'udp', side_effect=[allowed_udp, udp_result]):
        result = helper.probe(address, 12345, 12346, unit if restricted else None)
        assert verification.call_count == int(restricted)
        return result

exercise(allowed_tcp, allowed_udp, False)
assert exercise(denied, denied)['non_loopback_tcp'] == denied
assert exercise(timeout, denied)['non_loopback_tcp'] == timeout
for tcp_result, udp_result in ((allowed_tcp, denied), (timeout, timeout),
                               (timeout, allowed_udp), (denied, allowed_udp),
                               ({'result': 'error', 'errno': errno.ECONNREFUSED}, denied),
                               (timeout, {'result': 'error', 'errno': errno.ENETUNREACH})):
    rejected(lambda: exercise(tcp_result, udp_result))
rejected(lambda: exercise(timeout, denied, localhost=timeout), 'localhost-failed')
rejected(lambda: exercise(denied, denied, False), 'control-failed')

# Exercise real socket error classification without actually sending traffic.
with patch.object(helper.socket, 'socket') as factory:
    client = factory.return_value.__enter__.return_value
    for error, expected in ((TimeoutError(), timeout),
                            (OSError(errno.EPERM, 'denied'), denied),
                            (OSError(errno.ECONNREFUSED, 'refused'),
                             {'result': 'error', 'errno': errno.ECONNREFUSED})):
        client.connect.side_effect = error
        assert helper.tcp(address, 12345) == expected
        client.sendto.side_effect = error
        assert helper.udp(address, 12345) == expected
    client.connect.side_effect = None
    client.recv.return_value = b'network-probe'
    assert helper.tcp(address, 12345) == allowed_tcp
    client.recv.return_value = b'wrong-server'
    rejected(lambda: helper.tcp(address, 12345), 'invalid-local-response')

for args in ([], ['unknown'], ['properties', '--unit', unit],
             ['probe', '--address', 'example.test', '--port', '12345', '--ipv6-port', '12346'],
             ['probe', '--address', address, '--port', 'not-a-port', '--ipv6-port', '12346']):
    result = subprocess.run([sys.executable, str(source), *args], capture_output=True, text=True)
    assert result.returncode != 0, args

# Fixture discovery is the only workflow connection; production stays dormant.
for workflow in (repo / '.github/workflows').glob('*.yml'):
    text = workflow.read_text()
    assert source.name not in text and 'IPAddressDeny=' not in text \
        and 'IPAddressAllow=' not in text, workflow
assert 'fixtures=(.github/scripts/test-*.sh)' in (
    repo / '.github/workflows/ai-workflow-regression.yml').read_text()


class Servers:
    def __init__(self, address):
        self.sockets = []
        self.counts = {'tcp_local': 0, 'tcp_non_loopback': 0, 'udp_non_loopback': 0}
        self.stop = threading.Event()
        self.thread = None
        try:
            loop = self.bind(socket.AF_INET, socket.SOCK_STREAM, '127.0.0.1', 0)
            self.port = loop.getsockname()[1]
            self.non_loopback = self.bind(socket.AF_INET, socket.SOCK_STREAM, address, self.port)
            self.bind(socket.AF_INET, socket.SOCK_DGRAM, '127.0.0.1', self.port)
            self.non_loopback_udp = self.bind(socket.AF_INET, socket.SOCK_DGRAM, address, self.port)
            ipv6 = self.bind(socket.AF_INET6, socket.SOCK_STREAM, '::1', 0)
            self.ipv6_port = ipv6.getsockname()[1]
            self.thread = threading.Thread(target=self.serve)
            self.thread.start()
        except BaseException:
            self.close()
            raise

    def bind(self, family, kind, address, port):
        server = socket.socket(family, kind)
        self.sockets.append(server)
        server.bind((address, port))
        if kind == socket.SOCK_STREAM:
            server.listen(8)
        server.setblocking(False)
        return server

    def serve(self):
        while not self.stop.is_set():
            ready, _, _ = select.select(self.sockets, [], [], 0.05)
            for server in ready:
                if server.type == socket.SOCK_STREAM:
                    connection, _ = server.accept()
                    key = 'tcp_non_loopback' if server is self.non_loopback else 'tcp_local'
                    self.counts[key] += 1
                    with connection:
                        connection.sendall(b'network-probe')
                else:
                    payload, peer = server.recvfrom(64)
                    if server is self.non_loopback_udp:
                        self.counts['udp_non_loopback'] += 1
                    server.sendto(payload, peer)

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=3)
            assert not self.thread.is_alive(), 'server cleanup failed'
        for server in self.sockets:
            server.close()

def service(address, servers, restricted):
    unit = 'codex-network-probe-' + uuid.uuid4().hex + '.service'
    properties = ('Type=exec', 'RuntimeMaxSec=20s', 'TimeoutStopSec=2s',
                  'KillMode=control-group', 'SendSIGKILL=yes', 'NoNewPrivileges=yes',
                  'CapabilityBoundingSet=', 'AmbientCapabilities=',
                  f'User={os.getuid()}', f'Group={os.getgid()}')
    if restricted:
        properties += helper.PROPERTIES
    command = ['sudo', '-n', '/usr/bin/systemd-run', '--quiet', '--wait', '--pipe',
               '--collect', '--unit=' + unit, *['--property=' + value for value in properties],
               '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LC_ALL=C',
               '/usr/bin/python3', str(source), 'probe', '--address', address,
               '--port', str(servers.port), '--ipv6-port', str(servers.ipv6_port)]
    if restricted:
        command += ['--unit', unit]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        # Keep original systemd/tool error text for unsupported/unavailable facts.
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        evidence = json.loads(result.stdout)
        assert evidence['status'] == 'pass', evidence
        print(json.dumps(evidence, sort_keys=True), flush=True)
    finally:
        # Cleanup targets only the unique fixture unit, including timeout/error.
        subprocess.run(['sudo', '-n', '/usr/bin/systemctl', 'stop', unit],
                       capture_output=True, timeout=10)
        state = subprocess.run(['sudo', '-n', '/usr/bin/systemctl', 'show', unit,
                                '--property=LoadState', '--value'],
                               capture_output=True, text=True, timeout=10)
        assert state.returncode in (0, 1) and state.stdout.strip() == 'not-found', \
            ('unit cleanup unconfirmed', unit, state.stdout, state.stderr)

# Test orchestration failure/timeout/cleanup even inside a restricted workload.
class Ports:
    port, ipv6_port = 12345, 12346

calls = []
failure = None
def fake_run(command, **kwargs):
    calls.append(command)
    if command[2] == '/usr/bin/systemd-run':
        assert '--property=IPAddressDeny=any' in command
        assert '--property=IPAddressAllow=localhost' in command
        assert '--property=NoNewPrivileges=yes' in command
        assert '--property=CapabilityBoundingSet=' in command
        assert '--collect' in command and '--wait' in command and '--pipe' in command
        assert kwargs['timeout'] == 30
        assert command[command.index('/usr/bin/env') + 1:][:3] == [
            '-i', 'PATH=/usr/bin:/bin', 'LC_ALL=C']
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(command, 30)
        if failure:
            return subprocess.CompletedProcess(command, 1, '', 'Unknown assignment IPAddressDeny')
        return subprocess.CompletedProcess(command, 0, json.dumps({
            'status': 'pass', 'mode': 'restricted', 'non_loopback_tcp': timeout}), '')
    assert command[2] == '/usr/bin/systemctl'
    return subprocess.CompletedProcess(command, 0, 'not-found\n' if 'show' in command else '', '')

with patch.object(subprocess, 'run', side_effect=fake_run), patch('builtins.print'):
    for _ in range(2):
        service(address, Ports(), True)
    for failure in ('unsupported', 'timeout'):
        try:
            service(address, Ports(), True)
        except (AssertionError, subprocess.TimeoutExpired):
            pass
        else:
            raise AssertionError('unsupported/timeout service accepted')
    assert len(calls) == 12, 'unexpected retry or missing cleanup'
    units = [next(item for item in command if item.startswith('--unit=')) for command in calls[::3]]
    assert len(set(units)) == 4
    for index in range(4):
        assert calls[index * 3 + 1][-1] == units[index].split('=', 1)[1]
        assert calls[index * 3 + 2][4] == units[index].split('=', 1)[1]

print('network boundary: pure/error/input/dormant/orchestration fixtures passed', flush=True)
if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP local-server/network runtime: inherited Codex boundary; sockets/systemd/sudo unavailable')
    sys.exit(0)

# Real local server/socket lifecycle regression, without needing systemd/sudo.
for _ in range(2):
    servers = Servers('127.0.0.2')
    try:
        assert helper.tcp('127.0.0.1', servers.port) == allowed_tcp
        assert helper.tcp('::1', servers.ipv6_port) == allowed_tcp
        assert helper.tcp('127.0.0.2', servers.port) == allowed_tcp
        assert helper.udp('127.0.0.1', servers.port) == allowed_udp
        assert helper.udp('127.0.0.2', servers.port) == allowed_udp
        assert servers.counts == {'tcp_local': 2, 'tcp_non_loopback': 1, 'udp_non_loopback': 1}
    finally:
        servers.close()
    assert all(server.fileno() == -1 for server in servers.sockets)
print('network boundary: local-server/repeat/cleanup fixtures passed', flush=True)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('network runtime requires systemd on the regression runner')
    print('SKIP network runtime: systemd is not PID 1')
    sys.exit(0)
assert os.getuid() != 0, 'runtime fixture requires a non-root runner UID'
subprocess.run(['sudo', '-n', 'true'], check=True, timeout=5)
addresses = sorted(helper.local_addresses())
assert addresses, 'no assigned non-loopback IPv4 address; fail closed'
address = addresses[0]
for _ in range(2):
    servers = Servers(address)
    try:
        service(address, servers, False)
        assert servers.counts == {'tcp_local': 2, 'tcp_non_loopback': 1, 'udp_non_loopback': 1}
        before = dict(servers.counts)
        service(address, servers, True)
        assert servers.counts == {**before, 'tcp_local': before['tcp_local'] + 2}, \
            ('restricted traffic reached non-loopback listener', servers.counts)
        service(address, servers, False)
        assert servers.counts == {'tcp_local': 6, 'tcp_non_loopback': 2, 'udp_non_loopback': 2}
        assert servers.thread.is_alive(), 'server failed during probe'
    finally:
        servers.close()
    assert all(server.fileno() == -1 for server in servers.sockets)
print('network boundary: localhost allow/non-loopback deny/repeat/cleanup runtime passed')
PY
