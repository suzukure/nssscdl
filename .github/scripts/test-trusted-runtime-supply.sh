#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import yaml

repo = Path(sys.argv[1])
def load(name):
    spec = importlib.util.spec_from_file_location(name, repo / '.github/scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
supply, staging = load('trusted-runtime-supply'), load('product-runtime-staging')
roots = load('product-npm-orchestrator')

def rejected(call, reason=None):
    try:
        call()
    except (ValueError, OSError) as error:
        if reason:
            assert str(error) == reason, (reason, str(error))
        return
    raise AssertionError('unsafe supply accepted')

# Closed filesystem contract: ext4 positive, unsupported/ambiguous/device negative.
device = os.makedev(8, 1)
line = '10 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n'
with patch.object(Path, 'read_text', return_value=line):
    assert supply.filesystem(Path('/opt/runtime'), device)[4] == 'ext4'
for bad in (line.replace('ext4', 'overlay'), line.replace('ext4', 'btrfs'),
            line.replace('ext4', 'nfs4'), line + line, line.replace('8:1', '8:2'),
            line.replace('/ /', '/ /\\040'), 'malformed\n', ''):
    with patch.object(Path, 'read_text', return_value=bad):
        rejected(lambda: supply.filesystem(Path('/opt/runtime'), device))
for attribute in ('system.posix_acl_access', 'system.posix_acl_default',
                  'security.capability', 'user.unknown', 'system.nfs4_acl', 'security.selinux'):
    with patch.object(os, 'listxattr', return_value=[attribute]):
        rejected(lambda: supply.no_xattrs(1), 'unsupported-xattr-authority')
with patch.object(os, 'listxattr', side_effect=PermissionError):
    rejected(lambda: supply.no_xattrs(1))
for attribute in ('system.posix_acl_access', 'system.posix_acl_default', 'security.capability',
                  'security.selinux', 'system.nfs4_acl', 'trusted.metadata', 'unknown.metadata', 'user.'):
    with patch.object(os, 'listxattr', return_value=[attribute]):
        rejected(lambda: supply.source_xattrs(1), 'unsupported-xattr-authority')
with patch.object(os, 'listxattr', return_value=['user.metadata']), \
     patch.object(os, 'getxattr', return_value=b'private metadata'):
    attributes = supply.source_xattrs(1)
    assert attributes == (('user.metadata', supply.hashlib.sha256(b'private metadata').hexdigest()),)
    assert 'private metadata' not in repr(attributes)
with patch.object(os, 'listxattr', return_value=['user.metadata']), \
     patch.object(os, 'getxattr', side_effect=PermissionError):
    rejected(lambda: supply.source_xattrs(1))
for names, value in ((['user.' + str(i) for i in range(33)], b''),
                     (['user.' + 'x' * 251], b''), (['user.duplicate'] * 2, b''),
                     (['user.large'], b'x' * 65537)):
    with patch.object(os, 'listxattr', return_value=names), \
         patch.object(os, 'getxattr', return_value=value):
        rejected(lambda: supply.source_xattrs(1), 'source-xattr-limit')
with patch.object(os, 'listxattr', side_effect=[['user.metadata'], []]), \
     patch.object(os, 'getxattr', return_value=b''):
    rejected(lambda: supply.source_xattrs(1), 'source-drift')

# Synthetic authority namespace: real copying/hashing/no-follow/inode checks,
# virtual root ownership + ext4 only. This is NOT actual runner evidence.
real_stat, real_fstat = os.stat, os.fstat
real_rmtree = supply.shutil.rmtree
def synthetic_cleanup(path, *args, **kwargs):
    # Privileged cleanup is virtual in this fixture; make only actual fixture
    # directories writable so the local unprivileged runner can remove them.
    for directory in (Path(path), *Path(path).rglob('*')):
        if stat.S_ISDIR(directory.lstat().st_mode):
            directory.chmod(0o700)
    return real_rmtree(path, *args, **kwargs)
def root_info(info):
    values = {name: getattr(info, name) for name in (
        'st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
    return SimpleNamespace(**values, st_uid=0, st_gid=0)
def fake_stat(*args, **kwargs):
    return root_info(real_stat(*args, **kwargs))
with tempfile.TemporaryDirectory(prefix='supply-fixture-') as temporary, \
     patch.object(os, 'stat', side_effect=fake_stat), \
     patch.object(os, 'fstat', side_effect=lambda fd: root_info(real_fstat(fd))), \
     patch.object(os, 'getuid', return_value=0), patch.object(os, 'getgid', return_value=0), \
     patch.object(supply.shutil, 'rmtree', side_effect=synthetic_cleanup), \
     patch.object(supply, 'filesystem', return_value=('synthetic', '8:1', '/', '/', 'ext4', 'rw', 'rw')):
    area = Path(temporary)
    source, parent, workspace, second = [area / name for name in ('source', 'supply', 'workspace', 'second')]
    for path in (source, parent, workspace, second):
        path.mkdir(mode=0o700)
    node = source / 'node'
    node.write_bytes(b'synthetic-node')
    node.chmod(0o777)
    source.chmod(0o777)
    package = source / 'package.json'
    package.write_bytes(b'{"name":"@openai/codex","version":"0.159.3"}')
    rows = [dict(source=str(node), destination='/runtime/node', **{'class': 'node-runtime'}, executable=True),
            dict(source=str(package), destination='/runtime/package.json',
                 **{'class': 'codex-package'}, executable=False)]
    def evidence(values=rows):
        return {**supply.SETUP, 'sources': {
            r['source']: supply.observe(Path(r['source']), staging) for r in values}}
    def prepare(values=rows, setup=None, excluded=None):
        return supply.PreparedSupply(values, setup=evidence(values) if setup is None else setup,
            excluded_roots=[workspace] if excluded is None else excluded,
            root_api=roots.CanonicalRoot, staging_api=staging)
    rejected(lambda: staging.PreparedRuntime(rows, trusted_uids={0}, excluded_roots=[workspace],
             root_api=roots.CanonicalRoot), 'unsafe-writable-authority')
    prepared = prepare()
    setup = evidence()
    for key, bad in (('phase', 'post-model'), ('action_blob', '0' * 40), ('package', 'arbitrary'),
                     ('version', 'latest'), ('launcher_parity', False), ('launcher_parity', 1)):
        rejected(lambda key=key, bad=bad: prepare(setup={**setup, key: bad}), 'untrusted-setup-provenance')
    rejected(lambda: prepare(setup={**setup, 'extra': True}))
    rejected(lambda: prepare(setup={k: v for k, v in setup.items() if k != 'phase'}))
    rejected(lambda: prepare(setup={**setup, 'sources': {}}), 'source-drift')
    extra = {**setup, 'sources': {**setup['sources'], '/extra': None}}
    rejected(lambda: prepare(setup=extra), 'source-inventory-mismatch')
    rejected(lambda: prepare([rows[0], rows[0]]), 'duplicate-inventory')
    rejected(lambda: prepare(rows * 17, setup=setup), 'invalid-inventory')
    rejected(lambda: prepare([rows[0], {**rows[1], 'destination': rows[0]['destination']}]),
             'duplicate-inventory')
    # Sparse oversize input is rejected before any hashing or copying.
    large = source / 'large'
    with large.open('wb') as stream:
        stream.truncate(512 * 1024 * 1024 + 1)
    rejected(lambda: prepare([{**rows[0], 'source': str(large)}]), 'source-size-limit')
    large.unlink()
    # Bound the combined inventory independently of per-file size validation.
    third = source / 'third'
    third.write_bytes(b'third')
    values = rows + [{**rows[1], 'source': str(third), 'destination': '/runtime/third'}]
    bounded = evidence(values)
    oversized = {}
    for path, observed in bounded['sources'].items():
        identity = list(observed[1])
        identity[6] = 512 * 1024 * 1024
        oversized[path] = (observed[0], tuple(identity), *observed[2:])
    with patch.object(supply, 'observe', side_effect=lambda path, api: oversized[str(path)]):
        rejected(lambda: prepare(values, setup={**supply.SETUP, 'sources': oversized}),
                 'inventory-size-limit')
    third.unlink()
    # Same physical identity under distinct source names is never admitted.
    alias_evidence = {path: setup['sources'][str(node)] for path in setup['sources']}
    with patch.object(supply, 'observe', return_value=setup['sources'][str(node)]):
        rejected(lambda: prepare(setup={**setup, 'sources': alias_evidence}), 'aliased-source')
    rejected(lambda: prepare([rows[0], {**rows[1], 'destination': '/runtime/node/child'}]))
    rejected(lambda: prepare([{**rows[0], 'destination': '/runtime/../node'}]))
    rejected(lambda: prepare([{**rows[0], 'source': 'relative'}]))
    rejected(lambda: prepare([{**rows[0], 'recursive': True}]))
    rejected(lambda: prepare(excluded=[source]), 'excluded-source')
    rejected(lambda: prepare(excluded=[]), 'missing-excluded-roots')
    link = source / 'symlink'
    link.symlink_to(node)
    ancestor_link = area / 'source-alias'
    ancestor_link.symlink_to(source, target_is_directory=True)
    rejected(lambda: prepare([{**rows[0], 'source': str(ancestor_link / 'node')}]))
    fifo = source / 'fifo'
    os.mkfifo(fifo)
    for path in (link, fifo, source):
        rejected(lambda path=path: prepare([{**rows[0], 'source': str(path)}]))
    os.link(node, source / 'hardlink')
    rejected(prepare, 'unsafe-source-type')
    (source / 'hardlink').unlink()
    node.chmod(0o4777)
    rejected(prepare, 'special-source-mode')
    node.chmod(0o777)
    prepared = prepare()
    node.write_bytes(b'drift')
    rejected(prepared.verify, 'source-drift')
    prepared = prepare()
    original_digest = staging.digest_fd
    with patch.object(staging, 'digest_fd', return_value='0' * 64):
        rejected(prepared.verify, 'source-drift')
    with patch.object(supply, 'filesystem', return_value=('changed-mount',)):
        rejected(prepared.verify, 'source-drift')
    # A physical bind-alias result is honored without lexical fallback.
    with patch.object(roots.CanonicalRoot, 'overlaps', return_value=True):
        rejected(prepare, 'excluded-source')
    prepared = prepare()
    for place in (source, workspace):
        rejected(lambda place=place: prepared.snapshot(place).__enter__())
    original_overlap = roots.CanonicalRoot.overlaps
    with patch.object(roots.CanonicalRoot, 'overlaps', lambda left, right:
                      True if left.path == parent else original_overlap(left, right)):
        rejected(lambda: prepared.snapshot(parent).__enter__(), 'supply-overlap')
    with patch.object(os, 'getuid', return_value=1001):
        rejected(lambda: prepared.snapshot(parent).__enter__(), 'root-preparation-required')
    for attribute in ('system.posix_acl_access', 'security.capability', 'trusted.metadata', 'unknown.metadata'):
        with patch.object(os, 'listxattr', return_value=[attribute]):
            rejected(prepare, 'unsupported-xattr-authority')

    # Metadata is bound on files AND ancestors, without relying on ctime drift.
    for metadata_path in (node, source):
        metadata_inode = metadata_path.stat().st_ino
        metadata = {'user.metadata': b'original'}
        def metadata_names(fd):
            info = os.fstat(fd) if type(fd) is int else os.stat(fd)
            return list(metadata) if info.st_ino == metadata_inode else []
        with patch.object(os, 'listxattr', side_effect=metadata_names), \
             patch.object(os, 'getxattr', side_effect=lambda fd, name: metadata[name]):
            bound = prepare()
            with bound.snapshot(parent) as sealed:
                assert all(not os.listxattr(path) for path in sealed.path.rglob('*'))
                sealed.prepared_runtime().verify()
            for changed in ({'user.metadata': b'changed'}, {}, {'user.renamed': b'original'}):
                metadata.clear()
                metadata.update(changed)
                rejected(bound.verify, 'source-drift')
            metadata.clear()
            metadata['user.metadata'] = b'original'
            real_open = os.fdopen
            def metadata_copy_open(fd, mode):
                metadata['user.metadata'] = b'copy-time change'
                return real_open(fd, mode)
            with patch.object(os, 'fdopen', side_effect=metadata_copy_open):
                rejected(lambda: bound.snapshot(parent).__enter__(), 'source-drift')
            assert not list(parent.iterdir())

    # Copy-time drift never publishes a handle and removes the partial root.
    original_read = os.read
    changed = False
    def drift_read(fd, count):
        global changed
        result = original_read(fd, count)
        # Only mutate on the actual copy (hashing uses the same read API).
        if copying and not changed:
            node.write_bytes(b'copy-time drift')
            changed = True
        return result
    real_fdopen = os.fdopen
    copying = False
    def copy_open(fd, mode):
        global copying
        copying = True
        return real_fdopen(fd, mode)
    def snapshot_attempt():
        with prepared.snapshot(parent):
            raise AssertionError('drift published')
    with patch.object(os, 'read', side_effect=drift_read), patch.object(os, 'fdopen', side_effect=copy_open):
        rejected(snapshot_attempt, 'source-drift')
    assert changed and not list(parent.iterdir())

    for attack in (None, 'bytes', 'mode', 'directory-mode', 'extra', 'missing', 'symlink',
                   'hardlink', 'fifo', 'replace', 'directory', 'xattr', 'owner'):
        prepared = prepare()
        with prepared.snapshot(parent) as sealed:
            supply_root = sealed.path
            target = supply_root / 'runtime/node'
            assert target.read_bytes() == node.read_bytes()
            assert stat.S_IMODE(target.stat().st_mode) == 0o555
            assert stat.S_IMODE((supply_root / 'runtime/package.json').stat().st_mode) == 0o444
            assert target.stat().st_ino != node.stat().st_ino
            accepted = sealed.prepared_runtime()
            assert all(Path(r['source']).is_relative_to(supply_root) for r in accepted.inventory()['files'])
            with accepted.stage(second) as staged:
                staged.verify()
            sealed.verify()
            if attack is None:
                # Once sealed, writable original bytes are no longer authority.
                node.write_bytes(b'original changed after sealing')
                sealed.verify()
                sealed.prepared_runtime().verify()
                continue
            # Fixture runs without real root: temporarily permit local attacks.
            (supply_root / 'runtime').chmod(0o755)
            if attack == 'bytes':
                target.chmod(0o755)
                target.write_bytes(b'modified')
                target.chmod(0o555)
            elif attack == 'mode':
                target.chmod(0o777)
            elif attack == 'directory-mode':
                (supply_root / 'runtime').chmod(0o777)
            elif attack == 'extra':
                (supply_root / 'runtime/extra').write_bytes(b'extra')
            elif attack == 'missing':
                target.unlink()
            elif attack == 'symlink':
                target.unlink()
                target.symlink_to(node)
            elif attack == 'hardlink':
                os.link(target, supply_root / 'runtime/alias')
            elif attack == 'fifo':
                target.unlink()
                os.mkfifo(target)
            elif attack == 'directory':
                target.unlink()
                target.mkdir()
            elif attack == 'replace':
                target.unlink()
                target.write_bytes(node.read_bytes())
                target.chmod(0o555)
            if attack != 'directory-mode':
                (supply_root / 'runtime').chmod(0o555)
            if attack == 'xattr':
                with patch.object(os, 'listxattr', return_value=['user.unknown']):
                    rejected(sealed.prepared_runtime)
            elif attack == 'owner':
                with patch.object(os, 'fstat', side_effect=real_fstat):
                    rejected(sealed.prepared_runtime)
            else:
                rejected(sealed.prepared_runtime)
            # Restore write access only for unprivileged synthetic cleanup.
            (supply_root / 'runtime').chmod(0o755)
        assert not supply_root.exists() and not list(parent.iterdir()) and not list(second.iterdir())
        rejected(sealed.verify, 'expired-supply-root')
    prepared = prepare()
    with patch.object(supply.shutil, 'rmtree', side_effect=OSError('cleanup fixture')):
        def cleanup_attempt():
            with prepared.snapshot(parent):
                pass
        rejected(cleanup_attempt)
    for residual in parent.iterdir():
        (residual / 'runtime').chmod(0o755)
        supply.shutil.rmtree(residual)

# Prepared-only surface: no actual setup/privileged proof in PR regression.
assert not (repo / '.github/scripts/runtime-supply-proof.py').exists()
workflow = yaml.safe_load((repo / '.github/workflows/ai-workflow-regression.yml').read_text())
assert set(workflow['jobs']) == {'fixtures'}
regression = (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
assert 'sudo' not in regression and 'openai/codex-action@' not in regression
assert 'runtime-supply-proof' not in regression
developer = (repo / '.github/workflows/ai-developer.yml').read_text()
assert supply.ACTION_BLOB in developer and 'codex-cli 0.159.3' in developer
print('Trusted runtime supply: synthetic provenance / drift / authority / inventory / seal / cleanup / prepared-only PASS')
PY
