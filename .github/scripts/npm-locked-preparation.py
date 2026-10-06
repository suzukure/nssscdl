#!/usr/bin/env python3
"""Dormant #682 adapter: #645 preparation inside #649, never host npm fallback."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import uuid

ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
SOURCES = ('npm-locked-preparation.py', 'prepare-product-npm.py',
           'npm-registry-proxy.py', 'codex-network-boundary.py')
STAGES = ('preflight', 'node-version', 'npm-version', 'npm-ci', 'post-validate', 'prepared')
# Diagnostic vocabulary only; validation remains exclusively in #645.
CANONICAL_REASONS = frozenset('''unsafe-path unsafe-input input-too-large duplicate-json-key
invalid-json invalid-json-object unsupported-manifest-mechanism invalid-dependencies
non-exact-dependency dependency-conflict unsafe-lock-path invalid-locked-version
unsupported-lock-entry locked-name-mismatch non-registry-source missing-integrity
invalid-integrity invalid-locked-dependencies non-registry-dependency manifest-lock-mismatch
unsupported-lock-version missing-lock-root invalid-legacy-lock tool-execution-failed
unsafe-run-root overlapping-paths run-root-changed unsafe-tool-path invalid-tool-version
npm-input-mutated invalid-input-or-filesystem provenance-write-failed'''.split())
PROGRESS_FLAGS = ('npm_ci_entered', 'npm_ci_completed',
                  'node_version_probe_completed', 'npm_version_probe_completed')


def diagnostic():
    return {'schema_version': 1, 'stage': 'preflight', 'canonical_reason': None,
            **dict.fromkeys(PROGRESS_FLAGS, False), 'service_result': 'error'}


def validate_diagnostic(value):
    """Accept only a closed, non-secret schema, including on service failures."""
    validator.require(isinstance(value, dict) and set(value) == set(diagnostic()),
                      'invalid-preparation-diagnostic')
    validator.require(type(value['schema_version']) is int and value['schema_version'] == 1
                      and isinstance(value['stage'], str) and value['stage'] in STAGES
                      and (value['canonical_reason'] is None or
                           isinstance(value['canonical_reason'], str)
                           and value['canonical_reason'] in CANONICAL_REASONS)
                      and all(type(value[key]) is bool for key in PROGRESS_FLAGS)
                      and value['service_result'] in ('pass', 'error'),
                      'invalid-preparation-diagnostic')
    return value


def load(name):
    path = Path(__file__).absolute().with_name(name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load('prepare-product-npm')


def pair(path):
    fd = validator.directory(path)
    try:
        return tuple(validator.read_input(fd, name) for name in ('package.json', 'package-lock.json'))
    finally:
        os.close(fd)


def source_snapshot(staged):
    result = {}
    for name in SOURCES:
        path = staged / name
        info = path.lstat()
        validator.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                          and info.st_uid == 0 and info.st_mode & 0o7022 == 0,
                          'unsafe-boundary-source')
        validator.require(not os.listxattr(path), 'boundary-source-attributes')
        result[name] = validator.sha(path.read_bytes())
    return result


def worker(args, progress=None):
    """Only the root-owned service copy may execute online preparation."""
    if progress is None:
        progress = diagnostic()
    proxy = load('npm-registry-proxy')
    network = proxy.verify_boundary(args)  # #649 preflight, snapshot, direct deny, 403s.
    directory = Path(__file__).absolute().parent
    validator.require(args.workspace == directory / 'root/runtime/inputs'
                      and args.run_root == directory / 'root/project/preparation'
                      and args.node == directory / 'root/runtime/node'
                      and args.npm == directory / 'root/runtime/npm/bin/npm-cli.js',
                      'preparation-path-mismatch')
    source_snapshot(directory)
    inputs = pair(args.workspace)
    validator.require(all(value is not None for value in inputs), 'locked-input-required')
    validator.validate_lock(*(validator.parse(value) for value in inputs))
    builtin = args.npm.parent.parent / 'npmrc'
    validator.require(builtin.read_bytes() == b'', 'unsafe-builtin-npmrc')
    original_run = validator.run

    def through_proxy(command, cwd, env, timeout=180):
        # Reuse every canonical #645 flag/operation. Only transport is adapted.
        if command == [str(args.node), '--version']:
            progress['stage'] = 'node-version'
            output = original_run(command, cwd, env, timeout)
            progress['node_version_probe_completed'] = True
            return output
        if command == [str(args.npm), '--version']:
            progress['stage'] = 'npm-version'
            output = original_run([str(args.node), *command], cwd, env, timeout)
            progress['npm_version_probe_completed'] = True
            return output
        validator.require(command[:2] == [str(args.npm), 'ci'], 'unexpected-preparation-command')
        endpoint = 'http://127.0.0.1:' + str(args.proxy_port)
        validator.require(not any(arg.startswith(('--proxy', '--https-proxy', '--noproxy',
                          '--fetch-', '--strict-ssl')) for arg in command), 'transport-override')
        progress.update(stage='npm-ci', npm_ci_entered=True)
        output = original_run([str(args.node), *command, '--proxy=' + endpoint,
                              '--https-proxy=' + endpoint, '--noproxy=', '--strict-ssl=true',
                              '--fetch-retries=0', '--fetch-timeout=10000'], cwd, env, timeout)
        progress.update(stage='post-validate', npm_ci_completed=True)
        return output

    validator.run = through_proxy
    try:
        result = validator.prepare(args.workspace, args.run_root, args.node, args.npm)
    finally:
        validator.run = original_run
    reason = result.get('reason')
    progress['canonical_reason'] = reason if isinstance(reason, str) and reason in CANONICAL_REASONS else None
    validator.require(result['status'] == 'prepared' and result['state'] == 'locked',
                      'restricted-preparation-failed')
    validator.require(pair(args.workspace) == inputs, 'frozen-input-mutated')
    progress.update(stage='prepared', service_result='pass')
    return {'status': 'pass', 'preparation': result, 'network': network,
            'proxy_target': proxy.TARGET, 'unit': args.unit,
            'diagnostic': validate_diagnostic(progress)}


def export(result, staged, run_root, inputs):
    """Service has stopped/collected. Freeze only validated snapshots and cache."""
    source = Path(result['preparation_path'])
    validator.require(source.parent == staged / 'root/project/preparation'
                      and re.fullmatch(r'product-npm-[A-Za-z0-9_\-]+', source.name)
                      and Path(result['cache_path']) == source / 'cache', 'preparation-path-mismatch')
    validator.require(pair(source) == inputs
                      and result['manifest_hash'] == validator.sha(inputs[0])
                      and result['lockfile_hash'] == validator.sha(inputs[1]), 'preparation-input-mismatch')
    validator.validate_lock(*(validator.parse(value) for value in inputs))
    # Inspect before copy and before any offline command: no links/special files.
    cache = source / 'cache'
    for path in (cache, *cache.rglob('*')):
        info = path.lstat()
        validator.require(info.st_uid == os.getuid() and info.st_mode & 0o7022 == 0
                          and (stat.S_ISDIR(info.st_mode) or
                               stat.S_ISREG(info.st_mode) and info.st_nlink == 1), 'unsafe-exported-cache')
        validator.require(not os.listxattr(path), 'cache-attributes')
    destination = Path(tempfile.mkdtemp(prefix='product-npm-', dir=run_root))
    try:
        shutil.copytree(cache, destination / 'cache', symlinks=True)
        for path in (destination / 'cache', *(destination / 'cache').rglob('*')):
            path.chmod(0o700 if path.is_dir() else 0o600)
        for name, data in zip(('package.json', 'package-lock.json'), inputs):
            (destination / name).write_bytes(data)
        return {**result, 'preparation_path': str(destination), 'cache_path': str(destination / 'cache')}
    except BaseException:
        shutil.rmtree(destination)
        raise


def prepare(workspace, run_root, node, npm):
    """No injected transport API, retry, bootstrap call, or direct npm path."""
    validator.require(os.getuid() not in (0, 65534), 'unsafe-parent-identity')
    inputs = pair(workspace)
    validator.require(all(value is not None for value in inputs), 'locked-input-required')
    validator.validate_lock(*(validator.parse(value) for value in inputs))
    expected_sources = {name: validator.sha(Path(__file__).absolute().with_name(name).read_bytes())
                        for name in SOURCES}
    registry = load('npm-registry-boundary-runtime')
    network = load('codex-network-boundary')
    filesystem = load('npm-filesystem-boundary-runtime')
    integration = load('npm-registry-lock-runtime')  # Snapshot utilities only; no bootstrap.
    repo = Path(__file__).absolute().parents[2]
    addresses = sorted(network.local_addresses())
    validator.require(bool(addresses), 'boundary-address-unavailable')
    staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                  '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
    validator.require(re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged)),
                      'unsafe-staging-path')
    servers = proxy = None
    port = None
    token = uuid.uuid4().hex
    try:
        with tempfile.TemporaryDirectory(prefix='npm-locked-build-') as temporary:
            root = Path(temporary) / 'root'
            filesystem.build_root(repo, root, node, npm, token, validator.parse(inputs[0]))
            shutil.rmtree(root / 'project')
            (root / 'project').mkdir()
            (root / 'project/package.json').write_bytes(inputs[0])
            (root / 'project/preparation').mkdir(mode=0o700)
            frozen = root / 'runtime/inputs'
            frozen.mkdir()
            for name, data in zip(('package.json', 'package-lock.json'), inputs):
                (frozen / name).write_bytes(data)
            (root / 'runtime/manifest.json').write_bytes(inputs[0])
            (root / 'runtime/npm/npmrc').write_bytes(b'')
            # #661 fresh build mode contract, after every mutation; never chmod host/link targets.
            for entry in root.rglob('*'):
                if not entry.is_symlink():
                    entry.chmod(0o755 if entry.is_dir() or entry.stat().st_mode & 0o111 else 0o644)
            # #645 run_root is private; retain #661 modes for the remaining tree.
            (root / 'project/preparation').chmod(0o700)
            provenance = integration.runtime_hashes(node, npm)
            validator.require(integration.runtime_hashes(root / 'runtime/node',
                              root / 'runtime/npm/bin/npm-cli.js') == provenance, 'runtime-copy-mismatch')
            subprocess.run(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')],
                           check=True, timeout=20, env=ENV)
        for name in SOURCES:
            subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-g', 'root', '-m', '0444',
                            str(Path(__file__).parent / name), str(staged / name)],
                           check=True, timeout=5, env=ENV)
        subprocess.run(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)],
                       check=True, timeout=10, env=ENV)
        integration.normalize_staging_acls(staged)
        subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)], check=True, timeout=5, env=ENV)
        root = staged / 'root'
        subprocess.run(['sudo', '-n', 'chown', '-R', 'nobody:nogroup',
                        str(root / 'project'), str(root / 'tmp')], check=True, timeout=5, env=ENV)
        digest = hashlib.sha256(inputs[0]).hexdigest()
        hashes = integration.staged_snapshot(root, token, digest, provenance)
        sources = source_snapshot(staged)
        validator.require(sources == expected_sources, 'boundary-source-copy-mismatch')
        servers = registry.Servers(addresses[0])
        network.probe(addresses[0], servers.port, servers.ipv6_port)  # Before-control.
        accepts = servers.accepted
        proxy, port = registry.start_proxy(staged)
        evidence = registry.service(repo, staged, addresses[0], servers, port, preparation_tools={
            'workspace': root / 'runtime/inputs', 'run-root': root / 'project/preparation',
            'node': root / 'runtime/node', 'npm': root / 'runtime/npm/bin/npm-cli.js'})
        validator.require(servers.accepted == accepts and evidence['proxy_target'] == 'registry.npmjs.org:443'
                          and evidence['network']['mode'] == 'restricted', 'boundary-evidence-mismatch')
        # Stop all writers before reading/exporting their output as claims.
        registry.stop_proxy(proxy)
        registry.verify_proxy_stopped(port)
        validator.require(source_snapshot(staged) == sources, 'boundary-source-mutated')
        validator.require(integration.staged_snapshot(root, token, digest, provenance) == hashes,
                          'staged-runtime-mutated')
        validator.require(pair(root / 'runtime/inputs') == inputs, 'frozen-input-mutated')
        network.probe(addresses[0], servers.port, servers.ipv6_port)  # After-control.
        validator.require(servers.accepted == accepts + 1, 'direct-fallback-detected')
        # Output is still an untrusted claim: never follow its links as root.
        subprocess.run(['sudo', '-n', 'chown', '-R', '-P', '--no-dereference', f'{os.getuid()}:{os.getgid()}',
                        str(root / 'project/preparation')], check=True, timeout=10, env=ENV)
        result = export(evidence['preparation'], staged, run_root, inputs)
        result['boundary'] = {'contract': 'npm-registry-only-v1', 'unit': evidence['unit'],
                              'proxy_target': evidence['proxy_target'], 'network': evidence['network'],
                              'runtime_hashes': hashes, 'sources': sources}
        return result
    finally:
        try:
            if proxy is not None:
                registry.stop_proxy(proxy)
                registry.verify_proxy_stopped(port)
        finally:
            try:
                if servers is not None:
                    servers.close()
            finally:
                subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)],
                               check=True, timeout=10, env=ENV)
                validator.require(not staged.exists(), 'boundary-cleanup-residual')


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('command', choices=['probe'])
    for name in ('address', 'unit'):
        parser.add_argument('--' + name, required=True)
    for name in ('port', 'ipv6-port', 'proxy-port', 'proxy-uid'):
        parser.add_argument('--' + name, required=True, type=int)
    for name in ('properties-file', 'workspace', 'run-root', 'node', 'npm'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--protected-paths', required=True, nargs='+')
    args = parser.parse_args()
    progress = diagnostic()
    try:
        result = worker(args, progress)
    except Exception:
        # Never disclose config, package payloads, or inherited credentials.
        print(json.dumps({'status': 'error', 'reason': 'restricted-preparation-failed',
                          'diagnostic': validate_diagnostic(progress)}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
