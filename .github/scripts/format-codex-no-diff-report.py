#!/usr/bin/env python3
"""Presentation only: closed vocabulary, never a machine decision or raw excerpt."""

import os
import re
import stat
import sys


RAW_LIMIT = 16 * 1024
RENDERED_LIMIT = 8 * 1024
# Exact complete values, not a regex-based claim to detect unknown secrets.
FIELDS = (
    ("作業状況", ("変更なし", "変更を試みた", "状況不明")),
    ("差分0件の理由", ("変更不要と判断", "既存実装で対応済みと判断", "編集を取り消した", "編集できなかった", "理由不明")),
    ("観測事実", ("関連箇所を確認した", "変更を試みた", "確認できなかった")),
    ("未実施", ("実装と検証", "実装", "検証", "確認できなかった")),
    ("次の人間判断", ("Issueと既存実装を確認", "実行状況を確認", "対応方針を確認")),
)
FALLBACK = "最終説明は安全に公開不可/欠損。人間確認が必要です。\n"


def explanation(path):
    """Bounded read of a regular non-symlink file; every reject is identical."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= RAW_LIMIT:
                return FALLBACK
            raw = source.read(RAW_LIMIT + 1)
        if not 0 < len(raw) <= RAW_LIMIT:
            return FALLBACK
        content = raw.decode("utf-8", "strict")
        # Only LF separators, exactly five lines, optional final LF. CR, BOM,
        # controls, invisibles, Markdown, URL, paths, tokens and extra text all
        # fail exact membership. Even plausible free-form Japanese is rejected.
        lines = content.removesuffix("\n").split("\n")
        if len(lines) != len(FIELDS):
            return FALLBACK
        rendered = []
        for line, (label, allowed) in zip(lines, FIELDS):
            prefix = label + ": "
            if not line.startswith(prefix) or line[len(prefix):] not in allowed:
                return FALLBACK
            # Reconstruct exclusively from trusted constants.
            rendered.append(prefix + allowed[allowed.index(line[len(prefix):])])
        return "Codexの構造化説明（自己申告）\n" + "\n".join(rendered) + "\n"
    except (OSError, UnicodeError, ValueError):
        return FALLBACK


def main():
    # No argparse error/exception may reflect untrusted arguments or contents.
    if len(sys.argv) != 5:
        return 1
    path, repository, run_id, attempt = sys.argv[1:]
    if (not re.fullmatch(r"[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_.-]{1,100}", repository)
            or not re.fullmatch(r"[1-9][0-9]{0,19}", run_id)
            or not re.fullmatch(r"[1-9][0-9]{0,5}", attempt)):
        return 1
    body = (
        "このAI Developer実行ではリポジトリの変更はありませんでした。commit・pushは行っていません。\n"
        f"実行run ID: {run_id} / attempt: {attempt}\n"
        f"実行run URL: https://github.com/{repository}/actions/runs/{run_id}/attempts/{attempt}\n"
        "diff=0、commit/push/PRなし。未実装/要人間確認。人間確認が必要です。\n"
        "最終報告は自己申告であり正式CIやIssue Doneを証明しません。\n"
        "差分0件の根本原因はhost事実として確定していません。\n\n"
        + explanation(path)
    )
    if len(body.encode("utf-8")) > RENDERED_LIMIT:
        return 1
    sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
