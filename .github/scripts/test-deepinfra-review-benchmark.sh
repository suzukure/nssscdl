#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$repo_root/.github/workflows/deepinfra-review-benchmark.yml"
script="$repo_root/.github/scripts/deepinfra-review-benchmark.py"

test -s "$workflow"
test -s "$script"

grep -Fq 'workflow_dispatch:' "$workflow"
if grep -Eq '^[[:space:]]+(pull_request|issue_comment|schedule):' "$workflow"; then
  echo 'Benchmark workflow must remain manual-only.' >&2
  exit 1
fi
grep -Fq 'if: github.ref_name == github.event.repository.default_branch' "$workflow"
grep -Fq 'contents: read' "$workflow"
grep -Fq 'issues: read' "$workflow"
grep -Fq 'persist-credentials: false' "$workflow"
grep -Fq 'fetch-depth: 0' "$workflow"
grep -Fq 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' "$workflow"
grep -Fq 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' "$workflow"
grep -Fq 'DEEPINFRA_API_KEY: ${{ secrets.DEEPINFRA_API_KEY }}' "$workflow"

if grep -Eq '(^|[[:space:]])(contents|issues|pull-requests|actions|checks|workflows): write' "$workflow"; then
  echo 'Benchmark workflow unexpectedly requests write permission.' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]+(strategy|matrix):' "$workflow"; then
  echo 'Benchmark workflow must not fan out into an automatic matrix.' >&2
  exit 1
fi
if [ "$(grep -Fc 'DEEPINFRA_API_KEY:' "$workflow")" -ne 1 ]; then
  echo 'DeepInfra key must be scoped only to the paid benchmark step.' >&2
  exit 1
fi

python3 - "$repo_root" <<'PY'
import importlib.util
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
path = root / ".github/scripts/deepinfra-review-benchmark.py"
spec = importlib.util.spec_from_file_location("benchmark", path)
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

assert set(m.CASES) == {
    "A01-defect", "A01-fixed",
    "A02-defect", "A02-fixed",
    "A03-defect", "A03-fixed",
    "A04-defect", "A04-fixed",
    "A05-control", "A06-control",
}
for case in m.CASES.values():
    assert set(case) == {"pr", "issue", "base", "head"}
    assert len(case["base"]) == 40
    assert len(case["head"]) == 40

assert set(m.MODEL_PRICES_PER_MILLION) == {
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "zai-org/GLM-5.3-Flash",
    "deepseek-ai/DeepSeek-V4-Pro-0813",
}
try:
    m.selected_case("unknown")
    raise AssertionError("unknown case accepted")
except m.BenchmarkError:
    pass
try:
    m.validate_model("arbitrary/model")
    raise AssertionError("unknown model accepted")
except m.BenchmarkError:
    pass

schema = m.production_review_schema()
assert set(schema["properties"]) == {
    "verdict", "summary", "blocking_findings", "non_blocking_findings", "linked_issues_checked"
}
approve = {
    "verdict": "approve",
    "summary": "no blocking defect",
    "blocking_findings": [],
    "non_blocking_findings": ["minor"],
    "linked_issues_checked": ["#313"],
}
assert m.validate_review(approve) is approve
request_changes = {
    "verdict": "request_changes",
    "summary": "blocking defect",
    "blocking_findings": ["must fix"],
    "non_blocking_findings": [],
    "linked_issues_checked": ["#313"],
}
assert m.validate_review(request_changes) is request_changes
for bad in (
    {**approve, "blocking_findings": ["contradiction"]},
    {**request_changes, "blocking_findings": []},
    {**approve, "verdict": "maybe"},
):
    try:
        m.validate_review(bad)
        raise AssertionError("invalid review accepted")
    except m.BenchmarkError:
        pass

cost = m.estimate_cost_usd("deepseek-ai/DeepSeek-V4.1-Flash", 1_000_000, 1_000_000)
assert abs(cost - 0.56) < 1e-12
cost = m.estimate_cost_usd("zai-org/GLM-5.3-Flash", 2_000_000, 1_000_000)
assert abs(cost - 0.40) < 1e-12

body = """## Scope-out impact and follow-up

- Follow-up Issue: #10
- Follow-up Issue: #11

## Next
- Follow-up Issue: #99
"""
assert m.extract_follow_up_issues(body) == [10, 11]
assert m.extract_follow_up_issues("## Scope-out impact and follow-up\n\n- Follow-up Issue: none\n") == []

case_id = "A01-defect"
case = m.CASES[case_id]
git_calls = []

def fake_git(args, timeout=25):
    git_calls.append(list(args))
    if args[:2] == ["cat-file", "-e"]:
        return ""
    if args and args[0] == "diff" and "--name-only" in args:
        assert case["base"] in args and case["head"] in args
        return "docs/example.md\n"
    if args and args[0] == "diff":
        assert case["base"] in args and case["head"] in args
        return "diff --git a/docs/example.md b/docs/example.md\n+selected historical change\n"
    raise AssertionError(f"unexpected git call: {args}")

def fake_issue(repo, number):
    if number == case["issue"]:
        return {
            "number": number,
            "title": "closing issue",
            "state": "open",
            "updated_at": "2026-09-20T00:00:00Z",
            "body": "contract body\n\n## Scope-out impact and follow-up\n\n- Follow-up Issue: #999\n",
        }
    assert number == 999
    return {
        "number": 999,
        "title": "follow-up",
        "state": "open",
        "updated_at": "2026-09-20T00:00:01Z",
        "body": "follow-up contract only",
    }

m.git_output = fake_git
m.fetch_issue = fake_issue
m.historical_file_content = lambda head, path: (
    "selected historical file" if head == case["head"] and path == "docs/example.md"
    else (_ for _ in ()).throw(AssertionError("wrong historical head/path"))
)
m.current_text = lambda path: (
    "# trusted current reviewer instructions" if path == "CLAUDE.md"
    else "# trusted current agent instructions" if path == "AGENTS.md"
    else (_ for _ in ()).throw(AssertionError(f"unexpected current file {path}"))
)
context, meta = m.build_context("owner/repo", case_id)
assert meta["base_sha"] == case["base"]
assert meta["selected_head_sha"] == case["head"]
assert meta["follow_up_issues"] == [999]
assert "#342" not in context
assert "Claude review\n\n**Verdict:**" not in context
assert "selected historical change" in context
assert "selected historical file" in context
assert "follow-up contract only" in context
assert all("HEAD" not in arg and "main" not in arg for call in git_calls for arg in call)

old_limit = m.MAX_CONTEXT_CHARS
m.MAX_CONTEXT_CHARS = 20
try:
    m.build_context("owner/repo", case_id)
    raise AssertionError("oversized context accepted")
except m.BenchmarkError:
    pass
finally:
    m.MAX_CONTEXT_CHARS = old_limit

source = path.read_text(encoding="utf-8")
assert "pulls/{pr}/reviews" not in source
assert "/reviews" not in source
assert "expected_verdict" not in source
assert "expected_findings" not in source
assert "deepinfra_request(" in source
assert "response_format" in source and '"json_schema"' in source
assert '"tools"' not in source
PY

echo 'DeepInfra review benchmark fixture tests passed.'
