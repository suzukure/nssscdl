"""Pure, production-unreachable stream record validation (#781).

The fixed sibling extractor owns usage validation. No CLI, identity acquisition,
stream capture, persistence or production provenance claim is provided here.
"""

import importlib.util
import json
from pathlib import Path


SCHEMA = "codex-exec-stream"
VERSION = 1
MAX_STREAM_BYTES = 4096
EXTRACTOR_NAME = "extract-codex-exec-usage.py"
FIELDS = ("schema", "version", "process_returncode", "collection_status", "usage_result")
STATUSES = ("collected", "capture_limit_exceeded", "invalid_input", "execution_not_started")


def load_validator():
    # Trusted repository code only; fixed sibling, no caller path or search.
    # Read source explicitly to avoid import bytecode/cache persistence.
    try:
        source_path = Path(__file__).with_name(EXTRACTOR_NAME)
        spec = importlib.util.spec_from_file_location("stream_exec_usage", source_path)
        module = importlib.util.module_from_spec(spec)
        source = spec.loader.get_source(spec.name)
        exec(compile(source, "<usage_validator>", "exec"), module.__dict__)
        validator = module.validate_result
        if callable(validator):
            return validator
    except Exception:
        pass
    # Never chain the import error or reflect its source path.
    raise ValueError("validator_unavailable") from None


def require(condition):
    if not condition:
        raise ValueError


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(",", ":"), allow_nan=False).encode("ascii")


def _validate(data, validator):
    require(type(data) is bytes and 0 < len(data) <= MAX_STREAM_BYTES)
    payload = data[:-1] if data.endswith(b"\n") else data
    result = json.loads(payload.decode("utf-8", "strict"),
                        object_pairs_hook=unique_object, parse_constant=reject_constant)
    require(type(result) is dict and set(result) == set(FIELDS))
    require(result["schema"] == SCHEMA and type(result["version"]) is int
            and result["version"] == VERSION)
    status, rc = result["collection_status"], result["process_returncode"]
    require(type(status) is str and status in STATUSES)
    if status == "execution_not_started":
        require(rc is None and result["usage_result"] is None)
    else:
        require(type(rc) is int and -255 <= rc <= 255)
        if status == "collected":
            usage = validator(canonical(result["usage_result"]))
            require(usage["availability"] != "reported" or rc == 0)
            result["usage_result"] = usage
        else:
            require(result["usage_result"] is None)
    require(payload == canonical(result))
    return result


def validate_stream(stream_bytes):
    """Bounded canonical record -> recorded; absent/bad bytes -> unknown inputs.

    Missing and invalid carry null, never raw input or fabricated zero usage.
    Validator availability is a code prerequisite, not an invalid record.
    """
    validator = load_validator()
    if type(stream_bytes) is bytes and not stream_bytes:
        return dict(evidence_status="missing", stream_result=None)
    try:
        result = _validate(stream_bytes, validator)
    except (ValueError, TypeError, RecursionError, OverflowError):
        return dict(evidence_status="invalid", stream_result=None)
    return dict(evidence_status="recorded", stream_result=result)
