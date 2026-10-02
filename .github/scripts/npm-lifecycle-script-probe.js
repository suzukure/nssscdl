'use strict';
// Dormant #656: fixed commands only, inside the unchanged #654 disposable root.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { isolationPreflight } = require('./filesystem-probe.js');

const events = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'];
const npmEnv = Object.freeze({ PATH: '/runtime', HOME: '/project', LC_ALL: 'C' });
const flags = Object.freeze(['/runtime/npm/bin/npm-cli.js', '--offline', '--ignore-scripts',
  '--package-lock=false', '--audit=false', '--fund=false', '--update-notifier=false',
  '--userconfig=/project/empty.npmrc', '--globalconfig=/project/global.npmrc',
  '--cache=/project/cache']);
const operations = Object.freeze({
  config: ['config', 'get', 'ignore-scripts'],
  pack: ['pack', '--json'],
  rebuild: ['rebuild', '--json', 'lifecycle-dependency'],
});
const packFilename = 'lifecycle-project-1.0.0.tgz';
const packArtifact = '/project/' + packFilename;

function noPackArtifact() {
  try {
    fs.lstatSync(packArtifact);
  } catch (error) {
    assert.equal(error.code, 'ENOENT', 'pack artifact absence unconfirmed');
    return;
  }
  assert.fail('pack artifact cleanup failed');
}

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
  assert.equal(manifest.name, 'lifecycle-' + kind);
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.scripts, expectedScripts(token, kind), 'missing lifecycle fixture scripts');
}

function noSideEffects() {
  assert.deepEqual(fs.readdirSync('/project/markers'), [], 'lifecycle side effect detected');
  function noLocks(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(!['package-lock.json', 'npm-shrinkwrap.json', '.package-lock.json'].includes(entry.name),
        'unexpected lock generation');
      if (entry.isDirectory()) noLocks(path.join(directory, entry.name));
    }
  }
  noLocks('/project');
}

function probe(input) {
  isolationPreflight(input);
  assert(/^[0-9a-f]{32}$/.test(input.token), 'invalid lifecycle token');
  checkPackage('/project/package.json', input.token, 'project');
  checkPackage('/project/lifecycle-package/package.json', input.token, 'dependency');
  checkPackage('/project/node_modules/lifecycle-dependency/package.json', input.token, 'dependency');
  noSideEffects();
  noPackArtifact();
  // Require the effective npm setting, then successful real pack and rebuild.
  // No enabled-script control or fallback ever runs on the trusted host.
  assert.equal(runNpm('config').trim(), 'true', 'scripts disabled setting unsupported');
  noSideEffects();
  const packed = JSON.parse(runNpm('pack'));
  assert(Array.isArray(packed), 'unexpected pack result');
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, packFilename);
  noSideEffects();
  assert(fs.lstatSync(packArtifact).isFile(), 'unsafe pack artifact type');
  fs.unlinkSync(packArtifact);
  noPackArtifact();
  // Non-link rebuild covers install events; project pack covers prepare.
  assert.equal(runNpm('rebuild').trim(), 'rebuilt dependencies successfully', 'unexpected rebuild result');
  checkPackage('/project/node_modules/lifecycle-dependency/package.json', input.token, 'dependency');
  noSideEffects();
  return { status: 'pass', scripts: 'disabled', markers: [], operations: ['config', 'pack', 'rebuild'] };
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
