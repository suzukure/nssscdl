#!/usr/bin/env python3
"""Bounded unit journal acquisition (#796); no production wiring or raw storage.

Trusted callers supply #780 identity bytes. Shape validation is not authority
proof; recorded workload usage remains billing-unverified.
"""

import importlib.util
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time


SELECTOR_NAME = "select-codex-usage-journal.py"
BUILDER_NAME = "build-codex-usage-evidence.py"
IDENTITY_NAME = "validate-codex-usage-identity.py"
ACQUISITION_SECONDS = 10
CLEANUP_SECONDS = 1


def load_sibling(name):
    # Closed direct dependencies; their existing loaders own transitive schemas.
    try:
        if name not in (SELECTOR_NAME, BUILDER_NAME, IDENTITY_NAME):
            raise ValueError
        spec = importlib.util.spec_from_file_location(
            "collector_sibling", Path(__file__).with_name(name))
        module = importlib.util.module_from_spec(spec)
        source = spec.loader.get_source(spec.name)
        exec(compile(source, "<collector_sibling>", "exec"), module.__dict__)
        return module
    except Exception:
        pass
    raise ValueError("validator_unavailable") from None


def _acquire(unit, limit):
    """Successful bounded EOF bytes only; None for every acquisition failure."""
    process = None
    try:
        deadline = time.monotonic() + ACQUISITION_SECONDS
        process = subprocess.Popen(
            ["/usr/bin/journalctl", "--unit=" + unit,
             "--no-pager", "--output=cat", "--quiet"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, shell=False)
        data = bytearray()
        with selectors.DefaultSelector() as readiness:
            readiness.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not readiness.select(remaining):
                    return None
                chunk = os.read(process.stdout.fileno(), min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > limit:
                    return None
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            return None
        return bytes(data)
    except Exception:
        return None
    finally:
        if process is not None:
            # No retries, unbounded drains or stderr capture, even on overflow.
            try:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=CLEANUP_SECONDS)
            except Exception:
                pass
            try:
                process.stdout.close()
            except Exception:
                pass


def collect(identity_bytes):
    """Identity -> exact unit -> acquisition -> existing selector and builder."""
    failure = None
    try:
        validator = load_sibling(IDENTITY_NAME).validate_identity
        identity = validator(identity_bytes)
    except Exception as error:
        failure = ("invalid_identity" if type(error) is ValueError
                   and error.args == ("invalid_identity",) else "validator_unavailable")
    if failure is not None:
        raise ValueError(failure) from None
    try:
        selector = load_sibling(SELECTOR_NAME)
        builder = load_sibling(BUILDER_NAME)
        # Check dependencies before starting the only subprocess.
        selector.load_stream_validator()(b"")
        builder.load_identity_validator()
        builder.load_stream_validator()
        prefix = {"develop-from-issue": "codex-developer",
                  "respond-to-claude": "codex-followup"}[identity["job"]]
        unit = f'{prefix}-{identity["run_id"]}-{identity["run_attempt"]}'
        journal = _acquire(unit, selector.MAX_JOURNAL_BYTES)
        stream = selector.INVALID if journal is None else selector.select_stream(journal)
        return builder.build(identity_bytes, stream)
    except Exception:
        pass
    raise ValueError("validator_unavailable") from None


def main():
    # No caller-supplied paths, commands, units or loader/search paths.
    if len(sys.argv) != 1:
        print("usage evidence収集を拒否しました: invalid_arguments", file=sys.stderr)
        return 2
    try:
        validator = load_sibling(IDENTITY_NAME)
        identity = sys.stdin.buffer.read(validator.MAX_IDENTITY_BYTES + 1)
        result = collect(identity)
        sys.stdout.buffer.write(result + b"\n")
        return 0
    except Exception as error:
        reason = ("invalid_identity" if type(error) is ValueError
                  and error.args == ("invalid_identity",) else "collection_unavailable")
    print("usage evidence収集を拒否しました: " + reason, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
