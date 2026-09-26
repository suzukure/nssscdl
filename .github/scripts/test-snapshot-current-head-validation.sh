#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/snapshot-current-head-validation.py" <<'PY'
import contextlib
import importlib.util
import io
import json
import sys
import urllib.parse

spec = importlib.util.spec_from_file_location("snapshot", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sha = "a" * 40
started = 1000
created = "1970-01-01T00:16:50Z"
pr = {"number": 37, "head": {"sha": sha, "ref": "ai/issue-36",
      "repo": {"full_name": "owner/repo"}}, "labels": [{"name": "ai-followup-in-progress"}]}
workflow = {"id": 44, "path": ".github/workflows/traceability-check.yml"}
run = {"id": 50, "workflow_id": 44, "head_sha": sha, "event": "pull_request",
       "created_at": created, "pull_requests": [{"number": 37}]}
job = {"name": "Linked Issue", "status": "completed", "conclusion": "success"}
render = []
developer = []

def get(path):
    if path.endswith("/pulls/37"):
        return pr
    if path.endswith("/actions/workflows/traceability-check.yml"):
        return workflow
    if path.endswith("/git/ref/heads/ai/issue-36"):
        return {"ref": "refs/heads/ai/issue-36", "object": {"sha": sha}}
    raise AssertionError(path)

def pages(path, key):
    if "traceability-check.yml/runs" in path:
        return [run]
    if "/actions/runs/50/jobs" in path:
        return [job]
    if "render-plantuml.yml/runs" in path:
        return render
    if "ai-developer.yml/runs" in path:
        return developer
    raise AssertionError(path)

real_pages = module.pages
module.get = get
module.pages = pages
sys.argv = [sys.argv[1], "owner/repo", "37", sha, "1", "pushed", str(started), "99"]

def snapshot():
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        module.main()
    return json.loads(output.getvalue())

assert snapshot()["checks"] == [{"name": "PR Traceability / Linked Issue",
                                "sha": sha, "status": "success"}]
for state in ("queued", "in_progress", "requested", "waiting", "pending"):
    assert module.status({"status": state}) == "pending"
for conclusion in ("failure", "cancelled", "skipped", "neutral", "timed_out",
                   "action_required", "stale", "startup_failure"):
    assert module.status({"status": "completed", "conclusion": conclusion}) == "failure"
for bad in ({"status": "unknown"}, {"status": "completed", "conclusion": "unknown"}):
    try:
        module.status(bad)
    except ValueError:
        pass
    else:
        raise AssertionError("unknown GitHub state was accepted")
job["status"] = "completed"
job["conclusion"] = "skipped"
assert snapshot()["checks"][0]["status"] == "failure"
job["status"] = "in_progress"
job["conclusion"] = None
assert snapshot()["checks"][0]["status"] == "pending"
run["created_at"] = "1970-01-01T00:16:39Z"
assert snapshot()["checks"] == []  # Old Draft skip is not current-cycle evidence.
run["created_at"] = created
run["workflow_id"] = 45
assert snapshot()["checks"] == []  # Raw job name does not prove workflow identity.
run["workflow_id"] = 44
render.append({"id": 51, "head_branch": "ai/issue-36", "head_sha": sha,
               "event": "push", "status": "in_progress"})
assert snapshot()["branch_mutating_runs"][0]["status"] == "pending"
developer.append({"id": 99, "head_branch": "ai/issue-36", "head_sha": sha,
                  "event": "pull_request_review", "status": "in_progress"})
assert len(snapshot()["branch_mutating_runs"]) == 1  # This orchestrator is excluded.
developer.append({"id": 100, "head_branch": "ai/issue-36", "head_sha": sha,
                  "event": "pull_request_review", "status": "in_progress"})
assert len(snapshot()["branch_mutating_runs"]) == 2
module.get = lambda path: {"total_count": 2, "jobs": [{"name": "Linked Issue"}]}
try:
    real_pages("repos/owner/repo/actions/runs/50/jobs", "jobs")
except ValueError:
    pass
else:
    raise AssertionError("incomplete API listing was accepted")
print("Current-head snapshot tests passed.")
PY
