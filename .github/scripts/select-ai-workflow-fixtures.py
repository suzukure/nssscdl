#!/usr/bin/env python3
"""Read-only coarse suite selector. Trusted base policy; no fixture execution."""

import json
import os
from pathlib import Path
import sys


SCHEMA = "ai-workflow-fixture-selection"
VERSION = 1
SCRIPTS = ".github/scripts/"
SELF = SCRIPTS + "select-ai-workflow-fixtures.py"
SELF_TEST = SCRIPTS + "test-select-ai-workflow-fixtures.sh"

# Trusted base copy of workflow on.pull_request.paths; machine-synced by common fixture.
TRIGGER_PATTERNS = (
    ".github/scripts/**", ".github/workflows/**",
    "**/AGENTS.md", "**/AGENTS.override.md", "**/CLAUDE.md", "**/CLAUDE.local.md",
    "**/.claude/**", "**/.codex/**", "**/.mcp.json",
    "docs/00_requirements/01_Introduction.md", "docs/diagrams/README.md",
    "docs/30_operations/ai-development-workflow.md",
)

# #695 checkpoint at 275f4ba: exact 68-fixture primary inventory.
# Names are literal; selection never infers registration from filename prefixes.
BASELINE = {
    "product-npm": (
        "npm-filesystem-sources", "npm-initial-lock", "npm-lifecycle-scripts",
        "npm-locked-preparation", "npm-network-sources", "npm-offline-ci",
        "npm-registry-boundary", "npm-registry-lock", "prepare-product-npm",
        "product-npm-bootstrap", "product-npm-orchestrator",
    ),
    "resume-human-pause": (
        "ai-resume-review-consumer-workflow", "ai-resume-review-producer",
        "build-ai-resume-github-context", "build-ai-resume-prepare-context",
        "consume-ai-resume-review", "create-human-pause",
        "decompose-human-pause-record-graph", "derive-human-pause-pre-resume-state",
        "evaluate-current-head-validation", "human-pause-record",
        "inspect-ai-resume-target", "list-human-pause-records",
        "parse-ai-resume-command", "prepare-ai-resume-review-consumer",
        "prepare-ai-resume-review-recovery", "prepare-ai-resume-validate-consumer",
        "prepare-ai-resume-validate-cycle", "prepare-ai-resume-validate-pause-record",
        "prepare-ai-resume-validate-recovery", "prepare-ai-resume",
        "reconcile-human-pause-active-pause",
        "reconcile-human-pause-resume-acceptance-active-pause",
        "reconcile-human-pause-resume-acceptance", "recover-ai-resume-review",
        "resolve-ai-resume-target", "validate-human-pause-record-graph",
    ),
    "claude": (
        "build-review-context", "classify-claude-human-escalation",
        "claude-auto-rereview-failure-handler", "claude-auto-rereview-workflow",
        "claude-followup-target", "claude-review-cost-guard",
        "claude-review-failure-handler", "claude-review-workflow",
        "evaluate-claude-auto-rereview-entry-gate",
        "prepare-claude-auto-rereview-consumer", "prepare-claude-followup-producer",
    ),
    "deepinfra": (
        "deepinfra-budget-finalize", "deepinfra-checkpoint", "deepinfra-diagnostic-b",
        "deepinfra-investigator", "deepinfra-no-tool-retry",
        "deepinfra-review-benchmark", "deepinfra-usage-ledger", "deepinfra-usage",
        "summarize-deepinfra-usage",
    ),
    "ai-developer-codex": (
        "ai-developer-branch-freshness", "ai-developer-diff-guard",
        "ai-developer-workflow", "codex-network-boundary", "codex-node-hardening",
        "consume-ai-resume-develop", "evaluate-codex-diff-gate",
    ),
    "failure-evidence": ("failure-evidence-collector", "failure-evidence-packet"),
    "common": ("ai-entry-gate-metadata", "ai-workflow"),
}
BASELINE_COUNTS = {
    "product-npm": 11, "resume-human-pause": 26, "claude": 11, "deepinfra": 9,
    "ai-developer-codex": 7, "failure-evidence": 2, "common": 2,
}
# Explicit extensions: #692 / #684, selector, #701 common guard, and #756 shard planner.
EXTENSIONS = {
    "product-npm": ("product-npm-bootstrap-preparation", "product-npm-post-workload",
                    "product-npm-production-session", "product-runtime-staging", "trusted-runtime-supply"),
    "ai-developer-codex": ("select-codex-issue-model", "extract-codex-exec-usage",
                           "supervise-codex-exec-stream", "validate-codex-usage-identity",
                           "validate-codex-usage-stream", "build-codex-usage-evidence",
                           "systemd-transient-lifecycle", "select-codex-usage-journal"),
    "common": ("select-ai-workflow-fixtures", "production-unreachable", "plan-ai-workflow-shards"),
}
INVENTORY = {
    suite: tuple(SCRIPTS + "test-" + name + ".sh"
                 for name in names + EXTENSIONS.get(suite, ()))
    for suite, names in BASELINE.items()
}

# Coarse exact-path mapping. Unlisted trigger paths require full regression.
# Tuple rows preserve duplicate-path contradictions for validation.
PATH_SUITES = (
    (SCRIPTS + "plan-ai-workflow-shards.py", ("common",)),
    (SCRIPTS + "build-failure-evidence-packet.py", ("failure-evidence",)),
    (SCRIPTS + "collect-failure-evidence.py", ("failure-evidence",)),
    (SCRIPTS + "fixtures/failure-evidence-654.json", ("failure-evidence",)),
    (SCRIPTS + "fixtures/failure-evidence-654-issue.md", ("failure-evidence",)),
    (SCRIPTS + "deepinfra-diagnostic-b.py", ("deepinfra",)),
    (SCRIPTS + "deepinfra-investigator.py", ("deepinfra",)),
    (SCRIPTS + "deepinfra-review-benchmark.py", ("deepinfra",)),
    (SCRIPTS + "deepinfra-usage-ledger.py", ("deepinfra",)),
    (SCRIPTS + "summarize-deepinfra-usage.py", ("deepinfra",)),
    (SCRIPTS + "prepare-product-npm.py", ("product-npm",)),
    (SCRIPTS + "product-npm-orchestrator.py", ("product-npm",)),
    (SCRIPTS + "product-npm-session-runtime.py", ("product-npm",)),
    (SCRIPTS + "product-npm-session-probe.js", ("product-npm",)),
    (SCRIPTS + "product-runtime-staging.py", ("product-npm",)),
    (SCRIPTS + "trusted-runtime-supply.py", ("product-npm",)),
    (SCRIPTS + "trusted-main-runtime-supply-proof.py", ("product-npm",)),
    (SCRIPTS + "npm-locked-preparation.py", ("product-npm",)),
    (SCRIPTS + "npm-registry-proxy.py", ("product-npm",)),
    (SCRIPTS + "npm-registry-boundary-runtime.py", ("product-npm",)),
    (SCRIPTS + "npm-network-source-probe.py", ("product-npm",)),
    (SCRIPTS + "npm-filesystem-boundary-runtime.py", ("product-npm",)),
    (SCRIPTS + "npm-filesystem-source-probe.js", ("product-npm",)),
    (SCRIPTS + "npm-lifecycle-boundary-runtime.py", ("product-npm",)),
    (SCRIPTS + "npm-lifecycle-script-probe.js", ("product-npm",)),
    (SCRIPTS + "npm-initial-lock-runtime.py", ("product-npm",)),
    (SCRIPTS + "npm-initial-lock-probe.js", ("product-npm",)),
    (SCRIPTS + "npm-registry-lock-runtime.py", ("product-npm",)),
    (SCRIPTS + "npm-registry-lock-probe.js", ("product-npm",)),
    (SCRIPTS + "npm-registry-lock-adapter.js", ("product-npm",)),
    (SCRIPTS + "npm-offline-ci-runtime.py", ("product-npm",)),
    (SCRIPTS + "npm-offline-ci-probe.js", ("product-npm",)),
    (SCRIPTS + "evaluate-codex-diff-gate.sh", ("ai-developer-codex", "claude")),
    (SCRIPTS + "classify-ai-developer-decision-marker.sh", ("ai-developer-codex",)),
    (SCRIPTS + "select-codex-issue-model.py", ("ai-developer-codex",)),
    (SCRIPTS + "extract-codex-exec-usage.py", ("ai-developer-codex",)),
    (SCRIPTS + "supervise-codex-exec-stream.py", ("ai-developer-codex",)),
    (SCRIPTS + "validate-codex-usage-identity.py", ("ai-developer-codex",)),
    (SCRIPTS + "validate-codex-usage-stream.py", ("ai-developer-codex",)),
    (SCRIPTS + "build-codex-usage-evidence.py", ("ai-developer-codex",)),
    (SCRIPTS + "systemd-transient-lifecycle.py", ("ai-developer-codex",)),
    (SCRIPTS + "select-codex-usage-journal.py", ("ai-developer-codex",)),
    (SCRIPTS + "codex-issue-model-policy.json", ("ai-developer-codex",)),
    (SCRIPTS + "parse-ai-resume-command.sh", ("resume-human-pause",)),
    (SCRIPTS + "classify-claude-human-escalation.sh", ("claude",)),
    (SCRIPTS + "classify-claude-review-risk.sh", ("claude",)),
    (SCRIPTS + "classify-claude-review-execution.sh", ("claude",)),
    (SCRIPTS + "build-review-context.sh", ("claude", "ai-developer-codex")),
    (SCRIPTS + "codex-network-boundary.py", ("ai-developer-codex", "product-npm")),
    (SCRIPTS + "build-development-context.py", ("ai-developer-codex", "failure-evidence")),
    # Shared pause source/contract is consumed by developer and Claude workflows.
    *((SCRIPTS + name + ".sh", ("resume-human-pause", "ai-developer-codex", "claude"))
      for name in (
          "apply-human-pause", "create-human-pause", "human-pause-record",
          "list-human-pause-records", "validate-human-pause-record-graph",
          "decompose-human-pause-record-graph", "derive-human-pause-pre-resume-state",
          "reconcile-human-pause-resume-acceptance", "reconcile-human-pause-active-pause",
          "format-human-pause-notification", "notify-human",
      )),
    # Regression caller executes this policy from the trusted event base commit.
    # Product npm and failure-evidence dormant guards scan every workflow too.
    (".github/workflows/claude-review.yml",
     ("claude", "resume-human-pause", "deepinfra", "ai-developer-codex",
      "product-npm", "failure-evidence")),
)
FULL_PATHS = frozenset((SELF, SELF_TEST, ".github/workflows/ai-workflow-regression.yml"))


def valid_path(path):
    """Canonical repository-relative POSIX path, without normalization or expansion."""
    if not isinstance(path, str) or not path or "\\" in path or "\0" in path:
        return False
    try:
        path.encode("utf-8", "strict")
    except UnicodeError:
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def parse_paths(data):
    """Exact git --name-only -z bytes; no newline splitting, quoting, or shell."""
    if not isinstance(data, bytes) or (data and not data.endswith(b"\0")):
        raise ValueError
    paths = [] if not data else data[:-1].decode("utf-8", "strict").split("\0")
    if not all(valid_path(path) for path in paths):
        raise ValueError
    return sorted(set(paths))


def trigger_rules(patterns):
    """Support only literal prefix/basename/directory/exact patterns; reject new syntax."""
    if not isinstance(patterns, (tuple, list)) or not patterns:
        raise ValueError
    rules = []
    for pattern in patterns:
        if not isinstance(pattern, str):
            raise ValueError
        if pattern.startswith("**/") and pattern.endswith("/**"):
            kind, value = "directory", pattern[3:-3]
        elif pattern.startswith("**/"):
            kind, value = "basename", pattern[3:]
        elif pattern.endswith("/**"):
            kind, value = "prefix", pattern[:-3]
        else:
            kind, value = "exact", pattern
        if (not valid_path(value) or any(char in value for char in "*?[]!+")
                or (kind in ("directory", "basename") and "/" in value)):
            raise ValueError
        rules.append((kind, value))
    return rules


def trigger_match(path, rules):
    parts = path.split("/")
    return any((kind == "prefix" and path.startswith(value + "/"))
               or (kind == "basename" and parts[-1] == value)
               or (kind == "directory" and value in parts[:-1])
               or (kind == "exact" and path == value)
               for kind, value in rules)


def mappings():
    """Validate inventory and mapping before any selected result is allowed."""
    if set(BASELINE) != set(BASELINE_COUNTS) or set(INVENTORY) != set(BASELINE):
        raise ValueError
    if any(len(BASELINE[s]) != n for s, n in BASELINE_COUNTS.items()):
        raise ValueError
    if not set(EXTENSIONS) <= set(INVENTORY):
        raise ValueError
    owners = {}
    for suite, fixtures in INVENTORY.items():
        expected = tuple(SCRIPTS + "test-" + name + ".sh"
                         for name in BASELINE[suite] + EXTENSIONS.get(suite, ()))
        if not fixtures or fixtures != expected:
            raise ValueError
        for path in fixtures:
            if (not valid_path(path) or not path.startswith(SCRIPTS + "test-")
                    or not path.endswith(".sh") or path in owners):
                raise ValueError
            owners[path] = suite
    paths = {}
    for path, suites in PATH_SUITES:
        if (not valid_path(path) or path in paths or path in owners or path in FULL_PATHS
                or not suites or len(set(suites)) != len(suites)
                or not set(suites) <= set(INVENTORY)):
            raise ValueError
        paths[path] = set(suites)
    return owners, paths


def record(mode, reason, suites, fixtures):
    return dict(schema=SCHEMA, version=VERSION, mode=mode, reason=reason,
                suites=sorted(set(suites)), fixtures=sorted(set(fixtures)))


def select(repo_root, changed_paths_nul):
    """Read local inventory only; return a deterministic fail-closed decision."""
    # scandir matches the workflow's non-recursive shell glob, including bad types.
    # Unreadable discovery cannot safely supply an executable full fixture set.
    try:
        with os.scandir(Path(repo_root) / ".github/scripts") as entries:
            discovered = sorted((entry.name, entry.is_file(follow_symlinks=False))
                                for entry in entries
                                if entry.name.startswith("test-") and entry.name.endswith(".sh"))
        actual = [SCRIPTS + name for name, _ in discovered]
        if not all(valid_path(path) for path in actual):
            raise ValueError
    except Exception:
        return record("full", "inventory_unavailable", (), ())

    def full(reason):
        return record("full", reason, BASELINE_COUNTS, actual)

    try:
        owners, paths = mappings()
        if set(owners) != set(actual) or not all(is_file for _, is_file in discovered):
            return full("inventory_mismatch")
        try:
            changed = parse_paths(changed_paths_nul)
        except (ValueError, UnicodeError):
            return full("malformed_input")
        rules = trigger_rules(TRIGGER_PATTERNS)
        changed = [path for path in changed if trigger_match(path, rules)]
        if not changed:
            return full("empty_selection")
        if any(path in FULL_PATHS for path in changed):
            return full("global_boundary")
        if any(path not in owners and path not in paths for path in changed):
            return full("unmapped_path")
        suites = {"common"}
        for path in changed:
            suites.update((owners[path],) if path in owners else paths[path])
        fixtures = {path for suite in suites for path in INVENTORY[suite]}
        # Preserve changed fixture inclusion independently of suite selection.
        fixtures.update(path for path in changed if path in owners)
        if not fixtures:
            return full("empty_selection")
        return record("selected", "known_paths", suites, fixtures)
    except ValueError:
        return full("mapping_conflict")
    except Exception:
        return full("selector_error")


def main():
    # Deliberately avoid argparse reflecting untrusted arguments in errors.
    if len(sys.argv) != 3 or sys.argv[1] != "--repo-root":
        print("usage: select-ai-workflow-fixtures.py --repo-root ROOT < paths.nul", file=sys.stderr)
        return 2
    try:
        result = select(sys.argv[2], sys.stdin.buffer.read())
    except Exception:
        result = select(sys.argv[2], None)
    print(json.dumps(result, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
    # Full is a valid decision; unavailable/empty discovery must stop the caller.
    return 0 if result["fixtures"] else 1


if __name__ == "__main__":
    sys.exit(main())
