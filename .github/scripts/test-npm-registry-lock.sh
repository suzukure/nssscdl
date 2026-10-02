#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import errno
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import importlib.util

repo = Path(sys.argv[1]).resolve()
scripts = repo / '.github/scripts'
spec = importlib.util.spec_from_file_location('registry_lock', scripts / 'npm-registry-lock-runtime.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
# Keep the selected launcher aliases so provenance can check their link chains.
node, npm = Path(shutil.which('node')), Path(shutil.which('npm'))
token = 'a' * 32
javascript = r'''
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const [scripts, root, token] = process.argv.slice(1);
function load(name, imports, processOverride=process) {
  const m = {exports:{}};
  new Function('require','module','process',fs.readFileSync(scripts+'/'+name,'utf8'))(
    name => imports[name] || require(name),m,processOverride);
  return m.exports;
}
async function adapterTests() {
  for (const fault of ['', 'proxy-error','proxy-403','proxy-head','tls-error','redirect','body-large','body-json','identity']) {
    let connects = 0, gets = 0, tlsCalls = 0, destroyed = 0;
    const socket = {destroy(){destroyed++;}};
    const fakeHttp = {request(options) {
      connects++; assert.deepEqual(options,{host:'127.0.0.1',port:12345,method:'CONNECT',
        path:'registry.npmjs.org:443',headers:{Host:'registry.npmjs.org:443'},agent:false});
      const request = new EventEmitter(); request.destroy = () => {};
      request.end = () => process.nextTick(() => {
        if (fault==='proxy-error') request.emit('error',Error());
        else request.emit('connect',{statusCode:fault==='proxy-403'?403:200},socket,
          fault==='proxy-head'?Buffer.from('unexpected'):Buffer.alloc(0));
      });
      return request;
    }};
    const fakeTls = {connect(options) {
      tlsCalls++; assert.deepEqual(options,{socket,servername:'registry.npmjs.org',rejectUnauthorized:true});
      return socket;
    }};
    const fakeHttps = {Agent:class {destroy(){}},get(options, callback) {
      gets++; assert.equal(options.hostname,'registry.npmjs.org');assert.equal(options.path,'/is-number/7.0.0');
      assert.deepEqual(options.headers,{Accept:'application/json','Accept-Encoding':'identity'});
      assert.equal(options.agent.createConnection(),socket);
      const request = new EventEmitter(); request.destroy = () => {};
      process.nextTick(() => {
        if (fault==='tls-error') return request.emit('error',Error());
        const response = new EventEmitter(); response.statusCode = fault==='redirect'?302:200;
        callback(response);
        const body = fault==='body-large'?'x'.repeat(65537):fault==='body-json'?'invalid':
          JSON.stringify({name:fault==='identity'?'other':'is-number',version:'7.0.0',dist:{fixture:'unchanged'}});
        response.emit('data',Buffer.from(body)); response.emit('end');
      });
      return request;
    }};
    const adapter = load('npm-registry-lock-adapter.js',{'node:http':fakeHttp,'node:https':fakeHttps,'node:tls':fakeTls});
    if (fault) await assert.rejects(adapter.metadata(12345),/official-registry-unavailable/);
    else assert.deepEqual(await adapter.metadata(12345),{name:'is-number',version:'7.0.0',dist:{fixture:'unchanged'}});
    assert.equal(connects,1);assert(gets<=1 && tlsCalls<=1,'retry/direct fallback');
    for (const port of [80,65536,'12345',null]) assert.throws(()=>adapter.metadata(port));
    const counts={metadata:0,denied:0}, value={name:'is-number',version:'7.0.0',dist:{integrity:'untouched'}};
    const handler=adapter.handler(value,counts);
    for (const [method,url,status] of [['GET','/is-number',200],['POST','/is-number',403],
      ['GET','/is-number/-/is-number-7.0.0.tgz',403],['GET','/unknown',403],['GET','http://example.invalid/',403]]) {
      const response={writeHead(code){assert.equal(code,status);},end(body){
        if(status===200) assert.deepEqual(JSON.parse(body).versions['7.0.0'],value);
      }};
      handler({method,url},response);
    }
    assert.deepEqual(counts,{metadata:1,denied:4});
  }
}
async function integrationTests() {
  const project=root+'/project', unit='npm-filesystem-probe-'+token+'.service';
  const digest=crypto.createHash('sha256').update(fs.readFileSync(project+'/package.json')).digest('hex');
  const input={token,unit,manifest_hash:digest,proxy_uid:1000,proxy_port:12345,address:'192.0.2.1',direct_port:12346,hidden:{}};
  let fault='', calls=[], workers=0, udpCalls=0;
  const translate=p=>p.replace(/^\/project/,project).replace(/^\/runtime/,root+'/runtime');
  const fakeFs={...fs,lstatSync(p){
    if(p.endsWith(unit+'.json'))return {isFile:()=>true,uid:fault==='snapshot-owner'?65534:0,mode:0o100444};
    const info=fs.lstatSync(translate(p));
    return new Proxy(info,{get(o,k){if(k==='uid')return fault==='runtime-owner'?65534:0;
      if(k==='mode' && fault==='runtime-mode')return 0o100666;return typeof o[k]==='function'?o[k].bind(o):o[k];}});
  },readFileSync(p,options){
    if(p.endsWith(unit+'.json'))return JSON.stringify({unit:fault==='snapshot-unit'?'other':unit,properties:'validated'});
    if(p==='/project/package.json' && fault==='manifest')return Buffer.from('{}');
    return fs.readFileSync(translate(p),options);
  },readdirSync(p,options){return fs.readdirSync(translate(p),options);},
  existsSync(p){if(p.endsWith(unit+'.json'))return true;return fs.existsSync(translate(p));},
  accessSync(){if(fault==='runtime-writable')return;throw Object.assign(Error(),{code:'EACCES'});}};
  const fakeCp={spawnSync(command,args,options){
    calls.push(args);assert.equal(command,'/runtime/node');assert.equal(options.cwd,'/project');
    assert.deepEqual(options.env,{PATH:'/runtime',HOME:'/project',LC_ALL:'C'});
    const config=args.includes('config');
    if((config && fault==='config') || (!config && fault==='lock'))return {status:1,signal:null};
    if(!config){
      fs.writeFileSync(project+'/package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/is-number':{
        version:'7.0.0',resolved:'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz'}}}));
      if(fault==='marker')fs.writeFileSync(project+'/markers/executed','executed');
      if(fault==='mutation')fs.writeFileSync(project+'/unexpected','changed');
    }
    return {status:0,signal:null,stdout:config?'true':'{"added":0,"removed":0,"changed":0}'};
  },fork(script,args,options){
    workers++;assert.equal(script,'/runtime/npm-registry-lock-adapter.js');assert.deepEqual(args,['12345']);
    assert.equal(options.execPath,'/runtime/node');assert.deepEqual(options.execArgv,[]);
    assert.deepEqual(options.env,{PATH:'/runtime',HOME:'/project',LC_ALL:'C'});
    const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
    child.kill=()=>assert.fail('unexpected force kill');
    child.send=message=>{
      assert.equal(message,'stop');process.nextTick(()=>{
        child.emit('message',{metadata:1,denied:fault==='content'?1:0});
        child.exitCode=0;child.emit('exit',0,null);
      });
    };
    process.nextTick(()=>{
      if(fault==='unavailable'){child.exitCode=1;child.emit('exit',1,null);}
      else child.emit('message',{port:23456});
    });return child;
  }};
  const initial=load('npm-initial-lock-probe.js',{'node:fs':fakeFs,'node:child_process':fakeCp,
    './filesystem-probe.js':{isolationPreflight(){}}});
  const probe=load('npm-registry-lock-probe.js',{'node:fs':fakeFs,'node:child_process':fakeCp,
    './filesystem-probe.js':{isolationPreflight(){assert(fault!=='boundary');}},'./initial-lock-probe.js':initial,
    'node:dgram':{createSocket(){return {send(body,port,address,done){udpCalls++;
      assert.equal(address,input.address);assert.equal(port,input.direct_port);
      done(fault==='direct'?null:Object.assign(Error(),{code:'EPERM'}));},close(){}};}},
    'node:net':{isIPv4:()=>true,connect(options){const s=new EventEmitter();s.destroy=()=>{};
      process.nextTick(()=>s.emit('error',Object.assign(Error(),{code:options.host==='127.0.0.1'?'ECONNREFUSED':'EPERM'})));return s;}}},
    {...process,getuid:()=>65534});
  for (fault of ['boundary','runtime-owner','runtime-mode','runtime-writable','manifest',
    'snapshot-owner','snapshot-unit','direct','unavailable','config','lock','marker','mutation','content','']) {
    calls=[];workers=udpCalls=0;
    try{
      if(fault)await assert.rejects(probe.probe(input));
      else{const evidence=await probe.probe(input);assert.equal(evidence.candidate,'package-lock.json');
        assert.deepEqual(evidence.command,initial.command('lock',23456));assert.equal(evidence.tarball_requests,0);}
      const early=['boundary','runtime-owner','runtime-mode','runtime-writable','manifest','snapshot-owner','snapshot-unit','direct'];
      assert.equal(workers,early.includes(fault)?0:1);
      assert.equal(calls.length,early.includes(fault)||fault==='unavailable'?0:fault==='config'?1:2);
    } finally{
      for(const name of ['package-lock.json','unexpected','markers/executed'])fs.rmSync(project+'/'+name,{force:true});
    }
  }
  fault='unavailable';calls=[];
  assert.deepEqual(await probe.probe({...input,expect_unavailable:true}),{
    status:'pass',fail_closed:'official-registry-unavailable',npm_started:false});assert.equal(calls.length,0);
}
(async()=>{await adapterTests();await integrationTests();})().catch(e=>{console.error(e);process.exitCode=1;});
'''
with tempfile.TemporaryDirectory(prefix='registry-lock-test-') as directory:
    root = Path(directory) / 'root'
    digest = fixture.build_root(repo, root, node, npm, token)
    assert hashlib.sha256((root / 'project/package.json').read_bytes()).hexdigest() == digest
    assert (root / 'runtime/manifest.json').read_bytes() == (root / 'project/package.json').read_bytes()
    assert sorted(p.name for p in (root / 'project').iterdir()) == [
        'cache','empty.npmrc','global.npmrc','lifecycle-marker.js','markers','package.json']
    assert list((root / 'project/cache').iterdir()) == []
    subprocess.run([str(node), '-e', javascript, str(scripts), str(root), token],
                   check=True, timeout=30, env=fixture.ENV)
assert not root.exists()

# Source provenance rejects owner/parent write-boundary and external npm symlinks.
original = Path.lstat
def trusted_info(path):
    actual = original(path)
    return SimpleNamespace(st_uid=0, st_gid=0, st_mode=actual.st_mode & ~0o022)
with patch.object(Path, 'lstat', side_effect=trusted_info, autospec=True), \
     patch.object(fixture.os, 'getxattr', side_effect=OSError(errno.ENODATA, 'no ACL')):
    provenance = fixture.runtime_provenance(node, npm)
assert len(provenance['node_sha256']) == len(provenance['npm_cli_sha256']) == 64
for fault in ('owner','write','parent'):
    def info(path):
        actual = trusted_info(path)
        target = node.resolve() if fault != 'parent' else node.resolve().parent
        if path == target:
            return SimpleNamespace(st_uid=123456 if fault=='owner' else actual.st_uid, st_gid=0,
                                   st_mode=actual.st_mode | (0o022 if fault!='owner' else 0))
        return actual
    with patch.object(Path, 'lstat', side_effect=info, autospec=True), \
         patch.object(fixture.os, 'getxattr', side_effect=OSError(errno.ENODATA, 'no ACL')):
        try:
            fixture.runtime_provenance(node,npm)
        except AssertionError:
            pass
        else:
            raise AssertionError('unsafe runtime provenance accepted')

# Model /usr/local launchers, hosted toolcache, and npm internal symlink chains.
# The failure context supplies the path, not its mode: cover root/caller 0755
# and trusted-group 0775 layouts without assuming an actual runner image mode.
for layout in ('local', 'toolcache'):
    prefix = Path('/usr/local' if layout == 'local' else '/opt/hostedtoolcache/node/24.0.0/x64')
    binary = prefix / 'bin/node'
    distribution = prefix / 'lib/node_modules/npm'
    cli = distribution / 'bin/npm-cli.js'
    alias_node, alias_npm = Path('/usr/local/bin/node'), Path('/usr/local/bin/npm')
    for fault in ('', 'trusted-group', 'caller-owned', 'owner', 'workload-owner',
                  'other-write', 'workload-group', 'unknown-group', 'parent-owner',
                  'parent-write', 'alias-parent-write', 'link-owner', 'link-outside',
                  'link-loop', 'dangling', 'npm-escape', 'npm-hop-escape',
                  'intermediate-owner', 'directory-alias', 'directory-link-owner',
                  'acl-write', 'acl-error', 'special'):
        tree, links, inspected = {}, {}, []
        def entry(path, mode, uid=0, gid=0):
            tree[path] = SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=mode)
            for parent in path.parents:
                tree.setdefault(parent, SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o755))
        entry(binary, stat.S_IFREG | 0o755)
        entry(cli, stat.S_IFREG | 0o644)
        entry(distribution / 'bin/real.js', stat.S_IFREG | 0o644)
        def link(path, target):
            entry(path, stat.S_IFLNK | 0o777)
            links[path] = str(target)
        if layout == 'toolcache':
            link(alias_node, binary)
        link(alias_npm, distribution / 'bin/cli-link.js')
        link(distribution / 'bin/cli-link.js', 'npm-cli.js')
        link(distribution / 'bin/internal.js', 'real.js')
        target = binary if fault not in ('parent-owner', 'parent-write', 'alias-parent-write') else \
            alias_npm.parent if fault == 'alias-parent-write' else binary.parent
        if fault in ('trusted-group', 'caller-owned'):
            for metadata in tree.values():
                if not stat.S_ISLNK(metadata.st_mode):
                    metadata.st_gid = 1000
                    metadata.st_mode |= 0o020
                    if fault == 'caller-owned':metadata.st_uid = 1000
        if fault in ('owner', 'parent-owner'):tree[target].st_uid = 123456
        if fault == 'workload-owner':tree[target].st_uid = 65534
        if fault in ('other-write', 'parent-write', 'alias-parent-write'):tree[target].st_mode |= 0o002
        if fault in ('workload-group', 'unknown-group'):
            tree[target].st_mode |= 0o020
            tree[target].st_gid = 65534 if fault == 'workload-group' else 123456
        if fault == 'link-owner':tree[alias_npm].st_uid = 123456
        if fault == 'link-outside':links[alias_npm] = '/tmp/npm/bin/npm-cli.js'
        if fault == 'link-loop':links[alias_npm] = str(alias_npm)
        if fault == 'dangling':links[alias_npm] = str(prefix / 'missing')
        if fault in ('npm-escape', 'npm-hop-escape'):
            outside = prefix / 'lib/outside.js'
            entry(outside, stat.S_IFREG | 0o644)
            if fault == 'npm-hop-escape':link(outside, cli)
            links[distribution / 'bin/internal.js'] = str(outside)
        if fault == 'intermediate-owner':tree[distribution / 'bin/cli-link.js'].st_uid = 123456
        if fault in ('directory-alias', 'directory-link-owner'):
            link(distribution / 'launcher', 'bin')
            links[alias_npm] = str(distribution / 'launcher/cli-link.js')
            if fault == 'directory-link-owner':tree[distribution / 'launcher'].st_uid = 123456
        if fault == 'special':tree[binary].st_mode = stat.S_IFIFO | 0o644
        def metadata(path):
            inspected.append(path)
            if path not in tree:raise FileNotFoundError(str(path))
            return tree[path]
        def acl(path, name, **kwargs):
            assert name == 'system.posix_acl_access' and kwargs == {'follow_symlinks':False}
            if path == binary and fault == 'acl-write':return b'untrusted ACL'
            raise OSError(errno.EACCES if path == binary and fault == 'acl-error' else errno.ENODATA, 'ACL fixture')
        with patch.object(Path, 'lstat', side_effect=metadata, autospec=True), \
             patch.object(Path, 'rglob', return_value=[path for path in tree if path.is_relative_to(distribution)]), \
             patch.object(Path, 'read_bytes', return_value=b'fixed runtime'), \
             patch.object(fixture.os, 'readlink', side_effect=lambda path:links[path]), \
             patch.object(fixture.os, 'getxattr', side_effect=acl), \
             patch.object(fixture.os, 'getuid', return_value=1000), \
             patch.object(fixture.os, 'getgid', return_value=1000), \
             patch.object(fixture.os, 'getgroups', return_value=[1000, 65534]):
            try:
                result = fixture.runtime_provenance(alias_node, alias_npm)
            except (AssertionError, FileNotFoundError):
                assert fault not in ('', 'trusted-group', 'caller-owned', 'directory-alias'), (layout, fault)
            else:
                assert fault in ('', 'trusted-group', 'caller-owned', 'directory-alias'), (layout, fault)
                assert {alias_node, alias_npm, binary, cli, distribution / 'bin/cli-link.js'} <= set(inspected)
                assert binary.parent in inspected and alias_npm.parent in inspected
                assert len(result['node_sha256']) == 64

# Source rejection must precede all staging, service/proxy construction or fallback.
with patch.object(fixture.os, 'getuid', return_value=1000), \
     patch.object(fixture, 'runtime_provenance', side_effect=AssertionError('untrusted source')), \
     patch.object(fixture, 'load') as loaded, \
     patch.object(fixture.subprocess, 'check_output') as output, \
     patch.object(fixture.subprocess, 'run') as launched:
    try:
        fixture.runtime(repo, node, npm)
    except AssertionError as error:
        assert str(error) == 'untrusted source'
    else:
        raise AssertionError('source rejection ignored')
    loaded.assert_not_called()
    output.assert_not_called()
    launched.assert_not_called()

# Integration launcher reuses service/observer; no direct launch fallback on failure.
registry = fixture.load(repo,'npm-registry-boundary-runtime')
network = fixture.load(repo,'codex-network-boundary')
boundary = fixture.load(repo,'npm-filesystem-boundary-runtime')
for failure in (None,'build','copy','service','evidence','cleanup'):
    staged = Path('/run/npm-filesystem-fixture-abcdefgh')
    calls=[]
    def build(repo, root, node, npm, token):
        if failure=='build':raise AssertionError('build failed')
        (root/'runtime/npm/bin').mkdir(parents=True)
        (root/'project').mkdir()
        (root/'runtime/node').write_bytes(node.read_bytes())
        (root/'runtime/npm/bin/npm-cli.js').write_bytes(npm.read_bytes())
        for name in ('runtime/manifest.json','project/package.json'):(root/name).write_bytes(b'{}')
        return 'fixture-hash'
    def run(command, **kwargs):
        calls.append(command)
        assert kwargs['env']==fixture.ENV
        if (failure=='copy' and 'cp' in command) or (failure=='cleanup' and 'rm' in command):
            raise subprocess.CalledProcessError(1,command)
        return subprocess.CompletedProcess(command,0,'','')
    def service(repo,root,record,observer):
        assert callable(observer) and record['proxy_uid']==1000
        if failure=='service':raise AssertionError('service failed')
        return {'candidate':'wrong' if failure=='evidence' else 'package-lock.json',
                'manifest_hash':'fixture-hash','metadata_requests':1,'tarball_requests':0,
                'markers':[],'node_modules':False}
    with patch.object(fixture,'load',return_value=boundary), \
         patch.object(fixture,'build_root',side_effect=build), \
         patch.object(boundary,'service',side_effect=service), \
         patch.object(fixture.subprocess,'check_output',return_value=str(staged)+'\n'), \
         patch.object(fixture.subprocess,'run',side_effect=run), \
         patch.object(fixture.os,'getuid',return_value=1000), \
         patch.object(Path,'rglob',return_value=[]), \
         patch.object(Path,'read_bytes',return_value=b'{}'), \
         patch.object(Path,'exists',return_value=False), patch('builtins.print'):
        fake_provenance={'node_sha256':hashlib.sha256(b'{}').hexdigest(),
                         'npm_cli_sha256':hashlib.sha256(b'{}').hexdigest()}
        try:
            fixture.run_fixture(repo,node,npm,registry,network,
                SimpleNamespace(address='192.0.2.1',port=12345,accepted=1),12346,fake_provenance)
        except (AssertionError,subprocess.CalledProcessError):
            assert failure is not None
        else:
            assert failure is None
    assert [command[-1] for command in calls if 'rm' in command]==[str(staged)]

# Two success roots plus two unavailable roots; every outer failure cleans proxy/listeners.
from unittest.mock import Mock
for failure in (None, 'start', 'fixture', 'outer-cleanup', 'workspace'):
    commands, runs, servers = [], [], []
    def endpoints(address):
        value = SimpleNamespace(port=12345, accepted=0, close=Mock())
        servers.append(value)
        return value
    def integration(*args):
        runs.append(args)
        if failure == 'fixture':
            raise AssertionError('fixture failed')
        return '/run/root-' + str(len(runs))
    def run(command, **kwargs):
        commands.append(command)
        if failure == 'outer-cleanup' and 'rm' in command:
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, '', '')
    with patch.object(fixture, 'load', side_effect=[registry,network]), \
         patch.object(fixture, 'runtime_provenance', return_value=provenance), \
         patch.object(fixture.os, 'getuid', return_value=1000), \
         patch.object(fixture.subprocess, 'check_output', return_value='/run/npm-registry-fixture-abcdefgh\n'), \
         patch.object(fixture.subprocess, 'run', side_effect=run), \
         patch.object(network, 'local_addresses', return_value={'192.0.2.1'}), \
         patch.object(network, 'tcp', return_value={'result':'connected'}), \
         patch.object(network, 'udp', return_value={'result':'received'}), \
         patch.object(registry, 'snapshot', return_value='host-unchanged'), \
         patch.object(fixture, 'workspace_state', side_effect=['before', 'changed' if failure=='workspace' else 'before']), \
         patch.object(registry, 'Servers', side_effect=endpoints), \
         patch.object(registry, 'start_proxy', side_effect=AssertionError('start failed') if failure=='start' else None,
                      return_value=(Mock(),12346)), \
         patch.object(registry, 'stop_proxy') as stop, \
         patch.object(registry, 'verify_proxy_stopped') as stopped, \
         patch.object(fixture, 'run_fixture', side_effect=integration), \
         patch.object(Path, 'exists', return_value=False), patch('builtins.print'):
        try:
            fixture.runtime(repo,node,npm)
        except (AssertionError,subprocess.CalledProcessError):
            assert failure is not None
        else:
            assert failure is None
    assert len(runs) == (0 if failure=='start' else 1 if failure=='fixture' else 4)
    if len(runs)==4:
        assert [args[-1] is True for args in runs] == [False,True,False,True]
        assert stop.call_count == 4 and stopped.call_count == 4
    assert all(value.close.call_count==1 for value in servers)
    assert [cmd[-1] for cmd in commands if 'rm' in cmd] == ['/run/npm-registry-fixture-abcdefgh']

# Observer failure is propagated by shared filesystem launcher with unit cleanup.
for observer_failure in (False, True):
    observed, commands = [], []
    def observe(unit,done):
        observed.append(unit)
        if observer_failure:raise AssertionError('snapshot unavailable')
    def run(command, **kwargs):
        commands.append(command)
        if '--property=LoadState' in command:return subprocess.CompletedProcess(command,0,'not-found\n','')
        return subprocess.CompletedProcess(command,0,'{"status":"pass"}','')
    with patch.object(boundary,'command',return_value=['isolated-command']), \
         patch.object(boundary.subprocess,'run',side_effect=run):
        try:
            boundary.service(repo,Path('/root'),{'token':token},observer=observe)
        except AssertionError:
            assert observer_failure
        else:
            assert not observer_failure
    assert len(observed)==1
    assert any('stop' in command for command in commands)
    assert any('--property=LoadState' in command for command in commands)

for name in ('npm-registry-lock-runtime.py','npm-registry-lock-probe.js',
             'npm-registry-lock-adapter.js','test-npm-registry-lock.sh'):
    for workflow in (repo/'.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring',str(workflow))
assert 'npm-registry-lock' not in (scripts/'prepare-product-npm.py').read_text()
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo/'.github/workflows/ai-workflow-regression.yml').read_text()
print('registry lock: exact command/manifest snapshot/runtime provenance/adapter fail-closed/isolation/cleanup/dormant mocks passed',flush=True)
if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP registry lock runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('registry lock runtime requires systemd on the regression runner')
    print('SKIP registry lock runtime: systemd is not PID 1')
    sys.exit(0)
fixture.runtime(repo,node,npm)
print('registry lock: official candidate/two fresh runs/proxy unavailable/direct deny/workspace unchanged/cleanup runtime passed')
PY
