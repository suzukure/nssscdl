#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/.github/scripts/deepinfra-diagnostic-b.py"
workflow="$repo_root/.github/workflows/deepinfra-diagnostic-b.yml"
test -s "$script" && test -s "$workflow"
grep -Fq 'workflow_dispatch:' "$workflow"
grep -Fq 'if: github.ref_name == github.event.repository.default_branch' "$workflow"
grep -Fq 'contents: read' "$workflow"
grep -Fq 'issues: read' "$workflow"
grep -Fq 'DEEPINFRA_API_KEY: ${{ secrets.DEEPINFRA_API_KEY }}' "$workflow"
if grep -Eq '(^|[[:space:]])(contents|issues|pull-requests|actions|checks|workflows): write' "$workflow"; then exit 1; fi
if [ "$(grep -Fc 'DEEPINFRA_API_KEY:' "$workflow")" -ne 1 ]; then exit 1; fi

PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root" <<'PY'
import importlib.util, json, pathlib, sys, tempfile
root = pathlib.Path(sys.argv[1]); path = root / '.github/scripts/deepinfra-diagnostic-b.py'
spec = importlib.util.spec_from_file_location('diagnostic_b', path); assert spec and spec.loader
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert (m.CASE_ID, m.MODEL, m.BASE_SHA, m.HEAD_SHA) == ('A04-defect', 'deepseek-ai/DeepSeek-V4-Flash-0731', '52d16de6a07e336f87dbdbc2ab5a2a8be86aa410', '8cfa0572d3640527265aa33c412c92e80779562a')
assert m.PREVIOUS_COST_USD < m.TOTAL_COST_CEILING_USD
assert set(x['function']['name'] for x in m.tool_definitions()) == {'list_selected_head_paths', 'search_selected_head', 'read_selected_head_file', 'inspect_selected_diff'}
source = path.read_text()
assert 'subprocess' not in source and 'os.system' not in source
assert 'HEAD_SHA' in source and 'BASE_SHA' in source
assert 'MAX_TOOL_CALLS' in source and 'MAX_ROUNDS' in source and 'MAX_TOOL_RESULT_CHARS' in source
assert 'json_schema' in source and 'benchmark.validate_review' in source
assert 'benchmark.build_context(args.repo, CASE_ID, diagnostic_a=True)' in source

calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    if args[:3] == ['git', 'ls-tree', '-r']: return 'a.txt\ndir/b.txt\n'
    if args[:3] == ['git', 'grep', '-n']: return '8:a.txt:needle\n'
    if args[:2] == ['git', 'show']: return 'one\ntwo\n'
    if args[:3] == ['git', 'diff', '--name-only']: return 'a.txt\n'
    if args[:3] == ['git', 'diff', '--no-ext-diff']: return 'diff --git a/a.txt b/a.txt\n'
    raise AssertionError(args)
m.shared.run = fake_run
assert m.execute_tool('list_selected_head_paths', {'limit': 1})['paths'] == ['a.txt']
assert m.execute_tool('search_selected_head', {'query': 'needle'})['matches'] == ['8:a.txt:needle']
assert '1: one' in m.execute_tool('read_selected_head_file', {'path': 'a.txt', 'end_line': 1})['content']
assert m.execute_tool('inspect_selected_diff', {'view': 'paths'})['base'] == m.BASE_SHA
for args in calls:
    assert any(m.HEAD_SHA in arg for arg in args)
try:
    m.execute_tool('read_selected_head_file', {'path': '../bad'})
    raise AssertionError('path escape accepted')
except (m.DiagnosticBError, m.shared.InvestigatorError): pass

usage = {'local_estimated_cost_usd': 0.05}
with tempfile.TemporaryDirectory() as tmp:
    out_json = pathlib.Path(tmp) / 'result.json'; out_md = pathlib.Path(tmp) / 'result.md'
    m.write_outputs({}, {'verdict': 'approve', 'summary': 'x', 'blocking_findings': [], 'non_blocking_findings': [], 'linked_issues_checked': []}, usage, {'status': 'valid', 'structured_output_valid': True, 'reason': None}, [], out_json, out_md)
    result = json.loads(out_json.read_text())
    assert result['benchmark'] == 'issue-368-diagnostic-b'
    assert result['validation']['status'] == 'failed' and result['review'] is None
PY

echo 'DeepInfra Diagnostic B fixture tests passed.'
