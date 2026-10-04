#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
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
proof = load('runtime-supply-proof')
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
    rejected(lambda: prepare([rows[0], {**rows[1], 'destination': '/runtime/node/child'}]))
    rejected(lambda: prepare([{**rows[0], 'destination': '/runtime/../node'}]))
    rejected(lambda: prepare([{**rows[0], 'source': 'relative'}]))
    rejected(lambda: prepare([{**rows[0], 'recursive': True}]))
    rejected(lambda: prepare(excluded=[source]), 'excluded-source')
    rejected(lambda: prepare(excluded=[]), 'missing-excluded-roots')
    link = source / 'symlink'
    link.symlink_to(node)
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
    for attribute in ('system.posix_acl_access', 'security.capability', 'user.unknown'):
        with patch.object(os, 'listxattr', return_value=[attribute]):
            rejected(prepare, 'unsupported-xattr-authority')

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

# Secretless subprocess surface: version-only, bounded and no inherited env.
with patch.object(proof.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'codex-cli 0.159.3\n')) as run:
    assert proof.version(['/runtime/codex', '--version'], Path('/runtime/package')) == 'codex-cli 0.159.3'
    assert run.call_args.kwargs['env'] == {
        'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'CODEX_MANAGED_PACKAGE_ROOT': '/runtime/package',
        'CODEX_MANAGED_BY_NPM': '1'}
    assert run.call_args.kwargs['timeout'] == 20

# Resolver identity/parity negatives without launching the setup executables.
node = Path('/opt/hostedtoolcache/node/24.1.2/x64/bin/node')
distribution = node.parent.parent
package = distribution / 'lib/node_modules/@openai/codex'
entry = package / 'bin/codex.js'
platform = package / 'node_modules/@openai/codex-linux-x64'
action = Path('/trusted/action/dist/main.js')
def metadata(path):
    if path == action:
        return b'synthetic pinned action'
    import json
    return json.dumps({'name': '@openai/codex', 'version':
        '0.159.3-linux-x64' if path == platform / 'package.json' else '0.159.3'}).encode()
def versions(argv, package=None):
    return 'v24.1.2' if argv == [str(node), '--version'] else 'codex-cli 0.159.3'
def resolver():
    return proof.resolve(node, entry, action, Path('/workspace'), supply, staging, roots.CanonicalRoot)
with patch.object(Path, 'resolve', lambda path, **kwargs: path), \
     patch.object(Path, 'exists', lambda path: path == platform), \
     patch.object(supply, 'observe', return_value=('synthetic-evidence',)), \
     patch.object(proof.hashlib, 'sha1', return_value=SimpleNamespace(hexdigest=lambda: supply.ACTION_BLOB)), \
     patch.object(proof, 'version', side_effect=versions), \
     patch.object(supply, 'PreparedSupply') as prepare_mock:
    # Path methods mocked at class level retain the instance via autospec.
    with patch.object(Path, 'read_bytes', autospec=True, side_effect=metadata):
        resolver()
        values = prepare_mock.call_args.args[0]
        assert len(values) == 5 and len({row['source'] for row in values}) == 5
        assert set(prepare_mock.call_args.kwargs['setup']['sources']) == {row['source'] for row in values}
        assert str(node) in {row['source'] for row in values}
        with patch.object(proof, 'version', return_value='wrong-version'):
            rejected(resolver, 'unexpected-node-version')
        with patch.object(proof, 'version', side_effect=lambda argv, package=None:
                          'v24.1.2' if argv == [str(node), '--version'] else 'codex-cli wrong'):
            rejected(resolver, 'launcher-parity-failed')
        with patch.object(proof.hashlib, 'sha1', return_value=SimpleNamespace(hexdigest=lambda: '0' * 40)):
            rejected(resolver, 'unexpected-action-blob')
    with patch.object(Path, 'read_bytes', autospec=True, side_effect=lambda path:
                      metadata(path).replace(b'0.159.3', b'0.159.4')):
        rejected(resolver, 'unexpected-package-identity')

workflow = yaml.safe_load((repo / '.github/workflows/ai-workflow-regression.yml').read_text())
job = workflow['jobs']['runtime-supply']
assert set(job) == {'name', 'runs-on', 'timeout-minutes', 'steps'}
assert job['runs-on'] == 'ubuntu-latest' and job['timeout-minutes'] == 10
assert 'needs' not in job and 'if' not in job
assert len(job['steps']) == 3
checkout, setup, actual = job['steps']
assert checkout['uses'] == 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'
assert set(checkout) == set(setup) == {'name', 'uses', 'with'}
assert checkout['with'] == {'ref': '${{ github.event.pull_request.head.sha }}', 'persist-credentials': False}
assert setup['uses'] == 'openai/codex-action@' + proof.PIN
assert setup['with'] == {'codex-version': '0.159.3',
    'codex-home': '${{ runner.temp }}/runtime-supply-codex-home', 'safety-strategy': 'unsafe', 'allow-users': '*'}
assert 'secrets.' not in str(job) and 'vars.' not in str(job)
assert set(actual) == {'name', 'timeout-minutes', 'shell', 'env', 'run'}
assert actual['timeout-minutes'] == 5 and actual['shell'] == 'bash'
assert actual['env'] == {'HEAD_SHA': '${{ github.event.pull_request.head.sha }}',
                        'RUNNER_ENVIRONMENT': '${{ runner.environment }}'}
expected_run = '''set -euo pipefail
node_path="$(command -v node)"
launcher_path="$(command -v codex)"
action_main="$(dirname "$RUNNER_WORKSPACE")/_actions/openai/codex-action/86365089eb2b84e0a8fb0717b304f8bdcb13b20e/dist/main.js"
sudo -n env -i PATH=/usr/bin:/bin LC_ALL=C python3 -B \\
  .github/scripts/runtime-supply-proof.py \\
  "$node_path" "$launcher_path" "$action_main" "$GITHUB_WORKSPACE" \\
  "$HEAD_SHA" "$RUNNER_ENVIRONMENT"
'''
assert actual['run'] == expected_run, 'proof command/phase/env drift'
developer = (repo / '.github/workflows/ai-developer.yml').read_text()
assert supply.ACTION_BLOB in developer and 'codex-cli 0.159.3' in developer
assert proof.PIN in developer
print('Trusted runtime supply: synthetic provenance / drift / authority / inventory / seal / cleanup / workflow PASS')
PY
