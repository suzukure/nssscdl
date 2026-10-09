"""Secretless #919 regressions using real gate/classifier and deterministic gh responses."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("merge_approved", ROOT / ".github/scripts/merge-approved-pr.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
HEAD = "a" * 40
OLD = "b" * 40
# Source: #640 required-check identities and #919's explicitly confirmed scope.
WORKFLOWS = {"Linked Issue": ".github/workflows/traceability-check.yml",
             "Product CI": ".github/workflows/product-ci.yml"}
assert module.REQUIRED == WORKFLOWS


class GitHub:
    def __init__(self, case):
        self.case, self.tick, self.now = case, 0, 0
        self.calls, self.merges, self.gates = [], 0, 0
        self.snapshots = 0
        self.samples = 0

    def sleep(self, seconds):
        self.tick += 1
        self.now += seconds

    def gh(self, args):
        self.calls.append(args)
        later = self.tick > 0
        if args[:2] == ["pr", "view"] and "reviewDecision" in args[-1]:
            self.snapshots += 1
        if self.case.startswith("final-"):
            later = self.snapshots > 1
        scenario = self.case.removeprefix("final-")
        if self.case == "api-error" and later:
            raise module.Stop("api_error")
        pr = dict(number=37, state="OPEN", isDraft=False, headRefOid=HEAD,
                  headRefName="ai/issue-36", baseRefName="main", labels=[],
                  author={"login": "dev[bot]"}, reviewDecision="APPROVED",
                  closingIssuesReferences=[dict(number=36, url="https://github.com/owner/repo/issues/36")])
        if self.case == "closed-extra":
            pr["closingIssuesReferences"].append(dict(number=38, url="https://github.com/owner/repo/issues/38"))
        if later:
            if scenario == "head":
                pr["headRefOid"] = OLD
            if scenario == "closed":
                pr["state"] = "CLOSED"
            if scenario == "draft":
                pr["isDraft"] = True
            if scenario == "pause":
                pr["labels"] = [{"name": "human-review-required"}]
            if self.case == "review":
                pr["reviewDecision"] = "REVIEW_REQUIRED"
            if self.case == "links":
                pr["closingIssuesReferences"].append(dict(number=38, url="https://github.com/owner/repo/issues/38"))
        if args[:2] == ["pr", "view"]:
            return pr
        if args[:2] == ["pr", "diff"]:
            return ".github/workflows/example.yml\n" if scenario == "protected" and (later or not self.case.startswith("final-")) else "src/worker.ts\n"
        if args[:2] == ["pr", "merge"]:
            self.merges += 1
            assert args == ["pr", "merge", "37", "--repo", "owner/repo", "--squash", "--match-head-commit", HEAD]
            assert self.gates >= 3
            if self.case in {"policy", "merge-unknown"}:
                raise module.Stop("merge_rejected_or_outcome_unknown")
            return ""
        assert args[0] == "api", args
        path = args[-1]
        if "/actions/runs?" in path:
            self.samples += 1
        if "/issues/" in path:
            issue_number = int(path.rsplit("/", 1)[1])
            return dict(number=issue_number, state="closed" if self.case == "closed-extra" and issue_number == 38 else "open",
                        labels=[{"name": "human-review-required"}]
                        if later and self.case == "issue-pause" else [])
        if "/reviews?" in path:
            review = dict(id=9, user={"login": "reviewer[bot]"}, state="APPROVED", commit_id=HEAD)
            if self.case == "stale-review":
                review["commit_id"] = OLD
            if self.case == "dismissed" and later:
                review["state"] = "DISMISSED"
            if self.case == "new-review" and later:
                review["id"] = 10
            return [[review]]
        pending = (self.case not in {"success", "policy", "merge-unknown", "stale-review", "duplicate",
                                    "wrong-app", "wrong-check-head", "wrong-pr", "bad-response", "race-pending"}
                   and not later and not self.case.startswith("final-")) or self.case == "timeout"
        status, conclusion = ("in_progress", None) if pending else ("completed", "success")
        if self.case == "race-pending" and self.samples >= 2 and not later:
            status, conclusion = "in_progress", None
        if self.case in {"failure", "cancelled", "skipped", "neutral", "timed_out"}:
            status, conclusion = "completed", self.case
        runs, checks, jobs = [], [], {}
        for i, (name, workflow) in enumerate(WORKFLOWS.items(), start=1):
            run = dict(id=i, path=workflow, head_sha=HEAD, event="pull_request", run_attempt=2,
                       head_repository={"full_name": "owner/repo"}, pull_requests=[{"number": 37}],
                       check_suite_id=100 + i, status=status, conclusion=conclusion)
            if self.case == "product-failure" and name == "Product CI":
                run.update(status="completed", conclusion="failure")
            if self.case == "wrong-pr":
                run["pull_requests"] = [{"number": 39}]
            runs.append(run)
            url = f"https://api.github.com/repos/owner/repo/check-runs/{200+i}"
            job = dict(id=300+i, name=name, run_id=i, run_attempt=2, head_sha=HEAD,
                       check_run_url=url, status=status, conclusion=conclusion)
            check = dict(id=200+i, name=name, head_sha=HEAD, url=url, app={"id": 15368},
                         check_suite={"id": 100+i}, status=status, conclusion=conclusion)
            if self.case == "wrong-app":
                check["app"]["id"] = 1
            if self.case == "wrong-check-head":
                check["head_sha"] = OLD
            # Old attempt success must not hide the CURRENT pending job/check.
            stale = copy.deepcopy(check)
            stale.update(id=400+i, url=url + "-old", status="completed", conclusion="success")
            checks += [stale, check]
            jobs[i] = [job, copy.deepcopy(job)] if self.case == "duplicate" else [job]
        if "/check-runs?" in path:
            if self.case == "bad-response":
                return [{"check_runs": "invalid", "total_count": 2}]
            if self.case == "missing" or (self.case == "missing-success" and not later):
                checks = []
            if self.case == "old-only":
                checks = [check for check in checks if check["id"] > 400]
            if self.case == "duplicate-check":
                checks.append(copy.deepcopy(checks[-1]))
            return [dict(total_count=len(checks), check_runs=checks)]
        if "/actions/runs?" in path:
            # Older same-head run success must not hide a newer pending run.
            stale_run = copy.deepcopy(runs[0])
            stale_run.update(id=0, status="completed", conclusion="success")
            # A positive ID below current IDs, without depending on production output.
            if self.case == "old-run":
                runs = [dict(run, id=run["id"]+10) for run in runs]
                runs.append(dict(stale_run, id=1))
            if self.case == "missing-run":
                runs = []
            if self.case == "duplicate-run":
                runs.append(copy.deepcopy(runs[-1]))
            return [dict(total_count=len(runs), workflow_runs=runs)]
        if "/jobs?" in path:
            ident = int(path.split("/actions/runs/")[1].split("/")[0])
            ident = ident - 10 if self.case == "old-run" else ident
            selected = jobs[ident]
            if self.case == "missing-job":
                selected = []
            if self.case == "old-run":
                selected = [dict(job, run_id=job["run_id"]+10) for job in selected]
            return [dict(total_count=len(selected), jobs=selected)]
        if "/actions/runs/" in path:
            ident = int(path.rsplit("/", 1)[1])
            return dict(id=ident, run_attempt=3 if self.case == "attempt" else 2)
        raise AssertionError(args)

    def run(self, args, **kwargs):
        if args[0] == "gh":
            result = self.gh(args[1:])
            return subprocess.CompletedProcess(args, 0, result if isinstance(result, str) else json.dumps(result), "")
        assert args[0] == "bash"
        self.gates += 1
        # Exercise actual trusted gate and its classifier with fixture-only gh exported to Bash.
        # Real Bash subprocess, receiving a finite executable gh adapter via temp directory.
        with tempfile.TemporaryDirectory() as directory:
            adapter = Path(directory) / "gh"
            view = self.gh(["pr", "view"])
            issues = {item["number"]: self.gh(["api", f"repos/owner/repo/issues/{item['number']}"])
                      for item in view["closingIssuesReferences"]}
            diff = self.gh(["pr", "diff"])
            adapter.write_text("#!/usr/bin/env python3\nimport sys\n"
                               f"pr={view!r}\nissues={issues!r}\ndiff={diff!r}\n"
                               "import json\n"
                               "if sys.argv[1:3]==['pr','view']: print(json.dumps(pr))\n"
                               "elif sys.argv[1:3]==['pr','diff']: print(diff)\n"
                               "elif sys.argv[1]=='api': print(json.dumps(issues[int(sys.argv[2].rsplit('/',1)[1])]))\n"
                               "else: sys.exit(2)\n")
            adapter.chmod(0o755)
            env = {key: value for key, value in os.environ.items() if not key.startswith("BASH_FUNC_gh")}
            env["PATH"] = directory + os.pathsep + os.environ["PATH"]
            return REAL_RUN(args, env=env, **kwargs)


REAL_RUN = subprocess.run
cases = {
    "success": "merged", "pending-success": "merged", "missing-success": "merged",
    "failure": "required_failure_Linked Issue", "cancelled": "required_cancelled_Linked Issue",
    "skipped": "required_skipped_Linked Issue", "neutral": "required_neutral_Linked Issue",
    "timed_out": "required_timed_out_Linked Issue", "missing": "timeout_missing",
    "old-only": "timeout_missing", "timeout": "timeout_pending", "head": "head_changed",
    "closed": "pr_closed", "draft": "pr_draft", "pause": "human_pause",
    "issue-pause": "issue_human_pause", "protected": "protected_paths",
    "api-error": "api_error", "review": "review_invalid", "dismissed": "review_invalid",
    "stale-review": "review_invalid", "new-review": "pr_or_review_changed",
    "links": "pr_or_review_changed", "duplicate": "duplicate_required_Linked Issue",
    "wrong-app": "check_identity_invalid", "wrong-check-head": "check_identity_invalid",
    "wrong-pr": "check_identity_invalid", "attempt": "check_attempt_changed",
    "bad-response": "invalid_api_response", "policy": "merge_rejected_or_outcome_unknown",
    "merge-unknown": "merge_rejected_or_outcome_unknown", "old-run": "merged",
    "final-head": "head_changed", "final-closed": "pr_closed", "final-draft": "pr_draft",
    "final-pause": "human_pause", "final-protected": "protected_paths",
    "product-failure": "required_failure_Product CI",
    "duplicate-check": "duplicate_check_identity", "duplicate-run": "duplicate_run_identity",
    "missing-run": "timeout_missing", "missing-job": "timeout_missing", "race-pending": "merged",
    "closed-extra": "merged",
}
for case, expected in cases.items():
    github = GitHub(case)
    with tempfile.TemporaryDirectory() as directory, \
            patch.object(module.time, "monotonic", lambda: github.now), \
            patch.object(module.time, "sleep", github.sleep), \
            patch.object(module.subprocess, "run", github.run), \
            patch.dict(os.environ, GITHUB_STEP_SUMMARY=str(Path(directory) / "summary")):
        with patch.object(module.sys, "argv", ["merge-approved-pr.py", "owner/repo", "37", HEAD, "dev", "reviewer"]):
            result = module.main()
        summary = (Path(directory) / "summary").read_text()
        assert "自動マージ判定: " + expected in summary, (case, summary)
        assert result == (0 if expected == "merged" else 1), case
        assert github.merges == (1 if expected == "merged" or case in {"policy", "merge-unknown"} else 0), case
        assert github.now <= 600, case
        if expected.startswith("timeout_"):
            assert github.now == 600, case
        if case in {"pending-success", "missing-success", "old-run", "race-pending"}:
            assert github.tick == 1, case
print(f"#919: {len(cases)} bounded wait / exact-head / fail-closed fixtures passed")

# Actual CLI exit/timeout handling: API errors and an uncertain merge are never retried.
for merging in (False, True):
    reason = "merge_rejected_or_outcome_unknown" if merging else "api_error"
    for timeout in (False, True):
        completed = subprocess.CompletedProcess(["gh"], 1, "", "sensitive-error-not-for-summary")
        with patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired(["gh"], 1)
                          if timeout else None, return_value=completed) as run:
            try:
                module.Merge("owner/repo", "37", HEAD, "dev", "reviewer").command(["gh"], reason)
                raise AssertionError("must stop")
            except module.Stop as error:
                assert str(error) == ("api_timeout" if timeout and not merging else reason)
            assert run.call_count == 1
