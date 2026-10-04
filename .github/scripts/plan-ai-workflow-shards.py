#!/usr/bin/env python3
"""#756 pure/dormant full-inventory planner; no discovery or fixture execution.

CLI: python3 -B plan-ai-workflow-shards.py < fixtures.nul
Input is strict UTF-8, one canonical .github/scripts/test-*.sh path per NUL,
including a final NUL. At least two distinct paths are required. Paths are
literal data, never normalized, expanded, or checked against runtime hints.

Output is one canonical JSON line (sorted keys, ASCII escapes, no whitespace)
with schema ai-workflow-shard-plan, version 1, policy observed-lpt-v1,
shard_count 2, and shards [{id: 1, fixtures: [...]}, {id: 2, fixtures: [...]}].
Both lists are nonempty, sorted, disjoint, and cover every input exactly once.
This is a planning record, not execution/trust permission or worker handoff.
Worker naming and production integration remain outside this helper.

Policy: descending integer weight, then path; assign to the smallest total,
then fewest fixtures, then lowest shard id. #756 / PR #742 / Regression #487
observations supply tenths-of-second hints; unobserved inputs use 30 (3s).
Hints only balance work; absent hints never remove fixtures. Policy changes
must change POLICY. No env policy, network, repository writes, or subprocesses.
Malformed input or internal contradiction exits nonzero with no plan output.
"""

import json
import sys


SCHEMA = "ai-workflow-shard-plan"
VERSION = 1
POLICY = "observed-lpt-v1"
SHARD_COUNT = 2
PREFIX = ".github/scripts/test-"
FALLBACK_WEIGHT = 30
RUNTIME_HINTS = {
    PREFIX + "product-npm-production-session.sh": 1717,
    PREFIX + "npm-network-sources.sh": 564,
    PREFIX + "product-npm-bootstrap-preparation.sh": 346,
    PREFIX + "npm-offline-ci.sh": 304,
    PREFIX + "npm-registry-lock.sh": 267,
}


def fixture_path(path):
    if (not isinstance(path, str) or not path.startswith(PREFIX)
            or not path.endswith(".sh") or len(path) <= len(PREFIX) + 3
            or "/" in path[len(PREFIX):] or "\\" in path or "\0" in path):
        return False
    try:
        path.encode("utf-8", "strict")
    except UnicodeError:
        return False
    return True


def parse_paths(data):
    if not isinstance(data, bytes) or not data.endswith(b"\0"):
        raise ValueError
    paths = data[:-1].decode("utf-8", "strict").split("\0")
    if (not all(fixture_path(path) for path in paths)
            or len(paths) != len(set(paths)) or len(paths) < SHARD_COUNT):
        raise ValueError
    return sorted(paths)


def assign(paths):
    # Fail closed on a broken heuristic too, rather than silently changing policy.
    if (type(FALLBACK_WEIGHT) is not int or FALLBACK_WEIGHT <= 0
            or not isinstance(RUNTIME_HINTS, dict)
            or not all(fixture_path(path) and type(weight) is int and weight > 0
                       for path, weight in RUNTIME_HINTS.items())):
        raise ValueError
    weighted = [(path, RUNTIME_HINTS.get(path, FALLBACK_WEIGHT)) for path in paths]
    shards = [[] for _ in range(SHARD_COUNT)]
    totals = [0] * SHARD_COUNT
    for path, weight in sorted(weighted, key=lambda item: (-item[1], item[0])):
        index = min(range(SHARD_COUNT), key=lambda i: (totals[i], len(shards[i]), i))
        shards[index].append(path)
        totals[index] += weight
    return [sorted(shard) for shard in shards]


def plan(data):
    paths = parse_paths(data)
    shards = assign(paths)
    if (not isinstance(shards, list) or len(shards) != SHARD_COUNT
            or not all(isinstance(shard, list) and shard
                       and all(fixture_path(path) for path in shard)
                       and shard == sorted(shard) for shard in shards)):
        raise ValueError
    flattened = [path for shard in shards for path in shard]
    if len(flattened) != len(set(flattened)) or sorted(flattened) != paths:
        raise ValueError
    return dict(schema=SCHEMA, version=VERSION, policy=POLICY,
                shard_count=SHARD_COUNT,
                shards=[dict(id=index + 1, fixtures=shard)
                        for index, shard in enumerate(shards)])


def main():
    if len(sys.argv) != 1:
        print("usage: plan-ai-workflow-shards.py < fixtures.nul", file=sys.stderr)
        return 2
    try:
        output = json.dumps(plan(sys.stdin.buffer.read()), sort_keys=True,
                            ensure_ascii=True, separators=(",", ":"))
    except Exception:
        print("AI workflow shard planを確定できませんでした。", file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
