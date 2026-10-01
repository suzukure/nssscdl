#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

repo = Path(sys.argv[1]).resolve()
scripts = repo / '.github/scripts'
def load(name):
    spec = importlib.util.spec_from_file_location(name, scripts / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

proxy = load('npm-registry-proxy')
fixture = load('npm-registry-boundary-runtime')
approved = b'CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n'
proxy.authorize(approved)
def rejected(call):
    try:
        call()
    except (proxy.Rejected, proxy.primitive().Rejected):
        return
    raise AssertionError('unsafe input/result accepted')

# Exact authority only: no suffix, userinfo, alternative port, encoded name, IP,
# conflicting Host, request body, credentials, duplicate header, or HTTP forwarding.
for target in ('example.invalid:443', 'registry.npmjs.org.evil.invalid:443',
               'REGISTRY.NPMJS.ORG:443', 'registry.npmjs.org.:443', 'registry.npmjs.org:80',
               'registry.npmjs.org:0443', 'user@registry.npmjs.org:443', '127.0.0.1:443',
               '[::1]:443', 'registry%2enpmjs.org:443', 'https://registry.npmjs.org:443'):
    rejected(lambda: proxy.authorize(approved.replace(b'registry.npmjs.org:443', target.encode())))
for header in (
    approved.replace(b'CONNECT', b'GET'),
    approved.replace(b'HTTP/1.1', b'HTTP/1.0'),
    approved.replace(b'Host: registry.npmjs.org:443', b'Host: example.invalid:443'),
    approved.replace(b'Host: registry.npmjs.org:443\r\n', b''),
    approved[:-2] + b'Host: registry.npmjs.org:443\r\n\r\n',
    approved[:-2] + b'Content-Length: 0\r\n\r\n',
    approved[:-2] + b'Transfer-Encoding: chunked\r\n\r\n',
    approved[:-2] + b'Proxy-Authorization: test-fixture\r\n\r\n',
    approved[:-2] + b'Authorization: test-fixture\r\n\r\n',
    approved[:-2] + b'X-Forwarded-Host: example.invalid\r\n\r\n',
    approved[:-2] + b' User-Agent: folded\r\n\r\n',
    approved[:-2] + b'User-Agent: bad\x00value\r\n\r\n',
    b'GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n',
    b'x' * 8193 + b'\r\n\r\n', approved[:-1],
):
    rejected(lambda: proxy.authorize(header))

client = Mock()
remaining = io.BytesIO(approved + b'TLS-not-header')
client.recv.side_effect = lambda size: remaining.read(size)
assert proxy.read_header(client) == approved
assert remaining.read() == b'TLS-not-header'
client.recv.side_effect = None
client.recv.return_value = b''
rejected(lambda: proxy.read_header(client))

answer = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('104.16.24.34', 443))
# DNS/dial are completely mocked: no external packet or lookup during development.
with patch.object(proxy.socket, 'getaddrinfo', return_value=[answer]) as resolve, \
     patch.object(proxy.socket, 'socket') as factory:
    result = proxy.connect_registry()
    resolve.assert_called_once_with('registry.npmjs.org', 443, type=socket.SOCK_STREAM,
                                    proto=socket.IPPROTO_TCP)
    factory.return_value.connect.assert_called_once_with(answer[4])
    for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '192.0.2.1', '::1', 'fc00::1'):
        resolve.return_value = [answer, (*answer[:4], (address, 443))]
        factory.reset_mock()
        rejected(proxy.connect_registry)
        factory.assert_not_called()
    resolve.return_value = []
    rejected(proxy.connect_registry)
    resolve.return_value = [answer]
    factory.return_value.connect.side_effect = OSError('fixture unavailable')
    try:
        proxy.connect_registry()
    except OSError:
        factory.return_value.close.assert_called_once()
    else:
        raise AssertionError('upstream failure accepted')

handler = proxy.Handler.__new__(proxy.Handler)
handler.request = Mock()
with patch.object(proxy, 'read_header', return_value=approved.replace(b'CONNECT', b'GET')), \
     patch.object(proxy, 'connect_registry') as dial:
    handler.handle()
    dial.assert_not_called()
    assert handler.request.sendall.call_args.args[0].startswith(b'HTTP/1.1 403 ')
with patch.object(proxy, 'read_header', return_value=approved), \
     patch.object(proxy, 'connect_registry', side_effect=OSError('fixture unavailable')) as dial:
    handler.handle()
    assert dial.call_count == 1, 'unexpected retry/fallback'
    assert handler.request.sendall.call_args.args[0].startswith(b'HTTP/1.1 502 ')

# Proxied metadata requires validated TLS, 200, bounded data, and exact identity.
with patch.object(proxy.socket, 'create_connection') as create, \
     patch.object(proxy, 'read_header', return_value=b'HTTP/1.1 200 Connection Established\r\n\r\n'), \
     patch.object(proxy.ssl, 'create_default_context') as context, \
     patch.object(proxy.http.client, 'HTTPResponse') as response:
    response.return_value.status = 200
    response.return_value.read.return_value = b'{"name":"is-number","version":"7.0.0"}'
    assert proxy.registry_get(12345)['tls_verified'] is True
    assert create.call_args.args == (('127.0.0.1', 12345), proxy.TIMEOUT)
    assert context.return_value.wrap_socket.call_args.kwargs == {'server_hostname': proxy.HOST}
    for status in (301, 403, 500):
        response.return_value.status = status
        rejected(lambda: proxy.registry_get(12345))
    response.return_value.status = 200
    for body in (b'x' * 65537, b'{"name":"other","version":"7.0.0"}'):
        response.return_value.read.return_value = body
        rejected(lambda: proxy.registry_get(12345))
with patch.object(proxy.socket, 'create_connection', side_effect=ConnectionRefusedError) as create:
    try:
        proxy.registry_get(12345)
    except ConnectionRefusedError:
        assert create.call_count == 1
    else:
        raise AssertionError('missing proxy accepted')

# Effective property mismatch cannot be bypassed even through a custom trusted verifier.
network = proxy.primitive()
valid = 'IPAddressAllow=127.0.0.0/8 ::1/128\nIPAddressDeny=0.0.0.0/0 ::/0\n'
network.validate_properties(valid)
for invalid in ('', valid.replace('::/0', ''), valid.replace('127.0.0.0/8', '0.0.0.0/0')):
    rejected(lambda: network.validate_properties(invalid))
with patch.object(network, 'validate_endpoint'), patch.object(network, 'tcp') as tcp:
    def mismatch(unit):
        network.validate_properties('')
    rejected(lambda: network.probe('192.0.2.1', 12345, 12346, 'fixture', verifier=mismatch))
    tcp.assert_not_called()

unit = 'codex-network-probe-' + 'a' * 32 + '.service'
snapshot = scripts / (unit + '.json')
record = json.dumps({'unit': unit, 'properties': valid}).encode()
with patch.object(Path, 'exists', return_value=True), \
     patch.object(proxy.os, 'open', return_value=123), \
     patch.object(proxy.os, 'fdopen') as fdopen, \
     patch.object(proxy.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o444)) as fstat, \
     patch.object(proxy.os, 'access', return_value=False):
    def stream(data):
        value = Mock()
        value.__enter__ = Mock(return_value=value)
        value.__exit__ = Mock(return_value=False)
        value.read.return_value = data
        value.fileno.return_value = 123
        return value
    fdopen.return_value = stream(record)
    proxy.verify_snapshot(unit, snapshot)
    for data in (b'x' * 4097, json.dumps({'unit': 'other', 'properties': valid}).encode(),
                 json.dumps({'unit': unit, 'properties': ''}).encode()):
        fdopen.return_value = stream(data)
        rejected(lambda: proxy.verify_snapshot(unit, snapshot))
    fdopen.return_value = stream(record)
    for uid, mode in ((1000, stat.S_IFREG | 0o444), (0, stat.S_IFREG | 0o666), (0, stat.S_IFIFO | 0o444)):
        fstat.return_value = SimpleNamespace(st_uid=uid, st_mode=mode)
        rejected(lambda: proxy.verify_snapshot(unit, snapshot))
rejected(lambda: proxy.verify_snapshot('other', snapshot))
rejected(lambda: proxy.verify_snapshot(unit, Path('/tmp') / snapshot.name))

# A failed property/source preflight or unavailable proxy must never reach registry_get.
args = SimpleNamespace(address='192.0.2.1', port=12345, ipv6_port=12346,
                       proxy_port=12347, unit=unit, properties_file=snapshot)
with patch.object(proxy, 'preflight'), patch.object(network, 'probe', return_value={'status': 'pass'}), \
     patch.object(proxy, 'exchange', side_effect=ConnectionRefusedError), \
     patch.object(proxy, 'registry_get') as get:
    rejected(lambda: proxy.probe(args))
    get.assert_not_called()
with patch.object(proxy, 'preflight', side_effect=proxy.Rejected('unsafe-trusted-source')), \
     patch.object(network, 'probe') as check, patch.object(proxy, 'registry_get') as get:
    rejected(lambda: proxy.probe(args))
    check.assert_not_called()
    get.assert_not_called()

hardening_args = SimpleNamespace(proxy_uid=1000, protected_paths=['/run/fixture'] * 13)
status = 'NoNewPrivs:\t1\n' + ''.join(name + ':\t0000000000000000\n'
                                    for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'))
libc = Mock()
def syscall(number, *arguments):
    proxy.ctypes.set_errno(1)
    return -1
libc.syscall.side_effect = syscall
with patch.object(proxy.os, 'getuid', return_value=65534), \
     patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=0o444)), \
     patch.object(proxy.os, 'access', return_value=False), \
     patch.object(Path, 'read_text', return_value=status) as read_status, \
     patch.object(proxy.platform, 'machine', return_value='x86_64'), \
     patch.object(proxy.ctypes, 'CDLL', return_value=libc), \
     patch.object(proxy.socket, 'socket') as sockets:
    client = sockets.return_value.__enter__.return_value
    client.connect.side_effect = PermissionError(1, 'fixture denied')
    proxy.preflight(hardening_args)
    assert [call.args[0].value for call in libc.syscall.call_args_list] == [425, 426, 427]
    read_status.return_value = status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0')
    rejected(lambda: proxy.preflight(hardening_args))
    read_status.return_value = status.replace('CapBnd:\t0000000000000000', 'CapBnd:\t0000000000000001')
    rejected(lambda: proxy.preflight(hardening_args))
    read_status.return_value = status
    libc.syscall.side_effect = lambda *args: 0
    rejected(lambda: proxy.preflight(hardening_args))
    libc.syscall.side_effect = syscall
    client.connect.side_effect = None
    rejected(lambda: proxy.preflight(hardening_args))

# Unsupported unit startup/timeout must still stop/collect its unique unit, without retry.
class Ports:
    port, ipv6_port = 12345, 12346
calls = []
failure = None
def fake_run(command, **kwargs):
    calls.append(command)
    if command[2] == '/usr/bin/systemd-run':
        assert '--property=IPAddressDeny=any' in command
        assert '--property=IPAddressAllow=localhost' in command
        for value in fixture.hardening(repo):
            assert '--property=' + value in command
        assert '--property=User=nobody' in command
        assert '-i' in command and kwargs['timeout'] == 55
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(command, 55)
        return subprocess.CompletedProcess(command, 1, '', 'Unknown assignment IPAddressDeny')
    assert command[2] == '/usr/bin/systemctl'
    return subprocess.CompletedProcess(command, 0, 'not-found\n' if 'show' in command else '', '')

# Mock thread isolates startup/cleanup checks from observer tool races.
with patch.object(fixture.subprocess, 'run', side_effect=fake_run), \
     patch.object(fixture.threading, 'Thread') as thread:
    thread.return_value.is_alive.return_value = False
    for failure in ('unsupported', 'timeout'):
        try:
            fixture.service(repo, scripts, '192.0.2.1', Ports(), 12347)
        except (AssertionError, subprocess.TimeoutExpired) as error:
            if failure == 'unsupported':
                assert 'Unknown assignment IPAddressDeny' in str(error)
        else:
            raise AssertionError('unsupported/timeout accepted')
    assert len(calls) == 6, 'missing cleanup or unexpected retry'
    units = [item for command in calls for item in command if item.startswith('--unit=')]
    assert len(set(units)) == 2

# Exercise the property observer and root-owned atomic publication without systemd/sudo.
class SynchronousThread:
    def __init__(self, target):
        self.target = target
    def start(self):
        self.target()
    def join(self, timeout):
        pass
    def is_alive(self):
        return False

observed = []
def successful_run(command, **kwargs):
    observed.append(command)
    if '--property=IPAddressDeny' in command:
        return subprocess.CompletedProcess(command, 0, valid, '')
    if command[2] == '/usr/bin/python3':
        record = json.loads(command[-1])
        assert Path(command[-2]).name == record['unit'] + '.json'
        assert record['properties'] == valid and '0o444' in command[5]
        return subprocess.CompletedProcess(command, 0, '', '')
    if command[2] == '/usr/bin/systemd-run':
        return subprocess.CompletedProcess(command, 0, '{"status":"pass"}', '')
    return subprocess.CompletedProcess(command, 0, 'not-found\n' if 'show' in command else '', '')
with patch.object(fixture.subprocess, 'run', side_effect=successful_run), \
     patch.object(fixture.threading, 'Thread', SynchronousThread), patch('builtins.print'):
    fixture.service(repo, scripts, '192.0.2.1', Ports(), 12347)
assert len(observed) == 5, 'missing observer/publication/unit cleanup'

for ready in ({'status': 'ready', 'target': 'example.invalid:443', 'address': '127.0.0.1', 'port': 12345},
              {'status': 'ready', 'target': proxy.TARGET, 'address': '0.0.0.0', 'port': 12345}):
    process = Mock()
    process.poll.return_value = None
    process.wait.side_effect = lambda **kwargs: setattr(process.poll, 'return_value', 0)
    with patch.object(fixture.subprocess, 'Popen', return_value=process) as launch, \
         patch.object(fixture.select, 'select', return_value=([process.stdout], [], [])), \
         patch.object(fixture.os, 'read', return_value=json.dumps(ready).encode()):
        try:
            fixture.start_proxy(scripts)
        except AssertionError:
            pass
        else:
            raise AssertionError('unsafe proxy readiness accepted')
        assert launch.call_args.kwargs['env'] == {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
        process.terminate.assert_called_once()
        process.stdout.close.assert_called_once()

for name in ('npm-registry-proxy.py', 'npm-registry-boundary-runtime.py', 'test-npm-registry-boundary.sh'):
    for workflow in (repo / '.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring', workflow)
assert 'fixtures=(.github/scripts/test-*.sh)' in (
    repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('registry boundary: policy/DNS/TLS/failure/hardening/dormant fixtures passed', flush=True)

if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP registry runtime: inherited Codex boundary; systemd/sudo/network unavailable')
    sys.exit(0)

# Real proxy socket lifecycle, with fake upstream over socketpair: no DNS/internet.
for _ in range(2):
    upstreams = []
    def local_upstream():
        proxy_side, fixture_side = socket.socketpair()
        upstreams.append(fixture_side)
        fixture_side.sendall(b'opaque-fixture-response')
        return proxy_side
    server = proxy.Proxy(0)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05})
    thread.start()
    try:
        assert server.server_address[0] == '127.0.0.1'
        with patch.object(proxy, 'connect_registry', side_effect=local_upstream) as dial:
            assert proxy.exchange(port, approved.replace(b'CONNECT', b'GET')) == b'HTTP/1.1 403 Rejected'
            dial.assert_not_called()
            with socket.create_connection(('127.0.0.1', port), 2) as client:
                client.sendall(approved)
                assert proxy.read_header(client).startswith(b'HTTP/1.1 200 ')
                assert client.recv(64) == b'opaque-fixture-response'
                client.sendall(b'opaque-fixture-request')
                assert upstreams[-1].recv(64) == b'opaque-fixture-request'
            assert dial.call_count == 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)
        for upstream in upstreams:
            upstream.close()
    assert not thread.is_alive() and server.socket.fileno() == -1
print('registry boundary: local tunnel/repeat/socket cleanup passed', flush=True)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('registry runtime requires systemd on the regression runner')
    print('SKIP registry runtime: systemd is not PID 1')
    sys.exit(0)
# Only the independent regression runner performs the fixed metadata GET.
fixture.runtime(repo)
print('registry boundary: approved registry/direct deny/repeat/cleanup runtime passed', flush=True)
PY
