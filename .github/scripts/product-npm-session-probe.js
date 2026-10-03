'use strict';
// Secretless synthetic consumer; never a model launcher.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const offline = require('./offline-ci-probe.js');
const boundary = require('./registry-lock-probe.js');
const { isolationPreflight } = require('./filesystem-probe.js');

let diagnosticStage = 'isolation';
function mark(stage) {
  diagnosticStage = stage;
}

async function probe(input) {
  mark('isolation');
  isolationPreflight(input);
  // No trusted evidence path crosses argv. The staged /tmp is empty and the
  // host /home, /run, /root, /proc are hidden by the shared isolation preflight.
  mark('tmp-empty');
  assert.deepEqual(fs.readdirSync('/tmp'), []);
  mark('sudo-hidden');
  for (const target of ['/usr/bin/sudo', '/bin/sudo', '/runtime/sudo'])
    assert.throws(() => fs.accessSync(target, fs.constants.X_OK),
      error => ['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code));
  mark('input');
  if (input.origin === 'no-manifest') {
    assert(!fs.existsSync('/project/package.json'));
    assert(!fs.existsSync('/project/package-lock.json'));
    mark('property-snapshot');
    await boundary.snapshot(input);
    mark('direct-deny');
    await boundary.directDeny(input);
    mark('localhost');
    await offline.localhost(input);
  } else {
    mark('offline');
    const result = await offline.probe(input);
    // #677's cache-miss proof itself passes, but no consumer may start.
    assert.equal(result.install, 'cache-only');
  }
  mark('marker');
  fs.writeFileSync('/project/consumer-started', 'started');
  if (input.action === 'consumer-fail') throw Error('synthetic consumer failure');
  if (input.action === 'manifest-mutate') fs.appendFileSync('/project/package.json', ' ');
  if (input.action === 'lock-mutate') fs.appendFileSync('/project/package-lock.json', ' ');
  return {status: 'pass', consumer: 'completed', offline: input.origin !== 'no-manifest'};
}
module.exports = {probe};
if (require.main === module) probe(JSON.parse(process.argv[2]))
  .then(result => console.log(JSON.stringify(result)))
  .catch(() => {
    console.error(JSON.stringify({status: 'error', stage: diagnosticStage}));
    process.exitCode = 1;
  });
