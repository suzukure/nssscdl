"""Pure, production-unreachable usage evidence identity validation (#780).

Schema validation does not establish trusted authority. A future caller owns
identity acquisition; this module has no CLI, I/O, selection or stream handling.
"""

import json
import re


SCHEMA = "codex-usage-evidence-identity"
VERSION = 1
REPOSITORY = "suzukure/nssscdl"
MAX_IDENTITY_BYTES = 4096
MAX_INTEGER = 2**53 - 1
FIELDS = ("schema", "version", "repository", "run_id", "run_attempt", "issue_number",
          "job", "pr_number", "base_sha", "selected_model", "cli_version",
          "reasoning_effort", "invocation_mode")
JOBS = ("develop-from-issue", "respond-to-claude")


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


def positive_integer(value):
    require(type(value) is int and 1 <= value <= MAX_INTEGER)


def _validate(identity_bytes):
    require(type(identity_bytes) is bytes and 0 < len(identity_bytes) <= MAX_IDENTITY_BYTES)
    identity = json.loads(identity_bytes.decode("utf-8", "strict"),
                          object_pairs_hook=unique_object, parse_constant=reject_constant)
    require(type(identity) is dict and set(identity) == set(FIELDS))
    require(identity["schema"] == SCHEMA and identity["repository"] == REPOSITORY
            and type(identity["version"]) is int and identity["version"] == VERSION)
    for key in ("run_id", "run_attempt", "issue_number"):
        positive_integer(identity[key])
    if identity["pr_number"] is not None:
        positive_integer(identity["pr_number"])
    require(identity["job"] in JOBS)
    for key, pattern in (
            ("base_sha", r"[0-9a-f]{40}"),
            ("selected_model", r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"),
            ("cli_version", r"[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}")):
        require(type(identity[key]) is str and re.fullmatch(pattern, identity[key]))
    require(identity["reasoning_effort"] == "medium"
            and identity["invocation_mode"] == "fresh_exec")
    return dict(identity)


def validate_identity(identity_bytes):
    """Strict single JSON object bytes -> new validated dict; never reflect input."""
    try:
        return _validate(identity_bytes)
    except (ValueError, TypeError, RecursionError, OverflowError):
        pass
    # Raise outside the handler so parser errors/raw input are not chained.
    raise ValueError("invalid_identity") from None
