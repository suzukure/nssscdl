#!/usr/bin/env python3
"""#738 prepared exact runtime staging. No CLI, discovery, bind or execution API.

Trusted caller supplies CanonicalRoot (the existing #710 root API), explicit
trusted owner UIDs, excluded Product/workload roots and exact regular-file rows.
Only that caller can designate trusted sources; mode/UID alone is not provenance.
The caller must keep module, handles and sources isolated from model writes,
including processes sharing a trusted UID. This is not a runner isolation proof.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile


CLASSES = frozenset(('shell', 'python-runtime', 'python-module', 'python-extension',
                     'node-runtime', 'codex-package', 'codex-native', 'elf-loader',
                     'elf-library', 'preflight-descriptor', 'preflight-metadata'))
UNSAFE_XATTRS = frozenset(('system.posix_acl_access', 'system.posix_acl_default',
                          'security.capability'))


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def canonical(path):
    require(isinstance(path, (str, Path)), 'invalid-path')
    value = str(path)
    require(value.startswith('/') and value != '/' and '\\' not in value
            and '\0' not in value
            and all(part not in ('', '.', '..') for part in value[1:].split('/')),
            'noncanonical-path')
    return Path(value)


def signature(info):
    # Reads may change atime. All mutation-relevant metadata is retained.
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def no_extra_authority(fd):
    require(not UNSAFE_XATTRS.intersection(os.listxattr(fd)), 'unsafe-xattr-authority')


def authority(info, trusted_uids, *, directory=False, sticky_parent=False):
    require(info.st_uid in trusted_uids, 'untrusted-owner')
    mode = stat.S_IMODE(info.st_mode)
    require(not mode & 0o6000, 'special-source-mode')
    # A trusted-owned sticky ancestor (e.g. /tmp) cannot replace a trusted-owned
    # child through group/other write authority. Its identity is still bound.
    sticky = directory and sticky_parent and bool(mode & stat.S_ISVTX)
    require(not mode & 0o022 or sticky, 'unsafe-writable-authority')
    require(directory or not mode & stat.S_ISVTX, 'special-source-mode')


@contextmanager
def source_file(path, trusted_uids):
    """Pin every ancestor and the file with no-follow descriptor traversal."""
    fds = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)]
    try:
        ancestry = []
        for part in (None, *path.parts[1:-1]):
            if part is not None:
                fds.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                   dir_fd=fds[-1]))
            info = os.fstat(fds[-1])
            authority(info, trusted_uids, directory=True, sticky_parent=True)
            no_extra_authority(fds[-1])
            # Ancestor size/mtime/ctime change when unrelated siblings change;
            # replacement authority depends on identity, owner, mode and ACL.
            ancestry.append(signature(info)[:5])
        before = os.stat(path.name, dir_fd=fds[-1], follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'unsafe-source-type')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=fds[-1])
        fds.append(fd)
        info = os.fstat(fd)
        require(signature(info) == signature(before), 'source-drift')
        authority(info, trusted_uids)
        no_extra_authority(fd)
        yield fd, tuple(ancestry), signature(info)
    finally:
        for fd in reversed(fds):
            os.close(fd)


def digest_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while chunk := os.read(fd, 1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


class PreparedRuntime:
    """Parent-held expectation. JSON inventory copies are claims, not handles.

    Each row has exactly source/destination/class/executable. Destinations are
    canonical absolute names inside the future root, never host bind targets.
    Closure resolution and final executable inventory remain caller decisions.
    """
    def __init__(self, rows, *, trusted_uids, excluded_roots, root_api, directories=()):
        require(isinstance(trusted_uids, (set, frozenset)) and trusted_uids
                and all(type(uid) is int and uid >= 0 for uid in trusted_uids),
                'invalid-trusted-authority')
        require(isinstance(rows, (list, tuple)) and rows, 'empty-inventory')
        require(isinstance(excluded_roots, (list, tuple)) and excluded_roots,
                'missing-excluded-roots')
        self._uids = frozenset(trusted_uids)
        self._root_api = root_api
        self._excluded = tuple(root_api(canonical(path)) for path in excluded_roots)
        require(isinstance(directories, (list, tuple)), 'invalid-directory-inventory')
        self._directories = tuple(sorted(str(canonical(path)) for path in directories))
        require(len(set(self._directories)) == len(self._directories), 'duplicate-directory')
        entries, destinations, identities, coordinates = [], set(), set(), set()
        for row in rows:
            require(type(row) is dict and set(row) == {
                'source', 'destination', 'class', 'executable'}, 'invalid-inventory-row')
            source, destination = canonical(row['source']), canonical(row['destination'])
            require(type(row['class']) is str and row['class'] in CLASSES
                    and type(row['executable']) is bool, 'invalid-runtime-class')
            require(str(destination) not in destinations, 'duplicate-destination')
            destinations.add(str(destination))
            parent = root_api(source.parent)
            # Compare exact source physical coordinates to each excluded tree;
            # a shared ancestor alone does not make a source part of that tree.
            self._outside(source, parent)
            coordinate = (parent._snapshot[2], str(parent._snapshot[3] / source.name))
            require(coordinate not in coordinates, 'aliased-source')
            coordinates.add(coordinate)
            with source_file(source, self._uids) as (fd, ancestry, identity):
                require(identity[:2] not in identities, 'aliased-source')
                identities.add(identity[:2])
                digest = digest_fd(fd)
                require(signature(os.fstat(fd)) == identity, 'source-drift')
            entries.append({**row, 'source': str(source), 'destination': str(destination),
                            'identity': identity, 'ancestors': ancestry, 'sha256': digest,
                            'mode': 0o755 if row['executable'] else 0o644,
                            '_parent': parent})
        require(not any(Path(a) in Path(b).parents for a in destinations for b in destinations),
                'ambiguous-destination')
        require(not any(a == b or Path(a) in Path(b).parents
                        for a in destinations for b in self._directories), 'ambiguous-destination')
        self._entries = tuple(sorted(entries, key=lambda row: row['destination']))
        self.verify()

    def _outside(self, source, parent):
        parent.verify()
        device, physical = parent._snapshot[2], parent._snapshot[3] / source.name
        for root in self._excluded:
            root.verify()
            require(not (root.path == source or root.path in source.parents
                         or device == root._snapshot[2] and
                         (physical == root._snapshot[3] or root._snapshot[3] in physical.parents)),
                    'excluded-source')

    def _check(self, entry, fd, ancestry, identity):
        require(ancestry == entry['ancestors'] and identity == entry['identity']
                and digest_fd(fd) == entry['sha256']
                and signature(os.fstat(fd)) == identity, 'source-drift')
        self._outside(Path(entry['source']), entry['_parent'])

    def verify(self):
        for entry in self._entries:
            with source_file(Path(entry['source']), self._uids) as observed:
                self._check(entry, *observed)

    def inventory(self):
        return {'schema_version': 1, 'directories': self._directories, 'files': [
            {key: value for key, value in entry.items() if key != '_parent'}
            for entry in self._entries]}

    @contextmanager
    def stage(self, staging_parent):
        """Fresh copy only. Cleanup on all exits; never expose a failed seal."""
        parent_path = canonical(staging_parent)
        parent = self._root_api(parent_path)
        with _directory(parent_path, self._uids):
            pass
        require(not any(parent.overlaps(entry['_parent']) for entry in self._entries),
                'source-staging-overlap')
        require(not any(parent.overlaps(root) for root in self._excluded),
                'excluded-staging-root')
        self.verify()
        root = Path(tempfile.mkdtemp(prefix='runtime-staged-', dir=parent_path))
        handle = None
        try:
            parent.verify()
            directories = {root}
            for name in self._directories:
                target = root / name[1:]
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                directories.update(path for path in (target, *target.parents)
                                   if path == root or root in path.parents)
            for entry in self._entries:
                target = root / entry['destination'][1:]
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                directories.update(path for path in (target.parent, *target.parent.parents)
                                   if path == root or root in path.parents)
                with source_file(Path(entry['source']), self._uids) as observed:
                    fd, ancestry, identity = observed
                    self._check(entry, fd, ancestry, identity)
                    os.lseek(fd, 0, os.SEEK_SET)
                    output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                     | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(output, 'wb') as stream:
                        while chunk := os.read(fd, 1024 * 1024):
                            stream.write(chunk)
                        stream.flush()
                        os.fchmod(stream.fileno(), entry['mode'])
                        no_extra_authority(stream.fileno())
                    self._check(entry, fd, ancestry, identity)
            self.verify()
            for path in sorted(directories, key=lambda path: len(path.parts), reverse=True):
                path.chmod(0o755)
            handle = SealedRoot(root, self, parent)
            handle.verify()
            yield handle
        finally:
            if handle is not None:
                handle._active = False
            shutil.rmtree(root)
            require(not root.exists(), 'staging-cleanup-failed')


@contextmanager
def _directory(path, uids):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = (None, *path.parts[1:])
        for index, part in enumerate(parts):
            if part is not None:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            authority(os.fstat(fd), uids, directory=True, sticky_parent=index < len(parts) - 1)
            no_extra_authority(fd)
        yield fd
    finally:
        os.close(fd)


class SealedRoot:
    """Read-only exact seal, valid only in PreparedRuntime.stage() lifetime.

    Normalization is 0755 directories/executables, 0644 data files, caller UID/GID,
    no ACL/capability, single-link regular files. No runtime-added paths allowed.
    Future privileged callers can stage as root without changing this contract.
    """
    def __init__(self, path, prepared, parent):
        self.path = path
        self._prepared, self._parent = prepared, parent
        self._root = prepared._root_api(path)
        self._uid, self._gid = os.getuid(), os.getgid()
        self._active = True
        self._expected = self._observe()

    def _observe(self):
        self._parent.verify()
        self._root.verify()
        files = {entry['destination'][1:]: entry for entry in self._prepared._entries}
        directories = {'.'}
        for name in self._prepared._directories:
            directories.add(name[1:])
            directories.update(str(path) for path in Path(name[1:]).parents if str(path) != '.')
        for name in files:
            directories.update(str(path) for path in Path(name).parents if str(path) != '.')
        observed = {}

        def walk(fd, relative):
            info = os.fstat(fd)
            require(info.st_uid == self._uid and info.st_gid == self._gid
                    and stat.S_IMODE(info.st_mode) == 0o755, 'staged-directory-policy')
            no_extra_authority(fd)
            require(relative in directories, 'unexpected-staged-directory')
            observed[relative] = (signature(info), None)
            for name in sorted(os.listdir(fd)):
                child = name if relative == '.' else relative + '/' + name
                before = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(before.st_mode):
                    nested = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        require(signature(os.fstat(nested)) == signature(before), 'staged-drift')
                        walk(nested, child)
                    finally:
                        os.close(nested)
                else:
                    require(child in files and stat.S_ISREG(before.st_mode)
                            and before.st_nlink == 1, 'unexpected-staged-file')
                    entry = files[child]
                    require(before.st_uid == self._uid and before.st_gid == self._gid
                            and stat.S_IMODE(before.st_mode) == entry['mode'], 'staged-file-policy')
                    nested = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        no_extra_authority(nested)
                        digest = digest_fd(nested)
                        require(signature(os.fstat(nested)) == signature(before)
                                and digest == entry['sha256'], 'staged-drift')
                        observed[child] = (signature(before), digest)
                    finally:
                        os.close(nested)
            require(signature(os.fstat(fd)) == signature(info), 'staged-drift')

        with _directory(self.path, self._prepared._uids) as fd:
            walk(fd, '.')
        require(set(observed) == set(files) | directories, 'staged-inventory-mismatch')
        return observed

    def verify(self):
        require(self._active, 'expired-staged-root')
        require(self._observe() == self._expected, 'sealed-root-drift')

    def inventory(self):
        self.verify()
        # Deep copy: consumers cannot alter the parent-held expectation.
        return json.loads(json.dumps({'schema_version': 1, 'entries': self._expected}))
