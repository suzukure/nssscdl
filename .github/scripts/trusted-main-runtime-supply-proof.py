#!/usr/bin/env python3
"""#747 closed trusted-main proof infrastructure, never a PR fixture launcher.

No event inputs, model call, workspace/cache workload or serialized handoff.
CLI emits bounded names/classes only; internal #741 hashes never reach logs.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent
SUPPLY_PARENT = Path('/var/lib')
MAX_RECORDS = 192
MAX_OUTPUT = 128 * 1024
FILESYSTEM_REASONS = frozenset((
    'invalid-mount-table', 'unsupported-mount-coordinate', 'missing-mount-table',
    'ambiguous-mount-root', 'mount-device-mismatch', 'unsupported-authority-filesystem'))


def require(value, reason):
    if not value:
        raise ValueError(reason)


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    with path.open('rb') as stream:
        data = stream.read(65537)
    require(len(data) <= 65536, 'metadata-limit')
    return json.loads(data)


def runtime_rows():
    """Closed Linux x64 npm layout; version probes remain unprivileged."""
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'unsupported-platform')
    node, launcher = shutil.which('node'), shutil.which('codex')
    require(node and launcher, 'runtime-missing')
    node, entry = Path(node).resolve(strict=True), Path(launcher).resolve(strict=True)
    package = entry.parent.parent
    require(entry == package / 'bin/codex.js', 'unsupported-package-layout')
    metadata = read_json(package / 'package.json')
    require(metadata.get('name') == '@openai/codex'
            and metadata.get('version') == '0.159.3'
            and metadata.get('optionalDependencies', {}).get('@openai/codex-linux-x64')
                == 'npm:@openai/codex@0.159.3-linux-x64', 'package-identity-mismatch')
    # Node's upward package search, constrained to the two npm install layouts.
    candidates = [package / 'node_modules/@openai/codex-linux-x64',
                  package.parent / 'codex-linux-x64']
    candidates = [p for p in candidates if (p / 'package.json').is_file()]
    require(len(candidates) == 1, 'unsupported-native-layout')
    native_package = candidates[0].resolve(strict=True)
    native_metadata = read_json(native_package / 'package.json')
    require(native_metadata.get('name') == '@openai/codex'
            and native_metadata.get('version') == '0.159.3-linux-x64', 'native-identity-mismatch')
    native = native_package / 'vendor/x86_64-unknown-linux-musl/bin/codex'
    values = ((node, '/runtime/node', 'node-runtime', True),
              (entry, '/runtime/codex/bin/codex.js', 'codex-package', True),
              (package / 'package.json', '/runtime/codex/package.json', 'codex-package', False),
              (native_package / 'package.json', '/runtime/native/package.json', 'codex-package', False),
              (native, '/runtime/native/codex', 'codex-native', True))
    return [dict(source=str(p), destination=d, **{'class': c}, executable=x)
            for p, d, c, x in values]


def mount_diagnostics(path, device, supply):
    """Keep #741 global escaped-coordinate rejection, identify unrelated rows."""
    with Path('/proc/self/mountinfo').open('rb') as stream:
        data = stream.read(1024 * 1024 + 1)
    require(len(data) <= 1024 * 1024, 'mount-observation-limit')
    lines = data.decode('utf-8', 'strict').splitlines()
    require(len(lines) <= 4096, 'mount-observation-limit')
    escaped, matching = [], []
    for line in lines:
        fields = line.split()
        require(len(fields) >= 10 and '-' in fields[6:], 'invalid-mount-table')
        separator = fields.index('-', 6)
        require(len(fields) > separator + 3, 'invalid-mount-table')
        point = Path(fields[4])
        matches = path == point or point in path.parents
        if matches:
            matching.append((len(point.parts), identifier(fields[0]),
                             identifier(fields[separator + 1])))
        if '\\' in fields[3] + fields[4]:
            escaped.append(dict(mount_id=identifier(fields[0]), device=identifier(fields[2]),
                                filesystem=identifier(fields[separator + 1]),
                                coordinate_class='escaped',
                                relation='target' if matches else 'unrelated'))
    require(len(escaped) <= 32, 'mount-observation-limit')
    try:
        mount = supply.filesystem(path, device)
        return dict(status='pass', reason=None, mount_id=identifier(mount[0]),
                    device=identifier(mount[1]), filesystem=identifier(mount[4]), escaped=escaped)
    except ValueError as error:
        reason = str(error)
        require(reason in FILESYSTEM_REASONS, 'mount-observation-failed')
        # No mount coordinate, source device path or options are exposed.
        deepest = [row for row in matching if row[0] == max(r[0] for r in matching)] if matching else []
        return dict(status='error', reason=reason,
                    mount_id=deepest[0][1] if len(deepest) == 1 else None,
                    device=f'{os.major(device)}:{os.minor(device)}',
                    filesystem=deepest[0][2] if len(deepest) == 1 else None, escaped=escaped)


def identifier(value):
    require(re.fullmatch('[a-zA-Z0-9_:.+-]{1,32}', value), 'invalid-mount-identifier')
    return value


def observation(rows, supply):
    """Read-only no-follow walk; exact names and bounded ACL semantics, no values."""
    records = []
    for row in [*rows, {'source': str(SUPPLY_PARENT), 'class': 'sealed-parent'}]:
        path = Path(row['source'])
        require(path.is_absolute() and len(path.parts) <= 32, 'observation-depth-limit')
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        current = Path('/')
        try:
            for index, part in enumerate((None, *path.parts[1:])):
                if part is not None:
                    current /= part
                    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                    if current != path or row['class'] == 'sealed-parent':
                        flags |= os.O_DIRECTORY
                    child = os.open(part, flags, dir_fd=fd)
                    os.close(fd)
                    fd = child
                info = os.fstat(fd)
                require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'unsafe-observation-type')
                try:
                    names = sorted(os.listxattr(fd))
                except OSError as error:
                    records.append(dict(source_class=row['class'],
                                        ancestor_depth=len(path.parts) - 1 - index,
                                        status='error', reason='xattr-observation-failed', errno=error.errno))
                    break
                require(len(names) <= 32 and all(len(os.fsencode(n)) <= 255 for n in names),
                        'xattr-observation-limit')
                mount = mount_diagnostics(current, info.st_dev, supply)
                acceptable = not names if row['class'] == 'sealed-parent' else all(
                    supply.source_xattr_name(n) for n in names)
                reason = None if acceptable else 'unsupported-xattr-authority'
                acl_summaries = {}
                if acceptable and row['class'] != 'sealed-parent':
                    try:
                        for name in names:
                            if name in supply.SOURCE_ACLS:
                                acl_summaries[name] = supply.decode_source_acl(
                                    name, os.getxattr(fd, name), info.st_mode)
                        require(sorted(os.listxattr(fd)) == names, 'source-drift')
                    except ValueError as error:
                        require(str(error) in {'invalid-source-acl', 'source-acl-type', 'source-drift'},
                                'xattr-observation-failed')
                        acceptable, reason = False, str(error)
                    except OSError:
                        acceptable, reason = False, 'xattr-observation-failed'
                records.append(dict(source_class=row['class'], ancestor_depth=len(path.parts) - 1 - index,
                                    xattr_names=names, mount=mount, status='pass' if acceptable else 'error',
                                    reason=reason, acl_summaries=acl_summaries))
                require(len(records) <= MAX_RECORDS, 'observation-record-limit')
        except OSError as error:
            records.append(dict(source_class=row['class'],
                                ancestor_depth=len(path.parts) - 1 - index,
                                status='error', reason='descriptor-observation-failed', errno=error.errno))
        finally:
            os.close(fd)
    return dict(schema='runtime-supply-observation', version=1,
                status='pass' if all(r['status'] == 'pass' and r['mount']['status'] == 'pass' for r in records)
                else 'error', records=records)


class VersionParityError(ValueError):
    def __init__(self, diagnostic):
        super().__init__('version-parity-failed')
        self.diagnostic = diagnostic


def version_parity(rows):
    """Production identity semantics: strip trailing LF only, ignore stderr.

    Keep the closed preparation env and privilege drop; never retry in an
    inherited environment or reflect process output/exception/identity values.
    """
    runner = pwd.getpwnam('runner')
    require(runner.pw_uid != 0, 'invalid-probe-user')
    node, entry, _, _, native = (Path(row['source']) for row in rows)
    environment = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': '/nonexistent',
                   'LC_ALL': 'C', 'CODEX_MANAGED_BY_NPM': '1',
                   'CODEX_MANAGED_PACKAGE_ROOT': str(entry.parent.parent)}
    expected = b'codex-cli 0.159.3'
    outputs, probes = [], []
    for name, command in (('launcher', [str(node), str(entry), '--version']),
                          ('native', [str(native), '--version'])):
        stdout = stderr = None
        try:
            result = subprocess.run(command, cwd='/', env=environment, capture_output=True,
                                    timeout=20, user=runner.pw_uid, group=runner.pw_gid, extra_groups=())
            stdout, stderr = result.stdout, result.stderr
            exit_class = 'zero' if result.returncode == 0 else (
                'signal' if result.returncode < 0 else 'nonzero')
        except subprocess.TimeoutExpired as error:
            exit_class = 'timeout'
            stdout, stderr = error.output, error.stderr
        except OSError:
            exit_class = 'exec-error'
        normalized = stdout.rstrip(b'\n') if stdout is not None else None
        exact = normalized == expected
        stdout_class = ('unavailable' if stdout is None else
                        'exact-line' if stdout == expected + b'\n' else
                        'exact-identity' if exact else
                        'format-mismatch' if stdout.strip(b' \t\r\n') == expected else
                        'identity-mismatch')
        reason = ('probe-' + exit_class if exit_class != 'zero' else
                  'stdout-' + stdout_class if not exact else None)
        probes.append(dict(probe=name, status='error' if reason else 'pass', reason=reason,
                           exit_class=exit_class, stdout_class=stdout_class,
                           stdout_bytes=len(stdout) if stdout is not None else None,
                           stderr_bytes=len(stderr) if stderr is not None else None,
                           stderr_present=bool(stderr)))
        # Timeout output cannot establish parity, even if it contains the identity.
        outputs.append(normalized if exit_class in ('zero', 'nonzero', 'signal') else None)
    parity = outputs[0] == outputs[1] if all(v is not None for v in outputs) else None
    diagnostic = dict(environment='closed', parity=parity, probes=probes)
    if not all(p['status'] == 'pass' for p in probes) or parity is not True:
        raise VersionParityError(diagnostic)
    return diagnostic


def prepare(rows, supply):
    require(os.getuid() == os.getgid() == 0, 'root-preparation-required')
    staging = load('product-runtime-staging')
    root_api = load('product-npm-orchestrator').CanonicalRoot
    # Parent memory evidence spans unprivileged probes; never import a claim.
    setup = {**supply.SETUP, 'sources': {
        row['source']: supply.observe(Path(row['source']), staging) for row in rows}}
    parity = version_parity(rows)
    bound = supply.PreparedSupply(rows, setup=setup, excluded_roots=[SCRIPTS.parents[1]],
                                  root_api=root_api, staging_api=staging)
    with tempfile.TemporaryDirectory(prefix='runtime-supply-proof-', dir=SUPPLY_PARENT) as temporary:
        with bound.snapshot(Path(temporary)) as sealed:
            sealed.verify()
            sealed.prepared_runtime().verify()
    return dict(schema='runtime-supply-proof', version=1, status='pass',
                scope='setup-seal-prepared-handoff', c0_decision='not-made', version_parity=parity)


def check_checkout(supply):
    expected = os.environ.get('PROOF_SHA', '')
    require(re.fullmatch('[0-9a-f]{40}', expected), 'invalid-trusted-sha')
    result = subprocess.run(['/usr/bin/git', '-c', 'safe.directory=' + str(SCRIPTS.parents[1]),
                             'rev-parse', 'HEAD'], cwd=SCRIPTS.parents[1],
                            env={'PATH': '/usr/bin:/bin'}, capture_output=True, check=True)
    require(result.stdout.decode().strip() == expected, 'checkout-sha-mismatch')
    # Pin the existing resolver Action bundle as #741 requires.
    action = SCRIPTS.parents[2].parent / '_actions/openai/codex-action/86365089eb2b84e0a8fb0717b304f8bdcb13b20e/dist/main.js'
    data = action.read_bytes()
    require(hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            == supply.ACTION_BLOB, 'action-blob-mismatch')


def main():
    try:
        require(sys.argv[1:] in (['--observe'], ['--prepare']), 'invalid-proof-mode')
        supply = load('trusted-runtime-supply')
        check_checkout(supply)
        rows = runtime_rows()
        if sys.argv[1] == '--observe':
            require(os.getuid() != 0, 'unprivileged-observer-required')
            result = observation(rows, supply)
        else:
            result = prepare(rows, supply)
        output = json.dumps(result, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
        require(len(output.encode()) <= MAX_OUTPUT, 'diagnostic-output-limit')
        print(output)
        return 0 if result['status'] == 'pass' else 1
    except VersionParityError as error:
        print(json.dumps(dict(schema='runtime-supply-proof', version=1, status='error',
                              reason='version-parity-failed', version_parity=error.diagnostic)))
        return 1
    except Exception as error:
        # Raw exception/path/package/subprocess output is never diagnostic data.
        reason = str(error) if type(error) is ValueError and str(error) in FILESYSTEM_REASONS | {
            'unsupported-xattr-authority', 'unprivileged-observer-required', 'root-preparation-required',
            'version-parity-failed', 'checkout-sha-mismatch', 'action-blob-mismatch',
            'diagnostic-output-limit', 'observation-record-limit', 'observation-depth-limit',
            'xattr-observation-limit', 'mount-observation-limit', 'invalid-proof-mode',
            'unsupported-native-layout', 'unsupported-package-layout', 'package-identity-mismatch',
            'native-identity-mismatch', 'runtime-missing', 'unsupported-platform', 'invalid-trusted-sha'
        } else 'proof-failed'
        print(json.dumps(dict(schema='runtime-supply-proof', version=1, status='error', reason=reason)))
        return 1


if __name__ == '__main__':
    sys.exit(main())
