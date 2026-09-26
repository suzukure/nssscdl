#!/usr/bin/env python3
"""Collect trusted GitHub facts for evaluate-current-head-validation.sh.

The caller supplies only the fixed write decision, expected SHA, round and
write timestamp. Every live state is fetched again on each invocation.
"""
import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.error
import urllib.request


def fail(message):
    raise ValueError(message)


def timestamp(value):
    if not isinstance(value, str):
        fail("invalid timestamp")
    return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def get(path):
    request = urllib.request.Request(
        "https://api.github.com/" + path,
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def pages(path, key):
    result = []
    page = 1
    while True:
        separator = "&" if "?" in path else "?"
        body = get(f"{path}{separator}per_page=100&page={page}")
        if not isinstance(body, dict) or not isinstance(body.get(key), list):
            fail("incomplete API listing")
        items = body[key]
        result.extend(items)
        if len(items) < 100:
            if body.get("total_count", len(result)) > len(result):
                fail("incomplete API listing")
            return result
        page += 1
        if page > 100:
            fail("API listing too large")


def status(item):
    state = item.get("status")
    if state in ("queued", "in_progress", "requested", "waiting", "pending"):
        return "pending"
    if state != "completed":
        fail("unknown GitHub status")
    conclusion = item.get("conclusion")
    if conclusion == "success":
        return "success"
    if conclusion in ("failure", "cancelled", "skipped", "neutral", "timed_out",
                      "action_required", "stale", "startup_failure"):
        return "failure"
    fail("unknown GitHub conclusion")


def main():
    repo, pr_number, sha, round_number, write, started, current_run_id = sys.argv[1:]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        fail("invalid repository")
    if not all(re.fullmatch(r"[1-9][0-9]*", value) for value in (pr_number, round_number)):
        fail("invalid number")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or write not in ("pushed", "no_diff"):
        fail("invalid write identity")
    started = int(started)
    current_run_id = int(current_run_id)
    pr = get(f"repos/{repo}/pulls/{pr_number}")
    if (pr.get("number") != int(pr_number) or pr.get("head", {}).get("repo", {}).get("full_name") != repo
            or not re.fullmatch(r"[0-9a-f]{40}", pr.get("head", {}).get("sha", ""))):
        fail("invalid current PR")
    current_sha = pr["head"]["sha"]
    head_ref = pr["head"].get("ref")
    if not isinstance(head_ref, str) or not re.fullmatch(r"ai/issue-[1-9][0-9]*", head_ref):
        fail("invalid PR branch")
    branch = get(f"repos/{repo}/git/ref/heads/{head_ref}")
    branch_sha = branch.get("object", {}).get("sha")
    if branch.get("ref") != "refs/heads/" + head_ref or not isinstance(branch_sha, str) \
            or not re.fullmatch(r"[0-9a-f]{40}", branch_sha):
        fail("invalid branch tip")
    labels = pr.get("labels")
    if not isinstance(labels, list) or any(not isinstance(label.get("name"), str) for label in labels):
        fail("invalid PR labels")
    paused = any(label["name"] == "human-review-required" for label in labels)

    query = urllib.parse.urlencode({"head_sha": current_sha, "event": "pull_request"})
    workflow = get(f"repos/{repo}/actions/workflows/traceability-check.yml")
    if not isinstance(workflow.get("id"), int) or workflow.get("path") != ".github/workflows/traceability-check.yml":
        fail("invalid traceability workflow")
    trace_runs = pages(f"repos/{repo}/actions/workflows/traceability-check.yml/runs?{query}", "workflow_runs")
    candidates = [run for run in trace_runs
                  if run.get("workflow_id") == workflow["id"]
                  and run.get("head_sha") == current_sha
                  and run.get("event") == "pull_request"
                  and timestamp(run.get("created_at")) >= started
                  and any(p.get("number") == int(pr_number) for p in run.get("pull_requests", []))]
    checks = []
    if candidates:
        run = max(candidates, key=lambda item: (timestamp(item["created_at"]), item["id"], item.get("run_attempt", 1)))
        jobs = pages(f"repos/{repo}/actions/runs/{run['id']}/jobs?filter=latest", "jobs")
        linked = [job for job in jobs if job.get("name") == "Linked Issue"]
        if len(linked) != 1:
            fail("missing or duplicated Linked Issue job")
        checks.append({"name": "PR Traceability / Linked Issue", "sha": current_sha,
                       "status": status(linked[0])})

    branch_query = urllib.parse.urlencode({"branch": head_ref})
    render_runs = pages(f"repos/{repo}/actions/workflows/render-plantuml.yml/runs?{branch_query}", "workflow_runs")
    mutating = []
    for run in render_runs:
        if run.get("head_branch") != head_ref or run.get("event") not in ("push", "workflow_dispatch"):
            continue
        state = status(run)
        completed = run.get("updated_at")
        if state == "pending" or (completed and timestamp(completed) >= started):
            mutating.append({"id": run["id"], "sha": run["head_sha"], "status": state})
    developer_runs = pages(f"repos/{repo}/actions/workflows/ai-developer.yml/runs", "workflow_runs")
    for run in developer_runs:
        if run.get("id") == current_run_id or run.get("status") == "completed":
            continue
        if run.get("event") not in ("issue_comment", "pull_request_review"):
            continue
        # A review-event run can report the base branch as head_branch. Without
        # its event payload, no other in-flight developer run is provably safe
        # to exclude by branch name. The current orchestrator is exempt above.
        mutating.append({"id": run["id"], "sha": run["head_sha"], "status": status(run)})
    snapshot = {"automated_followup_count": int(round_number),
                "branch_mutating_runs": mutating,
                "branch_mutating_runs_complete": branch_sha == current_sha,
                "checks": checks, "checks_complete": True,
                "current_head_sha": current_sha, "diff_guard_passed": True,
                "followup_gate_passed": True, "human_pause": paused,
                "now": int(datetime.datetime.now(datetime.timezone.utc).timestamp()),
                "repository_write": write, "requirements_gate_passed": True,
                "validation_sha": sha, "window_started_at": started}
    print(json.dumps(snapshot, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
        print(f"current-head snapshot unavailable: {error}", file=sys.stderr)
        sys.exit(1)
