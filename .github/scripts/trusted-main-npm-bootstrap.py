#!/usr/bin/env python3
"""#792 secretless manual entry; candidate objects are data, never authority."""
from contextlib import redirect_stdout, redirect_stderr
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

WORKFLOW = '.github/workflows/trusted-main-npm-bootstrap.yml'
HELPER = '.github/scripts/trusted-main-npm-bootstrap.py'
MAX_SUMMARY = 32 * 1024
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'GIT_NO_REPLACE_OBJECTS': '1'}
STAGES = frozenset(('internal', 'candidate_manifest', 'prepare_input', 'bootstrap_enter',
                    'bootstrap_verify', 'bootstrap_cleanup', 'summary', 'export_verify',
                    'export_cleanup', 'authority_recheck'))


class Diagnostic:
    """Entry boundaries only; shared runtime internals remain opaque (#795)."""
    def __init__(self):
        self.stage = 'internal'

    def code(self):
        return self.stage if type(self.stage) is str and self.stage in STAGES else 'internal'


def require(condition):
    if not condition:
        raise ValueError('bootstrap boundary rejected')


def exact_sha(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-fA-F]{40}', value) is not None


def source_gate(env, event):
    sha = env.get('BOOTSTRAP_SHA', '')
    candidate = env.get('CANDIDATE_SHA', '')
    require(env.get('BOOTSTRAP_EVENT') == 'workflow_dispatch'
            and env.get('BOOTSTRAP_DEFAULT_BRANCH') == 'main'
            and env.get('BOOTSTRAP_REF') == 'refs/heads/main'
            and env.get('BOOTSTRAP_WORKFLOW_REF') == env.get('GITHUB_REPOSITORY', '')
                + '/' + WORKFLOW + '@refs/heads/main'
            and re.fullmatch('[0-9a-f]{40}', sha) is not None
            and env.get('BOOTSTRAP_WORKFLOW_SHA') == sha
            and exact_sha(candidate)
            and event.get('inputs') == {'candidate_sha': candidate})
    return sha, candidate.lower()


def git(repo, *args):
    return subprocess.run(['/usr/bin/git', *args], cwd=repo, env=ENV,
                          check=True, capture_output=True, timeout=30).stdout


def authority(repo, sha):
    require(re.fullmatch('[0-9a-f]{40}', sha) is not None)
    require(git(repo, 'rev-parse', '--verify', 'HEAD').strip().decode('ascii') == sha)
    # Fixed trusted checkout only. No candidate path, imports or hooks are run.
    require(not git(repo, 'status', '--porcelain', '--untracked-files=all', '--',
                    '.github/scripts', WORKFLOW))
    require(not git(repo, 'diff', sha, '--', '.github/scripts', WORKFLOW))
    require(git(repo, 'show', sha + ':' + HELPER) == Path(__file__).read_bytes())


def load_orchestrator():
    source = Path(__file__).with_name('product-npm-orchestrator.py')
    spec = importlib.util.spec_from_file_location('trusted_bootstrap_orchestrator', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidate_manifest(repo, candidate, validator):
    require(exact_sha(candidate))
    candidate = candidate.lower()
    require(git(repo, 'cat-file', '-t', candidate) == b'commit\n')
    require(git(repo, 'rev-parse', '--verify', candidate + '^{commit}').strip()
            == candidate.encode('ascii'))
    row = git(repo, 'ls-tree', '-z', candidate, '--', 'package.json')
    require(row.endswith(b'\0') and row.count(b'\0') == 1)
    metadata, name = row[:-1].split(b'\t')
    mode, kind, blob = metadata.split(b' ')
    require(name == b'package.json' and mode in (b'100644', b'100755') and kind == b'blob'
            and re.fullmatch(b'[0-9a-f]{40}', blob) is not None)
    size = int(git(repo, 'cat-file', '-s', blob.decode('ascii')))
    require(0 < size <= validator.MAX_INPUT)
    snapshot = git(repo, 'cat-file', 'blob', blob.decode('ascii'))
    require(len(snapshot) == size)
    validator.manifest_dependencies(validator.parse(snapshot))
    return snapshot


def digest(data):
    return hashlib.sha256(data).hexdigest()


def summary_record(candidate, sha, pair, provenance, orchestrator):
    source = provenance['runtime_source']
    require(provenance['status'] == 'validated' and provenance['validation'] == 'pass'
            and provenance['manifest_sha256'] == digest(pair[0])
            and provenance['lock_sha256'] == provenance['generated_lock_sha256'] == digest(pair[1]))
    # Project only bounded identities; runtime paths and raw provenance stay private.
    result = dict(schema='trusted-main-npm-bootstrap', version=1, status='validated',
                  candidate_sha=candidate, trusted_main_sha=sha,
                  manifest_sha256=digest(pair[0]), lock_sha256=digest(pair[1]),
                  node_version=source['node_version'], npm_version=source['npm_version'],
                  runtime_hashes={key: source[key] for key in ('node_sha256', 'npm_cli_sha256')},
                  registry=orchestrator.validator.REGISTRY,
                  source_contract='npm-official-tarball-with-integrity-v1',
                  contracts=provenance['contracts'], orchestrator_contracts=orchestrator.contracts(),
                  entry={'source': HELPER, 'sha256': digest(Path(__file__).read_bytes())})
    require(re.fullmatch(r'v24\.\d+\.\d+', result['node_version']) is not None
            and re.fullmatch(r'\d+\.\d+\.\d+', result['npm_version']) is not None)
    payload = (json.dumps(result, sort_keys=True, ensure_ascii=True) + '\n').encode('ascii')
    require(len(payload) <= MAX_SUMMARY)
    return payload


def verify_export(path, pair, summary, orchestrator):
    orchestrator.private_directory(path)
    require(set(os.listdir(path)) == {'package.json', 'package-lock.json', 'bootstrap-summary.json'})
    for name in os.listdir(path):
        info = (path / name).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o400)
        orchestrator.no_acl(path / name)
    require(orchestrator.read_pair(path) == pair)
    fd = orchestrator.validator.directory(path)
    try:
        require(orchestrator.validator.read_input(fd, 'bootstrap-summary.json') == summary)
    finally:
        os.close(fd)
    record = orchestrator.validator.parse(summary)
    require(len(summary) <= MAX_SUMMARY and record['manifest_sha256'] == digest(pair[0])
            and record['lock_sha256'] == digest(pair[1]))
    orchestrator.validator.validate_lock(*map(orchestrator.validator.parse, pair))
    require(orchestrator.read_pair(path) == pair)


def export_bootstrap(repo, sha, candidate, output, orchestrator, diagnostic=None):
    diagnostic = diagnostic if diagnostic is not None else Diagnostic()
    diagnostic.stage = 'candidate_manifest'
    require(exact_sha(candidate) and not output.exists() and not output.is_symlink())
    candidate = candidate.lower()
    snapshot = candidate_manifest(repo, candidate, orchestrator.validator)
    published = False
    try:
        diagnostic.stage = 'prepare_input'
        # Default /tmp, outside repository and RUNNER_TEMP, with disjoint private roots.
        with tempfile.TemporaryDirectory(prefix='trusted-npm-bootstrap-', dir='/tmp') as temporary:
            base = Path(temporary)
            workspace, trusted = base / 'workspace', base / 'trusted'
            workspace.mkdir(mode=0o700)
            trusted.mkdir(mode=0o700)
            (workspace / 'package.json').write_bytes(snapshot)
            (workspace / 'package.json').chmod(0o400)
            with orchestrator.prepare(workspace, trusted, Path('unused'), Path('unused')) as input_handle:
                require(input_handle.verify()['status'] == 'bootstrap-required')
                diagnostic.stage = 'bootstrap_enter'
                with orchestrator.bootstrap(input_handle, trusted) as validated:
                    diagnostic.stage = 'bootstrap_verify'
                    provenance = validated.verify()
                    pair = orchestrator.read_pair(Path(provenance['artifact_path']))
                    require(pair[0] == snapshot and pair[1] is not None)
                    diagnostic.stage = 'summary'
                    summary = summary_record(candidate, sha, pair, provenance, orchestrator)
                    diagnostic.stage = 'bootstrap_verify'
                    require(validated.verify() == provenance)
                    diagnostic.stage = 'bootstrap_cleanup'
            # No handoff if any bootstrap/context cleanup raised or left artifacts.
            require(not list(trusted.iterdir()) and orchestrator.read_pair(workspace) == (snapshot, None))
        require(not base.exists())
        diagnostic.stage = 'authority_recheck'
        authority(repo, sha)
        diagnostic.stage = 'export_verify'
        # Staging is private and excluded from the upload's exact file list.
        with tempfile.TemporaryDirectory(prefix='npm-bootstrap-export-', dir=output.parent) as temporary:
            staged = Path(temporary) / 'artifact'
            staged.mkdir(mode=0o700)
            for name, data in zip(('package.json', 'package-lock.json', 'bootstrap-summary.json'),
                                  (*pair, summary)):
                (staged / name).write_bytes(data)
                (staged / name).chmod(0o400)
            verify_export(staged, pair, summary, orchestrator)
            require(not output.exists() and not output.is_symlink())
            staged.rename(output)
            published = True
            verify_export(output, pair, summary, orchestrator)
            diagnostic.stage = 'export_cleanup'
        require(not Path(temporary).exists())
        diagnostic.stage = 'authority_recheck'
        authority(repo, sha)
        diagnostic.stage = 'export_verify'
        verify_export(output, pair, summary, orchestrator)
    except BaseException:
        if published:
            shutil.rmtree(output)
        raise


def main():
    # Fixed environment-only interface; never reflect exception text or helper logs.
    diagnostic = Diagnostic()
    try:
        with open(os.environ['GITHUB_EVENT_PATH']) as stream:
            sha, candidate = source_gate(os.environ, json.load(stream))
        repo = Path(__file__).absolute().parents[2]
        diagnostic.stage = 'authority_recheck'
        authority(repo, sha)
        diagnostic.stage = 'internal'
        output = Path(os.environ['RUNNER_TEMP']) / 'product-npm-bootstrap-artifact'
        with open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
            export_bootstrap(repo, sha, candidate, output, load_orchestrator(), diagnostic)
        print('trusted-main npm bootstrap: 検証済み artifact の生成完了')
        return 0
    except Exception:
        print('trusted-main npm bootstrap: 検証または cleanup が失敗しました'
              + ' (stage=' + diagnostic.code() + ')')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
