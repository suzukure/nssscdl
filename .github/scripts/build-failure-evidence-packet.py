#!/usr/bin/env python3
"""#686 pure builder. No collector, CLI, model, or filesystem access."""

import copy
import datetime as dt
import json
import re

SCHEMA = "failure-evidence-packet:v1"
CAP = 32768
IDENTITY = {"repository", "issue_number", "pr_number", "current_main_sha",
            "run_head_sha", "current_pr_head", "run_id", "run_attempt",
            "job_id", "failing_step"}
LOCATOR = {"repository", "ref", "sha", "path", "line_start", "line_end",
           "issue_number", "pr_number", "run_id", "run_attempt", "job_id", "step"}
SECTIONS = {"goal", "scope", "security", "non_goals", "done", "product_impact"}
SHA = re.compile(r"[0-9a-f]{40}\Z")
# Reject recognizable credential material before selecting excerpts. This is
# deliberately not a promise to discover every secret; collectors must supply
# credential-free evidence. Rejection diagnostics never echo input values.
# Only an entire literal *** value is a mask display, never credential material.
# Keep the existing value delimiters; partial masks and quoted masks still fail.
# Collectors reuse this expression for full-source scans before bounding text.
SECRET = re.compile(
    r"gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}"
    r"|sk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
    r"|\bBearer\s+(?!\*\*\*(?=\s|$))\S+"
    r"|\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*"
    r"(?!\*\*\*(?=[\s,}]|$))[^\s,}]+",
    re.IGNORECASE)


class Invalid(Exception):
    def __init__(self, reason, field):
        self.reason, self.field = reason, field


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def obj(value, keys, field):
    if type(value) is not dict or any(type(k) is not str for k in value):
        raise Invalid("malformed_schema", field)
    if set(value) - keys:
        raise Invalid("unknown_field", field)
    if keys - set(value):
        raise Invalid("missing_mandatory", [field + "." + key for key in sorted(keys - set(value))])


def string(value, field, nullable=False):
    if nullable and value is None:
        return
    if type(value) is not str or not value.strip():
        raise Invalid("missing_mandatory" if value is None else "malformed_schema", field)
    # Also reject lone surrogates rather than fail during final UTF-8 encoding.
    try:
        value.encode("utf-8")
    except UnicodeError as exc:
        raise Invalid("malformed_schema", field) from exc
    if SECRET.search(value):
        raise Invalid("secret_like_evidence", "input")


def number(value, field, nullable=False, minimum=1):
    if nullable and value is None:
        return
    if type(value) is not int or value < minimum:
        raise Invalid("missing_mandatory" if value is None else "malformed_schema", field)


def digest(value, field, nullable=False):
    if nullable and value is None:
        return
    string(value, field)
    if not SHA.fullmatch(value):
        raise Invalid("malformed_schema", field)


def identity(value):
    obj(value, IDENTITY, "identity")
    missing = sorted("identity." + key for key in IDENTITY - {"pr_number", "current_pr_head"}
                     if value[key] is None)
    if value["pr_number"] is not None and value["current_pr_head"] is None:
        missing.append("identity.current_pr_head")
    if missing:
        raise Invalid("missing_mandatory", sorted(missing))
    string(value["repository"], "identity.repository")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value["repository"]):
        raise Invalid("malformed_schema", "identity.repository")
    for key in ("issue_number", "run_id", "run_attempt", "job_id", "failing_step"):
        number(value[key], "identity." + key)
    number(value["pr_number"], "identity.pr_number", nullable=True)
    for key in ("current_main_sha", "run_head_sha"):
        digest(value[key], "identity." + key)
    digest(value["current_pr_head"], "identity.current_pr_head", nullable=value["pr_number"] is None)
    if value["pr_number"] is None and value["current_pr_head"] is not None:
        raise Invalid("identity_conflict", "identity.current_pr_head")


def source(value, kind, ident, field):
    obj(value, {"locator", "provenance", "text", "truncated", "original_locator",
                "original_chars", "original_bytes"}, field)
    expected = {"issue": "untrusted_issue", "log": "trusted_collector",
                "code": "trusted_repository", "diff": "trusted_repository"}[kind]
    if value["provenance"] != expected:
        raise Invalid("untrusted_source", field + ".provenance")
    string(value["text"], field + ".text")
    if type(value["truncated"]) is not bool:
        raise Invalid("malformed_schema", field + ".truncated")
    for key in ("original_chars", "original_bytes"):
        number(value[key], field + "." + key)
    chars, size = len(value["text"]), len(value["text"].encode("utf-8"))
    if not value["truncated"]:
        if (value["original_chars"], value["original_bytes"]) != (chars, size):
            raise Invalid("silent_truncation", field)
        if value["original_locator"] is not None:
            raise Invalid("malformed_schema", field + ".original_locator")
    elif value["original_locator"] is None:
        raise Invalid("missing_truncation_locator", field)
    elif value["original_chars"] <= chars or value["original_bytes"] <= size:
        raise Invalid("malformed_schema", field + ".original_bytes")

    def locator(loc):
        obj(loc, LOCATOR, field + ".locator")
        for key in ("repository", "ref", "path"):
            string(loc[key], field + ".locator." + key)
        digest(loc["sha"], field + ".locator.sha")
        for key in ("line_start", "line_end"):
            number(loc[key], field + ".locator." + key)
        if loc["line_end"] < loc["line_start"]:
            raise Invalid("malformed_schema", field + ".locator.line_end")
        for key in ("issue_number", "pr_number", "run_id", "run_attempt", "job_id", "step"):
            number(loc[key], field + ".locator." + key, nullable=True)
        if loc["repository"] != ident["repository"]:
            raise Invalid("identity_conflict", field + ".locator.repository")
        if loc["issue_number"] != ident["issue_number"] or loc["pr_number"] != ident["pr_number"]:
            raise Invalid("identity_conflict", field + ".locator.issue_number")
        if kind == "log":
            if loc["ref"] != "run_head":
                raise Invalid("identity_conflict", field + ".locator.ref")
            for key in ("run_id", "run_attempt", "job_id"):
                if loc[key] != ident[key]:
                    raise Invalid("identity_conflict", field + ".locator." + key)
            if loc["sha"] != ident["run_head_sha"]:
                raise Invalid("identity_conflict", field + ".locator.sha")
            number(loc["step"], field + ".locator.step")
        else:
            if any(loc[key] is not None for key in ("run_id", "run_attempt", "job_id", "step")):
                raise Invalid("identity_conflict", field + ".locator.run_id")
            if kind == "issue":
                if loc["sha"] != ident["current_main_sha"] or loc["ref"] != "main":
                    raise Invalid("stale_source", field + ".locator.sha")
            else:
                expected_sha = ident["current_main_sha"] if loc["ref"] == "main" else ident["run_head_sha"]
                if loc["ref"] not in {"main", "run_head"}:
                    raise Invalid("malformed_schema", field + ".locator.ref")
                if loc["sha"] != expected_sha:
                    raise Invalid("stale_source", field + ".locator.sha")

    locator(value["locator"])
    if value["truncated"]:
        locator(value["original_locator"])
        original, current = value["original_locator"], value["locator"]
        if any(original[k] != current[k] for k in LOCATOR - {"line_start", "line_end"}):
            raise Invalid("identity_conflict", field + ".original_locator")
        if not (original["line_start"] <= current["line_start"] <= current["line_end"] <= original["line_end"]):
            raise Invalid("malformed_schema", field + ".original_locator")
    # The retained text must match the represented physical line range.
    if value["locator"]["line_end"] - value["locator"]["line_start"] + 1 != len(value["text"].splitlines()):
        raise Invalid("malformed_schema", field + ".locator.line_end")


def bound(value, limit, failure_window=False):
    """Keep verbatim UTF-8 evidence, retaining the original source locator."""
    raw = value["text"].encode("utf-8")
    if len(raw) <= limit:
        return
    offset, skipped = 0, 0
    if failure_window:
        lines = value["text"].splitlines(keepends=True)
        # First lexical error, with up to two preceding lines. No assertion of
        # root cause; if absent, retain the beginning and report missing matches.
        matches = [index for index, line in enumerate(lines)
                   if re.search(r"AssertionError|Error:|\berror\b|\bassert(?:ion)?\b", line)]
        if matches:
            skipped = max(0, matches[0] - 2)
            if len("".join(lines[skipped:matches[0]]).encode("utf-8")) > 1024:
                skipped = matches[0]
            offset = len("".join(lines[:skipped]).encode("utf-8"))
            match = re.search(r"AssertionError|Error:|\berror\b|\bassert(?:ion)?\b", lines[matches[0]])
            # Extremely long context on the error line must not hide the match.
            if len(lines[matches[0]][:match.start()].encode("utf-8")) > 1024:
                skipped = matches[0]
                offset = len("".join(lines[:skipped]).encode("utf-8"))
                offset += len(lines[skipped][:match.start() - 256].encode("utf-8"))
    if not value["truncated"]:
        value["original_locator"] = copy.deepcopy(value["locator"])
    value["truncated"] = True
    value["text"] = raw[offset:offset + limit].decode("utf-8", errors="ignore")
    value["locator"]["line_start"] += skipped
    count = len(value["text"].splitlines())
    value["locator"]["line_end"] = value["locator"]["line_start"] + max(1, count) - 1


def extract(text):
    """Observed lexical matches only; no causal/security classification."""
    patterns = {
        "assertion": r"^.*(?:AssertionError|assert(?:ion)?[ .:]).*$",
        "error": r"^.*(?:Error:|error\b).*$",
        "errno": r"\bE[A-Z]{2,}\b",
        "syscall": r"\b(?:syscall[ :=]+)([A-Za-z_][A-Za-z0-9_]*)",
        "path": r"(?:^|[\s='\"])(/[^\s'\",;\]}]+)",
    }
    return {key: sorted(set(re.findall(pattern, text, re.MULTILINE))) or None
            for key, pattern in patterns.items()}


def serialize(packet):
    # Count the canonical packet itself, including these two count fields.
    integrity = packet["integrity"]
    integrity["serialized_chars"] = integrity["serialized_bytes"] = 0
    for _ in range(16):
        rendered = canonical(packet)
        counts = (len(rendered), len(rendered.encode("utf-8")))
        if counts == (integrity["serialized_chars"], integrity["serialized_bytes"]):
            return rendered
        integrity["serialized_chars"], integrity["serialized_bytes"] = counts
    raise Invalid("serialization_failure", "integrity")


def build(data):
    """Return status + packet + canonical serialization; no packet on refusal.

    Inputs are structured snapshots from a trusted caller, never model output.
    Provenance labels are validated declarations, not authenticated collectors.
    """
    try:
        return _build(copy.deepcopy(data))
    except Invalid as exc:
        status = {"identity_conflict": "conflict", "stale_source": "stale"}.get(exc.reason, "incomplete")
        return {"status": status, "reason": exc.reason, "missing_mandatory_fields":
                (exc.field if isinstance(exc.field, list) else [exc.field])
                if exc.reason == "missing_mandatory" else [],
                "packet": None, "serialized": None}
    except (TypeError, ValueError, OverflowError, RecursionError):
        return {"status": "incomplete", "reason": "malformed_schema",
                "missing_mandatory_fields": [], "packet": None, "serialized": None}


def _build(data):
    obj(data, {"schema", "identity", "contract", "steps", "repository"}, "input")
    if data["schema"] != SCHEMA:
        raise Invalid("malformed_schema", "schema")
    ident = data["identity"]
    identity(ident)
    contract = data["contract"]
    obj(contract, {"issue", "checkpoint"}, "contract")
    obj(contract["issue"], SECTIONS, "contract.issue")
    for key in sorted(SECTIONS):
        source(contract["issue"][key], "issue", ident, "contract.issue." + key)
        # Contract evidence is mandatory and is never shortened to meet the cap.
        if contract["issue"][key]["truncated"]:
            raise Invalid("missing_mandatory", "contract.issue." + key)
    checkpoint = contract["checkpoint"]
    obj(checkpoint, {"mode", "boundary", "fallback_reason", "provenance"}, "contract.checkpoint")
    if checkpoint["provenance"] != "trusted_selector":
        raise Invalid("untrusted_source", "contract.checkpoint")
    if checkpoint["mode"] not in {"full", "checkpoint", "fallback"}:
        raise Invalid("malformed_schema", "contract.checkpoint.mode")
    for key in ("boundary", "fallback_reason"):
        string(checkpoint[key], "contract.checkpoint." + key, nullable=True)
    if ((checkpoint["boundary"] is not None) != (checkpoint["mode"] == "checkpoint")
            or (checkpoint["fallback_reason"] is not None) != (checkpoint["mode"] == "fallback")):
        raise Invalid("malformed_schema", "contract.checkpoint")
    if checkpoint["boundary"] is not None:
        try:
            if dt.datetime.fromisoformat(checkpoint["boundary"].replace("Z", "+00:00")).tzinfo is None:
                raise ValueError("timezone required")
        except ValueError as exc:
            raise Invalid("malformed_schema", "contract.checkpoint.boundary") from exc

    steps = data["steps"]
    if type(steps) is not list or not steps:
        raise Invalid("missing_mandatory", "steps")
    for index, step in enumerate(steps):
        field = "steps." + str(index)
        obj(step, {"number", "name", "conclusion", "fixture", "log"}, field)
        number(step["number"], field + ".number")
        string(step["name"], field + ".name")
        string(step["fixture"], field + ".fixture", nullable=True)
        if step["conclusion"] not in {"success", "failure", "skipped", "cancelled"}:
            raise Invalid("malformed_schema", field + ".conclusion")
        source(step["log"], "log", ident, field + ".log")
        if step["log"]["locator"]["step"] != step["number"]:
            raise Invalid("identity_conflict", field + ".log.locator.step")
    steps.sort(key=lambda step: step["number"])
    if len({step["number"] for step in steps}) != len(steps):
        raise Invalid("identity_conflict", "steps.number")
    failures = [step for step in steps if step["conclusion"] == "failure"]
    if not failures:
        raise Invalid("missing_mandatory", "first_failing_step")
    first = failures[0]
    if first["number"] != ident["failing_step"]:
        raise Invalid("identity_conflict", "identity.failing_step")
    preceding = [step for step in steps if step["number"] < first["number"] and step["conclusion"] == "success"][-1:]

    repository = data["repository"]
    obj(repository, {"diff", "files", "code"}, "repository")
    source(repository["diff"], "diff", ident, "repository.diff")
    if repository["diff"]["truncated"]:
        raise Invalid("missing_mandatory", "repository.diff")
    if type(repository["files"]) is not list or type(repository["code"]) is not list:
        raise Invalid("malformed_schema", "repository")
    for item in repository["files"]:
        obj(item, {"path", "additions", "deletions"}, "repository.files")
        string(item["path"], "repository.files.path")
        for key in ("additions", "deletions"):
            number(item[key], "repository.files." + key, nullable=True, minimum=0)
    repository["files"].sort(key=lambda item: item["path"])
    if len({item["path"] for item in repository["files"]}) != len(repository["files"]):
        raise Invalid("identity_conflict", "repository.files.path")
    for index, code in enumerate(repository["code"]):
        source(code, "code", ident, "repository.code." + str(index))
    repository["code"].sort(key=canonical)
    all_sources = list(contract["issue"].values()) + [step["log"] for step in steps]
    all_sources += [repository["diff"]] + repository["code"]
    observed = {}
    for evidence in all_sources:
        key = canonical(evidence["locator"])
        if key in observed and observed[key] != evidence:
            raise Invalid("identity_conflict", "source.locator")
        observed[key] = evidence
    if ident["pr_number"] is not None and ident["run_head_sha"] != ident["current_pr_head"]:
        raise Invalid("stale_source", "identity.current_pr_head")
    if ident["pr_number"] is None and ident["run_head_sha"] != ident["current_main_sha"]:
        raise Invalid("stale_source", "identity.current_main_sha")

    bounded = [(first["log"], 4096)] + [(step["log"], 1024) for step in preceding]
    bounded += [(code, 2048) for code in repository["code"]]
    for evidence, limit in bounded:
        bound(evidence, limit, failure_window=evidence is first["log"])
    packet = {"schema": SCHEMA, "identity": ident, "contract": contract,
              "failure": {"first_failing_step": first, "preceding_pass": preceding,
                          "extracted": None}, "repository": repository,
              "integrity": {"freshness": "fresh", "mismatch": False,
                            "status": "complete", "missing_mandatory_fields": [],
                            "missing_fields": [], "truncated": False}}
    while True:
        packet["failure"]["extracted"] = extract(first["log"]["text"])
        packet["integrity"]["missing_fields"] = sorted(
            ["failure.extracted." + key for key, value in packet["failure"]["extracted"].items() if value is None]
            + (["failure.fixture"] if first["fixture"] is None else [])
            + (["failure.preceding_pass"] if not preceding else [])
            + (["repository.code"] if not repository["code"] else [])
            + ["repository.files." + item["path"] + "." + key
               for item in repository["files"] for key in ("additions", "deletions") if item[key] is None])
        packet["integrity"]["truncated"] = any(evidence["truncated"] for evidence, _ in bounded)
        rendered = serialize(packet)
        size = len(rendered.encode("utf-8"))
        if size <= CAP:
            return {"status": "complete", "reason": None, "missing_mandatory_fields": [],
                    "packet": packet, "serialized": rendered}
        # Only bounded evidence can shrink. Identity/locators/contracts/files
        # survive intact. One UTF-8 character remains per mandatory source.
        candidates = [evidence for evidence, _ in bounded if len(evidence["text"]) > 1]
        if not candidates:
            return {"status": "oversized", "reason": "mandatory_evidence_exceeds_cap",
                    "missing_mandatory_fields": [], "candidate_bytes": size,
                    "packet": None, "serialized": None}
        largest = max(candidates, key=lambda evidence: len(evidence["text"].encode("utf-8")))
        limit = max(len(largest["text"][0].encode("utf-8")), len(largest["text"].encode("utf-8")) // 2)
        bound(largest, limit)
