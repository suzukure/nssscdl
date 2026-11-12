#!/usr/bin/env python3
"""Issue #919: trusted, bounded required-check wait followed by one exact-head merge."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

REQUIRED = {
    "Linked Issue": ".github/workflows/traceability-check.yml",
    "Product CI": ".github/workflows/product-ci.yml",
}
PENDING = {"queued", "in_progress", "waiting", "pending", "requested"}
FAILURES = {"failure", "cancelled", "skipped", "neutral", "timed_out", "stale",
            "action_required", "startup_failure"}


class Stop(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Stop(reason)


def positive(value):
    return type(value) is int and value > 0


def completed(item, name):
    conclusion = item["conclusion"]
    require(conclusion == "success" or conclusion in FAILURES, "invalid_check_conclusion")
    require(conclusion == "success", "required_" + conclusion + "_" + name)


def report(reason):
    message = "自動マージ判定: " + reason
    print(message)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write("\n### 必須チェック待機・マージ\n\n" + message + "\n")


class Merge:
    def __init__(self, repo, number, head, developer, reviewer):
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "invalid_identity")
        require(re.fullmatch(r"[1-9][0-9]*", number), "invalid_identity")
        require(re.fullmatch(r"[0-9a-f]{40}", head), "invalid_identity")
        require(all(re.fullmatch(r"[A-Za-z0-9_-]+", slug) for slug in (developer, reviewer)),
                "invalid_identity")
        self.repo, self.number, self.head = repo, int(number), head
        self.developer, self.reviewer = developer, reviewer
        self.root = f"repos/{repo}"
        self.deadline = time.monotonic() + 600
        self.baseline = None
        self.last_wait = "pending"

    def command(self, args, reason):
        remaining = self.deadline - time.monotonic()
        timeout_reason = "deadline_before_merge" if self.last_wait == "success" else "timeout_" + self.last_wait
        require(remaining > 0, timeout_reason)
        try:
            result = subprocess.run(args, capture_output=True, text=True,
                                    timeout=min(30, remaining), check=False)
        except subprocess.TimeoutExpired:
            if reason == "merge_rejected_or_outcome_unknown":
                raise Stop(reason) from None
            raise Stop("api_timeout" if time.monotonic() < self.deadline
                       else timeout_reason) from None
        except OSError:
            raise Stop(reason) from None
        if result.returncode != 0 and reason == "trusted_gate_rejected":
            for text, code in (("Code Owner", "protected_paths"),
                               ("human-review-required", "human_pause"),
                               ("取得", "gate_api_error"),
                               ("closing Issue", "closing_issue_gate_rejected")):
                if text in result.stderr:
                    raise Stop(code)
        require(result.returncode == 0, reason)
        return result.stdout

    def api(self, path, collection=None):
        args = ["gh", "api"]
        if collection is not None:
            args += ["--paginate", "--slurp"]
        raw = self.command(args + [path], "api_error")
        try:
            data = json.loads(raw)
            if collection is None:
                require(type(data) is dict, "invalid_api_response")
                return data
            require(type(data) is list and len(data) > 0, "invalid_api_response")
            if collection == "reviews":
                require(all(type(page) is list for page in data), "invalid_api_response")
                return [item for page in data for item in page]
            require(all(type(page) is dict and type(page.get(collection)) is list
                        and type(page.get("total_count")) is int for page in data),
                    "invalid_api_response")
            rows = [item for page in data for item in page[collection]]
            require(all(page["total_count"] == len(rows) for page in data),
                    "incomplete_api_response")
            return rows
        except (ValueError, TypeError):
            raise Stop("invalid_api_response") from None

    def gate(self):
        # Resolve siblings from the trusted base checkout, never PR-head code.
        self.command(["bash", str(Path(__file__).with_name("verify-pr-gates.sh")),
                      self.repo, str(self.number), "merge", self.developer],
                     "trusted_gate_rejected")

    def snapshot(self):
        raw = self.command(["gh", "pr", "view", str(self.number), "--repo", self.repo,
                            "--json", "number,state,isDraft,headRefOid,headRefName,baseRefName,"
                            "labels,closingIssuesReferences,reviewDecision"], "api_error")
        try:
            pr = json.loads(raw)
            require(pr["number"] == self.number, "pr_identity_changed")
            require(pr["headRefOid"] == self.head, "head_changed")
            require(pr["state"] == "OPEN", "pr_closed")
            require(pr["isDraft"] is False, "pr_draft")
            require(pr["baseRefName"] == "main", "base_changed")
            require(type(pr["labels"]) is list, "invalid_pr_response")
            require(all(type(label["name"]) is str for label in pr["labels"]),
                    "invalid_pr_response")
            require(not any(label["name"] == "human-review-required" for label in pr["labels"]),
                    "human_pause")
            require(pr["reviewDecision"] == "APPROVED", "review_invalid")
            links = sorted((item["number"], item["url"]) for item in pr["closingIssuesReferences"])
            require(links and all(positive(n) and type(url) is str for n, url in links),
                    "invalid_closing_issues")
            issue_states = []
            for number, url in links:
                if not url.startswith(f"https://github.com/{self.repo}/issues/"):
                    continue
                require(url == f"https://github.com/{self.repo}/issues/{number}",
                        "closing_issues_changed")
                issue = self.api(f"{self.root}/issues/{number}")
                require(issue["number"] == number and issue["state"] in {"open", "closed"}
                        and "pull_request" not in issue, "invalid_issue_response")
                require(type(issue["labels"]) is list
                        and all(type(label["name"]) is str for label in issue["labels"]),
                        "invalid_issue_response")
                require(not any(label["name"] == "human-review-required"
                                for label in issue["labels"]), "issue_human_pause")
                issue_states.append((number, issue["state"]))
            reviews = self.api(f"{self.root}/pulls/{self.number}/reviews?per_page=100", "reviews")
            require(all(type(review) is dict and positive(review["id"])
                        and type(review["user"]["login"]) is str for review in reviews),
                    "invalid_review_response")
            require(len({review["id"] for review in reviews}) == len(reviews),
                    "duplicate_review_identity")
            own = [review for review in reviews
                   if review["user"]["login"] == self.reviewer + "[bot]"]
            require(own, "review_missing")
            latest = max(own, key=lambda review: review["id"])
            require(latest["state"] == "APPROVED" and latest["commit_id"] == self.head,
                    "review_invalid")
            identity = (pr["headRefName"], links, issue_states, latest["id"])
            if self.baseline is None:
                self.baseline = identity
            require(identity == self.baseline, "pr_or_review_changed")
        except (ValueError, KeyError, TypeError):
            raise Stop("invalid_pr_or_review_response") from None

    def checks(self):
        runs = self.api(f"{self.root}/actions/runs?head_sha={self.head}&per_page=100", "workflow_runs")
        checks = self.api(f"{self.root}/commits/{self.head}/check-runs?filter=all&per_page=100", "check_runs")
        waiting = []
        try:
            require(all(type(run) is dict and positive(run["id"]) and type(run["path"]) is str
                        for run in runs), "invalid_run_response")
            require(all(type(check) is dict and positive(check["id"])
                    and type(check["name"]) is str for check in checks), "invalid_check_response")
            require(len({run["id"] for run in runs}) == len(runs), "duplicate_run_identity")
            require(len({check["id"] for check in checks}) == len(checks), "duplicate_check_identity")
            for name, path in REQUIRED.items():
                candidates = [run for run in runs if run["path"] == path]
                if not candidates:
                    waiting.append("missing")
                    continue
                # Newest run and its CURRENT attempt; old same-head success is never fallback.
                run = max(candidates, key=lambda item: item["id"])
                require(run["head_sha"] == self.head and run["event"] == "pull_request"
                        and run["head_repository"]["full_name"] == self.repo
                        and any(pr["number"] == self.number for pr in run["pull_requests"])
                        and positive(run["run_attempt"]), "check_identity_invalid")
                if run["status"] == "completed":
                    completed(run, name)
                else:
                    require(run["status"] in PENDING and run["conclusion"] is None,
                            "invalid_run_status")
                jobs = self.api(f"{self.root}/actions/runs/{run['id']}/attempts/"
                                f"{run['run_attempt']}/jobs?per_page=100", "jobs")
                current = self.api(f"{self.root}/actions/runs/{run['id']}")
                require(current["id"] == run["id"] and current["run_attempt"] == run["run_attempt"],
                        "check_attempt_changed")
                matches = [job for job in jobs if job["name"] == name]
                require(len(matches) <= 1, "duplicate_required_" + name)
                if not matches:
                    waiting.append("missing")
                    continue
                job = matches[0]
                require(job["run_id"] == run["id"] and job["run_attempt"] == run["run_attempt"]
                        and job["head_sha"] == self.head and positive(job["id"]),
                        "check_identity_invalid")
                # The job/check URL joins the Actions attempt to the check GitHub evaluates.
                selected = [check for check in checks if check["name"] == name
                            and check["url"] == job["check_run_url"]]
                require(len(selected) <= 1, "duplicate_required_" + name)
                if not selected:
                    waiting.append("missing")
                    continue
                check = selected[0]
                require(check["head_sha"] == self.head and check["app"]["id"] == 15368
                        and check["check_suite"]["id"] == run["check_suite_id"]
                        and check["url"] == f"https://api.github.com/{self.root}/check-runs/{check['id']}",
                        "check_identity_invalid")
                for item in (job, check):
                    if item["status"] == "completed":
                        completed(item, name)
                    else:
                        require(item["status"] in PENDING and item["conclusion"] is None,
                                "invalid_check_status")
                if any(item["status"] != "completed" for item in (run, job, check)):
                    waiting.append("pending")
            return "missing" if "missing" in waiting else "pending" if waiting else "success"
        except (KeyError, TypeError):
            raise Stop("invalid_check_response") from None

    def execute(self):
        self.gate()
        while True:
            self.snapshot()
            self.gate()
            self.last_wait = self.checks()
            if self.last_wait == "success":
                # Re-read checks to detect a retry/new run during the successful sample.
                self.last_wait = self.checks()
                if self.last_wait == "success":
                    # Re-read identity and trusted policy AFTER waiting, before the only write.
                    self.snapshot()
                    self.gate()
                    self.command(["gh", "pr", "merge", str(self.number), "--repo", self.repo,
                                  "--squash", "--match-head-commit", self.head],
                                 "merge_rejected_or_outcome_unknown")
                    report("merged")
                    return
            remaining = self.deadline - time.monotonic()
            require(remaining > 0, "timeout_" + self.last_wait)
            time.sleep(min(15, remaining))


def main():
    try:
        require(len(sys.argv) == 6, "invalid_arguments")
        Merge(*sys.argv[1:]).execute()
        return 0
    except Stop as error:
        report(str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
