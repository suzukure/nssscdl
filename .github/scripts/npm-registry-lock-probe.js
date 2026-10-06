'use strict';
// #661 integration only. #660 owns the unchanged npm command/config/env contract.
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const dgram = require('node:dgram');
const assert = require('node:assert/strict');
const { isolationPreflight } = require('./filesystem-probe.js');
const initial = require('./initial-lock-probe.js');

function manifest(input) {
  const bytes = fs.readFileSync('/project/package.json');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), input.manifest_hash);
  assert.deepEqual(bytes, fs.readFileSync('/runtime/manifest.json'));
  if (input.bootstrap !== true) {
    assert.deepEqual(JSON.parse(bytes), { name: 'registry-lock-project', version: '1.0.0',
      dependencies: { 'is-number': '7.0.0' }, scripts: initial.scripts(input.token, 'project') });
  }
}

async function snapshot(input) {
  assert(/^npm-filesystem-probe-[0-9a-f]{32}\.service$/.test(input.unit));
  const target = '/runtime/' + input.unit + '.json', end = Date.now() + 10000;
  while (!fs.existsSync(target) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  const info = fs.lstatSync(target);
  assert(info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0);
  const record = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(record.unit, input.unit);
  // The shared #649 observer validated these properties before atomic publication.
  assert.equal(typeof record.properties, 'string');
}

async function directDeny(input) {
  assert(net.isIPv4(input.address) && !input.address.startsWith('127.'));
  assert(Number.isInteger(input.direct_port) && input.direct_port >= 1024 && input.direct_port <= 65535);
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const deadline = setTimeout(() => { socket.close(); reject(Error('UDP denial unavailable')); }, 2000);
    socket.send('network-probe', input.direct_port, input.address, error => {
      clearTimeout(deadline); socket.close();
      if (error?.code === 'EPERM') resolve(); else reject(Error('explicit UDP denial missing'));
    });
  });
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: input.address, port: input.direct_port });
    const deadline = setTimeout(() => { socket.destroy(); resolve(); }, 2000);
    socket.once('connect', () => { clearTimeout(deadline); socket.destroy(); reject(Error('direct TCP reachable')); });
    socket.once('error', error => {
      clearTimeout(deadline); socket.destroy();
      if (error.code === 'EPERM') resolve(); else reject(Error('TCP denial unconfirmed'));
    });
  });
}

function workerReady(child) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error('adapter readiness timeout')), 8000);
    const exited = () => { clearTimeout(deadline); reject(Error('official-registry-unavailable')); };
    child.once('exit', exited);
    child.once('error', exited);
    child.once('message', record => {
      clearTimeout(deadline); child.removeListener('exit', exited);
      resolve(record.port);
    });
  });
}

async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return null;
  return new Promise((resolve, reject) => {
    let counts = null;
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new ProbeFailure(23)); }, 3000);
    child.once('message', record => { counts = record; });
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      if (code === 0 && signal === null) resolve(counts); else reject(new ProbeFailure(23));
    });
    child.send('stop');
  });
}

async function verifyClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const deadline = setTimeout(() => { socket.destroy(); reject(new ProbeFailure(23)); }, 2000);
    socket.once('connect', () => { clearTimeout(deadline); socket.destroy(); reject(new ProbeFailure(23)); });
    socket.once('error', error => {
      clearTimeout(deadline); socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(); else reject(new ProbeFailure(23));
    });
  });
}

// #809: only finite exit codes cross the existing service boundary.
class ProbeFailure extends Error {
  constructor(code) { super('registry-lock integration failed'); this.code = code; }
}
function failureExitCode(error) {
  return error instanceof ProbeFailure && [20, 21, 22, 23].includes(error.code) ? error.code : 1;
}

async function probe(input) {
  isolationPreflight(input);
  assert.notEqual(input.proxy_uid, process.getuid()); assert.notEqual(input.proxy_uid, 0);
  for (const target of ['/runtime', '/runtime/npm', '/runtime/npm/bin/npm-cli.js',
    '/runtime/manifest.json', '/runtime/initial-lock-probe.js', '/runtime/npm-registry-lock-adapter.js']) {
    const info = fs.lstatSync(target);
    assert(!info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0);
    assert.throws(() => fs.accessSync(target, fs.constants.W_OK), e => ['EACCES','EPERM','EROFS'].includes(e.code));
  }
  manifest(input);
  assert.deepEqual(fs.readdirSync('/project/cache'), []);
  const before = initial.inventory();
  await snapshot(input); await directDeny(input);
  const adapterArgs = [String(input.proxy_port)];
  if (input.bootstrap === true) adapterArgs.push(JSON.stringify(input.bootstrap_dependencies));
  const child = cp.fork('/runtime/npm-registry-lock-adapter.js', adapterArgs, {
    execPath: '/runtime/node', execArgv: [], env: initial.npmEnv, stdio: ['ignore','ignore','ignore','ipc'],
  });
  let counts, port, candidateBytes;
  let failureCode = 20;
  try {
    try { port = await workerReady(child); }
    catch (error) {
      if (input.expect_unavailable !== true) throw new ProbeFailure(20);
      assert(child.exitCode === 1 && error.message === 'official-registry-unavailable');
      assert.deepEqual(initial.inventory(), before);
      return { status: 'pass', fail_closed: 'official-registry-unavailable', npm_started: false };
    }
    failureCode = 21;
    assert(input.expect_unavailable !== true, 'unavailable proxy unexpectedly succeeded');
    assert.equal(initial.runNpm('config', port).trim(), 'true');
    assert.deepEqual(initial.inventory(), before);
    const result = JSON.parse(initial.runNpm('lock', port));
    assert(result && !Array.isArray(result) && !Object.hasOwn(result, 'error'));
    for (const name of ['added','removed','changed']) assert.equal(result[name], 0);
    assert.deepEqual(initial.inventory(true), before);
    manifest(input);
    failureCode = 22;
    candidateBytes = fs.readFileSync('/project/package-lock.json');
    const lock = JSON.parse(candidateBytes);
    assert.equal(lock.lockfileVersion, 3);
    if (input.bootstrap !== true) {
      assert.equal(lock.packages['node_modules/is-number'].version, '7.0.0');
      assert.equal(lock.packages['node_modules/is-number'].resolved,
        'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz');
    }
  } catch (error) {
    const known = error instanceof assert.AssertionError || error instanceof SyntaxError ||
      ['ENOENT', 'EACCES', 'EPERM', 'EIO'].includes(error?.code);
    throw new ProbeFailure(failureExitCode(error) === 1 ? (known ? failureCode : 1) : failureExitCode(error));
  } finally {
    try {
      counts = await stopWorker(child);
      if (port !== undefined) await verifyClosed(port);
    } catch (error) { throw new ProbeFailure(failureExitCode(error)); }
  }
  try {
    assert(counts && (counts.metadata > 0 || input.bootstrap === true &&
      Object.keys(input.bootstrap_dependencies).length === 0 && counts.metadata === 0) &&
      counts.denied === 0, 'content/unsupported request detected');
  } catch { throw new ProbeFailure(21); }
  try {
    assert.deepEqual(fs.readFileSync('/project/package-lock.json'), candidateBytes, 'generated candidate mutated');
  } catch { throw new ProbeFailure(22); }
  return { status: 'pass', candidate: 'package-lock.json', manifest_hash: input.manifest_hash,
    lock_hash: crypto.createHash('sha256').update(candidateBytes).digest('hex'),
    command: initial.command('lock', port), node: process.version,
    npm: JSON.parse(fs.readFileSync('/runtime/npm/package.json')).version,
    markers: [], node_modules: false, metadata_requests: counts.metadata,
    tarball_requests: 0, dependency_execution_path: 'not-entered', direct_udp: 'EPERM' };
}
module.exports = { probe, manifest, snapshot, directDeny, workerReady, stopWorker, verifyClosed, failureExitCode };
if (require.main === module) Promise.resolve().then(() => probe(JSON.parse(process.argv[2]))).then(result => {
  console.log(JSON.stringify(result));
}).catch(error => { process.exitCode = failureExitCode(error); });
