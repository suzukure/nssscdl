"""Local CLI guard tests; never access real GitHub or push branches."""

from contextlib import contextmanager
from pathlib import Path
import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import local_development as ld


@contextmanager
def repository():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.name", "Fixture"], check=True)
        (root / "docs").mkdir()
        (root / "docs" / "a.md").write_text("old\n")
        subprocess.run(["git", "-C", str(root), "add", "docs/a.md"], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "-qm", "base"], check=True)
        old = Path.cwd()
        os.chdir(root)
        try:
            yield root
        finally:
            os.chdir(old)


class SafetyTests(unittest.TestCase):
    def test_protected_and_secret_paths(self):
        for name in [".github/workflows/ci.yml", "AGENTS.md", "agents.md", "CLAUDE.md", ".codex/config.toml",
                     ".ai-context/request.md", "../outside", ".env", "docs/.ENV.production", "x.key", ".mcp.json"]:
            self.assertTrue(ld.forbidden(name), name)
        self.assertFalse(ld.forbidden("docs/example.md"))
        self.assertFalse(ld.forbidden("scripts/local_development.py"))

    def test_issue_stopped_and_invalid_metadata(self):
        ok = {"number": 123, "state": "OPEN", "title": "valid", "body": "scope",
              "url": "https://github.com/suzukure/nssscdl/issues/123", "updatedAt": "2026-10-19T00:00:00Z",
              "labels": [], "comments": []}
        with patch.object(ld, "gh", return_value=json.dumps(ok)):
            self.assertEqual(ld.check_issue(123)[0]["number"], 123)
        for override in [{"state": "CLOSED"}, {"number": 99}, {"labels": [{"name": "human-review-required"}]},
                         {"comments": None}, {"labels": None}]:
            with patch.object(ld, "gh", return_value=json.dumps({**ok, **override})):
                with self.assertRaises(ld.Stop):
                    ld.check_issue(123)

    def test_duplicate_issue_pr_and_incomplete_list(self):
        with patch.object(ld, "gh", return_value=json.dumps([{"number": 5, "headRefName": "other", "body": "Closes #123"}])):
            with self.assertRaises(ld.Stop):
                ld.check_no_pr(123, "human/issue-123-local")
        with patch.object(ld, "gh", return_value=json.dumps([{"number": 5, "headRefName": "human/issue-123-local", "body": ""}])):
            with self.assertRaises(ld.Stop):
                ld.check_no_pr(123, "human/issue-123-local")
        with patch.object(ld, "gh", return_value=json.dumps([{"number": x, "headRefName": "other", "body": ""} for x in range(100)])):
            with self.assertRaises(ld.Stop):
                ld.check_no_pr(123, "human/issue-123-local")

    def test_candidates_and_symlink_or_secret_stop(self):
        with repository() as root:
            (root / "docs" / "a.md").write_text("changed\n")
            (root / "docs" / "b.md").write_text("new\n")
            self.assertEqual(ld.candidate_paths(), ["docs/a.md", "docs/b.md"])
            (root / "AGENTS.md").write_text("unexpected\n")
            with self.assertRaises(ld.Stop):
                ld.candidate_paths()

    def test_stale_main_stops(self):
        with patch.object(ld, "fresh_main", return_value="different"):
            with self.assertRaises(ld.Stop):
                ld.check_latest("pinned")

    def test_explicit_confirmation_required(self):
        with patch("builtins.input", return_value="y"):
            with self.assertRaises(ld.Stop):
                ld.confirm("submit", 123)
        with patch("builtins.input", return_value="YES 123"):
            ld.confirm("submit", 123)

    def test_guard_python3_alias_compatibility(self):
        # The canonical guard is not edited; the subprocess alone defines python3.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / ".github" / "scripts"
            scripts.mkdir(parents=True)
            (scripts / "evaluate-codex-diff-gate.sh").write_text(
                '#!/usr/bin/env bash\nset -eu\n'
                'python3 -c "import json; print(json.dumps({\'result\': \'pass\', \'changed_files\': 1}))"\n',
                encoding="utf-8")
            self.assertEqual(ld.bash_guard(root)["result"], "pass")

    def test_subprocess_failure_is_not_raw_stderr(self):
        with patch.object(ld.subprocess, "run") as mock:
            mock.return_value.returncode = 13
            mock.return_value.stderr = "SECRET_VALUE"
            with self.assertRaises(ld.Stop) as ctx:
                ld.call("git", "status")
            self.assertNotIn("SECRET_VALUE", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
