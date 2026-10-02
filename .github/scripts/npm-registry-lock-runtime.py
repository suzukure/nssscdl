#!/usr/bin/env python3
"""Dormant #661/#662 generation and trusted validation; no production wiring."""
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
TOOLCACHE_ROOT = Path('/opt/hostedtoolcache/node')
SERVICE_UID = SERVICE_GID = 65534


def load(repo, name):
    spec = importlib.util.spec_from_file_location(name, repo / '.github/scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def runtime_hashes(node, npm):
    return {'node_sha256': hashlib.sha256(node.read_bytes()).hexdigest(),
            'npm_cli_sha256': hashlib.sha256(npm.read_bytes()).hexdigest()}


def runtime_provenance(node, npm, scope):
    """Source identity/containment only; trusted setup is the source trust root.

    Host ancestor modes are not workload isolation. That boundary is established
    separately on the root-owned staged snapshot before any workload starts.
    """
    def resolve(selected, containment):
        assert selected.is_absolute() and '..' not in selected.parts, 'unsafe runtime input path'
        pending, current, hops = list(selected.parts[1:]), Path('/'), 0
        while pending:
            part = pending.pop(0)
            if part == '..':
                current = current.parent
                continue
            if part == '.':
                continue
            candidate = current / part
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode):
                hops += 1
                assert hops <= 40, 'runtime symlink loop'
                target = Path(os.readlink(candidate))
                target = target if target.is_absolute() else current / target
                assert Path(os.path.abspath(target)).is_relative_to(containment), 'runtime symlink escape'
                pending = list(target.parts[1:]) + pending
                current = Path('/')
            else:
                assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'unsafe runtime source type'
                assert not pending or stat.S_ISDIR(info.st_mode), 'non-directory runtime ancestor'
                current = candidate
        assert current.is_relative_to(containment), 'runtime source outside selected distribution'
        return current

    node_source, npm_source = resolve(node, scope), resolve(npm, scope)
    assert all(stat.S_ISREG(path.lstat().st_mode) for path in (node_source, npm_source)), \
        'runtime entry must be a regular file'
    npm_root = npm_source.parent.parent
    assert npm_root.name == 'npm' and npm_source.name == 'npm-cli.js'
    for selected in npm_root.rglob('*'):
        resolve(selected, npm_root)
    return {**runtime_hashes(node, npm), 'node_source': str(node_source), 'npm_source': str(npm_source)}


def normalize_staging_acls(staged):
    """Trusted setup only: remove inherited ACLs from the fresh copy, never sources.

    Physical traversal leaves symlink targets untouched. Missing tooling or any
    removal error stops setup; staged_snapshot independently verifies the result.
    """
    assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged)), 'unsafe ACL normalization path'
    subprocess.run(['sudo', '-n', '/usr/bin/setfacl', '--remove-all', '--remove-default',
                    '--recursive', '--physical', '--', str(staged)],
                   check=True, timeout=15, env=ENV)


def assert_no_acl(path):
    for attribute in ('system.posix_acl_access', 'system.posix_acl_default'):
        try:
            os.getxattr(path, attribute, follow_symlinks=False)
        except OSError as error:
            assert error.errno == errno.ENODATA, ('staged ACL inspection failed', str(path), attribute, error.errno)
        else:
            raise AssertionError(('unexpected staged ACL', str(path), attribute))


def staged_snapshot(root, token, manifest_hash, provenance):
    """Verify the workload boundary, including ELF closure, before/after service."""
    assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}/root', str(root)), 'unsafe staging path'
    def inspect(path):
        info = path.lstat()
        assert info.st_uid == info.st_gid == 0, ('unsafe staged owner', str(path))
        if stat.S_ISLNK(info.st_mode):
            npm_root = root / 'runtime/npm'
            assert path.is_relative_to(npm_root), 'unexpected staged symlink'
            # Check every hop, even an escape which eventually returns inside.
            current, seen = path, set()
            while current.is_symlink():
                assert current not in seen, 'staged symlink loop'
                seen.add(current)
                target = Path(os.readlink(current))
                assert not target.is_absolute(), 'absolute staged symlink'
                current = Path(os.path.abspath(current.parent / target))
                assert current.is_relative_to(npm_root), 'staged symlink escape'
            assert current.resolve(strict=True).is_relative_to(npm_root), 'staged symlink escape'
        else:
            assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'unsafe staged type'
            assert info.st_mode & 0o7022 == 0, ('unsafe staged mode', str(path))
            assert_no_acl(path)
    for path in (*reversed(root.parents), root):
        inspect(path)
        assert path.is_dir() and not path.is_symlink(), 'unsafe staged parent'
    for entry in root.rglob('*'):
        if any(entry.is_relative_to(root / name) for name in ('project', 'tmp')):
            continue
        inspect(entry)
    for name in ('project', 'tmp'):
        directory = root / name
        info = directory.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == SERVICE_UID and info.st_gid == SERVICE_GID
        assert info.st_mode & 0o7022 == 0, 'unsafe workload directory mode'
        for path in (directory, *directory.rglob('*')):
            assert not path.is_symlink(), 'unexpected workload symlink'
            assert_no_acl(path)
    assert json.loads((root / 'boundary.json').read_bytes())['token'] == token, 'boundary marker mismatch'
    snapshot = (root / 'runtime/manifest.json').read_bytes()
    assert hashlib.sha256(snapshot).hexdigest() == manifest_hash, 'manifest snapshot mismatch'
    assert (root / 'project/package.json').read_bytes() == snapshot, 'manifest changed'
    hashes = runtime_hashes(root / 'runtime/node', root / 'runtime/npm/bin/npm-cli.js')
    assert all(hashes[key] == provenance[key] for key in hashes), 'staged runtime hash mismatch'
    return hashes


def select_runtime():
    """Match Node hardening's descending installed Node 24/x64 path selection.

    PATH is never a source candidate; an invalid selected pair fails closed.
    """
    candidates = sorted(TOOLCACHE_ROOT.glob('24.*/x64'), reverse=True)
    assert candidates, 'trusted Node 24 runtime unavailable'
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


def build_root(repo, root, node, npm, token, manifest_snapshot=None):
    lifecycle = load(repo, 'npm-lifecycle-boundary-runtime')
    lifecycle.build_root(repo, root, node, npm, token)
    value = {'name': 'registry-lock-project', 'version': '1.0.0',
             'dependencies': {'is-number': '7.0.0'}, 'scripts': lifecycle.scripts(token, 'project')}
    lifecycle.filesystem(repo).validate_manifest(repo, value)
    # Exact caller snapshot or fixture input; no workspace/dependency source copy.
    snapshot = json.dumps(value, sort_keys=True).encode() if manifest_snapshot is None else manifest_snapshot
    validator = load(repo, 'prepare-product-npm')
    validator.manifest_dependencies(validator.parse(snapshot))
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


def contract_identities(repo):
    # Trusted base sources, never the restricted runtime copies. Source hashes
    # identify the exact contracts without forking their policy/command logic.
    sources = {
        'canonical_validator': 'prepare-product-npm.py',
        'bootstrap_command': 'npm-initial-lock-probe.js',
        'lifecycle_proof': 'npm-initial-lock-runtime.py',
        'registry': 'npm-registry-proxy.py',
        'network': 'npm-registry-boundary-runtime.py',
        'network_primitive': 'codex-network-boundary.py',
        'network_sources': 'npm-network-source-probe.py',
        'filesystem': 'npm-filesystem-boundary-runtime.py',
        'filesystem_probe': 'npm-filesystem-source-probe.js',
        'lifecycle_boundary': 'npm-lifecycle-boundary-runtime.py',
        'lifecycle_probe': 'npm-lifecycle-script-probe.js',
        'generation_probe': 'npm-registry-lock-probe.js',
        'registry_adapter': 'npm-registry-lock-adapter.js',
        'runtime': 'npm-registry-lock-runtime.py',
    }
    return {key: {'source': name, 'sha256': hashlib.sha256(
        (repo / '.github/scripts' / name).read_bytes()).hexdigest()}
        for key, name in sources.items()}


def command_contract(repo, node, command):
    """Evaluate #660's command constructor only; never spawn npm or bootstrap."""
    assert isinstance(command, list) and all(isinstance(arg, str) for arg in command)
    ports = [arg for arg in command if arg.startswith('--registry=')]
    assert len(ports) == 1
    match = re.fullmatch(r'--registry=http://127\.0\.0\.1:(\d+)/', ports[0])
    assert match, 'unknown bootstrap registry contract'
    assert initial_command(repo, node, int(match[1])) == command, 'bootstrap command mismatch'
    return command


def initial_command(repo, node, port):
    # Execute the trusted #660 constructor, not a copied command definition.
    javascript = """const fs = require('node:fs'), m = {exports:{}};
new Function('require','module',fs.readFileSync(process.argv[1],'utf8'))(
  name => name === './filesystem-probe.js' ? {} : require(name), m);
console.log(JSON.stringify(m.exports.command('lock', Number(process.argv[2]))));
"""
    result = subprocess.run([str(node), '-e', javascript,
        str(repo / '.github/scripts/npm-initial-lock-probe.js'), str(port)],
        check=True, capture_output=True, text=True, timeout=10, cwd='/', env=ENV)
    return json.loads(result.stdout)


def read_pair(validator, manifest_directory, project):
    def read(path, name):
        fd = validator.directory(path)
        try:
            data = validator.read_input(fd, name)
            validator.require(data is not None, 'missing-generated-input')
            return data
        finally:
            os.close(fd)
    snapshot = read(manifest_directory, 'manifest.json')
    validator.require(read(project, 'package.json') == snapshot, 'manifest-mutated')
    return snapshot, read(project, 'package-lock.json')


def verify_handoff(validator, artifact, expected):
    """Only the trusted in-memory expectation can authorize a handoff."""
    fd = validator.directory(artifact)
    try:
        info = os.fstat(fd)
        validator.require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
                          'unsafe-handoff-directory')
        assert_no_acl(artifact)
        validator.require(set(os.listdir(fd)) == {'package.json', 'package-lock.json', 'provenance.json'},
                          'unexpected-handoff-artifact')
        values = {}
        for name in ('package.json', 'package-lock.json', 'provenance.json'):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            validator.require(info.st_uid == os.getuid() and info.st_mode & 0o022 == 0,
                              'unsafe-handoff-file')
            assert_no_acl(artifact / name)
            values[name] = validator.read_input(fd, name)
        record = validator.parse(values['provenance.json'])
        validator.require(record == expected, 'provenance-mismatch')
        validator.require(record['artifact_path'] == str(artifact) and record['artifact_id'] == artifact.name
                          and record['schema_version'] == 1 and record['status'] == 'validated'
                          and record['validation'] == 'pass', 'invalid-handoff-identity')
        validator.require(hashlib.sha256(values['package.json']).hexdigest() == record['manifest_sha256']
                          and hashlib.sha256(values['package-lock.json']).hexdigest() == record['lock_sha256'],
                          'handoff-hash-mismatch')
        validator.validate_lock(validator.parse(values['package.json']),
                                validator.parse(values['package-lock.json']))
        # Re-read after canonical validation; never authorize changed bytes.
        validator.require(all(validator.read_input(fd, name) == data for name, data in values.items()),
                          'handoff-mutated')
        return record
    finally:
        os.close(fd)


def freeze_candidate(repo, root, run_root, manifest_snapshot, trusted, evidence):
    """Caller must have stopped/collected the service and verified post snapshot.

    trusted is retained in orchestration memory before workload start. Workload
    evidence is a claim to cross-check, never the source of manifest/runtime trust.
    run_root is private to the distinct trusted UID, outside RootDirectory/workspace.
    """
    validator = load(repo, 'prepare-product-npm')
    validator.require(os.getuid() != SERVICE_UID, 'workload-handoff-owner')
    validator.require(set(trusted) == {'manifest_sha256', 'runtime_source', 'staged_runtime_hashes',
                      'generation_id', 'generation_root', 'run_id', 'contracts'}, 'missing-trusted-evidence')
    validator.require(re.fullmatch(r'[0-9a-f]{32}', trusted['generation_id']) is not None
                      and trusted['generation_root'] == str(root.parent)
                      and trusted['run_id'] == run_root.name, 'generation-identity-mismatch')
    validator.require(trusted['contracts'] == contract_identities(repo), 'unknown-contract-identity')
    digest = hashlib.sha256(manifest_snapshot).hexdigest()
    validator.require(digest == trusted['manifest_sha256'], 'trusted-manifest-mismatch')
    source = trusted['runtime_source']
    hashes = trusted['staged_runtime_hashes']
    validator.require(all(hashes[key] == source[key] for key in ('node_sha256', 'npm_cli_sha256')),
                      'runtime-hash-mismatch')
    validator.require(evidence['status'] == 'pass' and evidence['candidate'] == 'package-lock.json'
                      and evidence['manifest_hash'] == digest
                      and evidence['node'] == source['node_version'] and evidence['npm'] == source['npm_version']
                      and evidence['markers'] == [] and evidence['node_modules'] is False
                      and (evidence['metadata_requests'] > 0 or
                           evidence['metadata_requests'] == 0 and not validator.manifest_dependencies(
                               validator.parse(manifest_snapshot))) and evidence['tarball_requests'] == 0
                      and evidence['dependency_execution_path'] == 'not-entered', 'generation-evidence-mismatch')
    command_contract(repo, Path(source['node_source']), evidence['command'])
    manifest_bytes, lock_bytes = read_pair(validator, root / 'runtime', root / 'project')
    lock_hash = hashlib.sha256(lock_bytes).hexdigest()
    validator.require(manifest_bytes == manifest_snapshot and lock_hash == evidence['lock_hash'],
                      'generation-hash-mismatch')
    # Freeze bytes in trusted memory before validation. The canonical parser also
    # rejects duplicate keys; the validator owns all source/integrity/manifest rules.
    validator.validate_lock(validator.parse(manifest_bytes), validator.parse(lock_bytes))
    validator.require(read_pair(validator, root / 'runtime', root / 'project') == (manifest_bytes, lock_bytes),
                      'candidate-mutated')
    fd = validator.directory(run_root)
    artifact = None
    try:
        info = os.fstat(fd)
        validator.require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
                          'unsafe-run-root')
        assert_no_acl(run_root)
        validator.require(not any(run_root == path or run_root in path.parents or path in run_root.parents
                          for path in (repo, root)), 'overlapping-handoff-path')
        artifact = Path(tempfile.mkdtemp(prefix='validated-lock-', dir=f'/proc/self/fd/{fd}'))
        artifact = run_root / artifact.name
        current = run_root.stat()
        validator.require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino), 'run-root-changed')
        expected = {**trusted, 'schema_version': 1, 'status': 'validated', 'validation': 'pass',
                    'lock_sha256': lock_hash, 'generated_lock_sha256': lock_hash,
                    'bootstrap_command': evidence['command'],
                    'lifecycle_result': 'dependency-execution-path-not-entered',
                    'artifact_path': str(artifact), 'artifact_id': artifact.name}
        for name, data in (('package.json', manifest_bytes), ('package-lock.json', lock_bytes),
                           ('provenance.json', (json.dumps(expected, sort_keys=True) + '\n').encode())):
            target = artifact / name
            target.write_bytes(data)
            target.chmod(0o400)
        verify_handoff(validator, artifact, expected)
        validator.require(read_pair(validator, root / 'runtime', root / 'project') == (manifest_bytes, lock_bytes),
                          'candidate-mutated')
        return artifact, expected
    except BaseException:
        if artifact is not None:
            shutil.rmtree(artifact)
        raise
    finally:
        os.close(fd)


def run_fixture(repo, node, npm, registry, network, servers, port, provenance, unavailable=False,
                manifest_snapshot=None, run_root=None):
    boundary = load(repo, 'npm-filesystem-boundary-runtime')
    staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                  '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
    assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged))
    token = uuid.uuid4().hex
    trusted_run = None
    artifact = expected = None
    try:
        if run_root is None:
            trusted_run = tempfile.TemporaryDirectory(prefix='npm-validated-handoff-')
            run_root = Path(trusted_run.name)
        with tempfile.TemporaryDirectory(prefix='npm-registry-lock-build-') as build:
            root = Path(build) / 'root'
            if manifest_snapshot is None:
                digest = build_root(repo, root, node, npm, token)
                manifest_snapshot = (root / 'runtime/manifest.json').read_bytes()
                bootstrap = False
            else:
                digest = build_root(repo, root, node, npm, token, manifest_snapshot)
                bootstrap = True
            copied = runtime_hashes(root / 'runtime/node', root / 'runtime/npm/bin/npm-cli.js')
            assert all(copied[key] == provenance[key] for key in copied), 'runtime copy hash mismatch'
            subprocess.run(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')],
                           check=True, timeout=15, env=ENV)
        subprocess.run(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)],
                       check=True, timeout=10, env=ENV)
        normalize_staging_acls(staged)
        subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)], check=True, timeout=5, env=ENV)
        root = staged / 'root'
        subprocess.run(['sudo', '-n', 'chown', '-R', 'nobody:nogroup',
                        str(root / 'project'), str(root / 'tmp')], check=True, timeout=5, env=ENV)
        staged_hashes = staged_snapshot(root, token, digest, provenance)
        # Retain trusted inputs in parent memory, never in workload-writable files.
        trusted = {'manifest_sha256': digest, 'runtime_source': dict(provenance),
                   'staged_runtime_hashes': dict(staged_hashes), 'generation_id': token,
                   'generation_root': str(staged), 'run_id': run_root.name,
                   'contracts': contract_identities(repo)}
        record = {'token': token, 'manifest_hash': digest, 'proxy_port': port, 'proxy_uid': os.getuid(),
                  'address': servers.address, 'direct_port': servers.port,
                  'expect_unavailable': unavailable, 'hidden': {
                      'workspace-root': str(repo), 'repository-head': str(repo / '.git/HEAD'),
                      'host-env': '/usr/bin/env', 'host-os-release': '/etc/os-release',
                      'staging-root': str(staged)}}
        if bootstrap:
            validator = load(repo, 'prepare-product-npm')
            record['bootstrap'] = True
            record['bootstrap_dependencies'] = validator.manifest_dependencies(validator.parse(manifest_snapshot))
        accepts = servers.accepted
        evidence = boundary.service(repo, root, record, observer=lambda unit, done:
            registry.observe_properties(unit, root / 'runtime', network, done))
        assert staged_snapshot(root, token, digest, provenance) == staged_hashes
        assert servers.accepted == accepts, 'direct/fallback reached trusted listener'
        assert (root / 'project/package.json').read_bytes() == (root / 'runtime/manifest.json').read_bytes()
        if unavailable:
            assert evidence == {'status': 'pass', 'fail_closed': 'official-registry-unavailable', 'npm_started': False}
            assert not (root / 'project/package-lock.json').exists()
        else:
            assert evidence['candidate'] == 'package-lock.json' and evidence['manifest_hash'] == digest
            assert (evidence['metadata_requests'] > 0 or bootstrap and
                    not record['bootstrap_dependencies'] and evidence['metadata_requests'] == 0)
            assert evidence['tarball_requests'] == 0
            assert evidence['markers'] == [] and evidence['node_modules'] is False
            artifact, expected = freeze_candidate(repo, root, run_root,
                                                  manifest_snapshot, trusted, evidence)
        print(json.dumps({**evidence, 'runtime_source': provenance, 'staged_runtime_hashes': staged_hashes}), flush=True)
        return (artifact, expected) if bootstrap else str(staged)
    finally:
        try:
            subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)], check=True, timeout=10, env=ENV)
            assert not staged.exists(), 'registry lock root cleanup failed'
            if artifact is not None:
                # This is the #645 acceptance handoff, after generation cleanup.
                validator = load(repo, 'prepare-product-npm')
                print(json.dumps(verify_handoff(validator, artifact, expected), sort_keys=True), flush=True)
        except BaseException:
            if artifact is not None:
                shutil.rmtree(artifact)
            raise
        finally:
            if trusted_run is not None:
                trusted_run.cleanup()
                assert not Path(trusted_run.name).exists(), 'handoff cleanup failed'


def generate_validated(repo, manifest_snapshot, run_root):
    """#691 explicit dormant entry: exact bytes, existing generation/freeze only.

    Caller owns a private, run-local output root. No candidate bytes are returned;
    generation, proxy and listener cleanup must finish before handoff succeeds.
    """
    validator = load(repo, 'prepare-product-npm')
    validator.require(os.getuid() not in (0, SERVICE_UID), 'unsafe-parent-identity')
    validator.require(type(manifest_snapshot) is bytes and len(manifest_snapshot) <= validator.MAX_INPUT,
                      'invalid-bootstrap-snapshot')
    validator.manifest_dependencies(validator.parse(manifest_snapshot))
    node, npm, provenance = select_runtime()
    registry = load(repo, 'npm-registry-boundary-runtime')
    network = load(repo, 'codex-network-boundary')
    addresses = sorted(network.local_addresses())
    validator.require(bool(addresses), 'boundary-address-unavailable')
    before, workspace = registry.snapshot(repo), workspace_state(repo)
    staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                  '/run/npm-registry-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
    assert re.fullmatch(r'/run/npm-registry-fixture-[A-Za-z0-9]{8}', str(staged))
    servers = proxy = None
    port = None
    try:
        subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)], check=True, timeout=5, env=ENV)
        for name in ('npm-registry-proxy.py', 'codex-network-boundary.py'):
            subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-g', 'root', '-m', '0444',
                            str(repo / '.github/scripts' / name), str(staged / name)],
                           check=True, timeout=5, env=ENV)
        servers = registry.Servers(addresses[0])
        servers.address = addresses[0]
        assert network.tcp(addresses[0], servers.port) == {'result': 'connected'}
        assert network.udp(addresses[0], servers.port) == {'result': 'received'}
        proxy, port = registry.start_proxy(staged)
        result = run_fixture(repo, node, npm, registry, network, servers, port, provenance,
                             manifest_snapshot=manifest_snapshot, run_root=run_root)
        assert network.tcp(addresses[0], servers.port) == {'result': 'connected'}
        assert network.udp(addresses[0], servers.port) == {'result': 'received'}
    finally:
        try:
            if proxy is not None:
                registry.stop_proxy(proxy)
                registry.verify_proxy_stopped(port)
        finally:
            try:
                if servers is not None:
                    servers.close()
            finally:
                subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)],
                               check=True, timeout=10, env=ENV)
                assert not staged.exists(), 'trusted proxy source cleanup failed'
    assert registry.snapshot(repo) == before, 'host socket/resolver integrity changed'
    assert workspace_state(repo) == workspace, 'workspace changed'
    verify_handoff(validator, *result)
    return result


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
