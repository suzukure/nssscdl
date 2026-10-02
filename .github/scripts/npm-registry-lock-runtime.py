#!/usr/bin/env python3
"""Dormant #661 integration fixture; no production bootstrap/handoff."""
import hashlib
import errno
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
RUNTIME_ROOTS = (Path('/usr'), Path('/opt/hostedtoolcache/node'))
TOOLCACHE_ROOT = Path('/opt/hostedtoolcache/node')
SERVICE_UID = SERVICE_GID = 65534


def load(repo, name):
    spec = importlib.util.spec_from_file_location(name, repo / '.github/scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def runtime_provenance(node, npm, scope=None):
    """Check launcher paths, every link hop and ancestors before copying/executing.

    Trusted setup may write its own runtime; the nobody workload must not. Link
    mode 0777 is not a write grant: link replacement is governed by its parent.
    This is a pre-workload check, not protection from concurrent trusted setup.
    """
    owners = {0, os.getuid()}
    groups = {0, os.getgid(), *os.getgroups()} - {SERVICE_GID}
    assert SERVICE_UID not in owners, 'setup identity overlaps workload'
    entries = {}

    def inspect(path):
        assert any(path.is_relative_to(root) or root.is_relative_to(path)
                   for root in RUNTIME_ROOTS), ('runtime path outside trusted roots', str(path))
        info = path.lstat()
        assert info.st_uid in owners, ('unsafe runtime source/parent owner', str(path), info.st_uid)
        if not stat.S_ISLNK(info.st_mode):
            assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'unsafe runtime source type'
            assert info.st_mode & 0o002 == 0 and (info.st_mode & 0o020 == 0 or info.st_gid in groups), \
                ('unsafe runtime source/parent write boundary', str(path), info.st_gid, stat.S_IMODE(info.st_mode))
            # Mode bits alone do not exclude a named-user/group ACL write grant.
            try:
                os.getxattr(path, 'system.posix_acl_access', follow_symlinks=False)
            except OSError as error:
                assert error.errno == errno.ENODATA, ('runtime ACL inspection failed', str(path), error.errno)
            else:
                raise AssertionError(('runtime access ACL unsupported', str(path)))
        entries[str(path)] = info.st_uid
        return info

    def resolve(selected, scope=None):
        assert selected.is_absolute() and '..' not in selected.parts, 'unsafe runtime input path'
        pending, current, hops = list(selected.parts[1:]), Path('/'), 0
        inspect(current)
        while pending:
            part = pending.pop(0)
            if part == '..':
                current = current.parent
                continue
            if part == '.':
                continue
            candidate = current / part
            info = inspect(candidate)
            if stat.S_ISLNK(info.st_mode):
                hops += 1
                assert hops <= 40, 'runtime symlink loop'
                target = Path(os.readlink(candidate))
                target = target if target.is_absolute() else current / target
                if scope:
                    assert Path(os.path.abspath(target)).is_relative_to(scope), 'npm runtime symlink escape'
                pending = list(target.parts[1:]) + pending
                current = Path('/')
            else:
                assert not pending or stat.S_ISDIR(info.st_mode), 'non-directory runtime ancestor'
                current = candidate
        assert any(current.is_relative_to(root) for root in RUNTIME_ROOTS), 'runtime source outside trusted roots'
        if scope:
            assert current.is_relative_to(scope), 'npm runtime symlink escape'
        return current

    node_source, npm_source = resolve(node, scope), resolve(npm, scope)
    assert all(stat.S_ISREG(inspect(path).st_mode) for path in (node_source, npm_source)), \
        'runtime entry must be a regular file'
    npm_root = npm_source.parent.parent
    assert npm_root.name == 'npm' and npm_source.name == 'npm-cli.js'
    for selected in npm_root.rglob('*'):
        resolve(selected, npm_root)
    return {'node_sha256': hashlib.sha256(node.read_bytes()).hexdigest(),
            'npm_cli_sha256': hashlib.sha256(npm.read_bytes()).hexdigest(),
            'node_source': str(node_source), 'npm_source': str(npm_source),
            'source_owners': sorted(set(entries.values())),
            'write_boundary': 'trusted-setup-before-workload; nobody UID/GID excluded; root-owned service copy'}


def select_runtime():
    """Explicit installed Node 24/x64 identity, matching the Node hardening fixture.

    PATH is never a source candidate. Ambiguity is an error, not permission to
    select the latest version or fall back to a host launcher. Validate all source
    hops/ancestors and the npm tree before executing even a version command.
    """
    candidates = list(TOOLCACHE_ROOT.glob('24.*/x64'))
    assert len(candidates) == 1, ('trusted runtime candidate not unique', len(candidates))
    prefix = candidates[0]
    assert re.fullmatch(r'24\.\d+\.\d+', prefix.parent.name), 'unsupported toolcache version'
    node, npm = prefix / 'bin/node', prefix / 'bin/npm'
    provenance = runtime_provenance(node, npm, scope=prefix)
    cli = prefix / 'lib/node_modules/npm/bin/npm-cli.js'
    assert provenance['node_source'] == str(node), 'Node identity outside selected distribution'
    assert provenance['npm_source'] == str(cli), 'npm identity outside selected distribution'
    metadata = json.loads((cli.parent.parent / 'package.json').read_bytes())
    assert metadata['name'] == 'npm' and metadata['bin']['npm'] == 'bin/npm-cli.js', 'npm pairing mismatch'
    assert re.fullmatch(r'\d+\.\d+\.\d+', metadata['version']), 'unsupported npm identity'
    versions = []
    for args in ([str(node), '--version'], [str(node), str(npm), '--version']):
        result = subprocess.run(args, check=True, capture_output=True, text=True,
                                timeout=10, cwd='/', env=ENV)
        versions.append(result.stdout.strip())
    assert versions == ['v' + prefix.parent.name, metadata['version']], 'Node/npm version pairing mismatch'
    return node, npm, {**provenance, 'selected_root': str(prefix),
                       'node_version': versions[0], 'npm_version': versions[1]}


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


def runtime(repo):
    assert os.getuid() != 0, 'independent runtime requires non-root runner UID'
    node, npm, provenance = select_runtime()
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
