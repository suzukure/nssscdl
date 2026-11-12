#!/usr/bin/env python3
"""#677 dormant offline-ci fixture; no external requests or production wiring."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid
from unittest.mock import patch
import importlib.util

ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


def load(repo, name):
    spec = importlib.util.spec_from_file_location(name, repo / '.github/scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_cache(repo, project, node, npm, payload):
    """Local fixture transport ONLY. #645 still owns validation/preparation.

    Seed its fresh dedicated cache from a deterministic local archive, then run
    its actual ci with offline appended. No official registry or persistent cache.
    """
    helper = load(repo, 'prepare-product-npm')
    originals = tuple((project / name).read_bytes() for name in ('package.json', 'package-lock.json'))
    helper.validate_lock(*(helper.parse(value) for value in originals))
    original_run = helper.run
    with tempfile.TemporaryDirectory(prefix='npm-offline-ci-preparation-') as temporary:
        run_root = Path(temporary)
        run_root.chmod(0o700)
        archive = run_root / 'dependency.tgz'
        archive.write_bytes(payload)
        calls = []

        def offline(command, cwd, env, timeout=180):
            if command[-1] == '--version':
                return original_run(command, cwd, env, timeout)
            assert command[1] == 'ci', 'unexpected preparation operation'
            calls.append(command)
            flags = [arg for arg in command if arg.startswith(('--cache=', '--userconfig=', '--globalconfig='))]
            original_run([str(npm), 'cache', 'add', str(archive), '--offline', '--ignore-scripts',
                          *flags], cwd, env, timeout)
            return original_run([*command, '--offline'], cwd, env, timeout)

        with patch.object(helper, 'run', side_effect=offline):
            prepared = helper.prepare(project, run_root, node, npm)
        assert prepared['status'] == 'prepared' and len(calls) == 1, prepared
        assert tuple((project / name).read_bytes() for name in ('package.json', 'package-lock.json')) == originals
        destination = Path(prepared['preparation_path'])
        assert all((destination / name).read_bytes() == value for name, value in
                   zip(('package.json', 'package-lock.json'), originals))
        shutil.rmtree(project / 'cache')
        shutil.copytree(prepared['cache_path'], project / 'cache')
        assert not list(destination.glob('install-*')) and not list(destination.rglob('node_modules'))
    assert not run_root.exists(), 'preparation cleanup failed'
    return {key: prepared[key] for key in ('status', 'manifest_hash', 'lockfile_hash', 'node_version', 'npm_version')}


def build_root(repo, root, node, npm, token, host_marker, missing=False):
    initial = load(repo, 'npm-initial-lock-runtime')
    initial.build_root(repo, root, node, npm, token, host_marker)
    project = root / 'project'
    shutil.rmtree(project / 'local')
    (project / 'local-control.tgz').unlink()
    value = initial.dependency(repo, token)
    (project / 'fixture/package.json').write_text(json.dumps(value, sort_keys=True))
    payload = initial.archive(value, (project / 'lifecycle-marker.js').read_bytes())
    manifest = json.loads((project / 'package.json').read_bytes())
    lock = {'name': manifest['name'], 'version': manifest['version'], 'lockfileVersion': 3,
            'requires': True, 'packages': {
                '': {key: manifest[key] for key in ('name', 'version', 'dependencies')},
                'node_modules/' + initial.NAME: {'version': '1.0.0',
                    'resolved': 'https://registry.npmjs.org/' + initial.NAME + '/-/' + initial.NAME + '-1.0.0.tgz',
                    'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(payload).digest()).decode(),
                    'hasInstallScript': True}}}
    (project / 'package-lock.json').write_text(json.dumps(lock))
    prepared = prepare_cache(repo, project, node, npm, payload)
    if missing:
        shutil.rmtree(project / 'cache')
        (project / 'cache').mkdir()
    for name in ('package.json', 'package-lock.json', 'lifecycle-marker.js'):
        shutil.copy2(project / name, root / 'runtime' / name)
    shutil.copy2(project / 'package.json', root / 'runtime/manifest.json')
    for source, target in [('npm-offline-ci-probe.js', 'probe.js'),
                           ('npm-initial-lock-probe.js', 'initial-lock-probe.js'),
                           ('npm-registry-lock-probe.js', 'registry-lock-probe.js')]:
        shutil.copy2(repo / '.github/scripts' / source, root / 'runtime' / target)
    for entry in root.rglob('*'):
        if not entry.is_symlink():
            entry.chmod(0o755 if entry.is_dir() or entry.stat().st_mode & 0o111 else 0o644)
    assert host_marker.read_bytes() == b'' and not list((project / 'markers').iterdir())
    return prepared


def verify_inputs(repo, root, expected):
    helper = load(repo, 'prepare-product-npm')
    fd = helper.directory(root / 'project')
    try:
        actual = tuple(helper.read_input(fd, name) for name in ('package.json', 'package-lock.json'))
        assert actual == expected, 'trusted input mutation'
        helper.validate_lock(*(helper.parse(value) for value in actual))
        assert tuple(helper.read_input(fd, name) for name in ('package.json', 'package-lock.json')) == expected
    finally:
        os.close(fd)
    assert not list((root / 'project/markers').iterdir()), 'trusted marker observation failed'


def host_control(node, marker):
    code = "require('node:fs').appendFileSync(process.argv[1],'control')"
    subprocess.run(['sudo', '-n', '-u', 'nobody', '/usr/bin/env', '-i', str(node), '-e', code, str(marker)],
                   check=True, timeout=5, env=ENV)
    assert marker.read_text() == 'control', 'host sentinel control failed'
    marker.write_bytes(b'')


def candidate_command(repo, node):
    # Evaluate only the trusted constructor. No npm, networking or bootstrap.
    code = ("const fs=require('node:fs'),m={exports:{}};"
            "new Function('require','module',fs.readFileSync(process.argv[1],'utf8'))("
            "n=>n.startsWith('./')?{}:require(n),m);"
            "console.log(JSON.stringify(m.exports.command()));")
    result = subprocess.run([str(node), '-e', code, str(repo / '.github/scripts/npm-offline-ci-probe.js')],
                            capture_output=True, text=True, check=True, timeout=10, env=ENV)
    return json.loads(result.stdout)


def run_fixture(repo, node, npm, provenance, registry, network, servers, missing):
    integration = load(repo, 'npm-registry-lock-runtime')
    boundary = load(repo, 'npm-filesystem-boundary-runtime')
    staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                  '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
    assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged))
    token = uuid.uuid4().hex
    try:
        command = candidate_command(repo, node)
        with tempfile.TemporaryDirectory(prefix='npm-offline-ci-host-', dir='/tmp') as host:
            Path(host).chmod(0o755)
            marker = Path(host) / 'side-effects'
            marker.write_bytes(b'')
            marker.chmod(0o666)
            host_control(node, marker)
            with tempfile.TemporaryDirectory(prefix='npm-offline-ci-build-') as build:
                root = Path(build) / 'root'
                prepared = build_root(repo, root, node, npm, token, marker, missing)
                expected = tuple((root / 'project' / name).read_bytes() for name in ('package.json', 'package-lock.json'))
                digest = hashlib.sha256(expected[0]).hexdigest()
                subprocess.run(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')],
                               check=True, timeout=15, env=ENV)
            subprocess.run(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)], check=True, timeout=10, env=ENV)
            integration.normalize_staging_acls(staged)
            subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)], check=True, timeout=5, env=ENV)
            root = staged / 'root'
            subprocess.run(['sudo', '-n', 'chown', '-R', 'nobody:nogroup', str(root / 'project'), str(root / 'tmp')],
                           check=True, timeout=5, env=ENV)
            hashes = integration.staged_snapshot(root, token, digest, provenance)
            verify_inputs(repo, root, expected)
            record = {'token': token, 'missing': missing, 'address': servers.address,
                      'direct_port': servers.port, 'local_port': servers.port, 'ipv6_port': servers.ipv6_port,
                      'hidden': {'workspace-root': str(repo), 'repository-head': str(repo / '.git/HEAD'),
                                 'host-env': '/usr/bin/env', 'host-os-release': '/etc/os-release',
                                 'staging-root': str(staged), 'lifecycle-host-marker': str(marker)}}
            accepts = servers.accepted
            evidence = boundary.service(repo, root, record, observer=lambda unit, done:
                registry.observe_properties(unit, root / 'runtime', network, done))
            assert integration.staged_snapshot(root, token, digest, provenance) == hashes
            verify_inputs(repo, root, expected)
            assert servers.accepted == accepts, 'direct/fallback reached listener'
            assert marker.read_bytes() == b'', 'trusted host lifecycle side effect detected'
            assert evidence['install'] == ('ENOTCACHED' if missing else 'cache-only')
            assert evidence['markers'] == [] and evidence['direct_udp'] == 'EPERM' and evidence['localhost'] == 'pass'
            assert evidence['node'] == provenance['node_version'] and evidence['npm'] == provenance['npm_version']
            assert evidence['command'] == command and evidence['env'] == {'PATH': '/runtime', 'HOME': '/project', 'LC_ALL': 'C'}
            assert evidence['manifest_hash'] == digest and evidence['lock_hash'] == hashlib.sha256(expected[1]).hexdigest()
            host_control(node, marker)
            print(json.dumps({**evidence, 'host_side_effects': 0, 'preparation': prepared,
                              'runtime_source': provenance, 'staged_runtime_hashes': hashes}), flush=True)
        assert not Path(host).exists(), 'host sentinel cleanup failed'
        return str(staged)
    finally:
        subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)], check=True, timeout=10, env=ENV)
        assert not staged.exists(), 'offline-ci root cleanup failed'


def runtime(repo):
    assert os.getuid() != 0, 'independent runner must not be root'
    integration = load(repo, 'npm-registry-lock-runtime')
    node, npm, provenance = integration.select_runtime()
    registry = load(repo, 'npm-registry-boundary-runtime')
    network = load(repo, 'codex-network-boundary')
    addresses = sorted(network.local_addresses())
    assert addresses, 'no assigned non-loopback IPv4; fail closed'
    workspace, before = integration.workspace_state(repo), registry.snapshot(repo)
    roots = []
    try:
        for cycle in range(2):
            servers = registry.Servers(addresses[0])
            servers.address = addresses[0]
            try:
                for phase in ('pre', 'post'):
                    assert network.tcp(servers.address, servers.port) == {'result': 'connected'}, phase
                    assert network.udp(servers.address, servers.port) == {'result': 'received'}, phase
                    if phase == 'pre':
                        for missing in (False, True):
                            roots.append(run_fixture(repo, node, npm, provenance, registry, network, servers, missing))
                assert servers.accepted == 2, 'unexpected direct connection'
            finally:
                servers.close()
            assert all(server.fileno() == -1 for server in servers.sockets)
            print(json.dumps({'cycle': cycle + 1, 'cleanup': 'pass'}), flush=True)
        assert len(set(roots)) == 4, 'offline-ci root reused'
    finally:
        assert integration.workspace_state(repo) == workspace, 'workspace changed'
        assert registry.snapshot(repo) == before, 'host socket/resolver changed'
