#!/usr/bin/env python3
"""Dormant #654 local-only fixture; never a production bootstrap launcher."""

import importlib.util
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid


@lru_cache(maxsize=None)
def load(repo, name):
    spec = importlib.util.spec_from_file_location(name, repo / '.github/scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_manifest(repo, manifest):
    # Single authoritative #645 policy, including all sections and workspaces.
    return load(repo, 'prepare-product-npm').manifest_dependencies(manifest)


def build_root(repo, root, node, npm, token, manifest=None):
    """Copy only selected runtime files; no host tree bind or workspace exposure."""
    manifest = manifest if manifest is not None else {'name': 'disposable', 'version': '1.0.0'}
    validate_manifest(repo, manifest)
    assert node.is_absolute() and node.is_file() and npm.is_absolute() and npm.is_file()
    npm_root = npm.resolve().parent.parent
    assert npm_root.name == 'npm' and npm.resolve().name == 'npm-cli.js', 'unsupported npm layout'
    for source in npm_root.rglob('*'):
        if source.is_symlink():
            assert source.resolve().is_relative_to(npm_root), 'npm runtime symlink escape'
        assert source.is_symlink() or source.is_file() or source.is_dir(), 'unsafe npm runtime file'
    (root / 'runtime').mkdir(parents=True)
    shutil.copy2(node, root / 'runtime/node')
    shutil.copy2('/usr/bin/env', root / 'runtime/env')
    shutil.copytree(npm_root, root / 'runtime/npm', symlinks=True)
    # Copy the ELF dependency closure at its loader paths, not /usr or /lib trees.
    shown = subprocess.run(['/usr/bin/ldd', str(node), '/usr/bin/env'], check=True, capture_output=True,
                           text=True, timeout=5, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    assert 'not found' not in shown.stdout, shown.stdout
    libraries = re.findall(r'(?:=>\s+|^\s*)(/[^\s]+)\s+\(', shown.stdout, re.MULTILINE)
    assert libraries, 'unsupported Node ELF runtime'
    for name in libraries:
        source = Path(name)
        assert source.is_file() and '..' not in source.parts, 'unsafe runtime library'
        assert source.parts[1] in ('lib', 'lib64', 'usr'), 'unexpected runtime library root'
        destination = root / source.relative_to('/')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    shutil.copy2(repo / '.github/scripts/npm-filesystem-source-probe.js', root / 'runtime/probe.js')
    for name in ('project', 'tmp', 'dev', 'run', 'proc', 'sys', 'home', 'root'):
        (root / name).mkdir()
    project = root / 'project'
    (project / 'cache').mkdir()
    (project / 'package.json').write_text(json.dumps(manifest))
    (project / 'local').mkdir()
    (project / 'local/package.json').write_text('{"name":"local-control","version":"1.0.0"}')
    with tarfile.open(project / 'local-control.tgz', 'w:gz') as output:
        output.add(project / 'local/package.json', arcname='package/package.json')
    for name in ('empty.npmrc', 'global.npmrc'):
        (project / name).touch()
    marker = root / 'boundary.json'
    marker.write_text(json.dumps({'token': token, 'visible_root': sorted(
        [entry.name for entry in root.iterdir()] + ['boundary.json'])}))
    # Normalize runtime permissions rather than trusting toolcache file modes.
    for source in root.rglob('*'):
        if not source.is_symlink():
            source.chmod(0o755 if source.is_dir() or source.stat().st_mode & 0o111 else 0o644)


def command(repo, root, unit, record):
    preparation = load(repo, 'prepare-product-npm')
    assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}/root', str(root)), 'unsafe root'
    fd = preparation.directory(root)
    try:
        parent = root.parent.stat()
        assert parent.st_uid == 0 and parent.st_mode & 0o022 == 0, 'unsafe root parent'
        info = os.fstat(fd)
        assert info.st_uid == 0 and info.st_mode & 0o022 == 0, 'unsafe root ownership'
        marker = preparation.read_input(fd, 'boundary.json')
        assert marker is not None, 'missing isolation boundary'
        marker_info = os.stat('boundary.json', dir_fd=fd, follow_symlinks=False)
        assert marker_info.st_uid == 0 and marker_info.st_mode & 0o022 == 0, 'unsafe boundary marker'
        assert json.loads(marker)['token'] == record['token'], 'invalid isolation boundary'
    finally:
        os.close(fd)
    assert re.fullmatch(r'npm-filesystem-probe-[0-9a-f]{32}\.service', unit), 'unsafe unit'
    # RootDirectory already supplies an empty /tmp. Host-based PrivateTmp mounts
    # would add directories outside the explicitly staged root inventory.
    hardening = tuple(value for value in load(repo, 'npm-registry-boundary-runtime').hardening(repo)
                      if value != 'PrivateTmp=yes')
    network = load(repo, 'codex-network-boundary').PROPERTIES
    properties = ('Type=exec', 'RuntimeMaxSec=55s', 'TimeoutStopSec=2s',
                  'KillMode=control-group', 'SendSIGKILL=yes', 'User=nobody', 'Group=nogroup',
                  *hardening, *network, 'RootDirectory=' + str(root), 'MountAPIVFS=no',
                  # Unprefixed InaccessiblePaths (including inherited socket masks)
                  # are host-root based, not RootDirectory isolation evidence.
                  # The probe proves staged-directory/host-path non-exposure,
                  # including /run/host/os-release, with empty/hidden checks.
                  'PrivateDevices=yes', 'InaccessiblePaths=/proc /sys /run /home /root',
                  'WorkingDirectory=/project', 'ReadWritePaths=+/project +/tmp')
    # env -i is applied to systemd-run, so manager/caller credentials are not copied.
    return ['sudo', '-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LC_ALL=C',
            '/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect',
            '--unit=' + unit, *['--property=' + value for value in properties],
            '/runtime/env', '-i', 'PATH=/runtime', 'HOME=/project', 'LC_ALL=C',
            '/runtime/node', '/runtime/probe.js', json.dumps(record)]


def service(repo, root, record):
    unit = 'npm-filesystem-probe-' + uuid.uuid4().hex + '.service'
    launch = command(repo, root, unit, record)
    try:
        result = subprocess.run(launch, capture_output=True, text=True, timeout=65,
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        evidence = json.loads(result.stdout)
        assert evidence['status'] == 'pass', evidence
        return evidence
    finally:
        subprocess.run(['sudo', '-n', '/usr/bin/systemctl', 'stop', unit],
                       capture_output=True, timeout=10)
        state = subprocess.run(['sudo', '-n', '/usr/bin/systemctl', 'show', unit,
                                '--property=LoadState', '--value'],
                               capture_output=True, text=True, timeout=10)
        assert state.returncode in (0, 1) and state.stdout.strip() == 'not-found', \
            ('unit cleanup unconfirmed', state.stdout, state.stderr)


def same_uid_control(node, controls, phase):
    # Only managed host sentinels must be readable outside isolation; repository
    # ancestors may be inaccessible to nobody on the regression runner.
    check = ('const fs=require("fs"),assert=require("assert/strict");'
             'assert.equal(process.getuid(),65534);'
             'const f=fs.openSync(process.argv[1],"r");fs.closeSync(f)')
    for source_class, target in controls.items():
        result = subprocess.run(['sudo', '-n', '-u', 'nobody', '/usr/bin/env', '-i',
                                 str(node), '-e', check, target],
                                capture_output=True, text=True, timeout=5)
        assert result.returncode == 0, ('same-UID control failed', phase, source_class,
                                        target, result.returncode, result.stdout, result.stderr)


def workspace_not_staged(root, workspace, phase):
    """Trusted-side inventory: reject workspace paths and copied sentinel content."""
    assert root.is_dir() and not root.is_symlink(), ('invalid inventory root', phase, str(root))
    workspace = Path(workspace)
    sentinels = [(workspace / name).read_bytes() for name in ('package.json', 'host-package.tgz')]
    package_name = json.loads(sentinels[0])['name'].encode()
    for entry in root.rglob('*'):
        paths = str(entry.relative_to(root))
        if entry.is_symlink():
            paths += ' ' + os.readlink(entry)
        assert workspace.name not in paths and str(workspace.parent) not in paths, \
            ('workspace staged path', phase, 'workspace', str(entry))
        if entry.is_file() and not entry.is_symlink():
            content = entry.read_bytes()
            assert package_name not in content and str(workspace.parent).encode() not in content \
                and content not in sentinels, \
                ('workspace staged content', phase, 'workspace', str(entry))


def runtime(repo, node, npm):
    assert os.getuid() != 0, 'independent runtime requires non-root runner UID'
    staged_paths = []
    # Host packages are real, readable controls; their contents never enter the root.
    with tempfile.TemporaryDirectory(prefix='npm-host-source-', dir='/tmp') as host, \
         tempfile.TemporaryDirectory(prefix='.npm-workspace-source-', dir=repo) as workspace:
        packages = [host, workspace]
        files = []
        controls = {}
        for source_class, directory in zip(('host', 'workspace'), packages):
            Path(directory).chmod(0o755)
            manifest = Path(directory) / 'package.json'
            manifest.write_text(json.dumps({'name': source_class + '-escape-' + uuid.uuid4().hex,
                                            'version': '1.0.0'}))
            manifest.chmod(0o644)
            archive = Path(directory) / 'host-package.tgz'
            with tarfile.open(archive, 'w:gz') as output:
                output.add(manifest, arcname='package/package.json')
            archive.chmod(0o644)
            files.append(str(archive))
            if source_class == 'host':
                controls['host-package'] = str(manifest)
                controls['host-tarball'] = str(archive)
        for cycle in range(2):
            staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                          '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5).strip())
            assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged))
            staged_paths.append(staged)
            token = uuid.uuid4().hex
            record = {'token': token, 'packages': packages, 'files': files,
                      'hidden': {kind + '-package': str(Path(item) / 'package.json')
                                 for kind, item in zip(('host', 'workspace'), packages)}}
            record['hidden'].update({'host-tarball': files[0], 'workspace-tarball': files[1],
                                     'workspace-root': str(repo), 'repository-head': str(repo / '.git/HEAD'),
                                     'host-os-release': '/etc/os-release', 'host-env': '/usr/bin/env',
                                     'staging-root': str(staged)})
            try:
                with tempfile.TemporaryDirectory(prefix='npm-root-build-') as build:
                    root = Path(build) / 'root'
                    build_root(repo, root, node, npm, token)
                    workspace_not_staged(root, workspace, 'build')
                    subprocess.run(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')],
                                   check=True, timeout=15)
                subprocess.run(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)],
                               check=True, timeout=10)
                subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)], check=True, timeout=5)
                subprocess.run(['sudo', '-n', 'chown', '-R', 'nobody:nogroup',
                                str(staged / 'root/project'), str(staged / 'root/tmp')],
                               check=True, timeout=5)
                workspace_not_staged(staged / 'root', workspace, 'staged')
                same_uid_control(node, controls, 'pre')
                print(json.dumps(service(repo, staged / 'root', record)), flush=True)
                same_uid_control(node, controls, 'post')
            finally:
                subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)], check=True, timeout=10)
                assert not staged.exists(), 'filesystem root cleanup failed'
            print(json.dumps({'cycle': cycle + 1, 'cleanup': 'pass'}), flush=True)
        assert len(set(staged_paths)) == 2, 'runtime root reused'
    assert not Path(host).exists() and not Path(workspace).exists(), 'host fixture cleanup failed'
