#!/usr/bin/env python3
"""Pure, production-unreachable evidence assembly and bounded input CLI (#782).

Identity validation establishes shape, not GitHub authority. Stream values are
workload-reported; recorded evidence establishes neither billing nor success.
"""

import importlib.util
import json
from pathlib import Path
import sys


IDENTITY_NAME = "validate-codex-usage-identity.py"
STREAM_NAME = "validate-codex-usage-stream.py"
MAX_INPUT_BYTES = 4096
MAX_OUTPUT_BYTES = 8192


def load_identity_validator():
    # Fixed trusted sibling source; no bytecode/cache writes or path search.
    try:
        source_path = Path(__file__).with_name(IDENTITY_NAME)
        spec = importlib.util.spec_from_file_location("evidence_identity", source_path)
        module = importlib.util.module_from_spec(spec)
        source = spec.loader.get_source(spec.name)
        exec(compile(source, "<identity_validator>", "exec"), module.__dict__)
        validator = module.validate_identity
        if callable(validator):
            return validator
    except Exception:
        pass
    raise ValueError("validator_unavailable") from None


def load_stream_validator():
    try:
        source_path = Path(__file__).with_name(STREAM_NAME)
        spec = importlib.util.spec_from_file_location("evidence_stream", source_path)
        module = importlib.util.module_from_spec(spec)
        source = spec.loader.get_source(spec.name)
        exec(compile(source, "<stream_validator>", "exec"), module.__dict__)
        validator = module.validate_stream
        if callable(validator):
            return validator
    except Exception:
        pass
    raise ValueError("validator_unavailable") from None


def build(identity_bytes, stream_bytes):
    """Use validator outputs in identity -> stream order; canonical bytes, no LF."""
    failure = None
    try:
        identity_validator = load_identity_validator()
    except Exception:
        failure = "validator_unavailable"
    if failure is not None:
        raise ValueError(failure) from None
    try:
        identity = identity_validator(identity_bytes)
        if type(identity) is not dict:
            raise ValueError
    except Exception as error:
        failure = ("invalid_identity" if type(error) is ValueError
                   and error.args == ("invalid_identity",) else "validator_unavailable")
    if failure is not None:
        raise ValueError(failure) from None
    try:
        stream = load_stream_validator()(stream_bytes)
        # Check only the validator's return envelope, never its input schemas.
        if (type(stream) is not dict or set(stream) != {"evidence_status", "stream_result"}
                or stream["evidence_status"] not in ("recorded", "missing", "invalid")
                or (type(stream["stream_result"]) is not dict if stream["evidence_status"] == "recorded"
                    else stream["stream_result"] is not None)):
            raise ValueError
        record = dict(schema="codex-usage-evidence", version=1, identity=identity,
                      source="codex_exec_jsonl_workload_reported", billing_status="unverified",
                      evidence_status=stream["evidence_status"], stream_result=stream["stream_result"])
        result = json.dumps(record, sort_keys=True, ensure_ascii=True,
                            separators=(",", ":"), allow_nan=False).encode("ascii")
    except Exception:
        failure = "validator_unavailable"
    if failure is not None:
        raise ValueError(failure) from None
    if len(result) > MAX_OUTPUT_BYTES:
        raise ValueError("invalid_evidence") from None
    return result


def diagnostic(reason):
    print("usage evidenceの組み立てを拒否しました: " + reason, file=sys.stderr)


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--identity":
        diagnostic("invalid_arguments")
        return 2
    try:
        with open(sys.argv[2], "rb") as stream:
            identity = stream.read(MAX_INPUT_BYTES + 1)
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    except Exception:
        diagnostic("input_unavailable")
        return 1
    try:
        result = build(identity, data)
    except ValueError as error:
        diagnostic(error.args[0])
        return 1
    try:
        sys.stdout.buffer.write(result + b"\n")
    except Exception:
        diagnostic("invalid_evidence")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
