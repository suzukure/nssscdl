#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import importlib.util
import ast
import io
import json
import os
from pathlib import Path
import stat
import sys
import subprocess
import tempfile
from contextlib import contextmanager, redirect_stdout
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
assert set(workflow['jobs']) == {'fixtures', 'shard_1', 'shard_2', 'regression_result'}
regression = (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
assert 'sudo' not in regression and 'openai/codex-action@' not in regression
assert 'runtime-supply-proof' not in regression
developer = (repo / '.github/workflows/ai-developer.yml').read_text()
assert supply.ACTION_BLOB in developer and 'codex-cli 0.159.3' in developer

# #747 fixtures never execute setup, sudo or an actual privileged proof.
proof = load('trusted-main-runtime-supply-proof')
proof_path = repo / '.github/scripts/trusted-main-runtime-supply-proof.py'
proof_workflow = repo / '.github/workflows/trusted-main-runtime-supply-proof.yml'
text = proof_workflow.read_text()
value = yaml.safe_load(text)
assert set(value) == {'name', True, 'permissions', 'jobs'}
assert value[True] == {'workflow_dispatch': None}
assert value['permissions'] == {'contents': 'read'}
assert set(value['jobs']) == {'proof'}
job = value['jobs']['proof']
assert set(job) == {'runs-on', 'timeout-minutes', 'steps'}
assert job['runs-on'] == 'ubuntu-24.04' and job['timeout-minutes'] == 10
steps = job['steps']
assert len(steps) == 5
assert [set(s) for s in steps] == [
    {'name', 'env', 'shell', 'run'}, {'name', 'uses', 'with'}, {'name', 'uses', 'with'},
    {'name', 'env', 'shell', 'run'}, {'name', 'env', 'shell', 'run'}]
assert steps[1]['uses'] == 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'
assert steps[1]['with'] == {'ref': '${{ github.sha }}', 'persist-credentials': False}
assert steps[2]['uses'] == 'openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e'
assert steps[2]['with'] == {
    'codex-version': '0.159.3', 'codex-home': '${{ runner.temp }}/runtime-supply-proof-home',
    'safety-strategy': 'unsafe', 'allow-users': '*'}
for index, mode in ((3, '--observe'), (4, '--prepare')):
    assert steps[index]['env'] == {'PROOF_SHA': '${{ github.sha }}'}
    assert steps[index]['shell'] == 'bash'
    assert steps[index]['run'] == (
        ('sudo -n ' if index == 4 else '') + '/usr/bin/env -i PATH="$PATH" PROOF_SHA="$PROOF_SHA" \\\n'
        '  /usr/bin/python3 -I .github/scripts/trusted-main-runtime-supply-proof.py ' + mode + '\n')
assert all(n not in text for n in ('secrets.', 'vars.', 'prompt:', 'openai-api-key:',
                                 'pull_request', 'github.event.inputs', 'continue-on-error', 'always()'))
assert steps[0]['env'] == {
    'PROOF_EVENT': '${{ github.event_name }}',
    'PROOF_DEFAULT_BRANCH': '${{ github.event.repository.default_branch }}',
    'PROOF_REF': '${{ github.ref }}', 'PROOF_SHA': '${{ github.sha }}',
    'PROOF_WORKFLOW_REF': '${{ github.workflow_ref }}',
    'PROOF_WORKFLOW_SHA': '${{ github.workflow_sha }}'}
with tempfile.TemporaryDirectory() as temporary:
    event = Path(temporary) / 'event.json'
    environment = {'PATH': os.environ['PATH'], 'GITHUB_EVENT_PATH': str(event),
                   'GITHUB_REPOSITORY': 'owner/repo', 'PROOF_EVENT': 'workflow_dispatch',
                   'PROOF_DEFAULT_BRANCH': 'main', 'PROOF_REF': 'refs/heads/main',
                   'PROOF_SHA': 'a' * 40, 'PROOF_WORKFLOW_SHA': 'a' * 40,
                   'PROOF_WORKFLOW_REF': 'owner/repo/.github/workflows/trusted-main-runtime-supply-proof.yml@refs/heads/main'}
    def gate(changes=None, inputs=None):
        event.write_text(json.dumps({'inputs': inputs}))
        return subprocess.run(['bash', '-euo', 'pipefail', '-c', steps[0]['run']],
                              env={**environment, **(changes or {})}, capture_output=True)
    assert gate().returncode == 0
    assert gate(inputs={}).returncode == 0
    for changes in ({'PROOF_EVENT': 'pull_request'}, {'PROOF_EVENT': 'pull_request_target'},
                    {'PROOF_EVENT': 'workflow_run'}, {'PROOF_REF': 'refs/heads/candidate'},
                    {'PROOF_REF': 'refs/tags/main'}, {'PROOF_DEFAULT_BRANCH': 'other'},
                    {'PROOF_WORKFLOW_REF': environment['PROOF_WORKFLOW_REF'].replace('@refs/heads/main', '@refs/heads/pr')},
                    {'PROOF_WORKFLOW_SHA': 'b' * 40}, {'PROOF_SHA': 'latest'},
                    {'PROOF_SHA': '$(touch NEVER)'}):
        assert gate(changes).returncode != 0, changes
    for inputs in ({'sha': 'b' * 40}, {'path': '/tmp/candidate'}, {'command': 'touch NEVER'},
                   {'version': 'latest'}, {'package': 'arbitrary'}, {'shell': 'bash'}, []):
        assert gate(inputs=inputs).returncode != 0
    assert not (Path.cwd() / 'NEVER').exists()

# Resolver layout comes from the installed pinned npm alias, not a free input.
with tempfile.TemporaryDirectory() as temporary:
    area = Path(temporary)
    package = area / '@openai/codex'
    native_package = package / 'node_modules/@openai/codex-linux-x64'
    (package / 'bin').mkdir(parents=True)
    native_package.mkdir(parents=True)
    (package / 'bin/codex.js').write_bytes(b'fixture launcher')
    node = area / 'node'
    node.write_bytes(b'fixture node')
    metadata = {'name': '@openai/codex', 'version': '0.159.3',
                'optionalDependencies': {'@openai/codex-linux-x64': 'npm:@openai/codex@0.159.3-linux-x64'}}
    (package / 'package.json').write_text(json.dumps(metadata))
    (native_package / 'package.json').write_text(json.dumps({'name': '@openai/codex', 'version': '0.159.3-linux-x64'}))
    with patch.object(proof.shutil, 'which', side_effect=lambda name: str(node if name == 'node' else package / 'bin/codex.js')), \
         patch.object(proof.os, 'uname', return_value=SimpleNamespace(machine='x86_64')):
        rows = proof.runtime_rows()
        assert len(rows) == 5 and rows[-1]['class'] == 'codex-native'
        assert rows[-1]['source'].endswith('/vendor/x86_64-unknown-linux-musl/bin/codex')
        (package / 'package.json').write_text(json.dumps({**metadata, 'version': 'latest'}))
        rejected(proof.runtime_rows, 'package-identity-mismatch')
        (package / 'package.json').write_text(json.dumps(metadata))
        (native_package / 'package.json').write_text('{"name":"arbitrary","version":"latest"}')
        rejected(proof.runtime_rows, 'native-identity-mismatch')

# Synthetic bounded observer: real no-follow read-only walk; no content/xattr value reads.
with tempfile.TemporaryDirectory() as temporary:
    area = Path(temporary)
    source = area / 'source'
    source.write_bytes(b'not disclosed')
    rows = [dict(source=str(source), **{'class': 'node-runtime'})]
    table = '10 1 8:1 / / rw - ext4 /dev/private rw\n'
    real_open = Path.open
    def mount_open(path, *args, **kwargs):
        return io.BytesIO(table.encode()) if str(path) == '/proc/self/mountinfo' else real_open(path, *args, **kwargs)
    # Existing policy stays real: only its kernel table/device is synthetic.
    with patch.object(Path, 'open', mount_open), patch.object(Path, 'read_text', return_value=table), \
         patch.object(supply, 'filesystem', return_value=('10', '8:1', '/', '/', 'ext4', 'rw', 'rw')), \
         patch.object(os, 'listxattr', return_value=['user.fixture']), \
         patch.object(os, 'getxattr', side_effect=AssertionError('xattr value read')), \
         patch.object(os, 'read', side_effect=AssertionError('file content read')), \
         patch.object(proof, 'SUPPLY_PARENT', area):
        result = proof.observation(rows, supply)
        assert result['status'] == 'error'  # sealed-parent rejects even user.*
        assert set(result) == {'schema', 'version', 'status', 'records'}
        assert result['records'][0]['ancestor_depth'] == len(source.parts) - 1
        assert result['records'][len(source.parts) - 1]['ancestor_depth'] == 0
        assert all(r['xattr_names'] == ['user.fixture'] for r in result['records'])
        encoded = json.dumps(result)
        assert len(encoded.encode()) < proof.MAX_OUTPUT
        assert all(v not in encoded for v in (str(source), '/dev/private', 'not disclosed', 'sha256'))
        with patch.object(os, 'listxattr', return_value=[]):
            assert proof.observation(rows, supply)['status'] == 'pass'
        with patch.object(os, 'listxattr', return_value=['security.unknown']):
            rejected_result = proof.observation(rows, supply)
            assert rejected_result['status'] == 'error'
            assert rejected_result['records'][0]['xattr_names'] == ['security.unknown']
        with patch.object(os, 'listxattr', side_effect=PermissionError(13, 'private path')):
            failure = proof.observation(rows, supply)
            assert failure['status'] == 'error' and failure['records'][0]['errno'] == 13
            assert 'private path' not in json.dumps(failure)
        with patch.object(os, 'listxattr', return_value=['user.' + str(i) for i in range(33)]):
            rejected(lambda: proof.observation(rows, supply), 'xattr-observation-limit')
        alias = area / 'alias'
        alias.symlink_to(source)
        failure = proof.observation([{'source': str(alias), 'class': 'node-runtime'}], supply)
        assert failure['status'] == 'error'
        assert any(r.get('reason') == 'descriptor-observation-failed' for r in failure['records'])
    # #742 observation: an unrelated escaped coordinate still rejects globally.
    unrelated = '11 1 8:1 / /unrelated\\040coordinate rw - ext4 /dev/private rw\n'
    table += unrelated
    with patch.object(Path, 'open', mount_open), patch.object(Path, 'read_text', return_value=table):
        diagnostic = proof.mount_diagnostics(Path('/opt/runtime'), os.makedev(8, 1), supply)
        assert diagnostic['reason'] == 'unsupported-mount-coordinate'
        assert diagnostic['escaped'] == [dict(mount_id='11', device='8:1', filesystem='ext4',
                                              coordinate_class='escaped', relation='unrelated')]
        assert '/unrelated' not in json.dumps(diagnostic)
    table = table.splitlines()[0].replace('ext4', 'overlay') + '\n'
    with patch.object(Path, 'open', mount_open), patch.object(Path, 'read_text', return_value=table):
        diagnostic = proof.mount_diagnostics(Path('/opt/runtime'), os.makedev(8, 1), supply)
        assert diagnostic['reason'] == 'unsupported-authority-filesystem'
        assert diagnostic['filesystem'] == 'overlay'

# Proof failures retain closed diagnostics; probes always drop to runner UID/GID.
blob = b'fixture action bundle'
expected_blob = proof.hashlib.sha1(b'blob ' + str(len(blob)).encode() + b'\0' + blob).hexdigest()
with patch.dict(os.environ, {'PROOF_SHA': 'a' * 40}), patch.object(Path, 'read_bytes', return_value=blob), \
     patch.object(proof.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'a' * 40 + b'\n', b'')) as checkout:
    proof.check_checkout(SimpleNamespace(ACTION_BLOB=expected_blob))
    assert checkout.call_args.kwargs['env'] == {'PATH': '/usr/bin:/bin'}
    rejected(lambda: proof.check_checkout(SimpleNamespace(ACTION_BLOB='b' * 40)), 'action-blob-mismatch')
    checkout.return_value = subprocess.CompletedProcess([], 0, b'b' * 40 + b'\n', b'')
    rejected(lambda: proof.check_checkout(SimpleNamespace(ACTION_BLOB=expected_blob)), 'checkout-sha-mismatch')
calls = []
with patch.object(proof.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001, pw_gid=1001)), \
     patch.object(proof.subprocess, 'run', side_effect=lambda *a, **k: calls.append((a, k)) or
                  subprocess.CompletedProcess(a[0], 0, b'codex-cli 0.159.3\n', b'')):
    proof.version_parity([{'source': '/fixed/' + p} for p in ('node', 'bin/codex.js', 'metadata', 'native-metadata', 'codex')])
assert len(calls) == 2
assert all(k['user'] == k['group'] == 1001 and k['extra_groups'] == ()
           and set(k['env']) == {'PATH', 'HOME', 'LC_ALL', 'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_PACKAGE_ROOT'}
           for _, k in calls)
with patch.object(proof.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001, pw_gid=1001)), \
     patch.object(proof.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'wrong\n', b'')):
    rejected(lambda: proof.version_parity([{'source': '/fixed/' + p} for p in
             ('node', 'bin/codex.js', 'metadata', 'native-metadata', 'codex')]), 'version-parity-failed')

# Pure composition proof: parent evidence precedes probes, handoff stays active,
# and cleanup failure cannot produce a success result. No real privileged call.
with tempfile.TemporaryDirectory() as temporary:
    order = []
    @contextmanager
    def snapshot(parent):
        order.append('snapshot')
        yield SimpleNamespace(verify=lambda: order.append('seal-verify'),
            prepared_runtime=lambda: SimpleNamespace(verify=lambda: order.append('handoff-verify')))
        order.append('cleanup')
    def constructor(rows, **kwargs):
        assert kwargs['setup']['sources'] == {'/fixed/node': 'parent-held-observation'}
        assert kwargs['excluded_roots'] == [repo]
        order.append('bind')
        return SimpleNamespace(snapshot=snapshot)
    mocked_supply = SimpleNamespace(SETUP=supply.SETUP,
        observe=lambda *args: order.append('capture') or 'parent-held-observation',
        PreparedSupply=constructor)
    fake_staging, fake_roots = object(), SimpleNamespace(CanonicalRoot=object())
    with patch.object(proof, 'load', side_effect=lambda name: fake_staging if name == 'product-runtime-staging' else fake_roots), \
         patch.object(proof, 'version_parity', side_effect=lambda rows: order.append('probe')), \
         patch.object(proof.os, 'getuid', return_value=0), patch.object(proof.os, 'getgid', return_value=0), \
         patch.object(proof, 'SUPPLY_PARENT', Path(temporary)):
        result = proof.prepare([{'source': '/fixed/node'}], mocked_supply)
        assert order == ['capture', 'probe', 'bind', 'snapshot', 'seal-verify', 'handoff-verify', 'cleanup']
        assert result['status'] == 'pass' and result['c0_decision'] == 'not-made'
        assert not list(Path(temporary).iterdir())
        @contextmanager
        def failed_cleanup(parent):
            yield SimpleNamespace(verify=lambda: None,
                prepared_runtime=lambda: SimpleNamespace(verify=lambda: None))
            raise OSError('private cleanup failure')
        with patch.object(mocked_supply, 'PreparedSupply', return_value=SimpleNamespace(snapshot=failed_cleanup)):
            rejected(lambda: proof.prepare([{'source': '/fixed/node'}], mocked_supply))
for args in ([], ['--prepare', '--path', '/candidate'], ['--observe', '--version', 'latest']):
    with patch.object(sys, 'argv', ['proof', *args]), patch.object(proof, 'check_checkout') as checkout, \
         redirect_stdout(io.StringIO()) as output:
        assert proof.main() == 1
        checkout.assert_not_called()
        assert json.loads(output.getvalue())['reason'] == 'invalid-proof-mode'
with patch.object(sys, 'argv', ['proof', '--observe']), patch.object(proof, 'check_checkout'), \
     patch.object(proof, 'runtime_rows', side_effect=RuntimeError('/private/token=value')), \
     redirect_stdout(io.StringIO()) as output:
    assert proof.main() == 1 and '/private' not in output.getvalue()
tree = ast.parse(proof_path.read_text())
assert 'sys.dont_write_bytecode = True' in proof_path.read_text()
assert not any(isinstance(n, ast.Attribute) and n.attr in ('system', 'getxattr', 'exec', 'eval') for n in ast.walk(tree))
print('Trusted main proof: synthetic trust gate / input rejection / secretless setup / bounded observer / unprivileged probes PASS')
print('Trusted runtime supply: synthetic provenance / drift / authority / inventory / seal / cleanup / prepared-only PASS')
PY
