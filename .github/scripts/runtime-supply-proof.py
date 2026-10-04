#!/usr/bin/env python3
"""#741 secretless setup-only actual runner proof. Not a production caller."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

PIN = '86365089eb2b84e0a8fb0717b304f8bdcb13b20e'


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def version(argv, package=None):
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
    if package:
        env.update(CODEX_MANAGED_PACKAGE_ROOT=str(package), CODEX_MANAGED_BY_NPM='1')
    return subprocess.run(argv, env=env, capture_output=True, check=True,
                          timeout=20).stdout.decode().strip()


def resolve(node, launcher, action, workspace, supply, staging, root_api):
    """Same fixed package/native/parity/blob contract as Issue-origin resolver.

    Resolve only known launcher symlinks, then no-follow regular sources. Record
    all accepted bytes before any version probe and revalidate after probes.
    """
    require = supply.require
    node, entry = node.resolve(strict=True), launcher.resolve(strict=True)
    require(re.fullmatch(r'/opt/hostedtoolcache/node/24\.\d+\.\d+/x64/bin/node', str(node)),
            'unexpected-node-layout')
    distribution = node.parent.parent
    package = distribution / 'lib/node_modules/@openai/codex'
    require(entry == package / 'bin/codex.js', 'unexpected-launcher-layout')
    platform = distribution / 'lib/node_modules/@openai/codex-linux-x64'
    # npm may place the optional platform dependency inside the main package.
    nested = package / 'node_modules/@openai/codex-linux-x64'
    if nested.exists():
        require(not platform.exists(), 'ambiguous-platform-package')
        platform = nested
    native = platform / 'vendor/x86_64-unknown-linux-musl/bin/codex'
    rows = [
        (node, '/runtime/node', 'node-runtime', True),
        (package / 'package.json', '/runtime/codex/package.json', 'codex-package', False),
        (entry, '/runtime/codex/bin/codex.js', 'codex-package', True),
        (platform / 'package.json', '/runtime/platform/package.json', 'codex-package', False),
        (native, '/runtime/platform/vendor/x86_64-unknown-linux-musl/bin/codex', 'codex-native', True),
    ]
    rows = [dict(source=str(source), destination=dest, **{'class': kind}, executable=execute)
            for source, dest, kind, execute in rows]
    action = staging.canonical(action)
    # Bind action identity as well as its exact git blob across resolver probes.
    action_before = supply.observe(action, staging)
    action_bytes = action.read_bytes()
    blob = hashlib.sha1(b'blob ' + str(len(action_bytes)).encode() + b'\0' + action_bytes).hexdigest()
    require(blob == supply.ACTION_BLOB, 'unexpected-action-blob')
    before = {row['source']: supply.observe(Path(row['source']), staging) for row in rows}
    for name, expected_name, expected_version in (
            (package, '@openai/codex', '0.159.3'),
            (platform, '@openai/codex', '0.159.3-linux-x64')):
        metadata = json.loads((name / 'package.json').read_bytes())
        require(metadata['name'] == expected_name and metadata['version'] == expected_version,
                'unexpected-package-identity')
    require(version([str(node), '--version']).startswith('v24.'), 'unexpected-node-version')
    require(version([str(node), str(entry), '--version'], package)
            == version([str(native), '--version'], package) == 'codex-cli 0.159.3',
            'launcher-parity-failed')
    require(supply.observe(action, staging) == action_before, 'action-drift')
    setup = {**supply.SETUP, 'sources': before}
    prepared = supply.PreparedSupply(rows, setup=setup, excluded_roots=[workspace],
                                     root_api=root_api, staging_api=staging)
    return prepared


def main():
    # Exact workflow argv; no environment/credential inheritance into probes.
    if len(sys.argv) != 7:
        raise ValueError('invalid-proof-invocation')
    node, launcher, action, workspace, head, runner_environment = sys.argv[1:]
    supply, staging = load('trusted-runtime-supply'), load('product-runtime-staging')
    root_api = load('product-npm-orchestrator').CanonicalRoot
    require = supply.require
    require(runner_environment == 'github-hosted' and os.getuid() == os.getgid() == 0,
            'independent-root-runner-required')
    require(re.fullmatch('[0-9a-f]{40}', head), 'invalid-head')
    workspace = staging.canonical(workspace)
    observed_head = subprocess.run(['/usr/bin/git', '-c', 'safe.directory=' + str(workspace),
                                    '-C', str(workspace), 'rev-parse', 'HEAD'],
                                   check=True, capture_output=True).stdout.decode().strip()
    require(observed_head == head, 'head-mismatch')
    expected_action = workspace.parent.parent / '_actions/openai/codex-action' / PIN / 'dist/main.js'
    require(Path(action) == expected_action, 'unexpected-action-path')
    prepared = resolve(Path(node), Path(launcher), Path(action), workspace, supply, staging, root_api)
    # Bounded names only: no source paths, xattr values or value digests in logs.
    observations = [('pinned-action', supply.observe(Path(action), staging))]
    observations += [(row['class'], evidence) for row, _, evidence in prepared._rows]
    for kind, evidence in observations:
        print(json.dumps({'class': kind, 'uid': evidence[1][2],
                          'mode': oct(evidence[1][4] & 0o7777), 'mount': evidence[2],
                          'ancestor_modes': [oct(a[0][4] & 0o7777) for a in evidence[0]],
                          'xattr_names': [name for name, _ in evidence[4]],
                          'ancestor_xattr_names': [[name for name, _ in a[2]]
                                                   for a in evidence[0]]}, sort_keys=True))
    # Demonstrate #738 authority refusal without modifying actual host sources.
    try:
        staging.authority(type('Info', (), {'st_uid': 0, 'st_mode': 0o40777})(), {0},
                          directory=True, sticky_parent=True)
    except ValueError as error:
        require(str(error) == 'unsafe-writable-authority', 'wrong-authority-rejection')
    else:
        raise ValueError('writable-authority-accepted')
    parent = Path(tempfile.mkdtemp(prefix='runtime-supply-proof-', dir='/var/lib'))
    try:
        stage_parent = parent / 'staging'
        stage_parent.mkdir(mode=0o700)
        with prepared.snapshot(parent) as sealed:
            accepted = sealed.prepared_runtime()
            accepted.verify()
            require(all(Path(row['source']).is_relative_to(sealed.path)
                        for row in accepted.inventory()['files']), 'original-source-exposed')
            with accepted.stage(stage_parent) as staged:
                staged.verify()
            sealed.verify()
            # Privileged test mutation is detected before any further handoff.
            target = sealed.path / 'runtime/node'
            target.chmod(0o755)
            try:
                sealed.prepared_runtime()
            except ValueError:
                pass
            else:
                raise ValueError('post-seal-mutation-accepted')
        require(list(parent.iterdir()) == [stage_parent] and not list(stage_parent.iterdir()),
                'proof-cleanup-failed')
    finally:
        shutil.rmtree(parent)
    require(not parent.exists(), 'proof-cleanup-failed')
    print('Runtime supply: actual setup-only / ext4 authority / sealed #738 acceptance / cleanup PASS')


if __name__ == '__main__':
    main()
