#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from unittest.mock import patch

repo = Path(sys.argv[1]).resolve()
source = repo / '.github/scripts/product-npm-orchestrator.py'
spec = importlib.util.spec_from_file_location('post_workload', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
validator = helper.validator
runtime = helper.load('npm-registry-lock-runtime')
node, npm = Path(shutil.which('node')), Path(shutil.which('npm'))
manifest = b'{"name":"post-workload-fixture","version":"1.0.0"}\n'
lock = json.dumps({'name': 'post-workload-fixture', 'version': '1.0.0',
                  'lockfileVersion': 3, 'packages': {'': validator.parse(manifest)}}).encode() + b'\n'
command = runtime.initial_command(repo, node, 12345)
runtime_source = {**runtime.runtime_hashes(node, npm), 'node_source': str(node),
                  'npm_source': str(npm), 'node_version': 'v24.0.0', 'npm_version': '11.0.0'}


with tempfile.TemporaryDirectory(prefix='post-workload-fixture-') as temporary:
    base = Path(temporary)
    workspace, trusted = base / 'workspace', base / 'trusted'
    workspace.mkdir()
    trusted.mkdir(mode=0o700)

    def write_pair(pair):
        for name, value in zip(helper.INPUTS, pair):
            target = workspace / name
            if value is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(value)

    def inventory():
        # Capture content and write metadata; reads can legitimately update atime.
        result = {}
        for path in (base, *sorted(base.rglob('*'))):
            info = path.lstat()
            result[str(path)] = (info.st_mode, info.st_dev, info.st_ino, info.st_mtime_ns,
                                 path.read_bytes() if stat.S_ISREG(info.st_mode) else None)
        return result

    def check(handle, reason=None, claim=None):
        before = inventory()
        # A verifier must never launch npm, regenerate inputs or clean up artifacts.
        with patch.object(subprocess, 'run', side_effect=AssertionError('tool invoked')) as tools, \
             patch.object(Path, 'write_bytes', side_effect=AssertionError('file write')) as bytes_write, \
             patch.object(Path, 'write_text', side_effect=AssertionError('file write')) as text_write, \
             patch.object(shutil, 'rmtree', side_effect=AssertionError('cleanup invoked')) as cleanup:
            result = helper.verify_post_workload(handle, claim)
            assert helper.verify_post_workload(handle, claim) == result, 'non-deterministic verification'
            for forbidden in (tools, bytes_write, text_write, cleanup):
                forbidden.assert_not_called()
        assert inventory() == before, 'verifier changed workspace/trusted artifact'
        assert result['status'] == ('pass' if reason is None else 'error'), result
        assert result['reason'] == reason, result
        assert set(result) == {'schema_version', 'status', 'state', 'manifest_hash_check',
                               'lock_hash_check', 'prepared_evidence_check', 'provenance_check',
                               'preparation_identity_check', 'category', 'reason'}
        assert all(result[key] in ('pass', 'fail', 'not-checked', 'not-applicable')
                   for key in result if key.endswith('_check'))
        if reason is None:
            assert result['manifest_hash_check'] == result['lock_hash_check'] == 'pass'
            assert result['prepared_evidence_check'] == 'pass' and result['category'] is None
        else:
            assert result['category'] in ('trusted-handoff', 'workspace', 'prepared-evidence')
        assert 'fixture-sensitive' not in json.dumps(result)
        return result

    def preparation(frozen, output, node, npm):
        # Local mock transport only; canonical validation remains in Handoff.verify.
        pair = helper.read_pair(frozen)
        destination = Path(tempfile.mkdtemp(prefix='product-npm-', dir=output))
        for name, value in zip(helper.INPUTS, pair):
            (destination / name).write_bytes(value)
        cache = destination / 'cache'
        cache.mkdir(mode=0o700)
        (cache / 'warm').write_bytes(b'fixture-cache')
        return {'state': 'locked', 'status': 'prepared',
                'manifest_hash': validator.sha(pair[0]), 'lockfile_hash': validator.sha(pair[1]),
                'preparation_path': str(destination), 'cache_path': str(cache),
                'node_version': 'v24.0.0', 'npm_version': '11.0.0', 'registry': validator.REGISTRY,
                'source_contract': 'npm-official-tarball-with-integrity-v1',
                'boundary': {'fixture': 'local-only'}}

    def generate(repo, exact, output):
        # Real #662 freeze/verify; generation itself is a local mock, no service.
        assert exact == manifest
        with tempfile.TemporaryDirectory(prefix='generation-', dir=base) as generation:
            root = Path(generation) / 'root'
            (root / 'runtime').mkdir(parents=True)
            (root / 'project').mkdir()
            (root / 'runtime/manifest.json').write_bytes(exact)
            (root / 'project/package.json').write_bytes(exact)
            (root / 'project/package-lock.json').write_bytes(lock)
            expected = {'manifest_sha256': hashlib.sha256(exact).hexdigest(),
                        'runtime_source': runtime_source,
                        'staged_runtime_hashes': runtime.runtime_hashes(node, npm),
                        'generation_id': uuid.uuid4().hex, 'generation_root': generation,
                        'run_id': output.name, 'contracts': runtime.contract_identities(repo)}
            evidence = {'status': 'pass', 'candidate': 'package-lock.json',
                        'manifest_hash': expected['manifest_sha256'],
                        'lock_hash': hashlib.sha256(lock).hexdigest(), 'command': command,
                        'node': runtime_source['node_version'], 'npm': runtime_source['npm_version'],
                        'markers': [], 'node_modules': False, 'metadata_requests': 0,
                        'tarball_requests': 0, 'dependency_execution_path': 'not-entered'}
            result = runtime.freeze_candidate(repo, root, output, exact, expected, evidence)
        runtime.verify_handoff(validator, *result)
        return result

    def changed_file(handle, path, value, reason='handoff-verification-failed'):
        original, mode = path.read_bytes(), stat.S_IMODE(path.stat().st_mode)
        path.chmod(0o600)
        path.write_bytes(value)
        path.chmod(mode)
        check(handle, reason)
        path.chmod(0o600)
        path.write_bytes(original)
        path.chmod(mode)
        check(handle)

    # Parent origin governs all three initial states, including an existing orphan
    # lock on no-manifest origin. No new manifest/lock side effect is admitted.
    for pair, state in (((None, None), 'no-manifest'), ((None, lock), 'no-manifest'),
                        ((manifest, None), 'bootstrap-required')):
        write_pair(pair)
        with helper.prepare(workspace, trusted, node, npm) as handle:
            result = check(handle)
            assert result['state'] == state
            assert result['provenance_check'] == result['preparation_identity_check'] == 'not-applicable'
            for index, label in enumerate(('manifest', 'lock')):
                changed = list(pair)
                changed[index] = (manifest if index == 0 else lock) if pair[index] is None else None
                write_pair(changed)
                check(handle, label + '-presence-mismatch')
                write_pair(pair)
                if pair[index] is not None:
                    changed[index] = pair[index] + b' '
                    write_pair(changed)
                    check(handle, label + '-hash-mismatch')
                    write_pair(pair)
            for field in handle.record():
                malformed = handle.record()
                malformed.pop(field)
                with patch.object(handle, '_expected', json.dumps(malformed).encode()):
                    reason = ('prepared-hash-mismatch' if field in
                              ('expected_post_workload_hashes', 'manifest_hash', 'lockfile_hash') else
                              'prepared-snapshot-mismatch' if field == 'manifest_snapshot' else
                              'invalid-trusted-handoff' if field in
                              ('schema_version', 'state', 'status', 'input_presence',
                               'node_version', 'npm_version') else None)
                    check(handle, reason)
            check(handle)
        check(handle, 'invalid-trusted-handoff')

    for value in (None, {}, {'schema_version': 1, 'state': 'locked'}, b'{}', workspace):
        check(value, 'invalid-trusted-handoff')

    # Direct existing-lock origin: exact original bytes and absence are mandatory.
    write_pair((manifest, lock))
    with patch.object(helper.locked, 'prepare', side_effect=preparation), \
         patch.object(helper, 'offline_ready', return_value=None):
        with helper.prepare(workspace, trusted, node, npm) as handle:
            record = handle.record()
            result = check(handle)
            assert result['state'] == 'locked'
            assert result['provenance_check'] == result['preparation_identity_check'] == 'pass'
            for index, label in enumerate(('manifest', 'lock')):
                for value, reason in ((None, '-presence-mismatch'),
                                      ((manifest, lock)[index] + b' ', '-hash-mismatch')):
                    pair = [manifest, lock]
                    pair[index] = value
                    write_pair(pair)
                    check(handle, label + reason)
                    write_pair((manifest, lock))

            # Every missing/changed claim field is rejected without using it as
            # the expectation, including versions, boundary/command and cache.
            for field in record:
                claim = copy.deepcopy(record)
                claim.pop(field)
                check(handle, 'handoff-verification-failed', claim)
                claim = copy.deepcopy(record)
                claim[field] = 'fixture-sensitive'
                check(handle, 'handoff-verification-failed', claim)
            for claim in ([], 'fixture-sensitive', {'unknown': True}):
                check(handle, 'handoff-verification-failed', claim)
            check(handle, claim=record)
            record['node_version'] = 'fixture-sensitive'
            check(handle)  # Mutating a returned record cannot replace parent memory.

            artifact = handle._artifact
            for name in (*helper.INPUTS, 'handoff.json'):
                changed_file(handle, artifact / name, b'fixture-sensitive')
            disk_record = handle.record()
            disk_record['node_version'] = 'fixture-sensitive'
            changed_file(handle, artifact / 'handoff.json', json.dumps(disk_record).encode())
            target = artifact / 'handoff.json'
            saved = target.read_bytes()
            target.unlink()
            check(handle, 'handoff-verification-failed')
            target.write_bytes(saved)
            target.chmod(0o400)

            cache = Path(handle.record()['cache']['path'])
            changed_file(handle, cache / 'warm', b'fixture-sensitive')
            saved_cache = trusted / 'saved-cache'
            cache.rename(saved_cache)
            shutil.copytree(saved_cache, cache)
            check(handle, 'handoff-verification-failed')  # Same bytes, different identity.
            shutil.rmtree(cache)
            saved_cache.rename(cache)
            with patch.object(helper, 'contracts', return_value={}):
                check(handle, 'handoff-verification-failed')
            with patch.object(helper, 'cache_identity', side_effect=OSError('fixture-sensitive')):
                check(handle, 'handoff-verification-failed')
            # Mutation observed on the last workspace re-read rejects a gate
            # whose initial workspace check passed; no actual fixture write.
            with patch.object(helper, 'read_pair', side_effect=[
                    (manifest, lock), (manifest, lock), (manifest + b' ', lock)] * 2):
                check(handle, 'handoff-verification-failed')

            # Workspace and trusted snapshot symlinks, hardlinks, directories,
            # dangling links and FIFOs fail closed, without blocking on a FIFO.
            for root, reason in ((workspace, 'unsafe-workspace-input'),
                                 (artifact, 'handoff-verification-failed')):
                for name in helper.INPUTS:
                    target = root / name
                    saved, mode = target.read_bytes(), stat.S_IMODE(target.stat().st_mode)
                    for kind in ('symlink', 'dangling', 'fifo', 'directory', 'hardlink'):
                        target.unlink()
                        other = base / 'other-input'
                        if kind == 'symlink':
                            target.symlink_to(cache / 'warm')
                        elif kind == 'dangling':
                            target.symlink_to(base / 'missing')
                        elif kind == 'fifo':
                            os.mkfifo(target)
                        elif kind == 'directory':
                            target.mkdir()
                        else:
                            other.write_bytes(saved)
                            os.link(other, target)
                        check(handle, reason)
                        if kind == 'directory':
                            target.rmdir()
                        else:
                            target.unlink()
                        other.unlink(missing_ok=True)
                        target.write_bytes(saved)
                        target.chmod(mode)
            alias = base / 'workspace-alias'
            alias.symlink_to(workspace, target_is_directory=True)
            for path in (alias, Path('relative'), workspace / '..' / workspace.name):
                with patch.object(handle, '_workspace', path):
                    check(handle, 'unsafe-workspace-input')
            check(handle)
        check(handle, 'invalid-trusted-handoff')
    assert not list(trusted.iterdir())

    # Bootstrap prepared pair includes a validated lock; original workspace does
    # not. Matching prepared lock bytes added to workspace must STILL be rejected.
    write_pair((manifest, None))
    original_load = helper.load
    with patch.object(helper, 'load', side_effect=lambda name:
                      runtime if name == 'npm-registry-lock-runtime' else original_load(name)), \
         patch.object(runtime, 'generate_validated', side_effect=generate), \
         patch.object(helper.locked, 'prepare', side_effect=preparation), \
         patch.object(helper, 'offline_ready', return_value=None):
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            with helper.bootstrap(input_handle, trusted) as validated:
                with helper.prepare_bootstrap(validated, trusted, node, npm) as handle:
                    record = handle.record()
                    assert record['expected_post_workload_hashes']['package-lock.json'] == validator.sha(lock)
                    assert not (workspace / 'package-lock.json').exists()
                    check(handle)
                    write_pair((manifest, lock))
                    check(handle, 'lock-presence-mismatch')
                    write_pair((manifest, None))
                    write_pair((manifest + b' ', None))
                    check(handle, 'manifest-hash-mismatch')
                    write_pair((manifest, None))
                    for artifact in (validated._artifact, handle._artifact):
                        changed_file(handle, artifact / 'package-lock.json', lock + b' ')
                    provenance_path = validated._artifact / 'provenance.json'
                    provenance = validated.record()
                    for field in provenance:
                        bad = copy.deepcopy(provenance)
                        bad[field] = 'fixture-sensitive'
                        changed_file(handle, provenance_path, json.dumps(bad).encode())
                    with patch.object(runtime, 'contract_identities', return_value={}):
                        check(handle, 'handoff-verification-failed')
                    with patch.object(validated, '_active', False):
                        check(handle, 'handoff-verification-failed')
                    with patch.object(input_handle, '_active', False):
                        check(handle, 'handoff-verification-failed')
                    # Malformed parent memory and prepared hash/snapshot mismatch
                    # are rejected too; no schema is restored from serialized data.
                    for field, value, reason in (
                            ('schema_version', True, 'invalid-trusted-handoff'),
                            ('state', 'fixture-sensitive', 'invalid-trusted-handoff'),
                            ('expected_post_workload_hashes', {}, 'prepared-hash-mismatch'),
                            ('manifest_snapshot', '', 'prepared-snapshot-mismatch'),
                            ('bootstrap_provenance', {}, 'bootstrap-hash-mismatch')):
                        bad = copy.deepcopy(record)
                        bad[field] = value
                        with patch.object(handle, '_expected', json.dumps(bad).encode()):
                            check(handle, reason)
                    with patch.object(handle, '_expected', b'not-json'):
                        check(handle, 'invalid-trusted-handoff')
                    check(handle)
        check(handle, 'invalid-trusted-handoff')
    assert helper.read_pair(workspace) == (manifest, None) and not list(trusted.iterdir())


    # #702: same trusted parent, explicit session policy, fresh consumable cache.
    exports = base / 'exports'
    exports.mkdir(mode=0o700)

    def rejected(call):
        try:
            call()
        except (validator.Rejected, OSError, TypeError, AttributeError):
            return
        raise AssertionError('unsafe session accepted')

    def assert_result(result, status='pass', reason=None):
        assert result['status'] == status and result['reason'] == reason, result
        assert set(result) == {'schema_version', 'status', 'origin', 'workspace_check',
                               'prepared_evidence_check', 'category', 'reason'}
        assert 'fixture-sensitive' not in json.dumps(result)
        if status == 'pass':
            assert result['workspace_check'] == result['prepared_evidence_check'] == 'pass'

    def session_check(session, status='pass', reason=None):
        before = inventory()
        with patch.object(subprocess, 'run', side_effect=AssertionError('tool invoked')):
            result = session.verify()
            assert session.verify() == result, 'session verification not deterministic'
        assert inventory() == before, 'session verifier wrote to disk'
        assert_result(result, status, reason)

    def inspect_contract(contract, origin):
        assert set(contract) == {'policy', 'cache_path'}
        assert dict(contract['policy']) == {'origin': origin,
                'allow_create_manifest': origin == 'no-manifest', 'allow_generate_lock': False}
        rejected(lambda: contract.__setitem__('cache_path', 'fixture-sensitive'))
        rejected(lambda: contract['policy'].__setitem__('origin', 'locked'))
        assert str(trusted) not in repr(contract), 'trusted evidence exposed'

    # No-manifest does no trusted writes, not even to an export directory.
    for creation in (None, manifest, b'{"dependencies":{"example":"1.2.3"}}'):
        write_pair((None, None))
        with helper.prepare(workspace, trusted, node, npm) as handle:
            before = inventory()
            with helper.workload_session(handle) as session:
                assert inventory() == before
                session_check(session, 'error', 'active-completed-session-required')

                def create(contract):
                    inspect_contract(contract, 'no-manifest')
                    assert contract['cache_path'] is None
                    if creation is not None:
                        (workspace / 'package.json').write_bytes(creation)
                    return True

                assert_result(session.run(create))
                session_check(session)
                rejected(lambda: session.run(create))  # Exactly one callback.
                if creation is not None:
                    check(handle, 'manifest-presence-mismatch')  # #684 unchanged.
            session_check(session, 'error', 'active-completed-session-required')
        assert not list(trusted.iterdir()) and not list(exports.iterdir())

    for bad in (b'not-json', b'[]', b'{"dependencies":{},"dependencies":{}}',
                b'{"dependencies":{"x":"^1.0.0"}}', b'{"dependencies":{"x":"file:../x"}}',
                b'{"dependencies":{"x":"npm:y@1.0.0"}}', b'{"workspaces":[]}',
                b'{"overrides":{}}', b'{"bundledDependencies":[]}'):
        write_pair((None, None))
        with helper.prepare(workspace, trusted, node, npm) as handle:
            with helper.workload_session(handle) as session:
                def malformed(contract):
                    (workspace / 'package.json').write_bytes(bad)
                    return True
                assert_result(session.run(malformed), 'error', 'workspace-policy-failed')
                session_check(session, 'error', 'workspace-policy-failed')

    for name in ('package-lock.json', 'npm-shrinkwrap.json', '.package-lock.json',
                 '.npmrc', '.npm', 'node_modules', 'cache', 'npm-debug.log.123'):
        write_pair((None, None))
        with helper.prepare(workspace, trusted, node, npm) as handle:
            with helper.workload_session(handle) as session:
                target = workspace / name
                def side_effect(contract):
                    if name in ('node_modules', '.npm', 'cache'):
                        target.mkdir()
                        (target / 'generated').write_bytes(b'fixture-sensitive')
                    else:
                        target.write_bytes(lock)
                    return True
                assert_result(session.run(side_effect), 'error', 'workspace-policy-failed')
                session_check(session, 'error', 'workspace-policy-failed')
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()

    # Unsafe newly-created manifest: regular single-link files only.
    for kind in ('symlink', 'hardlink', 'fifo', 'directory'):
        write_pair((None, None))
        other = base / 'session-other'
        other.write_bytes(manifest)
        target = workspace / 'package.json'
        with helper.prepare(workspace, trusted, node, npm) as handle:
            with helper.workload_session(handle) as session:
                def unsafe(contract):
                    if kind == 'symlink':
                        target.symlink_to(other)
                    elif kind == 'hardlink':
                        os.link(other, target)
                    elif kind == 'fifo':
                        os.mkfifo(target)
                    else:
                        target.mkdir()
                    return True
                assert_result(session.run(unsafe), 'error', 'workspace-policy-failed')
                if kind == 'directory':
                    target.rmdir()
                else:
                    target.unlink()
        other.unlink()

    for outcome in ('exception', False, None, {'status': 'pass'}, 1):
        write_pair((None, None))
        with helper.prepare(workspace, trusted, node, npm) as handle:
            with helper.workload_session(handle) as session:
                def failure(contract):
                    if outcome == 'exception':
                        raise RuntimeError('fixture-sensitive')
                    return outcome
                assert_result(session.run(failure), 'error', 'consumer-failed')
                session_check(session, 'error', 'active-completed-session-required')

    # Preparation changes after entry stop before the callback. Cleanup failures
    # propagate and never turn a successful machine gate into caller success.
    write_pair((None, None))
    with helper.prepare(workspace, trusted, node, npm) as handle:
        with helper.workload_session(handle) as session:
            called = []
            with patch.object(handle, '_active', False):
                assert_result(session.run(lambda contract: called.append(contract)),
                              'error', 'pre-workload-verification-failed')
            assert not called

    write_pair((None, lock))
    with helper.prepare(workspace, trusted, node, npm) as orphan:
        rejected(lambda: helper.workload_session(orphan).__enter__())
    write_pair((manifest, None))
    with helper.prepare(workspace, trusted, node, npm) as unprepared:
        rejected(lambda: helper.workload_session(unprepared, exports).__enter__())
    for claim in (None, {}, handle.record(), b'{}'):
        rejected(lambda: helper.workload_session(claim, exports).__enter__())
    rejected(lambda: helper.workload_session(handle, exports).__enter__())  # Expired.

    def exercise_locked(handle, origin):
        original = helper.read_pair(workspace)
        prepared = handle._pair
        for overlapping in (workspace, handle._artifact.parent, base):
            rejected(lambda: helper.workload_session(handle, overlapping).__enter__())
            assert helper.read_pair(workspace) == original
        # A corrupt export never reaches a consumer or bootstrap pre-write.
        original_copy = shutil.copytree
        def corrupt_export(source_cache, destination, **kwargs):
            result = original_copy(source_cache, destination, **kwargs)
            (destination / 'warm').write_bytes(b'fixture-sensitive')
            return result
        with patch.object(shutil, 'copytree', side_effect=corrupt_export):
            rejected(lambda: helper.workload_session(handle, exports).__enter__())
        assert helper.read_pair(workspace) == original and not list(exports.iterdir())
        with helper.workload_session(handle, exports) as session:
            assert helper.read_pair(workspace) == prepared
            if origin == 'bootstrap':
                assert session._materialized_hashes == (validator.sha(lock),) * 2
                check(handle, 'lock-presence-mismatch')  # Original public contract.
            retained_contract = []

            def consume(contract):
                inspect_contract(contract, origin)
                retained_contract.append(contract)
                cache = Path(contract['cache_path'])
                source_cache = Path(handle.record()['cache']['path'])
                assert cache != source_cache and cache.parent.parent == exports
                assert (cache / 'warm').read_bytes() == (source_cache / 'warm').read_bytes()
                assert (cache / 'warm').stat().st_ino != (source_cache / 'warm').stat().st_ino
                # Workload writes are allowed in the consumable export. They never
                # replace parent expectations or demand trusted cache mutation.
                (cache / 'warm').write_bytes(b'fixture-sensitive')
                (cache / 'consumer-new').write_bytes(b'consumed')
                assert (source_cache / 'warm').read_bytes() == b'fixture-cache'
                return True

            assert_result(session.run(consume))
            session_check(session)
            cache = Path(handle.record()['cache']['path'])
            saved = (cache / 'warm').read_bytes()
            (cache / 'warm').write_bytes(b'fixture-sensitive')
            session_check(session, 'error', 'prepared-evidence-failed')
            (cache / 'warm').write_bytes(saved)
            session_check(session)
            for index in (0, 1):
                mutated = list(prepared)
                mutated[index] += b' '
                write_pair(mutated)
                session_check(session, 'error', 'workspace-policy-failed')
                write_pair(prepared)
            saved_cache = exports / 'saved-trusted-cache'
            cache.rename(saved_cache)
            shutil.copytree(saved_cache, cache)
            session_check(session, 'error', 'prepared-evidence-failed')
            shutil.rmtree(cache)
            saved_cache.rename(cache)
            if origin == 'bootstrap':
                materialized_lock = workspace / 'package-lock.json'
                saved_lock = base / 'saved-materialized-lock'
                materialized_lock.rename(saved_lock)
                materialized_lock.write_bytes(lock)  # Equal bytes are not the trusted pre-write.
                session_check(session, 'error', 'workspace-policy-failed')
                materialized_lock.unlink()
                saved_lock.rename(materialized_lock)
                with patch.object(session, '_materialized_hashes', None):
                    session_check(session, 'error', 'workspace-policy-failed')
                with patch.object(handle._bootstrap, '_active', False):
                    session_check(session, 'error', 'prepared-evidence-failed')
                with patch.object(handle._bootstrap._runtime, 'contract_identities', return_value={}):
                    session_check(session, 'error', 'prepared-evidence-failed')
                provenance_path = handle._bootstrap._artifact / 'provenance.json'
                saved_provenance = provenance_path.read_bytes()
                provenance_path.chmod(0o600)
                provenance_path.write_bytes(b'fixture-sensitive')
                provenance_path.chmod(0o400)
                session_check(session, 'error', 'prepared-evidence-failed')
                provenance_path.chmod(0o600)
                provenance_path.write_bytes(saved_provenance)
                provenance_path.chmod(0o400)
                session_check(session)
            for patches in (
                    patch.object(helper, 'contracts', return_value={}),
                    patch.object(handle, '_expected', b'not-json'),
                    patch.object(handle, '_active', False)):
                with patches:
                    assert session.verify()['status'] == 'error'
            artifact = handle._artifact / 'handoff.json'
            saved = artifact.read_bytes()
            artifact.chmod(0o600)
            artifact.write_bytes(b'fixture-sensitive')
            artifact.chmod(0o400)
            session_check(session, 'error', 'prepared-evidence-failed')
            artifact.chmod(0o600)
            artifact.write_bytes(saved)
            artifact.chmod(0o400)
            session_check(session)
        session_check(session, 'error', 'active-completed-session-required')
        assert not Path(retained_contract[0]['cache_path']).exists()
        assert not list(exports.iterdir())
        write_pair(original)
        check(handle)

    with patch.object(helper.locked, 'prepare', side_effect=preparation), \
         patch.object(helper, 'offline_ready', return_value=None):
        write_pair((manifest, lock))
        with helper.prepare(workspace, trusted, node, npm) as handle:
            exercise_locked(handle, 'locked')
        write_pair((manifest, lock))
        with helper.prepare(workspace, trusted, node, npm) as cleanup_handle:
            cleanup_session = None
            with patch.object(shutil, 'rmtree', side_effect=OSError('fixture-sensitive')):
                def cleanup_attempt():
                    global cleanup_session
                    with helper.workload_session(cleanup_handle, exports) as cleanup_session:
                        assert_result(cleanup_session.run(lambda contract: True))
                rejected(cleanup_attempt)
            assert cleanup_session._active is False
            for residual in exports.iterdir():
                shutil.rmtree(residual)
        write_pair((manifest, None))
        with patch.object(helper, 'load', side_effect=lambda name:
                          runtime if name == 'npm-registry-lock-runtime' else original_load(name)), \
             patch.object(runtime, 'generate_validated', side_effect=generate):
            with helper.prepare(workspace, trusted, node, npm) as input_handle:
                with helper.bootstrap(input_handle, trusted) as validated:
                    with helper.prepare_bootstrap(validated, trusted, node, npm) as handle:
                        # Preexisting prepared-equal lock, unsafe lock targets,
                        # modified manifest, and provenance/source failures reject
                        # before trusted writing or consumer execution.
                        for bad in (lock, lock + b' '):
                            write_pair((manifest, bad))
                            rejected(lambda: helper.workload_session(handle, exports).__enter__())
                            assert helper.read_pair(workspace) == (manifest, bad)
                            write_pair((manifest, None))
                        write_pair((manifest + b' ', None))
                        rejected(lambda: helper.workload_session(handle, exports).__enter__())
                        write_pair((manifest, None))
                        with patch.object(runtime, 'contract_identities', return_value={}):
                            rejected(lambda: helper.workload_session(handle, exports).__enter__())
                        for kind in ('symlink', 'hardlink', 'fifo', 'directory'):
                            target = workspace / 'package-lock.json'
                            other = base / 'prewrite-other'
                            other.write_bytes(lock)
                            if kind == 'symlink':
                                target.symlink_to(other)
                            elif kind == 'hardlink':
                                os.link(other, target)
                            elif kind == 'fifo':
                                os.mkfifo(target)
                            else:
                                target.mkdir()
                            rejected(lambda: helper.workload_session(handle, exports).__enter__())
                            if kind == 'directory':
                                target.rmdir()
                            else:
                                target.unlink()
                            other.unlink()
                        exercise_locked(handle, 'bootstrap')
                        assert helper.read_pair(workspace) == (manifest, None)
    assert not list(exports.iterdir()) and not list(trusted.iterdir())
    print('workload session: policies/materialization/cache separation/active lifetime/fail-closed passed')

needle = "product-npm-orchestrator"
suite = "product-npm"
baseline_name = "product-npm-orchestrator"
mapped_name = "product-npm-orchestrator.py"


def assert_no_caller(name, text):
    if needle not in text:
        return
    # #696 permits only exact declarative inventory/mapping literals in the
    # dormant selector. The filename alone is never an exemption.
    assert name == 'select-ai-workflow-fixtures.py', ('unexpected caller', name)
    tree = ast.parse(text)
    allowed = []
    declarations = set()
    for statement in tree.body:
        if not (isinstance(statement, ast.Assign) and len(statement.targets) == 1
                and isinstance(statement.targets[0], ast.Name)):
            continue
        target = statement.targets[0].id
        if target not in ('BASELINE', 'PATH_SUITES'):
            continue
        assert target not in declarations, ('duplicate declaration', target)
        declarations.add(target)
        if target == 'BASELINE' and baseline_name is not None:
            assert isinstance(statement.value, ast.Dict)
            ast.literal_eval(statement.value)  # Literal data only, no call/expression.
            for key, value in zip(statement.value.keys, statement.value.values):
                if isinstance(key, ast.Constant) and key.value == suite:
                    allowed.extend(n for n in ast.walk(value)
                                   if isinstance(n, ast.Constant) and n.value == baseline_name)
        elif target == 'PATH_SUITES':
            assert isinstance(statement.value, ast.Tuple)
            expected = ast.parse(
                f"(SCRIPTS + {mapped_name!r}, ({suite!r},))", mode='eval').body
            for row in statement.value.elts:
                if ast.dump(row) == ast.dump(expected):
                    allowed.extend(n for n in ast.walk(row)
                                   if isinstance(n, ast.Constant) and n.value == mapped_name)
    assert len(allowed) == (2 if baseline_name else 1), 'missing/duplicate inventory reference'
    # Mask only the accepted literal spans; executable/unknown references remain.
    lines = text.encode().splitlines(keepends=True)
    for node in sorted(allowed, key=lambda n: (n.lineno, n.col_offset), reverse=True):
        assert node.lineno == node.end_lineno
        line = lines[node.lineno - 1]
        lines[node.lineno - 1] = line[:node.col_offset] + line[node.end_col_offset:]
    assert needle.encode() not in b''.join(lines), 'non-inventory selector reference'


selector_source = (repo / '.github/scripts/select-ai-workflow-fixtures.py').read_text()
assert_no_caller('select-ai-workflow-fixtures.py', selector_source)
# Exercise the same guard used by the repository scan, without writing callers.
for name, text in (
        ('unknown-caller.py', f'run({mapped_name!r})'),
        ('unknown-inventory.py', selector_source),
        ('select-ai-workflow-fixtures.py', selector_source + f'\nrun({mapped_name!r})\n'),
        ('select-ai-workflow-fixtures.py',
         selector_source.replace(repr(mapped_name).replace("'", '"'),
                                 f'run({mapped_name!r})'))):
    try:
        assert_no_caller(name, text)
    except (AssertionError, ValueError, SyntaxError):
        pass
    else:
        raise AssertionError(('unexpected caller accepted', name))

for workflow in (repo / '.github/workflows').glob('*.yml'):
    assert 'product-npm-orchestrator' not in workflow.read_text(), workflow
for script in (repo / '.github/scripts').iterdir():
    if script.is_file() and not script.name.startswith('test-') and script != source:
        assert_no_caller(script.name, script.read_text())
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('post-workload: origin/presence/hash/provenance/identity/unsafe inputs/determinism/read-only/production unreachable passed')
PY
