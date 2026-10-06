#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
from contextlib import contextmanager, redirect_stdout, redirect_stderr
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
import yaml

repo = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('entry', repo / '.github/scripts/trusted-main-npm-bootstrap.py')
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)
helper = entry.load_orchestrator()
validator = helper.validator
sha = 'a' * 40
candidate = 'b' * 40
env = dict(BOOTSTRAP_EVENT='workflow_dispatch', BOOTSTRAP_DEFAULT_BRANCH='main',
           BOOTSTRAP_REF='refs/heads/main', BOOTSTRAP_SHA=sha,
           BOOTSTRAP_WORKFLOW_REF='owner/repo/' + entry.WORKFLOW + '@refs/heads/main',
           BOOTSTRAP_WORKFLOW_SHA=sha, GITHUB_REPOSITORY='owner/repo', CANDIDATE_SHA=candidate)
event = {'inputs': {'candidate_sha': candidate}}


def rejected(call):
    try:
        call()
    except (ValueError, validator.Rejected, OSError, subprocess.SubprocessError):
        return
    raise AssertionError('unsafe bootstrap accepted')


assert entry.source_gate(env, event) == (sha, candidate)
for key, value in (('BOOTSTRAP_EVENT', 'pull_request'), ('BOOTSTRAP_DEFAULT_BRANCH', 'other'),
                   ('BOOTSTRAP_REF', 'refs/heads/candidate'), ('BOOTSTRAP_SHA', 'main'),
                   ('BOOTSTRAP_WORKFLOW_SHA', candidate), ('CANDIDATE_SHA', '--help'),
                   ('BOOTSTRAP_WORKFLOW_REF', 'owner/repo/' + entry.WORKFLOW + '@refs/heads/candidate')):
    rejected(lambda: entry.source_gate({**env, key: value}, event))
for inputs in (None, {}, {'candidate_sha': candidate, 'command': 'npm install'},
               {'candidate_sha': sha}):
    rejected(lambda: entry.source_gate(env, {'inputs': inputs}))
for value in ('main', 'a' * 39, 'g' * 40, sha + '\n', '--help', sha + ':package.json'):
    assert not entry.exact_sha(value)

# Execute the actual inline source gate with only local event data.
workflow_text = (repo / entry.WORKFLOW).read_text()
workflow = yaml.safe_load(workflow_text)
assert workflow.get('on', workflow.get(True)) == {'workflow_dispatch': {'inputs': {
    'candidate_sha': {'description': 'root package.json を読む exact candidate commit SHA（40桁）',
                      'required': True, 'type': 'string'}}}}
assert workflow['permissions'] == {'contents': 'read'}
assert set(workflow['jobs']) == {'bootstrap'}
job = workflow['jobs']['bootstrap']
assert job['runs-on'] == 'ubuntu-24.04' and job['timeout-minutes'] == 10
steps = job['steps']
assert len(steps) == 5
assert steps[1]['with'] == {'ref': '${{ github.sha }}', 'persist-credentials': False}
assert steps[2]['run'] == ('set -euo pipefail\n'
                         'git -c core.hooksPath=/dev/null fetch --no-tags --depth=1 origin "$CANDIDATE_SHA"\n')
assert steps[3]['run'] == 'python3 -I -B .github/scripts/trusted-main-npm-bootstrap.py'
assert steps[4]['uses'] == 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
assert set(steps[4]) == {'name', 'uses', 'with'}  # Default success(), never always().
upload = steps[4]['with']
assert upload['if-no-files-found'] == 'error' and upload['retention-days'] == 3
assert upload['path'].splitlines() == ['${{ runner.temp }}/product-npm-bootstrap-artifact/' + name
    for name in ('package.json', 'package-lock.json', 'bootstrap-summary.json')]
assert all(term not in workflow_text for term in ('secrets.', 'vars.', 'pull_request',
    'codex-action', 'create-github-app-token', 'contents: write', 'git push', 'npm install'))
assert workflow_text.count('uses: actions/checkout@') == 1
inline = steps[0]['run'].split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
manifest = b'{"name":"candidate","version":"1.0.0","scripts":{"install":"exit 99"}}\n'
lock = json.dumps({'name': 'candidate', 'version': '1.0.0', 'lockfileVersion': 3,
                  'packages': {'': {'name': 'candidate', 'version': '1.0.0'}}}).encode()

with tempfile.TemporaryDirectory(prefix='manual-bootstrap-fixture-') as temporary:
    base = Path(temporary)
    event_path = base / 'event.json'
    for gate_env, gate_event, expected in ((env, event, 0),
            ({**env, 'BOOTSTRAP_EVENT': 'pull_request'}, event, 1),
            ({**env, 'BOOTSTRAP_WORKFLOW_SHA': candidate}, event, 1),
            (env, {'inputs': {**event['inputs'], 'path': 'other'}}, 1),
            ({**env, 'CANDIDATE_SHA': 'invalid'}, event, 1)):
        event_path.write_text(json.dumps(gate_event))
        result = subprocess.run([sys.executable, '-I', '-B', '-c', inline],
            env={**gate_env, 'GITHUB_EVENT_PATH': str(event_path)}, capture_output=True)
        assert result.returncode == expected

    # Real Git object reader: isolated object database, no refs/branches/checkout.
    objects = base / 'objects'
    objects.mkdir()
    subprocess.run(['/usr/bin/git', 'init', '-q', str(objects)], check=True, env=entry.ENV)

    def object_write(kind, payload):
        return subprocess.run(['/usr/bin/git', 'hash-object', '-w', '--stdin', '-t', kind],
            input=payload, cwd=objects, env=entry.ENV, capture_output=True, check=True).stdout.strip()

    def candidate_object(data, mode=b'100644', name=b'package.json'):
        blob = object_write('blob', data)
        tree = object_write('tree', mode + b' ' + name + b'\0' + bytes.fromhex(blob.decode()))
        commit = object_write('commit', b'tree ' + tree +
            b'\nauthor Fixture <fixture@example.invalid> 1 +0000\n'
            b'committer Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n')
        return commit.decode()

    real_candidate = candidate_object(manifest)
    assert entry.candidate_manifest(objects, real_candidate.upper(), validator) == manifest
    for invalid in (sha, 'main', candidate_object(manifest, name=b'other.json'),
                    candidate_object(b'package.json', mode=b'120000'),
                    candidate_object(manifest, mode=b'40000'),
                    candidate_object(b'{broken'),
                    candidate_object(b'{"dependencies":{"example":"^1.0.0"}}')):
        rejected(lambda: entry.candidate_manifest(objects, invalid, validator))
    with patch.object(validator, 'MAX_INPUT', len(manifest) - 1):
        rejected(lambda: entry.candidate_manifest(objects, real_candidate, validator))
    for specifier in ('latest', 'git+https://example.invalid/repo', 'file:./local',
                      'https://example.invalid/a.tgz'):
        invalid = candidate_object(json.dumps({'dependencies': {'example': specifier}}).encode())
        rejected(lambda: entry.candidate_manifest(objects, invalid, validator))

    runtime = helper.load('npm-registry-lock-runtime')
    original_load = helper.load
    calls = []
    fault = None

    def generate(selected_repo, snapshot, root):
        calls.append('generate')
        assert selected_repo == repo and snapshot == manifest
        if fault == 'unavailable':
            raise validator.Rejected('official-registry-unavailable')
        artifact = root / 'validated-lock-fixture'
        artifact.mkdir(mode=0o700)
        expected = dict(schema_version=1, status='validated', validation='pass',
            manifest_sha256=entry.digest(manifest), lock_sha256=entry.digest(lock),
            generated_lock_sha256=entry.digest(lock), artifact_path=str(artifact), artifact_id=artifact.name,
            contracts=runtime.contract_identities(repo), runtime_source=dict(node_version='v24.0.0',
                npm_version='11.0.0', node_sha256='c' * 64, npm_cli_sha256='d' * 64))
        if fault == 'hash':
            expected['lock_sha256'] = 'e' * 64
        if fault == 'source':
            expected['contracts'] = {}
        for name, data in (('package.json', manifest), ('package-lock.json', lock),
                           ('provenance.json', json.dumps(expected).encode())):
            (artifact / name).write_bytes(data)
            (artifact / name).chmod(0o400)
        return artifact, expected

    output = base / 'output'
    real_verify = entry.verify_export
    real_bootstrap = helper.bootstrap

    @contextmanager
    def bootstrap(*args):
        calls.append('bootstrap')
        with real_bootstrap(*args) as validated:
            yield validated
        if fault == 'cleanup':
            raise OSError('fixture cleanup failure')

    def verify(path, pair, summary, orchestrator):
        if fault == 'export-mutation' and path == output:
            (path / 'package-lock.json').chmod(0o600)
            (path / 'package-lock.json').write_bytes(lock + b' ')
            (path / 'package-lock.json').chmod(0o400)
        return real_verify(path, pair, summary, orchestrator)

    with patch.object(entry, 'authority'), \
         patch.object(entry, 'candidate_manifest', return_value=manifest), \
         patch.object(helper, 'load', side_effect=lambda name: runtime if name == 'npm-registry-lock-runtime'
                      else original_load(name)), \
         patch.object(runtime, 'generate_validated', side_effect=generate), \
         patch.object(helper, 'bootstrap', side_effect=bootstrap), \
         patch.object(entry, 'verify_export', side_effect=verify), \
         patch.dict(os.environ, {'RUNNER_TEMP': str(base)}):
        entry.export_bootstrap(repo, sha, candidate, output, helper)
        assert calls == ['bootstrap', 'generate']
        summary = (output / 'bootstrap-summary.json').read_bytes()
        record = json.loads(summary)
        assert len(summary) <= entry.MAX_SUMMARY
        assert record['candidate_sha'] == candidate and record['trusted_main_sha'] == sha
        assert record['manifest_sha256'] == entry.digest(manifest)
        assert record['lock_sha256'] == entry.digest(lock)
        assert record['source_contract'] == 'npm-official-tarball-with-integrity-v1'
        assert str(base).encode() not in summary and b'artifact_path' not in summary
        assert record['contracts'] == runtime.contract_identities(repo)
        assert record['orchestrator_contracts'] == helper.contracts()
        assert helper.read_pair(output) == (manifest, lock)
        entry.shutil.rmtree(output)
        for fault in ('unavailable', 'hash', 'source', 'cleanup', 'export-mutation'):
            calls.clear()
            rejected(lambda: entry.export_bootstrap(repo, sha, candidate, output, helper))
            assert calls == ['bootstrap', 'generate'] and not output.exists(), fault
        fault = None
        with patch.object(entry, 'MAX_SUMMARY', 1):
            rejected(lambda: entry.export_bootstrap(repo, sha, candidate, output, helper))
        assert not output.exists()
        with patch.object(entry, 'authority', side_effect=ValueError('source drift')):
            rejected(lambda: entry.export_bootstrap(repo, sha, candidate, output, helper))
        assert not output.exists()

        # Exercise the actual Actions diagnostic interface, including suppressed
        # shared-runtime output and failures before/after publication.
        output = base / 'product-npm-bootstrap-artifact'
        event_path.write_text(json.dumps(event))
        canary = 'EXCEPTION_CANARY /private/absolute-canary ENVIRONMENT_CANARY'

        def fail(*args, **kwargs):
            print('STDOUT_CANARY ' + canary)
            print('STDERR_CANARY ' + canary, file=sys.stderr)
            raise subprocess.CalledProcessError(1, ['fixture'], output=canary, stderr=canary)

        def noisy_generate(*args):
            print('STDOUT_CANARY')
            print('STDERR_CANARY', file=sys.stderr)
            return generate(*args)

        @contextmanager
        def failed_context(*args):
            fail()
            yield

        real_prepare = helper.prepare

        @contextmanager
        def prepare_cleanup(*args):
            with real_prepare(*args) as handle:
                yield handle
            fail()

        @contextmanager
        def bootstrap_cleanup(*args):
            with real_bootstrap(*args) as handle:
                yield handle
            fail()

        original_temporary = entry.tempfile.TemporaryDirectory

        @contextmanager
        def temporary_cleanup(*args, **kwargs):
            with original_temporary(*args, **kwargs) as path:
                yield path
            if kwargs.get('prefix') == 'npm-bootstrap-export-':
                fail()

        def at_call(original, index, noisy=True):
            count = 0
            def invoke(*args, **kwargs):
                nonlocal count
                count += 1
                if count == index:
                    if noisy:
                        fail()
                    raise ValueError(canary)
                return original(*args, **kwargs)
            return invoke

        def main_result(expected=None, reason="internal"):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                result = entry.main()
            assert err.getvalue() == ''
            if expected is None:
                assert result == 0
                assert out.getvalue() == 'trusted-main npm bootstrap: 検証済み artifact の生成完了\n'
                assert set(os.listdir(output)) == {'package.json', 'package-lock.json', 'bootstrap-summary.json'}
                assert helper.read_pair(output) == (manifest, lock)
                assert (output / 'bootstrap-summary.json').read_bytes() == summary
                entry.shutil.rmtree(output)
            else:
                assert result == 1, expected
                assert out.getvalue() == ('trusted-main npm bootstrap: 検証または cleanup が失敗しました'
                                          + ' (stage=' + expected
                                          + (' reason=' + reason if expected == 'bootstrap_enter' else '')
                                          + ')\n'), expected
                assert not output.exists(), expected

        seen = set()
        with patch.dict(os.environ, {**env, 'GITHUB_EVENT_PATH': str(event_path),
                                     'DIAGNOSTIC_ENV_CANARY': 'ENVIRONMENT_CANARY'}), \
             patch.object(entry, 'load_orchestrator', return_value=helper), \
             patch.object(runtime, 'generate_validated', side_effect=noisy_generate):
            main_result()
            cases = [
                (entry, 'source_gate', at_call(lambda *args: None, 1, noisy=False), 'internal'),
                (entry, 'load_orchestrator', fail, 'internal'),
                (entry, 'candidate_manifest', fail, 'candidate_manifest'),
                (helper, 'prepare', failed_context, 'prepare_input'),
                (helper.Handoff, 'verify', fail, 'prepare_input'),
                (helper, 'bootstrap', failed_context, 'bootstrap_enter'),
                (runtime, 'generate_validated', fail, 'bootstrap_enter'),
                # The first verify is inside shared bootstrap __enter__.
                *[(helper.ValidatedBootstrap, 'verify',
                   at_call(helper.ValidatedBootstrap.verify, index), stage)
                  for index, stage in ((1, 'bootstrap_enter'), (2, 'bootstrap_verify'),
                                       (3, 'bootstrap_verify'))],
                (entry, 'summary_record', fail, 'summary'),
                (helper, 'bootstrap', bootstrap_cleanup, 'bootstrap_cleanup'),
                (helper, 'prepare', prepare_cleanup, 'bootstrap_cleanup'),
                (entry.tempfile, 'TemporaryDirectory', temporary_cleanup, 'export_cleanup'),
                *[(entry, 'verify_export', at_call(real_verify, index), 'export_verify')
                  for index in (1, 2, 3)],
                *[(entry, 'authority', at_call(lambda *args: None, index, noisy=False),
                   'authority_recheck') for index in (1, 2, 3)],
            ]
            for target, name, injection, stage in cases:
                with patch.object(target, name, side_effect=injection, autospec=isinstance(target, type)):
                    main_result(stage)
                seen.add(stage)
            for fault, stage in (('unavailable', 'bootstrap_enter'), ('hash', 'bootstrap_enter'),
                                 ('source', 'bootstrap_enter'), ('cleanup', 'bootstrap_cleanup'),
                                 ('export-mutation', 'export_verify')):
                main_result(stage, 'candidate_validation' if fault in ('unavailable', 'hash', 'source')
                            else 'internal')
            fault = None
            assert entry.REASONS == runtime.REASONS
            for reason in (*sorted(entry.REASONS), 'CANARY_UNKNOWN', None, {},
                           {'reason': 'metadata_prefetch'}):
                error = runtime.GenerationFailure(reason)
                with patch.object(runtime, 'generate_validated', side_effect=error):
                    main_result('bootstrap_enter', reason if type(reason) is str and
                                reason in entry.REASONS else 'internal')
            # Even a forged/malformed reason attribute must pass the entry allowlist.
            for reason in ('EXCEPTION_CANARY', '/private/absolute-canary', None, {},
                           {'reason': 'npm_generation'}):
                error = RuntimeError(canary)
                error.bootstrap_reason = reason
                with patch.object(runtime, 'generate_validated', side_effect=error):
                    main_result('bootstrap_enter')
            main_result()
        assert seen == entry.STAGES

# Unknown diagnostic state cannot be reflected into an Actions log.
diagnostic = entry.Diagnostic()
for invalid in ('EXCEPTION_CANARY\n::error::', '/private/absolute-canary', None, {}):
    diagnostic.stage = invalid
    assert diagnostic.code() == 'internal'

# No independent production AI session or locked preparation is admitted.
source = (repo / entry.HELPER).read_text()
assert all(term not in source for term in ('production_session(', 'prepare_bootstrap(', 'shell=True',
                                         'git push', 'git commit', 'os.environ.copy'))
assert source.count("with_name('product-npm-orchestrator.py')") == 1
print('trusted-main bootstrap: source/ref gate, Git object data, canonical API, bounded diagnostic/export and failure cleanup passed')
PY
