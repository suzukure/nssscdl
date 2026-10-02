#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import base64
from contextlib import ExitStack
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch, Mock

repo = Path(sys.argv[1]).resolve()
scripts = repo / '.github/scripts'
spec = importlib.util.spec_from_file_location('bootstrap_orchestrator', scripts / 'product-npm-orchestrator.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
runtime = helper.load('npm-registry-lock-runtime')
validator = helper.validator
node, npm = Path(shutil.which('node')), Path(shutil.which('npm'))
registry = runtime.load(repo, 'npm-registry-boundary-runtime')
network = runtime.load(repo, 'codex-network-boundary')
boundary = runtime.load(repo, 'npm-filesystem-boundary-runtime')
manifest = {'name': 'bootstrap-fixture', 'version': '1.0.0', 'dependencies': {'example': '1.2.3'}}
lock = {'name': manifest['name'], 'version': manifest['version'], 'lockfileVersion': 3,
        'packages': {'': manifest, 'node_modules/example': {'version': '1.2.3',
            'resolved': validator.REGISTRY + 'example/-/example-1.2.3.tgz',
            'integrity': 'sha512-' + base64.b64encode(bytes(64)).decode()}}}
# Exercise the new metadata route using the existing TLS/CONNECT implementation,
# with mocked sockets only. No external service is contacted.
javascript = r"""
const fs=require('node:fs'), assert=require('node:assert/strict'), {EventEmitter}=require('node:events');
const path=process.argv[1];
let calls=[];
const socket={destroy(){}};
const http={request(options){
  calls.push(options);const req=new EventEmitter();req.destroy=()=>{};
  req.end=()=>process.nextTick(()=>req.emit('connect',{statusCode:200},socket,Buffer.alloc(0)));
  return req;
}};
let payload, failure;
const https={Agent:class{destroy(){}},get(options,callback){
  calls.push(options);assert.equal(options.hostname,'registry.npmjs.org');
  assert.equal(options.headers.Accept,'application/vnd.npm.install-v1+json');
  assert.equal(options.agent.createConnection(),socket);
  const req=new EventEmitter();req.destroy=()=>{};
  process.nextTick(()=>{
    const response=new EventEmitter();response.statusCode=failure==='redirect'?302:200;
    callback(response);response.emit('data',Buffer.from(JSON.stringify(payload)));response.emit('end');
  });return req;
}};
const tls={connect(options){assert.deepEqual(options,{socket,servername:'registry.npmjs.org',rejectUnauthorized:true});return socket;}};
const m={exports:{}};
new Function('require','module',fs.readFileSync(path,'utf8'))(
  name=>({'node:http':http,'node:https':https,'node:tls':tls}[name]||require(name)),m);
const adapter=m.exports;
(async()=>{
  for(const name of ['example','@scope/example']){
    payload={name,versions:{'1.2.3':{name,version:'1.2.3',dist:{fixture:'unaltered'}}}};
    calls=[];assert.deepEqual(await adapter.metadata(12345,name),payload);
    assert.equal(calls.length,2);assert.equal(calls[0].path,'registry.npmjs.org:443');
    assert.equal(calls[1].path,adapter.metadataPath(name));
    const counts={metadata:0,denied:0};
    const handler=adapter.metadataHandler(12345,new Map([[name,payload]]),counts);
    for(const [method,url,status] of [['GET',adapter.metadataPath(name),200],['POST','/'+name,403],
      ['GET','/example/-/example-1.2.3.tgz',403],['GET','/example?token=x',403],
      ['GET','/../example',403],['GET','http://example.invalid/',403],['GET','/%65xample',403]]){
      await handler({method,url},{writeHead(code){assert.equal(code,status);},end(body){
        if(status===200)assert.deepEqual(JSON.parse(body),payload);
      }});
    }
    assert.deepEqual(counts,{metadata:1,denied:6});
    const cold=adapter.metadataHandler(12345,new Map(),counts);
    await cold({method:'GET',url:adapter.metadataPath(name)},{writeHead(code){assert.equal(code,200);},end(body){assert.deepEqual(JSON.parse(body),payload);}});
    payload={name:'other',versions:{}};
    await assert.rejects(adapter.metadata(12345,name),/official-registry-unavailable/);
    payload={name,versions:[]};
    await assert.rejects(adapter.metadata(12345,name),/official-registry-unavailable/);
    failure='redirect';await assert.rejects(adapter.metadata(12345,name),/official-registry-unavailable/);failure=null;
  }
  for(const name of ['../x','https://example.invalid','example/-/x.tgz','@scope/example/extra','x?token=y']){
    assert.throws(()=>adapter.metadata(12345,name));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
"""
subprocess.run([str(node), '-e', javascript, str(scripts / 'npm-registry-lock-adapter.js')],
               check=True, timeout=15, env=runtime.ENV)
command = runtime.initial_command(repo, node, 23456)
hashes = {key: hashlib.sha256(b'runtime').hexdigest() for key in ('node_sha256', 'npm_cli_sha256')}
provenance = {**hashes, 'node_source': str(node), 'npm_source': str(npm),
              'node_version': 'v24.0.0', 'npm_version': '11.0.0'}


def rejected(call):
    try:
        call()
    except (validator.Rejected, OSError, AssertionError, KeyError, TypeError, ValueError):
        return
    raise AssertionError('unsafe bootstrap accepted')


with tempfile.TemporaryDirectory(prefix='bootstrap-test-') as temporary:
    base = Path(temporary)
    workspace, trusted = base / 'workspace', base / 'trusted'
    workspace.mkdir()
    trusted.mkdir(mode=0o700)
    snapshot = json.dumps(manifest, indent=2).encode() + b'\n'
    (workspace / 'package.json').write_bytes(snapshot)
    before = helper.read_pair(workspace)
    events, roots = [], []
    fault = None
    service_stopped = False
    generation = None
    pattern = runtime.re.fullmatch
    real_rmtree = shutil.rmtree

    def select():
        if fault == 'runtime-source':
            raise AssertionError('runtime unavailable')
        return node, npm, copy.deepcopy(provenance)

    def cleanup(path, *args, **kwargs):
        if fault == 'output-cleanup' and Path(path).name.startswith('bootstrap-run-'):
            raise OSError('trusted output cleanup failed')
        return real_rmtree(path, *args, **kwargs)

    def output(command, **kwargs):
        prefix = 'generation-' if 'filesystem' in command[-1] else 'proxy-'
        path = Path(tempfile.mkdtemp(prefix=prefix, dir=base))
        roots.append(path)
        return str(path) + '\n'

    def run(command, **kwargs):
        events.append(command)
        assert kwargs['env'] == runtime.ENV
        if 'cp' in command:
            shutil.copytree(command[-2], command[-1])
        if 'rm' in command:
            if fault == 'generation-cleanup' and Path(command[-1]).name.startswith('generation-'):
                raise OSError('cleanup failed')
            if fault == 'proxy-cleanup' and Path(command[-1]).name.startswith('proxy-'):
                raise OSError('cleanup failed')
            real_rmtree(command[-1])
        return subprocess.CompletedProcess(command, 0, '', '')

    def build(repo, root, node, npm, token, exact):
        assert exact == snapshot or exact == b'{"name":"empty","version":"1.0.0"}'
        events.append('build')
        (root / 'runtime/npm/bin').mkdir(parents=True)
        (root / 'project').mkdir()
        (root / 'tmp').mkdir()
        (root / 'runtime/node').write_bytes(b'runtime')
        (root / 'runtime/npm/bin/npm-cli.js').write_bytes(b'runtime')
        for name in ('runtime/manifest.json', 'project/package.json'):
            (root / name).write_bytes(exact)
        return hashlib.sha256(exact).hexdigest()

    def staged(root, token, digest, source):
        events.append('post-snapshot' if service_stopped else 'pre-snapshot')
        if fault == 'post-snapshot' and service_stopped:
            raise AssertionError('runtime mutated')
        assert hashlib.sha256((root / 'runtime/manifest.json').read_bytes()).hexdigest() == digest
        return dict(hashes)

    def service(repo, root, record, observer):
        global service_stopped, generation
        events.append('service')
        assert events[-2] == 'pre-snapshot' and callable(observer)
        assert record['bootstrap'] is True
        assert record['bootstrap_dependencies'] == validator.manifest_dependencies(
            validator.parse((root / 'runtime/manifest.json').read_bytes()))
        generation = root.parent
        if fault in ('unavailable', 'generation'):
            raise AssertionError('generation failed')
        if fault == 'unavailable-claim':
            return {'status': 'pass', 'fail_closed': 'official-registry-unavailable', 'npm_started': False}
        value = copy.deepcopy(lock)
        if not record['bootstrap_dependencies']:
            value = {'name': 'empty', 'version': '1.0.0', 'lockfileVersion': 3,
                     'packages': {'': {'name': 'empty', 'version': '1.0.0'}}}
        if fault == 'source':
            value['packages']['node_modules/example']['resolved'] = 'https://example.invalid/archive.tgz'
        if fault == 'integrity':
            value['packages']['node_modules/example']['integrity'] = 'sha512-invalid'
        payload = b'{broken' if fault == 'malformed' else json.dumps(value, sort_keys=True).encode()
        candidate = root / 'project/package-lock.json'
        candidate.write_bytes(payload)
        evidence = {'status': 'pass', 'candidate': 'package-lock.json', 'manifest_hash': record['manifest_hash'],
                    'lock_hash': hashlib.sha256(payload).hexdigest(), 'command': command,
                    'node': provenance['node_version'], 'npm': provenance['npm_version'], 'markers': [],
                    'node_modules': False, 'metadata_requests': int(bool(record['bootstrap_dependencies'])),
                    'tarball_requests': 0, 'dependency_execution_path': 'not-entered'}
        if fault == 'mutation':
            candidate.write_bytes(payload + b' ')
        if fault == 'manifest':
            (root / 'runtime/manifest.json').write_bytes(b'{}')
        if fault == 'runtime':
            evidence['npm'] = 'unknown'
        if fault == 'workspace':
            (workspace / 'package.json').write_bytes(snapshot + b' ')
        service_stopped = True  # Models #654 service's mandatory stop/collect before return.
        return evidence

    original_freeze = runtime.freeze_candidate

    def freeze(*args):
        assert service_stopped and events[-1] == 'post-snapshot'
        events.append('freeze')
        if fault == 'trusted-manifest':
            args = (*args[:4], {**args[4], 'manifest_sha256': '0' * 64}, args[5])
        return original_freeze(*args)

    def module(name):
        return runtime if name == 'npm-registry-lock-runtime' else helper_load(name)

    helper_load = helper.load
    runtime_load = runtime.load

    def dependencies(repo, name):
        return {'npm-registry-boundary-runtime': registry, 'codex-network-boundary': network,
                'npm-filesystem-boundary-runtime': boundary, 'prepare-product-npm': validator}.get(name) or runtime_load(repo, name)

    def attempt():
        with helper.prepare(workspace, trusted, Path('unused'), Path('unused')) as input_handle:
            with helper.bootstrap(input_handle, trusted) as handoff:
                assert generation is not None and not generation.exists(), 'generation root still exists'
                assert all(not path.exists() for path in roots), 'proxy/generation cleanup incomplete'
                record = handoff.verify()
                artifact = Path(record['artifact_path'])
                assert (artifact / 'package.json').read_bytes() == helper.read_pair(workspace)[0]
                assert record['generated_lock_sha256'] == record['lock_sha256']
                assert sorted(p.name for p in artifact.iterdir()) == ['package-lock.json', 'package.json', 'provenance.json']
                assert handoff.verify()['status'] == 'validated'
                return record

    with ExitStack() as stack:
        for context in (patch.object(helper, 'load', side_effect=module),
          patch.object(runtime, 'load', side_effect=dependencies),
          patch.object(runtime, 'select_runtime', side_effect=select),
          patch.object(runtime, 'workspace_state', return_value='repository unchanged'),
          patch.object(helper.tempfile, '_rmtree', side_effect=cleanup),
          patch.object(runtime, 'build_root', side_effect=build),
          patch.object(runtime, 'staged_snapshot', side_effect=staged),
          patch.object(runtime, 'normalize_staging_acls'),
          patch.object(runtime, 'freeze_candidate', side_effect=freeze),
          patch.object(runtime.subprocess, 'check_output', side_effect=output),
          patch.object(runtime.subprocess, 'run', side_effect=run),
          patch.object(runtime.re, 'fullmatch', side_effect=lambda regex, value:
                       True if regex.startswith('/run/npm-') else pattern(regex, value)),
          patch.object(network, 'local_addresses', return_value={'192.0.2.1'}),
          patch.object(network, 'tcp', return_value={'result': 'connected'}),
          patch.object(network, 'udp', return_value={'result': 'received'}),
          patch.object(registry, 'snapshot', return_value='host unchanged'),
          patch.object(registry, 'Servers', side_effect=lambda address: SimpleNamespace(port=12345, accepted=0, close=Mock())),
          patch.object(registry, 'start_proxy', return_value=(Mock(), 12346)),
          patch.object(registry, 'stop_proxy', side_effect=lambda proxy:
                       (_ for _ in ()).throw(OSError('proxy cleanup failed')) if fault == 'proxy-stop' else None),
          patch.object(registry, 'verify_proxy_stopped'),
          patch.object(boundary, 'service', side_effect=service),
          patch.object(helper.locked, 'prepare', side_effect=AssertionError('locked preparation entered')),
          patch.object(helper, 'offline_ready', side_effect=AssertionError('offline preparation entered')),
          patch.dict(os.environ, {'NPM_TOKEN': 'fixture-secret', 'NODE_OPTIONS': 'fixture-secret'}),
          patch('builtins.print')):
            stack.enter_context(context)
        # Command verification must evaluate the real #660 constructor, despite mocked setup commands.
        with patch.object(runtime, 'command_contract', side_effect=lambda repo, selected, value:
                          validator.require(value == command and selected == node, 'bootstrap command mismatch')):
            first = attempt()
            service_stopped = False
            second = attempt()
            for field in ('manifest_sha256', 'lock_sha256', 'generated_lock_sha256', 'contracts'):
                assert first[field] == second[field]
            for field in ('generation_id', 'generation_root', 'run_id', 'artifact_id', 'artifact_path'):
                assert first[field] != second[field]
            assert helper.read_pair(workspace) == before and not list(trusted.iterdir())
            for fault in ('runtime-source', 'unavailable', 'unavailable-claim', 'generation', 'post-snapshot',
                          'malformed', 'source', 'integrity', 'mutation', 'manifest', 'runtime',
                          'trusted-manifest', 'workspace', 'generation-cleanup', 'proxy-stop', 'proxy-cleanup', 'output-cleanup'):
                service_stopped = False
                events.clear()
                rejected(attempt)
                if fault == 'output-cleanup':
                    for path in trusted.iterdir():
                        real_rmtree(path)  # The mocked deletion failed; success must still be rejected.
                assert not list(trusted.iterdir()), ('failed bootstrap left artifact', fault)
                assert events.count('service') <= 1, 'retry/fallback'
                for path in roots:
                    if path.exists():
                        real_rmtree(path)  # Clean deliberately failed mock roots.
                (workspace / 'package.json').write_bytes(snapshot)
            fault = None
            service_stopped = False
            with helper.prepare(workspace, trusted, node, npm) as input_handle:
                with helper.bootstrap(input_handle, trusted) as handoff:
                    record = handoff.verify()
                    for field in record:
                        changed = copy.deepcopy(record)
                        changed.pop(field)
                        rejected(lambda: handoff.verify(changed))
                    rejected(lambda: handoff.verify({**record, 'unknown': True}))
                    artifact = Path(record['artifact_path'])
                    for name in ('package.json', 'package-lock.json', 'provenance.json'):
                        target = artifact / name
                        saved = target.read_bytes()
                        target.chmod(0o600)
                        target.write_bytes(b'{}')
                        target.chmod(0o400)
                        rejected(handoff.verify)
                        target.chmod(0o600)
                        target.write_bytes(saved)
                        target.chmod(0o400)
                    (artifact / 'extra').write_bytes(b'unsupported')
                    rejected(handoff.verify)
                    (artifact / 'extra').unlink()
                    assert handoff.verify() == record
                    with patch.object(runtime, 'contract_identities', return_value={}):
                        rejected(handoff.verify)
                rejected(handoff.verify)
            assert not list(trusted.iterdir())
            # Empty dependency root uses the same command and canonical acceptance.
            service_stopped = False
            (workspace / 'package.json').write_bytes(b'{"name":"empty","version":"1.0.0"}')
            attempt()
            (workspace / 'package.json').write_bytes(snapshot)

    # Serialized claims, expired handles, wrong states, unsafe roots stop before generation.
    with patch.object(runtime, 'generate_validated', side_effect=AssertionError('generation started')) as generate:
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            rejected(lambda: helper.bootstrap(input_handle.record(), trusted).__enter__())
            for path in (workspace, base, workspace / 'nested', Path('relative')):
                rejected(lambda: helper.bootstrap(input_handle, path).__enter__())
            with patch.dict(os.environ, {'RUNNER_TEMP': str(trusted)}):
                rejected(lambda: helper.bootstrap(input_handle, trusted).__enter__())
        rejected(lambda: helper.bootstrap(input_handle, trusted).__enter__())
        (workspace / 'package.json').unlink()
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            rejected(lambda: helper.bootstrap(input_handle, trusted).__enter__())
        generate.assert_not_called()
    assert not list(trusted.iterdir())
print('bootstrap: exact snapshot/generation/freeze/canonical rejection/mutation/handoff/repeat/cleanup/stop states passed')

# No production connection: only explicit parent API and existing test discovery.
for workflow in (repo / '.github/workflows').glob('*.yml'):
    assert 'product-npm-orchestrator' not in workflow.read_text()
assert 'fixtures=(.github/scripts/test-*.sh)' in (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
if 'codex-' in Path('/proc/self/cgroup').read_text():
    print('SKIP bootstrap runtime: inherited Codex boundary; independent systemd runner required')
    sys.exit(0)
if Path('/proc/1/comm').read_text().strip() != 'systemd':
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise SystemExit('bootstrap runtime requires systemd on the regression runner')
    print('SKIP bootstrap runtime: systemd is not PID 1')
    sys.exit(0)
# Formal integration through #682's actual stop handle, not a separate candidate generator.
with tempfile.TemporaryDirectory(prefix='bootstrap-official-workspace-') as workspace_name, \
     tempfile.TemporaryDirectory(prefix='bootstrap-official-trusted-') as trusted_name:
    workspace, trusted = Path(workspace_name), Path(trusted_name)
    official = json.dumps({'name': 'bootstrap-official', 'version': '1.0.0',
                          'dependencies': {'is-number': '7.0.0'}}).encode()
    (workspace / 'package.json').write_bytes(official)
    previous = None
    for cycle in range(2):
        with helper.prepare(workspace, trusted, Path('unused'), Path('unused')) as input_handle:
            with helper.bootstrap(input_handle, trusted) as handoff:
                record = handoff.verify()
                assert not Path(record['generation_root']).exists()
                if previous:
                    for field in ('manifest_sha256', 'lock_sha256', 'contracts'):
                        assert previous[field] == record[field]
                    for field in ('generation_id', 'run_id', 'artifact_id'):
                        assert previous[field] != record[field]
                previous = record
        assert not list(trusted.iterdir())
        assert helper.read_pair(workspace) == (official, None)
    # Real unavailable proxy through the same API: no alternate transport or output.
    formal_registry = runtime_load(repo, 'npm-registry-boundary-runtime')
    start = formal_registry.start_proxy

    def stopped_proxy(staged):
        process, port = start(staged)
        formal_registry.stop_proxy(process)
        formal_registry.verify_proxy_stopped(port)
        return process, port

    def formal_load(repo, name):
        return formal_registry if name == 'npm-registry-boundary-runtime' else runtime_load(repo, name)

    with patch.object(helper, 'load', side_effect=module), \
         patch.object(runtime, 'load', side_effect=formal_load), \
         patch.object(formal_registry, 'start_proxy', side_effect=stopped_proxy):
        with helper.prepare(workspace, trusted, node, npm) as input_handle:
            rejected(lambda: helper.bootstrap(input_handle, trusted).__enter__())
    assert not list(trusted.iterdir()) and helper.read_pair(workspace) == (official, None)
print('bootstrap: official repeated generation/proxy unavailable/validated artifact/workspace unchanged/cleanup runtime passed')
PY
