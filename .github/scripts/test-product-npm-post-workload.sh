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

def assert_no_caller(name, text):
    needle = 'product-npm-orchestrator'
    assert 'verify_post_workload' not in text, ('unexpected verifier caller', name)
    if needle not in text:
        return
    # #696: only the exact declarative inventory/mapping spans are exempt.
    assert name == 'select-ai-workflow-fixtures.py', ('unexpected caller', name)
    tree = ast.parse(text)
    allowed = []
    for target, kind in (('BASELINE', ast.Dict), ('PATH_SUITES', ast.Tuple)):
        statements = [n for n in tree.body if isinstance(n, ast.Assign)
                      and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
                      and n.targets[0].id == target]
        assert len(statements) == 1, ('missing/duplicate declaration', target)
        statement = statements[0]
        writes = [n for n in ast.walk(tree) if isinstance(n, ast.Name)
                  and n.id == target and isinstance(n.ctx, (ast.Store, ast.Del))]
        assert writes == [statement.targets[0]], ('non-declarative write', target)
        assert isinstance(statement.value, kind)
        if target == 'BASELINE':
            ast.literal_eval(statement.value)
            values = [v for k, v in zip(statement.value.keys, statement.value.values)
                      if isinstance(k, ast.Constant) and k.value == 'product-npm']
            assert len(values) == 1 and isinstance(values[0], ast.Tuple)
            matches = [n for n in values[0].elts
                       if isinstance(n, ast.Constant) and n.value == needle]
        else:
            expected = ast.parse(
                '(SCRIPTS + "product-npm-orchestrator.py", ("product-npm",))',
                mode='eval').body
            rows = [n for n in statement.value.elts if ast.dump(n) == ast.dump(expected)]
            assert len(rows) == 1, 'missing/duplicate mapping literal'
            matches = [n for n in ast.walk(rows[0])
                       if isinstance(n, ast.Constant) and n.value == needle + '.py']
        assert len(matches) == 1, 'missing/duplicate inventory literal'
        allowed.extend(matches)
    lines = text.encode().splitlines(keepends=True)
    for node in sorted(allowed, key=lambda n: (n.lineno, n.col_offset), reverse=True):
        assert node.lineno == node.end_lineno
        line = lines[node.lineno - 1]
        lines[node.lineno - 1] = line[:node.col_offset] + line[node.end_col_offset:]
    assert needle.encode() not in b''.join(lines), 'non-inventory selector reference'


selector_text = (repo / '.github/scripts/select-ai-workflow-fixtures.py').read_text()
assert_no_caller('select-ai-workflow-fixtures.py', selector_text)
row = '(SCRIPTS + "product-npm-orchestrator.py", ("product-npm",))'
for name, text in (
        ('unknown.py', 'run("product-npm-orchestrator.py")'),
        ('unknown-inventory.py', selector_text),
        ('select-ai-workflow-fixtures.py', selector_text + '\nrun("product-npm-orchestrator.py")'),
        ('select-ai-workflow-fixtures.py', selector_text.replace(row, row + ', ' + row)),
        ('select-ai-workflow-fixtures.py', selector_text.replace(
            '"product-npm-orchestrator.py"', 'run("product-npm-orchestrator.py")')),
        ('select-ai-workflow-fixtures.py', selector_text + '\nBASELINE = BASELINE'),
        ('select-ai-workflow-fixtures.py', selector_text + '\nPATH_SUITES += ()'),
        ('select-ai-workflow-fixtures.py', selector_text + '\nverify_post_workload(handoff)')):
    try:
        assert_no_caller(name, text)
    except (AssertionError, ValueError, SyntaxError):
        pass
    else:
        raise AssertionError(('unsafe caller accepted', name))

for workflow in (repo / '.github/workflows').glob('*.yml'):
    assert 'product-npm-orchestrator' not in workflow.read_text(), workflow
    assert 'verify_post_workload' not in workflow.read_text(), workflow
for script in (repo / '.github/scripts').iterdir():
    if script.is_file() and not script.name.startswith('test-') and script != source:
        assert_no_caller(script.name, script.read_text())
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('post-workload: origin/presence/hash/provenance/identity/unsafe inputs/determinism/read-only/production unreachable passed')
PY
