#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import importlib.util

repo = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('offline_ci', repo / '.github/scripts/npm-offline-ci-runtime.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
node, npm = Path(shutil.which('node')).resolve(), Path(shutil.which('npm')).resolve()
source = repo / '.github/scripts/npm-offline-ci-probe.js'
token = 'a' * 32

javascript = r'''
const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
const path = require('node:path');
const [root, token] = process.argv.slice(1);
const initialFile = root + '/runtime/initial-lock-probe.js';
const translate = p => p.replace(/^\/runtime/, root+'/runtime').replace(/^\/project/,root+'/project');
const safeFs = {...fs, lstatSync:p=>fs.lstatSync(translate(p)),
  readFileSync:(p,...args)=>fs.readFileSync(translate(p),...args)};
let calls = [], failure = '', operation = 'ci', mutation = '', successful = false, missing = false;
const fakeCp = {spawnSync(executable,args,options) {
  assert.equal(executable,'/runtime/node'); assert.equal(options.cwd,'/project');
  assert.deepEqual(options.env,{PATH:'/runtime',HOME:'/project',LC_ALL:'C'});
  assert.equal(options.timeout,10000); assert.equal(options.killSignal,'SIGKILL');
  calls.push(args);
  const config = args.includes('config');
  const matches = config === (operation === 'config');
  if (matches && failure === 'throw') throw Error('fixture');
  if (matches && failure === 'timeout') return {error:Error(),status:null,signal:'SIGKILL'};
  if (matches && failure === 'signal') return {status:null,signal:'SIGTERM'};
  if (matches && mutation) fs.writeFileSync(root+'/project/'+mutation,'unexpected');
  if (matches && failure === 'marker') fs.writeFileSync(root+'/project/markers/ran','executed');
  if (matches && failure === 'symlink') fs.symlinkSync('/host',root+'/project/cache/escape');
  if (matches && failure === 'error') return {status:1,signal:null,stdout:'{"error":{"code":"EOTHER"}}'};
  if (!config && successful) {
   if (missing) return {status:1,signal:null,stdout:'{"error":{"code":"ENOTCACHED"}}'};
   fs.mkdirSync(root+'/project/node_modules/initial-lock-dependency',{recursive:true});
   for(const name of ['package.json','lifecycle-marker.js'])
    fs.copyFileSync(root+'/project/fixture/'+name,root+'/project/node_modules/initial-lock-dependency/'+name);
   const lock=JSON.parse(fs.readFileSync(root+'/project/package-lock.json'));
   delete lock.packages[''];
   fs.writeFileSync(root+'/project/node_modules/.package-lock.json',JSON.stringify(lock));
  }
  return {status:0,signal:null,stdout:config ? (failure==='enabled' ? 'false\n':'true\n') :
    failure==='malformed' ? 'not-json' : JSON.stringify(failure==='added' ? {added:0,removed:0,changed:0} :
      {added:1,removed:0,changed:0})};
}};
const initialModule = {exports:{}};
new Function('require','module',fs.readFileSync(initialFile,'utf8'))(
  name=>name==='node:fs'?safeFs:name==='./filesystem-probe.js'?{}:require(name),initialModule);
const initial = initialModule.exports;
let isolationBad = false, networkBad = false, observed = [];
const mockedFs = {...safeFs, existsSync:p=>fs.existsSync(translate(p)),
  readdirSync:p=>fs.readdirSync(translate(p))};
const mockedNet = {connect({host,port}) {
  assert(['127.0.0.1','::1'].includes(host)); assert(Number.isInteger(port));
  return {once(event, callback) {if(event==='data') queueMicrotask(()=>callback(Buffer.from('network-probe')));},destroy(){}};
}, createServer(callback) {
  const server = {once(){},listen(target,done){assert.equal(target,'/project/offline-ci.sock');done();},close(done){done();}};
  return server;
}};
// UNIX connection has a string argument instead of the TCP options object.
const tcpConnect = mockedNet.connect;
mockedNet.connect = options => typeof options === 'string' ? {
  once(event,callback){if(event==='data') queueMicrotask(()=>callback(Buffer.from('local-ipc')));},destroy(){},
} : tcpConnect(options);
const moduleFixture = {exports:{}};
new Function('require','module',fs.readFileSync(root+'/runtime/probe.js','utf8'))(name=>({
  'node:fs':mockedFs,'node:child_process':fakeCp,'node:net':mockedNet,
  './initial-lock-probe.js':initial,
  './registry-lock-probe.js':{snapshot:async()=>{assert(!networkBad);observed.push('snapshot');},
    directDeny:async()=>{assert(!networkBad);observed.push('deny');}},
  './filesystem-probe.js':{isolationPreflight(){assert(!isolationBad);}},
}[name] || require(name)),moduleFixture);
const probe = moduleFixture.exports, good = probe.command();
assert.deepEqual(good,['/runtime/npm/bin/npm-cli.js','--offline','--ignore-scripts',
 '--package-lock=true','--audit=false','--fund=false','--update-notifier=false',
 '--workspaces=false','--include=dev','--include=optional','--include=peer',
 '--fetch-retries=0','--fetch-timeout=5000','--registry=https://registry.npmjs.org/',
 '--userconfig=/project/empty.npmrc','--globalconfig=/project/global.npmrc',
 '--cache=/project/cache','ci','--json']);
for (const args of [good.filter(a=>a!=='--offline'),good.filter(a=>a!=='--ignore-scripts'),
 [...good,'--ignore-scripts=false'],[...good,'--offline=false'],[...good,'--ignore-scripts'],
 good.map(a=>a==='ci'?'install':a),[...good,'file:/host'],[...good,'--registry=http://127.0.0.1:12345/'],
 [...good,'--userconfig=/host'],null,'ci']) assert.throws(()=>probe.runNpm('ci',args));
for (const operation of ['install','pack','rebuild',null,'__proto__']) assert.throws(()=>probe.command(operation));
for (const env of [{},{...initial.npmEnv,HOME:'/host'},
 {...initial.npmEnv,NPM_CONFIG_IGNORE_SCRIPTS:'false'},{...initial.npmEnv,NPM_TOKEN:'fixture'},
 {...initial.npmEnv,NODE_OPTIONS:'--require=/host'},{...initial.npmEnv,HTTPS_PROXY:'fixture'}])
 assert.throws(()=>probe.runNpm('ci',good,env));
for (const file of ['empty.npmrc','global.npmrc']) {
 fs.writeFileSync(root+'/project/'+file,'ignore-scripts=false');
 assert.throws(()=>probe.runNpm('ci')); fs.writeFileSync(root+'/project/'+file,'');
}
fs.symlinkSync('/missing',root+'/project/.npmrc'); assert.throws(()=>probe.runNpm('ci'));
fs.unlinkSync(root+'/project/.npmrc');
assert.equal(calls.length,0,'unsafe contract spawned npm');
const input = {token, missing:false, local_port:12345, ipv6_port:12346};
async function checks() {
 isolationBad = true; await assert.rejects(probe.probe(input)); isolationBad = false;
 networkBad = true; await assert.rejects(probe.probe(input)); networkBad = false;
 assert.equal(calls.length,0,'unsafe boundary spawned npm');
 for (const event of ['preinstall','install','postinstall','prepare']) {
  const target=root+'/project/fixture/package.json', original=fs.readFileSync(target);
  const value=JSON.parse(original); delete value.scripts[event]; fs.writeFileSync(target,JSON.stringify(value));
  await assert.rejects(probe.probe(input)); fs.writeFileSync(target,original);
 }
 assert.equal(calls.length,0,'missing lifecycle script spawned npm');
 for (operation of ['config','ci']) for (failure of ['throw','timeout','signal','error','marker','symlink',
   ...(operation==='config'?['enabled']:['malformed','added'])]) {
  calls=[]; await assert.rejects(probe.probe(input),failure);
  assert.equal(calls.length,operation==='config'?1:2,'npm retried/fell back');
  for(const file of ['markers/ran','cache/escape']) fs.rmSync(root+'/project/'+file,{force:true});
 }
 failure='';
 for (operation of ['config','ci']) for (mutation of ['package.json','package-lock.json','unexpected']) {
  const target=root+'/project/'+mutation, existed=fs.existsSync(target), bytes=existed?fs.readFileSync(target):null;
  calls=[]; await assert.rejects(probe.probe(input),mutation);
  assert.equal(calls.length,operation==='config'?1:2);
  if(existed) fs.writeFileSync(target,bytes); else fs.unlinkSync(target);
 }
 mutation=''; calls=[];
 successful=true;
 const goodEvidence=await probe.probe(input);
 assert.equal(goodEvidence.install,'cache-only'); assert.equal(calls.length,2);
 assert.deepEqual(goodEvidence.command,good); assert.deepEqual(goodEvidence.env,initial.npmEnv);
 fs.rmSync(root+'/project/node_modules',{recursive:true});
 calls=[]; missing=true;
 const miss=await probe.probe({...input,missing:true});
 assert.equal(miss.install,'ENOTCACHED'); assert.equal(calls.length,2);
 assert.equal(miss.dependency_content,'absent');
 calls=[]; failure='error';
 await assert.rejects(probe.probe({...input,missing:true}));
 assert.equal(calls.length,2,'unrelated error accepted as cache miss');
 failure=''; successful=false; missing=false;
 // Marker writer controls are mocks, never scripts-enabled npm.
 const writer=fs.readFileSync(root+'/project/lifecycle-marker.js','utf8');
 for(const kind of ['project','dependency']) for(const event of ['preinstall','install','postinstall','prepare'])
  for(const hostError of [null,'ENOENT','EACCES']) {
   let writes=[],appends=[];
   const run=()=>new Function('require','process','__dirname',writer)(name=>name==='node:fs'?{
    appendFileSync(target,body){if(hostError)throw Object.assign(Error(),{code:hostError});appends.push(body);},
    writeFileSync(...args){writes.push(args);},
   }:require(name),{argv:['node','writer',token+'-'+kind+'-'+event]},root+'/project');
   if(hostError==='EACCES') assert.throws(run);
   else {run();assert.equal(writes.length,1);assert.equal(appends.length,hostError?0:1);}
  }
 console.log('offline-ci: exact identity/config/env/boundary/lifecycle/mutation/no retry mock passed');
}
checks().catch(error=>{console.error(error);process.exitCode=1;});
'''

roots = []
for missing in (False, True, False, True):
    with tempfile.TemporaryDirectory(prefix='npm-offline-ci-local-') as temporary:
        root = Path(temporary) / 'root'
        marker = Path(temporary) / 'side-effects'
        marker.write_bytes(b'')
        prepared = fixture.build_root(repo, root, node, npm, token, marker, missing)
        assert prepared['status'] == 'prepared'
        if not roots:
            subprocess.run([str(node), '-e', javascript, str(root), token], check=True, timeout=20, env=fixture.ENV)
        project = root / 'project'
        # Local operation proof uses actual paths for BOTH root/dependency scripts.
        # Isolation/network are explicitly omitted; formal runner tests them below.
        def localize(value):
            return value.replace('/runtime', str(root / 'runtime')).replace('/project', str(project))
        for target in [project / 'package.json', project / 'fixture/package.json']:
            target.write_text(localize(target.read_text()))
        initial = fixture.load(repo, 'npm-initial-lock-runtime')
        payload = initial.archive(json.loads((project / 'fixture/package.json').read_bytes()),
                                  (project / 'lifecycle-marker.js').read_bytes())
        value = json.loads((project / 'package-lock.json').read_bytes())
        import base64
        value['packages']['node_modules/initial-lock-dependency']['integrity'] = (
            'sha512-' + base64.b64encode(hashlib.sha512(payload).digest()).decode())
        (project / 'package-lock.json').write_text(json.dumps(value))
        fixture.prepare_cache(repo, project, node, npm, payload)
        if missing:
            shutil.rmtree(project / 'cache'); (project / 'cache').mkdir()
        for name in ('package.json','package-lock.json','lifecycle-marker.js'):
            shutil.copy2(project / name, root / 'runtime' / name)
        shutil.copy2(project / 'package.json',root / 'runtime/manifest.json')
        (root / 'runtime/local-probe.js').write_text(localize(source.read_text()))
        (root / 'runtime/initial-lock-probe.js').write_text(localize(
            (repo / '.github/scripts/npm-initial-lock-probe.js').read_text()))
        (root / 'runtime/filesystem-probe.js').write_text('exports.isolationPreflight=()=>{};\n')
        (root / 'runtime/registry-lock-probe.js').write_text('exports.snapshot=async()=>{};exports.directDeny=async()=>{};\n')
        local = root / 'runtime/local-probe.js'
        expected = tuple((project / name).read_bytes() for name in ('package.json','package-lock.json'))
        env = {'PATH':str(root/'runtime'),'HOME':str(project),'LC_ALL':'C'}
        def evaluate(code):
            return subprocess.check_output([str(node),'-e',code,str(local),token,str(missing).lower()],
                                           text=True,timeout=10,env=env)
        before = evaluate("const p=require(process.argv[1]);p.inputs(process.argv[2]);console.log(JSON.stringify(p.inventory()))")
        for operation in ('config','ci'):
            # Python local operation matches #656: evaluate the canonical JS
            # constructor, then execute it without Node's inherited socketpair limit.
            args = json.loads(evaluate("console.log(JSON.stringify(require(process.argv[1]).command(" + json.dumps(operation) + ")))") )
            result = subprocess.run([str(root/'runtime/node'),*args],cwd=project,env=env,
                                    capture_output=True,text=True,timeout=15)
            if operation == 'config':
                assert result.returncode == 0 and result.stdout.strip() == 'true', result.stderr
            elif missing:
                assert result.returncode > 0 and json.loads(result.stdout)['error']['code'] == 'ENOTCACHED', result.stderr
            else:
                value = json.loads(result.stdout)
                assert result.returncode == 0 and (value['added'],value['removed'],value['changed']) == (1,0,0), result.stderr
        evaluate("const p=require(process.argv[1]);p.inputs(process.argv[2]);p.installed(process.argv[3]==='true')")
        assert before == evaluate("console.log(JSON.stringify(require(process.argv[1]).inventory()))")
        assert marker.read_bytes() == b''
        fixture.verify_inputs(repo, root, expected)
        print(json.dumps({'mode':'local-operation','install':'ENOTCACHED' if missing else 'cache-only',
                          'host_side_effects':0}),flush=True)
        roots.append(root)
    assert not root.exists(), 'local root leaked'
assert len(set(roots)) == 4
print('offline-ci: real npm/cache-only/cache miss/input invariance/four fresh roots/cleanup passed',flush=True)

# The restricted launcher is shared unchanged. Inject orchestration failures to
# prove this new caller cleans its roots/sentinels and never retries the service.
command = fixture.candidate_command(repo, node)
assert command[-2:] == ['ci','--json'] and command.count('--offline') == 1
integration = fixture.load(repo, 'npm-registry-lock-runtime')
boundary = fixture.load(repo, 'npm-filesystem-boundary-runtime')
for failure in (None,'build','copy','pre-snapshot','service','post-snapshot','evidence',
                'host-effect','cleanup-error','cleanup-residual'):
    staged = Path('/run/npm-filesystem-fixture-abcdefgh')
    calls, serviced, hosts, builds = [], [], [], []
    expected = (b'{"name":"fixture"}',b'{}')
    def build(repo, root, node, npm, token, marker, missing):
        hosts.append(marker.parent); builds.append(root.parent)
        if failure == 'build':
            raise AssertionError('build failure')
        (root / 'project').mkdir(parents=True)
        for name, value in zip(('package.json','package-lock.json'), expected):
            (root / 'project' / name).write_bytes(value)
        return {'status':'prepared'}
    def service(repo, root, record, observer=None):
        serviced.append(root)
        assert observer is not None and record['hidden']['workspace-root'] == str(repo)
        if failure == 'service':
            raise AssertionError('service failure')
        if failure == 'host-effect':
            Path(record['hidden']['lifecycle-host-marker']).write_text('executed')
        return {'install':'wrong' if failure == 'evidence' else 'cache-only',
                'markers':[],'direct_udp':'EPERM','localhost':'pass','node':'v24.0.0','npm':'11.0.0',
                'command':command,'env':{'PATH':'/runtime','HOME':'/project','LC_ALL':'C'},
                'manifest_hash':hashlib.sha256(expected[0]).hexdigest(),
                'lock_hash':hashlib.sha256(expected[1]).hexdigest()}
    def run(args, **kwargs):
        calls.append(args)
        assert kwargs['env'] == fixture.ENV
        if (failure == 'copy' and 'cp' in args) or (failure == 'cleanup-error' and 'rm' in args):
            raise subprocess.CalledProcessError(1,args)
        return subprocess.CompletedProcess(args,0)
    def snapshot(*args):
        if failure == ('post-snapshot' if serviced else 'pre-snapshot'):
            raise AssertionError('snapshot failure')
        return {}
    modules = {'npm-registry-lock-runtime':integration,'npm-filesystem-boundary-runtime':boundary}
    with patch.object(fixture,'load',side_effect=lambda repo,name:modules[name]), \
         patch.object(fixture,'candidate_command',return_value=command), \
         patch.object(fixture,'build_root',side_effect=build), \
         patch.object(fixture,'host_control'), patch.object(fixture,'verify_inputs'), \
         patch.object(integration,'normalize_staging_acls'), \
         patch.object(integration,'staged_snapshot',side_effect=snapshot), \
         patch.object(boundary,'service',side_effect=service), \
         patch.object(fixture.subprocess,'check_output',return_value=str(staged)+'\n'), \
         patch.object(fixture.subprocess,'run',side_effect=run), \
         patch.object(Path,'exists',autospec=True,side_effect=lambda path:failure=='cleanup-residual' and path==staged), \
         patch('builtins.print'):
        try:
            fixture.run_fixture(repo,node,npm,{'node_version':'v24.0.0','npm_version':'11.0.0'},
                SimpleNamespace(),SimpleNamespace(),SimpleNamespace(address='192.0.2.1',port=12345,
                ipv6_port=12346,accepted=0),False)
        except (AssertionError,subprocess.CalledProcessError):
            assert failure is not None, failure
        else:
            assert failure is None, failure
    assert [args for args in calls if 'rm' in args] == [['sudo','-n','rm','-rf','--',str(staged)]]
    assert len(serviced) == (0 if failure in ('build','copy','pre-snapshot') else 1)
    assert all(not path.is_dir() for path in hosts+builds), 'build/host cleanup failed'
print('offline-ci: staging/service/evidence/host-effect failures/cleanup/no retry mock passed',flush=True)

for name in ('npm-offline-ci-runtime.py','npm-offline-ci-probe.js','test-npm-offline-ci.sh'):
    for workflow in (repo / '.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring',workflow)
    assert name not in (repo / '.github/scripts/prepare-product-npm.py').read_text()
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
print('offline-ci: production unreachable passed',flush=True)
if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP offline-ci runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('offline-ci runtime requires systemd on the regression runner')
    print('SKIP offline-ci runtime: systemd is not PID 1')
    sys.exit(0)
fixture.runtime(repo)
print('offline-ci: restricted service/lifecycle/cache-only/cache miss/localhost/direct deny/cleanup passed')
PY
