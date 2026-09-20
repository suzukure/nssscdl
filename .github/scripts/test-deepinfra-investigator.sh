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
grep -Fq 'actions: read' "$workflow"
grep -Fq 'contents: read' "$workflow"
grep -Fq 'issues: read' "$workflow"
grep -Fq 'persist-credentials: false' "$workflow"
grep -Fq 'ref: ${{ github.sha }}' "$workflow"
grep -Fq 'secrets.DEEPINFRA_API_KEY' "$workflow"
grep -Fq 'github.token' "$workflow"
grep -Fq 'deepseek-ai/DeepSeek-V4-Flash-0731' "$workflow"
grep -Fq 'deepseek-ai/DeepSeek-V4.1-Flash' "$workflow"
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
if grep -Eq '["'\'' ](push|commit|workflow run|issue comment|pr create)["'\'' ]' "$script"; then
  echo 'Investigator script contains a prohibited repository/action write command.' >&2
  exit 1
fi

python3 -m py_compile "$script"

SCRIPT="$script" python3 - <<'PY'
import importlib.util
import json
import os
from pathlib import Path

path = Path(os.environ["SCRIPT"])
spec = importlib.util.spec_from_file_location("investigator", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

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

try:
    m.repo_path("../secret")
    raise AssertionError("path traversal was accepted")
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
