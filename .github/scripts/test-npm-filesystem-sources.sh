#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
from types import SimpleNamespace
from unittest.mock import patch
import importlib.util

repo = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('filesystem', repo / '.github/scripts/npm-filesystem-boundary-runtime.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
preparation = fixture.load(repo, 'prepare-product-npm')
node = Path(shutil.which('node')).resolve()
npm = Path(shutil.which('npm')).resolve()

assert fixture.validate_manifest(repo, {'dependencies': {'control': '1.0.0'}}) == {'control': '1.0.0'}
for section in preparation.SECTIONS:
    for source in ('file:./local', 'file:/tmp/host', './local', '../local', '/tmp/host',
                   'file:../../host', 'file:./symlink', 'link:./local', 'workspace:*'):
        try:
            # Actual root preparation rejects before copy, ldd, or npm execution.
            fixture.build_root(repo, Path('/unused'), node, npm, 'fixture',
                               {section: {'escape': source}})
        except preparation.Rejected as error:
            assert str(error) == 'non-exact-dependency', error
        else:
            raise AssertionError('local top-level dependency accepted')
for mechanism in ('workspaces', 'overrides', 'resolutions', 'bundledDependencies', 'bundleDependencies'):
    try:
        fixture.validate_manifest(repo, {mechanism: []})
    except preparation.Rejected as error:
        assert str(error) == 'unsupported-manifest-mechanism'
    else:
        raise AssertionError('workspace/alternate source mechanism accepted')

# Invalid/missing root inputs fail before systemd/npm, with no host fallback.
root = Path('/run/npm-filesystem-fixture-abcdefgh/root')
record = {'token': 'a' * 32, 'hidden': [], 'packages': []}
unit = 'npm-filesystem-probe-' + 'b' * 32 + '.service'
for candidate in (Path('/'), Path('/tmp/root'), root / '../root'):
    with patch.object(fixture.subprocess, 'run') as launch:
        try:
            fixture.service(repo, candidate, record)
        except AssertionError:
            pass
        else:
            raise AssertionError('unsafe root accepted')
        launch.assert_not_called()
for uid, mode, marker in ((1000, 0o755, b'{}'), (0, 0o777, b'{}'),
                         (0, 0o755, None), (0, 0o755, b'{"token":"wrong"}')):
    helper = SimpleNamespace(directory=lambda path: 123,
                             read_input=lambda fd, name: marker)
    real_load = fixture.load
    with patch.object(fixture, 'load', side_effect=lambda repo, name:
                      helper if name == 'prepare-product-npm' else real_load(repo, name)), \
         patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=0o755)), \
         patch.object(fixture.os, 'fstat', return_value=SimpleNamespace(st_uid=uid, st_mode=mode)), \
         patch.object(fixture.os, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=0o644)), \
         patch.object(fixture.os, 'close'), patch.object(fixture.subprocess, 'run') as launch:
        try:
            fixture.service(repo, root, record)
        except AssertionError:
            pass
        else:
            raise AssertionError('missing/invalid isolation boundary accepted')
        launch.assert_not_called()

# Startup error and deadline stop/collect the SAME unit; never retry or run host npm.
helper = SimpleNamespace(directory=lambda path: 123,
                         read_input=lambda fd, name: json.dumps(record).encode())
real_load = fixture.load
for failure in ('unsupported', 'timeout', 'invalid-output'):
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        if '/usr/bin/systemd-run' in command:
            assert '--property=RootDirectory=' + str(root) in command
            assert '--property=MountAPIVFS=no' in command
            assert '--property=User=nobody' in command
            assert '--property=ReadWritePaths=/project /tmp' in command
            assert '--property=CapabilityBoundingSet=' in command
            assert '--property=IPAddressDeny=any' in command
            assert command[command.index('/runtime/env') + 1] == '-i'
            assert kwargs['env'] == {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
            assert not any('Bind' in value or 'Secret' in value or 'TOKEN' in value for value in command)
            if failure == 'timeout':
                raise subprocess.TimeoutExpired(command, 65)
            return subprocess.CompletedProcess(command, 1 if failure == 'unsupported' else 0,
                '{}' if failure == 'invalid-output' else '', 'Unknown assignment RootDirectory')
        return subprocess.CompletedProcess(command, 0, 'not-found\n' if 'show' in command else '', '')
    with patch.object(fixture, 'load', side_effect=lambda repo, name:
                      helper if name == 'prepare-product-npm' else real_load(repo, name)), \
         patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=0o755)), \
         patch.object(fixture.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o755)), \
         patch.object(fixture.os, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=0o644)), \
         patch.object(fixture.os, 'close'), patch.object(fixture.subprocess, 'run', side_effect=run):
        try:
            fixture.service(repo, root, record)
        except (AssertionError, KeyError, subprocess.TimeoutExpired) as error:
            if failure == 'unsupported':
                assert 'Unknown assignment RootDirectory' in str(error)
        else:
            raise AssertionError('boundary startup failure accepted')
    assert len(calls) == 3 and calls[-2][3] == 'stop' and 'show' in calls[-1]

# Runtime copy construction is local and deterministic even inside Codex.
with tempfile.TemporaryDirectory(prefix='npm-filesystem-build-test-') as build:
    built = Path(build) / 'root'
    fixture.build_root(repo, built, node, npm, record['token'])
    boundary = json.loads((built / 'boundary.json').read_text())
    assert boundary['visible_root'] == sorted(entry.name for entry in built.iterdir())
    assert not (built / 'etc').exists()
    for name in ('home', 'root', 'run', 'proc', 'sys'):
        assert list((built / name).iterdir()) == [], 'host content copied into root'
    assert (built / 'runtime/node').stat().st_mode & 0o022 == 0
    assert (built / 'runtime/npm/bin/npm-cli.js').is_file()
    workspace = Path(build) / '.npm-workspace-source-inventory'
    workspace.mkdir()
    (workspace / 'package.json').write_text('{"name":"workspace-sentinel-unique","version":"1.0.0"}')
    (workspace / 'host-package.tgz').write_bytes(b'workspace-tarball-sentinel')
    fixture.workspace_not_staged(built, workspace, 'build')
    try:
        fixture.workspace_not_staged(Path(build) / 'missing', workspace, 'staged')
    except AssertionError as error:
        assert error.args[0][0:2] == ('invalid inventory root', 'staged')
    else:
        raise AssertionError('missing inventory root accepted')
    # Inventory rejects renamed copies, embedded content/path, and symlink exposure.
    leak = built / 'runtime/leak'
    for content in ((workspace / 'package.json').read_bytes(),
                    (workspace / 'host-package.tgz').read_bytes(),
                    b'prefix workspace-sentinel-unique suffix', str(workspace).encode()):
        leak.write_bytes(content)
        try:
            fixture.workspace_not_staged(built, workspace, 'staged')
        except AssertionError as error:
            assert error.args[0] == ('workspace staged content', 'staged', 'workspace', str(leak))
        else:
            raise AssertionError('workspace content staged')
        leak.unlink()
    leak.symlink_to(workspace)
    try:
        fixture.workspace_not_staged(built, workspace, 'staged')
    except AssertionError as error:
        assert error.args[0] == ('workspace staged path', 'staged', 'workspace', str(leak))
    else:
        raise AssertionError('workspace symlink staged')
    leak.unlink()
    fixture.workspace_not_staged(built, workspace, 'staged')
assert not built.exists()

# Exercise service-side preflight and npm evidence classification without mounting
# anything or invoking npm: malformed isolation cannot reach spawnSync.
javascript = r'''
const fs = require('fs'), assert = require('assert/strict');
const execute = new Function('require', 'process', 'console',
  fs.readFileSync(process.argv[1], 'utf8'));
const inventoryModes = ['staged-missing', 'staged-file', 'staged-symlink',
  'staged-owner', 'staged-writable', 'extra-empty', 'extra-denied', 'extra-permission',
  'extra-file', 'extra-symlink', 'extra-device', 'extra-owner', 'extra-group-write',
  'extra-other-write', 'extra-special', 'extra-writable', 'extra-content',
  'extra-read-error', 'extra-write-error'];
const passing = ['pass', 'extra-empty', 'extra-denied', 'extra-permission'];
const emptyDirectories = ['/sys', '/run', '/home', '/root', '/proc'];
const emptyModes = ['empty-readable', 'empty-denied', 'empty-permission', 'empty-missing',
  'empty-content', 'empty-file', 'empty-symlink', 'empty-device', 'empty-read-error',
  'empty-late-file', 'empty-late-symlink', 'empty-late-device'];
const modes = [...inventoryModes, 'pass', 'marker-missing', 'marker-wrong', 'host-visible',
  'host-env-visible',
  'host-os-visible', 'host-run-visible', 'host-proc-visible',
  'bad-env', 'accepted-source', 'unrelated-error', 'timeout', 'broken-control', 'lock'];
for (const [mode, emptyTarget] of [...modes.map(mode=>[mode, null]),
  ...emptyDirectories.flatMap(target=>emptyModes.map(mode=>[mode, target]))]) {
  let calls = 0, emptyStats = 0, reported, error;
  const input = {token:'fixture',hidden:{'workspace-package':'/workspace/pkg/package.json',
    'host-env':'/usr/bin/env', 'host-os-release':'/etc/os-release'},
    packages:['/host/pkg','/workspace/pkg'],
    files:['/host/pkg.tgz','/workspace/pkg.tgz']};
  const fakeFs = {
    constants: {W_OK:2},
    statSync() {return {uid:0,mode:0o644}},
    lstatSync(p) {
      if (p === emptyTarget) emptyStats++;
      const extra = p === '/mount-point-fixture';
      const directory = p !== '/boundary.json' &&
        !(extra && ['extra-file','extra-symlink','extra-device'].includes(mode)) &&
        !(p === emptyTarget && ['empty-file','empty-symlink','empty-device'].includes(mode)) &&
        !(p === emptyTarget && emptyStats > 1 && mode.startsWith('empty-late-')) &&
        !(p === '/runtime' && ['staged-file','staged-symlink'].includes(mode));
      return {isDirectory:()=>directory,isFile:()=>p === '/boundary.json',
        uid:extra ? (mode === 'extra-owner' ? 65534 : 0) :
          p === '/project' || p === '/tmp' || (p === '/runtime' && mode === 'staged-owner') ? 65534 : 0,
        mode:extra ? ({'extra-group-write':0o775,'extra-other-write':0o757,
          'extra-special':0o1755}[mode] || 0o755) :
          p === '/runtime' && mode === 'staged-writable' ? 0o777 : 0o755};
    },
    accessSync(p, flag) {
      assert.equal(p,'/mount-point-fixture');
      assert.equal(flag,2);
      if (mode === 'extra-writable') return;
      throw Object.assign(Error('write check'), {code:mode === 'extra-write-error' ? 'EIO' : 'EACCES'});
    },
    readFileSync() {
      if (mode === 'marker-missing') throw Error('missing boundary');
      return JSON.stringify({token:mode === 'marker-wrong' ? 'wrong' : input.token,
        visible_root:['runtime','project','tmp','boundary.json', ...emptyDirectories.map(p=>p.slice(1))]});
    },
    readdirSync(p) {
      if (p === '/') return ['runtime','project','tmp','boundary.json', ...emptyDirectories.map(p=>p.slice(1))]
        .filter(name=>mode !== 'staged-missing' || name !== 'runtime')
        .concat(mode.startsWith('extra-') ? ['mount-point-fixture'] : []);
      if (p === '/mount-point-fixture') {
        const code = {'extra-denied':'EACCES','extra-permission':'EPERM','extra-read-error':'EIO'}[mode];
        if (code) throw Object.assign(Error('directory check'), {code});
        return mode === 'extra-content' ? ['host-content'] : [];
      }
      if (emptyDirectories.includes(p)) {
        if (p === emptyTarget) {
          const code = {'empty-denied':'EACCES', 'empty-permission':'EPERM',
            'empty-missing':'ENOENT', 'empty-read-error':'EIO'}[mode];
          if (code) throw Object.assign(Error('staged directory check'), {code});
          if (mode === 'empty-content') return ['host-content'];
        }
        return [];
      }
      return mode === 'lock' ? [{name:'package-lock.json',isDirectory:()=>false}] : [];
    },
    openSync(p) {
      // Reproduce the runner: opening a staged empty directory itself succeeds.
      if (emptyDirectories.includes(p) || mode === 'host-visible' ||
          ({'host-env-visible':'/usr/bin/env', 'host-os-visible':'/etc/os-release',
            'host-run-visible':'/run/host/os-release', 'host-proc-visible':'/proc/1/root'}[mode] === p)) return 123;
      throw Object.assign(Error('hidden'), {code:'ENOENT'});
    }, closeSync() {}, symlinkSync() {},
  };
  const fakeProcess = {argv:['node','probe',JSON.stringify(input)],getuid:()=>65534,
    cwd:()=>'/project',env:{HOME:'/project',PATH:'/runtime',LC_ALL:'C'}};
  if (mode === 'bad-env') fakeProcess.env.GITHUB_TOKEN = 'fixture-only';
  const fakeCp = {spawnSync(cmd,args,options) {
    calls++;
    assert.equal(cmd,'/runtime/node');
    for (const flag of ['--offline','--ignore-scripts','--package-lock=false']) assert(args.includes(flag));
    assert.equal(options.timeout,5000);
    const control = ['./local','file:./local-control.tgz'].includes(args.at(-1));
    if (mode === 'timeout') return {error:Error('timeout'),signal:'SIGKILL'};
    return {status:control ? (mode === 'broken-control' ? 1 : 0) :
      (mode === 'accepted-source' ? 0 : 1),signal:null,
      stdout:'[{"name":"local-control","version":"1.0.0"}]',
      stderr:mode === 'unrelated-error' ? 'EOFFLINE' : 'ENOENT'};
  }};
  const modules = {'node:fs':fakeFs,'node:path':require('path'),
    'node:child_process':fakeCp,'node:assert/strict':assert};
  execute(name=>modules[name],fakeProcess,{log:s=>reported=JSON.parse(s),error:s=>error=s});
  if (passing.includes(mode) || ['empty-readable','empty-denied','empty-permission','empty-missing'].includes(mode)) {
    assert.equal(reported.status,'pass');
    assert.equal(calls,17);
    assert.equal(reported.failures.length,13);
  } else {
    assert.equal(fakeProcess.exitCode,1,mode);
    assert(error && !reported,mode);
    if (mode === 'host-visible') assert(error.includes(
      'phase=hidden source_class=workspace-package path=/workspace/pkg/package.json'));
    if (mode === 'host-env-visible') assert(error.includes(
      'phase=hidden source_class=host-env path=/usr/bin/env'));
    for (const [failure, sourceClass, target] of [
      ['host-os-visible','host-os-release','/etc/os-release'],
      ['host-run-visible','system-path','/run/host/os-release'],
      ['host-proc-visible','system-path','/proc/1/root']]) {
      if (mode === failure) assert(error.includes(
        `phase=hidden source_class=${sourceClass} path=${target}`),error);
    }
    if (mode.startsWith('empty-')) {
      assert.equal(calls,0,mode);
      assert(error.includes(['empty-file','empty-symlink','empty-device'].includes(mode) ?
        `phase=inventory source_class=staged-entry path=${emptyTarget}` :
        `phase=hidden source_class=staged-directory path=${emptyTarget}`),error);
    }
    if (inventoryModes.includes(mode)) {
      assert.equal(calls,0,mode);
      assert(error.includes(mode.startsWith('staged-') ?
        'phase=inventory source_class=staged-entry path=/runtime' :
        'phase=inventory source_class=runtime-entry path=/mount-point-fixture'),error);
    }
    if (['accepted-source','unrelated-error'].includes(mode)) assert(error.includes(
      'phase=npm source_class=host-directory path=file:/host/pkg'));
    if (['marker-missing','marker-wrong','host-visible','host-env-visible',
      'host-os-visible','host-run-visible','host-proc-visible','bad-env'].includes(mode)) assert.equal(calls,0);
  }
}
'''
subprocess.run([str(node), '-e', javascript,
                str(repo / '.github/scripts/npm-filesystem-source-probe.js')], check=True, timeout=10)

# Actual npm local-only controls validate the probe command/error contract, but
# do not constitute filesystem isolation proof (that requires the service below).
with tempfile.TemporaryDirectory(prefix='npm-local-command-') as directory:
    local = Path(directory)
    (local / 'local').mkdir()
    (local / 'local/package.json').write_text('{"name":"local-control","version":"1.0.0"}')
    with tarfile.open(local / 'local-control.tgz', 'w:gz') as output:
        output.add(local / 'local/package.json', arcname='package/package.json')
    for name in ('empty.npmrc', 'global.npmrc'):
        (local / name).touch()
    flags = ['--offline', '--ignore-scripts', '--package-lock=false', '--audit=false',
             '--fund=false', '--update-notifier=false', '--cache=' + str(local / 'cache'),
             '--userconfig=' + str(local / 'empty.npmrc'),
             '--globalconfig=' + str(local / 'global.npmrc')]
    for source, success in (('./local', True), ('file:./local-control.tgz', True),
                            ('file:./missing', False), ('./local', True)):
        result = subprocess.run([str(node), str(npm), *flags, 'pack', '--dry-run', '--json', source],
            cwd=local, env={'PATH':str(node.parent), 'HOME':directory, 'LC_ALL':'C'},
            capture_output=True, text=True, timeout=10)
        assert (result.returncode == 0) == success, (result.returncode, result.stderr)
        if success:
            assert json.loads(result.stdout)[0]['name'] == 'local-control', result.stdout
        else:
            assert 'ENOENT' in result.stderr, result.stderr
    assert not list(local.rglob('package-lock.json')) and not list(local.rglob('node_modules'))
assert not local.exists()

# Same-UID controls identify each managed sentinel and preserve failure details.
controls = {kind: '/fixture/' + kind for kind in
            ('host-package', 'host-tarball')}
for phase in ('pre', 'post'):
    for denied in (None, *controls):
        checked = []
        def control_run(command, **kwargs):
            target = command[-1]
            checked.append(target)
            assert command[:7] == ['sudo', '-n', '-u', 'nobody', '/usr/bin/env', '-i', str(node)]
            assert 'assert.equal(process.getuid(),65534)' in command[-2]
            assert kwargs == {'capture_output': True, 'text': True, 'timeout': 5}
            return subprocess.CompletedProcess(command, int(target == controls.get(denied)),
                                               'control stdout', 'EACCES: sentinel unreadable')
        with patch.object(fixture.subprocess, 'run', side_effect=control_run):
            try:
                fixture.same_uid_control(node, controls, phase)
            except AssertionError as error:
                assert denied is not None
                assert error.args[0] == ('same-UID control failed', phase, denied,
                    controls[denied], 1, 'control stdout', 'EACCES: sentinel unreadable')
            else:
                assert denied is None
        expected = list(controls.values())
        if denied:
            expected = expected[:expected.index(controls[denied]) + 1]
        assert checked == expected, 'failed control continued or skipped a sentinel'

# Two fresh roots and cleanup are required, including a failing second service.
for failure in (None, 'service', 'pre-host', 'post-host', 'inventory-build', 'inventory-staged'):
    roots = [Path('/run/npm-filesystem-fixture-abcdefgh'),
             Path('/run/npm-filesystem-fixture-ijklmnop')]
    calls, serviced, control_paths, inventories, workspace_paths = [], [], [], [], []
    def inventory(root, workspace, phase):
        inventories.append(phase)
        workspace_paths.append(Path(workspace))
        assert Path(workspace).parent == repo
        assert all((Path(workspace) / name).is_file() for name in ('package.json', 'host-package.tgz'))
        # Runner workspace readability is irrelevant to the outside control.
        Path(workspace).chmod(0o700)
        if failure == 'inventory-' + phase:
            raise AssertionError('workspace staged content')
    def simulate_service(repo, root, record):
        serviced.append(root)
        assert len(record['files']) == 2 and all(Path(p).is_file() for p in record['files'])
        assert record['hidden']['workspace-root'] == str(repo)
        assert record['hidden']['repository-head'] == str(repo / '.git/HEAD')
        assert record['hidden']['host-os-release'] == '/etc/os-release'
        assert record['hidden']['host-env'] == '/usr/bin/env' and Path('/usr/bin/env').is_file()
        assert Path(record['hidden']['workspace-package']).parent == workspace_paths[-1]
        assert record['hidden']['workspace-tarball'] == record['files'][1]
        assert inventories[-2:] == ['build', 'staged']
        if failure == 'service' and len(serviced) == 2:
            raise AssertionError('fixture service failed')
        return {'status':'pass'}
    def simulated_run(command, **kwargs):
        calls.append(command)
        if '-e' in command:
            target = Path(command[-1])
            control_paths.append(target)
            assert target.is_file() and target.stat().st_mode & 0o777 == 0o644
            assert target.parent.stat().st_mode & 0o777 == 0o755
            assert target.parent.parent == Path('/tmp'), 'workspace used as positive control'
            phase = 'pre' if (len(control_paths) - 1) % 4 < 2 else 'post'
            if failure == phase + '-host':
                return subprocess.CompletedProcess(command, 1, '', 'EACCES: sentinel unreadable')
        return subprocess.CompletedProcess(command, 0, '', '')
    with patch.object(fixture.os, 'getuid', return_value=1000), \
         patch.object(fixture, 'build_root'), \
         patch.object(fixture, 'workspace_not_staged', side_effect=inventory), \
         patch.object(fixture, 'service', side_effect=simulate_service), \
         patch.object(fixture.subprocess, 'check_output', side_effect=[str(p)+'\n' for p in roots]), \
         patch.object(fixture.subprocess, 'run', side_effect=simulated_run), \
         patch.object(Path, 'exists', return_value=False), patch('builtins.print'):
        try:
            fixture.runtime(repo, node, npm)
        except AssertionError as error:
            assert failure is not None
            if failure == 'service':
                assert str(error) == 'fixture service failed'
            elif failure.startswith('inventory-'):
                assert str(error) == 'workspace staged content'
            else:
                phase, kind = failure.split('-')
                assert error.args[0][0:3] == ('same-UID control failed', phase, kind + '-package')
        else:
            assert failure is None
    started = roots if failure in (None, 'service') else roots[:1]
    expected_services = [] if failure and failure.startswith(('pre-', 'inventory-')) \
        else [p / 'root' for p in started]
    assert serviced == expected_services
    assert [cmd[-1] for cmd in calls if 'rm' in cmd] == [str(p) for p in started]
    assert all(not p.parent.exists() for p in control_paths), 'host fixture leaked'
    assert workspace_paths and all(not p.exists() for p in workspace_paths), 'workspace fixture leaked'
    if failure is None:
        assert len(control_paths) == 8
        assert all(control_paths.count(target) == 4 for target in set(control_paths))

for name in ('npm-filesystem-boundary-runtime.py', 'npm-filesystem-source-probe.js',
             'test-npm-filesystem-sources.sh'):
    for workflow in (repo / '.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring', workflow)
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('filesystem sources: top-level policy/root construction/fail-closed/cleanup/dormant contracts passed', flush=True)

if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP filesystem runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('filesystem source runtime requires systemd on the regression runner')
    print('SKIP filesystem runtime: systemd is not PID 1')
    sys.exit(0)
fixture.runtime(repo, node, npm)
print('filesystem sources: real npm/hidden host roots/traversal/symlink/repeat/cleanup runtime passed')
PY
