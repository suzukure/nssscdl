#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import hashlib
from functools import lru_cache
from pathlib import Path
import stat
import subprocess
import sys
from unittest.mock import patch
import yaml

repo = Path(sys.argv[1])
scripts = '.github/scripts/'
workflows = '.github/workflows/'
selector_path = scripts + 'select-ai-workflow-fixtures.py'
selector_fixture = scripts + 'test-select-ai-workflow-fixtures.sh'
product = 'product-npm-orchestrator'
verifier = 'verify_post_workload'
session_runtime = 'product-npm-session-runtime.py'
session_probe = 'product-npm-session-probe.js'
runtime_staging = 'product-runtime-staging.py'
runtime_supply = 'trusted-runtime-supply.py'
supply_proof = 'runtime-supply-proof.py'
model_selector = 'select-codex-issue-model.py'
model_policy = 'codex-issue-model-policy.json'
exec_usage = 'extract-codex-exec-usage.py'
stream_supervisor = 'supervise-codex-exec-stream.py'
trusted_proof = 'trusted-main-runtime-supply-proof.py'
trusted_workflow = workflows + 'trusted-main-runtime-supply-proof.yml'
session_symbols = ('production_session', 'workload_session', '_WorkloadSession')
# Compose the packet filename so the preserved legacy packet fixture's exact
# reference scan does not mistake this test's own contract data for a caller.
packet = 'build-' + 'failure-evidence-packet.py'
contracts = ((product, product + '.py', 'product-npm', product),
             (session_runtime, session_runtime, 'product-npm', None),
             (session_probe, session_probe, 'product-npm', None),
             (runtime_staging, runtime_staging, 'product-npm', None),
             (runtime_supply, runtime_supply, 'product-npm', None),
             (trusted_proof, trusted_proof, 'product-npm', None),
             (packet, packet, 'failure-evidence', None),
             (model_selector[:-3], model_selector, 'ai-developer-codex', None),
             (exec_usage[:-3], exec_usage, 'ai-developer-codex', None),
             (stream_supervisor[:-3], stream_supervisor, 'ai-developer-codex', None),
             (model_policy, model_policy, 'ai-developer-codex', None))


def python_body(text):
    prefix, start, rest = text.partition("<<'PY'\n")
    body, end, suffix = rest.rpartition('\nPY')
    assert start and end, 'missing fixture Python body'
    assert all(needle not in prefix + suffix for needle in (product, packet, verifier,
                                                           session_runtime, session_probe, runtime_staging,
                                                           *session_symbols, model_selector[:-3], model_policy,
                                                           exec_usage[:-3], stream_supervisor[:-3]))
    return body


def declaration(tree, name, kind):
    statements = [n for n in tree.body if isinstance(n, ast.Assign)
                  and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
                  and n.targets[0].id == name]
    assert len(statements) == 1, ('missing/duplicate declaration', name)
    statement = statements[0]
    # Reject nested/repeated/annotated/augmented writes, not just duplicate rows.
    writes = [n for n in ast.walk(tree) if isinstance(n, ast.Name)
              and n.id == name and isinstance(n.ctx, (ast.Store, ast.Del))]
    assert writes == [statement.targets[0]], ('non-declarative write', name)
    assert isinstance(statement.value, kind), ('non-literal declaration', name)
    return statement.value


def mask_literals(text, nodes):
    lines = text.encode().splitlines(keepends=True)
    for node in sorted(nodes, key=lambda n: (n.lineno, n.col_offset), reverse=True):
        assert node.lineno == node.end_lineno
        line = lines[node.lineno - 1]
        lines[node.lineno - 1] = line[:node.col_offset] + line[node.end_col_offset:]
    return b''.join(lines)


def assert_selector_dormant(tree):
    # The same closed imports/call surface as the existing selector fixture:
    # reject indirect execution of inventory paths even without filename text.
    imports = [ast.unparse(n) for n in ast.walk(tree)
               if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert sorted(imports) == sorted((
        'import json', 'import os', 'from pathlib import Path', 'import sys'))
    allowed_calls = {
        'BASELINE.items', 'BASELINE_COUNTS.items', 'EXTENSIONS.get', 'INVENTORY.items',
        'Path', 'all', 'any', 'data.endswith', 'data[:-1].decode',
        "data[:-1].decode('utf-8', 'strict').split", 'dict', 'entry.is_file',
        'entry.name.endswith', 'entry.name.startswith', 'fixtures.update', 'frozenset',
        'full', 'isinstance', 'json.dumps', 'len', 'main', 'mappings', 'os.scandir',
        'parse_paths', 'path.encode', 'path.endswith', 'path.split', 'path.startswith',
        'print', 'record', 'select', 'set', 'sorted', 'suites.update', 'sys.exit',
        'sys.stdin.buffer.read', 'tuple', 'valid_path',
        'pattern.startswith', 'pattern.endswith', 'rules.append', 'trigger_rules',
        'trigger_match',
    }
    assert all(ast.unparse(n.func) in allowed_calls for n in ast.walk(tree)
               if isinstance(n, ast.Call)), 'executable selector reference'


def assert_declarative(path, text):
    is_fixture = path == selector_fixture
    body = python_body(text) if is_fixture else text
    assert verifier not in body, ('non-inventory verifier reference', path)
    assert all(symbol not in body for symbol in session_symbols), ('session selector caller', path)
    tree = ast.parse(body)
    rows = declaration(tree, 'cases' if is_fixture else 'PATH_SUITES', ast.Tuple)
    baseline = None
    if not is_fixture:
        assert_selector_dormant(tree)
        baseline = declaration(tree, 'BASELINE', ast.Dict)
        ast.literal_eval(baseline)  # No calls/expressions in the primary inventory.
    for needle, filename, suite, baseline_name in contracts:
        allowed = []
        expected = ast.parse(
            f'({filename!r}, {{{suite!r}}})' if is_fixture else
            f'(SCRIPTS + {filename!r}, ({suite!r},))', mode='eval').body
        matches = [row for row in rows.elts if ast.dump(row) == ast.dump(expected)]
        assert len(matches) == (0 if is_fixture and baseline_name else 1), (
            'missing/duplicate mapping literal', path, suite)
        for row in matches:
            allowed.extend(n for n in ast.walk(row)
                           if isinstance(n, ast.Constant) and n.value == filename)
        if filename in (model_selector, exec_usage, stream_supervisor) and not is_fixture:
            # Exact fixture registration is data, never an executable reference.
            extension = declaration(tree, 'EXTENSIONS', ast.Dict)
            ast.literal_eval(extension)
            values = [v for k, v in zip(extension.keys, extension.values)
                      if isinstance(k, ast.Constant) and k.value == suite]
            assert len(values) == 1 and isinstance(values[0], ast.Tuple)
            names = [n for n in values[0].elts
                     if isinstance(n, ast.Constant) and n.value == filename[:-3]]
            assert len(names) == 1, 'missing/duplicate dormant fixture extension'
            allowed.extend(names)
        if baseline is not None and baseline_name:
            values = [v for k, v in zip(baseline.keys, baseline.values)
                      if isinstance(k, ast.Constant) and k.value == suite]
            assert len(values) == 1 and isinstance(values[0], ast.Tuple)
            names = [n for n in values[0].elts
                     if isinstance(n, ast.Constant) and n.value == baseline_name]
            assert len(names) == 1, 'missing/duplicate primary inventory literal'
            allowed.extend(names)
        assert needle.encode() not in mask_literals(body, allowed), (
            'non-inventory reference', path, suite)


def is_test_fixture(path):
    # Only direct script test files have fixture status; directories, arbitrary
    # filename substrings, and similarly named production files do not.
    p = Path(path)
    return (p.parent.as_posix() == scripts.rstrip('/')
            and p.name.startswith('test-') and p.suffix in ('.sh', '.py'))


@lru_cache(maxsize=32)
def mask_trusted_model_callers(text):
    # Closed exception for #759: exact reviewed caller bytes, metadata and gates.
    # Changing this digest requires reviewing the caller and its runtime fixture.
    value = yaml.safe_load(text)
    node = yaml.compose(text)
    def child(mapping, key):
        matches = [v for k, v in mapping.value if k.value == key]
        assert len(matches) == 1
        return matches[0]
    masked = text.splitlines(keepends=True)
    jobs = child(node, 'jobs')
    followup_gate = ("steps.verify-reviewer.outputs.trusted == 'true' && "
                    "steps.followup-gate.outputs.continue == 'true' && "
                    "steps.followup-checkout.outputs.continue == 'true'")
    for job, digest in (
            ('develop-from-issue', 'e526cfaca0742f923a5b528463c8123ffc26a8d27727ef5c90e6e65f105c04ea'),
            ('respond-to-claude', 'fbbfa579a33e6561c6ecbcb1835ec04c2ab48e031dbed437773886bbb757294c')):
        steps = value['jobs'][job]['steps']
        matches = [(i, step) for i, step in enumerate(steps) if step.get('id') == 'codex_model']
        assert len(matches) == 1, 'missing/duplicate trusted model caller'
        index, step = matches[0]
        env = {'NORMAL_MODEL': '${{ vars.CODEX_MODEL }}'}
        expected = dict(name='Select trusted Codex Issue model', id='codex_model',
                        shell='bash', env=env, run=step['run'])
        if job == 'develop-from-issue':
            env.update(BASE_SHA='${{ steps.issue_context.outputs.base_sha }}',
                ISSUE_NUMBER="${{ github.event_name == 'repository_dispatch' && steps.resume-gate.outputs.issue_number || github.event.issue.number }}")
            assert any(s.get('id') == 'issue_context' for s in steps[:index])
        else:
            env.update(BASE_SHA='${{ github.event.pull_request.base.sha }}',
                       HEAD_REF='${{ github.event.pull_request.head.ref }}')
            expected['if'] = followup_gate
            assert any(s.get('id') == 'followup-checkout' for s in steps[:index])
        assert step == expected, 'untrusted model caller metadata'
        assert hashlib.sha256(step['run'].encode()).hexdigest() == digest, 'untrusted model caller bytes'
        assert index < next(i for i, s in enumerate(steps) if s.get('id') == 'codex')
        step_node = child(child(jobs, job), 'steps').value[index]
        assert len({k.value for k, _ in step_node.value}) == len(step_node.value)
        env_node = child(step_node, 'env')
        assert len({k.value for k, _ in env_node.value}) == len(env_node.value)
        assert not any(isinstance(token, (yaml.tokens.AnchorToken, yaml.tokens.AliasToken))
                       and step_node.start_mark.index <= token.start_mark.index < step_node.end_mark.index
                       for token in yaml.scan(text)), 'model caller alias/anchor escape'
        for line in range(step_node.start_mark.line, step_node.end_mark.line):
            masked[line] = '\n'
    return ''.join(masked)


def assert_unreachable(sources):
    # Parse source text only. Never import selector, builder, collector or npm.
    for path in (selector_path, selector_fixture):
        assert_declarative(path, sources[path])
    for path, text in sources.items():
        if path.startswith(workflows):
            model_text = mask_trusted_model_callers(text) if path == workflows + 'ai-developer.yml' else text
            assert model_selector[:-3] not in model_text and model_policy not in model_text, (
                'unknown model selection production connection', path)
            assert exec_usage[:-3] not in text, ('exec usage production connection', path)
            assert stream_supervisor[:-3] not in text, ('stream supervisor production connection', path)
            if path == trusted_workflow:
                value = yaml.safe_load(text)
                assert value.get('on', value.get(True)) == {'workflow_dispatch': None}
                assert value['permissions'] == {'contents': 'read'}
                assert set(value['jobs']) == {'proof'}
                steps = value['jobs']['proof']['steps']
                assert len(steps) == 5 and 'Require exact trusted main source' == steps[0]['name']
                assert steps[1]['with'] == {'ref': '${{ github.sha }}', 'persist-credentials': False}
                assert steps[2]['with'] == {
                    'codex-version': '0.159.3',
                    'codex-home': '${{ runner.temp }}/runtime-supply-proof-home',
                    'safety-strategy': 'unsafe', 'allow-users': '*'}
                assert steps[3]['run'] == ('/usr/bin/env -i PATH="$PATH" PROOF_SHA="$PROOF_SHA" \\\n'
                    '  /usr/bin/python3 -I .github/scripts/' + trusted_proof + ' --observe\n')
                assert steps[4]['run'] == ('sudo -n /usr/bin/env -i PATH="$PATH" PROOF_SHA="$PROOF_SHA" \\\n'
                    '  /usr/bin/python3 -I .github/scripts/' + trusted_proof + ' --prepare\n')
                assert all(term not in text for term in ('secrets.', 'vars.', 'pull_request',
                           product, packet, verifier, runtime_staging, runtime_supply, *session_symbols))
                continue  # Only this closed proof entry; other workflow callers remain forbidden.
            assert all(needle not in text for needle in (product, packet, verifier,
                                                        session_runtime, session_probe, runtime_staging[:-3],
                                                        *session_symbols)), (
                'production workflow connection', path)
            assert runtime_supply[:-3] not in text, ('supply production connection', path)
            assert supply_proof[:-3] not in text, ('removed proof workflow connection', path)
        elif path.startswith(scripts):
            if path in (selector_path, selector_fixture) or is_test_fixture(path):
                continue
            if path != scripts + product + '.py':
                assert verifier not in text, ('unknown verifier caller', path)
                for symbol in session_symbols:
                    if path == scripts + session_runtime and symbol == 'production_session':
                        continue  # Only the closed callback API, never raw session access.
                    assert symbol not in text, ('unknown session caller', path)
            for needle, filename, _, _ in contracts:
                if path == scripts + stream_supervisor and filename == exec_usage:
                    # Only #761's exact prepared loader/CLI/API source is allowed.
                    # This static exception proves no runtime source provenance.
                    assert hashlib.sha256(text.encode()).hexdigest() == (
                        'b035818833808d9a129f84501dfe4ed8206f78ba74a5de9f14012125897c5f15')
                    tree = ast.parse(text)
                    identity = declaration(tree, 'EXTRACTOR_NAME', ast.Constant)
                    assert identity.value == filename
                    assert needle.encode() not in mask_literals(text, [identity])
                    continue
                if path == scripts + trusted_proof:
                    if filename in (runtime_staging, runtime_supply):
                        # Exactly one closed module load; no caller inventory input.
                        expression = "load('" + filename[:-3] + "')"
                        assert text.count(expression) == 1
                        assert needle not in text.replace(expression, 'PREPARED_API', 1)
                        continue
                    if filename == product + '.py':
                        expression = "load('product-npm-orchestrator').CanonicalRoot"
                        assert text.count(expression) == 1
                        assert needle not in text.replace(expression, 'ROOT_API', 1)
                        continue
                if path == scripts + filename:
                    continue  # Implementation's own source identity is not a caller.
                if path == scripts + product + '.py' and filename in (session_runtime, session_probe):
                    tree = ast.parse(text)
                    inventory = declaration(tree, 'SOURCES', ast.Tuple)
                    names = [n for n in inventory.elts if isinstance(n, ast.Constant) and n.value == filename]
                    assert len(names) == 1, 'missing/duplicate source identity'
                    assert needle.encode() not in mask_literals(text, names), 'executable source identity'
                    continue
                if needle == packet and path == scripts + 'collect-failure-evidence.py':
                    continue  # The single existing production caller (#687).
                if needle == session_probe and path == scripts + session_runtime:
                    continue  # Exact dormant synthetic launcher; workflows remain forbidden.
                assert needle not in text, ('unknown production caller', path, filename)
                if filename in (runtime_staging, runtime_supply, supply_proof):
                    assert filename[:-3] not in text, ('unknown extensionless runtime caller', path, filename)


def snapshot():
    # Index discovery excludes untracked bytecode/runtime artifacts. Inspect
    # working-tree bytes, not index blobs, so proposed source changes are tested.
    listed = subprocess.run(
        ['git', 'ls-files', '--stage', '-z', '--', scripts, workflows, ':!' + scripts + supply_proof],
        cwd=repo, capture_output=True, check=True).stdout
    assert listed and listed.endswith(b'\0'), 'invalid tracked inventory framing'
    result = {}
    for entry in listed[:-1].split(b'\0'):
        metadata, name = entry.split(b'\t', 1)
        mode, identity, stage = metadata.split(b' ')
        assert mode in (b'100644', b'100755') and stage == b'0', 'invalid tracked file'
        assert len(identity) in (40, 64) and all(c in b'0123456789abcdef' for c in identity)
        name = name.decode('utf-8', 'strict')
        assert name.startswith((scripts, workflows)) and name not in result
        assert '\\' not in name and all(p not in ('', '.', '..') for p in name.split('/'))
        path = repo
        parts = name.split('/')
        for index, part in enumerate(parts):
            path = path / part
            info = path.lstat()  # Missing, unreadable, symlink or special type must fail.
            expected = stat.S_ISREG if index == len(parts) - 1 else stat.S_ISDIR
            assert expected(info.st_mode), ('invalid tracked source type', name)
        data = path.read_bytes()
        data.decode('utf-8', 'strict')  # Invalid tracked source cannot be silently skipped.
        result[name] = data
    assert {selector_path, selector_fixture, scripts + product + '.py',
            scripts + packet, scripts + 'collect-failure-evidence.py'} <= result.keys()
    assert any(name.startswith(workflows) for name in result), 'missing tracked workflows'
    return result


# The removed proof is never admitted as an untracked or indexed executable.
assert not (repo / scripts / supply_proof).exists()
assert not (repo / scripts / supply_proof).is_symlink()
before = snapshot()
sources = {p: data.decode('utf-8') for p, data in before.items()}
# Include the proposed new dormant sources before workflow orchestration stages
# them. After merge they are covered by the tracked snapshot as well.
for name in (session_runtime, session_probe, runtime_staging, runtime_supply, trusted_proof,
             model_selector, model_policy, exec_usage, stream_supervisor):
    path = repo / scripts / name
    assert stat.S_ISREG(path.lstat().st_mode), 'invalid dormant source type'
    sources[scripts + name] = path.read_bytes().decode('utf-8', 'strict')
assert stat.S_ISREG((repo / trusted_workflow).lstat().st_mode), 'invalid proof workflow type'
sources[trusted_workflow] = (repo / trusted_workflow).read_text()
assert_unreachable(sources)
print('production unreachable: current repository / exact selector literals passed')


def accepted(path, text):
    assert_unreachable({**sources, path: text})


def rejected(path, text):
    try:
        accepted(path, text)
    except (AssertionError, ValueError, SyntaxError, yaml.YAMLError):
        return
    raise AssertionError(('unsafe reference accepted', path))


for mutation in (
        sources[trusted_workflow].replace('workflow_dispatch:', 'pull_request:'),
        sources[trusted_workflow].replace('contents: read', 'contents: write'),
        sources[trusted_workflow].replace('ref: ${{ github.sha }}', 'ref: ${{ github.event.pull_request.head.sha }}'),
        sources[trusted_workflow].replace('persist-credentials: false', 'persist-credentials: true'),
        sources[trusted_workflow].replace('--prepare', '--prepare --path /candidate'),
        sources[trusted_workflow].replace('codex-version: 0.159.3', 'codex-version: latest')):
    rejected(trusted_workflow, mutation)


# Mutate only in-memory snapshots; the actual repository is never written.
model_workflow = workflows + 'ai-developer.yml'
original_model_workflow = sources[model_workflow]
for mutation in (
        original_model_workflow.replace('git show "${BASE_SHA}:${source_path}"', 'git show "HEAD:${source_path}"', 1),
        original_model_workflow.replace('git hash-object --no-filters "$selection_dir/$filename"', 'echo "$expected_blob"', 1),
        original_model_workflow.replace('steps.issue_context.outputs.base_sha', 'github.event.pull_request.head.sha', 1),
        original_model_workflow.replace("steps.followup-checkout.outputs.continue == 'true'\n        id: codex_model", "true\n        id: codex_model", 1),
        original_model_workflow.replace('actual != canonical', 'False', 1),
        original_model_workflow.replace('        id: codex_model', '        id: invalid\n        id: codex_model', 1),
        original_model_workflow.replace("python3 -I -B - <<'PY_MODEL'", "python3 -B - <<'PY_MODEL'", 1),
        original_model_workflow.replace('          export SELECTION_DIR="$selection_dir"', '          export SELECTION_DIR="$selection_dir"\n          # extra select-codex-issue-model caller', 1),
        original_model_workflow.replace(
            '        run: |\n          set -euo pipefail\n          [[ "$BASE_SHA"',
            '        run: &model_caller |\n          set -euo pipefail\n          [[ "$BASE_SHA"', 1),
        original_model_workflow + '\n# unauthorized ' + model_selector,
        original_model_workflow + '\n# unauthorized ' + model_policy,
        original_model_workflow + '\n# unauthorized ' + exec_usage,
        original_model_workflow + '\n# unauthorized ' + stream_supervisor):
    assert mutation != original_model_workflow
    rejected(model_workflow, mutation)

rejected(workflows + 'ai-workflow-regression.yml',
         sources[workflows + 'ai-workflow-regression.yml'] + '\nrun: sudo python3 ' + scripts + supply_proof)
for needle, filename, suite, baseline_name in contracts:
    call = f'run({filename!r})\n'
    for path in (scripts + 'unknown-caller.py', scripts + 'deepinfra-investigator.py',
                 scripts + 'claude-helper.sh', scripts + 'nested/caller.js',
                 scripts + 'caller-test-helper.py', scripts + 'nested/test-caller.sh',
                 scripts + 'test-caller-production.js'):
        rejected(path, call)
    for path in (workflows + 'caller.yml', workflows + 'caller.yaml',
                 workflows + 'nested/caller.yml'):
        rejected(path, 'run: python3 ' + scripts + filename + '\n')
    if filename in (runtime_staging, runtime_supply, supply_proof):
        rejected(scripts + 'unknown-caller.py', f"load({filename[:-3]!r})\n")
        rejected(workflows + 'caller.yml', f"run: load({filename[:-3]!r})\n")
    # Test-only references and exact implementation identity remain distinct.
    accepted(scripts + 'test-synthetic-caller.sh', call)
    accepted(scripts + filename, sources[scripts + filename])
    rejected(scripts + 'copy-' + filename, sources[scripts + filename] + call)
    if filename in (session_runtime, session_probe):
        rejected(scripts + product + '.py', sources[scripts + product + '.py'] + call)
    if needle == packet:
        accepted(scripts + 'collect-failure-evidence.py', call)
        rejected(scripts + 'copy-collect-failure-evidence.py', call)
    else:
        rejected(scripts + 'collect-failure-evidence.py', call)

    original = sources[selector_path]
    literal = '"' + filename + '"'
    assert original.count(literal) == 1
    rejected(selector_path, original + '\n' + call)
    rejected(selector_path, original.replace(literal, f'run({filename!r})'))
    rejected(selector_path, original.replace(literal, f'({filename!r} + "")'))
    row = f'(SCRIPTS + {literal}, ("{suite}",))'
    assert row in original
    rejected(selector_path, original.replace(row, row + ',\n    ' + row))
    rejected(selector_path, original.replace(row, '("other.py", ("common",))'))
    rejected(selector_path, original + f'\n# unknown reference: {needle}\n')
    # Offsets are UTF-8 byte offsets, including non-ASCII preceding a literal.
    accepted(selector_path, original.replace(row + ',', row + ',  # 日本語'))
    if baseline_name:
        literal = '"' + baseline_name + '"'
        rejected(selector_path, original.replace(literal, literal + ', ' + literal))

for name in ('BASELINE', 'PATH_SUITES'):
    original = sources[selector_path]
    tree = ast.parse(original)
    value = declaration(tree, name, ast.Dict if name == 'BASELINE' else ast.Tuple)
    rejected(selector_path, original + '\n' + name + ' = ' + ast.unparse(value) + '\n')
    for assignment in (f'{name} = ()', f'{name}: tuple = ()', f'{name} += ()',
                       f'def extra():\n    {name} = ()'):
        rejected(selector_path, original + '\n' + assignment + '\n')

# The new extension exception admits only one declarative fixture identity.
original = sources[selector_path]
for filename in (model_selector, exec_usage, stream_supervisor):
    literal = '"' + filename[:-3] + '"'
    for replacement in ('"other"', literal + ', ' + literal,
                        f'run({filename[:-3]!r})'):
        rejected(selector_path, original.replace(literal, replacement))
for assignment in ('EXTENSIONS = {}', 'EXTENSIONS += {}',
                   'def extra():\n    EXTENSIONS = {}'):
    rejected(selector_path, original + '\n' + assignment + '\n')

# The only new prepared caller exception is exact source, never a filename-wide
# permission. Copies, extra loads, changed source/API and workflow callers fail.
prepared_source = sources[scripts + stream_supervisor]
accepted(scripts + stream_supervisor, prepared_source)
for mutation in (prepared_source + '\nload_extractor(EXTRACTOR_NAME)\n',
                 prepared_source.replace('spec.loader.exec_module(module)',
                                         'spec.loader.exec_module(module)\n    spec.loader.exec_module(module)'),
                 prepared_source.replace('"prepared_exec_usage", source_path',
                                         '"prepared_exec_usage", EXTRACTOR_NAME'),
                 prepared_source.replace('shell=False', 'shell=True'),
                 prepared_source.replace('return module', 'return load_extractor(source_path)')):
    assert mutation != prepared_source
    rejected(scripts + stream_supervisor, mutation)
rejected(scripts + 'copy-' + stream_supervisor, prepared_source)
rejected(scripts + 'unknown-loader.py', prepared_source)

for symbol in session_symbols:
    for path in (scripts + 'unknown.py', scripts + 'copy-' + session_runtime,
                 scripts + 'nested/test-caller.sh', selector_path, selector_fixture,
                 workflows + 'ai-developer.yml', workflows + 'caller.yaml'):
        rejected(path, sources.get(path, '') + f'\n{symbol}(handoff, consumer)\n')
    if symbol != 'production_session':
        rejected(scripts + session_runtime, sources[scripts + session_runtime] + f'\n{symbol}(handoff)\n')

for executable in ('os.system(PATH_SUITES[0][0])', 'eval(INVENTORY["product-npm"][0])',
                   '__import__("subprocess").run([PATH_SUITES[0][0]])'):
    rejected(selector_path, sources[selector_path] + '\n' + executable + '\n')

# The verifier symbol has no inventory exception or collector exception.
for path in (scripts + 'unknown.py', scripts + 'deepinfra-investigator.py',
             scripts + 'collect-failure-evidence.py', scripts + 'nested/test-caller.sh',
             scripts + 'test-caller-production.js', selector_path, selector_fixture,
             workflows + 'caller.yml', workflows + 'caller.yaml'):
    rejected(path, sources.get(path, '') + f'\n{verifier}(handoff)\n')
accepted(scripts + 'test-synthetic-verifier.sh', f'{verifier}(handoff)\n')
accepted(scripts + 'test-synthetic-verifier.py', f'{verifier}(handoff)\n')
accepted(scripts + product + '.py', sources[scripts + product + '.py'])

fixture_text = sources[selector_fixture]
fixture_row = f"({packet!r}, {{'failure-evidence'}})"
assert fixture_row in fixture_text
for mutation in (
        fixture_text.replace(fixture_row, fixture_row + ',\n    ' + fixture_row),
        fixture_text.replace(fixture_row, f"(run({packet!r}), {{'failure-evidence'}})"),
        fixture_text.replace('\nPY', f'\nrun({packet!r})\nPY'),
        fixture_text + f'\nrun {packet}\n',
        fixture_text.replace('\nPY', '\ncases += ()\nPY'),
        fixture_text.replace('\nPY', '\ncases = cases\nPY')):
    rejected(selector_fixture, mutation)
rejected(selector_fixture, fixture_text.replace('\nPY', f'\nrun({product!r})\nPY'))
rejected(scripts + 'selector-copy.py', sources[selector_path])


def snapshot_rejected():
    try:
        snapshot()
    except (AssertionError, ValueError, OSError, subprocess.CalledProcessError):
        return
    raise AssertionError('invalid tracked snapshot accepted')


# In-memory index/filesystem mocks: no git index or repository writes.
listing = subprocess.run(['git', 'ls-files', '--stage', '-z', '--', scripts, workflows, ':!' + scripts + supply_proof],
                         cwd=repo, capture_output=True, check=True).stdout
for invalid in (b'', listing[:-1], listing + listing.split(b'\0')[0] + b'\0',
                listing.replace(b'100644 ', b'120000 ', 1),
                listing.replace(b' 0\t', b' 1\t', 1),
                b'100644 ' + b'0' * 40 + b' 0\t.github/scripts/../escape.py\0',
                b'100644 ' + b'0' * 40 + b' 0\t.github/scripts/\xff.py\0'):
    with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, invalid)):
        snapshot_rejected()
with patch.object(subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'git')):
    snapshot_rejected()
for failure in (FileNotFoundError, PermissionError):
    with patch.object(Path, 'lstat', side_effect=failure):
        snapshot_rejected()
    with patch.object(Path, 'read_bytes', side_effect=failure):
        snapshot_rejected()
for mode in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFDIR):
    original_lstat = Path.lstat
    def bad_type(path):
        if path == repo / selector_path:
            return type('Info', (), {'st_mode': mode})()
        return original_lstat(path)
    with patch.object(Path, 'lstat', bad_type):
        snapshot_rejected()
with patch.object(Path, 'rglob', side_effect=AssertionError('untracked discovery')):
    assert snapshot() == before  # Never traverses __pycache__ or other untracked files.

# NUL framing preserves tabs/newlines in tracked names; binary tracked data fails.
extra_name = scripts + 'synthetic\tline\nbreak.py'
extra_path = repo / extra_name
extra_entry = b'100644 ' + b'0' * 40 + b' 0\t' + extra_name.encode() + b'\0'
original_read = Path.read_bytes
original_lstat = Path.lstat
for payload in (b'# synthetic source\n', b'\xff\x00'):
    with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess(
            [], 0, listing + extra_entry)), \
         patch.object(Path, 'lstat', lambda path: type('Info', (), {'st_mode': stat.S_IFREG})()
                      if path == extra_path else original_lstat(path)), \
         patch.object(Path, 'read_bytes', lambda path: payload
                      if path == extra_path else original_read(path)):
        if payload.startswith(b'#'):
            assert snapshot() == {**before, extra_name: payload}
        else:
            snapshot_rejected()
assert snapshot() == before, 'guard changed repository content'
print('production unreachable: cross-suite callers / verifier / workflows / AST mutations / tracked read-only snapshot passed')
PY
