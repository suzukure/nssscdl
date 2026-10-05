#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import ast
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
from unittest.mock import patch

repo = Path(sys.argv[1]).resolve()
source = repo / '.github/scripts/product-npm-orchestrator.py'
spec = importlib.util.spec_from_file_location('orchestrator', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
validator = helper.validator


def fixture_preparation(*args):
    # Fixture-only local transport; never a shared helper success path.
    return {**validator.prepare(*args), 'boundary': {'fixture': 'local-only'}}


node, npm = Path(shutil.which('node')), Path(shutil.which('npm'))
manifest = {'name': 'fixture', 'version': '1.0.0', 'dependencies': {'example': '1.2.3'}}
lock = {'name': 'fixture', 'version': '1.0.0', 'lockfileVersion': 3, 'packages': {
    '': copy.deepcopy(manifest), 'node_modules/example': {'version': '1.2.3',
    'resolved': validator.REGISTRY + 'example/-/example-1.2.3.tgz',
    'integrity': 'sha512-' + base64.b64encode(bytes(64)).decode()}}}


def rejected(call):
    try:
        call()
    except (validator.Rejected, OSError):
        return
    raise AssertionError('unsafe handoff accepted')


with tempfile.TemporaryDirectory(prefix='product-orchestrator-fixture-') as temporary:
    root = Path(temporary)
    workspace, trusted = root / 'workspace', root / 'trusted'
    workspace.mkdir()
    trusted.mkdir(mode=0o700)

    def write(manifest_value=manifest, lock_value=lock):
        for name, value in zip(helper.INPUTS, (manifest_value, lock_value)):
            target = workspace / name
            if value is None:
                target.unlink(missing_ok=True)
            else:
                target.write_text(json.dumps(value))

    def inventory():
        return {str(p.relative_to(workspace)): p.read_bytes() for p in workspace.rglob('*') if p.is_file()}

    def attempt():
        with helper.prepare(workspace, trusted, node, npm) as handoff:
            return handoff.verify()

    # Both stop states make ZERO tool/registry/cache calls, even with unusable
    # runtime/root arguments. No manifest carries only state/presence evidence.
    for manifest_value, lock_value, state in ((None, None, 'no-manifest'),
            (None, lock, 'no-manifest'), (manifest, None, 'bootstrap-required')):
        write(manifest_value, lock_value)
        before = inventory()
        with (patch.object(validator, 'run', side_effect=AssertionError('tool started')),
              patch.object(helper.locked, 'prepare', side_effect=AssertionError('preparation started')),
              patch.object(helper, 'offline_ready', side_effect=AssertionError('offline started'))):
            with helper.prepare(workspace, Path('/nonexistent'), Path('node'), Path('npm')) as handoff:
                record = handoff.verify()
                assert record['state'] == record['status'] == state
                assert record['input_presence']['package.json'] == (manifest_value is not None)
                if state == 'no-manifest':
                    assert set(record) == {'schema_version', 'state', 'status', 'input_presence'}
                else:
                    assert record['lockfile_hash'] is None and record['node_version'] is None
                    assert base64.b64decode(record['manifest_snapshot']) == (workspace / 'package.json').read_bytes()
                rejected(lambda: handoff.verify({**record, 'status': 'prepared'}))
        rejected(handoff.verify)
        assert inventory() == before and not list(trusted.iterdir())

    # Canonical policy rejects before any npm/cache work, both with/without lock.
    invalid = []
    for value in ('^1.2.3', 'file:../x', 'git+https://example.invalid/x', 'npm:other@1.2.3'):
        invalid.append(({**manifest, 'dependencies': {'example': value}}, None))
        invalid.append(({**manifest, 'dependencies': {'example': value}}, lock))
    invalid.append(({**manifest, 'workspaces': []}, None))
    for mutation in (lambda v: v.update(lockfileVersion=1),
                     lambda v: v['packages'][''].update(dependencies={'example': '9.9.9'}),
                     lambda v: v['packages']['node_modules/example'].update(resolved='https://example.invalid/x'),
                     lambda v: v['packages']['node_modules/example'].pop('integrity'),
                     lambda v: v['packages']['node_modules/example'].update(integrity='sha512-YQ==')):
        value = copy.deepcopy(lock)
        mutation(value)
        invalid.append((manifest, value))
    with patch.object(helper.locked, 'prepare', side_effect=AssertionError('preparation started')):
        for values in invalid:
            write(*values)
            rejected(attempt)
            assert not list(trusted.iterdir())
        write()
        (workspace / 'package.json').write_text('{"dependencies":{},"dependencies":{}}')
        rejected(attempt)
        write()
        (workspace / 'package-lock.json').write_text('not-json')
        rejected(attempt)

    calls, readiness = [], []
    failure = None

    def mock_run(command, cwd, env, timeout=180):
        calls.append(command)
        assert set(env) == {'PATH', 'HOME', 'LC_ALL'}
        assert 'secret' not in str(env) and not cwd.is_relative_to(workspace)
        if command[-1] == '--version':
            return b'24.0.0\n' if command[0] == str(node) else b'11.0.0\n'
        assert command[1] == 'ci' and '--ignore-scripts' in command
        cache = Path(next(a.split('=', 1)[1] for a in command if a.startswith('--cache=')))
        assert not list(cache.iterdir()), 'persistent cache reused'
        (cache / 'warm').write_bytes(b'validated dependency')
        if failure == 'prepare':
            raise validator.Rejected('fixture preparation failure')
        if failure == 'prepare-input':
            (cwd / 'package-lock.json').write_bytes(b'{}')
        if failure == 'partial':
            (cache / 'warm').unlink()
        (cwd / 'node_modules').mkdir()
        return b''

    def mock_offline(project, cache, node, npm):
        readiness.append(project)
        assert (cache / 'warm').read_bytes() == b'validated dependency'
        if failure == 'offline':
            raise validator.Rejected('fixture offline failure')
        if failure == 'offline-input':
            (project / 'package.json').write_bytes(b'{}')
        if failure == 'workspace-input':
            (workspace / 'package.json').write_bytes(b'{}')

    write()
    before = inventory()
    previous = None
    with patch.object(helper.locked, 'prepare', side_effect=fixture_preparation), \
         patch.object(validator, 'run', side_effect=mock_run), \
         patch.object(helper, 'offline_ready', side_effect=mock_offline), \
         patch.dict(os.environ, {'NODE_OPTIONS': 'secret', 'NPM_TOKEN': 'secret', 'HTTPS_PROXY': 'secret'}):
        for cycle in range(2):
            calls.clear()
            with helper.prepare(workspace, trusted, node, npm) as handoff:
                record = handoff.verify()
                assert record['state'] == 'locked' and record['status'] == 'prepared'
                assert [call[1] for call in calls] == ['--version', '--version', 'ci']
                assert record['offline_install_identity']['source'] == helper.contracts()['npm-offline-ci-probe.js']
                assert record['preparation_source_contract']['source'] == helper.contracts()['prepare-product-npm.py']
                changed = copy.deepcopy(record)
                changed['preparation_source_contract']['boundary'] = {'proxy_target': 'wrong'}
                rejected(lambda: handoff.verify(changed))
                assert record['expected_post_workload_hashes'] == dict(zip(helper.INPUTS, map(validator.sha, helper.read_pair(workspace))))
                for field in record:
                    bad = copy.deepcopy(record)
                    bad.pop(field)
                    rejected(lambda: handoff.verify(bad))
                for schema in (True, 1.0, '1', None):
                    rejected(lambda: handoff.verify({**record, 'schema_version': schema}))
                for field in ('manifest_hash', 'lockfile_hash', 'node_version', 'contracts', 'cache',
                              'offline_install_identity', 'expected_post_workload_hashes'):
                    bad = copy.deepcopy(record)
                    bad[field] = 'mismatch'
                    rejected(lambda: handoff.verify(bad))
                bad = handoff.record()
                bad['status'] = 'error'
                assert handoff.verify()['status'] == 'prepared', 'returned claim mutated trusted memory'
                artifact = Path(record['artifact_path'])
                for name in (*helper.INPUTS, 'handoff.json'):
                    target = artifact / name
                    original = target.read_bytes()
                    target.chmod(0o600)
                    target.write_bytes(b'{}')
                    target.chmod(0o400)
                    rejected(handoff.verify)
                    target.chmod(0o600)
                    target.write_bytes(original)
                    target.chmod(0o400)
                cache = Path(record['cache']['path'])
                original = (cache / 'warm').read_bytes()
                (cache / 'warm').unlink()
                rejected(handoff.verify)
                # Same bytes with a new cache file still require a new expectation.
                (cache / 'warm').write_bytes(original)
                # Do not rely on filesystem inode allocation to distinguish reuse.
                (cache / 'warm').write_bytes(b'corrupted')
                rejected(handoff.verify)
                (cache / 'warm').write_bytes(original)
                (cache / 'escape').symlink_to(workspace)
                rejected(handoff.verify)
                (cache / 'escape').unlink()
                (artifact / 'extra').write_bytes(b'unsupported')
                rejected(handoff.verify)
                (artifact / 'extra').unlink()
                with patch.object(helper, 'contracts', return_value={}):
                    rejected(handoff.verify)
                if previous is not None:
                    assert previous['cache']['path'] != record['cache']['path']
                    assert previous['manifest_hash'] == record['manifest_hash']
                    assert previous['lockfile_hash'] == record['lockfile_hash']
                    assert previous['contracts'] == record['contracts']
                previous = record
            assert not artifact.exists() and not list(trusted.iterdir())
            rejected(handoff.verify)
        for failure in ('prepare', 'prepare-input', 'offline', 'offline-input', 'workspace-input'):
            write()
            calls.clear()
            rejected(attempt)
            assert sum(call[1] == 'ci' for call in calls) == 1, 'retry/fallback'
            assert not list(trusted.iterdir())
        failure = 'partial'
        write()
        try:
            attempt()
        except FileNotFoundError:
            pass
        else:
            raise AssertionError('partial cache accepted')
        assert not list(trusted.iterdir())
        failure = None
        write()
        try:
            with helper.prepare(workspace, trusted, node, npm):
                raise RuntimeError('workload failed')
        except RuntimeError:
            pass
        assert not list(trusted.iterdir())
    assert inventory() == before

    # Unsafe roots/input types rejected without tools; RUNNER_TEMP is not evidence.
    with patch.object(helper.locked, 'prepare', side_effect=AssertionError('preparation started')):
        for path in (workspace, workspace / 'nested', root, Path('relative')):
            rejected(lambda: helper.prepare(workspace, path, node, npm).__enter__())
        trusted.chmod(0o777)
        rejected(attempt)
        trusted.chmod(0o700)
        with patch.dict(os.environ, {'RUNNER_TEMP': str(trusted)}):
            rejected(attempt)
        for name in helper.INPUTS:
            target = workspace / name
            saved = target.read_bytes()
            target.unlink()
            target.symlink_to(root / 'missing')
            rejected(attempt)
            target.unlink()
            os.mkfifo(target)
            rejected(attempt)
            target.unlink()
            target.write_bytes(saved)
    assert not list(trusted.iterdir())

    # Actual local npm: fixture-only transport seeds canonical #645's fresh
    # cache; helper's readiness operation uses #677's real constructor offline.
    marker = root / 'lifecycle-ran'
    script = 'node -e "require(\'fs\').writeFileSync(' + repr(str(marker)) + ',\'ran\')"'
    scripts = {event: script for event in ('preinstall', 'install', 'postinstall', 'prepare')}
    dependency = {'name': 'example', 'version': '1.2.3', 'scripts': scripts}
    archive = root / 'dependency.tgz'
    with tarfile.open(archive, 'w:gz') as tar:
        payload = json.dumps(dependency).encode()
        info = tarfile.TarInfo('package/package.json')
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
    real_lock = copy.deepcopy(lock)
    real_lock['packages']['node_modules/example']['integrity'] = (
        'sha512-' + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode())
    real_lock['packages']['node_modules/example']['hasInstallScript'] = True
    write({**manifest, 'scripts': scripts}, real_lock)
    before = inventory()
    original_run = validator.run
    warmed, installs = [], []
    missing = False

    def local_transport(command, cwd, env, timeout=180):
        if command[-1] == '--version':
            return original_run(command, cwd, env, timeout)
        if command[1] == 'ci':
            flags = [arg for arg in command if arg.startswith(('--cache=', '--userconfig=', '--globalconfig='))]
            cache = Path(next(arg.split('=', 1)[1] for arg in flags if arg.startswith('--cache=')))
            assert cache not in warmed and not list(cache.iterdir())
            warmed.append(cache)
            original_run([str(npm), 'cache', 'add', str(archive), '--offline', '--ignore-scripts', *flags], cwd, env, timeout)
            result = original_run([*command, '--offline'], cwd, env, timeout)
            if missing:
                shutil.rmtree(cache)
                cache.mkdir(mode=0o700)
            return result
        installs.append(command)
        assert command[:2] == [str(node), str(npm.resolve())]
        assert '--offline' in command and command[-2:] == ['ci', '--json']
        return original_run(command, cwd, env, timeout)

    with patch.object(helper.locked, 'prepare', side_effect=fixture_preparation), \
         patch.object(validator, 'run', side_effect=local_transport):
        for cycle in range(2):
            with helper.prepare(workspace, trusted, node, npm) as handoff:
                record = handoff.verify()
                assert record['status'] == 'prepared'
                assert base64.b64decode(record['lock_snapshot']) == (workspace / 'package-lock.json').read_bytes()
                assert record['cache']['content_hash'] is not None
            assert not list(trusted.iterdir()) and inventory() == before
        missing = True
        rejected(attempt)
        assert not list(trusted.iterdir()) and inventory() == before
    assert len(warmed) == len(installs) == 3 and len(set(warmed)) == 3
    assert not marker.exists(), 'root/dependency lifecycle ran'
    print('product orchestrator: real npm cold/repeated/offline readiness/partial cache/lifecycle/cleanup passed')

    # Cleanup errors propagate; never turn failed cleanup into successful return.
    write()
    with patch.object(helper.locked, 'prepare', side_effect=fixture_preparation), \
         patch.object(validator, 'run', side_effect=mock_run), \
         patch.object(helper, 'offline_ready', side_effect=mock_offline), \
         patch.object(helper.shutil, 'rmtree', side_effect=OSError('cleanup failed')):
        rejected(attempt)
    # Remove the deliberately leaked mock root using the real cleanup function.
    for path in trusted.iterdir():
        shutil.rmtree(path)

needle = "product-npm-orchestrator"
suite = "product-npm"
baseline_name = "product-npm-orchestrator"
mapped_name = "product-npm-orchestrator.py"


def assert_no_caller(name, text):
    if name == 'trusted-main-npm-bootstrap.py':
        # #792's exact secretless proof entry only, never an AI consumer.
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
print('product orchestrator: state/stop/validation/field/hash/source/cache rejection/workspace/cleanup/production unreachable passed')
PY
