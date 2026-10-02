#!/usr/bin/env python3
"""Dormant #661 integration fixture; no production bootstrap/handoff."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import uuid
import importlib.util

ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


def load(repo, name):
    spec = importlib.util.spec_from_file_location(name, repo / '.github/scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def runtime_provenance(node, npm):
    """Trusted setup source ownership/ancestors; service receives root-owned copies."""
    owners = {0, os.getuid()}
    entries = {}
    npm_root = npm.resolve().parent.parent
    assert npm_root.name == 'npm' and npm.resolve().name == 'npm-cli.js'
    for selected in (node, npm, *npm_root.rglob('*')):
        source = selected.resolve(strict=True)
        if selected.is_symlink():
            assert source.is_relative_to(npm_root), 'npm runtime symlink escape'
        for path in (source, *source.parents):
            info = path.lstat()
            assert info.st_uid in owners and info.st_mode & 0o022 == 0, \
                ('unsafe runtime source/parent', str(path))
            assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'unsafe runtime source type'
            entries[str(path)] = info.st_uid
    return {'node_sha256': hashlib.sha256(node.read_bytes()).hexdigest(),
            'npm_cli_sha256': hashlib.sha256(npm.read_bytes()).hexdigest(),
            'source_owners': sorted(set(entries.values())),
            'write_boundary': 'trusted-setup-before-workload; root-owned service copy'}


def build_root(repo, root, node, npm, token):
    lifecycle = load(repo, 'npm-lifecycle-boundary-runtime')
    lifecycle.build_root(repo, root, node, npm, token)
    value = {'name': 'registry-lock-project', 'version': '1.0.0',
             'dependencies': {'is-number': '7.0.0'}, 'scripts': lifecycle.scripts(token, 'project')}
    lifecycle.filesystem(repo).validate_manifest(repo, value)
    # Only exact fixture manifest input; no Product workspace or dependency source copy.
    snapshot = json.dumps(value, sort_keys=True).encode()
    (root / 'project/package.json').write_bytes(snapshot)
    (root / 'runtime/manifest.json').write_bytes(snapshot)
    shutil.rmtree(root / 'project/local')
    (root / 'project/local-control.tgz').unlink()
    for source, destination in (
        ('npm-initial-lock-probe.js', 'initial-lock-probe.js'),
        ('npm-registry-lock-probe.js', 'probe.js'),
        ('npm-registry-lock-adapter.js', 'npm-registry-lock-adapter.js'),
    ):
        shutil.copy2(repo / '.github/scripts' / source, root / 'runtime' / destination)
    builtin = root / 'runtime/npm/npmrc'
    assert not builtin.is_symlink()
    builtin.write_bytes(b'')
    for entry in root.rglob('*'):
        if not entry.is_symlink():
            entry.chmod(0o755 if entry.is_dir() or entry.stat().st_mode & 0o111 else 0o644)
    return hashlib.sha256(snapshot).hexdigest()


def workspace_state(repo):
    # Read-only repository observation, including pre-existing authorized diff.
    return tuple(subprocess.check_output(command, cwd=repo, env=ENV) for command in (
        ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        ['git', 'diff', '--binary'], ['git', 'diff', '--cached', '--binary']))


def run_fixture(repo, node, npm, registry, network, servers, port, provenance, unavailable=False):
    boundary = load(repo, 'npm-filesystem-boundary-runtime')
    staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                  '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
    assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged))
    token = uuid.uuid4().hex
    try:
        with tempfile.TemporaryDirectory(prefix='npm-registry-lock-build-') as build:
            root = Path(build) / 'root'
            digest = build_root(repo, root, node, npm, token)
            subprocess.run(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')],
                           check=True, timeout=15, env=ENV)
        subprocess.run(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)],
                       check=True, timeout=10, env=ENV)
        subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)], check=True, timeout=5, env=ENV)
        root = staged / 'root'
        subprocess.run(['sudo', '-n', 'chown', '-R', 'nobody:nogroup',
                        str(root / 'project'), str(root / 'tmp')], check=True, timeout=5, env=ENV)
        for entry in (root / 'runtime').rglob('*'):
            info = entry.lstat()
            assert info.st_uid == 0 and (entry.is_symlink() or info.st_mode & 0o022 == 0)
        assert hashlib.sha256((root / 'runtime/node').read_bytes()).hexdigest() == provenance['node_sha256']
        assert hashlib.sha256((root / 'runtime/npm/bin/npm-cli.js').read_bytes()).hexdigest() == provenance['npm_cli_sha256']
        record = {'token': token, 'manifest_hash': digest, 'proxy_port': port, 'proxy_uid': os.getuid(),
                  'address': servers.address, 'direct_port': servers.port,
                  'expect_unavailable': unavailable, 'hidden': {
                      'workspace-root': str(repo), 'repository-head': str(repo / '.git/HEAD'),
                      'host-env': '/usr/bin/env', 'host-os-release': '/etc/os-release',
                      'staging-root': str(staged)}}
        accepts = servers.accepted
        evidence = boundary.service(repo, root, record, observer=lambda unit, done:
            registry.observe_properties(unit, root / 'runtime', network, done))
        assert servers.accepted == accepts, 'direct/fallback reached trusted listener'
        assert (root / 'project/package.json').read_bytes() == (root / 'runtime/manifest.json').read_bytes()
        if unavailable:
            assert evidence == {'status': 'pass', 'fail_closed': 'official-registry-unavailable', 'npm_started': False}
            assert not (root / 'project/package-lock.json').exists()
        else:
            assert evidence['candidate'] == 'package-lock.json' and evidence['manifest_hash'] == digest
            assert evidence['metadata_requests'] > 0 and evidence['tarball_requests'] == 0
            assert evidence['markers'] == [] and evidence['node_modules'] is False
        print(json.dumps({**evidence, 'runtime_source': provenance}), flush=True)
        return str(staged)
    finally:
        subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)], check=True, timeout=10, env=ENV)
        assert not staged.exists(), 'registry lock root cleanup failed'


def runtime(repo, node, npm):
    assert os.getuid() != 0, 'independent runtime requires non-root runner UID'
    provenance = runtime_provenance(node, npm)
    registry = load(repo, 'npm-registry-boundary-runtime')
    network = load(repo, 'codex-network-boundary')
    addresses = sorted(network.local_addresses())
    assert addresses, 'no assigned non-loopback IPv4; fail closed'
    before, workspace = registry.snapshot(repo), workspace_state(repo)
    staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                  '/run/npm-registry-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
    assert re.fullmatch(r'/run/npm-registry-fixture-[A-Za-z0-9]{8}', str(staged))
    roots = []
    try:
        subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)], check=True, timeout=5, env=ENV)
        for name in ('npm-registry-proxy.py', 'codex-network-boundary.py'):
            subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-g', 'root', '-m', '0444',
                            str(repo / '.github/scripts' / name), str(staged / name)],
                           check=True, timeout=5, env=ENV)
        for cycle in range(2):
            servers, proxy = registry.Servers(addresses[0]), None
            servers.address = addresses[0]
            try:
                assert network.tcp(addresses[0], servers.port) == {'result': 'connected'}
                assert network.udp(addresses[0], servers.port) == {'result': 'received'}
                proxy, port = registry.start_proxy(staged)
                roots.append(run_fixture(repo, node, npm, registry, network, servers, port, provenance))
                registry.stop_proxy(proxy)
                registry.verify_proxy_stopped(port)
                roots.append(run_fixture(repo, node, npm, registry, network, servers, port, provenance, True))
                assert network.tcp(addresses[0], servers.port) == {'result': 'connected'}
                assert network.udp(addresses[0], servers.port) == {'result': 'received'}
            finally:
                try:
                    if proxy:
                        registry.stop_proxy(proxy)
                        registry.verify_proxy_stopped(port)
                finally:
                    servers.close()
            print(json.dumps({'cycle': cycle + 1, 'cleanup': 'pass'}), flush=True)
        assert len(set(roots)) == 4, 'integration root reused'
    finally:
        subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)], check=True, timeout=10, env=ENV)
        assert not staged.exists(), 'trusted proxy source cleanup failed'
        assert registry.snapshot(repo) == before, 'host socket/resolver integrity changed'
        assert workspace_state(repo) == workspace, 'workspace changed'
