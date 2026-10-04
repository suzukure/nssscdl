#!/usr/bin/env python3
"""Prepared-only selector. Caller supplies trusted policy and gated identity.

No provenance acquisition, lifecycle state, git/network calls or writes here.
The policy path is an explicit caller input, never an implicit sibling default.
"""

import json
import re
import sys


REPOSITORY = "suzukure/nssscdl"
POLICY_SCHEMA = "codex-issue-model-policy"
RESULT_SCHEMA = "codex-issue-model-selection"
VERSION = 1
ALLOWED_MODELS = frozenset(("gpt-6-luna",))
MAX_POLICY_BYTES = 65536
MAX_REQUEST_BYTES = 4096
MAX_ENTRIES = 256
MAX_ISSUE = 2**53 - 1


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


def parse(data, limit):
    require(type(data) is bytes and 0 < len(data) <= limit)
    return json.loads(data.decode("utf-8", "strict"),
                      object_pairs_hook=unique_object, parse_constant=reject_constant)


def fields(value, expected):
    require(type(value) is dict and set(value) == set(expected))


def issue_number(value):
    require(type(value) is int and 1 <= value <= MAX_ISSUE)


def select(policy_bytes, request_bytes):
    """Pure bounded bytes -> selection; malformed/unknown never means default."""
    policy = parse(policy_bytes, MAX_POLICY_BYTES)
    request = parse(request_bytes, MAX_REQUEST_BYTES)
    fields(policy, ("schema", "version", "repository", "entries"))
    require(policy["schema"] == POLICY_SCHEMA
            and type(policy["version"]) is int and policy["version"] == VERSION
            and policy["repository"] == REPOSITORY)
    fields(request, ("repository", "issue", "normal_model"))
    require(request["repository"] == REPOSITORY)
    issue_number(request["issue"])
    normal = request["normal_model"]
    require(type(normal) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", normal))
    entries = policy["entries"]
    require(type(entries) is list and len(entries) <= MAX_ENTRIES)
    models = {}
    for entry in entries:
        fields(entry, ("issue", "model"))
        issue_number(entry["issue"])
        require(entry["issue"] not in models and type(entry["model"]) is str
                and entry["model"] in ALLOWED_MODELS)
        models[entry["issue"]] = entry["model"]
    opted_in = request["issue"] in models
    return dict(schema=RESULT_SCHEMA, version=VERSION, issue=request["issue"],
                model=models[request["issue"]] if opted_in else normal,
                selection="opt_in" if opted_in else "default")


def main():
    # Avoid argparse/exception text reflecting arguments, paths or input bytes.
    if len(sys.argv) != 3 or sys.argv[1] != "--policy":
        print("モデル選択を拒否しました: invalid_arguments", file=sys.stderr)
        return 2
    try:
        with open(sys.argv[2], "rb") as stream:
            policy = stream.read(MAX_POLICY_BYTES + 1)
        request = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        result = select(policy, request)
    except Exception:
        print("モデル選択を拒否しました: invalid_policy_or_request", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
