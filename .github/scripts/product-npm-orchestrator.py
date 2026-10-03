#!/usr/bin/env python3
"""Dormant trusted parent API. Never load from a workload-modified copy.

The parent retains the returned handle in memory; serialized copies are claims.
No CLI, production wiring, or persistent cache. Bootstrap is an explicit API.
"""
import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from types import MappingProxyType


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


def _mount_table():
    """Read Linux mount coordinates, including bind roots; no namespace changes."""
    rows = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        require(len(fields) >= 10 and '-' in fields[6:], 'invalid-mount-table')
        def unescape(value):
            return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)
        root, point = (Path(unescape(value)) for value in fields[3:5])
        require(root.is_absolute() and point.is_absolute(), 'invalid-mount-table')
        rows.append((fields[0], fields[2], root, point))
    require(rows, 'missing-mount-table')
    return tuple(rows)


class CanonicalRoot:
    """Read-only root identity/ancestry snapshot, retained in the trusted parent."""
    def __init__(self, path):
        require(isinstance(path, (str, Path)), 'invalid-root')
        self.path = Path(path)
        require(self.path.is_absolute() and self.path.anchor == '/' and '..' not in self.path.parts
                and str(self.path) == str(path), 'noncanonical-root')
        self._snapshot = self._observe()
        self.verify()

    def _observe(self):
        mounts = _mount_table()
        ancestry = []
        # Descriptor-relative traversal rejects symlinks in every component.
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in (None, *self.path.parts[1:]):
                if part is not None:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=fd)
                    os.close(fd)
                    fd = child
                info = os.fstat(fd)
                ancestry.append((info.st_dev, info.st_ino))
            matches = [row for row in mounts if self.path == row[3]
                       or row[3] in self.path.parents]
            depth = max(len(row[3].parts) for row in matches)
            matches = [row for row in matches if len(row[3].parts) == depth]
            require(len(matches) == 1, 'ambiguous-mount-root')
            mount_id, device, root, point = matches[0]
            require(device == f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}',
                    'mount-device-mismatch')
            # Bind aliases have different lexical ancestry, but the same
            # filesystem coordinates. Neither lexical tests nor '..' alone
            # can establish ancestry across a bind mount's root.
            physical = root / self.path.relative_to(point)
            require(_mount_table() == mounts, 'mount-identity-changed')
            check_fd = validator.directory(self.path)
            try:
                check = os.fstat(check_fd)
                require((check.st_dev, check.st_ino) == ancestry[-1], 'root-identity-changed')
            finally:
                os.close(check_fd)
            return tuple(ancestry), mount_id, device, physical
        finally:
            os.close(fd)

    def verify(self):
        require(self._observe() == self._snapshot, 'root-identity-changed')

    def overlaps(self, other):
        require(type(other) is CanonicalRoot, 'canonical-root-required')
        self.verify()
        other.verify()
        left, _, device, physical = self._snapshot
        right, _, other_device, other_physical = other._snapshot
        return (left[-1] in right or right[-1] in left
                or device == other_device and (physical == other_physical
                    or physical in other_physical.parents or other_physical in physical.parents))


class RootBoundary:
    """Disjoint workspace/repository/evidence/consumable groups, no fallback.

    Evidence roots may contain one another; overlap across groups is forbidden.
    This observes paths, not isolation from another process with the same UID.
    """
    def __init__(self, workspace, repository, trusted_roots=(), consumable=None):
        groups = [[workspace], [repository], list(trusted_roots),
                  [] if consumable is None else [consumable]]
        self._groups = tuple(tuple(CanonicalRoot(path) for path in group) for group in groups)
        self.verify()

    def verify(self):
        for index, group in enumerate(self._groups):
            for root in group:
                root.verify()
                require(not any(root.overlaps(other)
                                for later in self._groups[index + 1:] for other in later),
                        'physical-root-overlap')


def state_policy(origin):
    """Closed machine/prompt policy for an already prepared session origin."""
    require(type(origin) is str and origin in ('no-manifest', 'bootstrap', 'locked'),
            'invalid-policy-origin')
    creating = origin == 'no-manifest'
    prompt = ('You may create package.json only. Do not generate package-lock.json, '
              'install dependencies, or resolve packages from a registry. Dependencies '
              'must use exact registry versions accepted by the canonical validator; '
              'package names and versions remain subject to review.' if creating else
              'Use prepared dependencies. Preserve the exact bytes of package.json '
              'and package-lock.json. Do not regenerate the lock or resolve packages '
              'from a registry.')
    return MappingProxyType({'origin': origin, 'allow_create_manifest': creating,
                             'allow_generate_lock': False, 'allow_install': not creating,
                             'allow_registry_resolution': False,
                             'preserve_manifest_lock_bytes': not creating,
                             'dependency_versions': 'canonical-exact-registry', 'prompt': prompt})


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
    return _cache_inventory(path)


def _cache_inventory(path, content_only=False):
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
    if content_only:
        return validator.sha(json.dumps([entry[:2] for entry in entries], sort_keys=True).encode())
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
    def __init__(self, workspace, pair, record, artifact=None, bootstrap_handle=None,
                 trusted_root=None):
        self._workspace = workspace
        self._pair = pair
        self._expected = json.dumps(record, sort_keys=True).encode()
        self._artifact = artifact
        self._bootstrap = bootstrap_handle
        self._trusted_root = trusted_root
        self._active = True

    def record(self):
        return validator.parse(self._expected)

    def verify(self, claim=None):
        return self._verify(claim)

    def _verify(self, claim=None, workspace_gate=None):
        # Only the trusted session supplies an alternative workspace gate.
        # Public verify() always retains the original-workspace contract.
        require(self._active, 'expired-handoff')
        expected = self.record()
        workspace_pair = self._pair
        if self._bootstrap is not None:
            require(self._bootstrap._verify(workspace_gate=workspace_gate)
                    == expected['bootstrap_provenance'],
                    'bootstrap-provenance-mismatch')
            workspace_pair = self._bootstrap._input._pair
        require(claim is None or (isinstance(claim, dict)
                and json.dumps(claim, sort_keys=True).encode() == self._expected),
                'handoff-field-mismatch')
        def check_workspace():
            if workspace_gate is None:
                require(read_pair(self._workspace) == workspace_pair, 'workspace-input-mutated')
            else:
                workspace_gate()

        check_workspace()
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
        check_workspace()
        return expected


def verify_post_workload(handoff, claim=None):
    """Read-only gate over an active parent-held handle, never a JSON expectation.

    Prepared hashes describe frozen artifacts. Workspace presence/bytes come
    from the original parent-held pair, including manifest-only bootstrap origin.
    Only status=pass authorizes success; partial checks never authorize a caller.
    """
    result = {'schema_version': 1, 'status': 'error', 'state': 'unknown',
              'manifest_hash_check': 'not-checked', 'lock_hash_check': 'not-checked',
              'prepared_evidence_check': 'not-checked', 'provenance_check': 'not-checked',
              'preparation_identity_check': 'not-checked',
              'category': 'trusted-handoff', 'reason': 'invalid-trusted-handoff'}
    try:
        require(type(handoff) is Handoff and handoff._active is True,
                'active-trusted-handoff-required')
        expected = handoff.record()
        state = expected['state']
        require(type(expected['schema_version']) is int and expected['schema_version'] == 1
                and state in ('no-manifest', 'bootstrap-required', 'locked')
                and expected['status'] == ('prepared' if state == 'locked' else state),
                'invalid-handoff-state')
        pair = handoff._pair
        require(type(pair) is tuple and len(pair) == 2
                and all(value is None or type(value) is bytes for value in pair)
                and state == ('no-manifest' if pair[0] is None else
                              'bootstrap-required' if pair[1] is None else 'locked')
                and set(expected['input_presence']) == set(INPUTS)
                and all(type(expected['input_presence'][name]) is bool
                        and expected['input_presence'][name] == (value is not None)
                        for name, value in zip(INPUTS, pair))
                and (handoff._artifact is not None) == (state == 'locked')
                and (handoff._bootstrap is None or state == 'locked'), 'invalid-handoff-origin')
        if state == 'bootstrap-required':
            require(expected['node_version'] is None and expected['npm_version'] is None,
                    'unobserved-tool-identity-required')
        result['state'] = state
        origin = pair if handoff._bootstrap is None else handoff._bootstrap._input._pair
        result.update(category='workspace', reason='unsafe-workspace-input')
        actual = read_pair(handoff._workspace)
        for index, key in enumerate(('manifest_hash_check', 'lock_hash_check')):
            result[key] = ('pass' if actual[index] == origin[index]
                           and validator.sha(actual[index]) == validator.sha(origin[index]) else 'fail')
        for index, label in enumerate(('manifest', 'lock')):
            if (actual[index] is None) != (origin[index] is None):
                result['reason'] = label + '-presence-mismatch'
                return result
            if actual[index] != origin[index]:
                result['reason'] = label + '-hash-mismatch'
                return result

        _verify_prepared_evidence(handoff, claim, result)
    except Exception:
        # Fail closed even on malformed handles/files or unexpected verifier
        # errors; never serialize arbitrary exception text or workload content.
        pass
    return result


def _verify_prepared_evidence(handoff, claim, result, workspace_gate=None):
    """Shared evidence gate; workspace authorization remains a separate policy."""
    expected, pair = handoff.record(), handoff._pair
    state = expected['state']
    result.update(category='prepared-evidence', reason='prepared-hash-mismatch',
                  prepared_evidence_check='fail')
    if pair[0] is not None:
        require(expected['expected_post_workload_hashes']
                == dict(zip(INPUTS, map(validator.sha, pair)))
                and expected['manifest_hash'] == validator.sha(pair[0])
                and expected['lockfile_hash'] == validator.sha(pair[1]), 'prepared-hash-mismatch')
        result['reason'] = 'prepared-snapshot-mismatch'
        require(base64.b64decode(expected['manifest_snapshot'], validate=True) == pair[0],
                'prepared-snapshot-mismatch')
        if state == 'locked':
            require(base64.b64decode(expected['lock_snapshot'], validate=True) == pair[1],
                    'prepared-snapshot-mismatch')
    if handoff._bootstrap is not None:
        result['reason'] = 'bootstrap-hash-mismatch'
        provenance = expected['bootstrap_provenance']
        require(provenance['manifest_sha256'] == hashlib.sha256(pair[0]).hexdigest()
                and provenance['lock_sha256'] == provenance['generated_lock_sha256']
                == hashlib.sha256(pair[1]).hexdigest(), 'bootstrap-hash-mismatch')

    # Reuse #682/#691/#692, including #645 validation and #662 provenance.
    # The complete artifact record binds versions, command/source and cache
    # identity to parent memory. No tool probes, schema copies or writeback.
    result['reason'] = 'handoff-verification-failed'
    handoff._verify(claim, workspace_gate)
    result.update(status='pass', prepared_evidence_check='pass',
                  provenance_check='pass' if state == 'locked' else 'not-applicable',
                  preparation_identity_check='pass' if state == 'locked' else 'not-applicable',
                  category=None, reason=None)


def _npm_side_effects(workspace):
    """Observe npm output locations without following links or reading payloads."""
    entries = []

    def walk(path):
        info = path.lstat()
        entries.append((str(path.relative_to(workspace)), info.st_dev, info.st_ino,
                        info.st_mode, info.st_nlink, info.st_size,
                        info.st_mtime_ns, info.st_ctime_ns))
        if stat.S_ISDIR(info.st_mode):
            fd = validator.directory(path)
            try:
                for name in sorted(os.listdir(fd)):
                    walk(path / name)
            finally:
                os.close(fd)

    fd = validator.directory(workspace)
    try:
        for name in sorted(os.listdir(fd)):
            if (name in ('node_modules', 'npm-shrinkwrap.json', 'cache')
                    or name.startswith(('.npm', '.package-lock.json', 'npm-debug.log'))):
                walk(workspace / name)
    finally:
        os.close(fd)
    return tuple(entries)


class _WorkloadSession:
    """One callback in the active trusted parent; never reconstructed from claims."""
    def __init__(self, handoff):
        require(verify_post_workload(handoff)['status'] == 'pass', 'invalid-trusted-handoff')
        self._handoff = handoff
        self._expected = handoff._expected
        self._workspace = handoff._workspace
        self._bootstrap = handoff._bootstrap
        self._artifact = handoff._artifact
        self._origin = ('bootstrap' if handoff._bootstrap is not None else
                        handoff.record()['state'])
        require(self._origin in ('no-manifest', 'bootstrap', 'locked'),
                'prepared-session-required')
        self._baseline = handoff._pair
        if self._origin == 'no-manifest':
            require(self._baseline == (None, None), 'no-manifest-lock-present')
        self._side_effects = (_npm_side_effects(self._workspace)
                              if self._origin == 'no-manifest' else None)
        self._workspace_identity = self._directory_identity()
        self._materialized_hashes = None
        self._materialized_identity = None
        self._cache = None
        self._active = True
        self._started = False
        self._completed = False
        self._failed = False
        self._roots = None

    def _directory_identity(self):
        fd = validator.directory(self._workspace)
        try:
            info = os.fstat(fd)
            return (info.st_dev, info.st_ino)
        finally:
            os.close(fd)

    def _materialize(self):
        # Reverify the original manifest-only workspace immediately before the
        # exclusive descriptor-relative write. A matching preexisting lock fails.
        handoff = self._handoff
        require(verify_post_workload(handoff)['status'] == 'pass', 'pre-write-verification-failed')
        require(self._directory_identity() == self._workspace_identity, 'workspace-identity-mismatch')
        before = read_pair(self._workspace)
        require(before == (self._baseline[0], None), 'workspace-input-mutated')
        prepared_hash = validator.sha(self._baseline[1])
        fd = validator.directory(self._workspace)
        try:
            file_fd = os.open('package-lock.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL
                              | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
            with os.fdopen(file_fd, 'wb') as stream:
                info = os.fstat(stream.fileno())
                self._materialized_identity = (info.st_dev, info.st_ino)
                self._materialized_hashes = (prepared_hash, prepared_hash)
                stream.write(self._baseline[1])
                stream.flush()
                info = os.fstat(stream.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe-materialized-lock')
                identity = (info.st_dev, info.st_ino)
            after = read_pair(self._workspace)
            info = os.stat('package-lock.json', dir_fd=fd, follow_symlinks=False)
            require((info.st_dev, info.st_ino) == identity
                    and self._directory_identity() == self._workspace_identity
                    and after == self._baseline, 'materialized-lock-mismatch')
            self._materialized_hashes = (prepared_hash, validator.sha(after[1]))
            require(self._materialized_hashes[0] == self._materialized_hashes[1],
                    'materialized-lock-mismatch')
            self._materialized_identity = identity
        finally:
            os.close(fd)

    def _workspace_gate(self):
        if self._roots is not None:
            self._roots.verify()
        require(self._active and self._handoff._active
                and self._handoff._expected == self._expected
                and self._handoff._workspace == self._workspace
                and self._handoff._bootstrap is self._bootstrap
                and self._handoff._artifact == self._artifact
                and self._handoff._pair == self._baseline, 'expired-or-mutated-session')
        require(self._directory_identity() == self._workspace_identity, 'workspace-identity-mismatch')
        actual = read_pair(self._workspace)
        if self._origin == 'no-manifest':
            require(actual[1] is None, 'unexpected-lock')
            if actual[0] is not None:
                validator.manifest_dependencies(validator.parse(actual[0]))
            require(_npm_side_effects(self._workspace) == self._side_effects, 'unexpected-npm-side-effect')
        else:
            require(actual == self._baseline, 'workspace-baseline-mismatch')
            if self._origin == 'bootstrap':
                require(self._materialized_hashes == (validator.sha(self._baseline[1]),) * 2,
                        'trusted-materialization-required')
                info = (self._workspace / 'package-lock.json').lstat()
                require((info.st_dev, info.st_ino) == self._materialized_identity,
                        'materialized-lock-identity-mismatch')
        require(read_pair(self._workspace) == actual, 'workspace-input-mutated')

    def verify(self):
        result = {'schema_version': 1, 'status': 'error', 'origin': self._origin,
                  'workspace_check': 'not-checked', 'prepared_evidence_check': 'not-checked',
                  'category': 'session', 'reason': 'active-completed-session-required'}
        try:
            require(self._active and self._completed and not self._failed,
                    'active-completed-session-required')
            result.update(category='workspace', reason='workspace-policy-failed')
            self._workspace_gate()
            result['workspace_check'] = 'pass'
            evidence = {}
            _verify_prepared_evidence(self._handoff, None, evidence, self._workspace_gate)
            require(evidence['status'] == 'pass', 'prepared-evidence-failed')
            result.update(status='pass', prepared_evidence_check='pass', category=None, reason=None)
        except Exception:
            if result['workspace_check'] == 'pass':
                result.update(category='prepared-evidence', reason='prepared-evidence-failed')
        return result

    def run(self, consumer):
        require(self._active and not self._started, 'single-workload-required')
        self._started = True
        policy = state_policy(self._origin)
        # Only a consumable path and closed policy cross the consumer contract.
        contract = MappingProxyType({'policy': policy, 'cache_path': self._cache})
        try:
            self._workspace_gate()
            evidence = {}
            _verify_prepared_evidence(self._handoff, None, evidence, self._workspace_gate)
            require(evidence['status'] == 'pass', 'prepared-evidence-failed')
        except Exception:
            self._failed = True
            return {'schema_version': 1, 'status': 'error', 'origin': self._origin,
                    'workspace_check': 'not-checked', 'prepared_evidence_check': 'not-checked',
                    'category': 'session', 'reason': 'pre-workload-verification-failed'}
        try:
            require(consumer(contract) is True, 'consumer-failed')
            self._completed = True
        except Exception:
            self._failed = True
            return {'schema_version': 1, 'status': 'error', 'origin': self._origin,
                    'workspace_check': 'not-checked', 'prepared_evidence_check': 'not-checked',
                    'category': 'consumer', 'reason': 'consumer-failed'}
        return self.verify()


    def cleanup_materialized_lock(self):
        """Explicit failure cleanup: remove only our still-identical exact lock.

        Missing/changed/unknown files are dirty, never successful cleanup. This
        does not roll back consumer edits or authorize downstream writes.
        """
        if self._origin != 'bootstrap':
            return 'none'
        try:
            require(self._active and self._materialized_identity is not None
                    and self._materialized_hashes == (validator.sha(self._baseline[1]),) * 2,
                    'unknown-materialization')
            if self._roots is not None:
                self._roots.verify()
            require(self._directory_identity() == self._workspace_identity,
                    'workspace-identity-mismatch')
            fd = validator.directory(self._workspace)
            try:
                before = os.stat('package-lock.json', dir_fd=fd, follow_symlinks=False)
                require((before.st_dev, before.st_ino) == self._materialized_identity
                        and validator.read_input(fd, 'package-lock.json') == self._baseline[1],
                        'materialized-lock-mismatch')
                after = os.stat('package-lock.json', dir_fd=fd, follow_symlinks=False)
                def signature(info):
                    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                            info.st_uid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                require(signature(before) == signature(after)
                        and self._directory_identity() == self._workspace_identity,
                        'materialized-lock-mismatch')
                os.unlink('package-lock.json', dir_fd=fd)
                require(validator.read_input(fd, 'package-lock.json') is None,
                        'cleanup-residual')
            finally:
                os.close(fd)
            self._failed = True
            return 'removed'
        except Exception:
            self._failed = True
            return 'dirty'


@contextmanager
def workload_session(handoff, export_root=None):
    """Dormant #702 parent lifetime: preparation, one callback, post gate.

    export_root is a caller-owned consumable area, separate from all evidence.
    Filesystem isolation of the trusted roots is the future launcher's duty.
    """
    session = _WorkloadSession(handoff)
    export = None
    try:
        trusted_roots = [] if handoff._trusted_root is None else [handoff._trusted_root]
        if handoff._bootstrap is not None:
            trusted_roots.append(handoff._bootstrap._artifact.parent.parent)
        session._roots = RootBoundary(session._workspace, Path(__file__).absolute().parents[2],
                                      trusted_roots, export_root)
        if session._origin != 'no-manifest':
            root_identity = private_directory(export_root)
            export = Path(tempfile.mkdtemp(prefix='npm-consumable-', dir=export_root))
            require(private_directory(export_root) == root_identity, 'consumable-root-changed')
            private_directory(export)
            source = Path(handoff.record()['cache']['path'])
            cache = export / 'cache'
            shutil.copytree(source, cache, symlinks=True)
            # Bind source before/after; compare bytes/types without copied inode
            # identities. Never re-use the export as post-workload evidence.
            handoff.verify()
            require(cache_identity(cache)['directory_identity']
                    != handoff.record()['cache']['directory_identity']
                    and _cache_inventory(cache, content_only=True)
                    == _cache_inventory(source, content_only=True), 'cache-export-mismatch')
            handoff.verify()
            session._cache = str(cache)
        if session._origin == 'bootstrap':
            session._materialize()
        session._workspace_gate()
        yield session
    finally:
        session._active = False
        if export is not None:
            shutil.rmtree(export)
            require(not export.exists(), 'cleanup-residual')


def production_session(handoff, consumer, export_root=None):
    """Dormant #710 composition over active #702 memory, never a launcher.

    The injected trusted callback must wait for completion and return exact
    True. Only a pass after context cleanup permits subsequent caller writes.
    Preparation/bootstrap and runtime isolation remain outside this API.
    """
    result = {'schema_version': 1, 'status': 'error', 'origin': 'unknown',
              'category': 'session', 'reason': 'production-session-failed',
              'downstream_write_allowed': False, 'failure_ownership': 'none'}
    try:
        require(type(handoff) is Handoff and handoff._active is True,
                'active-trusted-handoff-required')
        origin = 'bootstrap' if handoff._bootstrap is not None else handoff.record()['state']
        state_policy(origin)
        result['origin'] = origin
        # Entry failures may leave an incompletely materialized file. Without
        # session identity/hash evidence this remains a dirty hard failure.
        result['failure_ownership'] = 'dirty' if origin == 'bootstrap' else 'none'
        with workload_session(handoff, export_root) as session:
            gate = session.run(consumer)
            result.update(status=gate['status'], category=gate['category'], reason=gate['reason'])
            if gate['status'] != 'pass':
                result['failure_ownership'] = session.cleanup_materialized_lock()
                if result['failure_ownership'] == 'dirty':
                    result.update(category='cleanup', reason='dirty-materialized-lock')
            else:
                result['failure_ownership'] = 'retained' if origin == 'bootstrap' else 'none'
        result['downstream_write_allowed'] = result['status'] == 'pass'
    except Exception:
        result.update(status='error', category='session', reason='production-session-failed',
                      downstream_write_allowed=False)
        if result['failure_ownership'] == 'retained':
            result['failure_ownership'] = 'dirty'
    return result


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
        handle = Handoff(workspace, pair, record, artifact,
                         trusted_root=run_root if artifact is not None else None)
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


class ValidatedBootstrap:
    """#662 expectation retained by the parent, separate from #682 locked setup."""
    def __init__(self, input_handle, artifact, expected, runtime):
        self._input = input_handle
        self._artifact = artifact
        self._expected = json.dumps(expected, sort_keys=True).encode()
        self._runtime = runtime
        self._identity = private_directory(artifact)
        self._contracts = contracts()
        self._active = True

    def record(self):
        return validator.parse(self._expected)

    def verify(self, claim=None):
        return self._verify(claim)

    def _verify(self, claim=None, workspace_gate=None):
        require(self._active, 'expired-handoff')
        self._input._verify(workspace_gate=workspace_gate)
        require(claim is None or isinstance(claim, dict)
                and json.dumps(claim, sort_keys=True).encode() == self._expected,
                'handoff-field-mismatch')
        require(contracts() == self._contracts
                and self._runtime.contract_identities(Path(__file__).absolute().parents[2])
                == self.record()['contracts'], 'source-identity-mismatch')
        require(private_directory(self._artifact) == self._identity, 'artifact-identity-mismatch')
        record = self._runtime.verify_handoff(validator, self._artifact, self.record())
        require(record['manifest_sha256'] == hashlib.sha256(self._input._pair[0]).hexdigest()
                and read_pair(self._artifact)[0] == self._input._pair[0], 'trusted-manifest-mismatch')
        self._input._verify(workspace_gate=workspace_gate)
        return record


@contextmanager
def bootstrap(input_handle, run_root):
    """Explicit #691 composition of an active #682 bootstrap-required Handoff.

    Serialized claims cannot start generation. #650 selects the trusted runtime;
    Output stays #662's validated artifact; prepare_bootstrap() composes #682.
    """
    require(type(input_handle) is Handoff, 'trusted-bootstrap-handle-required')
    record = input_handle.verify()
    require(record['state'] == record['status'] == 'bootstrap-required', 'bootstrap-input-required')
    snapshot = input_handle._pair[0]
    require(record['manifest_hash'] == validator.sha(snapshot)
            and base64.b64decode(record['manifest_snapshot'], validate=True) == snapshot,
            'trusted-manifest-mismatch')
    root_identity = private_directory(run_root)
    excluded = [input_handle._workspace, Path(__file__).absolute().parents[2]]
    if os.environ.get('RUNNER_TEMP'):
        excluded.append(Path(os.environ['RUNNER_TEMP']).resolve())
    require(not any(run_root == path or run_root in path.parents or path in run_root.parents
                    for path in excluded), 'overlapping-trusted-root')
    runtime = load('npm-registry-lock-runtime')
    handle = None
    with tempfile.TemporaryDirectory(prefix='bootstrap-run-', dir=run_root) as temporary:
        output_root = Path(temporary)
        require(private_directory(run_root) == root_identity, 'run-root-changed')
        artifact, expected = runtime.generate_validated(Path(__file__).absolute().parents[2],
                                                       snapshot, output_root)
        require(artifact.parent == output_root, 'artifact-path-mismatch')
        try:
            handle = ValidatedBootstrap(input_handle, artifact, expected, runtime)
            handle.verify()
            yield handle
        finally:
            if handle is not None:
                handle._active = False
    require(not output_root.exists(), 'cleanup-residual')


@contextmanager
def prepare_bootstrap(validated, run_root, node, npm):
    """Consume an active #691 handle into #682's shared prepared handoff.

    Only reverified bytes enter fresh private inputs. The original workspace
    remains manifest-only; locked handoff fields describe the prepared snapshots.
    All handles/artifacts expire on exit, including failed composition attempts.
    """
    require(type(validated) is ValidatedBootstrap, 'trusted-validated-handle-required')
    require(validated._active, 'expired-handoff')
    handle = None
    try:
        provenance = validated.verify()  # Includes #662 verify_handoff().
        pair = read_pair(validated._artifact)
        require(pair[0] == validated._input._pair[0]
                and hashlib.sha256(pair[0]).hexdigest() == provenance['manifest_sha256']
                and hashlib.sha256(pair[1]).hexdigest() == provenance['lock_sha256']
                == provenance['generated_lock_sha256'], 'validated-snapshot-mismatch')
        require(validated.verify() == provenance, 'bootstrap-provenance-mismatch')
        root_identity = private_directory(run_root)
        excluded = [validated._input._workspace, Path(__file__).absolute().parents[2]]
        if os.environ.get('RUNNER_TEMP'):
            excluded.append(Path(os.environ['RUNNER_TEMP']).resolve())
        require(not any(run_root == path or run_root in path.parents or path in run_root.parents
                        for path in excluded)
                and run_root != validated._artifact and validated._artifact not in run_root.parents,
                'overlapping-trusted-root')
        with tempfile.TemporaryDirectory(prefix='bootstrap-composition-', dir=run_root) as temporary:
            composition = Path(temporary)
            require(private_directory(run_root) == root_identity, 'run-root-changed')
            private_directory(composition)
            frozen, locked_root = composition / 'inputs', composition / 'locked'
            for path in (frozen, locked_root):
                path.mkdir(mode=0o700)
                private_directory(path)
            for name, data in zip(INPUTS, pair):
                (frozen / name).write_bytes(data)
                (frozen / name).chmod(0o400)
            with prepare(frozen, locked_root, node, npm) as inner:
                record = inner.verify()
                require(validated.verify() == provenance, 'bootstrap-provenance-mismatch')
                record['bootstrap_provenance'] = provenance
                handle = Handoff(validated._input._workspace, pair, record,
                                 inner._artifact, bootstrap_handle=validated, trusted_root=run_root)
                target = inner._artifact / 'handoff.json'
                target.chmod(0o600)
                target.write_bytes(handle._expected)
                target.chmod(0o400)
                handle.verify()
                yield handle
    finally:
        if handle is not None:
            handle._active = False
        validated._active = False
        shutil.rmtree(validated._artifact)
        require(not validated._artifact.exists(), 'cleanup-residual')
