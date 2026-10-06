#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import importlib.util
import errno
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

repo = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('initial_lock', repo / '.github/scripts/npm-initial-lock-runtime.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
node, npm = Path(shutil.which('node')).resolve(), Path(shutil.which('npm')).resolve()
token = 'a' * 32
source = repo / '.github/scripts/npm-initial-lock-probe.js'

javascript = r'''
const fs = require('node:fs'), assert = require('node:assert/strict'), path = require('node:path');
const [source, root, token] = process.argv.slice(1);
const project = root + '/project', port = 12345;
// Prove both marker paths can detect execution with a MOCK filesystem only.
const writer = fs.readFileSync(project+'/lifecycle-marker.js','utf8');
for (const kind of ['project','dependency']) for (const event of ['preinstall','install','postinstall','prepare']) {
  const name = `${token}-${kind}-${event}`;
  for (const hostError of [null,'ENOENT','EACCES']) {
    let appends = [], writes = [];
    const markerRequire = module => module === 'node:fs' ? {
      appendFileSync(target,content) {
        if (hostError) throw Object.assign(Error(),{code:hostError});
        appends.push([target,content]);
      },
      writeFileSync(target,content,options) {writes.push([target,content,options]);}
    } : module === 'node:path' ? path : assert;
    const run = () => new Function('require','process','__dirname',writer)(
      markerRequire,{argv:['node','marker',name]},project);
    if (hostError === 'EACCES') {assert.throws(run);assert.deepEqual(writes,[]);}
    else {
      run();
      assert.deepEqual(writes,[[project+'/markers/'+name,'executed',{flag:'wx'}]]);
      assert.equal(appends.length,hostError ? 0 : 1);
      if (!hostError) assert.equal(appends[0][1],name+'\n');
    }
  }
}
const translate = p => p.replace(/^\/project/,project).replace(/^\/runtime/,root+'/runtime');
let calls = [], config = 'safe', fault = '', phase = 'lock', isolationBad = false;
let changed = false, candidate = false, artifact = false, artifactName = 'node_modules', artifactType = 'directory';
const lock = {lockfileVersion:3,packages:{'node_modules/initial-lock-dependency':{
  version:'1.0.0',resolved:`http://127.0.0.1:${port}/initial-lock-dependency/-/initial-lock-dependency-1.0.0.tgz`}}};
const fakeFs = {...fs,
  lstatSync(p) {
    if (config === 'project' && p === '/project/.npmrc') return {isFile:()=>true};
    if (config === 'dangling' && p === '/project/.npmrc') return {isFile:()=>false};
    if (config === 'unreadable' && p === '/project/.npmrc') throw Object.assign(Error(),{code:'EACCES'});
    if (config === 'missing' && p === '/project/global.npmrc') throw Object.assign(Error(),{code:'ENOENT'});
    if (config === 'symlink' && p === '/project/empty.npmrc') return {isFile:()=>false};
    if (p === '/project/package-lock.json') return {isFile:()=>true,isDirectory:()=>false};
    if (p === '/project/'+artifactName && artifact)
      return {isFile:()=>artifactType==='file',isDirectory:()=>artifactType==='directory'};
    return fs.lstatSync(translate(p));
  },
  readFileSync(p, options) {
    if (config === 'nonempty' && p.endsWith('global.npmrc')) return 'ignore-scripts=false';
    if (config === 'builtin' && p === '/runtime/npm/npmrc') return 'ignore-scripts=false';
    if (p === '/project/package-lock.json') {
      if (!candidate) throw Object.assign(Error(),{code:'ENOENT'});
      if (fault === 'invalid-lock') return 'not-json';
      if (fault === 'lock-version') return JSON.stringify({...lock,lockfileVersion:99});
      if (fault === 'missing-entry') return '{"lockfileVersion":3,"packages":{}}';
      return JSON.stringify(lock);
    }
    if (changed && p === '/project/package.json') return '{}';
    return fs.readFileSync(translate(p),options);
  },
  readdirSync(p, options) {
    const entries = fs.readdirSync(translate(p),options);
    if (fault === 'marker' && changed && p === '/project/markers') return ['executed'];
    if (p === '/project') {
      if (candidate) entries.push('package-lock.json');
      if (artifact) entries.push(artifactName);
    }
    return entries;
  }
};
const fakeCp = {spawnSync(cmd,args,options) {
  calls.push(args);
  assert.equal(cmd,'/runtime/node');
  assert.equal(options.cwd,'/project');
  assert.deepEqual(options.env,{PATH:'/runtime',HOME:'/project',LC_ALL:'C'});
  const operation = args.includes('config') ? 'config' : 'lock';
  assert.equal(options.timeout,operation === 'config' ? 10000 : 30000);
  assert.equal(options.killSignal,'SIGKILL');
  if (operation === phase) {
    if (fault === 'timeout') return {error:Error(),signal:'SIGKILL',status:null};
    if (fault === 'signal') return {signal:'SIGTERM',status:null};
    if (fault === 'error') return {signal:null,status:1};
    if (fault === 'throw') throw Error('fixture-only');
    if (fault === 'artifact') artifact = true;
    if (['marker','mutation'].includes(fault)) changed = true;
  }
  if (operation === 'lock' && fault !== 'no-lock') candidate = true;
  let stdout = operation === 'config' ? 'true\n' : '{"added":0,"removed":0,"changed":0}';
  if (operation === phase) {
    if (fault === 'enabled') stdout = 'false\n';
    if (fault === 'malformed') stdout = 'not-json';
    if (fault === 'reported-error') stdout = '{"error":{}}';
    if (fault === 'added') stdout = '{"added":1,"removed":0,"changed":0}';
    if (fault === 'array') stdout = '[]';
  }
  return {status:0,signal:null,stdout};
}};
const fixtureModule = {exports:{}};
const fixtureRequire = name => ({'node:fs':fakeFs,'node:path':path,'node:child_process':fakeCp,
  'node:assert/strict':assert,'./filesystem-probe.js':{isolationPreflight(){assert(!isolationBad);}}}[name]);
new Function('require','module',fs.readFileSync(source,'utf8'))(fixtureRequire,fixtureModule);
const probe = fixtureModule.exports, good = probe.command('lock',port);
const flags = ['/runtime/npm/bin/npm-cli.js','--ignore-scripts','--package-lock=true',
  '--lockfile-version=3','--audit=false','--fund=false','--update-notifier=false',
  '--workspaces=false','--include=dev','--include=optional','--include=peer',
  '--fetch-retries=0','--fetch-timeout=8000',`--registry=http://127.0.0.1:${port}/`,
  '--userconfig=/project/empty.npmrc','--globalconfig=/project/global.npmrc','--cache=/project/cache'];
assert.deepEqual(good,[...flags,'install','--package-lock-only','--json']);
assert.deepEqual(probe.command('config',port),[...flags,'config','get','ignore-scripts']);
for (const args of [good.filter(a=>a!=='--ignore-scripts'),[...good,'--ignore-scripts=false'],
  [...good,'--ignore-scripts'],good.map(a=>a==='--ignore-scripts'?'--no-ignore-scripts':a),
  good.filter(a=>a!=='--package-lock-only'),[...good,'--package-lock=false'],
  [...good,'file:./fixture'],[...good,'git+https://example.invalid/repo'],
  good.map(a=>a.startsWith('--registry=')?'--registry=https://example.invalid/':a),
  good.map(a=>a.startsWith('--userconfig=')?'--userconfig=/host/config':a),
  good.map(a=>a.startsWith('--globalconfig=')?'--globalconfig=/host/config':a),
  [...good,'--fetch-retries=1'],[...good,'--fetch-timeout=300000'],
  good.map(a=>a==='--fetch-timeout=8000'?'--fetch-timeout=5000':a),
  [...good,'--timeout=300000'],null,'install']) {
  assert.throws(()=>probe.runNpm('lock',port,args));
}
for (const operation of ['pack','rebuild','run','unknown','__proto__',null])
  assert.throws(()=>probe.runNpm(operation,port));
for (const badPort of [0,80,65536,'12345',null]) assert.throws(()=>probe.runNpm('lock',badPort));
const inherited = {GITHUB_TOKEN:'fixture-only',GH_TOKEN:'fixture-only',NODE_AUTH_TOKEN:'fixture-only',
  NPM_TOKEN:'fixture-only',AWS_SECRET_ACCESS_KEY:'fixture-only',NODE_OPTIONS:'--require=/host/config',
  npm_config_ignore_scripts:'false',NPM_CONFIG_IGNORE_SCRIPTS:'false',
  npm_config_fetch_timeout:'300000',NPM_CONFIG_FETCH_TIMEOUT:'300000',
  npm_config_timeout:'300000',NPM_CONFIG_TIMEOUT:'300000',
  npm_config_userconfig:'/host/config',HTTPS_PROXY:'fixture-only'};
for (const [name,value] of Object.entries(inherited))
  assert.throws(()=>probe.runNpm('lock',port,good,{...probe.npmEnv,[name]:value}));
for (const env of [{},{...probe.npmEnv,HOME:'/host'},{...probe.npmEnv,PATH:'/usr/bin'}])
  assert.throws(()=>probe.runNpm('lock',port,good,env));
for (config of ['project','dangling','unreadable','missing','symlink','nonempty','builtin'])
  assert.throws(()=>probe.runNpm('lock',port));
config = 'safe';
isolationBad = true;
assert.throws(()=>probe.probe({token,port}));
isolationBad = false;
assert.equal(calls.length,0,'unsafe contract reached npm');
// Every root/dependency lifecycle event must exist before the first npm spawn.
for (const target of ['package.json','fixture/package.json']) {
  const file = project + '/' + target, original = fs.readFileSync(file,'utf8');
  for (const event of ['preinstall','install','postinstall','prepare']) {
    const value = JSON.parse(original); delete value.scripts[event];
    fs.writeFileSync(file,JSON.stringify(value));
    assert.throws(()=>probe.probe({token,port}));
    fs.writeFileSync(file,original);
  }
}
assert.equal(calls.length,0,'missing script reached npm');
for (artifactName of ['node_modules','npm-shrinkwrap.json','.package-lock.json','unexpected']) {
  for (artifactType of ['file','directory','symlink','special']) {
    artifact = true;
    assert.throws(()=>probe.probe({token,port}));
    assert.equal(calls.length,0,'preexisting artifact reached npm');
    artifact = false;
  }
}
artifactName = 'node_modules'; artifactType = 'directory';
Object.assign(process.env,inherited);
for (phase of ['config','lock']) {
  const faults = ['timeout','signal','error','throw','artifact','marker','mutation'];
  if (phase === 'config') faults.push('enabled','malformed');
  else faults.push('malformed','reported-error','added','array','no-lock','invalid-lock','lock-version','missing-entry');
  for (fault of faults) {
    calls = []; changed = candidate = artifact = false;
    assert.throws(()=>probe.probe({token,port}),fault);
    assert.equal(calls.length,phase==='config'?1:2,'failure retried/fell back');
  }
}
fault = ''; calls = []; changed = candidate = artifact = false;
// Workload fields cannot override either operation's trusted spawn deadline.
const evidence = probe.probe({token,port,timeout:300000,configTimeout:300000,lockTimeout:300000});
assert.equal(calls.length,2);
assert.equal(evidence.candidate,'package-lock.json');
assert.deepEqual(evidence.command,good);
assert.deepEqual(evidence.markers,[]);
'''

paths = []
socket_skipped = False
for mode in ('mock', 'real', 'real'):
    with tempfile.TemporaryDirectory(prefix='npm-initial-lock-local-') as directory:
        root = Path(directory) / 'root'
        host_marker = Path(directory) / 'host-side-effects'
        host_marker.write_text('')
        fixture.build_root(repo, root, node, npm, token, host_marker)
        project = root / 'project'
        assert (root / 'runtime/filesystem-probe.js').read_bytes() == \
            (repo / '.github/scripts/npm-filesystem-source-probe.js').read_bytes()
        assert (root / 'runtime/probe.js').read_bytes() == source.read_bytes()
        assert json.loads((root / 'boundary.json').read_text())['visible_root'] == sorted(p.name for p in root.iterdir())
        assert all(not list((root / name).iterdir()) for name in ('run','proc','sys','home','root'))
        value = json.loads((project / 'fixture/package.json').read_text())
        writer = (project / 'lifecycle-marker.js').read_bytes()
        payload = fixture.archive(value, writer)
        assert payload == fixture.archive(value, writer), 'non-deterministic tarball'
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            assert json.load(archive.extractfile('package/package.json')) == value
            assert archive.extractfile('package/lifecycle-marker.js').read() == writer
        if mode == 'mock':
            subprocess.run([str(node), '-e', javascript, str(source), str(root), token],
                           check=True, timeout=15, env=fixture.ENV)
        else:
            # Same probe/command/config/env logic, replacing ONLY disposable path
            # constants. Isolation is not claimed by this local operation proof.
            def localize(text):
                return text.replace('/runtime', str(root / 'runtime')).replace('/project', str(project))
            for target in (project / 'package.json', project / 'fixture/package.json'):
                target.write_text(localize(target.read_text()))
            value = json.loads((project / 'fixture/package.json').read_text())
            (root / 'runtime/local-probe.js').write_text(localize(source.read_text()))
            (root / 'runtime/filesystem-probe.js').write_text('exports.isolationPreflight = () => {};\n')
            try:
                registry = fixture.Registry(value, writer)
            except PermissionError as error:
                if error.errno != errno.EPERM or 'codex-' not in Path('/proc/self/cgroup').read_text():
                    raise
                socket_skipped = True
                print('SKIP initial-lock local real npm: socket EPERM in inherited Codex boundary', flush=True)
                registry = None
            if registry is not None:
                with registry:
                    record = {'token': token, 'port': registry.port}
                    result = subprocess.run([str(root / 'runtime/node'), str(root / 'runtime/local-probe.js'),
                        json.dumps(record)], cwd=project, capture_output=True, text=True, timeout=25,
                        env={'PATH':str(root / 'runtime'),'HOME':str(project),'LC_ALL':'C'})
                    assert result.returncode == 0, (result.returncode,result.stdout,result.stderr)
                    evidence = json.loads(result.stdout)
                    assert evidence['markers'] == [] and evidence['node_modules'] is False
                    assert host_marker.read_bytes() == b'', 'host lifecycle side effect detected'
                    print(json.dumps({'mode':'local-operation',**evidence,**registry.evidence(),
                                      'host_side_effects':0}), flush=True)
                    assert json.loads((project / 'package-lock.json').read_text())['lockfileVersion'] == 3
        paths.append(root)
    assert not root.exists(), 'local root cleanup failed'
assert len(set(paths)) == 3
print('initial-lock: exact command/unsafe overrides/config/env/mock lifecycle/candidate checks passed', flush=True)
if not socket_skipped:
    print('initial-lock: local real npm/two fresh roots/metadata-only/candidate/cleanup passed', flush=True)

# Registry itself must reject a content request even if npm returned success.
handlers = []
def server(address, handler):
    assert address == ('127.0.0.1',0)
    handlers.append(handler)
    return SimpleNamespace(server_address=('127.0.0.1',12345),serve_forever=lambda **kwargs:None)
with patch.object(fixture,'HTTPServer',side_effect=server):
    registry = fixture.Registry(value,writer)
handler = object.__new__(handlers[0])
for request, expected in [('/'+fixture.NAME,200),('/'+fixture.NAME+'/-/package.tgz',403),('/unknown',403)]:
    handler.path, handler.wfile = request, io.BytesIO()
    handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
    handler.do_GET()
    handler.send_response.assert_called_once_with(expected)
    if expected == 200:
        metadata = json.loads(handler.wfile.getvalue())['versions']['1.0.0']
        assert metadata['scripts'] == value['scripts'] and metadata['hasInstallScript'] is True
        assert metadata['dist']['tarball'].startswith(registry.url)
        assert metadata['dist']['integrity'].startswith('sha512:')
assert registry.requests == [('GET','/'+fixture.NAME),('GET','/'+fixture.NAME+'/-/package.tgz'),('GET','/unknown')]
registry = object.__new__(fixture.Registry)
registry.requests = [('GET','/'+fixture.NAME)]
assert registry.evidence() == {'metadata_requests':1,'tarball_requests':0,
                               'dependency_execution_path':'not-entered'}
for requests in ([], [('GET','/'+fixture.NAME),('GET','/'+fixture.NAME+'/-/package.tgz')],
                 [('POST','/'+fixture.NAME)], [('GET','/unknown')]):
    registry.requests = requests
    try:
        registry.evidence()
    except AssertionError:
        pass
    else:
        raise AssertionError('content access accepted as dependency suppression')

# Socket/thread cleanup is fail-closed even where real sockets are unavailable.
for cleanup in ('pass','listener','timeout','thread'):
    registry = object.__new__(fixture.Registry)
    registry.port = 12345
    registry.server = SimpleNamespace(shutdown=Mock(),server_close=Mock())
    registry.thread = SimpleNamespace(join=Mock(),is_alive=lambda:cleanup=='thread')
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    if cleanup in ('pass','thread'):
        client.connect.side_effect = OSError(errno.ECONNREFUSED,'fixture-only')
    elif cleanup == 'timeout':
        client.connect.side_effect = TimeoutError('fixture-only')
    with patch.object(fixture.socket,'socket',return_value=client):
        try:
            registry.__exit__(None,None,None)
        except AssertionError:
            assert cleanup != 'pass'
        else:
            assert cleanup == 'pass'
    registry.server.shutdown.assert_called_once()
    registry.server.server_close.assert_called_once()
    registry.thread.join.assert_called_once_with(3)
registry.thread.start = Mock(side_effect=RuntimeError('fixture-only'))
registry.server.server_close.reset_mock()
try:
    registry.__enter__()
except RuntimeError:
    pass
else:
    raise AssertionError('registry startup failure ignored')
registry.server.server_close.assert_called_once()

# Exercise success, staging/service/evidence failures and both cleanup failures.
# #654/#656 regressions separately cover unchanged launcher/stop/collect behavior.
boundary = fixture.lifecycle(repo).filesystem(repo)
for failure in (None,'build','copy','service','evidence','host-effect','cleanup-error','cleanup-residual'):
    roots = [Path('/run/npm-filesystem-fixture-abcdefgh'),Path('/run/npm-filesystem-fixture-ijklmnop')]
    calls, serviced, builds = [], [], []
    def build(repo, root, node, npm, token, host_marker):
        builds.append(root.parent)
        if failure == 'build':
            raise AssertionError('build failure')
        (root / 'project/fixture').mkdir(parents=True)
        (root / 'project/fixture/package.json').write_text('{}')
        (root / 'project/lifecycle-marker.js').write_text('fixture')
    def service(repo, root, record):
        serviced.append(root)
        assert record['port'] == 12345
        if failure == 'service' and len(serviced) == 2:
            raise AssertionError('service failure')
        if failure == 'host-effect':
            Path(record['hidden']['lifecycle-host-marker']).write_text('executed')
        return {'status':'pass','operations':['config','lock'],'markers':[],
                'node_modules':False,'candidate':'wrong' if failure == 'evidence' else 'package-lock.json'}
    def run(command, **kwargs):
        calls.append(command)
        assert kwargs['env'] == fixture.ENV
        if (failure == 'copy' and 'cp' in command) or (failure == 'cleanup-error' and 'rm' in command):
            raise subprocess.CalledProcessError(1,command)
        return subprocess.CompletedProcess(command,0,'','')
    registry = SimpleNamespace(port=12345,evidence=lambda:{'tarball_requests':0})
    from contextlib import nullcontext
    with patch.object(fixture.os,'getuid',return_value=1000), \
         patch.object(fixture,'build_root',side_effect=build), \
         patch.object(fixture,'lifecycle',return_value=SimpleNamespace(filesystem=lambda repo:boundary)), \
         patch.object(boundary,'service',side_effect=service), \
         patch.object(fixture,'Registry',side_effect=lambda *args:nullcontext(registry)), \
         patch.object(fixture.subprocess,'check_output',side_effect=[str(p)+'\n' for p in roots]) as mktemp, \
         patch.object(fixture.subprocess,'run',side_effect=run), \
         patch.object(Path,'exists',autospec=True,side_effect=lambda p:failure=='cleanup-residual' and p in roots), \
         patch('builtins.print'):
        try:
            fixture.runtime(repo,node,npm)
        except (AssertionError,subprocess.CalledProcessError):
            assert failure is not None
        else:
            assert failure is None
    expected = roots if failure in (None,'service') else roots[:1]
    assert mktemp.call_count == len(expected)
    assert [cmd[-1] for cmd in calls if 'rm' in cmd] == [str(p) for p in expected]
    assert all(not p.exists() for p in builds), 'build root leaked'
    assert serviced == ([] if failure in ('build','copy') else [p/'root' for p in expected])

for name in ('npm-initial-lock-runtime.py','npm-initial-lock-probe.js','test-npm-initial-lock.sh'):
    for workflow in (repo / '.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring',workflow)
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
assert 'npm-initial-lock' not in (repo / '.github/scripts/prepare-product-npm.py').read_text()
print('initial-lock: registry content evidence/failure cleanup/production unreachable passed', flush=True)
if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP initial-lock runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('initial-lock runtime requires systemd on the regression runner')
    print('SKIP initial-lock runtime: systemd is not PID 1')
    sys.exit(0)
fixture.runtime(repo,node,npm)
print('initial-lock: restricted service/candidate/metadata-only/two fresh roots/cleanup runtime passed')
PY
