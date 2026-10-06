#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

repo = Path(sys.argv[1])
def load(name):
    spec = importlib.util.spec_from_file_location(name, repo / '.github/scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

helper = load('product-runtime-staging')
parent = load('product-npm-orchestrator')
# This fixture designates the synthetic namespace's observed ancestor owners;
# the helper must not impose root:root on host sources (including this container).
uids = {0, os.getuid(), Path('/').stat().st_uid, Path(tempfile.gettempdir()).stat().st_uid}

def rejected(call):
    try:
        call()
    except (ValueError, OSError):
        return
    raise AssertionError('unsafe staging accepted')

with tempfile.TemporaryDirectory(prefix='runtime-contract-') as temporary:
    area = Path(temporary)
    source, staging, product = (area / name for name in ('source', 'staging', 'product'))
    for path in (source, staging, product):
        path.mkdir(mode=0o700)
    rows = []
    for index, kind in enumerate(sorted(helper.CLASSES)):
        path = source / str(index)
        path.write_bytes(('synthetic-' + kind).encode())
        path.chmod(0o500 if index % 2 else 0o640)
        rows.append({'source': str(path), 'destination': '/runtime/' + kind,
                     'class': kind, 'executable': index % 2 == 1})

    def prepare(values=rows, **kwargs):
        return helper.PreparedRuntime(values, trusted_uids=kwargs.pop('trusted_uids', uids),
                                      excluded_roots=[product],
                                      root_api=kwargs.pop('root_api', parent.CanonicalRoot), **kwargs)

    prepared = prepare()
    prepared.verify()
    expected = prepared.inventory()
    assert {row['class'] for row in expected['files']} == helper.CLASSES
    assert all(row['identity'] and row['ancestors'] and len(row['sha256']) == 64
               for row in expected['files'])
    expected['files'].clear()
    assert len(prepared.inventory()['files']) == len(rows), 'mutable inventory expectation'
    with prepared.stage(staging) as sealed:
        root = sealed.path
        sealed.verify()
        claim = sealed.inventory()
        assert set(claim['entries']) == {'.', 'runtime', *(row['destination'][1:] for row in rows)}
        for row in rows:
            staged = root / row['destination'][1:]
            assert staged.read_bytes() == Path(row['source']).read_bytes()
            assert stat.S_IMODE(staged.stat().st_mode) == (0o755 if row['executable'] else 0o644)
            assert (staged.stat().st_dev, staged.stat().st_ino) != (
                Path(row['source']).stat().st_dev, Path(row['source']).stat().st_ino)
        assert root.stat().st_mode & 0o777 == 0o755
        claim['entries'].clear()
        sealed.verify()
        # Every attack uses a fresh baseline because restoring bytes or mode
        # does not restore ctime/identity of an already sealed object.
    assert not root.exists() and not list(staging.iterdir())
    rejected(sealed.verify)
    with prepare(directories=('/proc', '/tmp', '/empty/nested')).stage(staging) as sealed:
        for name in ('proc', 'tmp', 'empty/nested'):
            assert list((sealed.path / name).iterdir()) == []
            assert (sealed.path / name).stat().st_mode & 0o777 == 0o755
        sealed.verify()
    rejected(lambda: prepare(directories=('/tmp', '/tmp')))
    rejected(lambda: prepare(directories=('/tmp/../alias',)))
    rejected(lambda: prepare(directories=(rows[0]['destination'],)))
    rejected(lambda: prepare(directories=(rows[0]['destination'] + '/child',)))

    for bad in ('relative', '/', '//runtime/x', '/runtime/../x', '/runtime/./x',
                '/runtime//x', '/runtime/x/', '/runtime/\\x', '/runtime/\0x'):
        rejected(lambda bad=bad: prepare([{**rows[0], 'destination': bad}]))
        rejected(lambda bad=bad: prepare([{**rows[0], 'source': bad}]))
    rejected(lambda: prepare([rows[0], rows[0]]))
    rejected(lambda: prepare([rows[0], {**rows[1], 'destination': rows[0]['destination'] + '/child'}]))
    rejected(lambda: prepare([rows[0], {**rows[1], 'source': rows[0]['source']}]))
    rejected(lambda: prepare([{**rows[0], 'class': 'host-tree'}]))
    rejected(lambda: prepare([{**rows[0], 'executable': 1}]))
    rejected(lambda: prepare([{**rows[0], 'recursive': True}]))
    rejected(lambda: prepare([], trusted_uids=uids))
    rejected(lambda: prepare(trusted_uids=set()))
    rejected(lambda: prepare(trusted_uids={os.getuid() + 10000}))

    original = Path(rows[0]['source'])
    link = source / 'symlink'
    link.symlink_to(original)
    rejected(lambda: prepare([{**rows[0], 'source': str(link)}]))
    alias = area / 'alias'
    alias.symlink_to(source, target_is_directory=True)
    rejected(lambda: prepare([{**rows[0], 'source': str(alias / original.name)}]))
    hardlink = source / 'hardlink'
    os.link(original, hardlink)
    rejected(lambda: prepare([{**rows[0], 'source': str(original)}]))
    rejected(lambda: prepare([{**rows[0], 'source': str(hardlink)}]))
    hardlink.unlink()
    rejected(lambda: prepare([{**rows[0], 'source': str(source)}]))
    fifo = source / 'fifo'
    os.mkfifo(fifo)
    rejected(lambda: prepare([{**rows[0], 'source': str(fifo)}]))
    private = product / 'runtime'
    private.write_bytes(b'model-modified')
    rejected(lambda: prepare([{**rows[0], 'source': str(private)}]))

    # Host ownership is caller-supplied authority, not one fixed UID/mode.
    for uid, mode in ((0, 0o444), (os.getuid(), 0o640), (12345, 0o700)):
        helper.authority(SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | mode), {uid})
    for mode in (0o666, 0o620, 0o4644, 0o2644, 0o1644):
        rejected(lambda mode=mode: helper.authority(
            SimpleNamespace(st_uid=os.getuid(), st_mode=stat.S_IFREG | mode), uids))
    # Unsafe replacement through an ancestor is rejected, even with safe file mode.
    for mode in (0o777, 0o770):
        source.chmod(mode)
        rejected(prepare)
    source.chmod(0o700)
    original.chmod(0o666)
    rejected(prepare)
    original.chmod(0o640)
    with patch.object(helper.os, 'listxattr', return_value=['system.posix_acl_access']):
        rejected(prepare)
    with patch.object(helper.os, 'listxattr', side_effect=PermissionError):
        rejected(prepare)

    prepared = prepare()
    original.write_bytes(b'identity/hash drift')
    rejected(prepared.verify)
    prepared = prepare()
    replacement = source / 'replacement'
    replacement.write_bytes(original.read_bytes())
    replacement.chmod(0o640)
    replacement.replace(original)
    rejected(prepared.verify)
    prepared = prepare()
    source.chmod(0o750)
    rejected(prepared.verify)
    source.chmod(0o700)

    # Hash revalidation must reject drift even with a stale identity claim.
    prepared = prepare()
    with patch.object(helper, 'digest_fd', return_value='0' * 64):
        rejected(prepared.verify)
    # Before-read and after-copy mutations never publish a handle; cleanup is mandatory.
    for when in ('before', 'after'):
        prepared = prepare()
        original_check = prepared._check
        original_read = helper.os.read
        original_fdopen = helper.os.fdopen
        changed = False
        copying = False
        checks = 0
        def drift_check(entry, fd, ancestors, identity):
            global changed, checks
            checks += 1
            if when == 'before' and checks == len(rows) + 1:
                Path(entry['source']).write_bytes(b'drift before copy')
                changed = True
            return original_check(entry, fd, ancestors, identity)
        def drift_read(fd, count):
            global changed
            result = original_read(fd, count)
            if when == 'after' and copying and not changed:
                original.write_bytes(b'drift during read/copy')
                changed = True
            return result
        def copy_open(fd, mode):
            global copying
            copying = mode == 'wb'
            return original_fdopen(fd, mode)
        def attempt():
            with prepared.stage(staging):
                raise AssertionError('drift published')
        with patch.object(prepared, '_check', side_effect=drift_check), \
             patch.object(helper.os, 'read', side_effect=drift_read), \
             patch.object(helper.os, 'fdopen', side_effect=copy_open):
            rejected(attempt)
        assert changed and not list(staging.iterdir())

    for attack in ('extra-file', 'extra-directory', 'missing', 'bytes', 'mode',
                   'symlink', 'hardlink', 'directory-mode', 'replacement'):
        prepared = prepare()
        with prepared.stage(staging) as sealed:
            target = sealed.path / rows[0]['destination'][1:]
            if attack == 'extra-file':
                (sealed.path / 'extra').write_bytes(b'extra')
            elif attack == 'extra-directory':
                (sealed.path / 'extra').mkdir()
            elif attack == 'missing':
                target.unlink()
            elif attack == 'bytes':
                target.write_bytes(b'changed')
            elif attack == 'mode':
                target.chmod(0o600)
            elif attack == 'symlink':
                target.unlink()
                target.symlink_to(original)
            elif attack == 'hardlink':
                os.link(target, sealed.path / 'extra')
            elif attack == 'directory-mode':
                target.parent.chmod(0o777)
            else:
                new = target.parent / 'replacement'
                new.write_bytes(target.read_bytes())
                new.chmod(0o644)
                new.replace(target)
            rejected(sealed.verify)
        assert not list(staging.iterdir())
    prepared = prepare()
    rejected(lambda: prepared.stage(product).__enter__())
    rejected(lambda: prepared.stage(source).__enter__())
    with prepared.stage(staging) as sealed:
        with patch.object(helper.os, 'listxattr', return_value=['security.capability']):
            rejected(sealed.verify)

# Closed implementation API: no host discovery, subprocess, network, bind or recursive copy.
tree = ast.parse((repo / '.github/scripts/product-runtime-staging.py').read_text())
imports = {ast.unparse(node) for node in ast.walk(tree)
           if isinstance(node, (ast.Import, ast.ImportFrom))}
assert imports == {'from contextlib import contextmanager', 'import hashlib', 'import json',
                   'import os', 'from pathlib import Path', 'import shutil', 'import stat',
                   'import tempfile'}
calls = {ast.unparse(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
assert not calls & {'shutil.copytree', 'os.system', 'os.walk', 'eval', 'exec', '__import__'}
assert not any(isinstance(node, ast.If) and '__name__' in ast.unparse(node.test)
               for node in tree.body)
assert all(not hasattr(helper, name) for name in ('bind', 'discover', 'run', 'build_root'))
print('Product runtime staging: synthetic source identity / exact seal / negatives / cleanup passed')
PY
