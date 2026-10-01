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

function directoryMetadata(target, entries) {
  // Metadata only: never follow symlinks or read entry contents/configuration.
  return entries.slice().sort().map(name => {
    const info = fs.lstatSync(path.join(target, name));
    return { parent_path: target, entry_name: name,
      type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' :
        info.isSymbolicLink() ? 'symlink' : 'other',
      uid: info.uid, mode: info.mode };
  });
}

function assertEmptyDirectory(target, entries, message) {
  if (entries.length === 0) return;
  const metadata = directoryMetadata(target, entries);
  // Diagnose only this observed directory, one level deep; never recurse.
  if (target === '/run' && metadata.some(entry =>
    entry.entry_name === 'systemd' && entry.type === 'directory')) {
    let children = [];
    try {
      children = fs.readdirSync('/run/systemd');
    } catch (error) {
      // An inaccessible child cannot erase the parent's non-empty failure.
      assert(['ENOENT', 'EACCES', 'EPERM'].includes(error.code), message);
    }
    const childMetadata = directoryMetadata('/run/systemd', children);
    metadata.push(...childMetadata);
    // Only the artifact observed on the formal runner is eligible. Never
    // enumerate incoming's contents or accept siblings/type/owner/mode drift.
    const exact = (items, name, mode) => items.length === 1 &&
      items[0].entry_name === name && items[0].type === 'directory' &&
      items[0].uid === 0 && items[0].mode === mode;
    if (exact(metadata.slice(0, entries.length), 'systemd', 0o40755) &&
        exact(childMetadata, 'incoming', 0o40600)) {
      assert.equal(process.getuid(), 65534, 'runtime artifact requires service UID=nobody');
      const incoming = '/run/systemd/incoming';
      const checks = {
        open: () => { const fd = fs.openSync(incoming, 'r'); fs.closeSync(fd); },
        list: () => fs.readdirSync(incoming),
        traverse: () => fs.statSync(incoming + '/filesystem-probe-synthetic-child'),
      };
      for (const [operation, check] of Object.entries(checks)) {
        const context = `phase=hidden source_class=runtime-artifact path=${incoming} operation=${operation}`;
        let denied = false;
        try {
          check();
        } catch (error) {
          // ENOENT does not prove traversal denial; require explicit refusal.
          assert(['EACCES', 'EPERM'].includes(error.code), 'unconfirmed artifact denial: ' + context);
          denied = true;
        }
        assert(denied, 'runtime artifact accessible: ' + context);
      }
      return;
    }
  }
  assert.fail(message + ' entries=' + JSON.stringify(metadata));
}

function emptyDirectory(target) {
  const context = `phase=hidden source_class=staged-directory path=${target}`;
  // The staged directory object can be readable without exposing host content.
  // lstat rejects a replacement symlink, file, or device before enumeration.
  let entries;
  try {
    assert(fs.lstatSync(target).isDirectory(), 'unsafe staged directory type: ' + context);
    entries = fs.readdirSync(target);
  } catch (error) {
    assert(['ENOENT', 'EACCES', 'EPERM'].includes(error.code), context + ': ' + error);
    return;
  }
  assertEmptyDirectory(target, entries, 'staged directory content visible: ' + context);
}

function rootInventory(expected) {
  const actual = fs.readdirSync('/');
  for (const name of expected) {
    const target = '/' + name;
    const context = `phase=inventory source_class=staged-entry path=${target}`;
    assert(actual.includes(name), 'missing staged entry: ' + context);
    const info = fs.lstatSync(target);
    assert(name === 'boundary.json' ? info.isFile() : info.isDirectory(), context);
    assert.equal(info.uid, ['project', 'tmp'].includes(name) ? 65534 : 0, context);
    assert.equal(info.mode & 0o022, 0, context);
  }
  for (const name of actual.filter(name => !expected.includes(name))) {
    const target = '/' + name;
    const context = `phase=inventory source_class=runtime-entry path=${target}`;
    const info = fs.lstatSync(target);
    // systemd can create mount-point directories; names alone cannot prove safety.
    assert(info.isDirectory(), 'unsafe runtime entry type: ' + context);
    assert.equal(info.uid, 0, context);
    assert.equal(info.mode & 0o7022, 0, context);
    try {
      fs.accessSync(target, fs.constants.W_OK);
      throw new Error('writable runtime entry: ' + context);
    } catch (error) {
      assert(['EACCES', 'EPERM', 'EROFS'].includes(error.code), context + ': ' + error);
    }
    let entries;
    try {
      entries = fs.readdirSync(target);
    } catch (error) {
      assert(['EACCES', 'EPERM'].includes(error.code), context + ': ' + error);
      continue;
    }
    assertEmptyDirectory(target, entries, 'runtime entry content visible: ' + context);
  }
}

function cacheWriteControl() {
  let target = '/project/cache';
  try {
    if (!fs.lstatSync(target).isDirectory()) {
      throw Object.assign(new Error(), { code: 'ENOTDIR' });
    }
    target += '/filesystem-write-control';
    fs.mkdirSync(target, { mode: 0o700 });
    fs.rmdirSync(target);
    try {
      fs.lstatSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    throw Object.assign(new Error(), { code: 'EEXIST' });
  } catch (error) {
    // Never include error messages, file contents, or inherited configuration.
    throw new Error(`cache write control failed: phase=cache-write path=${target} errno=${error.code || 'UNKNOWN'}`);
  }
}

function probe(input) {
  // A missing/mismatched boundary must fail before any package-manager command.
  const info = fs.statSync('/boundary.json');
  assert.equal(info.uid, 0);
  assert.equal(info.mode & 0o022, 0);
  const boundary = JSON.parse(fs.readFileSync('/boundary.json', 'utf8'));
  assert.equal(boundary.token, input.token);
  assert.equal(process.getuid(), 65534);
  rootInventory(boundary.visible_root);
  assert.equal(process.cwd(), '/project');
  assert.equal(fs.statSync('/runtime/node').uid, 0);
  assert.equal(fs.statSync('/runtime/node').mode & 0o022, 0);
  for (const [sourceClass, target] of Object.entries(input.hidden)) {
    unreadable(target, sourceClass);
  }
  for (const target of ['/proc/1/root', '/run/host/os-release', '/run/systemd/notify',
    '/run/systemd/journal/socket', '/run/systemd/journal/stdout',
    '/run/systemd/userdb/io.systemd.DynamicUser']) {
    unreadable(target);
  }
  for (const target of ['/sys', '/run', '/home', '/root', '/proc']) {
    emptyDirectory(target);
  }
  assert.deepEqual(Object.keys(process.env).sort(), ['HOME', 'LC_ALL', 'PATH']);
  cacheWriteControl();
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
