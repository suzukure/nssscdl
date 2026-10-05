#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import ast
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import uuid
from unittest.mock import patch

repo = Path(sys.argv[1]).resolve()
source = repo / '.github/scripts/product-npm-orchestrator.py'
spec = importlib.util.spec_from_file_location('composition', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
validator = helper.validator
runtime = helper.load('npm-registry-lock-runtime')
node, npm = Path(shutil.which('node')), Path(shutil.which('npm'))
manifest = {'name': 'composition-fixture', 'version': '1.0.0', 'dependencies': {'example': '1.2.3'}}
lock = {'name': manifest['name'], 'version': manifest['version'], 'lockfileVersion': 3, 'packages': {'': manifest,
        'node_modules/example': {'version': '1.2.3',
            'resolved': validator.REGISTRY + 'example/-/example-1.2.3.tgz',
            'integrity': 'sha512-' + base64.b64encode(bytes(64)).decode()}}}
# Real #662 freeze/verify and canonical constructor; generation/online setup are
# fixture-only local substitutes. No network, systemd or external service here.
command = runtime.initial_command(repo, node, 12345)
runtime_source = {**runtime.runtime_hashes(node, npm), 'node_source': str(node),
                  'npm_source': str(npm), 'node_version': 'v24.0.0', 'npm_version': '11.0.0'}


def rejected(call):
    try:
        call()
    except (validator.Rejected, OSError, AssertionError):
        return
    raise AssertionError('unsafe composition accepted')


with tempfile.TemporaryDirectory(prefix='bootstrap-preparation-test-') as temporary:
    base = Path(temporary)
    workspace, trusted = base / 'workspace', base / 'trusted'
    workspace.mkdir()
    trusted.mkdir(mode=0o700)
    snapshot = json.dumps(manifest, indent=2).encode() + b'\n'
    lock_bytes = json.dumps(lock, sort_keys=True).encode() + b'\n'
    (workspace / 'package.json').write_bytes(snapshot)
    calls, private_inputs = [], []
    failure = None
    bootstrap_origin = True

    def generate(repo, exact, output):
        assert exact == snapshot
        with tempfile.TemporaryDirectory(prefix='generation-', dir=base) as generation:
            root = Path(generation) / 'root'
            (root / 'runtime').mkdir(parents=True)
            (root / 'project').mkdir()
            (root / 'runtime/manifest.json').write_bytes(exact)
            (root / 'project/package.json').write_bytes(exact)
            (root / 'project/package-lock.json').write_bytes(lock_bytes)
            trusted_record = {'manifest_sha256': hashlib.sha256(exact).hexdigest(),
                'runtime_source': runtime_source, 'staged_runtime_hashes': runtime.runtime_hashes(node, npm),
                'generation_id': uuid.uuid4().hex, 'generation_root': generation,
                'run_id': output.name, 'contracts': runtime.contract_identities(repo)}
            evidence = {'status': 'pass', 'candidate': 'package-lock.json',
                'manifest_hash': trusted_record['manifest_sha256'],
                'lock_hash': hashlib.sha256(lock_bytes).hexdigest(), 'command': command,
                'node': runtime_source['node_version'], 'npm': runtime_source['npm_version'],
                'markers': [], 'node_modules': False, 'metadata_requests': 1, 'tarball_requests': 0,
                'dependency_execution_path': 'not-entered'}
            result = runtime.freeze_candidate(repo, root, output, exact, trusted_record, evidence)
        runtime.verify_handoff(validator, *result)
        return result

    def preparation(frozen, output, node, npm):
        calls.append('locked')
        private_inputs.append(frozen)
        assert helper.read_pair(frozen) == (snapshot, lock_bytes)
        assert frozen != workspace and not frozen.is_relative_to(workspace)
        assert helper.private_directory(frozen.parent)
        assert (workspace / 'package-lock.json').exists() != bootstrap_origin
        if failure == 'locked':
            raise validator.Rejected('fixture-locked-failure')
        destination = Path(tempfile.mkdtemp(prefix='product-npm-', dir=output))
        for name, data in zip(helper.INPUTS, (snapshot, lock_bytes)):
            (destination / name).write_bytes(data)
        cache = destination / 'cache'
        cache.mkdir(mode=0o700)
        (cache / 'warm').write_bytes(b'fixture-cache')
        if failure == 'cache':
            (cache / 'escape').symlink_to(workspace)
        return {'state': 'locked', 'status': 'error' if failure == 'locked-result' else 'prepared',
                'manifest_hash': validator.sha(snapshot), 'lockfile_hash': validator.sha(lock_bytes),
                'preparation_path': str(destination), 'cache_path': str(cache),
                'node_version': 'v24.0.0', 'npm_version': '11.0.0', 'registry': validator.REGISTRY,
                'source_contract': 'npm-official-tarball-with-integrity-v1',
                'boundary': {'fixture': 'local-only'}}

    def readiness(project, cache, node, npm):
        calls.append('offline')
        assert helper.read_pair(project) == (snapshot, lock_bytes)
        assert (cache / 'warm').read_bytes() == b'fixture-cache'
        if failure == 'offline':
            raise validator.Rejected('fixture-offline-failure')
        if failure == 'workspace':
            (workspace / 'package-lock.json').write_bytes(lock_bytes)
        if failure == 'offline-input':
            (project / 'package-lock.json').write_bytes(b'{}')

    original_load = helper.load
    with patch.object(helper, 'load', side_effect=lambda name:
                      runtime if name == 'npm-registry-lock-runtime' else original_load(name)), \
         patch.object(runtime, 'generate_validated', side_effect=generate), \
         patch.object(helper.locked, 'prepare', side_effect=preparation) as locked_call, \
         patch.object(helper, 'offline_ready', side_effect=readiness):
        previous = None
        for cycle in range(2):
            calls.clear()
            with helper.prepare(workspace, trusted, node, npm) as input_handle:
                with helper.bootstrap(input_handle, trusted) as validated:
                    provenance = validated.verify()
                    with helper.prepare_bootstrap(validated, trusted, node, npm) as final:
                        record = final.verify()
                        assert type(final) is helper.Handoff
                        assert record['schema_version'] == 1 and record['status'] == 'prepared'
                        assert record['state'] == 'locked' and all(record['input_presence'].values())
                        assert record['bootstrap_provenance'] == provenance
                        assert not Path(provenance['generation_root']).exists()
                        assert base64.b64decode(record['manifest_snapshot']) == snapshot
                        assert base64.b64decode(record['lock_snapshot']) == lock_bytes
                        assert record['manifest_hash'] == validator.sha(snapshot)
                        assert record['lockfile_hash'] == validator.sha(lock_bytes)
                        assert record['expected_post_workload_hashes'] == dict(zip(
                            helper.INPUTS, map(validator.sha, (snapshot, lock_bytes))))
                        assert record['contracts'] == helper.contracts()
                        assert record['offline_install_identity']['source'] == helper.contracts()['npm-offline-ci-probe.js']
                        assert record['preparation_source_contract']['source'] == helper.contracts()['prepare-product-npm.py']
                        assert calls == ['locked', 'offline']
                        for field in provenance:
                            claim = copy.deepcopy(record)
                            claim['bootstrap_provenance'].pop(field)
                            rejected(lambda: final.verify(claim))
                        rejected(lambda: final.verify({**record, 'unexpected': True}))
                        for field in record:
                            claim = copy.deepcopy(record)
                            claim.pop(field)
                            rejected(lambda: final.verify(claim))
                        saved = final.record()
                        saved['bootstrap_provenance']['generation_id'] = '0' * 32
                        assert final.verify() == record, 'claim changed trusted memory'
                        for artifact, names in ((Path(provenance['artifact_path']), ('package-lock.json', 'provenance.json')),
                                                (Path(record['artifact_path']), (*helper.INPUTS, 'handoff.json'))):
                            for name in names:
                                target = artifact / name
                                original = target.read_bytes()
                                target.chmod(0o600)
                                target.write_bytes(b'{}')
                                target.chmod(0o400)
                                rejected(final.verify)
                                target.chmod(0o600)
                                target.write_bytes(original)
                                target.chmod(0o400)
                        with patch.object(runtime, 'contract_identities', return_value={}):
                            rejected(final.verify)
                        validated._active = False
                        rejected(final.verify)
                        validated._active = True
                        assert final.verify() == record
                        if previous:
                            for field in ('manifest_hash', 'lockfile_hash', 'contracts'):
                                assert record[field] == previous[field]
                            for field in ('generation_id', 'run_id', 'artifact_id'):
                                assert provenance[field] != previous['bootstrap_provenance'][field]
                            assert record['artifact_path'] != previous['artifact_path']
                            assert record['cache']['path'] != previous['cache']['path']
                        previous = record
                    rejected(final.verify)
                    rejected(validated.verify)
                    assert not Path(record['artifact_path']).exists()
                    assert not Path(provenance['artifact_path']).exists()
            assert not list(trusted.iterdir())
            assert helper.read_pair(workspace) == (snapshot, None)
            assert all(not path.exists() for path in private_inputs)

        # Wrong types, candidate-only and serialized claims stop before #682.
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            for value in (input_handle, input_handle.record(), {'status': 'validated'}, lock_bytes, workspace):
                locked_call.reset_mock()
                rejected(lambda: helper.prepare_bootstrap(value, trusted, node, npm).__enter__())
                locked_call.assert_not_called()

        for failure in ('locked', 'locked-result', 'cache', 'offline', 'offline-input', 'workspace',
                        'artifact-bytes', 'artifact-hash', 'provenance', 'identity', 'expired',
                        'unknown-contract', 'snapshot-race', 'unsafe-root', 'runner-temp', 'consumer'):
            calls.clear()
            with helper.prepare(workspace, trusted, node, npm) as input_handle:
                with helper.bootstrap(input_handle, trusted) as validated:
                    artifact = Path(validated.record()['artifact_path'])
                    composition_root = trusted
                    if failure in ('artifact-bytes', 'artifact-hash', 'provenance', 'identity'):
                        target = artifact / ('package-lock.json' if failure == 'artifact-bytes' else 'provenance.json')
                        data = target.read_bytes()
                        if failure == 'artifact-bytes':
                            data += b' '
                        else:
                            value = validator.parse(data)
                            value[{'artifact-hash': 'lock_sha256', 'provenance': 'generated_lock_sha256',
                                   'identity': 'generation_id'}[failure]] = '0' * 64
                            data = json.dumps(value).encode()
                        target.chmod(0o600)
                        target.write_bytes(data)
                        target.chmod(0o400)
                    if failure == 'expired':
                        validated._active = False
                    if failure == 'unsafe-root':
                        composition_root = workspace

                    def attempt():
                        with helper.prepare_bootstrap(validated, composition_root, node, npm):
                            if failure == 'consumer':
                                raise validator.Rejected('consumer-failed')
                    if failure == 'unknown-contract':
                        with patch.object(runtime, 'contract_identities', return_value={}):
                            rejected(attempt)
                    elif failure == 'snapshot-race':
                        real_read = helper.read_pair
                        def changed_pair(path):
                            pair = real_read(path)
                            return (pair[0], pair[1] + b' ') if path == artifact else pair
                        with patch.object(helper, 'read_pair', side_effect=changed_pair):
                            rejected(attempt)
                    elif failure == 'runner-temp':
                        with patch.dict(os.environ, {'RUNNER_TEMP': str(trusted)}):
                            rejected(attempt)
                    else:
                        rejected(attempt)
                    if failure != 'expired':
                        assert not artifact.exists(), failure
                        assert not validated._active
                    if failure in ('artifact-bytes', 'artifact-hash', 'provenance', 'identity', 'expired',
                                   'unknown-contract', 'snapshot-race', 'unsafe-root', 'runner-temp'):
                        assert calls == [], (failure, calls)
                    else:
                        assert calls.count('locked') == 1 and calls.count('offline') <= 1, 'retry/fallback'
            (workspace / 'package-lock.json').unlink(missing_ok=True)
            assert helper.read_pair(workspace) == (snapshot, None)
            assert not list(trusted.iterdir()) and all(not path.exists() for path in private_inputs)
        failure = None

        # Cleanup failure is propagated; remove deliberately leaked fixture data.
        real_rmtree = shutil.rmtree
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            with helper.bootstrap(input_handle, trusted) as validated:
                def cleanup(path, *args, **kwargs):
                    if Path(path) == validated._artifact:
                        raise OSError('fixture-artifact-cleanup-failed')
                    return real_rmtree(path, *args, **kwargs)
                with patch.object(helper.shutil, 'rmtree', side_effect=cleanup):
                    def cleanup_attempt():
                        with helper.prepare_bootstrap(validated, trusted, node, npm):
                            pass
                    rejected(cleanup_attempt)
                assert not validated._active
        assert not list(trusted.iterdir())

    # Direct existing-lock preparation keeps the shared fields and bypasses bootstrap.
    bootstrap_origin = False
    (workspace / 'package-lock.json').write_bytes(lock_bytes)
    with patch.object(helper.locked, 'prepare', side_effect=preparation), \
         patch.object(helper, 'offline_ready', side_effect=readiness), \
         patch.object(helper, 'bootstrap', side_effect=AssertionError('bootstrap entered')):
        with helper.prepare(workspace, trusted, node, npm) as direct:
            record = direct.verify()
            assert set(record) == set(previous) - {'bootstrap_provenance'}
            for field in ('schema_version', 'state', 'status', 'input_presence', 'manifest_snapshot',
                          'manifest_hash', 'lock_snapshot', 'lockfile_hash', 'node_version', 'npm_version',
                          'contracts', 'preparation_source_contract', 'offline_install_identity',
                          'expected_post_workload_hashes'):
                assert record[field] == previous[field], field
        (workspace / 'package.json').unlink()
        with helper.prepare(workspace, trusted, node, npm) as empty:
            assert empty.verify()['status'] == 'no-manifest'
    assert not list(trusted.iterdir())

    # Real local npm for composition: empty dependency closure needs no registry.
    snapshot = b'{"name":"composition-empty","version":"1.0.0"}\n'
    lock_bytes = json.dumps({'name': 'composition-empty', 'version': '1.0.0',
        'lockfileVersion': 3, 'packages': {'': validator.parse(snapshot)}}).encode() + b'\n'
    (workspace / 'package.json').write_bytes(snapshot)
    (workspace / 'package-lock.json').unlink()
    original_run = validator.run
    def local_run(command, cwd, env, timeout=180):
        if command[1] == 'ci':
            command = [*command, '--offline']
        return original_run(command, cwd, env, timeout)
    with patch.object(helper, 'load', side_effect=lambda name:
                      runtime if name == 'npm-registry-lock-runtime' else original_load(name)), \
         patch.object(runtime, 'generate_validated', side_effect=generate), \
         patch.object(helper.locked, 'prepare', side_effect=lambda *args:
                      {**validator.prepare(*args), 'boundary': {'fixture': 'local-only'}}), \
         patch.object(validator, 'run', side_effect=local_run):
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            with helper.bootstrap(input_handle, trusted) as validated:
                with helper.prepare_bootstrap(validated, trusted, node, npm) as final:
                    assert final.verify()['status'] == 'prepared'
        assert helper.read_pair(workspace) == (snapshot, None) and not list(trusted.iterdir())
print('bootstrap preparation: local real npm preparation/offline readiness passed')

needle = "product-npm-orchestrator"
suite = "product-npm"
baseline_name = "product-npm-orchestrator"
mapped_name = "product-npm-orchestrator.py"


def assert_no_caller(name, text):
    if name == 'trusted-main-npm-bootstrap.py':
        # #792's exact secretless proof entry only, never locked preparation.
        assert hashlib.sha256(text.encode()).hexdigest() == (
            'e35393291ff80b682432ec1316ccb44844e3c352a5a10f45a494512f0343c0e6')
        return
    if name == 'trusted-main-runtime-supply-proof.py':
        # #747 reuses only the existing root API, never the Product consumer.
        expression = "load('product-npm-orchestrator').CanonicalRoot"
        assert text.count(expression) == 1
        text = text.replace(expression, 'ROOT_API', 1)
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
        ('trusted-main-npm-bootstrap.py', 'unauthorized caller'),
        ('trusted-main-runtime-supply-proof.py', 'ROOT_API'),
        ('trusted-main-runtime-supply-proof.py',
         "load('product-npm-orchestrator').CanonicalRoot\n" * 2),
        *[('trusted-main-runtime-supply-proof.py',
           "load('product-npm-orchestrator').CanonicalRoot\n"
           + f"load('product-npm-orchestrator').{api}()\n")
          for api in ('bootstrap', 'prepare', 'production_session')],
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
    assert 'product-npm-orchestrator' not in workflow.read_text()
for script in (repo / '.github/scripts').iterdir():
    if script.is_file() and not script.name.startswith('test-') and script != source:
        assert_no_caller(script.name, script.read_text())
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('bootstrap preparation: shared fields/provenance/mutation/failure/cleanup/repeat/workspace/production unreachable passed')

if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP bootstrap preparation runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('bootstrap preparation runtime requires systemd on the regression runner')
    print('SKIP bootstrap preparation runtime: systemd is not PID 1')
    sys.exit(0)
# Formal runner only: active #691 -> actual #682, no alternate transport.
node, npm, _ = runtime.select_runtime()
registry = runtime.load(repo, 'npm-registry-boundary-runtime')
before, repository_state = registry.snapshot(repo), runtime.workspace_state(repo)
with tempfile.TemporaryDirectory(prefix='composition-official-workspace-') as workspace_name, \
     tempfile.TemporaryDirectory(prefix='composition-official-trusted-') as trusted_name:
    workspace, trusted = Path(workspace_name), Path(trusted_name)
    exact = json.dumps({'name': 'composition-official', 'version': '1.0.0',
                        'dependencies': {'is-number': '7.0.0'}}).encode()
    (workspace / 'package.json').write_bytes(exact)
    previous = None
    for cycle in range(2):
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            with helper.bootstrap(input_handle, trusted) as validated:
                provenance = validated.verify()
                with helper.prepare_bootstrap(validated, trusted, node, npm) as final:
                    record = final.verify()
                    assert record['status'] == 'prepared' and record['state'] == 'locked'
                    assert record['bootstrap_provenance'] == provenance
                    assert record['preparation_source_contract']['boundary']['network']['mode'] == 'restricted'
                    if previous:
                        assert record['lockfile_hash'] == previous['lockfile_hash']
                        assert record['manifest_hash'] == previous['manifest_hash']
                        assert record['bootstrap_provenance']['generation_id'] != previous['bootstrap_provenance']['generation_id']
                        assert record['cache']['path'] != previous['cache']['path']
                    previous = record
        assert helper.read_pair(workspace) == (exact, None) and not list(trusted.iterdir())
    # Stop only the locked preparation proxy, after successful bootstrap.
    real_start, locked_load = registry.start_proxy, helper.locked.load
    def unavailable(staged):
        process, port = real_start(staged)
        registry.stop_proxy(process)
        registry.verify_proxy_stopped(port)
        return process, port
    with helper.prepare(workspace, trusted, node, npm) as input_handle:
        with helper.bootstrap(input_handle, trusted) as validated:
            with patch.object(helper.locked, 'load', side_effect=lambda name:
                              registry if name == 'npm-registry-boundary-runtime' else locked_load(name)), \
                 patch.object(registry, 'start_proxy', side_effect=unavailable):
                rejected(lambda: helper.prepare_bootstrap(validated, trusted, node, npm).__enter__())
            rejected(validated.verify)
    assert helper.read_pair(workspace) == (exact, None) and not list(trusted.iterdir())
assert registry.snapshot(repo) == before and runtime.workspace_state(repo) == repository_state
print('bootstrap preparation: official repeated composition/restricted preparation/offline/proxy failure/cleanup passed')

PY
