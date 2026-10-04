#!/usr/bin/env python3
"""Prepared-only fresh exec usage extraction (#753); no provenance acquisition.

The pure API accepts JSONL bytes and context JSON bytes, returning canonical
JSON bytes. Only main() reads the explicit context path and bounded stdin.
Source shape: Issue #753's fixed Codex 0.159.3 exec event contract. Synthetic
proof does not establish runtime provenance, billing or all-request coverage.
"""

import json
import sys


CONTEXT_SCHEMA = "codex-exec-usage-context"
RESULT_SCHEMA = "codex-exec-usage"
VERSION = 1
SOURCE = "codex_exec_jsonl_workload_reported"
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_LINE_BYTES = 1024 * 1024
MAX_RECORDS = 50000
MAX_CONTEXT_BYTES = 4096
MAX_OUTPUT_BYTES = 1024
MAX_TOKENS = 2**53 - 1
USAGE_FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens",
                "output_tokens", "reasoning_output_tokens")
EVENT_FIELDS = {
    "thread.started": ("type", "thread_id"),
    "turn.started": ("type",),
    "turn.completed": ("type", "usage"),
    "turn.failed": ("type", "error"),
    "error": ("type", "message"),
    "item.started": ("type", "item"),
    "item.updated": ("type", "item"),
    "item.completed": ("type", "item"),
}


def require(condition):
    if not condition:
        raise ValueError("invalid_input")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("invalid_input")


class JsonInteger(str):
    """Keep numeric lexemes opaque until an adopted field needs a bounded int."""


class JsonFloat(str):
    """Valid JSON floats remain distinct from adopted strings and integers."""


def parse(data):
    return json.loads(data.decode("utf-8", "strict"),
                      object_pairs_hook=unique_object,
                      parse_constant=reject_constant,
                      parse_int=JsonInteger, parse_float=JsonFloat)


def fields(value, expected):
    require(type(value) is dict and set(value) == set(expected))


def validate_usage(usage):
    fields(usage, USAGE_FIELDS)
    # JSON decoding must not apply Python's integer digit cap or binary-float
    # overflow to opaque item data. Convert only these adopted integer fields.
    for key, value in usage.items():
        require(type(value) is JsonInteger and len(value) <= 17)
        value = int(value)
        require(0 <= value <= MAX_TOKENS)
        usage[key] = value
    require(usage["cached_input_tokens"] <= usage["input_tokens"]
            and usage["cache_write_input_tokens"] <= usage["input_tokens"]
            and usage["reasoning_output_tokens"] <= usage["output_tokens"])


def extract(jsonl_bytes, context_bytes):
    """Pure bounded inputs -> canonical bounded JSON; invalid raises fixed ValueError.

    Context is caller-supplied data, not proof of trusted process provenance.
    Blank lines are allowed, but thread.started and turn.started are required.
    A complete final JSON line need not end in LF; a truncated JSON line fails.
    """
    try:
        return _extract(jsonl_bytes, context_bytes)
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ValueError("invalid_input") from None


def _extract(data, context_bytes):
    require(type(data) is bytes and len(data) <= MAX_INPUT_BYTES)
    require(type(context_bytes) is bytes and 0 < len(context_bytes) <= MAX_CONTEXT_BYTES)
    context = parse(context_bytes)
    fields(context, ("schema", "version", "mode", "process_outcome"))
    require(context["schema"] == CONTEXT_SCHEMA
            and type(context["version"]) is JsonInteger and context["version"] == "1"
            and context["mode"] == "fresh_exec"
            and type(context["process_outcome"]) is str
            and context["process_outcome"] in ("success", "failed", "cancelled", "unknown"))
    # Validate even blank lines with strict UTF-8. Split on LF only, so an
    # embedded CR/control character is not silently converted into framing.
    data.decode("utf-8", "strict")
    thread = turn = failure = False
    terminal = None
    usage = None
    count = 0
    for line in data.split(b"\n"):
        require(len(line) <= MAX_LINE_BYTES)
        if not line.strip(b" \t\r"):
            continue
        count += 1
        require(count <= MAX_RECORDS and terminal is None)
        event = parse(line)
        require(type(event) is dict and type(event.get("type")) is str)
        kind = event["type"]
        require(kind in EVENT_FIELDS)
        fields(event, EVENT_FIELDS[kind])
        if kind == "thread.started":
            require(not thread and not turn and type(event["thread_id"]) is str
                    and 0 < len(event["thread_id"]) <= 128)
            thread = True
        elif kind == "turn.started":
            require(thread and not turn)
            turn = True
        elif kind in ("turn.completed", "turn.failed"):
            require(thread and turn)
            terminal = kind
            if kind == "turn.completed":
                require(context["process_outcome"] not in ("failed", "cancelled"))
                validate_usage(event["usage"])
                usage = event["usage"]
            else:
                fields(event["error"], ("message",))
                require(type(event["error"]["message"]) is str)
                failure = True
        elif kind == "error":
            require(type(event["message"]) is str)
            failure = True
        else:
            require(thread and turn)
            # item is opaque JSON: never inspect token-like fields or raw text.
    require(thread and turn)
    outcome = context["process_outcome"]
    if outcome != "success":
        reason = "process_" + outcome
    elif failure:
        reason = "execution_failed"
    elif terminal is None:
        reason = "missing_terminal"
    elif not any(usage.values()):
        reason = "zero_unverified"
    else:
        reason = "terminal_cumulative"
    reported = reason == "terminal_cumulative"
    result = dict(schema=RESULT_SCHEMA, version=VERSION, source=SOURCE,
                  availability="reported" if reported else "unavailable",
                  reason=reason, usage=usage if reported else None)
    canonical = json.dumps(result, sort_keys=True, ensure_ascii=True,
                           separators=(",", ":"), allow_nan=False).encode("ascii")
    require(len(canonical) <= MAX_OUTPUT_BYTES)
    return canonical


def main():
    # Neither arguments, paths nor exception messages may be reflected.
    if len(sys.argv) != 3 or sys.argv[1] != "--context":
        print("usage抽出を拒否しました: invalid_arguments", file=sys.stderr)
        return 2
    try:
        with open(sys.argv[2], "rb") as stream:
            context = stream.read(MAX_CONTEXT_BYTES + 1)
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        result = extract(data, context)
    except Exception:
        print("usage抽出を拒否しました: invalid_input", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(result + b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
