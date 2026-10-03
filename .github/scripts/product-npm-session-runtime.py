#!/usr/bin/env python3
"""Dormant secretless #711 boundary. No CLI, production caller or model call."""
import os
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


def checked(args, timeout=15):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout, env=ENV)


DIAGNOSTIC_STAGES = frozenset({
    'source-identity', 'command-identity', 'workspace-root', 'cache-root',
    'staging-create', 'staging-build', 'staging-normalize', 'runtime-snapshot',
    'service-isolation', 'service-tmp-empty', 'service-sudo-hidden',
    'service-input', 'service-property-snapshot', 'service-direct-deny',
    'service-localhost', 'service-offline', 'service-marker', 'service-unknown',
    'post-runtime-snapshot', 'cleanup',
})


def run_session(parent_api, handoff, workspace, export_root, node, npm, record, observer):
    """Retain only the parent API/handle; never expose a raw workload session.

    This synthetic launcher consumes prepared #710 contracts. Preparation and
    bootstrap are the caller's existing contexts. No recovery/retry or git write.
    A failing dormant fixture may expose only a fixed diagnostic stage, never
    exception text, paths, workload content or trusted evidence.
    """
    diagnostic = {'stage': 'source-identity'}

    def mark(stage):
        assert stage in DIAGNOSTIC_STAGES
        diagnostic['stage'] = stage
    repo = Path(__file__).absolute().parents[2]
    boundary = parent_api.load('npm-filesystem-boundary-runtime')
    offline = parent_api.offline
    integration = parent_api.load('npm-registry-lock-runtime')
    source_runtime = integration.runtime_hashes(node, npm)
    mark('command-identity')
    expected_command = offline.candidate_command(repo, node)
    sources = {name: (repo / '.github/scripts' / name).read_bytes() for name in (
        'product-npm-session-runtime.py', 'product-npm-session-probe.js',
        'npm-offline-ci-probe.js', 'npm-filesystem-boundary-runtime.py',
        'npm-filesystem-source-probe.js', 'npm-initial-lock-probe.js',
        'npm-registry-lock-probe.js')}

    def consume(contract):
        assert set(contract) == {'policy', 'cache_path'}
        origin = contract['policy']['origin']
        assert origin in ('no-manifest', 'bootstrap', 'locked')
        assert set(record) == {'token', 'address', 'direct_port', 'local_port',
                               'ipv6_port', 'missing', 'action'}
        assert record['action'] in ('pass', 'consumer-fail', 'manifest-mutate', 'lock-mutate')
        assert re.fullmatch(r'[0-9a-f]{32}', record['token']) and type(record['missing']) is bool
        assert record['local_port'] == record['direct_port']
        assert type(record['ipv6_port']) is int and 1024 <= record['ipv6_port'] <= 65535
        parent_api.load('codex-network-boundary').validate_endpoint(record['address'], record['direct_port'])
        assert all((repo / '.github/scripts' / name).read_bytes() == data
                   for name, data in sources.items()), 'runtime-source-identity-mismatch'
        assert offline.candidate_command(repo, node) == expected_command, 'command-identity-mismatch'
        assert expected_command[0] == '/runtime/npm/bin/npm-cli.js'
        mark('workspace-root')
        parent_api.CanonicalRoot(workspace).verify()
        assert workspace == handoff._workspace, 'workspace-identity-mismatch'
        assert re.fullmatch(r'/[A-Za-z0-9_./-]+', str(workspace)), 'unsafe-bind-path'
        cache = contract['cache_path']
        if origin == 'no-manifest':
            assert cache is None and not contract['policy']['allow_install']
        else:
            assert contract['policy']['allow_install'] and cache is not None
            # The session has already byte-verified this fresh consumable export.
            mark('cache-root')
            parent_api.CanonicalRoot(cache).verify()
            assert re.fullmatch(r'/[A-Za-z0-9_./-]+', cache), 'unsafe-bind-path'
        mark('staging-create')
        staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                      '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
        assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged))
        changed_owner = False
        try:
            mark('staging-build')
            with tempfile.TemporaryDirectory(prefix='npm-session-build-') as build:
                root = Path(build) / 'root'
                boundary.build_root(repo, root, node, npm, record['token'])
                builtin = root / 'runtime/npm/npmrc'
                assert not builtin.is_symlink(), 'unsafe-builtin-npmrc'
                builtin.write_bytes(b'')
                builtin.chmod(0o644)
                for source, target in (
                    ('product-npm-session-probe.js', 'probe.js'),
                    ('npm-offline-ci-probe.js', 'offline-ci-probe.js'),
                    ('npm-filesystem-source-probe.js', 'filesystem-probe.js'),
                    ('npm-initial-lock-probe.js', 'initial-lock-probe.js'),
                    ('npm-registry-lock-probe.js', 'registry-lock-probe.js')):
                    shutil.copy2(repo / '.github/scripts' / source, root / 'runtime' / target)
                if origin == 'no-manifest':
                    (root / 'project/package.json').unlink()
                else:
                    for name in ('package.json', 'package-lock.json', 'lifecycle-marker.js'):
                        shutil.copy2(workspace / name, root / 'runtime' / name)
                checked(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')])
            root = staged / 'root'
            mark('staging-normalize')
            checked(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)])
            parent_api.load('npm-registry-lock-runtime').normalize_staging_acls(staged)
            checked(['sudo', '-n', 'chmod', '0755', str(staged)])
            checked(['sudo', '-n', 'chown', '-R', 'nobody:nogroup', str(root / 'project'), str(root / 'tmp')])

            def snapshot():
                result = {}
                for path in (staged, root, *sorted(root.rglob('*'))):
                    if any(path.is_relative_to(root / name) for name in ('project', 'tmp')):
                        continue
                    info = path.lstat()
                    assert info.st_uid == 0 and info.st_gid == 0
                    parent_api.no_acl(path)
                    if stat.S_ISLNK(info.st_mode):
                        assert path.is_relative_to(root / 'runtime/npm')
                        assert not Path(os.readlink(path)).is_absolute()
                        assert path.resolve(strict=True).is_relative_to(root / 'runtime/npm')
                        content = os.readlink(path)
                    else:
                        assert info.st_mode & 0o7022 == 0
                        assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
                        content = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
                    if re.fullmatch(r'npm-filesystem-probe-[0-9a-f]{32}\.service\.json', path.name):
                        assert path.parent == root / 'runtime' and info.st_mode & 0o022 == 0
                        value = json.loads(path.read_bytes())
                        assert set(value) == {'unit', 'properties'} and value['unit'] + '.json' == path.name
                        parent_api.load('codex-network-boundary').validate_properties(value['properties'])
                        continue  # The observer's exact validated atomic publication.
                    result[str(path)] = (info.st_dev, info.st_ino, info.st_mode, content)
                assert integration.runtime_hashes(root / 'runtime/node', root / 'runtime/npm/bin/npm-cli.js') == source_runtime
                return result

            mark('runtime-snapshot')
            expected_runtime = snapshot()

            def launch(repo, root, unit, input_record):
                command = boundary.command(repo, root, unit, input_record)
                if origin != 'no-manifest':
                    # Sources never enter workload argv; only canonical aliases
                    # /project and /project/cache are visible inside RootDirectory.
                    binding = '--property=BindPaths=' + str(workspace) + ':/project ' + cache + ':/project/cache'
                    command.insert(command.index('/runtime/env'), binding)
                return command

            if origin != 'no-manifest':
                changed_owner = True
                checked(['sudo', '-n', 'chown', '-R', '-P', '--no-dereference', 'nobody:nogroup', '--', str(workspace), cache])
            input_record = {**record, 'origin': origin,
                            'hidden': {'host-env': '/usr/bin/env', 'host-os-release': '/etc/os-release'}}
            try:
                evidence = boundary.service(repo, root, input_record, observer=lambda unit, done:
                                            observer(unit, root / 'runtime', done), command_factory=launch)
            except Exception as error:
                # The staged probe emits exactly one bounded JSON diagnostic on
                # stderr. Accept only a closed stage allowlist; never reflect
                # arbitrary exception or subprocess text.
                match = re.search(r'\{"status":"error","stage":"([a-z-]+)"\}', str(error))
                stage = 'service-' + match.group(1) if match else 'service-unknown'
                mark(stage if stage in DIAGNOSTIC_STAGES else 'service-unknown')
                raise
            mark('post-runtime-snapshot')
            assert snapshot() == expected_runtime, 'staged-runtime-identity-mismatch'
            assert evidence == {'status': 'pass', 'consumer': 'completed', 'offline': origin != 'no-manifest'}
            return True
        finally:
            try:
                try:
                    if changed_owner:
                        checked(['sudo', '-n', 'chown', '-R', '-P', '--no-dereference',
                                 f'{os.getuid()}:{os.getgid()}', '--', str(workspace), cache])
                finally:
                    checked(['sudo', '-n', 'rm', '-rf', '--', str(staged)])
                    assert not staged.exists(), 'session-root-cleanup-failed'
            except Exception:
                mark('cleanup')
                raise

    result = parent_api.production_session(handoff, consume, export_root)
    if result['status'] != 'pass':
        result = {**result, 'diagnostic_stage': diagnostic['stage']}
    return result
