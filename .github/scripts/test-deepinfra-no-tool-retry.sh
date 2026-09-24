#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/.github/scripts/deepinfra-investigator.py"

SCRIPT="$script" python3 - <<'PY'
import importlib.util
import json
import os
from pathlib import Path

path = Path(os.environ["SCRIPT"])
spec = importlib.util.spec_from_file_location("investigator_no_tool_retry", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

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
    "summary": "ok",
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

responses = [
    {
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
        "choices": [{"message": {"content": "plain text", "tool_calls": []}}],
    },
    {
        "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14},
        "choices": [{"message": {"content": None, "tool_calls": [{
            "id": "submit-1",
            "type": "function",
            "function": {"name": "submit_analysis", "arguments": json.dumps(good)},
        }]}}],
    },
]

seen_messages = []
def fake_chat(model, messages, tools):
    seen_messages.append([dict(x) for x in messages])
    return responses.pop(0)

m.call_chat = fake_chat
analysis, usage = m.investigate(
    "owner/repo",
    328,
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "a" * 40,
    snapshot,
)
trace = usage.pop("_tool_trace")

assert analysis["summary"] == "ok"
assert usage["total_tokens"] == 26
assert any(x.get("tool") == "protocol_retry" for x in trace)
assert len(seen_messages) == 2
assert "Protocol reminder:" in seen_messages[1][-1]["content"]

responses = [
    {"usage": {}, "choices": [{"message": {"content": "plain", "tool_calls": []}}]},
    {"usage": {}, "choices": [{"message": {"content": "still plain", "tool_calls": []}}]},
]
m.call_chat = lambda *args, **kwargs: responses.pop(0)
try:
    m.investigate(
        "owner/repo",
        328,
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "a" * 40,
        snapshot,
    )
    raise AssertionError("two consecutive no-tool responses were accepted")
except m.InvestigatorError as exc:
    assert "after retry" in str(exc)

print("DeepInfra no-tool retry fixture tests passed.")
PY
