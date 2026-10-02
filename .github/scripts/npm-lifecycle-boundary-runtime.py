#!/usr/bin/env python3
"""Dormant #656 local-only lifecycle fixture; never a production launcher."""

import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
EVENTS = ('preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack')


def filesystem(repo):
    spec = importlib.util.spec_from_file_location(
        'lifecycle_filesystem', repo / '.github/scripts/npm-filesystem-boundary-runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def scripts(token, kind):
    assert re.fullmatch(r'[0-9a-f]{32}', token) and kind in ('project', 'dependency')
    return {event: '/runtime/node /project/lifecycle-marker.js ' + token + '-' + kind + '-' + event
            for event in EVENTS}


def stage_fixture(project, token):
    # Fixture sources only; this does not relax #645 Product manifest policy.
    (project / 'markers').mkdir()
    (project / 'lifecycle-package').mkdir()
    for kind, target in (('project', project), ('dependency', project / 'lifecycle-package')):
        (target / 'package.json').write_text(json.dumps({
            'name': 'lifecycle-' + kind, 'version': '1.0.0', 'scripts': scripts(token, kind)}))
    installed = project / 'node_modules/lifecycle-dependency'
    installed.mkdir(parents=True)
    shutil.copy2(project / 'lifecycle-package/package.json', installed / 'package.json')
    (project / 'lifecycle-marker.js').write_text(
        "'use strict';const fs=require('node:fs'),assert=require('node:assert/strict');"
        "const name=process.argv[2];assert(/^[0-9a-f]{32}-(project|dependency)-"
        "(preinstall|install|postinstall|prepare|prepack|postpack)$/.test(name));"
        "fs.writeFileSync('/project/markers/'+name,'executed',{flag:'wx'});\n")


def build_root(repo, root, node, npm, token):
    filesystem(repo).build_root(repo, root, node, npm, token)
    shutil.copy2(root / 'runtime/probe.js', root / 'runtime/filesystem-probe.js')
    shutil.copy2(repo / '.github/scripts/npm-lifecycle-script-probe.js', root / 'runtime/probe.js')
    stage_fixture(root / 'project', token)
    # Newly added fixture files must not depend on the caller's umask.
    for entry in (root / 'project').rglob('*'):
        if not entry.is_symlink():
            entry.chmod(0o755 if entry.is_dir() else 0o644)


def runtime(repo, node, npm):
    assert os.getuid() != 0, 'independent runtime requires non-root runner UID'
    boundary = filesystem(repo)
    staged_paths = []
    for cycle in range(2):
        staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                      '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
        assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged))
        staged_paths.append(staged)
        token = uuid.uuid4().hex
        record = {'token': token, 'hidden': {'workspace-root': str(repo),
                  'repository-head': str(repo / '.git/HEAD'), 'host-env': '/usr/bin/env',
                  'host-os-release': '/etc/os-release', 'staging-root': str(staged)}}
        try:
            with tempfile.TemporaryDirectory(prefix='npm-lifecycle-build-') as build:
                root = Path(build) / 'root'
                build_root(repo, root, node, npm, token)
                subprocess.run(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')],
                               check=True, timeout=15, env=ENV)
            subprocess.run(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)],
                           check=True, timeout=10, env=ENV)
            subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)],
                           check=True, timeout=5, env=ENV)
            subprocess.run(['sudo', '-n', 'chown', '-R', 'nobody:nogroup',
                            str(staged / 'root/project'), str(staged / 'root/tmp')],
                           check=True, timeout=5, env=ENV)
            # Reuse the exact #654 command, root validation, hardening and unit cleanup.
            evidence = boundary.service(repo, staged / 'root', record)
            assert evidence == {'status': 'pass', 'scripts': 'disabled', 'markers': [],
                                'operations': ['config', 'pack', 'rebuild']}, 'invalid lifecycle evidence'
            print(json.dumps(evidence), flush=True)
        finally:
            subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)],
                           check=True, timeout=10, env=ENV)
            assert not staged.exists(), 'lifecycle root cleanup failed'
        print(json.dumps({'cycle': cycle + 1, 'cleanup': 'pass'}), flush=True)
    assert len(set(staged_paths)) == 2, 'lifecycle root reused'
