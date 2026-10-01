#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import importlib.util
import json
import os
from pathlib import Path
import shutil
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

source = load('npm-network-source-probe')
proxy = source.proxy_helper()
runtime = load('npm-registry-boundary-runtime')
tools = {name: Path(shutil.which(name)).resolve() for name in ('node', 'npm', 'git')}
assert all(path.is_file() for path in tools.values()), 'trusted npm/git runtime missing'
args = SimpleNamespace(mode='restricted', address='127.0.0.1', port=12345,
                       ipv6_port=12346, source_port=12347, proxy_port=12348,
                       unit='fixture', properties_file=Path('/unused'), **tools)

def rejected(call, reason):
    try:
        call()
    except (proxy.Rejected, proxy.primitive().Rejected) as error:
        assert str(error) == reason, error
        return
    raise AssertionError('unsafe result accepted')

# Boundary/source/UID preflight failures prevent every package-manager subprocess.
with patch.object(source, 'sources') as commands, \
     patch.object(proxy, 'probe', side_effect=proxy.Rejected('network-properties-mismatch')):
    rejected(lambda: source.probe(args, proxy), 'network-properties-mismatch')
    commands.assert_not_called()
args.mode = 'unavailable'
with patch.object(source, 'sources') as commands, \
     patch.object(proxy, 'preflight', side_effect=proxy.Rejected('unsafe-proxy-identity')):
    rejected(lambda: source.probe(args, proxy), 'unsafe-proxy-identity')
    commands.assert_not_called()
with patch.object(source, 'sources') as commands, patch.object(proxy, 'preflight'), \
     patch.object(proxy.primitive(), 'probe', side_effect=proxy.primitive().Rejected('explicit-deny-missing')):
    rejected(lambda: source.probe(args, proxy), 'explicit-deny-missing')
    commands.assert_not_called()

network = proxy.primitive()
denied = {'result': 'error', 'errno': 1}
with patch.object(network, 'validate_endpoint'), patch.object(network, 'udp', return_value={'result':'timeout'}), \
     patch.object(source, 'execute') as commands:
    rejected(lambda: source.sources(args, proxy), 'source-port-filter-unconfirmed')
    commands.assert_not_called()

# Exit failure alone, timeout, or an unrelated HTTP error is never proxy proof.
args.mode = 'restricted'
for outcome, output, reason in (
    ({'result':'exited', 'returncode':0}, '403', 'git_https-accepted'),
    ({'result':'exited', 'returncode':1}, '500', 'git_https-proxy-deny-unconfirmed'),
    ({'result':'exited', 'returncode':1}, 'connect to 127.0.0.1:40301 failed', 'git_https-proxy-deny-unconfirmed'),
    ({'result':'timeout'}, '', 'git_https-accepted'),
):
    with patch.object(network, 'validate_endpoint'), patch.object(network, 'udp', return_value=denied), \
         patch.object(source.os, 'access', return_value=False), \
         patch.object(source, 'execute', side_effect=[({'result':'timeout'}, '')] * 2 + [(outcome, output)]):
        rejected(lambda: source.sources(args, proxy), reason)

# A timed-out npm/git tree is killed; proxy timeouts are errors, never retried.
process = Mock(pid=12345)
process.communicate.side_effect = [subprocess.TimeoutExpired('fixture', 10), ('', '')]
with patch.object(source.subprocess, 'Popen', return_value=process) as launch, \
     patch.object(source.os, 'killpg') as kill:
    try:
        source.execute(['fixture'], scripts, {'LC_ALL':'C'})
    except subprocess.TimeoutExpired:
        pass
    else:
        raise AssertionError('proxy timeout accepted')
    assert launch.call_count == 1 and launch.call_args.kwargs['start_new_session'] is True
    assert kill.call_args.args[0] == 12345

# Exact #649 property/hardening/observer contract reused for the new service.
class Ports:
    port, ipv6_port = 12345, 12346
    sources = SimpleNamespace(port=12347)
calls = []
def launch_failed(command, **kwargs):
    calls.append(command)
    if command[2] == '/usr/bin/systemd-run':
        for value in (*network.PROPERTIES, *runtime.hardening(repo)):
            assert '--property=' + value in command
        assert 'npm-network-source-probe.py' in ' '.join(command)
        assert '--source-port' in command and '--node' in command and '--git' in command
        assert '--mode' in command and command[command.index('--mode')+1] == 'restricted'
        assert '-i' in command and '--property=User=nobody' in command
        return subprocess.CompletedProcess(command, 1, '', 'Unknown assignment IPAddressDeny')
    return subprocess.CompletedProcess(command, 0, 'not-found\n' if 'show' in command else '', '')
with patch.object(runtime.subprocess, 'run', side_effect=launch_failed), \
     patch.object(runtime.threading, 'Thread') as thread:
    thread.return_value.is_alive.return_value = False
    try:
        runtime.service(repo, scripts, '192.0.2.1', Ports(), 12348, source_tools=tools)
    except AssertionError as error:
        assert 'Unknown assignment IPAddressDeny' in str(error)
    else:
        raise AssertionError('unavailable boundary accepted')
    assert len(calls) == 3 and calls[-2][3] == 'stop', 'fallback or missing cleanup'

# Full command orchestration in every mode, including disposable config/cache.
directories = []
for mode in ('control', 'restricted', 'unavailable', 'restricted'):
    args.mode = mode
    seen = []
    def command_result(command, cwd, env, direct=False):
        seen.append(command)
        assert cwd.exists() and env['HOME'] == str(cwd)
        assert not any('TOKEN' in key or 'SECRET' in key for key in env)
        if not directories or directories[-1] != cwd:
            directories.append(cwd)
        if str(tools['npm']) in command:
            for flag in ('--ignore-scripts', '--package-lock=false', '--fetch-retries=0',
                         '--allow-git=all', '--allow-remote=all'):
                assert flag in command
            configs = [value.split('=', 1)[1] for value in command if
                       value.startswith(('--userconfig=', '--globalconfig='))]
            assert len(set(configs)) == 2 and all(Path(path).read_text() == '' for path in configs)
        if len(seen) <= 2:
            assert not any('proxy' in key.lower() for key in env)
            return ({'result':'exited', 'returncode':0}, '1.0.0') if mode == 'control' else (
                    {'result':'timeout'}, '')
        output = ('ECONNREFUSED Failed to connect to 127.0.0.1 git ls-remote' if mode == 'unavailable'
                  else 'CONNECT tunnel failed, response 403 git ls-remote')
        return {'result':'exited', 'returncode':1}, output
    with patch.object(network, 'validate_endpoint'), \
         patch.object(network, 'udp', return_value={'result':'received'} if mode == 'control' else denied), \
         patch.object(source.os, 'access', return_value=False), \
         patch.object(source, 'execute', side_effect=command_result):
        result = source.sources(args, proxy)
    assert len(seen) == (2 if mode == 'control' else 5)
    assert not directories[-1].exists() and result['disposable_directory'] == 'removed'
    if mode != 'control':
        assert result['npm_git_https']['git_subprocess'] is True
assert len(set(directories)) == 4

# Reuse the complete #649 runner cycle, root staging and cleanup with source controls.
instances, services, installed = [], [], []
class FakeServers:
    def __init__(self, address):
        self.accepted = 0
        self.thread = Mock()
        self.thread.is_alive.return_value = True
        self.sockets = [Mock()]
        self.sockets[0].fileno.return_value = -1
        instances.append(self)
    def close(self):
        self.sources.close.assert_called_once()
def simulated_service(repo, staged, address, servers, port=None, expect_error=False, source_tools=None):
    assert source_tools == tools
    services.append((port is not None, expect_error))
    if port is None:
        servers.accepted += 1
        servers.sources.accepted += 2
def stage_command(command, **kwargs):
    if command[2] == 'install':
        assert command[3:9] == ['-o','root','-g','root','-m','0444']
        installed.append(Path(command[-1]).name)
    return subprocess.CompletedProcess(command, 0, '', '')
with patch.object(runtime.os, 'getuid', return_value=1000), \
     patch.object(runtime.subprocess, 'run', side_effect=stage_command), \
     patch.object(runtime.subprocess, 'check_output', return_value='/run/npm-registry-fixture-abcdefgh\n'), \
     patch.object(runtime, 'snapshot', return_value=('sockets','resolver')), \
     patch.object(runtime, 'load', side_effect=[SimpleNamespace(local_addresses=lambda: {'192.0.2.1'}),
                    SimpleNamespace(SourceEndpoints=lambda address: SimpleNamespace(accepted=0,close=Mock()))]), \
     patch.object(runtime, 'Servers', FakeServers), \
     patch.object(runtime, 'start_proxy', return_value=(Mock(),12348)), \
     patch.object(runtime, 'service', side_effect=simulated_service), \
     patch.object(runtime, 'stop_proxy'), patch.object(runtime, 'verify_proxy_stopped') as cleanup, \
     patch.object(Path, 'exists', return_value=False), patch('builtins.print'):
    runtime.runtime(repo, source_tools=tools)
assert installed == ['npm-registry-proxy.py','codex-network-boundary.py','npm-network-source-probe.py']
assert services == [(False,False),(True,False),(False,False),(True,True)] * 2
assert cleanup.call_count == 2 and all(server.accepted == 2 for server in instances)

for name in ('npm-network-source-probe.py', 'test-npm-network-sources.sh'):
    for workflow in (repo / '.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring', workflow)
assert 'fixtures=(.github/scripts/test-*.sh)' in (
    repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('network sources: boundary/failure/timeout/cleanup/dormant contracts passed', flush=True)

if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP network source socket/runtime: inherited Codex boundary; independent runner required')
    sys.exit(0)

# Actual npm/git, local HTTP controls and real trusted proxy 403. No upstream dial.
# Filter outcomes are mocked ONLY here; actual IP denial needs independent systemd.
for cycle in range(2):
    endpoints = source.SourceEndpoints('127.0.0.1')
    server = proxy.Proxy(0)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval':0.05})
    thread.start()
    args.source_port = endpoints.port
    args.proxy_port = server.server_address[1]
    try:
        with patch.object(network, 'validate_endpoint'), \
             patch.object(source.os, 'access', return_value=False), \
             patch.object(proxy, 'connect_registry', side_effect=AssertionError('external dial')) as dial:
            def control():
                args.mode = 'control'
                with patch.object(network, 'udp', return_value={'result':'received'}):
                    result = source.sources(args, proxy)
                assert result['npm_direct']['returncode'] == result['git_direct']['returncode'] == 0
                return endpoints.accepted
            accepted = control()
            assert accepted >= 2
            real_execute = source.execute
            def direct_denied(command, cwd, env, direct=False):
                if direct:
                    assert not any('proxy' in key.lower() for key in env)
                    return {'result':'timeout'}, ''
                assert set(env) == {'PATH','HOME','LC_ALL','GIT_CONFIG_NOSYSTEM',
                    'GIT_CONFIG_GLOBAL','GIT_TERMINAL_PROMPT','HTTPS_PROXY','https_proxy',
                    'HTTP_PROXY','http_proxy','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'}
                return real_execute(command, cwd, env)
            args.mode = 'restricted'
            with patch.object(network, 'udp', return_value=denied), \
                 patch.object(source, 'execute', side_effect=direct_denied):
                result = source.sources(args, proxy)
            for name in ('git_https', 'npm_git_https', 'npm_remote_tarball'):
                assert result[name]['proxy_http_status'] == 403, result
            assert endpoints.accepted == accepted, 'proxied source reached HTTP listener'
            assert control() > accepted, 'post-denial local control failed'
            server.shutdown()
            server.server_close()
            thread.join(3)
            runtime.verify_proxy_stopped(args.proxy_port)
            accepted = endpoints.accepted
            args.mode = 'unavailable'
            with patch.object(network, 'udp', return_value=denied), \
                 patch.object(source, 'execute', side_effect=direct_denied):
                result = source.sources(args, proxy)
            assert all(result[name]['proxy'] == 'unavailable' for name in
                       ('git_https', 'npm_git_https', 'npm_remote_tarball'))
            assert endpoints.accepted == accepted
            dial.assert_not_called()
    finally:
        if thread.is_alive():
            server.shutdown()
            server.server_close()
            thread.join(3)
        endpoints.close()
    assert not thread.is_alive() and server.socket.fileno() == -1
    print(f'network sources: real npm/git local controls/403/unavailable/cleanup cycle {cycle+1} passed', flush=True)

if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('network source runtime requires systemd on the regression runner')
    print('SKIP network source runtime: systemd is not PID 1')
    sys.exit(0)
runtime.runtime(repo, source_tools=tools)
print('network sources: #649 registry proof/npm/git direct deny/HTTPS 403/fail-closed/repeat/cleanup runtime passed')
PY
