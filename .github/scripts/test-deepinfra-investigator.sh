#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$repo_root/.github/workflows/deepinfra-investigator.yml"
script="$repo_root/.github/scripts/deepinfra-investigator.py"

test -f "$workflow"
test -f "$script"
grep -Fxq 'name: DeepInfra Investigator' "$workflow"
grep -Fq 'issue_comment:' "$workflow"
grep -Fq "github.event.comment.body == '/deepseek analyze'" "$workflow"
grep -Fq "github.event.comment.body == '/deepseek analyze v4.1'" "$workflow"
grep -Fq '["OWNER","MEMBER","COLLABORATOR"]' "$workflow"
grep -Fq 'github.event.issue.author_association' "$workflow"
grep -Fq 'actions: read' "$workflow"
grep -Fq 'contents: read' "$workflow"
grep -Fq 'issues: read' "$workflow"
grep -Fq 'persist-credentials: false' "$workflow"
grep -Fq 'ref: ${{ github.sha }}' "$workflow"
grep -Fq 'secrets.DEEPINFRA_API_KEY' "$workflow"
grep -Fq 'github.token' "$workflow"
grep -Fq 'deepseek-ai/DeepSeek-V4-Flash-0731' "$workflow"
grep -Fq 'deepseek-ai/DeepSeek-V4.1-Flash' "$workflow"
grep -Fq '"tool_choice": "required"' "$script"
if grep -Fq '"tool_choice": "auto"' "$script"; then
  echo 'Investigator protocol requires structured tool calls; tool_choice=auto is not allowed.' >&2
  exit 1
fi
grep -Fq 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' "$workflow"
grep -Fq 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' "$workflow"

if grep -Eq '^[[:space:]]+[A-Za-z-]+: write$|permissions:[[:space:]]*write-all' "$workflow"; then
  echo 'DeepInfra Investigator must not grant write permissions.' >&2
  exit 1
fi
if grep -Eq 'gh[[:space:]]+(issue[[:space:]]+comment|workflow[[:space:]]+run|pr[[:space:]]+create)|git[[:space:]]+(push|commit)' "$workflow"; then
  echo 'DeepInfra Investigator workflow contains a repository/action write.' >&2
  exit 1
fi
if [ "$(grep -Fc 'secrets.DEEPINFRA_API_KEY' "$workflow")" -ne 1 ]; then
  echo 'DeepInfra API key must be scoped to exactly one workflow step.' >&2
  exit 1
fi
if grep -Fq 'shell=True' "$script"; then
  echo 'Investigator must not execute model-controlled shell strings.' >&2
  exit 1
fi
if grep -Eq '\["git",[[:space:]]*"(commit|push)"|\["gh",[[:space:]]*"pr",[[:space:]]*"(create|merge)"|\["gh",[[:space:]]*"workflow",[[:space:]]*"run"|\["gh",[[:space:]]*"issue",[[:space:]]*"comment"' "$script"; then
  echo 'Investigator script contains a prohibited repository/action write command.' >&2
  exit 1
fi

python3 -m py_compile "$script"

SCRIPT="$script" REPO_ROOT="$repo_root" python3 - <<'PY'
import copy
import importlib.util
import json
import os
from pathlib import Path

path = Path(os.environ["SCRIPT"])
spec = importlib.util.spec_from_file_location("investigator", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.chdir(os.environ["REPO_ROOT"])

assert m.ALLOWED_MODELS == {
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "deepseek-ai/DeepSeek-V4.1-Flash",
}

os.environ["DEEPINFRA_API_KEY"] = "secret-deepinfra-12345"
os.environ["GH_TOKEN"] = "github_pat_secret_12345"
redacted = m.sanitize("secret-deepinfra-12345 github_pat_secret_12345 Authorization: Bearer abc")
assert "secret-deepinfra" not in redacted
assert "github_pat_secret" not in redacted
assert "Bearer abc" not in redacted

for bad in ("../secret", "/etc/passwd", ".git/config", "a/../../b", "a b"):
    try:
        m.repo_path(bad)
        raise AssertionError(f"unsafe path accepted: {bad}")
    except m.InvestigatorError:
        pass

good = {
    "summary": "summary",
    "hypotheses": [{
        "id": "H1",
        "statement": "statement",
        "status": "open",
        "confidence": "medium",
        "evidence": [{"source": "issue#328", "observation": "observed"}],
        "gaps": ["gap"],
    }],
    "unresolved_causality": ["unknown"],
    "next_probe": None,
    "escalation": {"recommended": False, "target": "none", "reason": "not needed"},
}
assert m.validate_analysis(good) is good

submit = next(t["function"]["parameters"] for t in m.tool_defs() if t["function"]["name"] == "submit_analysis")
assert submit["properties"]["summary"]["maxLength"] == 10000
assert submit["properties"]["hypotheses"]["minItems"] == 1
assert submit["properties"]["hypotheses"]["maxItems"] == 20
assert submit["properties"]["unresolved_causality"]["maxItems"] == 30
assert submit["properties"]["unresolved_causality"]["items"]["maxLength"] == 2000

for invalid_value in ([{"x": 1}], ["x" * 2001]):
    bad = copy.deepcopy(good)
    bad["unresolved_causality"] = invalid_value
    try:
        m.validate_analysis(bad)
        raise AssertionError(f"invalid unresolved_causality accepted: {type(invalid_value[0])}")
    except m.InvestigatorError:
        pass

normalized = copy.deepcopy(good)
normalized["escalation"] = {"recommended": False, "target": "astra", "reason": "needs specialist review"}
assert m.validate_analysis(normalized)["escalation"]["recommended"] is True

head = m.run(["git", "rev-parse", "HEAD"]).strip()
assert len(head) == 40
paths = m.execute("list_repo_paths", {"prefix": ".github/scripts/", "limit": 200}, "owner/repo", head)
assert ".github/scripts/deepinfra-investigator.py" in paths["paths"]
matches = m.execute("search_repository", {"query": "DeepInfra Investigator", "limit": 40}, "owner/repo", head)
assert matches["matches"]
read = m.execute(
    "read_file",
    {"path": ".github/scripts/deepinfra-investigator.py", "start_line": 1, "end_line": 40},
    "owner/repo",
    head,
)
assert "ALLOWED_MODELS" in read["content"]
same = m.execute("compare_commits", {"base": head, "head": head, "limit": 20}, "owner/repo", head)
assert same["files"] == []
assert same["truncated"] is False
try:
    m.execute(
        "read_file",
        {"path": ".github/scripts/deepinfra-investigator.py", "start_line": 1, "end_line": 401},
        "owner/repo",
        head,
    )
    raise AssertionError("read_file accepted more than 400 lines")
except m.InvestigatorError:
    pass

original_gh_json = m.gh_json
original_run = m.run
log_calls = []
m.gh_json = lambda repo, endpoint, timeout=25: {"run_id": 123} if endpoint == "actions/jobs/456" else {}
m.run = lambda args, **kwargs: log_calls.append(args) or "line before\nneedle\nline after\n"
excerpt = m.execute(
    "get_job_log_excerpt",
    {"run_id": 123, "job_id": 456, "pattern": "needle", "context_lines": 1},
    "owner/repo",
    head,
)
assert excerpt["matched"] is True
assert excerpt["run_id"] == 123 and excerpt["job_id"] == 456
assert any("456" in args for args in log_calls)

m.gh_json = lambda repo, endpoint, timeout=25: {"run_id": 999}
m.run = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("log read ran before identity rejection"))
try:
    m.execute(
        "get_job_log_excerpt",
        {"run_id": 123, "job_id": 456, "pattern": "needle", "context_lines": 1},
        "owner/repo",
        head,
    )
    raise AssertionError("mismatched run_id/job_id was accepted")
except m.InvestigatorError:
    pass
m.gh_json = original_gh_json
m.run = original_run

responses = [
    {
        "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14, "estimated_cost": 0.001},
        "choices": [{"message": {"content": None, "tool_calls": [{
            "id": "call-1", "type": "function",
            "function": {"name": "get_issue", "arguments": json.dumps({"issue_number": 328})}
        }]}}],
    },
    {
        "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28, "estimated_cost": 0.002},
        "choices": [{"message": {"content": None, "tool_calls": [{
            "id": "call-2", "type": "function",
            "function": {"name": "submit_analysis", "arguments": json.dumps(good)}
        }]}}],
    },
]
seen = []

def fake_chat(model, messages, tools):
    assert model == "deepseek-ai/DeepSeek-V4-Flash-0731"
    assert messages[0]["role"] == "user"
    assert all(message.get("role") != "system" for message in messages)
    assert "UNTRUSTED DATA" in messages[0]["content"]
    assert any(t["function"]["name"] == "submit_analysis" for t in tools)
    return responses.pop(0)

def fake_execute(name, args, repo, base_sha):
    seen.append((name, args, repo, base_sha))
    return {"number": 328, "title": "test"}

m.call_chat = fake_chat
m.execute = fake_execute
analysis, usage = m.investigate(
    "owner/repo",
    328,
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "a" * 40,
)
assert analysis["summary"] == "summary"
assert seen[0][0] == "get_issue"
assert usage["total_tokens"] == 42
assert abs(usage["estimated_cost_usd"] - 0.003) < 1e-12

m.call_chat = lambda *_: {
    "usage": {},
    "choices": [{"message": {"content": "free form final"}}],
}
try:
    m.investigate("owner/repo", 328, "deepseek-ai/DeepSeek-V4-Flash-0731", "a" * 40)
    raise AssertionError("free-form final was accepted")
except m.InvestigatorError:
    pass

try:
    m.investigate("owner/repo", 328, "untrusted/model", "a" * 40)
    raise AssertionError("untrusted model was accepted")
except m.InvestigatorError:
    pass

print("DeepInfra investigator unit checks passed.")
PY

echo 'DeepInfra Investigator fixture tests passed.'
