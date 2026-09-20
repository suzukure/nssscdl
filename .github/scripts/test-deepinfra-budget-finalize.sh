#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/.github/scripts/deepinfra-investigator.py"

SCRIPT="$script" REPO_ROOT="$repo_root" python3 - <<'PY'
import importlib.util
import json
import os
from pathlib import Path

path = Path(os.environ["SCRIPT"])
spec = importlib.util.spec_from_file_location("investigator_budget_finalize", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.chdir(os.environ["REPO_ROOT"])

snapshot = {
    "number": 328,
    "title": "investigation",
    "state": "open",
    "labels": [],
    "body": "",
    "comments_total": 0,
    "latest_comments_newest_first": [],
    "comment_index_oldest_first": [],
}
good = {
    "summary": "finalized from gathered evidence",
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

original_tool_calls = m.MAX_TOOL_CALLS
original_rounds = m.MAX_ROUNDS
m.MAX_TOOL_CALLS = 3
m.MAX_ROUNDS = 4

responses = [
    {
        "usage": {},
        "choices": [{"message": {"content": None, "tool_calls": [
            {
                "id": f"read-{i}",
                "type": "function",
                "function": {
                    "name": "get_issue_comment",
                    "arguments": json.dumps({"comment_id": i}),
                },
            }
            for i in range(1, 5)
        ]}}],
    },
    {
        "usage": {},
        "choices": [{"message": {"content": None, "tool_calls": [{
            "id": "submit-final",
            "type": "function",
            "function": {
                "name": "submit_analysis",
                "arguments": json.dumps(good),
            },
        }]}}],
    },
]
tool_sets = []

def fake_chat(model, messages, tools):
    names = [x["function"]["name"] for x in tools]
    tool_sets.append(names)
    return responses.pop(0)

executed = []

def fake_execute(name, args, repo, base_sha):
    executed.append((name, args))
    return {"id": args["comment_id"], "body": "bounded evidence"}

m.call_chat = fake_chat
m.execute = fake_execute
analysis, usage = m.investigate(
    "owner/repo",
    328,
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "a" * 40,
    snapshot,
)
trace = usage.pop("_tool_trace")

assert analysis["summary"] == "finalized from gathered evidence"
assert len(executed) == 3
assert all(name == "get_issue_comment" for name, _ in executed)
assert len(tool_sets) == 2
assert "get_issue_comment" in tool_sets[0]
assert tool_sets[1] == ["submit_analysis"]

rejected = [x for x in trace if x.get("budget_exhausted")]
assert len(rejected) == 1
assert rejected[0]["tool"] == "get_issue_comment"
assert rejected[0]["ok"] is False
assert trace[-1]["tool"] == "submit_analysis"
assert trace[-1]["ok"] is True

m.MAX_TOOL_CALLS = original_tool_calls
m.MAX_ROUNDS = original_rounds
print("DeepInfra budget-finalization fixture tests passed.")
PY
