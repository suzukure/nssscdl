'use strict';
// Dormant #654 probe. Only launched in the disposable RootDirectory.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

function unreadable(target, sourceClass = 'system-path') {
  const context = `phase=hidden source_class=${sourceClass} path=${target}`;
  try {
    const fd = fs.openSync(target, 'r');
    fs.closeSync(fd);
  } catch (error) {
    assert(['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code), context + ': ' + error);
    return;
  }
  throw new Error('host source visible: ' + context);
}

function probe(input) {
  // A missing/mismatched boundary must fail before any package-manager command.
  const info = fs.statSync('/boundary.json');
  assert.equal(info.uid, 0);
  assert.equal(info.mode & 0o022, 0);
  const boundary = JSON.parse(fs.readFileSync('/boundary.json', 'utf8'));
  assert.equal(boundary.token, input.token);
  assert.deepEqual(fs.readdirSync('/').sort(), boundary.visible_root.sort());
  assert.equal(process.getuid(), 65534);
  assert.equal(process.cwd(), '/project');
  assert.equal(fs.statSync('/runtime/node').uid, 0);
  assert.equal(fs.statSync('/runtime/node').mode & 0o022, 0);
  for (const [sourceClass, target] of Object.entries(input.hidden)) {
    unreadable(target, sourceClass);
  }
  for (const target of ['/proc/1/root', '/sys', '/run', '/home', '/root', '/run/host/os-release']) {
    unreadable(target);
  }
  assert.deepEqual(Object.keys(process.env).sort(), ['HOME', 'LC_ALL', 'PATH']);
  const npm = ['/runtime/npm/bin/npm-cli.js', '--offline', '--ignore-scripts',
    '--package-lock=false', '--audit=false', '--fund=false', '--update-notifier=false',
    '--userconfig=/project/empty.npmrc', '--globalconfig=/project/global.npmrc',
    '--cache=/project/cache'];
  function add(source, success, sourceClass = 'visible-local') {
    const context = `phase=npm source_class=${sourceClass} path=${source}`;
    const result = cp.spawnSync('/runtime/node', [...npm, 'pack', '--dry-run', '--json', source], {
      cwd: '/project', env: process.env, encoding: 'utf8', timeout: 5000,
      killSignal: 'SIGKILL',
    });
    // Timeout/signal/unrelated npm failure is never filesystem denial evidence.
    assert(!result.error && result.signal === null, context + ': ' + (result.error || result.signal));
    if (success) {
      assert.equal(result.status, 0, context + ': ' + result.stderr);
      const packed = JSON.parse(result.stdout);
      assert.equal(packed.length, 1);
      assert.equal(packed[0].name, 'local-control');
      assert.equal(packed[0].version, '1.0.0');
    } else {
      assert(result.status > 0, 'local source accepted: ' + context);
      assert(/\b(?:ENOENT|EACCES|ENOTDIR)\b/.test(result.stderr), context + ': ' + result.stderr);
    }
    return { source, returncode: result.status };
  }
  // Visible local package succeeds before and after: failures are not broken npm.
  add('./local', true);
  add('file:./local-control.tgz', true);
  const failures = [];
  for (const target of [...input.packages, ...input.files]) {
    const sourceClass = input.packages.includes(target) ?
      (target === input.packages[0] ? 'host-directory' : 'workspace-directory') :
      (target === input.files[0] ? 'host-tarball' : 'workspace-tarball');
    failures.push(add('file:' + target, false, sourceClass));
    failures.push(add(target, false, sourceClass));
  }
  failures.push(add('../..' + input.packages[0], false, 'host-traversal'));
  failures.push(add('file:../../' + input.packages[0].slice(1), false, 'host-traversal'));
  for (const [name, target] of [['absolute-link', input.packages[0]],
    ['relative-link', '../..' + input.packages[1]]]) {
    fs.symlinkSync(target, '/project/' + name);
    unreadable('/project/' + name + '/package.json', name);
    failures.push(add('./' + name, false, name));
  }
  fs.symlinkSync(input.files[0], '/project/file-link.tgz');
  unreadable('/project/file-link.tgz', 'host-tarball-symlink');
  failures.push(add('file:./file-link.tgz', false, 'host-tarball-symlink'));
  add('./local', true);
  add('file:./local-control.tgz', true);
  function noInstall(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(!['package-lock.json', 'npm-shrinkwrap.json', 'node_modules'].includes(entry.name));
      if (entry.isDirectory()) noInstall(path.join(directory, entry.name));
    }
  }
  noInstall('/project');
  return { status: 'pass', visible_source_root: '/project', host_sources: 'hidden', failures };
}

try {
  console.log(JSON.stringify(probe(JSON.parse(process.argv[2]))));
} catch (error) {
  // Fixture input contains local paths only; never print inherited configuration.
  console.error(String(error));
  process.exitCode = 1;
}
