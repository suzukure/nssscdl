#!/usr/bin/env python3
"""#784 prepared-only trusted-main RootDirectory handoff (no production caller).

The workflow owns exact-main provenance; this process checks checkout identity.
Reuse #741 supply and #738 seals without importing serialized claims. The fixed
/runtime/proof slot is an INTERNAL reserved executable interface, no argv or
probe implementation. #739 owns its future target inventory and assertions.
Today's CLI never requests target execution. Synthetic fixtures alone exercise
that branch. No shell, host fallback, bind, property or executable input exists.

Result v1 contains acceptance, execution request, unchanged #783 lifecycle result
(including cleanup/residual), and bounded actual stop/show observations. Neither
result nor exceptions reflect command output, paths, environment or identities.
Manager transport failures fail closed; nonzero show with exact not-found needs
a human #783 Contract decision, never adapter normalization. Proof success here
is infrastructure evidence only, not actual #739 target evidence or C0 judgment.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STAGING = load('product-runtime-staging')
LIFECYCLE = load('systemd-transient-lifecycle')
SUPPLY = load('trusted-runtime-supply')
PROOF = load('trusted-main-runtime-supply-proof')
ROOT_API = load('product-npm-orchestrator').CanonicalRoot


def descriptor(sealed, unit):
    """Closed construction; inputs are parent-held seal and generated identity."""
    return ('sudo', '-n', '/usr/bin/systemd-run', '--quiet', '--wait', '--collect',
            '--unit=' + unit, '--property=RootDirectory=' + str(sealed.path),
            '--property=User=nobody', '--property=CapabilityBoundingSet=',
            '--property=AmbientCapabilities=', '--', '/runtime/proof')


def bound_launch(sealed, unit, launch):
    # Exact canonical tuple catches missing, duplicate, mismatched bindings and
    # any extra executable/argv/property/bind, before privileged execution.
    STAGING.require(type(launch) is tuple and launch == descriptor(sealed, unit)
                    and LIFECYCLE.valid_inputs(unit, launch, 30), 'invalid-launch-binding')
    STAGING.require([arg for arg in launch if arg.startswith('--unit=')]
                    == ['--unit=' + unit], 'invalid-launch-binding')


def handoff(prepared, sealed, *, request=False):
    result = dict(schema='prepared-root-directory-handoff', version=1,
                  status='fail', prepared_runtime='rejected', sealed_root='rejected',
                  execution='not-requested', lifecycle=None)
    try:
        STAGING.require(type(request) is bool, 'invalid-execution-request')
        STAGING.require(type(prepared) is STAGING.PreparedRuntime
                        and type(sealed) is STAGING.SealedRoot
                        and sealed._prepared is prepared, 'invalid-runtime-handle')
        unit = LIFECYCLE.new_unit()
        launch = descriptor(sealed, unit)
        bound_launch(sealed, unit, launch)
        if request:
            # Reserved slot must be an exact executable inventory entry; no host
            # path, JSON inventory, or caller-provided executable is authority.
            STAGING.require(any(row['destination'] == '/runtime/proof'
                                and row['executable'] for row in prepared._entries),
                            'missing-internal-executable')
        # Last operations before the privileged consumer; never weaken verify.
        prepared.verify()
        sealed.verify()
        result.update(prepared_runtime='accepted', sealed_root='accepted')
        if request:
            result['execution'] = 'requested'
            result['lifecycle'] = LIFECYCLE.execute(unit, launch, 30)
            result['status'] = result['lifecycle']['status']
        else:
            result['status'] = 'pass'
    except Exception:
        result['status'] = 'fail'
    return result


def observe_manager():
    """Actual absent-unit cleanup transport, not a target execution proof.

    Fixed commands match #783; only rc and exact absence classification escape.
    Do not reinterpret rc != 0 even if the manager returns absence text.
    """
    unit = LIFECYCLE.new_unit()
    record = {}
    for operation, tail in (('stop', ()), ('show', ('--property=LoadState', '--value'))):
        with tempfile.TemporaryFile() as stream:
            kind, rc = LIFECYCLE.invoke(
                ['sudo', '-n', '/usr/bin/systemctl', operation, unit, *tail], 10, stream)
            row = dict(exit_class=kind, rc=rc)
            if operation == 'show':
                stream.seek(0)
                row['exact_not_found'] = stream.read(33) in (b'not-found', b'not-found\n')
            record[operation] = row
    return record


def prepare():
    STAGING.require(os.getuid() == os.getgid() == 0, 'root-preparation-required')
    PROOF.check_checkout(SUPPLY)
    observed = observe_manager()
    show, stop = observed['show'], observed['stop']
    compatible = (show['exit_class'] == 'zero' and show['exact_not_found']
                  and stop['exit_class'] in ('zero', 'nonzero'))
    if not compatible:
        return dict(schema='root-directory-proof', version=1, status='fail',
                    reason='scope-decision-required' if show['exact_not_found']
                    and show['exit_class'] == 'nonzero' else 'manager-proof-failed',
                    manager=observed, handoff=None, c0_decision='not-made')
    rows = PROOF.runtime_rows()
    setup = {**SUPPLY.SETUP, 'sources': {
        row['source']: SUPPLY.observe(Path(row['source']), STAGING) for row in rows}}
    PROOF.version_parity(rows)
    bound = SUPPLY.PreparedSupply(rows, setup=setup, excluded_roots=[SCRIPTS.parents[1]],
                                  root_api=ROOT_API, staging_api=STAGING)
    with tempfile.TemporaryDirectory(prefix='root-directory-proof-', dir=PROOF.SUPPLY_PARENT) as area:
        parent = Path(area)
        supply_parent, stage_parent = parent / 'supply', parent / 'stage'
        supply_parent.mkdir(mode=0o755)
        stage_parent.mkdir(mode=0o755)
        with bound.snapshot(supply_parent) as supply_root:
            supply_root.verify()
            prepared = supply_root.prepared_runtime()
            with prepared.stage(stage_parent) as sealed:
                supply_root.verify()
                result = handoff(prepared, sealed)
    # All context cleanup completes BEFORE success can leave this process.
    return dict(schema='root-directory-proof', version=1, status=result['status'],
                manager=observed, handoff=result, c0_decision='not-made')


def main():
    try:
        STAGING.require(sys.argv[1:] == [], 'unexpected-input')
        result = prepare()
    except Exception:
        result = dict(schema='root-directory-proof', version=1, status='fail',
                      reason='proof-failed', c0_decision='not-made')
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
