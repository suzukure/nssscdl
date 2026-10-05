#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import importlib.util
from contextlib import contextmanager, redirect_stdout
import io
from types import SimpleNamespace
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
import yaml

repo = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('root_proof', repo / '.github/scripts/trusted-main-root-directory-proof.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
private = 'PRIVATE-DIAGNOSTIC'

# Exact trusted source/ref gate executes before checkout/setup/privilege.
workflow_path = repo / '.github/workflows/trusted-main-root-directory-proof.yml'
text = workflow_path.read_text()
workflow = yaml.safe_load(text)
assert workflow[True] == {'workflow_dispatch': None}
assert workflow['permissions'] == {'contents': 'read'}
steps = workflow['jobs']['proof']['steps']
assert len(steps) == 5 and steps[0]['name'] == 'Require exact trusted main source'
assert steps[1]['with'] == {'ref': '${{ github.sha }}', 'persist-credentials': False}
assert steps[2]['with'] == {'codex-version': '0.159.3',
    'codex-home': '${{ runner.temp }}/root-directory-proof-home',
    'safety-strategy': 'unsafe', 'allow-users': '*'}
assert steps[-1]['run'] == ('sudo -n /usr/bin/env -i PATH="$PATH" PROOF_SHA="$PROOF_SHA" \\\n'
    '  /usr/bin/python3 -I .github/scripts/trusted-main-root-directory-proof.py\n')
assert all(term not in text for term in ('secrets.', 'vars.', 'pull_request', 'inputs:', 'GH_TOKEN', 'openai-api-key'))
code = steps[0]['run'].split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
with tempfile.TemporaryDirectory() as temporary:
    event = Path(temporary) / 'event.json'
    env = dict(PATH='/usr/bin:/bin', GITHUB_EVENT_PATH=str(event), GITHUB_REPOSITORY='owner/repo',
        PROOF_EVENT='workflow_dispatch', PROOF_DEFAULT_BRANCH='main', PROOF_REF='refs/heads/main',
        PROOF_SHA='a'*40, PROOF_WORKFLOW_SHA='a'*40,
        PROOF_WORKFLOW_REF='owner/repo/.github/workflows/trusted-main-root-directory-proof.yml@refs/heads/main')
    def gate(change={}, inputs=None):
        event.write_text(json.dumps({'inputs': inputs}))
        return subprocess.run(['/usr/bin/python3', '-I', '-c', code], env={**env, **change}, capture_output=True).returncode
    assert gate() == gate(inputs={}) == 0
    for change in ({'PROOF_EVENT': 'pull_request'}, {'PROOF_EVENT': 'pull_request_target'},
                   {'PROOF_REF': 'refs/heads/candidate'}, {'PROOF_DEFAULT_BRANCH':'candidate'},
                   {'PROOF_SHA':'HEAD'}, {'PROOF_WORKFLOW_SHA':'b'*40},
                   {'PROOF_WORKFLOW_REF': env['PROOF_WORKFLOW_REF'].replace('@refs/heads/main', '@refs/heads/candidate')}):
        assert gate(change) != 0
    for key in ('path', 'command', 'property', 'bind', 'executable', 'sha'):
        assert gate(inputs={key: private}) != 0
    assert gate(inputs=[]) != 0

# Real #738 PreparedRuntime/SealedRoot; only target execution is synthetic.
with tempfile.TemporaryDirectory() as temporary:
    area = Path(temporary)
    source, parent, excluded = area/'source', area/'stage', area/'excluded'
    for path in (source, parent, excluded):
        path.mkdir(mode=0o755)
    binary = source / 'descriptor'
    binary.write_bytes(b'synthetic reserved executable; no target probe')
    binary.chmod(0o644)
    rows = [dict(source=str(binary), destination='/runtime/proof',
                 **{'class':'preflight-descriptor'}, executable=True)]
    def prepare():
        return helper.STAGING.PreparedRuntime(rows, trusted_uids={0, os.getuid(), Path('/').stat().st_uid, Path(tempfile.gettempdir()).stat().st_uid},
            excluded_roots=[excluded], root_api=helper.ROOT_API)
    prepared = prepare()
    with prepared.stage(parent) as sealed:
        with patch.object(helper.LIFECYCLE, 'execute', side_effect=AssertionError('unexpected execution')) as execute:
            result = helper.handoff(prepared, sealed)
            assert result['status'] == 'pass' and result['execution'] == 'not-requested'
            assert result['lifecycle'] is None
            for invalid in (sealed.path, str(sealed.path), {}, None):
                assert helper.handoff(prepared, invalid, request=True)['status'] == 'fail'
            for invalid in (1, 'true', {}, None):
                assert helper.handoff(prepared, sealed, request=invalid)['status'] == 'fail'
            execute.assert_not_called()
        unit = helper.LIFECYCLE.new_unit()
        launch = helper.descriptor(sealed, unit)
        helper.bound_launch(sealed, unit, launch)
        for altered in (launch + ('--unit='+unit,), tuple(a for a in launch if not a.startswith('--unit=')),
                        tuple('--unit='+helper.LIFECYCLE.new_unit() if a.startswith('--unit=') else a for a in launch),
                        launch+('--property=BindPaths=/usr',), launch[:-1]+('/bin/sh',), launch+(private,)):
            try:
                helper.bound_launch(sealed, unit, altered)
            except ValueError:
                pass
            else:
                raise AssertionError('unsafe closed launch accepted')
        # Invoke the REAL #783 helper and check failure propagation, no rc repair.
        for launch_rc, stop_rc, show_rc, data in itertools.product((0, 2), (0, 2, -15), (0, 4), (b'not-found\n', b'loaded\n')):
            calls = []
            def run(argv, **kwargs):
                index = len(calls)
                calls.append(argv)
                if index == 2:
                    kwargs['stdout'].write(data)
                return subprocess.CompletedProcess(argv, (launch_rc, stop_rc, show_rc)[index])
            with patch.object(helper.LIFECYCLE.subprocess, 'run', side_effect=run):
                result = helper.handoff(prepared, sealed, request=True)
            assert len(calls) == 3
            identity = next(arg[7:] for arg in calls[0] if arg.startswith('--unit='))
            assert calls[1][-1] == calls[2][4] == identity
            passed = launch_rc == 0 and stop_rc >= 0 and show_rc == 0 and data == b'not-found\n'
            assert result['status'] == ('pass' if passed else 'fail')
            assert result['status'] == result['lifecycle']['status']
            assert result['execution'] == 'requested'
            encoded = json.dumps(result)
            assert len(encoded.encode()) < 1024
            assert all(value not in encoded for value in (str(sealed.path), identity, private))
        with patch.object(helper.LIFECYCLE, 'execute') as execute:
            binary.write_bytes(b'drift')
            assert helper.handoff(prepared, sealed, request=True)['status'] == 'fail'
            execute.assert_not_called()
    assert not list(parent.iterdir())
    assert helper.handoff(prepared, sealed, request=True)['status'] == 'fail'
    prepared = prepare()
    with prepared.stage(parent) as sealed:
        (sealed.path/'runtime/proof').write_bytes(b'drift')
        with patch.object(helper.LIFECYCLE, 'execute') as execute:
            assert helper.handoff(prepared, sealed, request=True)['status'] == 'fail'
            execute.assert_not_called()

# Complete prepared composition keeps accepted handles alive and only reports
# success AFTER staging and supply cleanup. Production CLI never requests exec.
with tempfile.TemporaryDirectory() as temporary:
    area = Path(temporary)
    for name in ('source', 'excluded'):
        (area/name).mkdir()
    binary = area/'source/descriptor'
    binary.write_bytes(b'synthetic')
    prepared = helper.STAGING.PreparedRuntime([dict(source=str(binary),
        destination='/runtime/proof', **{'class':'preflight-descriptor'}, executable=True)],
        trusted_uids={0,os.getuid(),Path('/').stat().st_uid,Path(tempfile.gettempdir()).stat().st_uid},
        excluded_roots=[area/'excluded'], root_api=helper.ROOT_API)
    order=[]
    @contextmanager
    def snapshot(parent):
        order.append('supply')
        yield SimpleNamespace(verify=lambda: order.append('verify-supply'), prepared_runtime=lambda: prepared)
        order.append('cleanup-supply')
    @contextmanager
    def failed_cleanup(parent):
        yield SimpleNamespace(verify=lambda: None, prepared_runtime=lambda: prepared)
        raise OSError(private)
    observation={'stop':dict(exit_class='nonzero',rc=5),
                 'show':dict(exit_class='zero',rc=0,exact_not_found=True)}
    with patch.object(helper,'os',SimpleNamespace(getuid=lambda:0,getgid=lambda:0)), \
         patch.object(helper.PROOF,'check_checkout'), patch.object(helper.PROOF,'runtime_rows',return_value=[{'source':str(binary)}]), \
         patch.object(helper.PROOF,'version_parity'), patch.object(helper.PROOF,'SUPPLY_PARENT',area), \
         patch.object(helper.SUPPLY,'observe',return_value='held-observation'), \
         patch.object(helper.SUPPLY,'PreparedSupply',return_value=SimpleNamespace(snapshot=snapshot)) as constructor, \
         patch.object(helper,'observe_manager',return_value=observation), \
         patch.object(helper.LIFECYCLE,'execute') as execute:
        result=helper.prepare()
        assert result['status']=='pass' and result['handoff']['execution']=='not-requested'
        assert result['handoff']['sealed_root']=='accepted' and result['c0_decision']=='not-made'
        assert order[-1]=='cleanup-supply'
        assert constructor.call_args.kwargs['setup']['sources']=={str(binary):'held-observation'}
        execute.assert_not_called()
        assert sorted(p.name for p in area.iterdir())==['excluded','source']
        with patch.object(helper.SUPPLY,'PreparedSupply',return_value=SimpleNamespace(snapshot=failed_cleanup)), \
             patch.object(sys,'argv',['proof']), redirect_stdout(io.StringIO()) as output:
            assert helper.main()==1
            value=json.loads(output.getvalue())
            assert value['status']=='fail' and private not in output.getvalue()
        for args in (['--path',private],['--command',private],['--execute'],['--property',private]):
            with patch.object(sys,'argv',['proof',*args]), patch.object(helper,'prepare') as prepare, redirect_stdout(io.StringIO()):
                assert helper.main()==1
                prepare.assert_not_called()

# Bounded manager observation: exact bytes cannot override nonzero rc.
for rc, data in ((0,b'not-found\n'),(4,b'not-found\n'),(0,b'loaded\n'),(0,b'not-found\n'+private.encode())):
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        kwargs['stdout'].write(data)
        return subprocess.CompletedProcess(argv, rc)
    with patch.object(helper.LIFECYCLE.subprocess,'run',side_effect=run):
        observed = helper.observe_manager()
    assert len(calls)==2 and calls[0][-1]==calls[1][4]
    assert observed['show']['rc']==rc
    assert observed['show']['exact_not_found']==(data==b'not-found\n')
    assert private not in json.dumps(observed)
    with patch.object(helper,'os',SimpleNamespace(getuid=lambda:0,getgid=lambda:0)), \
         patch.object(helper.PROOF,'check_checkout'), patch.object(helper,'observe_manager',return_value=observed), \
         patch.object(helper.PROOF,'runtime_rows') as inventory:
        if rc or data!=b'not-found\n':
            result=helper.prepare()
            assert result['status']=='fail'
            assert result['reason']==('scope-decision-required' if rc==4 and data==b'not-found\n' else 'manager-proof-failed')
            inventory.assert_not_called()

print('RootDirectory prepared handoff: real seals, drift refusal, exact unit binding, lifecycle failure propagation, bounded manager record, trusted main gate PASS')
PY
