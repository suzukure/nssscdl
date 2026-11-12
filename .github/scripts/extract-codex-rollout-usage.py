"""Prepared-only Codex 0.159.3 rollout observation (#1061).

extract(prepared_bytes) -> canonical ASCII JSON bytes; no I/O or CLI.
Only token_usage_record.payload.response_id / usage are adopted. Other rollout
records and extra metadata are opaque JSON, never output. This does not prove
source provenance, complete request coverage, failed usage or provider billing.
"""

import json


RESULT_SCHEMA = "codex-rollout-usage"
VERSION = 1
SOURCE = "codex_0.159.3_rollout_token_usage_record"
# Operational bounds for this prepared parser, not claims about rollout size.
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_LINE_BYTES = 1024 * 1024
MAX_LINES = 50000
MAX_RECORDS = 4096
MAX_RESPONSE_ID_CHARS = 512
MAX_OUTPUT_BYTES = 1024
MAX_TOKENS = 2**53 - 1
THRESHOLD = 272000
USAGE_FIELDS = frozenset(("input_tokens", "cached_input_tokens",
                          "cache_write_input_tokens", "output_tokens",
                          "reasoning_output_tokens", "total_tokens"))
METRICS = ("recorded_completed_response_count", "max_observed_response_input_tokens",
           "observed_above_272k_completed_response_count")


def require(condition):
    if not condition:
        raise ValueError("invalid_input")


class JsonInteger(str):
    """Opaque lexeme: unrelated JSON numbers need no int conversion."""


class JsonFloat(str):
    """Distinguish valid opaque JSON floats from adopted integer fields."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("invalid_input")


def parse(line):
    return json.loads(line.decode("utf-8", "strict"), object_pairs_hook=unique_object,
                      parse_int=JsonInteger, parse_float=JsonFloat,
                      parse_constant=reject_constant)


def validate_usage(usage):
    # input is mandatory; absent optional counters stay absent, never zero-filled.
    require(type(usage) is dict and "input_tokens" in usage
            and set(usage) <= USAGE_FIELDS)
    values = {}
    for key, value in usage.items():
        require(type(value) is JsonInteger and len(value) <= 17)
        number = int(value)
        require(0 <= number <= MAX_TOKENS)
        values[key] = number
    for key in ("cached_input_tokens", "cache_write_input_tokens"):
        if key in values:
            require(values[key] <= values["input_tokens"])
    # cached and cache-write are individually bounded; do not infer disjointness.
    if "reasoning_output_tokens" in values:
        require("output_tokens" in values
                and values["reasoning_output_tokens"] <= values["output_tokens"])
    if "total_tokens" in values:
        require("output_tokens" in values)
        total = values["input_tokens"] + values["output_tokens"]
        require(total <= MAX_TOKENS and values["total_tokens"] == total)
    return values["input_tokens"]


def observe(data):
    require(type(data) is bytes and len(data) <= MAX_INPUT_BYTES)
    data.decode("utf-8", "strict")
    # LF framing only. A complete final line may omit LF; truncation is invalid.
    line_count = data.count(b"\n") + int(bool(data) and not data.endswith(b"\n"))
    require(line_count <= MAX_LINES)
    lines = data.split(b"\n")
    if lines[-1] == b"":
        lines.pop()
    seen = set()
    maximum = above = 0
    for line in lines:
        require(len(line) <= MAX_LINE_BYTES)
        if not line.strip(b" \t\r"):
            continue
        record = parse(line)
        require(type(record) is dict and type(record.get("type")) is str)
        if record["type"] != "token_usage_record":
            continue
        payload = record.get("payload")
        require(type(payload) is dict)
        response_id = payload.get("response_id")
        require(type(response_id) is str and 0 < len(response_id) <= MAX_RESPONSE_ID_CHARS)
        require(response_id not in seen and len(seen) < MAX_RECORDS)
        observed = validate_usage(payload.get("usage"))
        seen.add(response_id)
        maximum = max(maximum, observed)
        above += observed > THRESHOLD
    return (len(seen), maximum, above) if seen else None


def extract(prepared_bytes):
    """Fail closed for the whole input; never expose partial metrics or raw errors.

    Metadata strings are fixed literals; input-derived output is numeric only.
    Unknown/invalid metrics are null, including the count (never fabricated 0).
    """
    try:
        metrics = observe(prepared_bytes)
        reason = "observed_completed" if metrics else "no_records"
    except (ValueError, TypeError, RecursionError, OverflowError):
        metrics = None
        reason = "invalid_input"
    result = dict(schema=RESULT_SCHEMA, version=VERSION, source=SOURCE,
                  availability="observed" if metrics else "unknown", reason=reason,
                  billing_status="unverified", coverage="observed_only")
    result.update(zip(METRICS, metrics if metrics else (None,) * len(METRICS)))
    canonical = json.dumps(result, sort_keys=True, ensure_ascii=True,
                           separators=(",", ":"), allow_nan=False).encode("ascii")
    require(len(canonical) <= MAX_OUTPUT_BYTES)
    return canonical
