#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

repo = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('lifecycle', repo / '.github/scripts/npm-lifecycle-boundary-runtime.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
node = Path(shutil.which('node')).resolve()
npm = Path(shutil.which('npm')).resolve()
token = 'a' * 32

# Root construction retains #654 staging/inventory; only disposable probe and
# lifecycle fixtures are added. Product workspace is never bound or copied.
with tempfile.TemporaryDirectory(prefix='npm-lifecycle-copy-') as build:
    root = Path(build) / 'root'
    fixture.build_root(repo, root, node, npm, token)
    assert (root / 'runtime/filesystem-probe.js').read_bytes() == \
        (repo / '.github/scripts/npm-filesystem-source-probe.js').read_bytes()
    assert (root / 'runtime/probe.js').read_bytes() == \
        (repo / '.github/scripts/npm-lifecycle-script-probe.js').read_bytes()
    boundary = json.loads((root / 'boundary.json').read_text())
    assert boundary['visible_root'] == sorted(entry.name for entry in root.iterdir())
    for name in ('home', 'root', 'run', 'proc', 'sys'):
        assert not list((root / name).iterdir())
    for kind, target in (('project', root / 'project'),
                         ('dependency', root / 'project/lifecycle-package')):
        assert json.loads((target / 'package.json').read_text())['scripts'] == fixture.scripts(token, kind)
    assert not list((root / 'project/markers').iterdir())
assert not root.exists()

javascript = r'''
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const [source, project, token] = process.argv.slice(1);
// Validate the deterministic marker writer with a mocked filesystem only.
const markerCode = fs.readFileSync(path.join(project,'lifecycle-marker.js'),'utf8');
let markerWrites = [];
const markerRequire = name => name === 'node:assert/strict' ? assert : name === 'node:path' ? path : {
  writeFileSync(target,content,options) { markerWrites.push({target,content,options}); },
};
for (const kind of ['project','dependency']) {
  for (const event of ['preinstall','install','postinstall','prepare','prepack','postpack']) {
    const name = `${token}-${kind}-${event}`;
    for (const directory of ['/project', project]) {
      new Function('require','process','__dirname',markerCode)(markerRequire,{argv:['node','marker',name]},directory);
      assert.deepEqual(markerWrites.pop(),{target:path.join(directory,'markers',name),content:'executed',options:{flag:'wx'}});
    }
  }
}
for (const invalid of ['../../host','wrong-token-project-install',token+'-project-unknown']) {
  assert.throws(()=>new Function('require','process','__dirname',markerCode)(markerRequire,{argv:['node','marker',invalid]},project));
}
assert.equal(markerWrites.length,0);
let calls = [], preflightCalls = 0, isolationFailure = false, configMode = 'safe';
let effect = false, lock = false, missingScripts = false;
const localPath = p => p.startsWith('/project') ? project + p.slice(8) : p;
const fakeFs = {
  ...fs,
  lstatSync(p) {
    if (configMode === 'missing' && p === '/project/empty.npmrc') throw Object.assign(Error(),{code:'ENOENT'});
    if (configMode === 'symlink' && p === '/project/empty.npmrc') return {isFile:()=>false};
    return fs.lstatSync(localPath(p));
  },
  existsSync(p) {
    return configMode === 'project' && p === '/project/.npmrc' ? true : fs.existsSync(localPath(p));
  },
  readFileSync(p, options) {
    if (configMode === 'nonempty' && p === '/project/global.npmrc') return 'ignore-scripts=false';
    if (missingScripts && p === '/project/package.json') return '{"name":"lifecycle-project","version":"1.0.0","scripts":{}}';
    return fs.readFileSync(localPath(p), options);
  },
  readdirSync(p, options) {
    if (effect && p === '/project/markers') return ['unexpected-marker'];
    if (lock && options) return [{name:'.package-lock.json',isDirectory:()=>false}];
    return fs.readdirSync(localPath(p), options);
  },
};
let spawnMode = 'pass', failureOperation = 'config';
const fakeCp = {spawnSync(cmd,args,options) {
  assert.equal(cmd,'/runtime/node');
  assert.deepEqual(options.env,{PATH:'/runtime',HOME:'/project',LC_ALL:'C'});
  assert.equal(options.cwd,'/project');
  assert.equal(options.timeout,10000);
  assert.equal(options.killSignal,'SIGKILL');
  calls.push(args);
  const operation = args[10];
  const outcome = operation === failureOperation ? spawnMode : 'pass';
  if (outcome === 'throw') throw Error('fixture-only');
  if (outcome === 'timeout') return {error:Error('timeout'),signal:'SIGKILL',status:null};
  if (outcome === 'error') return {signal:null,status:1,stdout:'',stderr:'fixture-only'};
  if (outcome === 'side-effect') effect = true;
  if (outcome === 'lock') lock = true;
  if (outcome === 'malformed') return {signal:null,status:0,stdout:'not-json'};
  const stdout = operation === 'config' ? (outcome === 'enabled' ? 'false\n' : 'true\n') :
    operation === 'pack' ? '[{"filename":"lifecycle-dependency-1.0.0.tgz"}]' : 'rebuilt dependencies successfully';
  return {signal:null,status:0,stdout};
}};
const fixtureModule = {exports:{}};
const fixtureRequire = name => ({'node:fs':fakeFs,'node:path':path,'node:child_process':fakeCp,
  'node:assert/strict':assert,'./filesystem-probe.js':{isolationPreflight(input) {
    preflightCalls++;
    assert.equal(input.token,token);
    if (isolationFailure) throw Error('isolation failed');
  }}}[name]);
new Function('require','module',fs.readFileSync(source,'utf8'))(fixtureRequire,fixtureModule);
const probe = fixtureModule.exports;
{
  const good = probe.command('rebuild');
  const invalid = [good.filter(a=>a !== '--ignore-scripts'),
    [...good,'--ignore-scripts=false'],[...good,'--ignore-scripts=true'],
    good.map(a=>a === '--ignore-scripts' ? '--no-ignore-scripts' : a),
    good.map(a=>a.startsWith('--userconfig=') ? '--userconfig=/root/.npmrc' : a),
    good.map(a=>a.startsWith('--globalconfig=') ? '--globalconfig=/etc/npmrc' : a),
    good.filter(a=>a !== '--offline'),[...good,'run','prepare'],null,'install'];
  for (const args of invalid) assert.throws(()=>probe.runNpm('rebuild',args));
  for (const operation of ['unknown','run','__proto__',null]) assert.throws(()=>probe.runNpm(operation));
  const inherited = {GITHUB_TOKEN:'fixture-only',GH_TOKEN:'fixture-only',NODE_AUTH_TOKEN:'fixture-only',
    NPM_TOKEN:'fixture-only',AWS_SECRET_ACCESS_KEY:'fixture-only',NODE_OPTIONS:'--require=/host/unsafe',
    npm_config_ignore_scripts:'false',NPM_CONFIG_USERCONFIG:'/host/config',HTTPS_PROXY:'fixture-only'};
  for (const [name,value] of Object.entries(inherited)) {
    assert.throws(()=>probe.runNpm('rebuild',good,{...probe.npmEnv,[name]:value}));
  }
  assert.throws(()=>probe.runNpm('rebuild',good,{PATH:'/runtime',HOME:'/host',LC_ALL:'C'}));
  for (const value of ['missing','symlink','nonempty','project']) {
    configMode = value;
    assert.throws(()=>probe.runNpm('rebuild'));
  }
  configMode = 'safe';
  assert.equal(calls.length,0,'preflight failure reached npm');
  isolationFailure = true;
  assert.throws(()=>probe.probe({token}));
  isolationFailure = false;
  missingScripts = true;
  assert.throws(()=>probe.probe({token}));
  missingScripts = false;
  assert.equal(calls.length,0,'missing fixture scripts reached npm');
  for (const [index,operation] of ['config','pack','rebuild'].entries()) {
    failureOperation = operation;
    const failures = ['timeout','error','throw','side-effect','lock','malformed'];
    if (operation === 'config') failures.push('enabled');
    for (const value of failures) {
      spawnMode = value;
      calls = [];
      assert.throws(()=>probe.probe({token}));
      assert.equal(calls.length,index + 1,'failed proof continued to another npm operation');
      effect = lock = false;
    }
  }
  // Caller credentials are not copied: npm receives only the bounded literal.
  Object.assign(process.env,inherited);
  spawnMode = 'pass';
}
calls = [];
assert.deepEqual(probe.probe({token}),{status:'pass',scripts:'disabled',markers:[],
  operations:['config','pack','rebuild']});
assert.equal(calls.length,3);
assert(preflightCalls > 0);
assert.deepEqual(fs.readdirSync(path.join(project,'markers')),[]);
'''

# One mock fixture and two fresh local real-npm fixtures; never enable scripts.
local_paths = []
for mode in ('mock', 'real', 'real'):
    with tempfile.TemporaryDirectory(prefix='npm-lifecycle-local-') as directory:
        project = Path(directory)
        fixture.stage_fixture(project, token)
        for name in ('empty.npmrc', 'global.npmrc'):
            (project / name).touch()
        if mode == 'mock':
            subprocess.run([str(node), '-e', javascript,
                str(repo / '.github/scripts/npm-lifecycle-script-probe.js'),
                directory, token], check=True, timeout=15,
                env={'PATH':str(node.parent),'HOME':directory,'LC_ALL':'C'})
        else:
            # Scripts must be executable in this fresh local fixture as well:
            # a missing /runtime/node must not make suppression look successful.
            # Only mock execution above exercises the marker writer itself.
            local_scripts = {}
            for kind, target in (('project', project), ('dependency', project/'lifecycle-package'),
                                 ('dependency', project/'node_modules/lifecycle-dependency')):
                manifest = json.loads((target/'package.json').read_text())
                local_scripts[kind] = {event: value.replace('/runtime/node', str(node)).replace(
                    '/project/lifecycle-marker.js', str(project/'lifecycle-marker.js'))
                    for event, value in fixture.scripts(token, kind).items()}
                manifest['scripts'] = local_scripts[kind]
                (target/'package.json').write_text(json.dumps(manifest))
            assert node.is_file() and (project/'lifecycle-marker.js').is_file()
            # Local npm operation proof is independent of systemd isolation.
            # This Python subprocess control is not a service fallback.
            flags = ['--offline','--ignore-scripts','--package-lock=false','--audit=false',
                     '--fund=false','--update-notifier=false',
                     '--userconfig='+str(project/'empty.npmrc'),
                     '--globalconfig='+str(project/'global.npmrc'),
                     '--cache='+str(project/'cache')]
            for operation in (['config','get','ignore-scripts'],
                              ['pack','--json','./lifecycle-package'],
                              ['rebuild','--json','lifecycle-dependency']):
                result = subprocess.run([str(node),str(npm),*flags,*operation],
                    cwd=project,env={'PATH':str(node.parent),'HOME':directory,'LC_ALL':'C'},
                    capture_output=True,text=True,timeout=10)
                assert result.returncode == 0, (operation[0],result.returncode,result.stderr)
                if operation[0] == 'config':
                    assert result.stdout.strip() == 'true'
                elif operation[0] == 'pack':
                    assert json.loads(result.stdout)[0]['filename'] == 'lifecycle-dependency-1.0.0.tgz'
                else:
                    assert result.stdout.strip() == 'rebuilt dependencies successfully'
                    installed = json.loads((project/'node_modules/lifecycle-dependency/package.json').read_text())
                    assert installed['scripts'] == local_scripts['dependency']
                assert not list((project/'markers').iterdir()), 'lifecycle side effect detected'
        assert not list(project.rglob('package-lock.json'))
        assert not list(project.rglob('npm-shrinkwrap.json'))
        assert not list(project.rglob('.package-lock.json'))
        local_paths.append(project)
    assert not project.exists(), 'local fixture cleanup failed'
assert len(set(local_paths)) == 3
print('lifecycle: fixed contract/fail-closed/env/local real npm/repeat/cleanup passed', flush=True)

# Caller -> systemd-run uses #654 exact bounded env/command. Its startup,
# timeout, unsupported-property and unit cleanup are covered by #654 regression.
boundary = fixture.filesystem(repo)
helper = boundary.load(repo, 'prepare-product-npm')
from types import SimpleNamespace
root = Path('/run/npm-filesystem-fixture-abcdefgh/root')
record = {'token':token}
with patch.object(helper, 'directory', return_value=123), \
     patch.object(helper, 'read_input', return_value=json.dumps(record).encode()), \
     patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=0,st_mode=0o755)), \
     patch.object(boundary.os, 'fstat', return_value=SimpleNamespace(st_uid=0,st_mode=0o755)), \
     patch.object(boundary.os, 'stat', return_value=SimpleNamespace(st_uid=0,st_mode=0o644)), \
     patch.object(boundary.os, 'close'), \
     patch.dict(os.environ, {'GITHUB_TOKEN':'fixture-only','NPM_TOKEN':'fixture-only'}):
    command = boundary.command(repo, root, 'npm-filesystem-probe-'+'b'*32+'.service', record)
    assert command[:8] == ['sudo','-n','/usr/bin/env','-i','PATH=/usr/bin:/bin','LC_ALL=C',
                          '/usr/bin/systemd-run','--quiet']
    assert '--property=ReadWritePaths=+/project +/tmp' in command
    assert '--property=RootDirectory='+str(root) in command
    assert not any('fixture-only' in arg or 'TOKEN' in arg or 'Bind' in arg for arg in command)
    assert command[command.index('/runtime/env')+1:command.index('/runtime/node')] == \
        ['-i','PATH=/runtime','HOME=/project','LC_ALL=C']

# Both successful cycles and failure during build/staging/service must discard
# roots. Failure does not retry or launch npm outside the isolated service.
for failure in (None, 'build', 'copy', 'service', 'evidence'):
    roots = [Path('/run/npm-filesystem-fixture-abcdefgh'), Path('/run/npm-filesystem-fixture-ijklmnop')]
    calls, serviced, builds = [], [], []
    def build(repo, root, node, npm, token):
        builds.append(root.parent)
        if failure == 'build':
            raise AssertionError('build failure')
    def service(repo, root, record):
        serviced.append(root)
        assert record['hidden']['workspace-root'] == str(repo)
        if failure == 'service' and len(serviced) == 2:
            raise AssertionError('service failure')
        return {} if failure == 'evidence' else {'status':'pass','scripts':'disabled',
            'markers':[],'operations':['config','pack','rebuild']}
    def run(command, **kwargs):
        calls.append(command)
        assert kwargs['env'] == fixture.ENV
        if failure == 'copy' and 'cp' in command:
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command,0,'','')
    with patch.object(fixture.os, 'getuid', return_value=1000), \
         patch.object(fixture, 'build_root', side_effect=build), \
         patch.object(boundary, 'service', side_effect=service), \
         patch.object(fixture, 'filesystem', return_value=boundary), \
         patch.object(fixture.subprocess, 'check_output', side_effect=[str(p)+'\n' for p in roots]) as mktemp, \
         patch.object(fixture.subprocess, 'run', side_effect=run), \
         patch.object(Path, 'exists', return_value=False), patch('builtins.print'):
        try:
            fixture.runtime(repo,node,npm)
        except (AssertionError,subprocess.CalledProcessError):
            assert failure is not None
        else:
            assert failure is None
    expected = roots if failure in (None,'service') else roots[:1]
    assert mktemp.call_count == len(expected)
    assert [cmd[-1] for cmd in calls if 'rm' in cmd] == [str(p) for p in expected]
    assert all(not p.exists() for p in builds), 'build fixture leaked'
    assert serviced == ([] if failure in ('build','copy') else [p/'root' for p in expected])

for name in ('npm-lifecycle-boundary-runtime.py','npm-lifecycle-script-probe.js','test-npm-lifecycle-scripts.sh'):
    for workflow in (repo / '.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring',workflow)
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('lifecycle: restricted launcher/cleanup/dormant contracts passed', flush=True)

if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP lifecycle runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('lifecycle runtime requires systemd on the regression runner')
    print('SKIP lifecycle runtime: systemd is not PID 1')
    sys.exit(0)
fixture.runtime(repo,node,npm)
print('lifecycle: real npm/scripts absent/restricted service/two fresh roots/cleanup runtime passed')
PY
