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
# Verify the actual strict structured-output request payload, not only the
# investigate() call boundary.
captured_payloads = []
original_request = m.deepinfra_request
m.deepinfra_request = lambda payload: (
    captured_payloads.append(payload),
    {"usage": {}, "choices": [{"message": {"content": json.dumps({"ok": True})}}]},
)[1]
schema_for_payload = next(
    t["function"]["parameters"]
    for t in m.tool_defs()
    if t["function"]["name"] == "submit_analysis"
)
m.call_structured_final(
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    [{"role": "user", "content": "evidence"}],
    schema_for_payload,
)
payload = captured_payloads[0]
assert "tools" not in payload
assert payload["response_format"]["type"] == "json_schema"
assert payload["response_format"]["json_schema"]["name"] == "investigator_analysis"
assert payload["response_format"]["json_schema"]["strict"] is True
assert payload["response_format"]["json_schema"]["schema"] == schema_for_payload
assert payload["messages"][-1]["role"] == "user"
assert "read-tool budget is exhausted" in payload["messages"][-1]["content"]
assert payload["max_tokens"] == 4096
m.deepinfra_request = original_request

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
        "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
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
]
tool_sets = []
structured_calls = []

def fake_chat(model, messages, tools):
    names = [x["function"]["name"] for x in tools]
    tool_sets.append(names)
    return responses.pop(0)

def fake_structured_final(model, messages, schema):
    structured_calls.append((model, messages, schema))
    assert schema == next(
        t["function"]["parameters"]
        for t in m.tool_defs()
        if t["function"]["name"] == "submit_analysis"
    )
    assert any(
        message.get("role") == "tool" and "bounded evidence" in message.get("content", "")
        for message in messages
    )
    return {
        "usage": {"prompt_tokens": 20, "completion_tokens": 7, "total_tokens": 27},
        "choices": [{"message": {"content": json.dumps(good)}}],
    }

executed = []

def fake_execute(name, args, repo, base_sha):
    executed.append((name, args))
    return {"id": args["comment_id"], "body": "bounded evidence"}

m.call_chat = fake_chat
m.call_structured_final = fake_structured_final
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
assert len(tool_sets) == 1
assert "get_issue_comment" in tool_sets[0]
assert len(structured_calls) == 1
assert usage["total_tokens"] == 40

rejected = [x for x in trace if x.get("budget_exhausted")]
assert len(rejected) == 1
assert rejected[0]["tool"] == "get_issue_comment"
assert rejected[0]["ok"] is False
assert trace[-1]["tool"] == "submit_analysis"
assert trace[-1]["mode"] == "json_schema"
assert trace[-1]["ok"] is True

# Invalid structured final output must still fail closed.
bad_responses = [{
    "usage": {},
    "choices": [{"message": {"content": None, "tool_calls": [
        {
            "id": f"bad-read-{i}",
            "type": "function",
            "function": {
                "name": "get_issue_comment",
                "arguments": json.dumps({"comment_id": i}),
            },
        }
        for i in range(1, 5)
    ]}}],
}]
m.call_chat = lambda model, messages, tools: bad_responses.pop(0)
m.call_structured_final = lambda model, messages, schema: {
    "usage": {},
    "choices": [{"message": {"content": "{not-json"}}],
}
try:
    m.investigate(
        "owner/repo",
        328,
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "a" * 40,
        snapshot,
    )
    raise AssertionError("malformed structured final was accepted")
except m.InvestigatorError:
    pass

# Length truncation and malformed choice shapes must produce InvestigatorError.
length_responses = [{
    "usage": {},
    "choices": [{"finish_reason": "length", "message": {"content": json.dumps(good)}}],
}]
m.call_chat = lambda model, messages, tools: bad_responses.pop(0) if bad_responses else (_ for _ in ()).throw(AssertionError("unexpected tool call"))
m.call_structured_final = lambda model, messages, schema: length_responses.pop(0)
bad_responses = [{
    "usage": {},
    "choices": [{"message": {"content": None, "tool_calls": [
        {
            "id": f"length-read-{i}",
            "type": "function",
            "function": {
                "name": "get_issue_comment",
                "arguments": json.dumps({"comment_id": i}),
            },
        }
        for i in range(1, 5)
    ]}}],
}]
try:
    m.investigate(
        "owner/repo",
        328,
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "a" * 40,
        snapshot,
    )
    raise AssertionError("truncated structured final was accepted")
except m.InvestigatorError as exc:
    assert "truncated" in str(exc)

try:
    m.first_message({"choices": [None]}, "fixture")
    raise AssertionError("non-object choice was accepted")
except m.InvestigatorError:
    pass

m.MAX_TOOL_CALLS = original_tool_calls
m.MAX_ROUNDS = original_rounds
print("DeepInfra budget-finalization fixture tests passed.")
PY
