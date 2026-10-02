#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import base64
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

repo = Path(sys.argv[1]).resolve()
scripts = repo / '.github/scripts'

def load(name):
    spec = importlib.util.spec_from_file_location(name, scripts / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

helper = load('npm-locked-preparation')
validator = helper.validator
registry = load('npm-registry-boundary-runtime')
proxy = load('npm-registry-proxy')
network = load('codex-network-boundary')
filesystem = load('npm-filesystem-boundary-runtime')
integration = load('npm-registry-lock-runtime')
orchestrator = load('product-npm-orchestrator')
manifest = {'name': 'locked-fixture', 'version': '1.0.0', 'dependencies': {'example': '1.2.3'}}
lock = {'name': manifest['name'], 'version': '1.0.0', 'lockfileVersion': 3,
        'packages': {'': manifest, 'node_modules/example': {'version': '1.2.3',
        'resolved': validator.REGISTRY + 'example/-/example-1.2.3.tgz',
        'integrity': 'sha512-' + base64.b64encode(bytes(64)).decode()}}}
inputs = tuple(json.dumps(value).encode() for value in (manifest, lock))

def reject(call):
    try:
        call()
    except (validator.Rejected, AssertionError, OSError, subprocess.SubprocessError):
        return
    raise AssertionError('unsafe restricted preparation accepted')

source_hashes = {name: validator.sha((scripts / name).read_bytes()) for name in helper.SOURCES}

with tempfile.TemporaryDirectory(prefix='locked-worker-mock-') as temporary:
    staged = Path(temporary)
    frozen, root = staged / 'root/runtime/inputs', staged / 'root/project/preparation'
    frozen.mkdir(parents=True)
    root.mkdir(parents=True, mode=0o700)
    npm = staged / 'root/runtime/npm/bin/npm-cli.js'
    npm.parent.mkdir(parents=True)
    (npm.parent.parent / 'npmrc').write_bytes(b'')
    node = staged / 'root/runtime/node'
    for name, data in zip(orchestrator.INPUTS, inputs):
        (frozen / name).write_bytes(data)
    args = SimpleNamespace(workspace=frozen, run_root=root, node=node, npm=npm,
                           proxy_port=12345, unit='codex-network-probe-' + 'a'*32 + '.service')
    calls = []
    def run(command, cwd, env, timeout=180):
        calls.append(command)
        assert set(env) == {'PATH', 'HOME', 'LC_ALL'}
        if command[-1] == '--version':
            return b'24.0.0\n' if len(command) == 2 else b'11.0.0\n'
        assert command[:3] == [str(node), str(npm), 'ci']
        assert command[-6:] == ['--proxy=http://127.0.0.1:12345',
            '--https-proxy=http://127.0.0.1:12345', '--noproxy=', '--strict-ssl=true',
            '--fetch-retries=0', '--fetch-timeout=10000']
        assert '--ignore-scripts' in command and '--registry=' + validator.REGISTRY in command
        cache = Path(next(value.split('=', 1)[1] for value in command if value.startswith('--cache=')))
        assert not list(cache.iterdir())
        (cache / 'warm').write_bytes(b'cache')
        return b''
    with patch.object(helper, '__file__', str(staged / 'npm-locked-preparation.py')), \
         patch.object(helper, 'load', return_value=proxy), \
         patch.object(helper, 'source_snapshot', return_value={}), \
         patch.object(proxy, 'verify_boundary', return_value={'mode': 'restricted'}) as boundary, \
         patch.object(validator, 'run', side_effect=run), \
         patch.dict(os.environ, {'HTTPS_PROXY': 'secret', 'NPM_TOKEN': 'secret'}):
        original_runner = validator.run
        evidence = helper.worker(args)
        assert boundary.call_count == 1 and len(calls) == 3
        assert evidence['status'] == 'pass' and evidence['proxy_target'] == proxy.TARGET
        assert helper.pair(frozen) == inputs
        for reason in ('proxy-unavailable', 'allowlist-mismatch', 'explicit-deny-missing',
                       'network-properties-mismatch'):
            calls.clear()
            with patch.object(proxy, 'verify_boundary', side_effect=AssertionError(reason)):
                reject(lambda: helper.worker(args))
            assert calls == [], 'npm started without boundary'
        with patch.object(validator, 'run', side_effect=validator.Rejected('partial-cache')):
            reject(lambda: helper.worker(args))
        assert validator.run is original_runner, 'canonical runner patch leaked'
    # Export only after collection; input/path/unsafe cache mismatch stops copy.
    result = evidence['preparation']
    trusted = staged / 'trusted'
    trusted.mkdir(mode=0o700)
    exported = helper.export(result, staged, trusted, inputs)
    assert helper.pair(Path(exported['preparation_path'])) == inputs
    cache = Path(result['cache_path'])
    (cache / 'escape').symlink_to(frozen)
    reject(lambda: helper.export(result, staged, trusted, inputs))
    (cache / 'escape').unlink()
    os.link(cache / 'warm', cache / 'hardlink')
    reject(lambda: helper.export(result, staged, trusted, inputs))
    (cache / 'hardlink').unlink()
    for mutation in ({'cache_path': '/tmp/cache'}, {'manifest_hash': 'wrong'},
                     {'preparation_path': '/tmp/product-npm-escape'}):
        reject(lambda: helper.export({**result, **mutation}, staged, trusted, inputs))

# The shared helper cannot execute canonical preparation in its trusted parent.
with tempfile.TemporaryDirectory(prefix='locked-unavailable-') as temporary:
    base = Path(temporary)
    workspace, trusted = base / 'workspace', base / 'trusted'
    workspace.mkdir()
    trusted.mkdir(mode=0o700)
    for name, data in zip(orchestrator.INPUTS, inputs):
        (workspace / name).write_bytes(data)
    node, npm = Path(shutil.which('node')), Path(shutil.which('npm'))
    with patch.object(orchestrator.locked, 'prepare', side_effect=OSError('boundary unavailable')) as restricted, \
         patch.object(orchestrator.validator, 'prepare', side_effect=AssertionError('host fallback')) as direct:
        reject(lambda: orchestrator.prepare(workspace, trusted, node, npm).__enter__())
        assert restricted.call_count == 1 and direct.call_count == 0
        assert not list(trusted.iterdir()) and orchestrator.read_pair(workspace) == inputs

# Same #649 constructor/observer/cleanup, only the entry point and write root vary.
commands, stopped = [], []
def launch(command, **kwargs):
    commands.append(command)
    if '/usr/bin/systemd-run' in command:
        return SimpleNamespace(returncode=0, stdout=json.dumps({'status':'pass'}), stderr='')
    stopped.append(command)
    return SimpleNamespace(returncode=0, stdout='not-found\n', stderr='')
staged = Path('/run/npm-filesystem-fixture-AbCd1234')
tools = {'workspace': staged / 'root/runtime/inputs', 'run-root': staged / 'root/project/preparation',
         'node': staged / 'root/runtime/node', 'npm': staged / 'root/runtime/npm/bin/npm-cli.js'}
with patch.object(registry, 'load', return_value=network), \
     patch.object(registry, 'observe_properties') as observe, \
     patch.object(registry.subprocess, 'run', side_effect=launch), patch('builtins.print'):
    registry.service(repo, staged, '192.0.2.1', SimpleNamespace(port=12345, ipv6_port=12346),
                     12347, preparation_tools=tools)
assert observe.call_count == 1
command = commands[0]
for value in (*registry.hardening(repo), *network.PROPERTIES):
    assert '--property=' + value in command
assert '--property=RuntimeMaxSec=240s' in command
assert '--property=ReadWritePaths=' + str(staged / 'root/project') in command
assert str(staged / 'npm-locked-preparation.py') in command
assert any('stop' in call for call in stopped) and any('show' in call for call in stopped)
with patch.object(registry, 'load', return_value=network), \
     patch.object(registry.subprocess, 'run', side_effect=AssertionError('direct service started')):
    reject(lambda: registry.service(repo, staged, '192.0.2.1',
           SimpleNamespace(port=12345, ipv6_port=12346), preparation_tools=tools))

# Run the actual parent adapter/control flow with local staging doubles. Each
# failure must clean the same staged root and never execute parent-side npm.
for failure in (None, 'build', 'copy', 'pre-snapshot', 'source-copy', 'proxy', 'service', 'direct',
                'post-snapshot', 'sources', 'input', 'export', 'cleanup'):
    with tempfile.TemporaryDirectory(prefix='locked-parent-mock-') as temporary:
        base = Path(temporary)
        staged, workspace, trusted = (base / name for name in ('staged', 'workspace', 'trusted'))
        for directory in (staged, workspace, trusted):
            directory.mkdir(mode=0o700)
        for name, data in zip(orchestrator.INPUTS, inputs):
            (workspace / name).write_bytes(data)
        servers = SimpleNamespace(port=12345, ipv6_port=12346, accepted=0, close=lambda: None)
        service_calls, snapshot_calls, source_calls, cleanup = [], [], [], []
        def build(repo, root, node, npm, token, manifest):
            assert failure != 'build', 'build unavailable'
            for name in ('project', 'tmp', 'runtime/npm/bin'):
                (root / name).mkdir(parents=True, exist_ok=True)
        def run(command, **kwargs):
            if 'cp' in command:
                assert failure != 'copy', 'copy failed'
                shutil.copytree(command[-2], command[-1])
            elif 'rm' in command:
                cleanup.append(command)
                shutil.rmtree(staged)
                assert failure != 'cleanup', 'cleanup unconfirmed'
            return SimpleNamespace(returncode=0)
        def snapshot(*args):
            phase = 'post-snapshot' if snapshot_calls else 'pre-snapshot'
            snapshot_calls.append(phase)
            assert failure != phase, phase
            return {'node_sha256':'node', 'npm_cli_sha256':'npm'}
        def sources(*args):
            source_calls.append(True)
            return {} if failure == 'source-copy' or failure == 'sources' and len(source_calls) > 1 else source_hashes
        def control(*args):
            servers.accepted += 1
        def start(*args):
            assert failure != 'proxy', 'proxy unavailable'
            return SimpleNamespace(), 12347
        def service(repo, stage, address, listeners, port, preparation_tools):
            service_calls.append(preparation_tools)
            assert failure != 'service', 'restricted service failed'
            if failure == 'direct':
                servers.accepted += 1
            frozen = preparation_tools['workspace']
            if failure == 'input':
                (frozen / 'package-lock.json').write_bytes(b'{}')
            destination = preparation_tools['run-root'] / 'product-npm-mock'
            destination.mkdir(mode=0o700)
            (destination / 'cache').mkdir(mode=0o700)
            (destination / 'cache/warm').write_bytes(b'cache')
            if failure == 'export':
                (destination / 'cache/escape').symlink_to(workspace)
            for name, data in zip(orchestrator.INPUTS, inputs):
                (destination / name).write_bytes(data)
            return {'status':'pass', 'proxy_target':proxy.TARGET, 'network':{'mode':'restricted'},
                    'unit':'codex-network-probe-' + 'a'*32 + '.service', 'preparation':{
                    'status':'prepared', 'state':'locked', 'manifest_hash':validator.sha(inputs[0]),
                    'lockfile_hash':validator.sha(inputs[1]), 'cache_path':str(destination / 'cache'),
                    'preparation_path':str(destination), 'registry':validator.REGISTRY,
                    'source_contract':'npm-official-tarball-with-integrity-v1',
                    'node_version':'v24.0.0', 'npm_version':'11.0.0'}}
        modules = {'npm-registry-boundary-runtime':registry, 'codex-network-boundary':network,
                   'npm-filesystem-boundary-runtime':filesystem, 'npm-registry-lock-runtime':integration}
        original_match = helper.re.fullmatch
        def match(pattern, value):
            return True if pattern == r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}' and value == str(staged) \
                else original_match(pattern, value)
        mocks = [patch.object(helper, 'load', side_effect=lambda name: modules[name]),
             patch.object(helper, 'source_snapshot', side_effect=sources),
             patch.object(helper.re, 'fullmatch', side_effect=match),
             patch.object(helper.subprocess, 'check_output', return_value=str(staged)+'\n'),
             patch.object(helper.subprocess, 'run', side_effect=run),
             patch.object(filesystem, 'build_root', side_effect=build),
             patch.object(integration, 'runtime_hashes', return_value={'node_sha256':'node','npm_cli_sha256':'npm'}),
             patch.object(integration, 'normalize_staging_acls'),
             patch.object(integration, 'staged_snapshot', side_effect=snapshot),
             patch.object(network, 'local_addresses', return_value={'192.0.2.1'}),
             patch.object(network, 'probe', side_effect=control),
             patch.object(registry, 'Servers', return_value=servers),
             patch.object(registry, 'start_proxy', side_effect=start),
             patch.object(registry, 'stop_proxy'), patch.object(registry, 'verify_proxy_stopped'),
             patch.object(registry, 'service', side_effect=service),
             patch.object(orchestrator.locked, 'prepare', side_effect=helper.prepare),
             patch.object(orchestrator, 'offline_ready'),
             patch.object(orchestrator.validator, 'run', side_effect=AssertionError('host npm started'))]
        with ExitStack() as stack:
            for mock in mocks:
                stack.enter_context(mock)
            def attempt():
                with orchestrator.prepare(workspace, trusted, Path('/trusted/node'), Path('/trusted/npm')) as handoff:
                    assert handoff.verify()['status'] == 'prepared'
            if failure is None:
                attempt()
            else:
                reject(attempt)
        assert len(cleanup) == 1 and not staged.exists() and not list(trusted.iterdir())
        assert len(service_calls) <= 1, 'restricted preparation retried'
        assert orchestrator.read_pair(workspace) == inputs
print('locked preparation: parent staging/service/source/input/export/cleanup failure and workspace mocks passed')

for name in ('npm-locked-preparation', 'product-npm-orchestrator'):
    for workflow in (repo / '.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring', workflow)
assert 'validator.prepare(' not in (scripts / 'product-npm-orchestrator.py').read_text()
print('locked preparation: mandatory #649/transport/partial failure/export/cleanup/no host fallback mocks passed')

if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP locked preparation runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('locked preparation runtime requires systemd on the regression runner')
    print('SKIP locked preparation runtime: systemd is not PID 1')
    sys.exit(0)

# Formal runner only: observe official fixture metadata through #661's existing
# TLS/CONNECT adapter, construct a locked fixture directly, never bootstrap npm.
node, npm, provenance = integration.select_runtime()
assert os.getuid() not in (0, 65534)
before, workspace_state = registry.snapshot(repo), integration.workspace_state(repo)
proxy_root = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
    '/run/npm-registry-fixture-XXXXXXXX'], text=True, timeout=5, env=helper.ENV).strip())
process = None
try:
    subprocess.run(['sudo', '-n', 'chmod', '0755', str(proxy_root)], check=True, timeout=5)
    for name in ('npm-registry-proxy.py', 'codex-network-boundary.py'):
        subprocess.run(['sudo', '-n', 'install', '-m', '0444', str(scripts / name),
                        str(proxy_root / name)], check=True, timeout=5)
    process, port = registry.start_proxy(proxy_root)
    javascript = ("require(process.argv[1]).metadata(Number(process.argv[2]))"
                  ".then(v=>console.log(JSON.stringify(v))).catch(()=>process.exit(1));")
    metadata = json.loads(subprocess.check_output([str(node), '-e', javascript,
        str(scripts / 'npm-registry-lock-adapter.js'), str(port)], timeout=10, env=helper.ENV))
    registry.stop_proxy(process)
    registry.verify_proxy_stopped(port)
    manifest = {'name': 'locked-registry-fixture', 'version': '1.0.0',
                'dependencies': {'is-number': '7.0.0'}}
    lock = {'name': manifest['name'], 'version': '1.0.0', 'lockfileVersion': 3,
            'packages': {'': manifest, 'node_modules/is-number': {'version': '7.0.0',
             'resolved': metadata['dist']['tarball'], 'integrity': metadata['dist']['integrity']}}}
    validator.validate_lock(manifest, lock)
    with tempfile.TemporaryDirectory(prefix='locked-registry-workspace-') as workspace, \
         tempfile.TemporaryDirectory(prefix='locked-registry-handoff-') as trusted:
        workspace, trusted = Path(workspace), Path(trusted)
        inputs = tuple(json.dumps(value).encode() for value in (manifest, lock))
        for name, data in zip(orchestrator.INPUTS, inputs):
            (workspace / name).write_bytes(data)
        records = []
        for cycle in range(2):
            with orchestrator.prepare(workspace, trusted, node, npm) as handoff:
                record = handoff.verify()
                boundary = record['preparation_source_contract']['boundary']
                assert record['status'] == 'prepared' and boundary['proxy_target'] == proxy.TARGET
                assert boundary['network']['mode'] == 'restricted'
                assert boundary['network']['non_loopback_udp'] == {'result':'error', 'errno':1}
                assert boundary['runtime_hashes'] == integration.runtime_hashes(node, npm)
                assert record['node_version'] == provenance['node_version']
                assert record['npm_version'] == provenance['npm_version']
                records.append(record)
                print(json.dumps({'cycle':cycle+1, 'boundary':boundary,
                                  'offline_readiness':'pass', 'status':record['status']}), flush=True)
            assert orchestrator.read_pair(workspace) == inputs and not list(trusted.iterdir())
        assert records[0]['cache']['path'] != records[1]['cache']['path']
        # Same real service path, stopped proxy: reject without direct fallback.
        real_start = registry.start_proxy
        def unavailable(staged):
            process, port = real_start(staged)
            registry.stop_proxy(process)
            registry.verify_proxy_stopped(port)
            return process, port
        original_load = orchestrator.locked.load
        with patch.object(orchestrator.locked, 'load', side_effect=lambda name:
                          registry if name == 'npm-registry-boundary-runtime' else original_load(name)), \
             patch.object(registry, 'start_proxy', side_effect=unavailable):
            reject(lambda: orchestrator.prepare(workspace, trusted, node, npm).__enter__())
        assert orchestrator.read_pair(workspace) == inputs and not list(trusted.iterdir())
finally:
    try:
        if process is not None:
            registry.stop_proxy(process)
            registry.verify_proxy_stopped(port)
    finally:
        subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(proxy_root)], check=True, timeout=10)
    assert not proxy_root.exists()
    assert registry.snapshot(repo) == before and integration.workspace_state(repo) == workspace_state
print('locked preparation: orchestrator cold/repeated #649 registry-only/offline readiness/proxy unavailable/cleanup runtime passed')
PY
