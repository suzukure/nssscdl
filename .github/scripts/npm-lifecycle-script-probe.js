'use strict';
// Dormant #656: fixed commands only, inside the unchanged #654 disposable root.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { isolationPreflight } = require('./filesystem-probe.js');

const events = ['preinstall', 'install', 'postinstall', 'prepare'];
const npmEnv = Object.freeze({ PATH: '/runtime', HOME: '/project', LC_ALL: 'C' });
const flags = Object.freeze(['/runtime/npm/bin/npm-cli.js', '--offline', '--ignore-scripts',
  '--package-lock=false', '--audit=false', '--fund=false', '--update-notifier=false',
  '--userconfig=/project/empty.npmrc', '--globalconfig=/project/global.npmrc',
  '--cache=/project/cache']);
const operations = Object.freeze({
  config: ['config', 'get', 'ignore-scripts'],
  install: ['install', '--json'],
});

function command(operation) {
  assert(Object.hasOwn(operations, operation), 'unsupported lifecycle command');
  return [...flags, ...operations[operation]];
}

function validateContract(operation, args, env) {
  // Exact equality rejects missing/duplicate flags, enabled overrides, alternate
  // configs, env npm_config_*, credentials and unknown/malformed operations.
  assert.deepEqual(args, command(operation), 'unsafe lifecycle command contract');
  assert.deepEqual(env, npmEnv, 'unsafe lifecycle environment contract');
}

function configurationPreflight() {
  for (const target of ['/project/empty.npmrc', '/project/global.npmrc']) {
    assert(fs.lstatSync(target).isFile(), 'unsafe lifecycle config type');
    assert.equal(fs.readFileSync(target, 'utf8'), '', 'non-empty lifecycle config');
  }
  assert(!fs.existsSync('/project/.npmrc'), 'unexpected project config');
}

function runNpm(operation, args = command(operation), env = { ...npmEnv }) {
  validateContract(operation, args, env);
  configurationPreflight();
  const result = cp.spawnSync('/runtime/node', args, {
    cwd: '/project', env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
  });
  assert(!result.error && result.signal === null && result.status === 0,
    'lifecycle npm operation failed: ' + operation);
  return result.stdout;
}

function expectedScripts(token, kind) {
  return Object.fromEntries(events.map(event => [event,
    `/runtime/node /project/lifecycle-marker.js ${token}-${kind}-${event}`]));
}

function checkPackage(target, token, kind) {
  const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(manifest, { name: 'lifecycle-' + kind, version: '1.0.0',
    scripts: expectedScripts(token, kind) }, 'invalid lifecycle fixture manifest');
}

function noSideEffects() {
  assert.deepEqual(fs.readdirSync('/project/markers'), [], 'lifecycle side effect detected');
  const inventory = [];
  function inspect(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      assert(!['package-lock.json', 'npm-shrinkwrap.json', '.package-lock.json'].includes(name),
        'unexpected lock generation');
      const target = path.join(directory, name);
      const info = fs.lstatSync(target);
      assert(info.isDirectory() || info.isFile(), 'unsafe fixture artifact type');
      // npm cache/log contents may change; all other fixture paths stay exact.
      if (!target.startsWith('/project/cache/')) inventory.push([target, info.isDirectory()]);
      if (info.isDirectory()) inspect(target);
    }
  }
  inspect('/project');
  return inventory;
}

function probe(input) {
  isolationPreflight(input);
  assert(/^[0-9a-f]{32}$/.test(input.token), 'invalid lifecycle token');
  checkPackage('/project/package.json', input.token, 'project');
  const inventory = noSideEffects();
  // Require the effective npm setting, then successful bare project install.
  // No enabled-script control or fallback ever runs on the trusted host.
  assert.equal(runNpm('config').trim(), 'true', 'scripts disabled setting unsupported');
  assert.deepEqual(noSideEffects(), inventory, 'unexpected fixture artifact');
  const installed = JSON.parse(runNpm('install'));
  assert(installed && !Array.isArray(installed) && typeof installed === 'object',
    'unexpected install result');
  assert(!Object.hasOwn(installed, 'error'), 'install reported error');
  for (const key of ['added', 'removed', 'changed']) assert.equal(installed[key], 0);
  checkPackage('/project/package.json', input.token, 'project');
  assert.deepEqual(noSideEffects(), inventory, 'unexpected fixture artifact');
  return { status: 'pass', scripts: 'disabled', markers: [], operations: ['config', 'install'] };
}

module.exports = { command, validateContract, runNpm, probe, expectedScripts, npmEnv };
if (require.main === module) {
  try {
    console.log(JSON.stringify(probe(JSON.parse(process.argv[2]))));
  } catch {
    // Fixed diagnostic: never echo package output, inherited env or secret values.
    console.error('lifecycle boundary proof failed');
    process.exitCode = 1;
  }
}
