#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
repo = Path(sys.argv[1])
source = repo / '.github/scripts/select-ai-workflow-fixtures.py'
spec = importlib.util.spec_from_file_location('selector', source)
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)
prefix = '.github/scripts/'
actual = sorted(prefix + p.name for p in (repo / prefix).glob('test-*.sh'))
counts = {'product-npm': 11, 'resume-human-pause': 26, 'claude': 11,
          'deepinfra': 9, 'ai-developer-codex': 7, 'failure-evidence': 2, 'common': 2}
assert {s: len(v) for s, v in selector.BASELINE.items()} == counts
assert sum(counts.values()) == 68
assert selector.EXTENSIONS == {
    'product-npm': ('product-npm-bootstrap-preparation', 'product-npm-post-workload',
                    'product-npm-production-session', 'product-runtime-staging', 'trusted-runtime-supply'),
    'ai-developer-codex': ('select-' + 'codex-issue-model',),
    'common': ('select-ai-workflow-fixtures', 'production-unreachable', 'plan-ai-workflow-shards')}
inventory = sorted(p for values in selector.INVENTORY.values() for p in values)
assert len(inventory) == len(set(inventory)) == 77
assert inventory == actual, 'Every current shell fixture must be registered exactly once'
common_guard = prefix + 'test-production-unreachable.sh'
assert common_guard in selector.INVENTORY['common']


def encode(paths):
    return b''.join(p.encode('utf-8') + b'\0' for p in paths)


def check_record(result):
    assert set(result) == {'schema', 'version', 'mode', 'reason', 'suites', 'fixtures'}
    assert result['schema'] == 'ai-workflow-fixture-selection' and result['version'] == 1
    assert result['suites'] == sorted(set(result['suites']))
    assert result['fixtures'] == sorted(set(result['fixtures']))


def selected(paths, suites, root=repo):
    result = selector.select(root, encode(paths))
    check_record(result)
    assert result['mode'] == 'selected', result
    assert result['reason'] == 'known_paths'
    assert result['suites'] == sorted(set(suites) | {'common'}), result
    expected = sorted({p for s in result['suites'] for p in selector.INVENTORY[s]})
    assert result['fixtures'] == expected
    assert common_guard in result['fixtures'], 'cross-suite guard must always be selected'
    return result


def full(data, reason, root=repo, expected=actual):
    result = selector.select(root, data)
    check_record(result)
    assert result['mode'] == 'full' and result['reason'] == reason, result
    assert result['fixtures'] == expected, result
    if expected:
        assert result['suites'] == sorted(counts)
    return result


# Independent expected suite boundaries, including shared helper consumers.
cases = (
    ('plan-ai-workflow-shards.py', {'common'}),
    ('build-failure-evidence-packet.py', {'failure-evidence'}),
    ('collect-failure-evidence.py', {'failure-evidence'}),
    ('fixtures/failure-evidence-654.json', {'failure-evidence'}),
    ('deepinfra-usage-ledger.py', {'deepinfra'}),
    ('prepare-product-npm.py', {'product-npm'}),
    ('product-npm-session-runtime.py', {'product-npm'}),
    ('product-npm-session-probe.js', {'product-npm'}),
    ('product-runtime-staging.py', {'product-npm'}),
    ('trusted-runtime-supply.py', {'product-npm'}),
    ('trusted-main-runtime-supply-proof.py', {'product-npm'}),
    ('test-ai-developer-branch-freshness.sh', {'ai-developer-codex'}),
    ('evaluate-codex-diff-gate.sh', {'ai-developer-codex', 'claude'}),
    ('classify-ai-developer-decision-marker.sh', {'ai-developer-codex'}),
    ('select-codex-issue-model.py', {'ai-developer-codex'}),
    ('codex-issue-model-policy.json', {'ai-developer-codex'}),
    ('build-review-context.sh', {'ai-developer-codex', 'claude'}),
    ('classify-claude-review-risk.sh', {'claude'}),
    ('parse-ai-resume-command.sh', {'resume-human-pause'}),
    ('codex-network-boundary.py', {'ai-developer-codex', 'product-npm'}),
    ('build-development-context.py', {'ai-developer-codex', 'failure-evidence'}),
)
for name, suites in cases:
    selected([prefix + name], suites)
# Unrelated helper changes run the common guard without the heavy Product npm suite.
light = selected([prefix + 'deepinfra-usage-ledger.py'], {'deepinfra'})
assert 'product-npm' not in light['suites']
assert not set(light['fixtures']) & set(selector.INVENTORY['product-npm'])
pause_suites = {'resume-human-pause', 'ai-developer-codex', 'claude'}
for name in ('create-human-pause', 'human-pause-record', 'list-human-pause-records',
             'validate-human-pause-record-graph', 'decompose-human-pause-record-graph',
             'derive-human-pause-pre-resume-state', 'reconcile-human-pause-resume-acceptance',
             'reconcile-human-pause-active-pause', 'apply-human-pause',
             'format-human-pause-notification', 'notify-human'):
    selected([prefix + name + '.sh'], pause_suites)
# Workflow changes must include the suites whose dormant guards scan all workflows.
workflow_suites = pause_suites | {'deepinfra', 'product-npm', 'failure-evidence'}
assert selected(['.github/workflows/claude-review.yml'], workflow_suites)['fixtures'] == actual
assert selected(['.github/workflows/claude-review.yml', prefix + 'prepare-product-npm.py'],
                workflow_suites)['fixtures'] == actual
for workflow in (repo / '.github/workflows').glob('*.yml'):
    result = selector.select(repo, encode([workflow.relative_to(repo).as_posix()]))
    check_record(result)
    assert result['fixtures'] == actual, ('workflow guard omitted', workflow, result)
paths = [prefix + 'deepinfra-usage-ledger.py', prefix + 'prepare-product-npm.py',
         prefix + 'codex-network-boundary.py']
expected = selected(paths, {'deepinfra', 'product-npm', 'ai-developer-codex'})
assert selector.select(repo, encode(paths[::-1] + paths)) == expected
assert selector.select(repo, encode(paths)) == expected

# Every changed registered fixture is included, even without a helper path mapping.
for suite, fixtures in selector.INVENTORY.items():
    for fixture in fixtures:
        if fixture == selector.SELF_TEST:
            full(encode([fixture]), 'global_boundary')
        else:
            assert fixture in selected([fixture], {suite})['fixtures']
changed_fixture = prefix + 'test-claude-review-workflow.sh'
assert changed_fixture in selected([changed_fixture, prefix + 'prepare-product-npm.py'],
                                    {'claude', 'product-npm'})['fixtures']

for path in ('.github/workflows/ai-workflow-regression.yml', selector.SELF, selector.SELF_TEST):
    full(encode([path]), 'global_boundary')
    full(encode([path, prefix + 'prepare-product-npm.py']), 'global_boundary')
for path in (prefix + 'unknown.sh', prefix + 'test-new.sh',
             'docs/00_requirements/01_Introduction.md', 'docs/diagrams/README.md',
             'docs/30_operations/ai-development-workflow.md',
             'AGENTS.md', 'nested/AGENTS.override.md', 'CLAUDE.md', 'nested/CLAUDE.local.md',
             '.codex/config.toml', 'nested/.claude/settings.json', 'nested/.mcp.json',
             '.github/workflows/new.yml', prefix + 'new-helper.py', 'src/CLAUDE.md'):
    full(encode([path]), 'unmapped_path')
    full(encode([prefix + 'prepare-product-npm.py', path]), 'unmapped_path')

# Trigger-excluded paths cannot force a mixed PR to full; an empty domain fails closed.
# Compose the helper name so the common guard retains its exact inventory-only rule.
product = selected(['.github/README.md', prefix + 'product-' + 'npm-orchestrator.py',
                    prefix + 'test-product-npm-post-workload.sh'], {'product-npm'})
assert len(product['fixtures']) == 21
selected(['README.md', prefix + 'deepinfra-usage-ledger.py'], {'deepinfra'})
for path in ('.github/README.md', 'README.md', 'src/product.py',
             'docs/diagrams/other.md', 'AGENTS.md.bak', 'src/notCLAUDE.md',
             '.github/scripts-other/helper.py', 'nested/.codex-other/config.toml'):
    full(encode([path]), 'empty_selection')
    selected([path, prefix + 'deepinfra-usage-ledger.py'], {'deepinfra'})

# Root and nested forms of every basename/directory pattern are in the domain.
for name in ('AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'):
    for path in (name, 'src/nested/' + name):
        full(encode([path]), 'unmapped_path')
for name in ('.claude', '.codex'):
    for path in (name + '/config', 'src/nested/' + name + '/deep/config'):
        full(encode([path]), 'unmapped_path')

for pattern in ('**/*.py', '.github/*/**', '**/nested/CLAUDE.md', '!README.md',
                'docs/[ab].md', '**/.codex/*', 'foo+bar', '', None):
    with patch.object(selector, 'TRIGGER_PATTERNS', selector.TRIGGER_PATTERNS + (pattern,)):
        full(encode([prefix + 'prepare-product-npm.py']), 'mapping_conflict')

# Framing/UTF-8/path violations never produce selected or echo rejected input.
for data in (b'\xff\0', b'/absolute\0', b'../outside\0', b'a/../b\0',
             b'a/./b\0', b'a//b\0', b'a/\0', b'\0', b'a\0\0', b'a',
             b'a\0unterminated', b'C:\\absolute\0', b'a\n', None, 'text', ['a']):
    full(data, 'malformed_input')
full(b'', 'empty_selection')

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    scripts = root / prefix
    scripts.mkdir(parents=True)
    for fixture in actual:
        (root / fixture).touch()
    selected([prefix + 'prepare-product-npm.py'], {'product-npm'}, root)
    extra = prefix + 'test-unregistered.sh'
    (root / extra).touch()
    full(encode([extra]), 'inventory_mismatch', root, sorted(actual + [extra]))
    full(encode([prefix + 'prepare-product-npm.py']), 'inventory_mismatch', root,
         sorted(actual + [extra]))
    (root / extra).unlink()
    missing = prefix + 'test-npm-offline-ci.sh'
    (root / missing).unlink()
    remaining = [p for p in actual if p != missing]
    full(encode([missing]), 'inventory_mismatch', root, remaining)
    (root / missing).mkdir()
    full(encode([prefix + 'prepare-product-npm.py']), 'inventory_mismatch', root)
    (root / missing).rmdir()
    (root / missing).symlink_to(source)
    full(encode([prefix + 'prepare-product-npm.py']), 'inventory_mismatch', root)
    (root / missing).unlink()
    (root / missing).touch()
    (root / common_guard).unlink()
    full(encode([prefix + 'deepinfra-usage-ledger.py']), 'inventory_mismatch', root,
         [p for p in actual if p != common_guard])
    (root / common_guard).touch()
    full(encode([prefix + 'prepare-product-npm.py']), 'inventory_unavailable',
         root / 'absent', [])
    # Shell metacharacters, newline, spaces, and glob are literal path data.
    sentinel = root / 'EXECUTED'
    malicious = prefix + '$(touch ' + str(sentinel) + ').sh'
    for path in (malicious, prefix + '*.sh', prefix + 'space name.sh', prefix + 'line\nbreak.sh'):
        result = full(encode([path]), 'unmapped_path', root)
        assert path not in json.dumps(result)
    assert not sentinel.exists()

# Contradictory/empty suite mappings, duplicate primary membership, and exceptions.
data = encode([prefix + 'prepare-product-npm.py'])
for extra in ((prefix + 'prepare-product-npm.py', ('deepinfra',)),
              (prefix + 'other.py', ('unknown-suite',)),
              (prefix + 'other.py', ()),
              (prefix + 'other.py', ('deepinfra', 'deepinfra')),
              (selector.SELF, ('deepinfra',)),
              (actual[0], ('deepinfra',))):
    with patch.object(selector, 'PATH_SUITES', selector.PATH_SUITES + (extra,)):
        full(data, 'mapping_conflict')
for mutation in ('duplicate', 'empty', 'unknown', 'swapped'):
    broken = copy.deepcopy(selector.INVENTORY)
    if mutation == 'duplicate':
        broken['common'] += (broken['product-npm'][0],)
    elif mutation == 'empty':
        broken['common'] = ()
    elif mutation == 'unknown':
        broken['unregistered-suite'] = ('unused',)
    else:
        # Same complete fixture set, contradictory primary suite assignments.
        a, b = broken['claude'], broken['ai-developer-codex']
        broken['claude'] = (b[0],) + a[1:]
        broken['ai-developer-codex'] = (a[0],) + b[1:]
    with patch.object(selector, 'INVENTORY', broken):
        full(data, 'mapping_conflict')
with patch.object(selector, 'parse_paths', side_effect=RuntimeError('private input')):
    result = full(data, 'selector_error')
    assert 'private input' not in json.dumps(result)
with patch.object(selector.os, 'scandir', side_effect=PermissionError('private path')):
    result = full(data, 'inventory_unavailable', expected=[])
    assert 'private path' not in json.dumps(result)

# Real CLI consumes raw NUL bytes and emits one stable JSON record without stderr.
command = [sys.executable, '-B', str(source), '--repo-root', str(repo)]
for data, expected_mode in ((encode(paths), 'selected'), (b'\xff\0', 'full'),
                            (b'\0', 'full'), (b'', 'full')):
    first = subprocess.run(command, input=data, capture_output=True, check=True)
    second = subprocess.run(command, input=data, capture_output=True, check=True)
    assert first.stdout == second.stdout and not first.stderr and not second.stderr
    assert first.stdout.count(b'\n') == 1
    assert json.loads(first.stdout)['mode'] == expected_mode
bad_cli = subprocess.run(command + ['untrusted argument'], input=b'', capture_output=True)
assert bad_cli.returncode == 2 and b'untrusted argument' not in bad_cli.stderr
unavailable = subprocess.run(command[:-1] + [str(repo / 'absent')], input=b'', capture_output=True)
assert unavailable.returncode == 1
assert json.loads(unavailable.stdout)['reason'] == 'inventory_unavailable'

# Inventory references cannot become callers through dynamic execution either.
def assert_dormant(text):
    tree = ast.parse(text)
    imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert {ast.unparse(n) for n in imports} == {
        'import json', 'import os', 'from pathlib import Path', 'import sys'}
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
               if isinstance(n, ast.Call)), 'selector must not execute inventory paths'


selector_text = source.read_text()
assert_dormant(selector_text)
for executable in ('os.system(PATH_SUITES[0][0])', 'eval(INVENTORY["product-npm"][0])',
                   '__import__("subprocess").run([PATH_SUITES[0][0]])'):
    try:
        assert_dormant(selector_text + '\n' + executable + '\n')
    except AssertionError:
        pass
    else:
        raise AssertionError('executable selector accepted')

# Only regression may materialize the trusted base policy; other callers stay prohibited.
for workflow in (repo / '.github/workflows').glob('*.yml'):
    if workflow.name != 'ai-workflow-regression.yml':
        assert source.name not in workflow.read_text(), workflow
for script in (repo / '.github/scripts').iterdir():
    if script.is_file() and script.suffix in ('.py', '.sh', '.js'):
        if script != source and not script.name.startswith('test-'):
            assert source.name not in script.read_text(), script
regression = (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
assert 'fixtures=(.github/scripts/test-*.sh)' in regression
assert "selector.write_bytes(git('show', base + ':' + prefix + 'select-ai-workflow-fixtures.py'))" in regression
assert "[sys.executable, '-B', str(selector), '--repo-root', str(root)]" in regression
assert 'for fixture in "${fixtures[@]}"; do' in regression
print('AI workflow fixture selector tests passed (68 baseline + #692 + #684 + #711 + #738 + #741 + #745 + selector + #701 + #756 = 77).')
PY
