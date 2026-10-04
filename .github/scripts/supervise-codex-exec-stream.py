#!/usr/bin/env python3
"""Prepared-only bounded stream/outcome collector (#761), never production proof.

Caller owns argv/extractor provenance, environment, cancellation and tree cleanup.
No persistence, timeout, retry, signal forwarding or implicit source discovery.
"""

import importlib.util
import json
import os
import subprocess
import sys


SCHEMA = "codex-exec-stream"
VERSION = 1
MAX_CAPTURE_BYTES = 16 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
MAX_ARGV = 128
MAX_ARGV_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 4096
EXTRACTOR_NAME = "extract-codex-exec-usage.py"


def validate_argv(argv):
    if type(argv) not in (list, tuple) or not 0 < len(argv) <= MAX_ARGV:
        raise ValueError("invalid_arguments")
    size = 0
    for argument in argv:
        if type(argument) is not str or "\0" in argument or len(argument) > MAX_ARGV_BYTES:
            raise ValueError("invalid_arguments")
        size += len(argument.encode("utf-8", "strict"))
        if size > MAX_ARGV_BYTES:
            raise ValueError("invalid_arguments")
    if not os.path.isabs(argv[0]):
        raise ValueError("invalid_arguments")
    return list(argv)


def record(returncode, status, usage=None):
    data = json.dumps(dict(schema=SCHEMA, version=VERSION,
                           process_returncode=returncode, collection_status=status,
                           usage_result=usage), sort_keys=True, ensure_ascii=True,
                      separators=(",", ":"), allow_nan=False).encode("ascii")
    if len(data) + 1 > MAX_OUTPUT_BYTES:
        raise ValueError("invalid_input")
    return data


def supervise(argv, parser, result_validator):
    """Explicit argv + existing extract/validate_result callables -> JSON bytes.

    Invalid invocation raises before launch. The supplied result validator must
    be the extractor's validator; neither callable's provenance is acquired here.
    EOF and wait must both finish. Outer kill may leave no result at all.
    """
    argv = validate_argv(argv)
    if not callable(parser) or not callable(result_validator):
        raise ValueError("invalid_arguments")
    try:
        child = subprocess.Popen(argv, shell=False, stdin=None,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 bufsize=0)
    except Exception:
        return record(None, "execution_not_started")
    capture = bytearray()
    limited = False
    with child.stdout:
        while True:
            chunk = child.stdout.read(CHUNK_BYTES)
            if not chunk:
                break
            if not limited:
                if len(capture) + len(chunk) > MAX_CAPTURE_BYTES:
                    capture.clear()
                    limited = True
                else:
                    capture.extend(chunk)
    returncode = child.wait()
    if limited:
        return record(returncode, "capture_limit_exceeded")
    context = json.dumps(dict(schema="codex-exec-usage-context", version=1,
                              mode="fresh_exec",
                              process_outcome="success" if returncode == 0 else "failed"),
                         sort_keys=True, separators=(",", ":")).encode("ascii")
    try:
        result = parser(bytes(capture), context)
        usage = result_validator(result)
        return record(returncode, "collected", usage)
    except Exception:
        return record(returncode, "invalid_input")


def exit_status(returncode):
    if returncode is None:
        return 2
    return returncode if returncode >= 0 else 128 - returncode


def load_extractor(source_path):
    # One explicit prepared source; no sibling search or production trust claim.
    if os.path.basename(source_path) != EXTRACTOR_NAME:
        raise ValueError("invalid_arguments")
    spec = importlib.util.spec_from_file_location("prepared_exec_usage", source_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    args = sys.argv[1:]
    try:
        if len(args) < 4 or args[0] != "--extractor" or args[2] != "--":
            raise ValueError("invalid_arguments")
        argv = validate_argv(args[3:])
        if not args[1] or "\0" in args[1] or os.path.basename(args[1]) != EXTRACTOR_NAME:
            raise ValueError("invalid_arguments")
    except Exception:
        print("stream収集を拒否しました: invalid_arguments", file=sys.stderr)
        return 2
    # Imports must not write bytecode/persistent state, even without CLI -B.
    sys.dont_write_bytecode = True
    try:
        extractor = load_extractor(args[1])
        parser, validator = extractor.extract, extractor.validate_result
        if not callable(parser) or not callable(validator):
            raise ValueError("invalid_arguments")
    except Exception:
        data = record(None, "execution_not_started")
    else:
        data = supervise(argv, parser, validator)
    sys.stdout.buffer.write(data + b"\n")
    return exit_status(json.loads(data)["process_returncode"])


if __name__ == "__main__":
    sys.exit(main())
