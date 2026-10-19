#!/usr/bin/env python3
"""Human-invoked local Git handoff; not an AI Developer or pause-state substitute."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPO = "suzukure/nssscdl"
BRANCH = re.compile(r"^human/issue-([1-9][0-9]*)-local$")
CLOSING = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9][0-9]*)\b", re.I)
PROTECTED = {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md",
             "CODEOWNERS", ".mcp.json"}


class Stop(Exception):
    pass


def call(*args, timeout=40, env=None):
    try:
        p = subprocess.run(args, text=True, encoding="utf-8", errors="replace",
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, env=env, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Stop(f"実行できません: {args[0]} ({type(exc).__name__})") from exc
    if p.returncode:
        # Do not echo raw stderr: it may include credentials or untrusted Issue content.
        raise Stop(f"コマンド失敗: {args[0]} (exit={p.returncode})。状態を確認してください")
    return p.stdout


def git(*args, **kwargs):
    return call("git", *args, **kwargs).strip()


def gh(*args):
    return call("gh", *args, timeout=60)


def decode_json(raw, what):
    try:
        return json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise Stop(f"{what} のJSONが不正です") from exc


def check_root():
    root = Path(git("rev-parse", "--show-toplevel")).resolve()
    if root != Path.cwd().resolve():
        raise Stop("リポジトリのルートで実行してください")
    remote = git("remote", "get-url", "origin")
    if not re.fullmatch(r"(?:https://github\.com/|git@github\.com:)suzukure/nssscdl(?:\.git)?", remote):
        raise Stop("originが指定リポジトリではありません")
    return root


def clean():
    return not git("status", "--porcelain=v1", "--untracked-files=normal")


def current_branch():
    return git("symbolic-ref", "--short", "HEAD")


def branch_issue():
    match = BRANCH.fullmatch(current_branch())
    if not match:
        raise Stop("人間管理のhuman/issue-N-localブランチではありません")
    return int(match.group(1))


def check_issue(number):
    raw = gh("issue", "view", str(number), "--repo", REPO, "--json",
             "number,title,body,url,labels,comments,state,updatedAt")
    info = decode_json(raw, "Issue")
    if not isinstance(info, dict) or info.get("number") != number or info.get("state") != "OPEN":
        raise Stop("IssueがOpenでないか番号が不一致です")
    labels = info.get("labels")
    if not isinstance(labels, list) or any(not isinstance(l, dict) or not isinstance(l.get("name"), str) for l in labels):
        raise Stop("Issueのlabelsを検証できません")
    if any(l["name"] == "human-review-required" for l in labels):
        raise Stop("Issueがhuman-review-requiredで停止しています")
    if not isinstance(info.get("comments"), list) or not isinstance(info.get("body"), str):
        raise Stop("Issueのbody/commentsが不完全です")
    if not isinstance(info.get("title"), str) or not isinstance(info.get("updatedAt"), str):
        raise Stop("Issueのidentityが不完全です")
    return info, raw


def check_no_pr(number, branch):
    raw = gh("pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
             "--json", "number,headRefName,body")
    prs = decode_json(raw, "Open PR一覧")
    if not isinstance(prs, list) or len(prs) >= 100:
        raise Stop("Open PRを完全に調べられません")
    for pr in prs:
        if not isinstance(pr, dict) or not isinstance(pr.get("headRefName"), str) or not isinstance(pr.get("body"), str):
            raise Stop("Open PRの情報が不完全です")
        if pr["headRefName"] == branch or str(number) in CLOSING.findall(pr["body"]):
            raise Stop("同一IssueまたはbranchのOpen PRがあります")


def remote_branch_exists(branch):
    return bool(git("ls-remote", "--heads", "origin", f"refs/heads/{branch}"))


def fresh_main():
    git("fetch", "origin", "main", timeout=90)
    return git("rev-parse", "refs/remotes/origin/main")


def check_latest(sha):
    # Fetch again to avoid treating a prior fetched HEAD as permanently fresh.
    if fresh_main() != sha:
        raise Stop("main HEADが変化しました。再評価が必要です")


def confirm(message, number):
    answer = input(f"{message} 承認する場合は YES {number} と入力: ")
    if answer != f"YES {number}":
        raise Stop("人間承認が得られませんでした")


def bash_guard(repo_root, contract=False):
    script = repo_root / ".github" / "scripts" / "evaluate-codex-diff-gate.sh"
    if not script.is_file():
        raise Stop("既存diff guardが見つかりません")
    # In Git Bash, python3 may resolve to the unusable WindowsApps alias.
    # Use only this child Bash process, without altering the canonical guard.
    env = os.environ.copy()
    env.pop("BASH_ENV", None)
    call("bash", "-c", "python -c 'import sys; assert sys.version_info.major == 3'", env=env)
    args = ["bash", "-c",
            'python3() { python "$@"; }; export -f python3; '
            'if command -v cygpath >/dev/null 2>&1; then guard=$(cygpath -u "$1") || exit 1; '
            'else guard="$1"; fi; shift; exec bash "$guard" "$@"',
            "local-guard", str(script)]
    if contract:
        args.append("--contract")
    result = decode_json(call(*args, env=env), "diff guard")
    if not isinstance(result, dict):
        raise Stop("diff guardの結果が不正です")
    return result


def forbidden(path):
    parts = Path(path).parts
    lower = [part.casefold() for part in parts]
    if not parts or path.startswith("/") or ".." in parts or "\\" in path:
        return True
    if lower[0] in {".github", ".claude", ".codex", ".ai-context"}:
        return True
    if path.casefold() in {n.casefold() for n in PROTECTED} or any(n.startswith(".env") for n in lower) or lower[-1].endswith((".key", ".pem")):
        return True
    return False


def candidate_paths():
    tracked = call("git", "diff", "--name-only", "-z", "HEAD").split("\x00")
    untracked = call("git", "ls-files", "--others", "--exclude-standard", "-z").split("\x00")
    names = sorted({p for p in tracked + untracked if p})
    if not names:
        raise Stop("提出する差分がありません")
    for p in names:
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in p):
            raise Stop("制御文字を含む変更パスは利用できません")
        if forbidden(p) or Path(p).is_symlink() or (Path(p).exists() and not Path(p).is_file()):
            raise Stop("禁止または検証できない変更パスがあります。停止します")
    return names


def prepare(number):
    root = check_root()
    if current_branch() != "main" or not clean():
        raise Stop("prepareはcleanなmainブランチからのみ起動できます")
    sha = fresh_main()
    info, raw = check_issue(number)
    branch = f"human/issue-{number}-local"
    check_no_pr(number, branch)
    if git("branch", "--list", branch) or remote_branch_exists(branch):
        raise Stop("既存branchがあります。作成を繰り返さず状態を確認してください")
    print(f"Issue #{number} / main {sha[:12]} / branch {branch}")
    print("停止record・依存契約・active writer・scopeの実態は人間がIssueで確認してください。")
    confirm("開始の確認", number)
    if current_branch() != "main" or not clean():
        raise Stop("開始直前のlocal状態が変わりました")
    check_latest(sha)
    check_no_pr(number, branch)
    updated, _ = check_issue(number)
    if updated["updatedAt"] != info["updatedAt"]:
        raise Stop("Issueが更新されました。再評価が必要です")
    git("merge", "--ff-only", "origin/main")
    if git("rev-parse", "HEAD") != sha:
        raise Stop("mainの同期結果が予期したSHAと不一致です")
    git("switch", "-c", branch)
    # Remove stale inputs before building: Codex must not read the old Issue.
    context = root / ".ai-context"
    context.mkdir(exist_ok=True)
    files = ("request.md", "AGENTS.base.md", "diff-guard-contract.json")
    for name in files:
        (context / name).unlink(missing_ok=True)
    if git("check-ignore", ".ai-context/request.md") != ".ai-context/request.md":
        raise Stop(".ai-contextはignoredである必要があります")
    builder = root / ".github" / "scripts" / "build-development-context.py"
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp)
        issue_json, request, summary = path / "issue.json", path / "request.md", path / "summary.txt"
        issue_json.write_text(raw, encoding="utf-8")
        call(sys.executable, str(builder), str(issue_json), str(request), str(summary))
        req = request.read_text(encoding="utf-8")
        if not req.startswith("# Development request\n") or f"Issue #{number}:" not in req:
            raise Stop("生成contextのIssueが一致しません")
        base = git("show", f"{sha}:AGENTS.md") + "\n"
        contract = bash_guard(root, contract=True)
        if not all(isinstance(contract.get(x), int) and contract[x] > 0 for x in
                   ("max_changed_files", "max_changed_lines", "max_new_files")):
            raise Stop("diff guard契約が不完全です")
        (context / "AGENTS.base.md").write_text(base, encoding="utf-8")
        (context / "diff-guard-contract.json").write_text(json.dumps(contract) + "\n", encoding="utf-8")
        (context / "request.md").write_text(req, encoding="utf-8")
    print(f"準備完了: {branch} / Issue #{number}。Codexは編集・有限検証のみ実行してください。")


def submit():
    root = check_root()
    number = branch_issue()
    branch = current_branch()
    if remote_branch_exists(branch):
        raise Stop("remote branchが既にあります。既存PR/途中状態を人間が確認してください")
    sha = fresh_main()
    if git("rev-parse", "HEAD") != sha:
        raise Stop("branch HEADが最新mainと異なります。既存commit/新mainを確認してください")
    if not (root / ".ai-context" / "request.md").is_file():
        raise Stop("必須contextがありません")
    req = (root / ".ai-context" / "request.md").read_text(encoding="utf-8")
    if f"Issue #{number}:" not in req or not req.startswith("# Development request\n"):
        raise Stop("Issue contextが不一致です")
    base = (root / ".ai-context" / "AGENTS.base.md")
    contract = (root / ".ai-context" / "diff-guard-contract.json")
    if not base.is_file() or not contract.is_file():
        raise Stop("必須trusted contextがありません")
    if base.read_text(encoding="utf-8").rstrip("\n") != git("show", f"{sha}:AGENTS.md"):
        raise Stop("trusted AGENTSとbase SHAが一致しません")
    if decode_json(contract.read_text(encoding="utf-8"), "guard契約") != bash_guard(root, contract=True):
        raise Stop("guard契約が一致しません")
    info, raw = check_issue(number)
    # Verify that Codex was given this Issue snapshot, not an older body/comment set.
    builder = root / ".github" / "scripts" / "build-development-context.py"
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        issue_json, built, summary = directory / "issue.json", directory / "request.md", directory / "summary.txt"
        issue_json.write_text(raw, encoding="utf-8")
        call(sys.executable, str(builder), str(issue_json), str(built), str(summary))
        if built.read_text(encoding="utf-8") != req:
            raise Stop("Issue contextがprepare以降に更新されています。人間による再評価が必要です")
    check_no_pr(number, branch)
    paths = candidate_paths()
    print(f"Issue #{number} / 提出予定 {len(paths)} files:")
    for p in paths:
        print("  " + p)
    print("実差分、Issue scope、機密情報、検証結果は人間が確認してください。")
    confirm("この一覧をstageする確認", number)
    if candidate_paths() != paths:
        raise Stop("候補差分が変わりました")
    git("add", "-A", "--", *paths)
    git("diff", "--cached", "--check")
    result = bash_guard(root)
    if result.get("result") != "pass" or not isinstance(result.get("changed_files"), int) or result["changed_files"] < 1:
        raise Stop("既存diff guardがpassではありません")
    staged = [p for p in call("git", "diff", "--cached", "--name-only", "-z").split("\x00") if p]
    if staged != sorted(paths):
        raise Stop("stageされたpathが承認一覧と一致しません")
    if call("git", "diff", "--name-only", "-z"):
        raise Stop("未stageの変更が残っています")
    print(f"guard PASS: {result['changed_files']} files / {result.get('total_changed_lines')} lines")
    confirm("commit・non-force push・Draft PR提出の最終確認", number)
    if candidate_paths() != paths or git("rev-parse", "HEAD") != sha:
        raise Stop("差分またはHEADが変化しました")
    check_latest(sha)
    new_info, _ = check_issue(number)
    if new_info["updatedAt"] != info["updatedAt"]:
        raise Stop("Issueが更新されました。再評価が必要です")
    check_no_pr(number, branch)
    if remote_branch_exists(branch):
        raise Stop("remote branchが新規作成されました")
    # No automated recovery after any irreversible external operation.
    git("commit", "-m", f"chore: address issue #{number} via local development")
    git("push", "--set-upstream", "origin", branch, timeout=90)
    try:
        result = gh("pr", "create", "--repo", REPO, "--head", branch, "--base", "main",
                    "--draft", "--title", f"Issue #{number}: {info['title']}",
                    "--body", f"Closes #{number}\n\n人間管理branchから提出。検証・レビュー準備は別Gateで確認。")
    except Stop as exc:
        raise Stop(f"push後にPR作成未確定。重複作成せず既存PRを確認: {exc}") from exc
    print("Draft PR提出完了: " + result.strip())
    print("Ready、正式CI/Claude、手動squash mergeは別の人間Gateです。")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("prepare", help="Issueのcontextと人間管理branchを準備")
    start.add_argument("issue", type=int)
    sub.add_parser("submit", help="差分を確認後、commit/push/Draft PR")
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            if args.issue < 1:
                raise Stop("Issue番号が不正です")
            prepare(args.issue)
        else:
            submit()
    except (Stop, OSError, ValueError) as exc:
        print("STOP: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
