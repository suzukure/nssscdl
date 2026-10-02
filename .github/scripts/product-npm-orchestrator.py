#!/usr/bin/env python3
"""Dormant trusted parent API. Never load from a workload-modified copy.

The parent retains the returned handle in memory; serialized copies are claims.
No CLI, bootstrap invocation, production wiring, or persistent cache.
"""
import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile


SOURCES = ('product-npm-orchestrator.py', 'prepare-product-npm.py',
           'npm-offline-ci-runtime.py', 'npm-offline-ci-probe.js',
           'npm-initial-lock-probe.js', 'npm-locked-preparation.py',
           'npm-registry-proxy.py', 'npm-registry-boundary-runtime.py',
           'codex-network-boundary.py', 'npm-filesystem-boundary-runtime.py',
           'npm-registry-lock-runtime.py')
INPUTS = ('package.json', 'package-lock.json')


def load(name):
    source = Path(__file__).absolute().parent / (name + '.py')
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load('prepare-product-npm')
offline = load('npm-offline-ci-runtime')
locked = load('npm-locked-preparation')
require = validator.require


def read_pair(path):
    fd = validator.directory(path)
    try:
        return tuple(validator.read_input(fd, name) for name in INPUTS)
    finally:
        os.close(fd)


def read_record(fd):
    # Two independently bounded inputs expand when base64-encoded in handoff.
    file_fd = os.open('handoff.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(file_fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe-handoff-file')
        limit = 4 * validator.MAX_INPUT
        data = stream.read(limit + 1)
        require(len(data) <= limit, 'handoff-too-large')
        return data


def contracts():
    directory = Path(__file__).absolute().parent
    fd = validator.directory(directory)
    try:
        return {name: {'path': '.github/scripts/' + name,
                       'hash': validator.sha(validator.read_input(fd, name))}
                for name in SOURCES}
    finally:
        os.close(fd)


def no_acl(path):
    require(not any(name in os.listxattr(path, follow_symlinks=False)
                    for name in ('system.posix_acl_access', 'system.posix_acl_default')),
            'unsafe-acl')


def private_directory(path):
    fd = validator.directory(path)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                'unsafe-trusted-directory')
        no_acl(path)
        return [info.st_dev, info.st_ino]
    finally:
        os.close(fd)


def cache_identity(path):
    """Bind every cache byte and reject links/special files, including partial cache."""
    identity = private_directory(path)
    entries = []

    def signature(info):
        # Reading can update atime; identity/content metadata must stay fixed.
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def walk(directory):
        fd = validator.directory(directory)
        try:
            for name in sorted(os.listdir(fd)):
                target = directory / name
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                require(info.st_uid == os.getuid() and info.st_mode & 0o7022 == 0,
                        'unsafe-cache-owner-or-mode')
                no_acl(target)
                relative = str(target.relative_to(path))
                if stat.S_ISDIR(info.st_mode):
                    entries.append([relative, 'directory', info.st_dev, info.st_ino])
                    walk(target)
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe-cache-file')
                    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    with os.fdopen(file_fd, 'rb') as stream:
                        require(signature(os.fstat(stream.fileno())) == signature(info), 'cache-mutated')
                        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                        require(signature(os.fstat(stream.fileno())) == signature(info), 'cache-mutated')
                    entries.append([relative, 'sha256:' + digest, info.st_dev, info.st_ino])
        finally:
            os.close(fd)

    walk(path)
    return {'path': str(path), 'directory_identity': identity,
            'content_hash': validator.sha(json.dumps(entries, sort_keys=True).encode())}


def check_lock(pair):
    manifest = validator.parse(pair[0])
    validator.manifest_dependencies(manifest)
    if pair[1] is not None:
        validator.validate_lock(manifest, validator.parse(pair[1]))


def offline_ready(project, cache, node, npm):
    """Readiness check only: localize #677's constructor, never copy its flags.

    This is a trusted setup install in a disposable directory, not a proof of
    the #677 restricted service boundary or a workload launcher.
    """
    repo = Path(__file__).absolute().parents[2]
    command = offline.candidate_command(repo, node)
    require(command[0] == '/runtime/npm/bin/npm-cli.js', 'unknown-offline-constructor')
    args = [arg.replace('/project/cache', str(cache)).replace('/project/', str(project) + '/')
            for arg in command[1:]]
    for name in ('empty.npmrc', 'global.npmrc'):
        (project / name).write_bytes(b'')
    env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(project), 'LC_ALL': 'C'}
    # npm is the caller's trusted launcher/CLI; no PATH search or retry.
    validator.run([str(node), str(npm.resolve(strict=True)), *args], project, env)


class Handoff:
    """Run-local expectation held by the trusted parent, never restored from JSON."""
    def __init__(self, workspace, pair, record, artifact=None):
        self._workspace = workspace
        self._pair = pair
        self._expected = json.dumps(record, sort_keys=True).encode()
        self._artifact = artifact
        self._active = True

    def record(self):
        return validator.parse(self._expected)

    def verify(self, claim=None):
        require(self._active, 'expired-handoff')
        expected = self.record()
        require(claim is None or (isinstance(claim, dict)
                and json.dumps(claim, sort_keys=True).encode() == self._expected),
                'handoff-field-mismatch')
        require(read_pair(self._workspace) == self._pair, 'workspace-input-mutated')
        if self._pair[0] is not None:
            check_lock(self._pair)
        if self._artifact is not None:
            require(contracts() == expected['contracts'], 'source-identity-mismatch')
            require(private_directory(self._artifact) == expected['artifact_identity'],
                    'artifact-identity-mismatch')
            fd = validator.directory(self._artifact)
            try:
                require(set(os.listdir(fd)) == {*INPUTS, 'handoff.json', 'preparation'},
                        'unexpected-handoff-artifact')
                for name in (*INPUTS, 'handoff.json'):
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o400,
                            'unsafe-handoff-file')
                    no_acl(self._artifact / name)
                values = (*tuple(validator.read_input(fd, name) for name in INPUTS), read_record(fd))
                require(values == (*self._pair, self._expected), 'handoff-snapshot-mismatch')
                check_lock(values[:2])
                require((*tuple(validator.read_input(fd, name) for name in INPUTS), read_record(fd))
                        == values, 'handoff-mutated')
            finally:
                os.close(fd)
            require(cache_identity(Path(expected['cache']['path'])) == expected['cache'],
                    'cache-identity-mismatch')
        require(read_pair(self._workspace) == self._pair, 'workspace-input-mutated')
        return expected


@contextmanager
def prepare(workspace, run_root, node, npm):
    """Yield a trusted Handoff; destroy all preparation on success or failure.

    Caller supplies trusted absolute Node/npm paths and a private run root outside
    workspace/RUNNER_TEMP. Memory remains with the trusted parent, not workload.
    #645 preparation runs only inside #649's mandatory registry-only service.
    """
    pair = read_pair(workspace)
    state = 'no-manifest' if pair[0] is None else 'bootstrap-required' if pair[1] is None else 'locked'
    record = {'schema_version': 1, 'status': state, 'state': state,
              'input_presence': dict(zip(INPUTS, (value is not None for value in pair)))}
    artifact = handle = None
    try:
        if pair[0] is not None:
            check_lock(pair)
            record.update(manifest_snapshot=base64.b64encode(pair[0]).decode(),
                          manifest_hash=validator.sha(pair[0]),
                          lockfile_hash=validator.sha(pair[1]),
                          node_version=None, npm_version=None,
                          expected_post_workload_hashes=dict(zip(INPUTS, map(validator.sha, pair))))
        require(read_pair(workspace) == pair, 'workspace-input-mutated')
        if state == 'locked':
            require(node.is_absolute() and npm.is_absolute(), 'unsafe-tool-path')
            root_identity = private_directory(run_root)
            excluded = [workspace]
            if os.environ.get('RUNNER_TEMP'):
                excluded.append(Path(os.environ['RUNNER_TEMP']).resolve())
            require(not any(run_root == path or run_root in path.parents or path in run_root.parents
                            for path in excluded), 'overlapping-trusted-root')
            source = contracts()
            require(all(item['hash'] is not None for item in source.values()), 'missing-contract-source')
            artifact = Path(tempfile.mkdtemp(prefix='product-npm-handoff-', dir=run_root))
            require(private_directory(run_root) == root_identity, 'run-root-changed')
            for name, data in zip(INPUTS, pair):
                (artifact / name).write_bytes(data)
                (artifact / name).chmod(0o400)
            preparation = artifact / 'preparation'
            preparation.mkdir(mode=0o700)
            # Use frozen inputs, never a mutable workspace read for preparation.
            with tempfile.TemporaryDirectory(prefix='inputs-', dir=artifact) as temporary:
                frozen = Path(temporary)
                for name, data in zip(INPUTS, pair):
                    (frozen / name).write_bytes(data)
                result = locked.prepare(frozen, preparation, node, npm)
            require(result['status'] == 'prepared' and result['state'] == 'locked',
                    'locked-preparation-failed')
            destination = Path(result['preparation_path'])
            cache = Path(result['cache_path'])
            require(destination.parent == preparation and cache == destination / 'cache',
                    'preparation-path-mismatch')
            require(read_pair(destination) == pair and read_pair(artifact) == pair
                    and result['manifest_hash'] == validator.sha(pair[0])
                    and result['lockfile_hash'] == validator.sha(pair[1]), 'preparation-input-mismatch')
            cache_identity(cache)  # Reject unsafe exported cache before offline npm.
            with tempfile.TemporaryDirectory(prefix='offline-readiness-', dir=artifact) as temporary:
                project = Path(temporary)
                for name, data in zip(INPUTS, pair):
                    (project / name).write_bytes(data)
                offline_ready(project, cache, node, npm)
                require(read_pair(project) == pair, 'offline-input-mutated')
            require(contracts() == source, 'source-identity-mismatch')
            record.update(status='prepared', lock_snapshot=base64.b64encode(pair[1]).decode(),
                          node_version=result['node_version'], npm_version=result['npm_version'],
                          cache=cache_identity(cache), contracts=source,
                          preparation_source_contract={'registry': result['registry'],
                                                       'contract': result['source_contract'],
                                                       'source': source['prepare-product-npm.py'],
                                                       'boundary': result['boundary']},
                          offline_install_identity={'source': source['npm-offline-ci-probe.js'],
                                                    'export': "command('ci')"},
                          artifact_path=str(artifact), artifact_identity=private_directory(artifact))
        handle = Handoff(workspace, pair, record, artifact)
        if artifact is not None:
            (artifact / 'handoff.json').write_bytes(handle._expected)
            (artifact / 'handoff.json').chmod(0o400)
        handle.verify()
        yield handle
    finally:
        if handle is not None:
            handle._active = False
        if artifact is not None:
            shutil.rmtree(artifact)
            require(not artifact.exists(), 'cleanup-residual')
