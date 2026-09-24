#!/usr/bin/env python3
"""Local fixtures for the Issue-entry conversation selector."""

import importlib.util
import json
import tempfile
from pathlib import Path
from unittest import mock

source = Path(__file__).with_name("build-development-context.py")
spec = importlib.util.spec_from_file_location("development_context", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def comment(body, time, association="MEMBER", login="human"):
    return {"body": body, "createdAt": time, "authorAssociation": association,
            "author": {"login": login}}


def check(metadata, mode, present=(), absent=(), reason=None):
    rendered, telemetry = module.build(metadata)
    assert telemetry["mode"] == mode, telemetry
    assert telemetry["fallback_reason"] == reason, telemetry
    for value in present:
        assert "DATA| " + value in rendered, (value, rendered)
    for value in absent:
        assert "DATA| " + value not in rendered, (value, rendered)
    return rendered, telemetry


base = {"number": 418, "title": "fixture", "url": "https://example.test/418",
        "body": "current decision", "comments": [
            comment("old decision", "2026-01-01T00:00:00Z"),
            comment("/codex context-checkpoint", "2026-01-02T00:00:00Z"),
            comment("new decision", "2026-01-03T00:00:00Z"),
            comment("untrusted secret", "2026-01-04T00:00:00Z", "NONE", "outsider"),
        ]}
check({**base, "comments": base["comments"][:1]}, "full", ("old decision",))
full_reversed = {**base, "comments": [
    comment("later full decision", "2026-01-02T00:00:00Z"),
    comment("earlier full decision", "2026-01-01T00:00:00Z"),
]}
rendered, _ = check(full_reversed, "full", ("earlier full decision", "later full decision"))
assert rendered.index("earlier full decision") < rendered.index("later full decision")
rendered, telemetry = check(base, "checkpoint", ("current decision", "new decision"),
                            ("old decision", "/codex context-checkpoint", "untrusted secret"))
assert telemetry["excluded_historical"]["chars"] > 0
assert "untrusted secret" not in rendered
later = comment("/codex context-checkpoint", "2026-01-04T00:00:00Z")
check({**base, "comments": base["comments"] + [later]}, "checkpoint",
      ("current decision",), ("new decision", "old decision"))
check({**base, "comments": base["comments"] + [comment("/codex context-checkpoint", "2026-01-05T00:00:00Z", "NONE")]},
      "checkpoint", ("new decision",))
check({**base, "comments": [comment("/codex context-checkpoint", "2026-01-01T00:00:00Z", "NONE"),
                               comment("old decision", "2026-01-02T00:00:00Z")]},
      "full", ("old decision",), ("/codex context-checkpoint",))
check({**base, "comments": [comment("prefix /codex context-checkpoint", "2026-01-01T00:00:00Z")]},
      "full", ("prefix /codex context-checkpoint",))
reversed_text, _ = check({**base, "comments": list(reversed(base["comments"]))}, "checkpoint",
                         ("new decision",))
assert reversed_text.index("current decision") < reversed_text.index("new decision")
ordered = {**base, "comments": [comment("second", "2026-01-04T00:00:00Z"),
                                comment("first", "2026-01-03T00:00:00Z"), base["comments"][1]]}
rendered, _ = check(ordered, "checkpoint", ("first", "second"))
assert rendered.index("first") < rendered.index("second")
for bad in [
        {**base, "comments": [{**base["comments"][0], "createdAt": "bad"}, *base["comments"][1:]]},
        {**base, "comments": [
            {key: value for key, value in base["comments"][0].items() if key != "createdAt"},
            *base["comments"][1:],
        ]},
]:
    check(bad, "fallback", ("old decision", "new decision"), ("untrusted secret",),
          "invalid_timestamp")

unsafe_identity = {
    **base,
    "comments": [{**base["comments"][0], "authorAssociation": []}, *base["comments"][1:]],
}
try:
    module.build(unsafe_identity)
    raise AssertionError("Unsafe identity metadata must stop before model context construction.")
except module.SelectionError as exc:
    assert exc.code == "unsafe_full_fallback"
tied = {**base, "comments": base["comments"] + [comment("/codex context-checkpoint", "2026-01-02T00:00:00Z")]}
check(tied, "fallback", ("old decision", "new decision"), ("untrusted secret",), "ambiguous_checkpoint")
try:
    module.build({**base, "comments": {}})
    raise AssertionError("Invalid comments metadata must stop before a partial fallback.")
except module.SelectionError as exc:
    assert exc.code == "unsafe_full_fallback"
same_time = {**base, "comments": base["comments"] + [comment("simultaneous", "2026-01-03T00:00:00Z")]}
check(same_time, "fallback", ("old decision", "new decision", "simultaneous"),
      ("untrusted secret",), "ambiguous_order")
with mock.patch.object(module, "select", side_effect=RuntimeError("internal failure")):
    check(base, "fallback", ("old decision", "new decision"), ("untrusted secret",), "selector_failure")
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / "issue.json").write_text(json.dumps(base), encoding="utf-8")
    module.main.__globals__["sys"].argv = [str(source), str(root / "issue.json"), str(root / "request.md"), str(root / "summary.md")]
    module.main()
    assert "Issue context selection" in (root / "summary.md").read_text()
    assert "untrusted secret" not in (root / "request.md").read_text()
print("Issue development context fixture tests passed.")
