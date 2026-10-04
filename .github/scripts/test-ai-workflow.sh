#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

curl() {
  printf '%s\n' "$*" > "$MOCK_CURL_ARGS"
  cat > "$MOCK_CURL_BODY"
}
export -f curl

unset NOTIFICATION_WEBHOOK_URL
if ! bash "$repo_root/.github/scripts/notify-human.sh" 'test escalation' \
  > "$test_dir/notification-unset.out" 2> "$test_dir/notification-unset.err"; then
  echo 'Expected notification to be skipped when the webhook is not configured.' >&2
  exit 1
fi
grep -Fq 'GitHub上の停止は継続します' "$test_dir/notification-unset.err"

NOTIFICATION_WEBHOOK_URL='https://discord.invalid/api/webhooks/secret-value'
MOCK_CURL_ARGS="$test_dir/curl.args"
MOCK_CURL_BODY="$test_dir/curl.body"
export NOTIFICATION_WEBHOOK_URL MOCK_CURL_ARGS MOCK_CURL_BODY
bash "$repo_root/.github/scripts/notify-human.sh" 'test @everyone escalation' \
  > "$test_dir/notification.out" 2> "$test_dir/notification.err"
jq -e '. == {"content":"test @everyone escalation","allowed_mentions":{"parse":[]}}' "$MOCK_CURL_BODY" > /dev/null
grep -Fq -- '--header Content-Type: application/json' "$MOCK_CURL_ARGS"
grep -Fq -- '--data-binary @-' "$MOCK_CURL_ARGS"
oversized="$(printf 'x%.0s' {1..1801})"
if bash "$repo_root/.github/scripts/notify-human.sh" "$oversized" > /dev/null 2>&1; then
  echo 'Expected oversized Discord content to be rejected.' >&2
  exit 1
fi
if grep -Fq "$NOTIFICATION_WEBHOOK_URL" "$test_dir/notification.out" "$test_dir/notification.err"; then
  echo 'Webhook URL was written to notification output.' >&2
  exit 1
fi

gh() {
  if [ "$1 $2" = 'pr view' ]; then
    case "${MOCK_CASE:-valid}" in
      no-links)
        printf '%s\n' '{"number":37,"title":"Test","body":"No link","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[],"comments":[],"reviews":[],"labels":[]}'
        ;;
      invalid-branch)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"feature/untrusted","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      wrong-base)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"release","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      draft)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":true,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      human-author)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"owner"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
      app-author)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"app/dev"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[{"author":{"login":"app/review"},"state":"CHANGES_REQUESTED"}],"labels":[]}'
        ;;
      human-label)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[{"name":"human-review-required"}]}'
        ;;
      *)
        printf '%s\n' '{"number":37,"title":"Test","body":"Closes #36","url":"https://github.com/owner/repo/pull/37","author":{"login":"dev[bot]"},"baseRefName":"main","headRefName":"ai/issue-36","state":"OPEN","isDraft":false,"files":[{"path":"x","additions":1,"deletions":0}],"commits":[],"closingIssuesReferences":[{"number":36,"url":"https://github.com/owner/repo/issues/36"}],"comments":[],"reviews":[],"labels":[]}'
        ;;
    esac
  elif [ "$1" = 'api' ]; then
    if [ "${MOCK_API_FAIL:-false}" = 'true' ]; then
      return 1
    fi
    if [[ "$*" =~ /issues/([0-9]+) ]]; then
      issue_number="${BASH_REMATCH[1]}"
    else
      echo "Unexpected Issue API target: $*" >&2
      return 2
    fi
    issue_labels='[]'
    if [ "${MOCK_ISSUE_PAUSED:-false}" = 'true' ]; then
      issue_labels='[{"name":"human-review-required"}]'
    fi
    jq -cn \
      --argjson number "$issue_number" \
      --arg state "${MOCK_ISSUE_STATE:-open}" \
      --argjson labels "$issue_labels" \
      '{number: $number, title: "Closing Issue", state: $state, body: "requirements", labels: $labels}'
  elif [ "$1 $2" = 'pr diff' ]; then
    if [ "${MOCK_DIFF_FAIL:-false}" = 'true' ]; then
      return 1
    elif [[ "$*" == *'--name-only'* ]]; then
      printf '%s\n' "${MOCK_CHANGED_PATH:-x}"
    else
      echo "Unexpected PR diff invocation: $*" >&2
      return 2
    fi
  else
    echo "Unexpected gh invocation: $*" >&2
    return 2
  fi
}
export -f gh

grep -Fq 'normal_followup_reason' "$repo_root/.github/scripts/evaluate-followup-gate.sh"

regression_workflow="$repo_root/.github/workflows/ai-workflow-regression.yml"
test -f "$regression_workflow"
grep -Fxq 'name: AI Workflow Regression' "$regression_workflow"
grep -Fq 'types: [opened, synchronize, reopened]' "$regression_workflow"
grep -Fq -- "- '.github/scripts/**'" "$regression_workflow"
grep -Fq -- "- '.github/workflows/**'" "$regression_workflow"
grep -Fq -- "- '**/AGENTS.md'" "$regression_workflow"
grep -Fq -- "- '**/AGENTS.override.md'" "$regression_workflow"
grep -Fq -- "- '**/CLAUDE.md'" "$regression_workflow"
grep -Fq -- "- '**/CLAUDE.local.md'" "$regression_workflow"
grep -Fq -- "- '**/.claude/**'" "$regression_workflow"
grep -Fq -- "- '**/.codex/**'" "$regression_workflow"
grep -Fq -- "- '**/.mcp.json'" "$regression_workflow"
grep -Fq -- "- 'docs/00_requirements/01_Introduction.md'" "$regression_workflow"
grep -Fq -- "- 'docs/diagrams/README.md'" "$regression_workflow"
grep -Fq -- "- 'docs/30_operations/ai-development-workflow.md'" "$regression_workflow"
grep -A1 '^permissions:$' "$regression_workflow" | grep -Fxq '  contents: read'
grep -Fq 'group: ai-workflow-regression-${{ github.event.pull_request.number }}' "$regression_workflow"
grep -Fq 'cancel-in-progress: true' "$regression_workflow"
grep -Fq 'name: Fixtures' "$regression_workflow"
grep -Fq 'runs-on: ubuntu-latest' "$regression_workflow"
grep -Fq 'timeout-minutes: 10' "$regression_workflow"
grep -Fq 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' "$regression_workflow"
grep -Fq 'ref: ${{ github.event.pull_request.head.sha }}' "$regression_workflow"
grep -Fq 'persist-credentials: false' "$regression_workflow"
grep -Fq 'fetch-depth: 0' "$regression_workflow"
grep -Fq 'BASE_SHA: ${{ github.event.pull_request.base.sha }}' "$regression_workflow"
grep -Fq 'HEAD_SHA: ${{ github.event.pull_request.head.sha }}' "$regression_workflow"
grep -Fq 'export LC_ALL=C' "$regression_workflow"
grep -Fq 'fixtures=(.github/scripts/test-*.sh)' "$regression_workflow"
grep -Fq 'if [ "${#fixtures[@]}" -eq 0 ]; then' "$regression_workflow"
grep -Fq 'for fixture in "${fixtures[@]}"; do' "$regression_workflow"
grep -Fq 'if bash "$fixture"; then' "$regression_workflow"
if grep -Eq '^[[:space:]]+[A-Za-z-]+: write$' "$regression_workflow"; then
  echo 'AI Workflow Regression grants a write permission.' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*permissions:[[:space:]]*write-all([[:space:]]*(#.*)?)?$' "$regression_workflow"; then
  echo 'AI Workflow Regression grants write-all permission.' >&2
  exit 1
fi
if grep -Fq 'secrets.' "$regression_workflow"; then
  echo 'AI Workflow Regression passes a repository secret.' >&2
  exit 1
fi
if grep -Eq 'github\.token|^[[:space:]]+GH_TOKEN:' "$regression_workflow"; then
  echo 'AI Workflow Regression passes a repository credential.' >&2
  exit 1
fi

# #528: execute the production run block against synthetic fixtures; mutations
# must be rejected by observable coverage and exit status, not text presence.
python3 -B - "$repo_root" <<'PY'
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import textwrap

repo = Path(sys.argv[1])
workflow = (repo / '.github/workflows/ai-workflow-regression.yml').read_text()
run_block = textwrap.dedent(workflow.split('  fixtures:\n', 1)[1].split('        run: |\n', 1)[1])
subprocess.run(['bash', '-n'], input=run_block.encode(), check=True)
source = repo / '.github/scripts/select-ai-workflow-fixtures.py'
spec = importlib.util.spec_from_file_location('regression_policy', source)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def check_trigger_contract(text, patterns):
    # Strictly parse the current literal-list YAML shape, without accepting new syntax.
    trigger = re.search(r'^on:\n  pull_request:\n    types: \[[^\n]+\]\n    paths:\n'
                        r'((?:      - [^\n]+\n)+)\n*(?=^\S|\Z)', text, re.MULTILINE)
    assert trigger, 'unsupported pull_request.paths shape'
    parsed = []
    for line in trigger[1].splitlines():
        item = re.fullmatch(r"      - '([^']+)'", line)
        assert item, 'unsupported trigger pattern declaration'
        parsed.append(item[1])
    assert len(parsed) == len(set(parsed))
    assert len(patterns) == len(set(patterns))
    assert set(parsed) == set(patterns), 'workflow/selector trigger drift'
    policy.trigger_rules(patterns)  # Unsupported matcher syntax must fail even if synced.


check_trigger_contract(workflow, policy.TRIGGER_PATTERNS)
for changed_workflow, patterns in (
        (workflow.replace("      - '**/CLAUDE.md'\n", ''), policy.TRIGGER_PATTERNS),
        (workflow.replace("      - '**/CLAUDE.md'", "      - '**/NEW.md'"), policy.TRIGGER_PATTERNS),
        (workflow.replace("      - '**/CLAUDE.md'", "      - '**/CLAUDE.md'\n      - 'README.md'"),
         policy.TRIGGER_PATTERNS),
        (workflow.replace("'**/CLAUDE.md'", "'**/*.py'"),
         tuple('**/*.py' if p == '**/CLAUDE.md' else p for p in policy.TRIGGER_PATTERNS)),
        (workflow.replace("      - '**/CLAUDE.md'", '      - "**/CLAUDE.md"'),
         policy.TRIGGER_PATTERNS),
        (workflow.replace('\npermissions:', "\n      - 'README.md'\n\npermissions:"),
         policy.TRIGGER_PATTERNS)):
    try:
        check_trigger_contract(changed_workflow, patterns)
    except (AssertionError, ValueError):
        pass
    else:
        raise AssertionError('trigger drift/unsupported pattern accepted')

prefix = '.github/scripts/'
actual = sorted(prefix + p.name for p in (repo / prefix).glob('test-*.sh'))
assert actual == sorted(p for fixtures in policy.INVENTORY.values() for p in fixtures)
assert len(actual) == 79
common_guard = prefix + 'test-production-unreachable.sh'
local_path = prefix + 'deepinfra-usage-ledger.py'
selected = sorted(policy.INVENTORY['deepinfra'] + policy.INVENTORY['common'])
base, head, merge = 'a' * 40, 'b' * 40, 'c' * 40
record = dict(schema='ai-workflow-fixture-selection', version=1, mode='selected',
              reason='known_paths', suites=['common', 'deepinfra'], fixtures=selected)


def encode(paths):
    return b''.join(p.encode() + b'\0' for p in paths)


with tempfile.TemporaryDirectory() as temporary:
    tmp = Path(temporary)
    workspace = tmp / 'workspace'
    scripts = workspace / prefix
    scripts.mkdir(parents=True)
    bin_dir = tmp / 'bin'
    bin_dir.mkdir()
    trusted = tmp / 'base-selector.py'
    changed_file, git_log = tmp / 'changed.nul', tmp / 'git.log'
    summary_file, execution_log = tmp / 'summary', tmp / 'executed'
    # Head policy is deliberately executable and hostile. It must never run.
    (scripts / source.name).write_text("raise RuntimeError('HEAD POLICY EXECUTED')\n")
    mock_git = bin_dir / 'git'
    mock_git.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['GIT_LOG'], 'a') as output:
    output.write(json.dumps(args) + '\\n')
base, head, merge = 'a' * 40, 'b' * 40, 'c' * 40
if args == ['rev-parse', 'HEAD']:
    print(os.environ.get('MOCK_HEAD', head))
elif args == ['rev-parse', '--verify', base + '^{commit}']:
    if os.environ.get('GIT_FAILURE') == 'base': sys.exit(1)
    print(os.environ.get('MOCK_BASE', base))
elif args == ['merge-base', base, head]:
    if os.environ.get('GIT_FAILURE') == 'merge-base': sys.exit(1)
    print(os.environ.get('MOCK_MERGE_BASE', merge))
elif args == ['diff', '--no-renames', '--name-only', '-z', merge, head]:
    if os.environ.get('GIT_FAILURE') == 'diff': sys.exit(1)
    sys.stdout.buffer.write(pathlib.Path(os.environ['CHANGED_FILE']).read_bytes())
elif args == ['diff', '--no-renames', '--name-only', '-z', base, head]:
    # Diverged base has a trigger-domain unknown path absent from the PR changes.
    sys.stdout.buffer.write(pathlib.Path(os.environ['CHANGED_FILE']).read_bytes()
                            + b'.github/scripts/base-only.py\\0')
elif args == ['show', base + ':.github/scripts/select-ai-workflow-fixtures.py']:
    if os.environ.get('GIT_FAILURE') == 'show': sys.exit(1)
    sys.stdout.buffer.write(pathlib.Path(os.environ['TRUSTED_SELECTOR']).read_bytes())
else:
    sys.exit(90)
''')
    mock_git.chmod(0o755)
    env = {**os.environ, 'PATH': str(bin_dir) + ':' + os.environ['PATH'],
           'BASE_SHA': base, 'HEAD_SHA': head, 'GITHUB_STEP_SUMMARY': str(summary_file),
           'EXECUTION_LOG': str(execution_log), 'GIT_LOG': str(git_log),
           'CHANGED_FILE': str(changed_file), 'TRUSTED_SELECTOR': str(trusted)}

    def fixture(path, fail=False):
        (workspace / path).write_text(
            f'printf "%s\\0" {shlex.quote(path)} >> "$EXECUTION_LOG"\n'
            + ('exit 7\n' if fail else 'exit 0\n'))

    def reset():
        for path in scripts.glob('test-*.sh'):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        for path in actual:
            fixture(path)
        trusted.write_bytes(source.read_bytes())
        changed_file.write_bytes(encode([local_path]))

    def run(expected, mode, reason, status=0, block=run_block, overrides=None):
        for path in (summary_file, execution_log, git_log):
            path.unlink(missing_ok=True)
        result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', block], cwd=workspace,
                                env={**env, **(overrides or {})}, capture_output=True)
        executed = (execution_log.read_bytes().split(b'\0')[:-1] if execution_log.exists() else [])
        executed = [path.decode() for path in executed]
        summary = summary_file.read_text()
        assert (result.returncode == 0) == (status == 0), (reason, result.stderr, summary)
        assert executed == expected, (reason, executed, expected)
        assert f'- mode: {mode}\n' in summary and f'- reason: {reason}\n' in summary, summary
        assert f'- full count: {len(list(scripts.glob("test-*.sh")))}\n' in summary
        assert f'結果: **{"PASS" if status == 0 else "FAIL"}**' in summary
        assert len(summary) < 1024 and '| Fixture |' not in summary
        assert not any(path in summary for path in actual)
        return [json.loads(line) for line in git_log.read_text().splitlines()] if git_log.exists() else []

    reset()
    calls = run(selected, 'selected', 'known_paths')
    assert calls == [['rev-parse', 'HEAD'], ['rev-parse', '--verify', base + '^{commit}'],
                     ['merge-base', base, head],
                     ['diff', '--no-renames', '--name-only', '-z', merge, head],
                     ['show', base + ':' + prefix + source.name]]
    assert common_guard in selected and len(selected) < len(actual)
    # A regression to two-dot semantics must be caught by the execution oracle.
    try:
        run(selected, 'selected', 'known_paths',
            block=run_block.replace("'-z', merge_base, head)", "'-z', base, head)"))
    except AssertionError:
        pass
    else:
        raise AssertionError('base-only impact accepted')
    changed_file.write_bytes(encode(['README.md', local_path]))
    run(selected, 'selected', 'known_paths')
    product_selected = sorted(policy.INVENTORY['product-npm'] + policy.INVENTORY['common'])
    changed_file.write_bytes(encode(['.github/README.md', prefix + 'product-npm-orchestrator.py',
                                    prefix + 'test-product-npm-post-workload.sh']))
    assert len(product_selected) == 21
    run(product_selected, 'selected', 'known_paths')
    # Changed fixture is required independently of the helper mapping.
    changed_file.write_bytes(encode([prefix + 'test-deepinfra-checkpoint.sh']))
    run(selected, 'selected', 'known_paths')
    fixture(selected[0], fail=True)
    run(selected, 'selected', 'known_paths', status=1)  # includes later fixtures after failure
    reset()
    for paths, reason in [(['README.md'], 'empty_selection'),
                          ([prefix + 'new-helper.py'], 'unmapped_path'),
                          (['.github/workflows/new.yml'], 'unmapped_path'),
                          (['src/CLAUDE.md'], 'unmapped_path'),
                          ([prefix + source.name], 'global_boundary'),
                          ([prefix + 'test-select-ai-workflow-fixtures.sh'], 'global_boundary'),
                          (['.github/workflows/ai-workflow-regression.yml'], 'global_boundary'),
                          ([local_path, prefix + 'space name\nline.py'], 'unmapped_path'),
                          # Rename old/new boundary: deleted unknown path cannot be omitted.
                          ([prefix + 'unknown-old.py', local_path], 'unmapped_path'),
                          ([local_path, prefix + 'unknown-new.py'], 'unmapped_path')]:
        changed_file.write_bytes(encode(paths))
        run(actual, 'full', reason)
    # Verify exact bytes at the trusted selector boundary, beyond full fallback.
    unusual = encode([local_path, prefix + 'space name\nline.py'])
    changed_file.write_bytes(unusual)
    trusted.write_text('import sys\nassert sys.stdin.buffer.read() == ' + repr(unusual)
                       + '\nprint(' + repr(json.dumps(record)) + ')\n')
    run(selected, 'selected', 'known_paths')
    reset()
    changed_file.write_bytes(b'')
    run(actual, 'full', 'empty_diff')
    changed_file.write_bytes(b'bad-framing')
    run(actual, 'full', 'malformed_input')
    reset()
    for overrides, reason in [({'BASE_SHA': 'invalid'}, 'sha_invalid'),
                              ({'HEAD_SHA': head.upper()}, 'sha_invalid'),
                              ({'MOCK_HEAD': base}, 'head_mismatch'),
                              ({'MOCK_BASE': head}, 'base_unavailable'),
                              ({'GIT_FAILURE': 'base'}, 'base_unavailable'),
                              ({'GIT_FAILURE': 'merge-base'}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': ''}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': 'invalid'}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': merge.upper()}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': merge + '\n' + base}, 'merge_base_failed'),
                              ({'GIT_FAILURE': 'diff'}, 'diff_failed'),
                              ({'GIT_FAILURE': 'show'}, 'base_selector_unavailable')]:
        run(actual, 'full', reason, overrides=overrides)
    trusted.write_text('raise SystemExit(3)\n')
    run(actual, 'full', 'selector_failed')
    # Full caller ignores an otherwise well-formed selector's incomplete full list.
    full_record = {**record, 'mode': 'full', 'reason': 'unmapped_path', 'fixtures': selected[:1]}
    trusted.write_text('print(' + repr(json.dumps(full_record)) + ')\n')
    run(actual, 'full', 'unmapped_path')
    for key, value in [('schema', 'unknown'), ('version', True), ('mode', 'unknown'),
                       ('reason', 'untrusted\ntext'), ('suites', ['unknown']),
                       ('suites', ['common', 'common']), ('fixtures', 'not-list'),
                       ('fixtures', selected + selected[:1]),
                       ('fixtures', [prefix + '../test-escape.sh']),
                       ('fixtures', ['outside/test-escape.sh'])]:
        broken = {**record, key: value}
        trusted.write_text('print(' + repr(json.dumps(broken)) + ')\n')
        run(actual, 'full', 'selector_record_invalid')
    for payload in ('invalid json', '[]', json.dumps(record) + '\n{}',
                    json.dumps(record)[:-1] + ',"mode":"selected"}'):
        trusted.write_text('print(' + repr(payload) + ')\n')
        run(actual, 'full', 'selector_record_invalid')
    missing_guard = {**record, 'fixtures': [p for p in selected if p != common_guard]}
    trusted.write_text('print(' + repr(json.dumps(missing_guard)) + ')\n')
    run(actual, 'full', 'common_guard_missing')
    for paths, reason in [([], 'no_fixtures'),
                          (selected + [prefix + 'test-missing.sh'], 'selected_fixture_missing')]:
        trusted.write_text('print(' + repr(json.dumps({**record, 'fixtures': paths})) + ')\n')
        run([], 'full', reason, status=1)
    reset()
    changed_file.write_bytes(encode([prefix + 'unknown.py']))
    fixture(actual[-1], fail=True)
    run(actual, 'full', 'unmapped_path', status=1)
    reset()
    unusual_fixture = prefix + 'test-space name\nline.sh'
    fixture(unusual_fixture)
    changed_file.write_bytes(encode([unusual_fixture]))
    run(sorted(actual + [unusual_fixture]), 'full', 'inventory_mismatch')
    (workspace / unusual_fixture).unlink()
    reset()
    extra = prefix + 'test-new.sh'
    fixture(extra)
    run(sorted(actual + [extra]), 'full', 'inventory_mismatch')
    (workspace / extra).unlink()
    (workspace / actual[0]).unlink()
    run(actual[1:], 'full', 'inventory_mismatch')
    reset()
    for kind in ('directory', 'symlink', 'fifo'):
        bad = workspace / selected[0]
        bad.unlink()
        if kind == 'directory': bad.mkdir()
        elif kind == 'symlink': bad.symlink_to(workspace / selected[1])
        else: os.mkfifo(bad)
        run([], 'full', 'invalid_fixture_type', status=1)
        reset()
    for path in actual:
        (workspace / path).unlink()
    run([], 'full', 'no_fixtures', status=1)
    reset()
    # Each production mutation must cause this same behavior oracle to reject it.
    for replacement in ('# if bash "$fixture"; then', 'if true; then',
                        'if bash "$fixture" || true; then'):
        mutated = run_block.replace('if bash "$fixture"; then', replacement)
        fixture(selected[0], fail=True)
        try:
            run(selected, 'selected', 'known_paths', status=1, block=mutated)
        except AssertionError:
            pass
        else:
            raise AssertionError('broken execution/failure propagation accepted')
    try:
        run(selected, 'selected', 'known_paths', status=1,
            block=run_block.replace('failed=1', 'failed=0'))
    except AssertionError:
        pass
    else:
        raise AssertionError('swallowed fixture failure accepted')
print('AI Workflow Regression: trusted-base selected/full behavior and #528 mutations passed.')
PY

grep -Fq 'outputs.execution_file' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq 'BASE_REF: ${{ steps.review-source.outputs.base_ref }}' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq 'git/ref/heads/${BASE_REF}' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq '^[0-9a-f]{40}$' "$repo_root/.github/workflows/claude-review.yml"
grep -Fq 'steps.build-review-context.outputs.base_sha' "$repo_root/.github/workflows/claude-review.yml"
if grep -Fq 'github.event.pull_request.base.sha' "$repo_root/.github/workflows/claude-review.yml"; then
  echo 'Workflow still uses the stale event base SHA.' >&2
  exit 1
fi
if grep -Eq 'attempt (2|3) of 3' "$repo_root/.github/workflows/claude-review.yml"; then
  echo 'Expected duplicate full-review retries to be removed.' >&2
  exit 1
fi

MOCK_CASE=valid
export MOCK_CASE
bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 traceability
bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev

MOCK_CASE=no-links
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 traceability; then
  echo 'Expected traceability failure without a closing Issue.' >&2
  exit 1
fi

MOCK_CASE=invalid-branch
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a non-AI branch.' >&2
  exit 1
fi

MOCK_CASE=human-author
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a human-authored AI-named branch.' >&2
  exit 1
fi

MOCK_CASE=app-author
export MOCK_CASE
bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev

MOCK_CASE=wrong-base
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a PR not targeting main.' >&2
  exit 1
fi

MOCK_CASE=draft
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a draft PR.' >&2
  exit 1
fi

MOCK_CASE=human-label
export MOCK_CASE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure while human-review-required is present.' >&2
  exit 1
fi

MOCK_CASE=valid
MOCK_CHANGED_PATH=src/CLAUDE.md
export MOCK_CASE MOCK_CHANGED_PATH
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure for a nested AI instruction file.' >&2
  exit 1
fi
unset MOCK_CHANGED_PATH

MOCK_CASE=valid
MOCK_DIFF_FAIL=true
export MOCK_CASE MOCK_DIFF_FAIL
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure when protected-path lookup fails.' >&2
  exit 1
fi
unset MOCK_DIFF_FAIL

MOCK_CASE=valid
MOCK_ISSUE_PAUSED=true
export MOCK_CASE MOCK_ISSUE_PAUSED
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 merge dev; then
  echo 'Expected merge failure while a closing Issue is paused.' >&2
  exit 1
fi
unset MOCK_ISSUE_PAUSED

MOCK_CASE=valid
MOCK_ISSUE_STATE=closed
export MOCK_CASE MOCK_ISSUE_STATE
if bash "$repo_root/.github/scripts/verify-pr-gates.sh" owner/repo 37 traceability; then
  echo 'Expected traceability failure for a closed Issue.' >&2
  exit 1
fi
unset MOCK_ISSUE_STATE

echo 'AI workflow fixture tests passed.'
