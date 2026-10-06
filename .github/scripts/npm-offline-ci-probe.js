'use strict';
// #677 production candidate identity. Dormant fixture, never a launcher.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const initial = require('./initial-lock-probe.js');
const boundary = require('./registry-lock-probe.js');
const { isolationPreflight } = require('./filesystem-probe.js');

function command(operation = 'ci') {
  assert(['ci', 'config'].includes(operation), 'unsupported offline command');
  return ['/runtime/npm/bin/npm-cli.js', '--offline', '--ignore-scripts',
    '--package-lock=true', '--audit=false', '--fund=false', '--update-notifier=false',
    '--workspaces=false', '--include=dev', '--include=optional', '--include=peer',
    '--fetch-retries=0', '--fetch-timeout=5000', '--registry=https://registry.npmjs.org/',
    '--userconfig=/project/empty.npmrc', '--globalconfig=/project/global.npmrc',
    '--cache=/project/cache', ...(operation === 'ci' ? ['ci', '--json'] : ['config', 'get', 'ignore-scripts'])];
}

function runNpm(operation, args = command(operation), env = {...initial.npmEnv}) {
  initial.validateInvocation(args, command(operation), env);
  const result = cp.spawnSync('/runtime/node', args, { cwd: '/project', env,
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert(!result.error && result.signal === null && Number.isInteger(result.status),
    'npm execution failed: ' + JSON.stringify({operation, code:result.error?.code, signal:result.signal, status:result.status}));
  return result;
}

function inputs(token) {
  initial.checkManifests(token);
  for (const name of ['package.json', 'package-lock.json', 'lifecycle-marker.js']) {
    const target = '/project/' + name, info = fs.lstatSync(target);
    assert(info.isFile() && info.nlink === 1, 'unsafe input type');
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync('/runtime/' + name), 'input changed');
  }
  assert.deepEqual(fs.readFileSync('/project/fixture/lifecycle-marker.js'),
    fs.readFileSync('/runtime/lifecycle-marker.js'));
}

function inventory() {
  assert.deepEqual(fs.readdirSync('/project/markers'), [], 'lifecycle marker detected');
  const entries = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name), info = fs.lstatSync(target);
      assert(info.isFile() || info.isDirectory(), 'unsafe artifact type');
      assert(!['npm-shrinkwrap.json', '.npmrc'].includes(name), 'unexpected npm artifact');
      if (target === '/project/node_modules' || target.startsWith('/project/cache/')) {
        if (info.isDirectory()) walkAllowed(target);
        continue;
      }
      entries.push([target, info.isDirectory() ? null : fs.readFileSync(target).toString('base64')]);
      if (info.isDirectory()) walk(target);
    }
  }
  function walkAllowed(directory) {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), info = fs.lstatSync(target);
      assert(info.isFile() || info.isDirectory(), 'unsafe install/cache artifact');
      if (info.isDirectory()) walkAllowed(target);
    }
  }
  walk('/project');
  return entries;
}

function installed(missing) {
  const target = '/project/node_modules';
  if (missing) {
    if (fs.existsSync(target)) assert.deepEqual(fs.readdirSync(target), [], 'cache miss installed content');
    return;
  }
  assert.deepEqual(fs.readdirSync(target).sort(), ['.package-lock.json', 'initial-lock-dependency']);
  const dependency = target + '/initial-lock-dependency';
  assert.deepEqual(fs.readdirSync(dependency).sort(), ['lifecycle-marker.js', 'package.json']);
  for (const name of ['package.json', 'lifecycle-marker.js'])
    assert.deepEqual(fs.readFileSync(dependency + '/' + name), fs.readFileSync('/project/fixture/' + name),
      'dependency content mismatch');
  const hidden = JSON.parse(fs.readFileSync(target + '/.package-lock.json'));
  assert.equal(hidden.lockfileVersion, 3);
  assert.deepEqual(Object.keys(hidden.packages), ['node_modules/initial-lock-dependency']);
  const lock = JSON.parse(fs.readFileSync('/project/package-lock.json'));
  assert.deepEqual(hidden.packages, {'node_modules/initial-lock-dependency': lock.packages['node_modules/initial-lock-dependency']});
}

async function localhost(input) {
  for (const [host, port] of [['127.0.0.1', input.local_port], ['::1', input.ipv6_port]]) {
    await new Promise((resolve, reject) => {
      const socket = net.connect({host, port});
      const deadline = setTimeout(() => { socket.destroy(); reject(Error('localhost timeout')); }, 2000);
      socket.once('data', data => {
        clearTimeout(deadline); socket.destroy();
        try { assert.equal(data.toString(), 'network-probe'); resolve(); } catch (error) { reject(error); }
      });
      socket.once('error', error => { clearTimeout(deadline); socket.destroy(); reject(error); });
    });
  }
  // AF_UNIX remains usable for local IPC; no protected host socket is exposed.
  const target = '/project/offline-ci.sock';
  const server = net.createServer(socket => socket.end('local-ipc'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(target, resolve); });
    await new Promise((resolve, reject) => {
      const socket = net.connect(target);
      const deadline = setTimeout(() => { socket.destroy(); reject(Error('unix timeout')); }, 2000);
      socket.once('data', data => {
        clearTimeout(deadline); socket.destroy();
        try { assert.equal(data.toString(), 'local-ipc'); resolve(); } catch (error) { reject(error); }
      });
      socket.once('error', error => { clearTimeout(deadline); socket.destroy(); reject(error); });
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert(!fs.existsSync(target), 'unix socket cleanup failed');
}

async function probe(input) {
  isolationPreflight(input);
  assert(typeof input.missing === 'boolean');
  inputs(input.token);
  const before = inventory();
  assert(!fs.existsSync('/project/node_modules'), 'preexisting install');
  await boundary.snapshot(input);
  await boundary.directDeny(input);
  await localhost(input);
  const config = runNpm('config');
  assert.equal(config.status, 0); assert.equal(config.stdout.trim(), 'true');
  inputs(input.token); assert.deepEqual(inventory(), before, 'config mutation');
  const result = runNpm('ci');
  const value = JSON.parse(result.stdout);
  assert(value && typeof value === 'object' && !Array.isArray(value), 'unsupported npm result');
  if (input.missing) {
    assert(result.status > 0 && value.error?.code === 'ENOTCACHED', 'cache miss did not fail closed');
  } else {
    assert.equal(result.status, 0); assert(!Object.hasOwn(value, 'error'));
    assert.equal(value.added, 1); assert.equal(value.removed, 0); assert.equal(value.changed, 0);
  }
  installed(input.missing);
  inputs(input.token); assert.deepEqual(inventory(), before, 'unexpected fixture mutation');
  return {status:'pass', command:command(), env:initial.npmEnv, node:process.version,
    npm:JSON.parse(fs.readFileSync('/runtime/npm/package.json')).version,
    markers:[], install:input.missing ? 'ENOTCACHED' : 'cache-only',
    dependency_content:input.missing ? 'absent' : 'verified', direct_udp:'EPERM', localhost:'pass',
    manifest_hash:crypto.createHash('sha256').update(fs.readFileSync('/project/package.json')).digest('hex'),
    lock_hash:crypto.createHash('sha256').update(fs.readFileSync('/project/package-lock.json')).digest('hex')};
}
module.exports = {command, runNpm, inputs, inventory, installed, localhost, probe};
if (require.main === module) probe(JSON.parse(process.argv[2])).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(String(error)); process.exitCode = 1; });
