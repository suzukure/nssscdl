#!/usr/bin/env python3
"""Read-only aggregation of the Issue #665 durable ledger (Issue #668)."""

import argparse
from collections import Counter, defaultdict
import datetime
from decimal import Decimal, localcontext
import importlib.util
import json
import os
import pathlib
import re
import sys

spec = importlib.util.spec_from_file_location(
    "usage_ledger", pathlib.Path(__file__).with_name("deepinfra-usage-ledger.py"))
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)
require = ledger.require
Error = ledger.LedgerError
MARKER = re.compile(r"deepinfra-usage-ledger:v1 / ([1-9][0-9]*) / ([1-9][0-9]*)")
DIMENSIONS = ("workflow_name", "usage_kind", "model", "run_conclusion", "usage_availability")
AVAILABILITIES = ("complete", "partial", "unavailable")


def utc(value, code="date_invalid"):
    require(type(value) is str and re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|\+00:00)", value), code)
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise Error(code) from None


def validate_record(value, prefix, repo):
    ledger.validate_record(value)
    require(value["schema_version"] == 1 and ledger.marker(value) == prefix, "record_identity_mismatch")
    name = value["workflow_name"]
    require(type(name) is str and name in ledger.WORKFLOWS
            and value["usage_kind"] == ledger.WORKFLOWS[name][0], "record_identity_mismatch")
    require(value["run_url"] == f"https://github.com/{repo}/actions/runs/{value['run_id']}/attempts/{value['run_attempt']}",
            "record_identity_mismatch")
    require(type(value["run_conclusion"]) is str and value["run_conclusion"] in ledger.CONCLUSIONS
            and type(value["head_sha"]) is str and re.fullmatch(r"[0-9a-f]{40}", value["head_sha"]), "record_invalid")
    utc(value["recorded_at"], "record_date_invalid")
    if value["telemetry_status"] == "valid":
        known = any(value[field] is not None for field in ledger.FIELDS)
        availability = value["usage_availability"]
        require((availability != "unavailable") == known, "record_invalid")
        require(not known or value["response_count"] > 0, "record_invalid")
        if availability == "complete":
            require(all(value[field] is not None for field in ledger.FIELDS)
                    and value["response_count"] == value["request_count"]
                    and value["missing_usage_response_count"] == value["request_error_count"] == 0, "record_invalid")
        elif availability == "partial":
            require(any(value[field] is None for field in ledger.FIELDS)
                    or value["response_count"] < value["request_count"]
                    or value["missing_usage_response_count"] > 0 or value["request_error_count"] > 0, "record_invalid")
        # A partial record may have all aggregate fields: an interrupted request,
        # errored response or a missing field in an earlier response still matters.
    return value


def decimal_sum(numbers):
    values = [Decimal(str(number)) for number in numbers]
    if not values:
        return None
    # Sum provider's serialized decimal values without binary-float addition or
    # Decimal's default 28-digit rounding, even for very small/large valid costs.
    with localcontext() as context:
        context.prec = max(v.adjusted() for v in values) - min(v.as_tuple().exponent for v in values) + len(str(len(values))) + 2
        total = format(sum(values, Decimal(0)), "f")
    return total.rstrip("0").rstrip(".") if "." in total else total


def summary(records):
    availability = Counter(record["usage_availability"] for record in records)
    totals = {}
    for field in ledger.FIELDS:
        known = [record for record in records if record[field] is not None]
        numbers = [record[field] for record in known]
        totals[field] = {
            "known_sum": decimal_sum(numbers) if field == "provider_estimated_cost_usd" else (sum(numbers) if numbers else None),
            "known_records": len(known), "unknown_records": len(records) - len(known),
            "partial_records": sum(record["usage_availability"] == "partial" for record in known),
        }
    return {"run_attempt_count": len(records),
            "usage_availability_counts": {key: availability[key] for key in AVAILABILITIES}, "totals": totals}


def aggregate(comments, repo, filters):
    require(type(repo) is str and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "repository_invalid")
    require(type(comments) is list and all(type(comment) is dict for comment in comments), "comments_invalid")
    identities = defaultdict(list)
    invalid = Counter()
    ignored = 0
    for comment in comments:
        user, body = comment.get("user"), comment.get("body")
        if (type(user) is not dict or user.get("login") != "github-actions[bot]" or user.get("type") != "Bot"
                or type(body) is not str):
            ignored += 1
            continue
        prefix, _, payload = body.partition("\n")
        match = MARKER.fullmatch(prefix)
        if not match:
            ignored += 1
            continue
        try:
            identity = tuple(int(part) for part in match.groups())
        except ValueError:
            invalid["record_identity_mismatch"] += 1
            continue
        value = None
        try:
            require(len(body.encode("utf-8")) <= ledger.MAX_USAGE_BYTES, "record_oversized")
            value = validate_record(ledger.parse_json(payload, "record_json_invalid"), prefix, repo)
        except Error as exc:
            invalid[str(exc)] += 1
        # Dedupe the whole input BEFORE filtering, including invalid candidates.
        # A second copy never silently selects the valid or in-range candidate.
        identities[identity].append(value)
    duplicates = [{"run_id": key[0], "run_attempt": key[1], "comment_count": len(values)}
                  for key, values in sorted(identities.items()) if len(values) > 1]
    records = [values[0] for _, values in sorted(identities.items()) if len(values) == 1 and values[0] is not None]
    before_filter = len(records)
    records = [record for record in records
               if (filters["since"] is None or record["recorded_at"] >= filters["since"])
               and (filters["until"] is None or record["recorded_at"] < filters["until"])
               and all(filters[field] is None or record[field] == filters[field] for field in DIMENSIONS)]
    groups = {}
    for field in DIMENSIONS:
        buckets = defaultdict(list)
        for record in records:
            buckets[record[field]].append(record)
        # Null model is an explicit group, never the string "unavailable".
        groups[field] = [{"value": key, **summary(buckets[key])}
                         for key in sorted(buckets, key=lambda key: (key is not None, key or ""))]
    times = [record["recorded_at"] for record in records]
    runs = [{key: record[key] for key in ("run_id", "run_attempt", "run_url", "recorded_at", *DIMENSIONS,
                                         "telemetry_status", "telemetry_reason_code")} for record in records]
    return {"schema_version": 1, "repository": repo, "ledger_issue": ledger.LEDGER,
            "filters": filters, "period": {"field": "recorded_at", "first": min(times) if times else None,
                                           "last": max(times) if times else None},
            "summary": summary(records), "groups": groups, "runs": runs,
            "diagnostics": {"comments_read": len(comments), "ignored_comments": ignored,
                            "invalid_comments": sum(invalid.values()), "invalid_by_reason": dict(sorted(invalid.items())),
                            "duplicate_identity_count": len(duplicates),
                            "duplicate_comments": sum(item["comment_count"] for item in duplicates),
                            "duplicate_identities": duplicates, "filtered_out_records": before_filter - len(records)}}


def markdown(report):
    # Render every JSON leaf, including groups, filters, diagnostics and run URLs.
    # Markdown is a view of this report; it is never parsed as an input.
    rows = []
    def visit(value, path):
        if isinstance(value, dict) and value:
            for key in sorted(value):
                visit(value[key], f"{path}.{key}" if path else key)
        elif isinstance(value, list) and value:
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]")
        else:
            cell = json.dumps(value, ensure_ascii=False, allow_nan=False)
            rows.append(f"| `{path}` | {cell.replace('|', '&#124;')} |")
    visit(report, "")
    return ("# DeepInfra利用台帳集計\n\n"
            "期間は台帳記録時刻（UTC）。known_sumは取得済み値の合計で、未取得はnull。"
            "unknown_recordsとpartial_recordsを合わせて確認してください。費用は10進文字列（USD）。"
            "重複identityは全件を除外し、診断はフィルタ前の台帳全体を対象とします。\n\n"
            "| 項目 | 値 |\n| --- | --- |\n" + "\n".join(rows) + "\n")


def parser():
    result = argparse.ArgumentParser(description="DeepInfra #665台帳をread-onlyで集計（JSON正本）")
    result.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), help="owner/repo")
    source = result.add_mutually_exclusive_group(required=True)
    source.add_argument("--comments", type=pathlib.Path, help="REST comments配列のJSON snapshot")
    source.add_argument("--fetch", action="store_true", help="gh apiで#665 commentsだけを全ページGET")
    result.add_argument("--since", help="recorded_atの下限（含む）、UTC ISO秒時刻")
    result.add_argument("--until", help="recorded_atの上限（含まない）、UTC ISO秒時刻")
    result.add_argument("--workflow", choices=sorted(ledger.WORKFLOWS), dest="workflow_name")
    result.add_argument("--usage-kind", choices=sorted(ledger.producer.USAGE_KINDS))
    result.add_argument("--model", choices=sorted(ledger.producer.USAGE_MODELS))
    result.add_argument("--run-conclusion", choices=sorted(ledger.CONCLUSIONS))
    result.add_argument("--usage-availability", choices=AVAILABILITIES)
    result.add_argument("--markdown", type=pathlib.Path, help="同じ集計をMarkdownファイルへ整形")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        require(type(args.repo) is str and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo), "repository_invalid")
        filters = {field: getattr(args, field) for field in DIMENSIONS}
        for field in ("since", "until"):
            value = getattr(args, field)
            filters[field] = utc(value, "filter_date_invalid").isoformat(timespec="seconds") if value else None
        require(filters["since"] is None or filters["until"] is None or filters["since"] < filters["until"], "filter_range_invalid")
        if args.comments:
            comments = ledger.parse_json(args.comments.read_bytes(), "comments_invalid")
        else:
            # No payload parameter, artifacts, logs, provider API or write path.
            comments = list(ledger.pages(f"/repos/{args.repo}/issues/{ledger.LEDGER}/comments"))
        report = aggregate(comments, args.repo, filters)
        encoded = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
        if args.markdown:
            args.markdown.write_text(markdown(report), encoding="utf-8")
        print(encoded, end="")
        return 0
    except Error as exc:
        print(f"DeepInfra台帳集計に失敗しました: {exc}", file=sys.stderr)
    except Exception:
        print("DeepInfra台帳集計に失敗しました: aggregation_internal_error", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
