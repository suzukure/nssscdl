'use strict';
// Dormant #660: only the initial-lock path; no pack/git/directory proof.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { isolationPreflight } = require('./filesystem-probe.js');
const events = ['preinstall', 'install', 'postinstall', 'prepare'];
const npmEnv = Object.freeze({ PATH: '/runtime', HOME: '/project', LC_ALL: 'C' });
const operations = Object.freeze({
  config: ['config', 'get', 'ignore-scripts'],
  lock: ['install', '--package-lock-only', '--json'],
});

function registry(port) {
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'invalid fixture port');
  return `http://127.0.0.1:${port}/`;
}

function command(operation, port) {
  assert(Object.hasOwn(operations, operation), 'unsupported initial-lock command');
  return ['/runtime/npm/bin/npm-cli.js', '--ignore-scripts', '--package-lock=true',
    '--lockfile-version=3', '--audit=false', '--fund=false', '--update-notifier=false',
    '--workspaces=false', '--include=dev', '--include=optional', '--include=peer',
    '--fetch-retries=0', '--fetch-timeout=8000', '--registry=' + registry(port),
    '--userconfig=/project/empty.npmrc', '--globalconfig=/project/global.npmrc',
    '--cache=/project/cache', ...operations[operation]];
}

function validateInvocation(args, expected, env) {
  // Missing/overridden disable flags, alternate configs, credentials, npm env,
  // proxies and unknown arguments all fail BEFORE spawn; no retry/fallback.
  assert.deepEqual(args, expected, 'unsafe npm command contract');
  assert.deepEqual(env, npmEnv, 'unsafe initial-lock environment contract');
  for (const target of ['/project/empty.npmrc', '/project/global.npmrc',
    '/runtime/npm/npmrc']) {
    assert(fs.lstatSync(target).isFile(), 'unsafe npmrc type');
    assert.equal(fs.readFileSync(target, 'utf8'), '', 'unsafe npmrc content');
  }
  // lstat also catches dangling symlinks; existsSync alone would miss them.
  try {
    fs.lstatSync('/project/.npmrc');
    assert.fail('unexpected project npmrc');
  } catch (error) {
    assert.equal(error.code, 'ENOENT', 'unsafe project npmrc');
  }
}

function runNpm(operation, port, args = command(operation, port), env = { ...npmEnv }) {
  validateInvocation(args, command(operation, port), env);
  // #814: config stays at 10s; lock resolution gets 30s within the outer 55s.
  const timeout = operation === 'lock' ? 30000 : 10000;
  const result = cp.spawnSync('/runtime/node', args, {
    cwd: '/project', env, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
  });
  assert(!result.error && result.signal === null && result.status === 0,
    'initial-lock npm operation failed: ' + operation);
  return result.stdout;
}

function scripts(token, kind) {
  return Object.fromEntries(events.map(event => [event,
    `/runtime/node /project/lifecycle-marker.js ${token}-${kind}-${event}`]));
}

function checkManifests(token) {
  assert(/^[0-9a-f]{32}$/.test(token), 'invalid fixture token');
  assert.deepEqual(JSON.parse(fs.readFileSync('/project/package.json', 'utf8')),
    { name: 'initial-lock-project', version: '1.0.0',
      dependencies: { 'initial-lock-dependency': '1.0.0' }, scripts: scripts(token, 'project') });
  assert.deepEqual(JSON.parse(fs.readFileSync('/project/fixture/package.json', 'utf8')),
    { name: 'initial-lock-dependency', version: '1.0.0', scripts: scripts(token, 'dependency') });
  assert(fs.lstatSync('/project/lifecycle-marker.js').isFile());
  assert.equal(fs.readFileSync('/project/fixture/lifecycle-marker.js', 'utf8'),
    fs.readFileSync('/project/lifecycle-marker.js', 'utf8'));
}

function inventory(candidate = false) {
  assert.deepEqual(fs.readdirSync('/project/markers'), [], 'lifecycle side effect detected');
  const entries = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name), info = fs.lstatSync(target);
      assert(info.isFile() || info.isDirectory(), 'unsafe artifact type');
      assert(!['node_modules', 'npm-shrinkwrap.json', '.package-lock.json'].includes(name),
        'unexpected install artifact');
      if (name === 'package-lock.json') {
        assert(candidate && target === '/project/package-lock.json' && info.isFile(),
          'unexpected lock variant');
        continue;
      }
      // Cache bytes can change; all other bytes/types and paths must stay exact.
      if (target.startsWith('/project/cache/')) {
        if (info.isDirectory()) walk(target);
        continue;
      }
      entries.push([target, info.isDirectory() ? null : fs.readFileSync(target).toString('base64')]);
      if (info.isDirectory()) walk(target);
    }
  }
  walk('/project');
  return entries;
}

function probe(input) {
  isolationPreflight(input);
  registry(input.port);
  checkManifests(input.token);
  const npmVersion = JSON.parse(fs.readFileSync('/runtime/npm/package.json', 'utf8')).version;
  assert(/^\d+\.\d+\.\d+$/.test(npmVersion), 'unsupported npm version metadata');
  assert.deepEqual(fs.readdirSync('/project/cache'), [], 'initial cache not empty');
  const before = inventory();
  assert.equal(runNpm('config', input.port).trim(), 'true', 'script disable unsupported');
  assert.deepEqual(inventory(), before, 'config side effect');
  const installed = JSON.parse(runNpm('lock', input.port));
  assert(installed && typeof installed === 'object' && !Array.isArray(installed) &&
    !Object.hasOwn(installed, 'error'), 'invalid npm success evidence');
  for (const key of ['added', 'removed', 'changed']) assert.equal(installed[key], 0);
  assert.deepEqual(inventory(true), before, 'unexpected fixture mutation');
  checkManifests(input.token);
  // Candidate existence/fixture identity only; final validation/provenance is #662.
  const lock = JSON.parse(fs.readFileSync('/project/package-lock.json', 'utf8'));
  assert.equal(lock.lockfileVersion, 3, 'unsupported npm lock behavior');
  assert.equal(lock.packages['node_modules/initial-lock-dependency'].version, '1.0.0');
  assert.equal(lock.packages['node_modules/initial-lock-dependency'].resolved,
    registry(input.port) + 'initial-lock-dependency/-/initial-lock-dependency-1.0.0.tgz');
  return { status: 'pass', command: command('lock', input.port), node: process.version, npm: npmVersion,
    markers: [], candidate: 'package-lock.json', node_modules: false,
    operations: ['config', 'lock'] };
}

module.exports = { command, runNpm, npmEnv, probe, scripts, inventory, validateInvocation, checkManifests };
if (require.main === module) {
  try {
    console.log(JSON.stringify(probe(JSON.parse(process.argv[2]))));
  } catch {
    console.error('initial-lock lifecycle proof failed');
    process.exitCode = 1;
  }
}
