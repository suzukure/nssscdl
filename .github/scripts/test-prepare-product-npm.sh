#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from unittest.mock import patch

repo = Path(sys.argv[1])
source = repo / '.github/scripts/prepare-product-npm.py'
spec = importlib.util.spec_from_file_location('product_npm', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
manifest = {'name': 'fixture', 'version': '1.0.0', 'dependencies': {'example': '1.2.3'},
            'scripts': {'preinstall': 'exit 99'}}
integrity = 'sha512-' + base64.b64encode(bytes(64)).decode()
lock = {'name': 'fixture', 'version': '1.0.0', 'lockfileVersion': 3, 'packages': {
    '': {key: value for key, value in manifest.items() if key != 'scripts'},
    'node_modules/example': {'version': '1.2.3',
        'resolved': helper.REGISTRY + 'example/-/example-1.2.3.tgz', 'integrity': integrity,
        'hasInstallScript': True}}}


def rejected(manifest_value, lock_value=None):
    try:
        if lock_value is None:
            helper.manifest_dependencies(manifest_value)
        else:
            helper.validate_lock(manifest_value, lock_value)
    except helper.Rejected:
        return
    raise AssertionError('unsafe input accepted')


helper.validate_lock(manifest, lock)
for version in ('^1.2.3', '~1.2.3', '>=1', '*', 'latest', 'next', 'git+https://example.test/x',
                'github:owner/repo', 'file:../x', 'https://example.test/x.tgz',
                'npm:other@1.2.3', 'workspace:*', '01.2.3', '1.2.3-01', '1.2.3\n', ''):
    rejected({**manifest, 'dependencies': {'example': version}})
for section in helper.SECTIONS:
    rejected({**manifest, section: {'other': '^1.0.0'}})
for key in ('workspaces', 'overrides', 'resolutions', 'bundledDependencies', 'bundleDependencies'):
    rejected({**manifest, key: []})
rejected({**manifest, 'optionalDependencies': {'example': '2.0.0'}})
for exact in ('0.0.0', '1.2.3-rc.1', '1.2.3+build.1'):
    helper.manifest_dependencies({'dependencies': {'@scope/example': exact}})

mutations = [
    lambda value: value.update(name='different-project'),
    lambda value: value.update(version='9.9.9'),
    lambda value: value['packages'][''].update(dependencies={'example': '9.9.9'}),
    lambda value: value['packages']['node_modules/example'].update(version='9.9.9'),
    lambda value: value['packages']['node_modules/example'].pop('integrity'),
    lambda value: value['packages']['node_modules/example'].update(integrity='sha512-YQ=='),
    lambda value: value['packages']['node_modules/example'].update(integrity='sha512-!!!'),
    lambda value: value['packages']['node_modules/example'].update(integrity=''),
    lambda value: value['packages']['node_modules/example'].update(integrity='   '),
    lambda value: value['packages']['node_modules/example'].update(link=True),
    lambda value: value['packages']['node_modules/example'].update(inBundle=True),
    lambda value: value['packages']['node_modules/example'].update(dependencies={'bad': 'file:/tmp/x'}),
    lambda value: value.update(lockfileVersion=1),
    lambda value: value['packages'].pop('node_modules/example'),
]
for resolved in ('http://registry.npmjs.org/example/-/example-1.2.3.tgz',
                 'https://example.test/example.tgz', 'file:/tmp/example', 'git+https://example.test/x',
                 'https://registry.npmjs.org@evil.test/example.tgz',
                 helper.REGISTRY + '../example.tgz', helper.REGISTRY + '%2e%2e/example.tgz',
                 helper.REGISTRY + 'other/-/other-1.2.3.tgz',
                 helper.REGISTRY + 'example/-/example-1.2.3.tgz?token=secret'):
    mutations.append(lambda value, resolved=resolved:
                     value['packages']['node_modules/example'].update(resolved=resolved))
for location in ('../outside', '/node_modules/example', 'node_modules/../example',
                 'node_modules/@scope', 'node_modules/example/../../../outside',
                 'node_modules\\example'):
    mutations.append(lambda value, location=location:
                     value['packages'].update({location: value['packages']['node_modules/example']}))
for mutate in mutations:
    value = copy.deepcopy(lock)
    mutate(value)
    rejected(manifest, value)
legacy = copy.deepcopy(lock)
legacy['lockfileVersion'] = 2
legacy['dependencies'] = {'example': copy.deepcopy(lock['packages']['node_modules/example'])}
helper.validate_lock(manifest, legacy)
legacy['dependencies']['example']['resolved'] = 'file:/tmp/x'
rejected(manifest, legacy)
try:
    helper.parse(b'{"dependencies":{},"dependencies":{"example":"latest"}}')
except helper.Rejected:
    pass
else:
    raise AssertionError('duplicate key accepted')


with tempfile.TemporaryDirectory(prefix='product-npm-fixture-') as temporary:
    root = Path(temporary)
    workspace = root / 'workspace'
    workspace.mkdir()
    trusted = root / 'trusted'
    trusted.mkdir(mode=0o700)
    node, npm = Path('/trusted/bin/node'), Path('/trusted/bin/npm')
    calls = []
    fail = None
    generated = lock

    def fake_run(command, cwd, env, timeout=180):
        calls.append(command)
        assert set(env) == {'PATH', 'HOME', 'LC_ALL'}
        assert str(workspace) not in str(cwd)
        if command[-1] == '--version':
            return b'24.0.0\n' if command[0] == str(node) else b'11.0.0\n'
        assert '--ignore-scripts' in command and '--registry=' + helper.REGISTRY in command
        assert '--workspaces=false' in command and '--audit=false' in command
        cache = Path(next(arg.split('=', 1)[1] for arg in command if arg.startswith('--cache=')))
        assert cache.is_relative_to(trusted) and cache != Path(env['HOME'])
        assert Path(env['HOME']).is_dir()
        if command[1] == fail:
            raise helper.Rejected('tool-execution-failed')
        if command[1] == 'install':
            if fail == 'generated-symlink':
                (cwd / 'package-lock.json').symlink_to(workspace / 'package.json')
                return b''
            (cwd / 'package-lock.json').write_text(json.dumps(generated))
            (cache / 'warm').write_text('package-lock-only cache')
        else:
            if generated is lock and not (workspace / 'package-lock.json').exists():
                assert (cache / 'warm').exists(), 'bootstrap must reuse the dedicated cache for ci'
            if fail == 'mutation':
                (cwd / 'package-lock.json').write_text('{}')
            (cwd / 'node_modules').mkdir()
            (cache / 'warm').write_text('ci cache')
        return b''

    def exercise(expected, state=None):
        before = {p.name: p.read_bytes() for p in workspace.iterdir() if p.is_file()}
        with patch.dict(os.environ, {'NODE_OPTIONS': '--require=/evil.js',
                                    'npm_config_registry': 'https://evil.test',
                                    'NPM_TOKEN': 'secret', 'HTTPS_PROXY': 'https://evil.test'}):
            with patch.object(helper, 'run', side_effect=fake_run):
                result = helper.prepare(workspace, trusted, node, npm)
        assert result['status'] == expected, result
        if state is not None:
            assert result['state'] == state, result
        assert before == {p.name: p.read_bytes() for p in workspace.iterdir() if p.is_file()}
        if 'preparation_path' in result:
            destination = Path(result['preparation_path'])
            assert json.loads((destination / 'provenance.json').read_text()) == result
            assert not list(destination.glob('install-*'))
            assert not list(destination.rglob('node_modules'))
            assert result['node_version'] == '24.0.0' and result['npm_version'] == '11.0.0'
            if expected == 'prepared':
                for file, field in (('package.json', 'manifest_hash'), ('package-lock.json', 'lockfile_hash')):
                    expected_hash = 'sha256:' + hashlib.sha256((destination / file).read_bytes()).hexdigest()
                    assert result[field] == expected_hash
        return result

    result = exercise('no-manifest', 'no-manifest')
    assert result['manifest_hash'] is None and result['lockfile_hash'] is None
    assert all(command[-1] == '--version' for command in calls), 'no registry operation without manifest'
    (workspace / 'package.json').write_text(json.dumps(manifest))
    first = exercise('prepared', 'bootstrap')
    second = exercise('prepared', 'bootstrap')
    assert first['cache_path'] != second['cache_path'], 'invocations must not share persistent cache'
    assert first['manifest_hash'] == second['manifest_hash']
    assert first['lockfile_hash'] == second['lockfile_hash']
    (workspace / 'package-lock.json').write_text(json.dumps(lock))
    calls.clear()
    exercise('prepared', 'locked')
    assert [command[1] for command in calls] == ['--version', '--version', 'ci']
    fail = 'ci'
    exercise('error', 'locked')
    fail = 'mutation'
    assert exercise('error')['reason'] == 'npm-input-mutated'
    (workspace / 'package-lock.json').unlink()
    fail = 'install'
    exercise('error', 'bootstrap')
    fail = 'generated-symlink'
    calls.clear()
    exercise('error', 'bootstrap')
    assert not any(command[1] == 'ci' for command in calls)
    fail = None
    generated = copy.deepcopy(lock)
    generated['packages']['node_modules/example'].pop('integrity')
    calls.clear()
    exercise('error', 'bootstrap')
    assert not any(command[1] == 'ci' for command in calls)
    generated = lock
    for mutate in mutations:
        value = copy.deepcopy(lock)
        mutate(value)
        (workspace / 'package-lock.json').write_text(json.dumps(value))
        calls.clear()
        exercise('error', 'locked')
        assert not calls, 'invalid input must be rejected before npm runs'
    (workspace / 'package-lock.json').unlink()
    original = workspace / 'package.json'
    original.unlink()
    outside = root / 'outside.json'
    outside.write_text(json.dumps(manifest))
    original.symlink_to(outside)
    exercise('error')
    original.unlink()
    os.link(outside, original)
    exercise('error')
    original.unlink()
    os.mkfifo(original)
    exercise('error')
    original.unlink()
    original.write_text(json.dumps(manifest))
    (workspace / 'package-lock.json').symlink_to(outside)
    exercise('error')
    (workspace / 'package-lock.json').unlink()
    alias = root / 'alias'
    alias.symlink_to(workspace, target_is_directory=True)
    with patch.object(helper, 'run', side_effect=AssertionError('tool invoked for unsafe path')):
        for path in (alias, alias / '.', root / 'workspace' / '..' / 'workspace', Path('relative')):
            assert helper.prepare(path, trusted, node, npm)['status'] == 'error'
        cache_alias = root / 'cache-alias'
        cache_alias.symlink_to(trusted, target_is_directory=True)
        assert helper.prepare(workspace, cache_alias, node, npm)['status'] == 'error'
        assert helper.prepare(workspace, workspace, node, npm)['status'] == 'error'
        trusted.chmod(0o777)
        assert helper.prepare(workspace, trusted, node, npm)['status'] == 'error'
        trusted.chmod(0o700)
    with patch.object(helper.tempfile, 'mkdtemp', side_effect=OSError('cache failure')):
        assert helper.prepare(workspace, trusted, node, npm)['status'] == 'error'

    # Real installed npm, entirely offline: seed a local tarball into the
    # dedicated cache, then exercise bootstrap and two ci calls with scripts.
    # This checks actual dependency lifecycle suppression, not only flag text.
    actual_node = Path(shutil.which('node'))
    actual_npm = Path(shutil.which('npm'))
    marker = root / 'script-executed'
    script = f'node -e "require(\'fs\').writeFileSync(\'{marker}\', \'unsafe\')"'
    pkg = {'name': 'example', 'version': '1.2.3',
           'scripts': {key: script for key in ('preinstall', 'install', 'postinstall', 'prepare')}}
    tarball = root / 'example.tgz'
    with tarfile.open(tarball, 'w:gz') as archive:
        payload = json.dumps(pkg).encode()
        info = tarfile.TarInfo('package/package.json')
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    real_lock = copy.deepcopy(lock)
    real_lock['packages']['node_modules/example']['integrity'] = (
        'sha512-' + base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode())
    real_manifest = {**manifest, 'scripts': {key: script for key in pkg['scripts']}}
    original.write_text(json.dumps(real_manifest))
    (workspace / 'package-lock.json').write_text(json.dumps(real_lock))
    real_run = helper.run
    warmed = set()

    def offline_run(command, cwd, env, timeout=180):
        if command[-1] == '--version':
            return real_run(command, cwd, env, timeout)
        cache_arg = next(arg for arg in command if arg.startswith('--cache='))
        config_args = [arg for arg in command if arg.startswith(('--userconfig=', '--globalconfig='))]
        if cache_arg not in warmed:
            real_run([str(actual_npm), 'cache', 'add', str(tarball), cache_arg,
                      '--offline', '--ignore-scripts', *config_args], cwd, env, timeout)
            warmed.add(cache_arg)
        result = real_run([*command, '--offline'], cwd, env, timeout)
        if command[1] == 'ci':
            real_run([*command, '--offline'], cwd, env, timeout)
        return result

    with patch.object(helper, 'run', side_effect=offline_run):
        result = helper.prepare(workspace, trusted, actual_node, actual_npm)
    assert result['status'] == 'prepared', result
    assert not marker.exists(), 'root/dependency lifecycle script ran'
    # Real empty bootstrap cannot need metadata or registry tarballs.
    original.write_text(json.dumps({'name': 'empty', 'version': '1.0.0', 'scripts': pkg['scripts']}))
    (workspace / 'package-lock.json').unlink()
    with patch.object(helper, 'run', side_effect=offline_run):
        result = helper.prepare(workspace, trusted, actual_node, actual_npm)
    assert result['status'] == 'prepared' and result['state'] == 'bootstrap', result
    assert not marker.exists()

    # Process failures and timeout must not become successful preparation.
    for outcome in (subprocess.CompletedProcess([], 1, b'', b'sensitive error'),
                    subprocess.TimeoutExpired([], 1), OSError('missing tool')):
        kwargs = {'side_effect': outcome} if isinstance(outcome, Exception) else {'return_value': outcome}
        with patch.object(helper.subprocess, 'run', **kwargs):
            result = helper.prepare(workspace, trusted, actual_node, actual_npm)
        assert result['status'] == 'error' and result['reason'] == 'tool-execution-failed'
        assert 'sensitive' not in json.dumps(result)

    # CLI produces a single JSON value with failure reflected in exit status.
    cli = [sys.executable, str(source), '--workspace', str(alias), '--run-root', str(trusted),
           '--node', str(actual_node), '--npm', str(actual_npm)]
    process = subprocess.run(cli, capture_output=True, text=True)
    assert process.returncode == 1 and json.loads(process.stdout)['status'] == 'error'

# Dormant helper cannot be reached from any production workflow. The existing
# regression glob discovers this fixture without adding production wiring.
for workflow in (repo / '.github/workflows').glob('*.yml'):
    assert 'prepare-product-npm' not in workflow.read_text(), workflow
print('Product npm preparation: pure, isolated orchestration, offline lifecycle/cache, provenance, paths, dormant fixtures passed.')
PY
