#!/usr/bin/env python3
"""Trusted, secretless usage-only consumer; Issue #667 / durable stream #665."""

import datetime
import importlib.util
import io
import json
import math
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import zipfile
import zlib

# Producer schema/constants are loaded only from the trusted checkout.
spec = importlib.util.spec_from_file_location(
    "usage_producer", pathlib.Path(__file__).with_name("deepinfra-investigator.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
WORKFLOWS = {
    "DeepInfra Investigator": ("investigator", "deepinfra-investigator.yml", "issue_comment"),
    "DeepInfra Review Benchmark": ("review_benchmark", "deepinfra-review-benchmark.yml", "workflow_dispatch"),
    "DeepInfra Diagnostic A": ("diagnostic_a", "deepinfra-diagnostic-a.yml", "workflow_dispatch"),
    "DeepInfra Diagnostic B": ("diagnostic_b", "deepinfra-diagnostic-b.yml", "workflow_dispatch"),
}
FIELDS = producer.USAGE_FIELDS
ERRORS = {None, "http_error", "network_error", "invalid_json", "invalid_response", "response_read_error"}
CONCLUSIONS = {"success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale", "startup_failure"}
MAX_USAGE_BYTES = 256 * 1024
MAX_ARCHIVE_BYTES = MAX_USAGE_BYTES + 64 * 1024
MAX_API_BYTES = 16 * 1024 * 1024
LEDGER = 665


class LedgerError(Exception):
    """Only fixed non-sensitive codes reach diagnostics."""


def require(condition, code):
    if not condition:
        raise LedgerError(code)


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def parse_json(raw, code):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, code)
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(LedgerError(code)))
    except (ValueError, UnicodeError, RecursionError):
        raise LedgerError(code) from None


def validate_usage(raw, kind):
    require(len(raw) <= MAX_USAGE_BYTES, "telemetry_oversized")
    value = parse_json(raw, "telemetry_invalid")
    keys = {"schema_version", "usage_kind", "model", "request_count", "response_count",
            "usage_availability", "missing_usage_response_count", "request_error_count", "requests", *FIELDS}
    require(type(value) is dict and set(value) == keys, "telemetry_invalid")
    require(type(value["schema_version"]) is int and value["schema_version"] == 1
            and value["usage_kind"] == kind, "telemetry_identity_mismatch")
    require(type(value["model"]) is str and value["model"] in producer.USAGE_MODELS, "telemetry_invalid")
    for field in ("request_count", "response_count", "missing_usage_response_count", "request_error_count"):
        require(integer(value[field]), "telemetry_invalid")
    requests = value["requests"]
    require(type(requests) is list and len(requests) == value["request_count"]
            and 1 <= len(requests) <= 512, "telemetry_invalid")
    for index, entry in enumerate(requests, 1):
        require(type(entry) is dict and set(entry) == {"request_index", "response_received", "error_reason_code", *FIELDS}, "telemetry_invalid")
        require(integer(entry["request_index"], 1) and entry["request_index"] == index
                and type(entry["response_received"]) is bool, "telemetry_invalid")
        require(entry["error_reason_code"] is None or
                (type(entry["error_reason_code"]) is str and entry["error_reason_code"] in ERRORS), "telemetry_invalid")
        for field in FIELDS:
            number = entry[field]
            valid = number is None or (integer(number) if field != "provider_estimated_cost_usd" else
                                       integer(number) or type(number) is float and number >= 0 and math.isfinite(number))
            require(valid, "telemetry_invalid")
            require(entry["response_received"] or number is None, "telemetry_invalid")
    responses = [entry for entry in requests if entry["response_received"]]
    totals = {}
    for field in FIELDS:
        numbers = [entry[field] for entry in responses if entry[field] is not None]
        try:
            total = sum(numbers) if numbers else None
        except OverflowError:
            raise LedgerError("telemetry_invalid") from None
        if field == "provider_estimated_cost_usd" and type(total) is float and not math.isfinite(total):
            total = None
        totals[field] = total
        # No coercion of boolean, string, or fractional token totals.
        require(value[field] is None if total is None else
                type(value[field]) in ((int, float) if field == "provider_estimated_cost_usd" else (int,))
                and value[field] == total, "telemetry_invalid")
    complete = len(responses) == len(requests) and all(
        entry[field] is not None for entry in responses for field in FIELDS
    ) and all(total is not None for total in totals.values()) and not any(entry["error_reason_code"] for entry in requests)
    availability = "complete" if complete else "partial" if any(total is not None for total in totals.values()) else "unavailable"
    require(value["response_count"] == len(responses)
            and value["missing_usage_response_count"] == sum(any(entry[field] is None for field in FIELDS) for entry in responses)
            and value["request_error_count"] == sum(bool(entry["error_reason_code"]) for entry in requests)
            and value["usage_availability"] == availability, "telemetry_invalid")
    return {key: value[key] for key in keys - {"requests"}}


def read_archive(raw, kind):
    require(len(raw) <= MAX_ARCHIVE_BYTES, "telemetry_oversized")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            require(len(members) == 1 and members[0].filename == "deepinfra-usage.json", "archive_invalid")
            member = members[0]
            mode = member.external_attr >> 16
            require(not member.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG)
                    and not member.flag_bits & 1, "archive_invalid")
            require(member.file_size <= MAX_USAGE_BYTES, "telemetry_oversized")
            with archive.open(member) as stream:
                content = stream.read(MAX_USAGE_BYTES + 1)
            return validate_usage(content, kind)
    except (zipfile.BadZipFile, zlib.error, RuntimeError, NotImplementedError, OSError, EOFError, ValueError):
        raise LedgerError("archive_invalid") from None


def api(path, payload=None, binary=False):
    # Fixed argument vector, no shell; raw stderr/response are never logged.
    args = ["gh", "api", path]
    if payload is not None:
        args += ["--method", "POST", "--input", "-"]
    limit = MAX_ARCHIVE_BYTES if binary else MAX_API_BYTES
    try:
        with tempfile.TemporaryFile() as output:
            completed = subprocess.run(args, input=None if payload is None else json.dumps(payload).encode(),
                                       stdout=output, stderr=subprocess.DEVNULL, timeout=60, check=False)
            require(completed.returncode == 0, "github_api_failed")
            require(output.tell() <= limit, "telemetry_oversized" if binary else "github_response_oversized")
            output.seek(0)
            raw = output.read(limit + 1)
    except (OSError, subprocess.TimeoutExpired):
        raise LedgerError("github_api_failed") from None
    return raw if binary else parse_json(raw, "github_response_invalid")


def pages(path, key=None):
    page = 1
    while True:
        response = api(f"{path}?per_page=100&page={page}")
        require(type(response) is dict if key else type(response) is list, "github_response_invalid")
        entries = response.get(key) if key else response
        require(type(entries) is list and len(entries) <= 100 and all(type(entry) is dict for entry in entries), "github_response_invalid")
        yield from entries
        if len(entries) < 100:
            return
        page += 1  # Complete pagination; job timeout is the fail-closed bound.


def identity(event, repo):
    require(type(event) is dict and event.get("action") == "completed", "event_invalid")
    run = event.get("workflow_run")
    require(type(run) is dict, "event_invalid")
    repository = event.get("repository", {})
    require(repository.get("full_name") == repo and integer(repository.get("id"), 1), "repository_mismatch")
    for source in (run.get("repository"), run.get("head_repository")):
        require(type(source) is dict and source.get("full_name") == repo
                and source.get("id") == repository["id"], "repository_mismatch")
    name = run.get("name")
    require(type(name) is str, "event_invalid")
    if name not in WORKFLOWS:
        return None
    kind, filename, trigger = WORKFLOWS[name]
    require(integer(run.get("id"), 1) and integer(run.get("run_attempt"), 1)
            and integer(run.get("workflow_id"), 1), "event_invalid")
    require(run.get("status") == "completed" and type(run.get("conclusion")) is str
            and run["conclusion"] in CONCLUSIONS and run.get("event") == trigger, "event_invalid")
    require(type(run.get("head_sha")) is str and re.fullmatch(r"[0-9a-f]{40}", run["head_sha"]), "event_invalid")
    require(run.get("head_branch") == repository.get("default_branch"), "untrusted_source_branch")
    # URL is constructed from validated identity, never copied from telemetry.
    return {"schema_version": 1, "run_id": run["id"], "run_attempt": run["run_attempt"],
            "workflow_name": name, "usage_kind": kind,
            "run_url": f"https://github.com/{repo}/actions/runs/{run['id']}/attempts/{run['run_attempt']}",
            "run_conclusion": run["conclusion"], "head_sha": run["head_sha"]}


def marker(record):
    return f"deepinfra-usage-ledger:v1 / {record['run_id']} / {record['run_attempt']}"


def validate_record(saved):
    """Shared durable record schema; producer remains the usage schema authority."""
    require(type(saved) is dict, "existing_record_invalid")
    keys = {"schema_version", "run_id", "run_attempt", "workflow_name", "usage_kind", "run_url",
            "run_conclusion", "head_sha", "model", "request_count", "response_count",
            "missing_usage_response_count", "request_error_count", "usage_availability", *FIELDS,
            "telemetry_status", "telemetry_reason_code", "recorded_at"}
    require(set(saved) == keys and type(saved["schema_version"]) is int
            and integer(saved["run_id"], 1) and integer(saved["run_attempt"], 1), "existing_record_invalid")
    allowed = {"valid": {"usage_complete", "usage_partial", "usage_unavailable"},
               "unavailable": {"artifact_missing", "artifact_expired"},
               "invalid": {"telemetry_invalid", "telemetry_identity_mismatch", "telemetry_oversized", "archive_invalid"}}
    require(type(saved["telemetry_status"]) is str and saved["telemetry_status"] in allowed
            and type(saved["telemetry_reason_code"]) is str
            and saved["telemetry_reason_code"] in allowed[saved["telemetry_status"]], "existing_record_invalid")
    require(type(saved["recorded_at"]) is str and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00", saved["recorded_at"]), "existing_record_invalid")
    if saved["telemetry_status"] != "valid":
        require(saved["usage_availability"] == "unavailable" and all(saved[key] is None for key in
                ("model", "request_count", "response_count", "missing_usage_response_count", "request_error_count", *FIELDS)), "existing_record_invalid")
    else:
        require(type(saved["model"]) is str and saved["model"] in producer.USAGE_MODELS
                and type(saved["usage_availability"]) is str and saved["usage_availability"] in
                {"complete", "partial", "unavailable"} and saved["telemetry_reason_code"] ==
                "usage_" + saved["usage_availability"], "existing_record_invalid")
        for key in ("request_count", "response_count", "missing_usage_response_count", "request_error_count"):
            require(integer(saved[key]), "existing_record_invalid")
        require(1 <= saved["request_count"] <= 512 and saved["response_count"] <= saved["request_count"]
                and saved["missing_usage_response_count"] <= saved["response_count"]
                and saved["request_error_count"] <= saved["request_count"], "existing_record_invalid")
        for key in FIELDS:
            value = saved[key]
            require(value is None or integer(value) or key == "provider_estimated_cost_usd" and
                    type(value) is float and value >= 0 and math.isfinite(value), "existing_record_invalid")
    return saved


def existing(repo, record):
    matches = []
    prefix = marker(record) + "\n"
    for comment in pages(f"/repos/{repo}/issues/{LEDGER}/comments"):
        user = comment.get("user") or {}
        # A human quoting or copying the marker cannot suppress a machine write.
        if user.get("login") != "github-actions[bot]" or user.get("type") != "Bot":
            continue
        body = comment.get("body")
        if not isinstance(body, str) or not body.startswith(prefix):
            continue
        saved = parse_json(body[len(prefix):], "existing_record_invalid")
        require(type(saved) is dict and saved.get("schema_version") == 1
                and all(saved.get(key) == record[key] for key in
                        ("run_id", "run_attempt", "workflow_name", "usage_kind", "run_url", "run_conclusion", "head_sha")), "existing_record_invalid")
        validate_record(saved)
        require(integer(comment.get("id"), 1), "existing_record_invalid")
        matches.append(comment["id"])
    require(len(matches) <= 1, "duplicate_existing_records")
    return bool(matches)


def consume(event, repo):
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "repository_invalid")
    record = identity(event, repo)
    if record is None:
        return "unknown_workflow_ignored"
    run_id, attempt = record["run_id"], record["run_attempt"]
    run = api(f"/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}")
    fresh = identity({"action": "completed", "repository": event["repository"], "workflow_run": run}, repo)
    require(fresh == record and run.get("workflow_id") == event["workflow_run"]["workflow_id"], "run_identity_mismatch")
    workflow = api(f"/repos/{repo}/actions/workflows/{run['workflow_id']}")
    require(workflow.get("path") == ".github/workflows/" + WORKFLOWS[record["workflow_name"]][1], "workflow_identity_mismatch")
    # Entry-gate skips are not paid attempts; keep identity validation fail-closed.
    if record["run_conclusion"] == "skipped":
        return "skipped_run_ignored"
    if existing(repo, record):
        return "already_recorded"
    name = f"deepinfra-usage-{record['usage_kind']}-{run_id}-{attempt}"
    artifacts = [item for item in pages(f"/repos/{repo}/actions/runs/{run_id}/artifacts", "artifacts") if item.get("name") == name]
    telemetry = {"model": None, "request_count": None, "response_count": None,
                 "missing_usage_response_count": None, "request_error_count": None,
                 "usage_availability": "unavailable", **dict.fromkeys(FIELDS)}
    status, reason = "unavailable", "artifact_missing"
    if artifacts:
        require(len(artifacts) == 1, "artifact_identity_ambiguous")
        artifact = artifacts[0]
        require(integer(artifact.get("id"), 1) and integer(artifact.get("size_in_bytes"))
                and type(artifact.get("expired")) is bool, "artifact_metadata_invalid")
        source = artifact.get("workflow_run") or {}
        require(source.get("id") == run_id and source.get("head_sha") == record["head_sha"]
                and source.get("repository_id") == event["repository"]["id"]
                and source.get("head_repository_id") == event["repository"]["id"], "artifact_identity_mismatch")
        if artifact["expired"]:
            reason = "artifact_expired"
        elif artifact["size_in_bytes"] > MAX_ARCHIVE_BYTES:
            status, reason = "invalid", "telemetry_oversized"
        else:
            try:
                raw = api(f"/repos/{repo}/actions/artifacts/{artifact['id']}/zip", binary=True)
                telemetry = read_archive(raw, record["usage_kind"])
                telemetry.pop("schema_version")
                telemetry.pop("usage_kind")
                status = "valid"
                reason = {"complete": "usage_complete", "partial": "usage_partial", "unavailable": "usage_unavailable"}[telemetry["usage_availability"]]
            except LedgerError as exc:
                if str(exc) not in {"telemetry_invalid", "telemetry_identity_mismatch", "telemetry_oversized", "archive_invalid"}:
                    raise
                status, reason = "invalid", str(exc)
    record.update(telemetry, telemetry_status=status, telemetry_reason_code=reason,
                  recorded_at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
    body = marker(record) + "\n" + json.dumps(record, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    # Recheck the whole stream immediately before writing, within record-job concurrency.
    if existing(repo, record):
        return "already_recorded"
    try:
        posted = api(f"/repos/{repo}/issues/{LEDGER}/comments", {"body": body})
        require(integer(posted.get("id"), 1) and posted.get("body") == body, "comment_write_unconfirmed")
    except LedgerError:
        # An uncertain POST is never retried. Re-read to reconcile a lost response.
        if not existing(repo, record):
            raise LedgerError("comment_write_unconfirmed") from None
    return "recorded_" + status


def report(code, failed=False):
    text = f"DeepInfra利用台帳: {'失敗' if failed else '処理結果'} `{code}`。\n"
    print(text, end="", file=sys.stderr if failed else sys.stdout)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(text)


def main():
    try:
        require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_run", "event_invalid")
        with open(os.environ["GITHUB_EVENT_PATH"], "rb") as stream:
            raw = stream.read(MAX_API_BYTES + 1)
        require(len(raw) <= MAX_API_BYTES, "event_invalid")
        result = consume(parse_json(raw, "event_invalid"), os.environ["GITHUB_REPOSITORY"])
        report(result)
        return 0
    except LedgerError as exc:
        report(str(exc), True)
    except Exception:
        report("consumer_internal_error", True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
