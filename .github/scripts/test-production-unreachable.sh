#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -B - "$repo_root" <<'PY'
import ast
from pathlib import Path
import sys

repo = Path(sys.argv[1])
scripts = '.github/scripts/'
workflows = '.github/workflows/'
selector_path = scripts + 'select-ai-workflow-fixtures.py'
selector_fixture = scripts + 'test-select-ai-workflow-fixtures.sh'
product = 'product-npm-orchestrator'
# Compose the packet filename so the preserved legacy packet fixture's exact
# reference scan does not mistake this test's own contract data for a caller.
packet = 'build-' + 'failure-evidence-packet.py'
contracts = ((product, product + '.py', 'product-npm', product),
             (packet, packet, 'failure-evidence', None))


def python_body(text):
    prefix, start, rest = text.partition("<<'PY'\n")
    body, end, suffix = rest.rpartition('\nPY')
    assert start and end, 'missing fixture Python body'
    assert all(needle not in prefix + suffix for needle, *_ in contracts)
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
    }
    assert all(ast.unparse(n.func) in allowed_calls for n in ast.walk(tree)
               if isinstance(n, ast.Call)), 'executable selector reference'


def assert_declarative(path, text):
    is_fixture = path == selector_fixture
    body = python_body(text) if is_fixture else text
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


def assert_unreachable(sources):
    # Parse source text only. Never import selector, builder, collector or npm.
    for path in (selector_path, selector_fixture):
        assert_declarative(path, sources[path])
    for path, text in sources.items():
        if path.startswith(workflows):
            assert all(needle not in text for needle, *_ in contracts), (
                'production workflow connection', path)
        elif path.startswith(scripts):
            if path in (selector_path, selector_fixture) or is_test_fixture(path):
                continue
            for needle, filename, _, _ in contracts:
                if path == scripts + filename:
                    continue  # Implementation's own source identity is not a caller.
                if needle == packet and path == scripts + 'collect-failure-evidence.py':
                    continue  # The single existing production caller (#687).
                assert needle not in text, ('unknown production caller', path, filename)


def snapshot():
    result = {}
    for directory in (scripts, workflows):
        for path in sorted((repo / directory).rglob('*')):
            assert not path.is_symlink(), ('unexpected symlink', path)
            if path.is_file():
                result[path.relative_to(repo).as_posix()] = path.read_bytes()
    return result


before = snapshot()
sources = {p: data.decode('utf-8') for p, data in before.items()}
assert_unreachable(sources)
print('production unreachable: current repository / exact selector literals passed')


def accepted(path, text):
    assert_unreachable({**sources, path: text})


def rejected(path, text):
    try:
        accepted(path, text)
    except (AssertionError, ValueError, SyntaxError):
        return
    raise AssertionError(('unsafe reference accepted', path))


# Mutate only in-memory snapshots; the actual repository is never written.
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
    # Test-only references and exact implementation identity remain distinct.
    accepted(scripts + 'test-synthetic-caller.sh', call)
    accepted(scripts + filename, sources[scripts + filename])
    rejected(scripts + 'copy-' + filename, sources[scripts + filename] + call)
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

for executable in ('os.system(PATH_SUITES[0][0])', 'eval(INVENTORY["product-npm"][0])',
                   '__import__("subprocess").run([PATH_SUITES[0][0]])'):
    rejected(selector_path, sources[selector_path] + '\n' + executable + '\n')

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
assert snapshot() == before, 'guard changed repository content'
print('production unreachable: cross-suite callers / workflows / AST mutations / read-only passed')
PY
