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
# Formal runner also validates its pair before the local construction/mock probe.
# PATH tooling is only used for pure/mock work inside the inherited Codex boundary
# or a local environment without systemd; neither is formal runtime evidence.
if 'codex-' not in Path('/proc/self/cgroup').read_text() and \
   Path('/proc/1/comm').read_text().strip() == 'systemd':
    node, npm, _ = fixture.select_runtime()
else:
    node, npm = Path(shutil.which('node')), Path(shutil.which('npm'))
token = 'a' * 32
javascript = r'''
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const [scripts, root, token] = process.argv.slice(1);
function load(name, imports, processOverride=process, timers={setTimeout,clearTimeout}) {
  const m = {exports:{}};
  new Function('require','module','process','setTimeout','clearTimeout',fs.readFileSync(scripts+'/'+name,'utf8'))(
    name => imports[name] || require(name),m,processOverride,timers.setTimeout,timers.clearTimeout);
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
        const body = fault==='body-large'?'x'.repeat(32*1024*1024+1):fault==='body-json'?'invalid':
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
  let fault='', calls=[], workers=0, udpCalls=0, kills=0, stops=0, readinessDelays=[];
  const readinessFaults=['readiness-exit','readiness-kill','readiness-unconfirmed'];
  const timers={setTimeout(callback,delay){
    if([8000,11000,16000,21000,26000,31000].includes(delay))readinessDelays.push(delay);
    if(readinessFaults.includes(fault) && [8000,31000,3000].includes(delay))
      return {immediate:setImmediate(callback)};
    return setTimeout(callback,delay);
  },clearTimeout(timer){if(timer?.immediate)clearImmediate(timer.immediate);else clearTimeout(timer);}};
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
    if(fault==='unknown')throw Error('EXCEPTION_CANARY /private/path ENV_CANARY PACKAGE_CANARY');
    if((config && fault==='config') || (!config && fault==='lock'))return {status:1,signal:null};
    if(!config){
      fs.writeFileSync(project+'/package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/is-number':{
        version:'7.0.0',resolved:'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz'}}}));
      if(fault==='marker')fs.writeFileSync(project+'/markers/executed','executed');
      if(fault==='mutation')fs.writeFileSync(project+'/unexpected','changed');
    }
    return {status:0,signal:null,stdout:config?'true':'{"added":0,"removed":0,"changed":0}'};
  },fork(script,args,options){
    workers++;assert.equal(script,'/runtime/npm-registry-lock-adapter.js');
    assert.deepEqual(args,input.bootstrap===true?['12345',JSON.stringify(input.bootstrap_dependencies)]:['12345']);
    assert.equal(options.execPath,'/runtime/node');assert.deepEqual(options.execArgv,[]);
    assert.deepEqual(options.env,{PATH:'/runtime',HOME:'/project',LC_ALL:'C'});
    const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
    child.kill=signal=>{
      assert.equal(signal,'SIGKILL');assert(readinessFaults.includes(fault));kills++;
      if(fault!=='readiness-unconfirmed')process.nextTick(()=>{
        child.signalCode=signal;child.emit('exit',null,signal);
      });
    };
      child.send=message=>{
      assert.equal(message,'stop');stops++;
      if(['readiness-kill','readiness-unconfirmed'].includes(fault))return;
      process.nextTick(()=>{
        child.emit('message',{metadata:1,denied:fault==='content'?1:0});
        if(fault==='post-generation')fs.appendFileSync(project+'/package-lock.json',' ');
        child.exitCode=['adapter-cleanup','readiness-exit'].includes(fault)?1:0;
        child.emit('exit',child.exitCode,null);
      });
    };
    process.nextTick(()=>{
      if(fault==='unavailable'){child.exitCode=1;child.emit('exit',1,null);}
      else if(!readinessFaults.includes(fault))child.emit('message',{port:23456});
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
      process.nextTick(()=>s.emit('error',Object.assign(Error(),{code:options.host==='127.0.0.1'?(fault==='closed-cleanup'?'EPERM':'ECONNREFUSED'):'EPERM'})));return s;}}},
    {...process,getuid:()=>65534},timers);
  for (fault of ['boundary','runtime-owner','runtime-mode','runtime-writable','manifest',
    'snapshot-owner','snapshot-unit','direct','unavailable','unknown','config','lock','marker','mutation','content','post-generation','adapter-cleanup','closed-cleanup','']) {
    calls=[];workers=udpCalls=0;
    try{
      if(fault)await assert.rejects(probe.probe(input),error=>{
        const expected=fault==='unavailable'?20:['config','lock','marker','mutation','content'].includes(fault)?21:
          fault==='post-generation'?22:['adapter-cleanup','closed-cleanup'].includes(fault)?23:1;
        assert.equal(probe.failureExitCode(error),expected);return true;
      });
      else{const evidence=await probe.probe(input);assert.equal(evidence.candidate,'package-lock.json');
        assert.equal(evidence.lock_hash,crypto.createHash('sha256').update(fs.readFileSync(project+'/package-lock.json')).digest('hex'));
        assert.deepEqual(evidence.command,initial.command('lock',23456));assert.equal(evidence.tarball_requests,0);}
      const early=['boundary','runtime-owner','runtime-mode','runtime-writable','manifest','snapshot-owner','snapshot-unit','direct'];
      assert.equal(workers,early.includes(fault)?0:1);
      assert.equal(calls.length,early.includes(fault)||fault==='unavailable'?0:['config','unknown'].includes(fault)?1:2);
    } finally{
      for(const name of ['package-lock.json','unexpected','markers/executed'])fs.rmSync(project+'/'+name,{force:true});
    }
  }
  for(const error of [Error('EXCEPTION_CANARY'), {code:20}, {code:'20'}, null]) {
    assert.equal(probe.failureExitCode(error),1);
  }
  for(const [count,delay] of [[0,8000],[1,8000],[2,11000],[3,16000],[4,21000],
                            [5,26000],[6,31000],[7,31000],[100,31000]]){
    readinessDelays=[];
    const child=new EventEmitter();
    const ready=probe.workerReady(child,count);
    child.emit('message',{port:23456});
    assert.equal(await ready,23456);assert.deepEqual(readinessDelays,[delay]);
  }
  // Run the real workerReady deadline and stopWorker, with an accelerated clock.
  // IPC stop may be ignored before metadata prefetch registers its handler.
  for(fault of readinessFaults){
    calls=[];kills=stops=0;
    await assert.rejects(probe.probe(input),error=>{
      assert.equal(probe.failureExitCode(error),fault==='readiness-unconfirmed'?23:20);return true;
    });
    assert.equal(calls.length,0,'npm started before metadata readiness');
    assert.equal(stops,1);assert.equal(kills,fault==='readiness-exit'?0:1);
    fs.rmSync(project+'/package-lock.json',{force:true});
  }
  fault='unavailable';calls=[];
  assert.deepEqual(await probe.probe({...input,expect_unavailable:true}),{
    status:'pass',fail_closed:'official-registry-unavailable',npm_started:false});assert.equal(calls.length,0);
  // #691 receives arbitrary exact snapshot bytes, retaining #660 invocation/inventory.
  fault='';calls=[];
  const original=fs.readFileSync(project+'/package.json');
  const changed=Buffer.from(JSON.stringify({...JSON.parse(original),name:'bootstrap-caller'}));
  fs.writeFileSync(project+'/package.json',changed);fs.writeFileSync(root+'/runtime/manifest.json',changed);
  input.bootstrap=true;input.bootstrap_dependencies={'is-number':'7.0.0'};
  input.manifest_hash=crypto.createHash('sha256').update(changed).digest('hex');
  try {
    for(const count of [1,6,7]){
      input.bootstrap_dependencies=Object.fromEntries(Array.from({length:count},(_,i)=>['example-'+i,'1.0.0']));
      const bytes=Buffer.from(JSON.stringify({...JSON.parse(changed),dependencies:input.bootstrap_dependencies}));
      fs.writeFileSync(project+'/package.json',bytes);fs.writeFileSync(root+'/runtime/manifest.json',bytes);
      input.manifest_hash=crypto.createHash('sha256').update(bytes).digest('hex');
      calls=[];readinessDelays=[];
      const evidence=await probe.probe(input);
      assert.equal(evidence.manifest_hash,input.manifest_hash);
      assert.deepEqual(evidence.command,initial.command('lock',23456));
      assert.equal(calls.length,2);assert.equal(evidence.tarball_requests,0);
      assert.deepEqual(readinessDelays,[count===1?8000:31000]);
      fs.rmSync(project+'/package-lock.json',{force:true});
    }
    for(fault of readinessFaults){
      calls=[];readinessDelays=[];kills=stops=0;
      await assert.rejects(probe.probe(input),error=>{
        assert.equal(probe.failureExitCode(error),fault==='readiness-unconfirmed'?23:20);return true;
      });
      assert.deepEqual(readinessDelays,[31000]);assert.equal(calls.length,0);
      assert.equal(stops,1);assert.equal(kills,fault==='readiness-exit'?0:1);
    }
  } finally {
    fs.writeFileSync(project+'/package.json',original);fs.writeFileSync(root+'/runtime/manifest.json',original);
    fs.rmSync(project+'/package-lock.json',{force:true});
  }
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

# Source provenance accepts hosted ancestors such as /opt mode 0777. These
# are trusted setup inputs, never the runtime isolation boundary or a PATH fallback.
prefix = Path('/opt/hostedtoolcache/node/24.2.0/x64')
binary, launcher = prefix / 'bin/node', prefix / 'bin/npm'
distribution = prefix / 'lib/node_modules/npm'
cli = distribution / 'bin/npm-cli.js'
accepted = ('', 'host-writable', 'source-writable', 'multiple')
for fault in (*accepted, 'missing', 'bad-version', 'node-pair', 'npm-pair',
              'npm-name', 'npm-bin', 'npm-version', 'node-version', 'cli-version',
              'version-failure', 'link-outside', 'npm-escape', 'npm-hop-escape',
              'link-loop', 'dangling', 'special', 'hash-read', 'metadata-read'):
    tree, links, inspected, commands = {}, {}, [], []
    def entry(path, mode):
        tree[path] = SimpleNamespace(st_uid=1000, st_gid=1000, st_mode=mode)
        for parent in path.parents:
            tree.setdefault(parent, SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o755))
    def link(path, target):
        entry(path, stat.S_IFLNK | 0o777)
        links[path] = str(target)
    entry(binary, stat.S_IFREG | 0o755)
    entry(cli, stat.S_IFREG | 0o644)
    entry(distribution / 'package.json', stat.S_IFREG | 0o644)
    entry(distribution / 'bin/real.js', stat.S_IFREG | 0o644)
    link(launcher, '../lib/node_modules/npm/bin/npm-cli.js')
    link(distribution / 'bin/internal.js', 'real.js')
    # Unsafe PATH head is not even inspected.
    if fault == 'host-writable':
        tree[Path('/opt')].st_mode |= 0o022
    if fault == 'source-writable':
        for info in tree.values():
            if not stat.S_ISLNK(info.st_mode):info.st_mode |= 0o022
    if fault == 'node-pair':
        link(binary, prefix / 'bin/other-node')
        entry(prefix / 'bin/other-node', stat.S_IFREG | 0o755)
    if fault == 'npm-pair':
        other = prefix / 'other/npm/bin/npm-cli.js'
        entry(other, stat.S_IFREG | 0o644)
        links[launcher] = str(other)
    if fault == 'link-outside':links[launcher] = '/usr/local/bin/npm'
    if fault in ('npm-escape', 'npm-hop-escape'):
        outside = prefix / 'lib/outside.js'
        entry(outside, stat.S_IFREG | 0o644)
        if fault == 'npm-hop-escape':link(outside, cli)
        links[distribution / 'bin/internal.js'] = str(outside)
    if fault == 'link-loop':links[launcher] = str(launcher)
    if fault == 'dangling':links[launcher] = str(prefix / 'missing')
    if fault == 'special':tree[binary].st_mode = stat.S_IFIFO | 0o644
    def metadata(path):
        inspected.append(path)
        if path not in tree:raise FileNotFoundError(str(path))
        return tree[path]
    def contents(path):
        if (fault == 'hash-read' and path == binary) or (fault == 'metadata-read' and path.name == 'package.json'):
            raise PermissionError('source read failed')
        if path.name == 'package.json':
            return json.dumps({'name':'other' if fault=='npm-name' else 'npm',
                'version':'invalid' if fault=='npm-version' else '11.0.0',
                'bin':{'npm':'other.js' if fault=='npm-bin' else 'bin/npm-cli.js'}}).encode()
        return b'fixed runtime'
    def version(command, **kwargs):
        commands.append(command)
        assert kwargs == dict(check=True, capture_output=True, text=True, timeout=10, cwd='/', env=fixture.ENV)
        assert command in ([str(binary),'--version'],[str(binary),str(launcher),'--version'])
        if fault == 'version-failure':raise subprocess.CalledProcessError(1, command)
        output = 'v25.0.0' if fault == 'node-version' else 'v24.2.0' if len(command)==2 else \
            '10.0.0' if fault == 'cli-version' else '11.0.0'
        return subprocess.CompletedProcess(command, 0, output+'\n', '')
    with patch.object(Path, 'lstat', side_effect=metadata, autospec=True), \
         patch.object(Path, 'rglob', return_value=[path for path in tree if path.is_relative_to(distribution)]), \
         patch.object(Path, 'read_bytes', side_effect=contents, autospec=True), \
         patch.object(Path, 'glob', return_value=[] if fault=='missing' else
                      [fixture.TOOLCACHE_ROOT / '24.1.0/x64', prefix] if fault=='multiple' else
                      [fixture.TOOLCACHE_ROOT / '24.invalid/x64'] if fault=='bad-version' else [prefix]), \
         patch.object(fixture.subprocess, 'run', side_effect=version), \
         patch.object(fixture.os, 'environ', {'PATH':'/usr/local/bin'}), \
         patch.object(fixture.os, 'readlink', side_effect=lambda path:links[path]), \
         patch.object(fixture.os, 'getxattr', side_effect=AssertionError('source ACL is not a boundary')):
        try:
            selected_node, selected_npm, result = fixture.select_runtime()
        except (AssertionError, OSError, subprocess.CalledProcessError):
            assert fault not in accepted, fault
        else:
            assert fault in accepted, fault
            assert (selected_node, selected_npm) == (binary, launcher)
            assert result['node_source'] == str(binary) and result['npm_source'] == str(cli)
            assert result['node_version'] == 'v24.2.0' and result['npm_version'] == '11.0.0'
            assert len(result['node_sha256']) == 64
            assert commands == [[str(binary),'--version'],[str(binary),str(launcher),'--version']]
    assert Path('/usr/local/bin') not in inspected
    if fault not in (*accepted, 'node-version', 'cli-version', 'version-failure'):
        assert commands == [], ('unverified source executed', fault)

# Selection uses the same descending path rule as Node hardening, even with
# several installed distributions. A broken selected pair cannot fall back.
newer = fixture.TOOLCACHE_ROOT / '24.3.0/x64'
with patch.object(Path, 'glob', return_value=[prefix, newer]), \
     patch.object(fixture, 'runtime_provenance', side_effect=AssertionError('selected pair invalid')) as selected:
    try:
        fixture.select_runtime()
    except AssertionError as error:
        assert str(error) == 'selected pair invalid'
    else:
        raise AssertionError('broken pair fallback')
    selected.assert_called_once_with(newer / 'bin/node', newer / 'bin/npm', scope=newer)

# Real inherited access/default ACLs survive copy2/copytree and cp -a. Normalize
# only the fresh copy, including writable directories; never follow npm symlinks.
with tempfile.TemporaryDirectory(prefix='registry-acl-test-') as directory:
    source, staged = Path(directory) / 'source', Path(directory) / 'staged'
    (source / 'root/runtime/npm').mkdir(parents=True)
    for name in ('project', 'tmp'):(source / 'root' / name).mkdir()
    targets = [source / 'root/runtime/npm/npmrc', source / 'root/runtime/manifest.json',
               source / 'root/boundary.json', Path(directory) / 'outside']
    for target in targets:target.write_bytes(b'unchanged snapshot')
    # Use the mapped caller UID so this real ACL test also runs in Codex's user namespace.
    subprocess.run(['/usr/bin/setfacl', '-m', f'u:{os.getuid()}:rw-', *map(str, targets)], check=True, env=fixture.ENV)
    directories = [source, *[p for p in source.rglob('*') if p.is_dir()]]
    subprocess.run(['/usr/bin/setfacl', '-m', f'u:{os.getuid()}:rwx,d:u:{os.getuid()}:rwx',
                    *map(str, directories)], check=True, env=fixture.ENV)
    (source / 'root/runtime/npm/internal').symlink_to('npmrc')
    # A malicious external link must not mutate its target during normalization;
    # staged_snapshot separately rejects it before service launch.
    (source / 'root/runtime/npm/external').symlink_to(targets[-1])
    original_acls = {(p, attribute):os.getxattr(p, attribute, follow_symlinks=False)
                     for p in (*directories, *targets)
                     for attribute in ('system.posix_acl_access', 'system.posix_acl_default')
                     if attribute == 'system.posix_acl_access' or p.is_dir()}
    build = Path(directory) / 'build'
    shutil.copytree(source, build, symlinks=True)
    subprocess.run(['/bin/cp', '-a', str(build), str(staged)], check=True, env=fixture.ENV)
    assert os.getxattr(staged / 'root/runtime/npm/npmrc', 'system.posix_acl_access')
    assert os.getxattr(staged / 'root/runtime/npm', 'system.posix_acl_default')
    before = {p:p.read_bytes() for p in staged.rglob('*') if p.is_file() and not p.is_symlink()}
    local_run = subprocess.run
    def normalize(command, **kwargs):
        assert command[:3] == ['sudo', '-n', '/usr/bin/setfacl']
        assert command[-1] == str(staged) and kwargs['check'] and kwargs['env'] == fixture.ENV
        return local_run(command[2:], **kwargs)
    with patch.object(fixture.re, 'fullmatch', return_value=True), \
         patch.object(fixture.subprocess, 'run', side_effect=normalize):
        fixture.normalize_staging_acls(staged)
    for path in (staged, *staged.rglob('*')):
        if not path.is_symlink():fixture.assert_no_acl(path)
    assert all(p.read_bytes() == content for p, content in before.items())
    assert all(os.getxattr(p, attribute, follow_symlinks=False) == content
               for (p, attribute), content in original_acls.items()), 'source/host ACL mutated'
    assert (staged / 'root/runtime/npm/internal').is_symlink()

for path in ('/opt', '/run', '/run/npm-filesystem-fixture-abcdefgh/root'):
    with patch.object(fixture.subprocess, 'run') as command:
        try:fixture.normalize_staging_acls(Path(path))
        except AssertionError:pass
        else:raise AssertionError('ACL removal outside fresh staging allowed')
        command.assert_not_called()

# Real copied tree: only ownership/ACL are modeled because local setup is not
# root. Inject violations on the staged side, including ELF closure and marker.
original = Path.lstat
with tempfile.TemporaryDirectory(prefix='registry-snapshot-test-') as directory:
    root = Path(directory) / 'root'
    digest = fixture.build_root(repo, root, node, npm, token)
    provenance = fixture.runtime_hashes(node, npm)
    faults = ('', 'internal-link', 'parent-owner', 'parent-mode', 'root-mode', 'runtime-owner', 'runtime-mode',
              'marker-owner', 'manifest-owner', 'library-mode', 'acl', 'default-acl', 'project-acl',
              'tmp-default-acl', 'marker-acl', 'manifest-acl', 'acl-error',
              'marker-content', 'manifest-content', 'node-hash', 'cli-hash', 'symlink-escape',
              'link-owner', 'absolute-link', 'link-loop', 'dangling-link', 'special')
    library = next(path for path in root.rglob('*') if path.is_file() and path.parts[len(root.parts)] in ('lib','lib64','usr'))
    baseline = {path:path.read_bytes() for path in (root / 'boundary.json', root / 'runtime/manifest.json',
                root / 'runtime/node', root / 'runtime/npm/bin/npm-cli.js')}
    for fault in faults:
        def info(path):
            actual = original(path)
            writable = path in (root / 'project', root / 'tmp') or path.is_relative_to(root / 'project') or path.is_relative_to(root / 'tmp')
            owner = 65534 if writable else 0
            mode = actual.st_mode & ~0o7022
            if path == root.parent and fault == 'parent-owner' or path == root / 'runtime/node' and fault == 'runtime-owner' or \
               path == root / 'boundary.json' and fault == 'marker-owner' or path == root / 'runtime/manifest.json' and fault == 'manifest-owner' or path == escape and fault == 'link-owner':owner=1000
            if path == root.parent and fault == 'parent-mode' or path == root and fault == 'root-mode' or \
               path == root / 'runtime/npm' and fault == 'runtime-mode' or path == library and fault == 'library-mode':mode |= 0o022
            if path == root / 'runtime/node' and fault == 'special':mode=stat.S_IFIFO | 0o644
            return SimpleNamespace(st_uid=owner, st_gid=owner, st_mode=mode)
        def acl(path, attribute, **kwargs):
            target = {'acl':('runtime/node', 'access'), 'default-acl':('runtime/npm', 'default'),
                      'project-acl':('project', 'access'), 'tmp-default-acl':('tmp', 'default'),
                      'marker-acl':('boundary.json', 'access'), 'manifest-acl':('runtime/manifest.json', 'access')}
            if fault in target and path == root / target[fault][0] and attribute.endswith(target[fault][1]):return b'ACL'
            raise OSError(errno.EACCES if fault == 'acl-error' else errno.ENODATA, 'ACL fixture')
        if fault == 'marker-content':(root / 'boundary.json').write_text('{"token":"wrong"}')
        if fault == 'manifest-content':(root / 'runtime/manifest.json').write_bytes(b'{}')
        if fault == 'node-hash':(root / 'runtime/node').write_bytes(b'changed')
        if fault == 'cli-hash':(root / 'runtime/npm/bin/npm-cli.js').write_bytes(b'changed')
        escape = root / 'runtime/npm/escape'
        link_faults = {'internal-link':'bin/npm-cli.js', 'link-owner':'bin/npm-cli.js',
                       'absolute-link':str(root / 'runtime/npm/bin/npm-cli.js'),
                       'link-loop':'escape', 'dangling-link':'missing', 'symlink-escape':'../../project'}
        if fault in link_faults:escape.symlink_to(link_faults[fault])
        try:
            with patch.object(fixture.re, 'fullmatch', return_value=True), \
                 patch.object(Path, 'lstat', side_effect=info, autospec=True), \
                 patch.object(fixture.os, 'getxattr', side_effect=acl):
                try:
                    hashes = fixture.staged_snapshot(root, token, digest, provenance)
                except (AssertionError, OSError):
                    assert fault not in ('', 'internal-link'), ('valid staged snapshot rejected', fault)
                else:
                    assert fault in ('', 'internal-link'), ('unsafe staged snapshot accepted', fault)
                    assert hashes == provenance
        finally:
            if fault in link_faults:escape.unlink()
            changed = {'marker-content':'boundary.json', 'manifest-content':'runtime/manifest.json',
                       'node-hash':'runtime/node', 'cli-hash':'runtime/npm/bin/npm-cli.js'}
            if fault in changed:
                target = root / changed[fault]
                target.write_bytes(baseline[target])

# Source rejection must precede all staging, service/proxy construction or fallback.
with patch.object(fixture.os, 'getuid', return_value=1000), \
     patch.object(fixture, 'select_runtime', side_effect=AssertionError('untrusted source')), \
     patch.object(fixture, 'load') as loaded, \
     patch.object(fixture.subprocess, 'check_output') as output, \
     patch.object(fixture.subprocess, 'run') as launched:
    try:
        fixture.runtime(repo)
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
for failure in (None,'build','build-hash','copy','acl-removal','acl-tooling','snapshot','post-hash','service','evidence','validation','handoff','cleanup'):
    staged = Path('/run/npm-filesystem-fixture-abcdefgh')
    calls=[]
    snapshots=[]
    def snapshot(root, token, digest, provenance):
        snapshots.append(root)
        assert any('chown' in command for command in calls), 'snapshot before ownership establishment'
        assert any('/usr/bin/setfacl' in command for command in calls), 'snapshot before ACL normalization'
        if failure=='snapshot' or failure=='post-hash' and len(snapshots)==2:
            raise AssertionError('snapshot mismatch')
        return provenance
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
        if '/usr/bin/setfacl' in command:
            assert command[-1] == str(staged), 'ACL normalization touched host source'
            if failure=='acl-removal':raise subprocess.CalledProcessError(1,command)
            if failure=='acl-tooling':raise FileNotFoundError('setfacl unavailable')
        return subprocess.CompletedProcess(command,0,'','')
    def service(repo,root,record,observer):
        assert len(snapshots) == 1, 'service before snapshot verification'
        assert callable(observer) and record['proxy_uid']==1000
        if failure=='service':raise AssertionError('service failed')
        return {'candidate':'wrong' if failure=='evidence' else 'package-lock.json',
                'manifest_hash':'fixture-hash','metadata_requests':1,'tarball_requests':0,
                'markers':[],'node_modules':False}
    def freeze_result(repo, root, run_root, manifest, trusted, evidence):
        assert len(snapshots) == 2, 'freeze before post-service snapshot'
        assert manifest == b'{}' and trusted['manifest_sha256'] == 'fixture-hash'
        assert trusted['generation_root'] == str(staged) and trusted['run_id'] == run_root.name
        if failure == 'validation':raise AssertionError('candidate rejected')
        return run_root / 'validated-lock-fixture', {'status':'validated'}
    def accept(helper, artifact, expected):
        assert any('rm' in command for command in calls), 'handoff before generation cleanup'
        if failure == 'handoff':raise AssertionError('handoff mutated')
        return expected
    with patch.object(fixture,'load',return_value=boundary), \
         patch.object(fixture,'contract_identities',return_value={}), \
         patch.object(fixture,'freeze_candidate',side_effect=freeze_result) as freeze, \
         patch.object(fixture,'verify_handoff',side_effect=accept) as handoff, \
         patch.object(fixture,'build_root',side_effect=build), \
         patch.object(fixture,'staged_snapshot',side_effect=snapshot), \
         patch.object(boundary,'service',side_effect=service) as service_call, \
         patch.object(fixture.subprocess,'check_output',return_value=str(staged)+'\n'), \
         patch.object(fixture.subprocess,'run',side_effect=run), \
         patch.object(fixture.os,'getuid',return_value=1000), \
         patch.object(Path,'rglob',return_value=[]), \
         patch.object(Path,'read_bytes',return_value=b'{}'), \
         patch.object(Path,'exists',return_value=False), patch('builtins.print'):
        fake_provenance={'node_sha256':hashlib.sha256(b'{}').hexdigest(),
                         'npm_cli_sha256':hashlib.sha256(b'{}').hexdigest()}
        if failure=='build-hash':fake_provenance['node_sha256']='wrong'
        try:
            fixture.run_fixture(repo,node,npm,registry,network,
                SimpleNamespace(address='192.0.2.1',port=12345,accepted=1),12346,fake_provenance)
        except (AssertionError,OSError,subprocess.CalledProcessError):
            assert failure is not None
        else:
            assert failure is None
    if failure=='build-hash':assert not any('cp' in command for command in calls)
    assert service_call.call_count == (0 if failure in ('build','build-hash','copy','acl-removal','acl-tooling','snapshot') else 1)
    assert freeze.call_count == (1 if failure in (None,'validation','handoff','cleanup') else 0)
    assert handoff.call_count == (1 if failure in (None,'handoff') else 0)
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
         patch.object(fixture, 'select_runtime', return_value=(node,npm,provenance)), \
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
            fixture.runtime(repo)
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
    with patch.object(boundary,'command',return_value=['isolated-command']) as command_factory, \
         patch.object(boundary.subprocess,'run',side_effect=run):
        try:
            boundary.service(repo,Path('/root'),{'token':token},observer=observe,
                             command_factory=command_factory)
        except AssertionError:
            assert observer_failure
        else:
            assert not observer_failure
    assert len(observed)==1
    command_factory.assert_called_once_with(repo,Path('/root'),observed[0],{'token':token,'unit':observed[0]})
    assert commands[0]==['isolated-command']
    assert any('stop' in command for command in commands)
    assert any('--property=LoadState' in command for command in commands)

for name in ('npm-registry-lock-runtime.py','npm-registry-lock-probe.js',
             'npm-registry-lock-adapter.js','test-npm-registry-lock.sh'):
    for workflow in (repo/'.github/workflows').glob('*.yml'):
        assert name not in workflow.read_text(), ('production wiring',str(workflow))
assert 'npm-registry-lock' not in (scripts/'prepare-product-npm.py').read_text()
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo/'.github/workflows/ai-workflow-regression.yml').read_text()

# Only the exact shared-service nonzero shape and finite codes are admitted.
for code, reason in fixture.PROBE_EXIT_REASONS.items():
    assert fixture.service_failure_reason(AssertionError((code, 'STDOUT_CANARY', 'STDERR_CANARY'))) == reason
for error in (RuntimeError('EXCEPTION_CANARY'), AssertionError((1, 'canary', 'canary')),
              AssertionError(('20', 'canary', 'canary')), AssertionError((True, '', '')),
              AssertionError((20, {}, [])), AssertionError((20, '', '', 'extra')),
              AssertionError({'reason': 'metadata_prefetch'}), AssertionError('metadata_prefetch')):
    assert fixture.service_failure_reason(error) == 'internal'
assert fixture.service_failure_reason(AssertionError(('unit cleanup unconfirmed', 'canary', 'canary'))) == 'generation_cleanup'
assert fixture.service_failure_reason(AssertionError('property observer cleanup failed')) == 'generation_cleanup'
# Malformed CLI JSON and preflight exceptions do not emit raw traceback/streams.
cli = r"""
const fs=require('node:fs'), m={exports:{}}, fakeProcess={argv:['node','probe','EXCEPTION_CANARY']};
const loader=name=>['./filesystem-probe.js','./initial-lock-probe.js'].includes(name)?{}:require(name);
loader.main=m;
new Function('require','module','process',fs.readFileSync(process.argv[1],'utf8'))(loader,m,fakeProcess);
setImmediate(()=>{require('node:assert/strict').equal(fakeProcess.exitCode,1);});
"""
result = subprocess.run([str(node), '-e', cli, str(scripts / 'npm-registry-lock-probe.js')],
                        capture_output=True, env=fixture.ENV)
assert result.returncode == 0 and result.stdout == result.stderr == b''

# Exercise the actual unchanged #654 service rejection and cleanup precedence.
for code in (*fixture.PROBE_EXIT_REASONS, 1, 99):
    for cleanup_failure in (False, True):
        commands = []
        def rejected_service(command, **kwargs):
            commands.append(command)
            if '--property=LoadState' in command:
                return subprocess.CompletedProcess(command, 0, 'loaded' if cleanup_failure else 'not-found', 'CLEANUP_CANARY')
            return subprocess.CompletedProcess(command, code, 'STDOUT_CANARY /private/path', 'STDERR_CANARY PACKAGE_CANARY')
        with patch.object(boundary, 'command', return_value=['isolated-command']), \
             patch.object(boundary.subprocess, 'run', side_effect=rejected_service):
            try:
                boundary.service(repo, Path('/root'), {'token': token})
            except AssertionError as error:
                assert fixture.service_failure_reason(error) == ('generation_cleanup' if cleanup_failure
                    else fixture.PROBE_EXIT_REASONS.get(code, 'internal'))
            else:
                raise AssertionError('nonzero service accepted')
        assert any('stop' in command for command in commands)
        assert any('--property=LoadState' in command for command in commands)

# #662 trusted validation is local-only, including the real #660 constructor.
# Retain expectations in parent memory, not in files a workload can edit.
import base64
import copy
validator = fixture.load(repo, 'prepare-product-npm')
command = fixture.initial_command(repo, node, 23456)
fixture.command_contract(repo, node, command)
for unsafe in (command + ['--ignore-scripts=false'], command[:-1],
               [arg for arg in command if arg != '--ignore-scripts']):
    try:fixture.command_contract(repo, node, unsafe)
    except AssertionError:pass
    else:raise AssertionError('unknown command accepted')

def fail_closed(operation):
    try:operation()
    except (validator.Rejected, AssertionError, OSError, KeyError, TypeError, ValueError):return
    raise AssertionError('invalid generated lock/handoff accepted')

with tempfile.TemporaryDirectory(prefix='generated-lock-test-') as directory:
    base = Path(directory)
    root, run_root = base / 'generation/root', base / 'trusted-run'
    (root / 'runtime').mkdir(parents=True)
    (root / 'project/cache').mkdir(parents=True)
    (root / 'project/cache/temporary').write_bytes(b'never handed off')
    (root / 'project/node_modules').mkdir()
    run_root.mkdir(mode=0o700)
    manifest = {'name':'registry-lock-project', 'version':'1.0.0',
                'dependencies':{'is-number':'7.0.0'}}
    snapshot = json.dumps(manifest, sort_keys=True).encode()
    lock = {'name':manifest['name'], 'version':manifest['version'], 'lockfileVersion':3,
            'packages':{'':manifest, 'node_modules/is-number':{'version':'7.0.0',
                'resolved':'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
                'integrity':'sha512-' + base64.b64encode(bytes(64)).decode()}}}
    lock_bytes = json.dumps(lock, sort_keys=True).encode()
    runtime = {'node_source':str(node), 'npm_source':str(npm),
               'node_version':'v24.2.0', 'npm_version':'11.0.0',
               'node_sha256':'1'*64, 'npm_cli_sha256':'2'*64}
    trusted = {'manifest_sha256':hashlib.sha256(snapshot).hexdigest(), 'runtime_source':runtime,
               'staged_runtime_hashes':{key:runtime[key] for key in ('node_sha256','npm_cli_sha256')},
               'generation_id':'a'*32, 'generation_root':str(root.parent),
               'run_id':run_root.name, 'contracts':fixture.contract_identities(repo)}
    evidence = {'status':'pass', 'candidate':'package-lock.json',
                'manifest_hash':trusted['manifest_sha256'], 'lock_hash':hashlib.sha256(lock_bytes).hexdigest(),
                'node':runtime['node_version'], 'npm':runtime['npm_version'], 'command':command,
                'markers':[], 'node_modules':False, 'metadata_requests':1, 'tarball_requests':0,
                'dependency_execution_path':'not-entered'}
    manifest_path = root / 'runtime/manifest.json'
    candidate = root / 'project/package-lock.json'
    def restore():
        manifest_path.write_bytes(snapshot)
        (root / 'project/package.json').write_bytes(snapshot)
        if candidate.is_symlink():candidate.unlink()
        candidate.write_bytes(lock_bytes)
    def freeze(value=trusted, claims=evidence):
        # Same canonical module instance lets faults target validation itself.
        with patch.object(fixture, 'load', return_value=validator):
            return fixture.freeze_candidate(repo, root, run_root, snapshot, value, claims)
    restore()
    workspace = fixture.workspace_state(repo)
    with patch.object(fixture.os, 'getuid', return_value=fixture.SERVICE_UID):
        fail_closed(freeze)
    run_root.chmod(0o777)
    fail_closed(freeze)
    run_root.chmod(0o700)
    first, expected = freeze()
    validator.validate_lock(validator.parse((first/'package.json').read_bytes()),
                            validator.parse((first/'package-lock.json').read_bytes()))
    assert fixture.verify_handoff(validator, first, expected) == expected
    assert sorted(path.name for path in first.iterdir()) == ['package-lock.json','package.json','provenance.json']
    second, repeated = freeze()
    assert first != second and expected['artifact_id'] != repeated['artifact_id']
    for key in ('manifest_sha256','lock_sha256','generated_lock_sha256','contracts','bootstrap_command'):
        assert expected[key] == repeated[key], ('unstable contract',key)
    other_run = base / 'other-trusted-run'
    other_run.mkdir(mode=0o700)
    another = {**trusted, 'run_id':other_run.name, 'generation_id':'b'*32}
    with patch.object(fixture, 'load', return_value=validator):
        third, other = fixture.freeze_candidate(repo, root, other_run, snapshot, another, evidence)
    assert other['run_id'] != expected['run_id'] and other['generation_id'] != expected['generation_id']
    assert other['lock_sha256'] == expected['lock_sha256']
    for key in trusted:
        incomplete = copy.deepcopy(trusted)
        incomplete.pop(key)
        fail_closed(lambda:freeze(incomplete))
    for key in evidence:
        incomplete = copy.deepcopy(evidence)
        incomplete.pop(key)
        fail_closed(lambda:freeze(claims=incomplete))
    for key in trusted['contracts']:
        unknown = copy.deepcopy(trusted)
        unknown['contracts'][key]['sha256'] = '0'*64
        fail_closed(lambda:freeze(unknown))
    for field in ('node_sha256','npm_cli_sha256'):
        unknown = copy.deepcopy(trusted)
        unknown['staged_runtime_hashes'][field] = '0'*64
        fail_closed(lambda:freeze(unknown))
    for field in ('manifest_hash','lock_hash','node','npm','dependency_execution_path'):
        fail_closed(lambda:freeze(claims={**evidence, field:'wrong'}))
    for payload in (b'{broken', b'[]', b'{"packages":{},"packages":{}}'):
        candidate.write_bytes(payload)
        fail_closed(lambda:freeze(claims={**evidence,'lock_hash':hashlib.sha256(payload).hexdigest()}))
    for mutate in (
        lambda value:value.update(name='mismatch'),
        lambda value:value['packages'][''].update(name='root-mismatch'),
        lambda value:value['packages']['node_modules/is-number'].update(version='8.0.0'),
        lambda value:value['packages']['node_modules/is-number'].update(resolved='file:/tmp/package.tgz'),
        lambda value:value['packages']['node_modules/is-number'].update(resolved='https://example.invalid/package.tgz'),
        lambda value:value['packages']['node_modules/is-number'].pop('integrity'),
        lambda value:value['packages']['node_modules/is-number'].update(integrity='sha512-invalid'),
    ):
        changed = copy.deepcopy(lock)
        mutate(changed)
        payload = json.dumps(changed).encode()
        candidate.write_bytes(payload)
        fail_closed(lambda:freeze(claims={**evidence,'lock_hash':hashlib.sha256(payload).hexdigest()}))
    restore()
    # Generation claim alone cannot authorize changed bytes, even valid JSON.
    candidate.write_bytes(lock_bytes + b' ')
    fail_closed(freeze)
    restore()
    manifest_path.write_bytes(snapshot + b' ')
    fail_closed(freeze)
    restore()
    (root/'project/package.json').write_bytes(b'{}')
    fail_closed(freeze)
    restore()
    candidate.unlink()
    candidate.symlink_to(first/'package-lock.json')
    fail_closed(freeze)
    restore()
    original_validation = validator.validate_lock
    def mutate_during_validation(manifest_value, lock_value):
        original_validation(manifest_value, lock_value)
        candidate.write_bytes(lock_bytes + b' ')
    with patch.object(validator, 'validate_lock', side_effect=mutate_during_validation):
        fail_closed(freeze)
    restore()
    before = set(run_root.iterdir())
    def fail_after_output(helper, artifact, record):
        candidate.write_bytes(lock_bytes + b' ')
        return record
    with patch.object(fixture, 'verify_handoff', side_effect=fail_after_output):
        fail_closed(freeze)
    assert set(run_root.iterdir()) == before, 'failed freeze left artifact'
    restore()
    # Provenance is compared with the trusted record, including every identity.
    provenance_file = first/'provenance.json'
    def rewrite(path, data):
        path.chmod(0o600)
        path.write_bytes(data)
        path.chmod(0o400)
    for field in expected:
        changed = copy.deepcopy(expected)
        changed.pop(field)
        rewrite(provenance_file, json.dumps(changed).encode())
        fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    for field in ('manifest_sha256','lock_sha256','generated_lock_sha256','artifact_path','run_id','generation_id','validation','status'):
        rewrite(provenance_file, json.dumps({**expected, field:'wrong'}).encode())
        fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    for key in expected['contracts']:
        changed = copy.deepcopy(expected)
        changed['contracts'][key]['sha256'] = '0'*64
        rewrite(provenance_file, json.dumps(changed).encode())
        fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    rewrite(provenance_file, json.dumps(expected).encode())
    rewrite(first/'package-lock.json', lock_bytes + b' ')
    fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    changed_hash = hashlib.sha256(lock_bytes + b' ').hexdigest()
    rewrite(provenance_file, json.dumps({**expected, 'lock_sha256':changed_hash,
                                       'generated_lock_sha256':changed_hash}).encode())
    fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    rewrite(provenance_file, json.dumps(expected).encode())
    rewrite(first/'package-lock.json', lock_bytes)
    first.chmod(0o777)
    fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    first.chmod(0o700)
    (first/'node_modules').mkdir()
    fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    (first/'node_modules').rmdir()
    def handoff_mutation(manifest_value, lock_value):
        original_validation(manifest_value, lock_value)
        rewrite(first/'package-lock.json', lock_bytes + b' ')
    with patch.object(validator, 'validate_lock', side_effect=handoff_mutation):
        fail_closed(lambda:fixture.verify_handoff(validator, first, expected))
    rewrite(first/'package-lock.json', lock_bytes)
    # Generation artifacts are gone; only validated snapshots/provenance survive.
    shutil.rmtree(root.parent)
    assert fixture.verify_handoff(validator, first, expected) == expected
    assert fixture.workspace_state(repo) == workspace, 'validation wrote workspace'
assert not base.exists(), 'trusted fixture cleanup failed'
print('generated lock: canonical validation/freeze/mutation/provenance/only snapshots/repeat/workspace/cleanup passed', flush=True)
print('registry lock: exact command/manifest snapshot/runtime provenance/adapter fail-closed/isolation/cleanup/dormant mocks passed',flush=True)
if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP registry lock runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('registry lock runtime requires systemd on the regression runner')
    print('SKIP registry lock runtime: systemd is not PID 1')
    sys.exit(0)
fixture.runtime(repo)
print('registry lock: official candidate/two fresh runs/proxy unavailable/direct deny/workspace unchanged/cleanup runtime passed')
PY
