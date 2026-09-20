#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/.github/scripts/deepinfra-investigator.py"

SCRIPT="$script" REPO_ROOT="$repo_root" python3 - <<'PY'
import importlib.util
import json
import os
import tempfile
from argparse import Namespace
from pathlib import Path

path = Path(os.environ["SCRIPT"])
spec = importlib.util.spec_from_file_location("investigator_checkpoint", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.chdir(os.environ["REPO_ROOT"])

issue_payload = {
    "number": 328,
    "title": "investigation",
    "state": "open",
    "html_url": "https://example.invalid/issues/328",
    "labels": [{"name": "investigation"}],
    "body": "issue body",
    "comments": 9,
}
bodies = [
    "old checkpoint",
    "Run #99 result",
    "Run #100 result",
    "Run #101 started",
    "Run #101 result",
    "Run #102 started",
    "Run #102 confirmed result",
    "/deepseek analyze",
    "/deepseek analyze v4.1",
]
comments = [
    {
        "id": i,
        "user": {"login": "user"},
        "author_association": "OWNER",
        "created_at": f"2026-09-20T00:00:0{i}Z",
        "html_url": f"https://example.invalid/comments/{i}",
        "issue_url": "https://example.invalid/issues/328",
        "body": body,
    }
    for i, body in enumerate(bodies, start=1)
]

original_gh_json = m.gh_json

def fake_gh_json(repo, endpoint, timeout=25):
    if endpoint == "issues/328":
        return issue_payload
    if endpoint == "issues/328/comments?per_page=100&page=1":
        return comments
    if endpoint == "issues/comments/7":
        return comments[6]
    raise AssertionError(f"unexpected endpoint: {endpoint}")

m.gh_json = fake_gh_json
snapshot = m.issue_snapshot("owner/repo", 328)

assert snapshot["comments_total"] == 9
assert [x["id"] for x in snapshot["latest_comments_newest_first"]] == [7, 6, 5, 4, 3, 2]
assert snapshot["latest_comments_newest_first"][0]["body"] == "Run #102 confirmed result"
assert snapshot["comment_index_oldest_first"][-1]["control_command"] is True
assert snapshot["comment_index_oldest_first"][-2]["control_command"] is True
assert snapshot["comment_index_oldest_first"][-3]["first_line"] == "Run #102 confirmed result"

comment = m.execute("get_issue_comment", {"comment_id": 7}, "owner/repo", "a" * 40)
assert comment["id"] == 7
assert comment["body"] == "Run #102 confirmed result"
assert any(t["function"]["name"] == "get_issue_comment" for t in m.tool_defs())

good = {
    "summary": "current state includes Run #102",
    "hypotheses": [{
        "id": "H1",
        "statement": "statement",
        "status": "open",
        "confidence": "medium",
        "evidence": [{"source": "issue#328-comment-7", "observation": "Run #102 is latest evidence"}],
        "gaps": ["gap"],
    }],
    "unresolved_causality": ["unknown"],
    "next_probe": None,
    "escalation": {"recommended": False, "target": "none", "reason": "not needed"},
}

responses = [
    {
        "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
        "choices": [{"message": {"content": None, "tool_calls": [{
            "id": "call-1",
            "type": "function",
            "function": {
                "name": "get_issue_comment",
                "arguments": json.dumps({"comment_id": 7}),
            },
        }]}}],
    },
    {
        "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28},
        "choices": [{"message": {"content": None, "tool_calls": [{
            "id": "call-2",
            "type": "function",
            "function": {
                "name": "submit_analysis",
                "arguments": json.dumps(good),
            },
        }]}}],
    },
]

def fake_chat(model, messages, tools):
    prompt = messages[0]["content"]
    assert "CURRENT ISSUE SNAPSHOT" in prompt
    assert "Run #102 confirmed result" in prompt
    assert "Before proposing a probe" in prompt
    assert any(t["function"]["name"] == "get_issue_comment" for t in tools)
    return responses.pop(0)

def fake_execute(name, args, repo, base_sha):
    assert name == "get_issue_comment"
    return {
        "id": args["comment_id"],
        "body": "Run #102 confirmed result with detailed evidence",
    }

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

assert analysis["summary"] == "current state includes Run #102"
assert usage["total_tokens"] == 42
assert trace[0]["tool"] == "bootstrap_issue"
assert trace[0]["latest_comment_ids"][0] == 7
assert trace[1]["tool"] == "get_issue_comment"
assert trace[1]["comment_id"] == 7
assert trace[-1]["tool"] == "submit_analysis"
assert all("body" not in entry and "result" not in entry for entry in trace)
assert "Run #102 confirmed result with detailed evidence" not in json.dumps(trace)

with tempfile.TemporaryDirectory() as td:
    out_json = Path(td) / "result.json"
    out_md = Path(td) / "result.md"
    args = Namespace(
        repo="owner/repo",
        issue=328,
        base_sha="a" * 40,
        model="deepseek-ai/DeepSeek-V4-Flash-0731",
        output_json=out_json,
        output_md=out_md,
    )
    m.write_outputs(analysis, usage, trace, args)
    envelope = json.loads(out_json.read_text())
    markdown = out_md.read_text()
    assert envelope["schema_version"] == 2
    assert envelope["tool_trace"] == trace
    assert "## Tool trace" in markdown
    assert "get_issue_comment" in markdown
    assert "Run #102 confirmed result with detailed evidence" not in markdown

m.gh_json = original_gh_json
print("DeepInfra latest-checkpoint fixture tests passed.")
PY
