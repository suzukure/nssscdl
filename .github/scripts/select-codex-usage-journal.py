"""Pure bounded journal selection (#789); no acquisition or authority proof.

The fixed sibling validator owns stream/usage schemas. A caller must establish
unique-unit identity, successful bounded acquisition and absence of truncation.
"""

import importlib.util
import json
from pathlib import Path


STREAM_NAME = "validate-codex-usage-stream.py"
MAX_JOURNAL_BYTES = 16 * 1024 * 1024
INVALID = b"invalid"


def load_stream_validator():
    # Fixed trusted sibling source; no search or bytecode/cache writes.
    try:
        source_path = Path(__file__).with_name(STREAM_NAME)
        spec = importlib.util.spec_from_file_location("journal_stream", source_path)
        module = importlib.util.module_from_spec(spec)
        source = spec.loader.get_source(spec.name)
        exec(compile(source, "<stream_validator>", "exec"), module.__dict__)
        validator = module.validate_stream
        if callable(validator):
            return validator
    except Exception:
        pass
    raise ValueError("validator_unavailable") from None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError


def select_stream(journal_bytes):
    """Canonical candidate without LF, b'' for missing, fixed sentinel for invalid."""
    validator = load_stream_validator()
    if type(journal_bytes) is not bytes or len(journal_bytes) > MAX_JOURNAL_BYTES:
        return INVALID
    candidate = None
    try:
        for line in journal_bytes.split(b"\n"):
            if not line.lstrip(b" \t\r\v\f").startswith(b"{"):
                continue
            # Numeric lexemes of other schemas are opaque; no integer digit cap
            # or float overflow should turn valid unrelated JSON into corruption.
            value = json.loads(line.decode("utf-8", "strict"),
                               object_pairs_hook=unique_object, parse_constant=reject_constant,
                               parse_int=str, parse_float=str)
            if value.get("schema") != "codex-exec-stream":
                continue
            if candidate is not None:
                return INVALID
            candidate = line
    except (ValueError, TypeError, RecursionError, OverflowError):
        return INVALID
    if candidate is None:
        return b""
    failed = False
    try:
        result = validator(candidate)
        if (type(result) is not dict or set(result) != {"evidence_status", "stream_result"}
                or result["evidence_status"] not in ("recorded", "invalid")
                or (type(result["stream_result"]) is not dict if result["evidence_status"] == "recorded"
                    else result["stream_result"] is not None)):
            raise ValueError
    except Exception:
        failed = True
    if failed:
        raise ValueError("validator_unavailable") from None
    return candidate if result["evidence_status"] == "recorded" else INVALID
