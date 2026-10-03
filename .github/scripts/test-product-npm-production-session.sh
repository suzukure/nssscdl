#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
from types import SimpleNamespace
from unittest.mock import patch
import importlib.util

repo = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('session_parent', repo / '.github/scripts/product-npm-orchestrator.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
launcher = helper.load('product-npm-session-runtime')
offline = helper.offline
integration = helper.load('npm-registry-lock-runtime')
network = helper.load('codex-network-boundary')
registry = helper.load('npm-registry-boundary-runtime')
node, npm = Path(shutil.which('node')).resolve(), Path(shutil.which('npm')).resolve()
independent = Path('/proc/1/comm').read_text().strip() == 'systemd' and 'codex-' not in Path('/proc/self/cgroup').read_text()
if independent:
    node, npm, _ = integration.select_runtime()

# All filesystem artifacts are outside the trusted helper checkout. Only the
# local tarball transport and generation are synthetic; validators, provenance,
# preparation, session API, #677 command and offline readiness are real.
with tempfile.TemporaryDirectory(prefix='npm-production-session-', dir='/tmp') as temporary:
    base = Path(temporary)
    base.chmod(0o755)
    workspace, trusted, exports = (base / name for name in ('workspace', 'trusted', 'exports'))
    for path in (workspace, trusted, exports):
        path.mkdir(mode=0o700)
    token = uuid.uuid4().hex
    marker = base / 'side-effects'
    marker.write_bytes(b'')
    marker.chmod(0o666)
    seed = base / 'seed'
    offline.build_root(repo, seed, node, npm, token, marker)
    shutil.rmtree(workspace)
    shutil.copytree(seed / 'project', workspace)
    manifest, lock = helper.read_pair(workspace)
    shutil.rmtree(workspace / 'cache')
    (workspace / 'cache').mkdir(mode=0o700)
    seed_cache = seed / 'project/cache'
    helper.RootBoundary(workspace, repo, (trusted,), exports).verify()
    root = helper.CanonicalRoot(workspace)
    mount_id, device = root._snapshot[1:3]
    # Bounded observed coordinates, no raw mount table or evidence content.
    line = next(line for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[0] == mount_id)
    filesystem = line.split()[line.split().index('-') + 1]
    print(json.dumps({'mount_id': mount_id, 'device': device, 'filesystem': filesystem,
                      'canonical_root': 'pass'}), flush=True)
    mounts = helper._mount_table()
    for kind in ('device-mismatch', 'ambiguous'):
        rows = []
        for row in mounts:
            if row[0] == mount_id:
                if kind == 'ambiguous':
                    rows.append(('synthetic', *row[1:]))
                else:
                    row = (row[0], '999:999', *row[2:])
            rows.append(row)
        with patch.object(helper, '_mount_table', return_value=tuple(rows)):
            try:
                helper.CanonicalRoot(workspace)
            except helper.validator.Rejected:
                pass
            else:
                raise AssertionError('mount mismatch/ambiguity accepted')

    def preparation(frozen, output, node, npm):
        # Dedicated local archive transport; never registry or host cache.
        actual = helper.load('prepare-product-npm')
        original_run = actual.run
        def local_run(command, cwd, env, timeout=180):
            if command[-1] == '--version':
                return original_run(command, cwd, env, timeout)
            assert command[1] == 'ci'
            destination = Path(next(arg.split('=', 1)[1] for arg in command if arg.startswith('--cache=')))
            shutil.copytree(seed_cache, destination, dirs_exist_ok=True)
            return original_run([*command, '--offline'], cwd, env, timeout)
        with patch.object(actual, 'run', side_effect=local_run):
            result = actual.prepare(frozen, output, node, npm)
        Path(result['cache_path']).chmod(0o700)
        return {**result, 'boundary': {'fixture': 'local-tarball-only'}}

    provenance = {**integration.runtime_hashes(node, npm), 'node_source': str(node), 'npm_source': str(npm),
                  'node_version': subprocess.check_output([str(node), '--version'], text=True).strip(),
                  'npm_version': subprocess.check_output([str(node), str(npm), '--version'], text=True).strip()}
    def generate(repo, exact, output):
        # Real #662 freeze/verify over a deterministic synthetic candidate.
        assert exact == manifest
        with tempfile.TemporaryDirectory(prefix='generation-', dir=base) as generation:
            root = Path(generation) / 'root'
            (root / 'runtime').mkdir(parents=True)
            (root / 'project').mkdir()
            (root / 'runtime/manifest.json').write_bytes(exact)
            (root / 'project/package.json').write_bytes(exact)
            (root / 'project/package-lock.json').write_bytes(lock)
            expected = {'manifest_sha256': hashlib.sha256(exact).hexdigest(), 'runtime_source': provenance,
                        'staged_runtime_hashes': integration.runtime_hashes(node, npm),
                        'generation_id': uuid.uuid4().hex, 'generation_root': generation,
                        'run_id': output.name, 'contracts': integration.contract_identities(repo)}
            evidence = {'status': 'pass', 'candidate': 'package-lock.json',
                        'manifest_hash': expected['manifest_sha256'], 'lock_hash': hashlib.sha256(lock).hexdigest(),
                        'command': integration.initial_command(repo, node, 12345),
                        'node': provenance['node_version'], 'npm': provenance['npm_version'],
                        'markers': [], 'node_modules': False, 'metadata_requests': 1, 'tarball_requests': 0,
                        'dependency_execution_path': 'not-entered'}
            result = integration.freeze_candidate(repo, root, output, exact, expected, evidence)
        integration.verify_handoff(helper.validator, *result)
        return result

    def reset(origin):
        for name in ('consumer-started', 'package.json', 'package-lock.json'):
            (workspace / name).unlink(missing_ok=True)
        shutil.rmtree(workspace / 'node_modules', ignore_errors=True)
        if origin != 'no-manifest':
            (workspace / 'package.json').write_bytes(manifest)
            if origin == 'locked':
                (workspace / 'package-lock.json').write_bytes(lock)

    def prepared(stack, origin):
        stack.enter_context(patch.object(helper.locked, 'prepare', side_effect=preparation))
        handle = stack.enter_context(helper.prepare(workspace, trusted, node, npm))
        if origin == 'bootstrap':
            runtime = helper.load('npm-registry-lock-runtime')
            stack.enter_context(patch.object(helper, 'load', side_effect=lambda name:
                                runtime if name == 'npm-registry-lock-runtime' else original_load(name)))
            stack.enter_context(patch.object(runtime, 'generate_validated', side_effect=generate))
            validated = stack.enter_context(helper.bootstrap(handle, trusted))
            handle = stack.enter_context(helper.prepare_bootstrap(validated, trusted, node, npm))
        return handle
    original_load = helper.load

    # Local closed callback and entry-failure ownership checks always run.
    for origin in ('no-manifest', 'locked', 'bootstrap'):
        for failure in ('pass', 'consumer-fail', 'post-mutate', 'entry-fail'):
            reset(origin)
            with ExitStack() as stack:
                handle = prepared(stack, origin)
                called = []
                def consume(contract):
                    called.append(True)
                    assert set(contract) == {'policy', 'cache_path'}
                    assert contract['policy']['origin'] == origin
                    if failure == 'post-mutate':
                        (workspace / 'package-lock.json').write_bytes(lock + b' ')
                    return failure != 'consumer-fail'
                if failure == 'entry-fail':
                    stack.enter_context(patch.object(helper, 'RootBoundary', side_effect=ValueError('fixture')))
                result = helper.production_session(handle, consume, exports)
                assert result['status'] == ('pass' if failure == 'pass' else 'error'), result
                assert result['downstream_write_allowed'] is (failure == 'pass'), result
                if failure == 'entry-fail':
                    assert not called
                if origin == 'bootstrap' and failure in ('entry-fail', 'post-mutate'):
                    assert result['failure_ownership'] == 'dirty', result
                if origin == 'bootstrap' and failure == 'consumer-fail':
                    assert result['failure_ownership'] == 'removed', result
                assert not list(exports.iterdir())
            assert not list(trusted.iterdir())
    print('production session: local real npm / three origins / closed callback / failure ownership passed', flush=True)

    # Exercise the actual launcher composition locally without sudo/systemd.
    # Only root staging/service are mocked; parent session and source/command
    # checks execute. The service sees aliases, never trusted evidence paths.
    for failure in ('pass', 'service-fail', 'command-mismatch'):
        reset('no-manifest')
        with helper.prepare(workspace, trusted, node, npm) as handle, ExitStack() as stack:
            boundary = original_load('npm-filesystem-boundary-runtime')
            staged = Path('/run/npm-filesystem-fixture-abcdefgh')
            calls, launches = [], []
            # Fake filesystem objects are restricted to this staging pathname.
            original_lstat, original_exists = Path.lstat, Path.exists
            def metadata(path):
                if path in (staged, staged / 'root'):
                    return SimpleNamespace(st_uid=0, st_gid=0, st_mode=0o40755, st_dev=1, st_ino=2)
                return original_lstat(path)
            def build(repo, root, node, npm, token):
                for name in ('runtime/npm', 'project', 'tmp'):
                    (root / name).mkdir(parents=True, exist_ok=True)
                (root / 'project/package.json').write_bytes(b'{}')
            def service(repo, root, record, observer, command_factory):
                args = command_factory(repo, root, 'npm-filesystem-probe-' + token + '.service', record)
                launches.append(args)
                assert all(str(path) not in json.dumps(record) for path in (trusted, exports, repo))
                assert 'RootDirectory=' + str(root) in args
                if failure == 'service-fail':
                    raise AssertionError('synthetic service failure')
                return {'status': 'pass', 'consumer': 'completed', 'offline': False}
            stack.enter_context(patch.object(helper, 'load', side_effect=lambda name:
                boundary if name == 'npm-filesystem-boundary-runtime' else integration if name == 'npm-registry-lock-runtime'
                else network if name == 'codex-network-boundary' else original_load(name)))
            stack.enter_context(patch.object(network, 'local_addresses', return_value={'192.0.2.1'}))
            stack.enter_context(patch.object(boundary, 'build_root', side_effect=build))
            stack.enter_context(patch.object(boundary, 'command', return_value=['RootDirectory=' + str(staged / 'root'), '/runtime/env']))
            stack.enter_context(patch.object(boundary, 'service', side_effect=service))
            stack.enter_context(patch.object(integration, 'normalize_staging_acls'))
            stack.enter_context(patch.object(integration, 'runtime_hashes', return_value={'fixture': 'identity'}))
            stack.enter_context(patch.object(launcher, 'checked', side_effect=lambda args, timeout=15: calls.append(args)))
            stack.enter_context(patch.object(subprocess, 'check_output', return_value=str(staged) + '\n'))
            stack.enter_context(patch.object(Path, 'lstat', metadata))
            stack.enter_context(patch.object(helper, 'no_acl'))
            stack.enter_context(patch.object(Path, 'rglob', return_value=iter(())))
            stack.enter_context(patch.object(Path, 'exists', lambda path: False if path == staged else original_exists(path)))
            if failure == 'command-mismatch':
                actual = offline.candidate_command(repo, node)
                # check_output above does not affect the trusted constructor.
                stack.enter_context(patch.object(offline, 'candidate_command', side_effect=[actual, [*actual, '--offline=false']]))
            request = {'token': token, 'address': '192.0.2.1', 'direct_port': 12345,
                       'local_port': 12345, 'ipv6_port': 12346, 'missing': False, 'action': 'pass'}
            result = launcher.run_session(helper, handle, workspace, exports, node, npm, request, lambda *args: None)
            assert result['status'] == ('pass' if failure == 'pass' else 'error'), result
            assert result['downstream_write_allowed'] is (failure == 'pass')
            assert len(launches) == (0 if failure == 'command-mismatch' else 1)
            assert len([args for args in calls if args[2] == 'rm']) == (0 if failure == 'command-mismatch' else 1)
    print('production session: launcher aliases / service failure / command identity / bounded cleanup mocks passed', flush=True)

    if not independent:
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            raise SystemExit('production session runtime requires independent systemd runner; SKIP forbidden')
        print('SKIP production session runtime: independent systemd runner required; local checks only')
        sys.exit(0)

    assert os.getuid() != 0
    addresses = sorted(network.local_addresses())
    assert addresses, 'no assigned non-loopback IPv4; fail closed'
    servers = registry.Servers(addresses[0])
    before = registry.snapshot(repo)
    def observe(unit, staged, done):
        def validate(text):
            network.validate_properties(text)
            shown = subprocess.check_output(['sudo', '-n', 'systemctl', 'show', unit,
                   '--property=NoNewPrivileges', '--property=CapabilityBoundingSet',
                   '--property=AmbientCapabilities', '--property=SystemCallFilter'], text=True, timeout=5)
            properties = dict(line.split('=', 1) for line in shown.splitlines())
            if (properties.get('NoNewPrivileges') != 'yes'
                    or properties.get('CapabilityBoundingSet') != ''
                    or properties.get('AmbientCapabilities') != ''
                    or not properties.get('SystemCallFilter', '').startswith('~')
                    or not all(name in properties.get('SystemCallFilter', '') for name in
                               ('io_uring_setup', 'io_uring_enter', 'io_uring_register'))):
                raise ValueError('hardening-properties-mismatch')
        registry.observe_properties(unit, staged, SimpleNamespace(
            validate_properties=validate, Rejected=network.Rejected), done)
    record = {'token': token, 'address': addresses[0], 'direct_port': servers.port,
              'local_port': servers.port, 'ipv6_port': servers.ipv6_port, 'missing': False, 'action': 'pass'}
    try:
        offline.host_control(node, marker)
        assert network.tcp(addresses[0], servers.port) == {'result': 'connected'}
        assert network.udp(addresses[0], servers.port) == {'result': 'received'}
        offline.host_control(node, marker)
        for origin in ('no-manifest', 'locked', 'bootstrap'):
            failures = ('pass', 'consumer-fail', 'manifest-mutate', 'lock-mutate', 'cache-miss',
                        'corrupt-export', 'source-mismatch', 'command-mismatch', 'network-property', 'filesystem-property', 'isolation-failure')
            for failure in failures:
                if origin == 'no-manifest' and failure not in ('pass', 'consumer-fail', 'network-property', 'filesystem-property', 'isolation-failure'):
                    continue
                reset(origin)
                with ExitStack() as stack:
                    handle = prepared(stack, origin)
                    request = {**record, 'action': failure if failure in (
                               'consumer-fail', 'manifest-mutate', 'lock-mutate') else 'pass',
                               'missing': failure == 'cache-miss'}
                    if failure == 'cache-miss':
                        # Mutate only the consumable export after the trusted
                        # session verified it; source evidence remains untouched.
                        original = launcher.checked
                        def clear_cache(args, timeout=15):
                            if args[:4] == ['sudo', '-n', 'chown', '-R'] and 'nobody:nogroup' in args and args[-1].endswith('/cache'):
                                cache = Path(args[-1])
                                shutil.rmtree(cache); cache.mkdir(mode=0o700)
                            return original(args, timeout)
                        stack.enter_context(patch.object(launcher, 'checked', side_effect=clear_cache))
                    if failure == 'corrupt-export':
                        original = helper._cache_inventory
                        def corrupt(path, content_only=False):
                            if content_only and Path(path).is_relative_to(exports):
                                (Path(path) / 'corrupted').write_bytes(b'fixture')
                            return original(path, content_only)
                        stack.enter_context(patch.object(helper, '_cache_inventory', side_effect=corrupt))
                    if failure == 'source-mismatch':
                        stack.enter_context(patch.object(helper, 'contracts', return_value={}))
                    if failure == 'command-mismatch':
                        actual = offline.candidate_command(repo, node)
                        stack.enter_context(patch.object(offline, 'candidate_command', side_effect=[actual, [*actual, '--offline=false']]))
                    if failure in ('network-property', 'filesystem-property', 'isolation-failure'):
                        boundary = helper.load('npm-filesystem-boundary-runtime')
                        stack.enter_context(patch.object(helper, 'load', side_effect=lambda name:
                            boundary if name == 'npm-filesystem-boundary-runtime' else original_load(name)))
                        original = boundary.command
                        def unsupported(repo, root, unit, record):
                            args = original(repo, root, unit, record)
                            if failure == 'isolation-failure':
                                # A readable "hidden" alias must fail service
                                # preflight before npm or consumer execution.
                                value = json.loads(args[-1])
                                value['hidden']['host-env'] = '/runtime/env'
                                args[-1] = json.dumps(value)
                                return args
                            name = 'IPAddressDeny' if failure == 'network-property' else 'RootDirectory'
                            return [arg.replace('--property=' + name + '=', '--property=' + name + 'Unsupported=') for arg in args]
                        stack.enter_context(patch.object(boundary, 'command', side_effect=unsupported))
                    accepts = servers.accepted
                    result = launcher.run_session(helper, handle, workspace, exports, node, npm, request, observe)
                    assert servers.accepted == accepts, 'non-loopback consumer reached listener'
                    assert result['status'] == ('pass' if failure == 'pass' else 'error'), (origin, failure, result)
                    assert result['downstream_write_allowed'] is (failure == 'pass')
                    if failure in ('cache-miss', 'corrupt-export', 'source-mismatch', 'command-mismatch', 'network-property', 'filesystem-property', 'isolation-failure'):
                        assert not (workspace / 'consumer-started').exists()
                    if origin == 'bootstrap':
                        expected = ('retained' if failure == 'pass' else 'dirty' if failure in (
                                    'lock-mutate', 'corrupt-export', 'source-mismatch') else 'removed')
                        assert result['failure_ownership'] == expected, result
                    assert not list(exports.iterdir())
                assert not list(trusted.iterdir())
                print(json.dumps({'origin': origin, 'case': failure, 'runtime': 'pass'}), flush=True)
        assert network.tcp(addresses[0], servers.port) == {'result': 'connected'}
        assert network.udp(addresses[0], servers.port) == {'result': 'received'}
    finally:
        servers.close()
        assert all(server.fileno() == -1 for server in servers.sockets)
        assert registry.snapshot(repo) == before, 'host sockets/resolver changed'
        assert marker.read_bytes() == b'', 'lifecycle scripts executed'
print('production session: independent systemd / offline npm / isolation / network / post gate / cleanup passed')
PY
