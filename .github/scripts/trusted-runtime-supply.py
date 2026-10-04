#!/usr/bin/env python3
"""#741 trusted preparation only; no production, discovery or execution API.

The parent must run before any model/Product/PR arbitrary executable, retaining
resolver evidence in memory. Evidence is a caller assertion, not authentication
of workflow history. Only ext4 with no xattrs is supported; never trust writable
toolcache authority as a #738 source. No workload receives original paths.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import stat
import tempfile

ACTION_BLOB = 'ce4e94e119abb91b980d23bfb4210688241f3a0a'
SETUP = {'phase': 'pre-workload-trusted-setup', 'action_blob': ACTION_BLOB,
         'package': '@openai/codex', 'version': '0.159.3', 'launcher_parity': True}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def filesystem(path, device):
    """Closed Linux ext4 authority contract, bind-aware mount identity."""
    rows = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        require(len(fields) >= 10 and '-' in fields[6:], 'invalid-mount-table')
        index = fields.index('-', 6)
        # Escaped mount coordinates are unsupported, never guessed/unescaped.
        require('\\' not in fields[3] + fields[4], 'unsupported-mount-coordinate')
        point = Path(fields[4])
        if path == point or point in path.parents:
            rows.append((len(point.parts), fields[0], fields[2], fields[3],
                         fields[4], fields[index + 1], fields[5], fields[index + 3]))
    require(rows, 'missing-mount-table')
    depth = max(row[0] for row in rows)
    rows = [row for row in rows if row[0] == depth]
    require(len(rows) == 1, 'ambiguous-mount-root')
    row = rows[0]
    require(row[2] == f'{os.major(device)}:{os.minor(device)}', 'mount-device-mismatch')
    require(row[5] == 'ext4', 'unsupported-authority-filesystem')
    return row[1:]


def no_xattrs(fd):
    # Unknown xattrs are not assumed harmless (including alternate ACL schemes).
    require(os.listxattr(fd) == [], 'unsupported-xattr-authority')


@contextmanager
def sealed_directory(path, staging):
    # #738 checks owner/mode; additionally reject unknown ancestor authority.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = Path('/')
        parts = (None, *path.parts[1:])
        for index, part in enumerate(parts):
            if part is not None:
                current /= part
                nested = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nested
            staging.authority(os.fstat(fd), {0}, directory=True, sticky_parent=index < len(parts) - 1)
            no_xattrs(fd)
            filesystem(current, os.fstat(fd).st_dev)
        yield fd
    finally:
        os.close(fd)


@contextmanager
def source_file(path, staging):
    fds = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)]
    try:
        ancestors = []
        current = Path('/')
        for part in (None, *path.parts[1:-1]):
            if part is not None:
                current /= part
                fds.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                   dir_fd=fds[-1]))
            info = os.fstat(fds[-1])
            no_xattrs(fds[-1])
            ancestors.append((staging.signature(info)[:5], filesystem(current, info.st_dev)))
        before = os.stat(path.name, dir_fd=fds[-1], follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'unsafe-source-type')
        require(0 < before.st_size <= 512 * 1024 * 1024, 'source-size-limit')
        require(not stat.S_IMODE(before.st_mode) & 0o7000, 'special-source-mode')
        fds.append(os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                           dir_fd=fds[-1]))
        info = os.fstat(fds[-1])
        require(staging.signature(info) == staging.signature(before), 'source-drift')
        no_xattrs(fds[-1])
        mount = filesystem(path, info.st_dev)
        yield fds[-1], tuple(ancestors), staging.signature(info), mount
    finally:
        for fd in reversed(fds):
            os.close(fd)


def observe(path, staging):
    with source_file(path, staging) as (fd, ancestors, identity, mount):
        digest = staging.digest_fd(fd)
        require(staging.signature(os.fstat(fd)) == identity, 'source-drift')
        return ancestors, identity, mount, digest


class PreparedSupply:
    """Exact resolver-bound rows/hash/identity; held only by trusted parent.

    setup is exact SETUP plus sources, a source -> observe() mapping captured
    before resolver version probes and rechecked afterwards. Serialized records
    cannot establish trusted provenance. Root privilege belongs to preparation;
    consumers must be non-root with no replacement authority or capabilities.
    """
    def __init__(self, rows, *, setup, excluded_roots, root_api, staging_api):
        require(type(setup) is dict and set(setup) == set(SETUP) | {'sources'}
                and all(type(setup[key]) is type(value) and setup[key] == value
                        for key, value in SETUP.items()), 'untrusted-setup-provenance')
        require(type(rows) in (list, tuple) and rows and len(rows) <= 32, 'invalid-inventory')
        require(type(setup['sources']) is dict, 'invalid-source-evidence')
        require(excluded_roots, 'missing-excluded-roots')
        self._root_api, self._staging = root_api, staging_api
        self._excluded = tuple(root_api(staging_api.canonical(p)) for p in excluded_roots)
        self._rows, sources, destinations, identities = [], set(), set(), set()
        for row in rows:
            require(type(row) is dict and set(row) == {
                'source', 'destination', 'class', 'executable'}, 'invalid-inventory-row')
            source = staging_api.canonical(row['source'])
            destination = staging_api.canonical(row['destination'])
            require(row['class'] in ('node-runtime', 'codex-package', 'codex-native')
                    and type(row['executable']) is bool, 'invalid-runtime-class')
            require(str(source) not in sources and str(destination) not in destinations,
                    'duplicate-inventory')
            sources.add(str(source))
            destinations.add(str(destination))
            parent = root_api(source.parent)
            require(not any(parent.overlaps(root) for root in self._excluded), 'excluded-source')
            evidence = observe(source, staging_api)
            require(setup['sources'].get(str(source)) == evidence, 'source-drift')
            require(evidence[1][:2] not in identities, 'aliased-source')
            identities.add(evidence[1][:2])
            self._rows.append(({**row, 'source': str(source), 'destination': str(destination)},
                               parent, evidence))
        require(sum(evidence[1][6] for _, _, evidence in self._rows) <= 1024 * 1024 * 1024,
                'inventory-size-limit')
        require(sources == set(setup['sources']), 'source-inventory-mismatch')
        require(not any(Path(a) in Path(b).parents for a in destinations for b in destinations),
                'ambiguous-destination')
        self.verify()

    def verify(self):
        for row, parent, evidence in self._rows:
            parent.verify()
            require(not any(parent.overlaps(root) for root in self._excluded), 'excluded-source')
            require(observe(Path(row['source']), self._staging) == evidence, 'source-drift')

    @contextmanager
    def snapshot(self, supply_parent):
        require(os.getuid() == 0 and os.getgid() == 0, 'root-preparation-required')
        staging = self._staging
        parent_path = staging.canonical(supply_parent)
        parent = self._root_api(parent_path)
        with sealed_directory(parent_path, staging) as fd:
            no_xattrs(fd)
            filesystem(parent_path, os.fstat(fd).st_dev)
        require(not any(parent.overlaps(p) for _, p, _ in self._rows)
                and not any(parent.overlaps(p) for p in self._excluded), 'supply-overlap')
        self.verify()
        root = Path(tempfile.mkdtemp(prefix='sealed-supply-', dir=parent_path))
        root_identity = (root.stat().st_dev, root.stat().st_ino)
        seal = None
        try:
            directories = {root}
            for row, _, evidence in self._rows:
                target = root / row['destination'][1:]
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                directories.update(p for p in (target.parent, *target.parent.parents)
                                   if p == root or root in p.parents)
                with source_file(Path(row['source']), staging) as (fd, ancestry, identity, mount):
                    require((ancestry, identity, mount, staging.digest_fd(fd)) == evidence,
                            'source-drift')
                    os.lseek(fd, 0, os.SEEK_SET)
                    out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(out, 'wb') as stream:
                        while chunk := os.read(fd, 1024 * 1024):
                            stream.write(chunk)
                        stream.flush()
                        os.fchmod(stream.fileno(), 0o555 if row['executable'] else 0o444)
                        no_xattrs(stream.fileno())
                    require(staging.signature(os.fstat(fd)) == identity
                            and staging.digest_fd(fd) == evidence[3], 'source-drift')
            self.verify()
            for path in sorted(directories, key=lambda p: len(p.parts), reverse=True):
                path.chmod(0o555)
            seal = SupplyRoot(root, self, parent)
            seal.verify()
            yield seal
        finally:
            if seal is not None:
                seal._active = False
            parent.verify()
            info = root.lstat()
            require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == root_identity,
                    'supply-cleanup-identity')
            shutil.rmtree(root)
            require(not root.exists(), 'supply-cleanup-failed')


class SupplyRoot:
    def __init__(self, path, prepared, parent):
        self.path, self._prepared, self._parent = path, prepared, parent
        self._root = prepared._root_api(path)
        self._active = True
        self._expected = self._observe()

    def _observe(self):
        staging = self._prepared._staging
        self._parent.verify()
        self._root.verify()
        files = {row['destination'][1:]: (row, evidence)
                 for row, _, evidence in self._prepared._rows}
        directories = {'.'}
        for name in files:
            directories.update(str(p) for p in Path(name).parents if str(p) != '.')
        observed = {}

        def walk(fd, relative, path):
            info = os.fstat(fd)
            require(info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o555,
                    'supply-directory-policy')
            no_xattrs(fd)
            mount = filesystem(path, info.st_dev)
            require(relative in directories, 'unexpected-supply-directory')
            observed[relative] = (staging.signature(info), mount, None)
            for name in sorted(os.listdir(fd)):
                child = name if relative == '.' else relative + '/' + name
                before = os.stat(name, dir_fd=fd, follow_symlinks=False)
                is_directory = stat.S_ISDIR(before.st_mode)
                require(is_directory or (child in files and stat.S_ISREG(before.st_mode)
                                         and before.st_nlink == 1), 'unexpected-supply-file')
                nested = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                                 | (os.O_DIRECTORY if is_directory else 0), dir_fd=fd)
                try:
                    require(staging.signature(os.fstat(nested)) == staging.signature(before),
                            'supply-drift')
                    if is_directory:
                        walk(nested, child, path / name)
                    else:
                        row, evidence = files[child]
                        require(before.st_uid == before.st_gid == 0 and stat.S_IMODE(before.st_mode)
                                == (0o555 if row['executable'] else 0o444), 'supply-file-policy')
                        no_xattrs(nested)
                        digest = staging.digest_fd(nested)
                        require(digest == evidence[3]
                                and staging.signature(os.fstat(nested)) == staging.signature(before),
                                'supply-drift')
                        observed[child] = (staging.signature(before),
                                           filesystem(path / name, before.st_dev), digest)
                finally:
                    os.close(nested)
            require(staging.signature(os.fstat(fd)) == staging.signature(info), 'supply-drift')

        with sealed_directory(self.path, staging) as fd:
            walk(fd, '.', self.path)
        require(set(observed) == set(files) | directories, 'supply-inventory-mismatch')
        return observed

    def verify(self):
        require(self._active, 'expired-supply-root')
        require(self._observe() == self._expected, 'sealed-supply-drift')

    def prepared_runtime(self):
        """Only sealed paths cross #738; original writable sources are withheld."""
        self.verify()
        rows = [{**row, 'source': str(self.path / row['destination'][1:])}
                for row, _, _ in self._prepared._rows]
        return self._prepared._staging.PreparedRuntime(
            rows, trusted_uids={0}, excluded_roots=[p.path for p in self._prepared._excluded],
            root_api=self._prepared._root_api)
