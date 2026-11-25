#!/usr/bin/env python3
"""Read-only authorization for the fixed #1180 review profile."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import quote

REPOSITORY = "suzukure/nssscdl"
BRANCH = "submission/issue-1180-retirement"
PROFILE = "retirement-1180"
WORKFLOW = ".github/workflows/claude-review.yml"
HELPER = ".github/scripts/authorize-retirement-review.py"
BUILDER = ".github/scripts/build-review-context.sh"
DEVELOPER = {"id": 323046280, "login": "nssscdl-chatgpt-dev[bot]", "type": "Bot"}
PAUSE_LABELS = {"human-review-required", "ai-followup-in-progress"}

QUERY = """
query($owner:String!, $repo:String!, $pr:Int!) {
  repository(owner:$owner, name:$repo) {
    nameWithOwner
    owner { __typename login ... on User { id } }
    pullRequest(number:$pr) {
      number state isDraft headRefOid baseRefOid
      closingIssuesReferences(first:2) {
        pageInfo { hasNextPage }
        nodes { number repository { nameWithOwner } }
      }
      comments(first:100) {
        pageInfo { hasNextPage }
        nodes {
          id body createdAt updatedAt lastEditedAt isMinimized authorAssociation
          author { __typename login ... on User { id } }
        }
      }
    }
  }
}
"""


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def integer(value):
    return type(value) is int and value > 0


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value)


def node_id(value):
    # GraphQL node identities are opaque. Int databaseId can overflow for comments.
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_+/=-]{1,256}", value)


def instant(value):
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def gh(deadline, *args, body=None):
    wait = deadline - time.monotonic()
    require(wait > 0, "deadline")
    result = subprocess.run(
        ["gh", "api", *args], input=body, text=True, capture_output=True,
        check=True, timeout=min(wait, 20),
    )
    return json.loads(result.stdout)


def identity(user, expected):
    return all(user[key] == value for key, value in expected.items())


def active(item):
    labels = item["labels"]
    return (item["state"] == "open" and isinstance(labels, list)
            and all(isinstance(label["name"], str) and label["name"] not in PAUSE_LABELS
                    for label in labels))


def facts(repo, number, head, base, run, deadline):
    root = f"repos/{repo}"
    pr = gh(deadline, f"{root}/pulls/{number}")
    owner = pr["base"]["repo"]["owner"]
    require(owner["type"] == "User" and owner["login"] == repo.split("/")[0]
            and integer(owner["id"]), "owner identity")
    repo_id = pr["base"]["repo"]["id"]
    require(pr["number"] == number and active(pr) and pr["draft"] is False
            and integer(repo_id) and pr["head"]["repo"]["id"] == repo_id
            and pr["base"]["repo"]["full_name"] == pr["head"]["repo"]["full_name"] == repo
            and pr["base"]["ref"] == "main" and pr["base"]["sha"] == base
            and pr["head"]["ref"] == BRANCH and pr["head"]["sha"] == head
            and identity(pr["user"], DEVELOPER), "current PR")
    issue = gh(deadline, f"{root}/issues/1180")
    require(issue["number"] == 1180 and "pull_request" not in issue and active(issue)
            and issue["repository_url"] == f"https://api.github.com/repos/{repo}", "current Issue")
    current = gh(deadline, f"{root}/git/ref/heads/main")
    require(current["ref"] == "refs/heads/main" and current["object"]["sha"] == base,
            "current main")
    execution = gh(deadline, f"{root}/actions/runs/{run}")
    require(execution["id"] == run and execution["run_attempt"] == 1
            and execution["event"] == "pull_request" and execution["name"] == "Claude Review"
            and execution["path"].split("@", 1)[0] == WORKFLOW
            and execution["status"] == "in_progress" and execution["head_sha"] == head
            and execution["head_branch"] == BRANCH
            and execution["head_repository"]["id"] == repo_id
            and integer(execution["workflow_id"]), "current run")
    associations = execution["pull_requests"]
    require(isinstance(associations, list) and (not associations or (
        len(associations) == 1 and associations[0]["number"] == number
        and associations[0]["head"]["sha"] == head)), "run PR association")
    workflow = execution["workflow_id"]
    runs = gh(deadline, f"{root}/actions/workflows/{workflow}/runs"
              f"?event=pull_request&branch={quote(BRANCH, safe='')}&per_page=100")
    recent = runs["workflow_runs"]
    require(isinstance(recent, list) and runs["total_count"] == len(recent) <= 100
            and sum(item["id"] == run for item in recent) == 1
            and all(integer(item["id"]) and item["id"] <= run for item in recent),
            "superseded or incomplete run history")
    return owner, instant(execution["run_started_at"])


def inspect_changes(repo, base, head, workflow_sha, deadline):
    # Compare fixed blobs. The preflight runner only checks out trusted main.
    for ref, paths in ((head, (WORKFLOW, HELPER, BUILDER)), (workflow_sha, (WORKFLOW,))):
        commit = gh(deadline, f"repos/{repo}/git/commits/{ref}")
        tree_sha = commit["tree"]["sha"]
        require(commit["sha"] == ref and sha(tree_sha), "Git commit unavailable")
        tree = gh(deadline, f"repos/{repo}/git/trees/{tree_sha}?recursive=1")
        require(tree["sha"] == tree_sha and tree["truncated"] is False
                and isinstance(tree["tree"], list), "Git tree unavailable")
        for path in paths:
            entry = subprocess.check_output(
                ["git", "--no-replace-objects", "ls-tree", base, "--", path],
                text=True, timeout=min(5, max(.01, deadline - time.monotonic())),
            ).rstrip("\n")
            fields, actual_path = entry.split("\t")
            mode, kind, blob = fields.split()
            require(actual_path == path and mode in ("100644", "100755")
                    and kind == "blob" and sha(blob), "trusted blob")
            matches = [item for item in tree["tree"] if item["path"] == path]
            require(len(matches) == 1 and matches[0]["type"] == kind
                    and matches[0]["mode"] == mode and matches[0]["sha"] == blob,
                    "review dependency changed")


def snapshot(repo, number, head, base, deadline):
    owner, name = repo.split("/")
    payload = json.dumps({"query": QUERY, "variables": {"owner": owner, "repo": name, "pr": number}})
    # gh's GraphQL query uses HTTP POST with a query document and no mutation.
    response = gh(deadline, "graphql", "--input", "-", body=payload)
    require("errors" not in response, "PR conversation unavailable")
    repository = response["data"]["repository"]
    graph_owner = repository["owner"]
    require(repository["nameWithOwner"] == repo and graph_owner["__typename"] == "User"
            and graph_owner["login"] == owner and node_id(graph_owner["id"]), "comment owner")
    pr = repository["pullRequest"]
    require(pr["number"] == number and pr["state"] == "OPEN" and pr["isDraft"] is False
            and pr["headRefOid"] == head and pr["baseRefOid"] == base, "PR snapshot")
    closing = pr["closingIssuesReferences"]
    require(closing["pageInfo"]["hasNextPage"] is False
            and closing["nodes"] == [{"number": 1180, "repository": {"nameWithOwner": repo}}],
            "unique closing Issue")
    comments = pr["comments"]
    nodes = comments["nodes"]
    require(comments["pageInfo"]["hasNextPage"] is False and isinstance(nodes, list)
            and len(nodes) <= 100 and all(node_id(node["id"])
                                          and isinstance(node["body"], str) for node in nodes)
            and len({node["id"] for node in nodes}) == len(nodes), "comment inventory")
    return nodes, graph_owner


def approval(comments, command, owner, started, now):
    matches = [comment for comment in comments if comment["body"] == command]
    if not matches:
        return None
    require(len(matches) == 1, "duplicate approval")
    comment = matches[0]
    created = instant(comment["createdAt"])
    require(comment["authorAssociation"] == "OWNER" and comment["isMinimized"] is False
            and identity(comment["author"], owner) and comment["lastEditedAt"] is None
            and comment["updatedAt"] == comment["createdAt"]
            and started <= created <= now, "approval identity, edit or freshness")
    return comment["id"]


def output(name, value):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        print(f"{name}={value}", file=stream)


def main(mode, base):
    repo = os.environ["GITHUB_REPOSITORY"]
    run_text = os.environ["GITHUB_RUN_ID"]
    workflow_sha = os.environ["GITHUB_WORKFLOW_SHA"]
    require(repo == REPOSITORY
            and re.fullmatch(r"[1-9][0-9]*", run_text)
            and os.environ["GITHUB_RUN_ATTEMPT"] == "1"
            and os.environ["GITHUB_EVENT_NAME"] == "pull_request"
            and sha(base) and sha(workflow_sha), "run identity")
    run = int(run_text)
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes())
    pr = event["pull_request"]
    number = pr["number"]
    head = pr["head"]["sha"]
    require(event["action"] == "ready_for_review" and integer(number) and sha(head)
            and active(pr) and pr["draft"] is False
            and pr["head"]["ref"] == BRANCH and pr["base"]["ref"] == "main"
            and pr["head"]["repo"]["full_name"] == pr["base"]["repo"]["full_name"] == repo
            and identity(pr["user"], DEVELOPER), "Ready event")
    deadline = time.monotonic() + (300 if mode == "wait" else 90)
    owner, started = facts(repo, number, head, base, run, deadline)
    require(identity(event["sender"], {key: owner[key] for key in ("id", "login", "type")}),
            "Ready actor")
    inspect_changes(repo, base, head, workflow_sha, deadline)
    command = f"/ai review approve {PROFILE} pr:{number} run:{run} attempt:1 base:{base} head:{head}"
    earliest = started
    if mode == "wait":
        earliest = max(started, datetime.now(timezone.utc).replace(microsecond=0))
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            print(f"### #1180 レビュー承認待ち（有料呼び出し前）\n\n`{command}`", file=stream)
        print(command, flush=True)
    else:
        require(mode == "check" and os.environ["EXPECTED_PROFILE"] == PROFILE
                and os.environ["EXPECTED_BASE"] == base
                and os.environ["EXPECTED_RUN"] == run_text
                and os.environ["EXPECTED_PR"] == str(number)
                and os.environ["EXPECTED_HEAD"] == head, "preflight handoff")

    if mode == "check":
        fresh_owner, fresh_start = facts(repo, number, head, base, run, deadline)
        require(fresh_owner == owner and fresh_start == started, "authority changed")
    next_poll = time.monotonic()
    for attempt in range(20 if mode == "wait" else 1):
        if attempt:
            time.sleep(max(0, min(next_poll, deadline) - time.monotonic()))
        next_poll = time.monotonic() + 15
        comments, graph_owner = snapshot(repo, number, head, base, deadline)
        comment = approval(comments, command, graph_owner, earliest, datetime.now(timezone.utc))
        if comment is None and mode == "wait":
            continue
        require(comment is not None, "approval missing or withdrawn")
        if mode == "check":
            require(os.environ["EXPECTED_COMMENT"] == str(comment), "approval replaced")
        else:
            fresh_owner, fresh_start = facts(repo, number, head, base, run, deadline)
            require(fresh_owner == owner and fresh_start == started, "authority changed")
            for key, value in (("profile", PROFILE), ("base", base), ("head", head),
                               ("pr", number), ("run", run), ("comment", comment)):
                output(key, value)
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            print(f"{PROFILE} PR #{number} run {run} attempt 1 base {base} head {head} "
                  f"comment {comment} / 600000 B / USD 4.20 (high risk) / 30 min", file=stream)
        return
    raise ValueError("approval wait exhausted")


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError) as exc:
        # Subprocess diagnostics and response bodies can include private data.
        reason = exc.args[0] if type(exc) is ValueError and len(exc.args) == 1 else ""
        if not isinstance(reason, str) or not re.fullmatch(r"[A-Za-z ,]+", reason):
            reason = "invalid or unavailable evidence"
        sys.exit(f"retirement-1180 authorization denied: {reason}")
