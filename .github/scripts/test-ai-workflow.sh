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
import ast
import base64
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
jobs = dict(re.findall(r'^  (\w+):\n(.*?)(?=^  \w+:\n|\Z)', workflow.split('jobs:\n', 1)[1], re.MULTILINE | re.DOTALL))
run_block = textwrap.dedent(jobs['fixtures'].split('        run: |\n', 1)[1])
validator = textwrap.dedent(workflow.split('  EXECUTION_PLAN_VALIDATOR: |\n', 1)[1].split('\njobs:', 1)[0])
worker_blocks = {str(i): textwrap.dedent(jobs[f'shard_{i}'].split('        run: |\n', 1)[1]) for i in (1, 2)}
terminal_block = textwrap.dedent(jobs['regression_result'].split('        run: |\n', 1)[1])
subprocess.run(['bash', '-n'], input=run_block.encode(), check=True)
source = repo / '.github/scripts/select-ai-workflow-fixtures.py'
planner_source = repo / '.github/scripts/plan-ai-workflow-shards.py'
spec = importlib.util.spec_from_file_location('regression_policy', source)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
spec = importlib.util.spec_from_file_location('regression_planner', planner_source)
planner_policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner_policy)
# Exact parallel topology, secretless worker checkout and bounded terminal.
assert list(jobs) == ['fixtures', 'shard_1', 'shard_2', 'regression_result']
assert not re.search(r'^\s*(strategy|matrix|max-parallel):', workflow, re.MULTILINE)
condition = "needs.fixtures.result == 'success' && needs.fixtures.outputs.routing_mode == 'full'"


def worker_topology(worker):
    # A normal condition retains Actions' implicit success() cancellation gate.
    assert re.findall(r'^    needs: (.*)$', worker, re.MULTILINE) == ['[fixtures]']
    assert re.findall(r'^    if: (.*)$', worker, re.MULTILINE) == [condition]


for i in (1, 2):
    worker = jobs[f'shard_{i}']
    worker_topology(worker)
    assert f'    name: Fixture shard {i}\n' in worker
    assert f"          SHARD_ID: '{i}'\n" in worker
    assert '          PRODUCER_RESULT: ${{ needs.fixtures.result }}\n' in worker
    assert '          EXECUTION_PLAN_B64: ${{ needs.fixtures.outputs.execution_plan_b64 }}\n' in worker
    assert '          ref: ${{ github.event.pull_request.head.sha }}\n' in worker
    assert '          persist-credentials: false\n' in worker
    assert '    timeout-minutes: 10\n' in worker
    for mutated in (worker.replace('needs: [fixtures]', 'needs: [fixtures, shard_1]'),
                    worker.replace('if: ' + condition, 'if: always() && ' + condition),
                    worker.replace("needs.fixtures.result == 'success' && ", '')):
        try:
            worker_topology(mutated)
        except AssertionError:
            pass
        else:
            raise AssertionError('serialization / cancellation / producer gate drift accepted')
terminal = jobs['regression_result']
assert '    name: Regression Result\n' in terminal
assert '    needs: [fixtures, shard_1, shard_2]\n' in terminal and '    if: always()\n' in terminal
assert '      - name: Normalize shard results\n' in terminal
for line in ('SHARD_ID: terminal', 'PRODUCER_RESULT: ${{ needs.fixtures.result }}',
             'EXECUTION_PLAN_B64: ${{ needs.fixtures.outputs.execution_plan_b64 }}',
             'ROUTING_MODE: ${{ needs.fixtures.outputs.routing_mode }}',
             'SHARD_1_RESULT: ${{ needs.shard_1.result }}',
             'SHARD_2_RESULT: ${{ needs.shard_2.result }}'):
    assert '          ' + line + '\n' in terminal
assert 'uses:' not in terminal and 'checkout' not in terminal and '    timeout-minutes: 1\n' in terminal
assert '      routing_mode: ${{ steps.fixtures.outputs.routing_mode }}\n' in jobs['fixtures']
assert '      execution_plan_b64: ${{ steps.fixtures.outputs.execution_plan_b64 }}\n' in jobs['fixtures']
assert '        id: fixtures\n' in workflow
assert workflow.count('GITHUB_OUTPUT') == 1  # Producer write only.
for block in [*worker_blocks.values(), terminal_block]:
    subprocess.run(['bash', '-n'], input=block.encode(), check=True)


def execution_list_boundary(block):
    code = block.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
    tree = ast.parse(code)
    writes = [ast.unparse(node) for node in ast.walk(tree)
              if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign))
              and any(isinstance(name, ast.Name) and name.id in {'actual', 'chosen'}
                      for target in (node.targets if isinstance(node, ast.Assign) else [node.target])
                      for name in ast.walk(target))]
    assert sorted(writes) == sorted([
        'actual, chosen = ([], [])', 'actual = sorted(sys.argv[2:])', 'chosen = actual',
        "chosen = sorted(record['fixtures'])",
        "mode, suites, chosen = ('full', sorted(suite_names), actual)"]), 'plan fed execution list'
    assert not any(isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                   and node.value.id in {'actual', 'chosen'} for node in ast.walk(tree))
    assert "for p in chosen))" in code  # Existing execution-file source, never plan.


execution_list_boundary(run_block)
try:
    execution_list_boundary(run_block.replace('reason = selection_reason',
                                             'reason = selection_reason\n    chosen = sorted(assigned)'))
except AssertionError:
    pass
else:
    raise AssertionError('plan-to-execution wiring accepted')


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
assert len(actual) == 86
common_guard = prefix + 'test-production-unreachable.sh'
local_path = prefix + 'deepinfra-usage-ledger.py'
selected = sorted(policy.INVENTORY['deepinfra'] + policy.INVENTORY['common'])
base, head, merge = 'a' * 40, 'b' * 40, 'c' * 40
record = dict(schema='ai-workflow-fixture-selection', version=1, mode='selected',
              reason='known_paths', suites=['common', 'deepinfra'], fixtures=selected)


def encode(paths):
    return b''.join(p.encode() + b'\0' for p in paths)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        assert key not in value, 'duplicate JSON key'
        value[key] = item
    return value


with tempfile.TemporaryDirectory() as temporary:
    tmp = Path(temporary)
    workspace = tmp / 'workspace'
    scripts = workspace / prefix
    scripts.mkdir(parents=True)
    bin_dir = tmp / 'bin'
    bin_dir.mkdir()
    trusted = tmp / 'base-selector.py'
    trusted_planner, planner_log = tmp / 'base-planner.py', tmp / 'planner.log'
    changed_file, git_log = tmp / 'changed.nul', tmp / 'git.log'
    summary_file, execution_log = tmp / 'summary', tmp / 'executed'
    output_file = tmp / 'github-output'
    # Head policy is deliberately executable and hostile. It must never run.
    (scripts / source.name).write_text("raise RuntimeError('HEAD POLICY EXECUTED')\n")
    (scripts / planner_source.name).write_text("raise RuntimeError('HEAD PLANNER EXECUTED')\n")
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
elif args == ['show', base + ':.github/scripts/plan-ai-workflow-shards.py']:
    if os.environ.get('GIT_FAILURE') == 'planner-show': sys.exit(1)
    sys.stdout.buffer.write(pathlib.Path(os.environ['TRUSTED_PLANNER']).read_bytes())
else:
    sys.exit(90)
''')
    mock_git.chmod(0o755)
    env = {**os.environ, 'PATH': str(bin_dir) + ':' + os.environ['PATH'],
           'BASE_SHA': base, 'HEAD_SHA': head, 'GITHUB_STEP_SUMMARY': str(summary_file),
           'GITHUB_OUTPUT': str(output_file), 'EXECUTION_PLAN_VALIDATOR': validator,
           'EXECUTION_LOG': str(execution_log), 'GIT_LOG': str(git_log),
           'CHANGED_FILE': str(changed_file), 'TRUSTED_SELECTOR': str(trusted),
           'TRUSTED_PLANNER': str(trusted_planner), 'PLANNER_LOG': str(planner_log)}

    def consumer(role, encoded, producer='success', routing='full', results=('success', 'success'), overrides=None,
                 block=None):
        block = block or (terminal_block if role == 'terminal' else worker_blocks[role])
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', block], cwd=workspace,
                              env={**env, 'SHARD_ID': role, 'PRODUCER_RESULT': producer,
                                   'EXECUTION_PLAN_B64': encoded, 'ROUTING_MODE': routing,
                                   'SHARD_1_RESULT': results[0], 'SHARD_2_RESULT': results[1],
                                   **(overrides or {})}, capture_output=True)

    def output_value():
        return output_file.read_text().splitlines()[0].split('=', 1)[1]

    def set_planner(body):
        # Observe actual subprocess invocations and exact NUL input before running
        # the base blob. Head source is hostile throughout every production test.
        trusted_planner.write_text('''import io, json, os, sys
data = sys.stdin.buffer.read()
with open(os.environ['PLANNER_LOG'], 'a') as output:
    output.write(json.dumps(list(data)) + '\\n')
sys.stdin = io.TextIOWrapper(io.BytesIO(data), encoding='utf-8')
''' + body)

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
        set_planner(planner_source.read_text())
        changed_file.write_bytes(encode([local_path]))

    def run(expected, mode, reason, status=0, block=run_block, overrides=None,
            planner_calls=None, planner_input=None, output_override=None, suites_override=None):
        for path in (summary_file, execution_log, git_log, planner_log, output_file):
            path.unlink(missing_ok=True)
        result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', block], cwd=workspace,
                                env={**env, **(overrides or {})}, capture_output=True)
        producer_status = result.returncode
        if mode == 'full' and expected and output_override is None and producer_status == 0:
            assert not execution_log.exists(), 'full producer executed fixtures'
            encoded = output_value()
            workers = [consumer(str(i), encoded, overrides=overrides) for i in (1, 2)]
            results = tuple('success' if w.returncode == 0 else 'failure' for w in workers)
            result = consumer('terminal', encoded, results=results)
        executed = (execution_log.read_bytes().split(b'\0')[:-1] if execution_log.exists() else [])
        executed = [path.decode() for path in executed]
        summary = summary_file.read_text()
        assert (result.returncode == 0) == (status == 0), (reason, result.stderr, summary)
        if mode == 'full' and expected and output_override is None:
            assert sorted(executed) == expected and len(executed) == len(set(executed)), (reason, executed, expected)
            prepared_shards = json.loads(base64.b64decode(output_value()))['shards']
            assert executed == [p for shard in prepared_shards for p in shard['fixtures']]
        else:
            assert executed == ([] if mode == 'full' else expected), (reason, executed, expected)
        assert f'- mode: {mode}\n' in summary and f'- reason: {reason}\n' in summary, summary
        assert f'- full count: {len(list(scripts.glob("test-*.sh")))}\n' in summary
        assert f'結果: **{"PASS" if producer_status == 0 else "FAIL"}**' in summary
        assert len(summary) < 1024 and '| Fixture |' not in summary
        assert not any(path in summary for path in actual)
        inputs = [bytes(json.loads(line)) for line in planner_log.read_text().splitlines()] if planner_log.exists() else []
        if planner_calls is None:
            planner_calls = int(mode == 'full' and reason not in {
                'no_fixtures', 'invalid_fixture_type', 'selected_fixture_missing',
                'planner_base_invalid', 'planner_base_unavailable', 'base_planner_unavailable'})
        inventory = sorted(prefix + p.name for p in scripts.glob('test-*.sh'))
        assert inputs == ([encode(planner_input if planner_input is not None else inventory)]
                          * planner_calls if planner_calls else []), (reason, inputs)
        calls = [json.loads(line) for line in git_log.read_text().splitlines()] if git_log.exists() else []
        extraction = ['show', base + ':' + prefix + planner_source.name]
        if mode == 'selected':
            assert extraction not in calls, 'selected path retrieved planner'
        if inputs:
            assert calls.count(extraction) == 1, 'planner must be extracted exactly once from base'
        output = output_file.read_bytes() if output_file.exists() else b''
        if output_override is not None:
            assert output == output_override
        elif expected:
            assert output.startswith(b'execution_plan_b64=') and output.endswith(b'\n')
            assert output.count(b'\n') == 2 and output.isascii()
            assert output.splitlines()[1] == ('routing_mode=' + mode).encode()
            encoded = output.splitlines()[0].split(b'=', 1)[1]
            assert len(encoded) <= 256 * 1024
            decoded = base64.b64decode(encoded, validate=True)
            prepared = json.loads(decoded.decode('utf-8', 'strict'), object_pairs_hook=unique_object)
            assert set(prepared) == {'schema', 'version', 'base_sha', 'head_sha', 'mode',
                                     'reason', 'suites', 'full_count', 'execution_count',
                                     'fixtures', 'shards'}
            assert prepared['schema'] == 'ai-workflow-regression-execution-plan'
            assert type(prepared['version']) is int and prepared['version'] == 1
            assert prepared['base_sha'] == base
            # Even on event SHA fallback, the output identifies validated current HEAD.
            assert prepared['head_sha'] == (overrides or {}).get('MOCK_HEAD', head)
            assert prepared['mode'] == mode and prepared['reason'] == reason
            expected_suites = (suites_override if suites_override is not None else
                              sorted(policy.INVENTORY) if mode == 'full' else
                              sorted(s for s, paths in policy.INVENTORY.items()
                                     if set(paths) & set(expected)))
            assert prepared['suites'] == expected_suites
            assert type(prepared['full_count']) is int and prepared['full_count'] == len(inventory)
            assert type(prepared['execution_count']) is int and prepared['execution_count'] == len(expected)
            assert prepared['fixtures'] == expected == sorted(set(expected))
            if mode == 'selected':
                assert prepared['shards'] == []
            else:
                assert expected == inventory  # Independent current discovery.
                assert len(prepared['shards']) == 2
                assert [s['id'] for s in prepared['shards']] == [1, 2]
                assigned = []
                for shard in prepared['shards']:
                    assert set(shard) == {'id', 'fixtures'} and type(shard['id']) is int
                    assert shard['fixtures'] and shard['fixtures'] == sorted(set(shard['fixtures']))
                    assigned.extend(shard['fixtures'])
                assert len(assigned) == len(set(assigned)) and sorted(assigned) == expected
                canonical_shards = [dict(id=s['id'], fixtures=sorted(s['fixtures']))
                                    for s in planner_policy.plan(encode(inventory))['shards']]
                assert prepared['shards'] == canonical_shards
            assert decoded == json.dumps(prepared, sort_keys=True, ensure_ascii=True,
                                         separators=(',', ':'), allow_nan=False).encode('utf-8')
            assert base64.b64encode(decoded) == encoded
            assert encoded.decode() not in summary and prepared['schema'] not in summary
        else:
            assert output == b'', (reason, output)
        return calls

    reset()
    calls = run(selected, 'selected', 'known_paths')
    assert calls == [['rev-parse', 'HEAD'], ['rev-parse', '--verify', base + '^{commit}'],
                     ['merge-base', base, head],
                     ['diff', '--no-renames', '--name-only', '-z', merge, head],
                     ['show', base + ':' + prefix + source.name], ['rev-parse', 'HEAD']]
    first_output = output_file.read_bytes()
    run(selected, 'selected', 'known_paths')
    assert output_file.read_bytes() == first_output
    # The record oracle must detect changed coverage/count independently of
    # unchanged execution, rather than merely accepting parseable JSON.
    for before, after in (('fixtures=chosen, shards=shards', 'fixtures=actual, shards=shards'),
                          ('execution_count=len(chosen)', 'execution_count=len(actual)')):
        mutated = run_block.replace(before, after)
        assert mutated != run_block
        try:
            run(selected, 'selected', 'known_paths', block=mutated)
        except AssertionError:
            pass
        else:
            raise AssertionError('inconsistent prepared execution plan accepted')
    assert common_guard in selected and len(selected) == 14
    # Producer failures stop before execution; never silently fall back.
    encoded_length = len(first_output.splitlines()[0].split(b'=', 1)[1])
    run(selected, 'selected', 'known_paths', block=run_block.replace(
        'execution_plan_limit = 256 * 1024', f'execution_plan_limit = {encoded_length}'))
    run([], 'selected', 'execution_plan_output_invalid', status=1, block=run_block.replace(
        'execution_plan_limit = 256 * 1024', f'execution_plan_limit = {encoded_length - 1}'))
    for before, after in (
            ('json.dumps(execution_plan,', 'json.dumps(object(),'),
            ('base64.b64encode(canonical)', 'base64.b64encode(None)'),
            ('execution_reason = reason', "suites = ['unknown']\n    execution_reason = reason"),
            ('execution_reason = reason', "reason = 'unknown'\n    execution_reason = reason")):
        run([], 'selected', 'execution_plan_invalid', status=1,
            block=run_block.replace(before, after))
    run([], 'selected', 'execution_plan_output_invalid', status=1,
        block=run_block.replace('base64.b64encode(canonical)', "b'bad\\n'"))
    run([], 'selected', 'execution_plan_output_invalid', status=1,
        overrides={'GITHUB_OUTPUT': str(tmp)})  # Cannot open a directory as output.
    run([], 'unknown', 'execution_plan_invalid', status=1, block=run_block.replace(
        'execution_reason = reason', "mode = 'unknown'\n    execution_reason = reason"))
    # Tampering with the prepared value cannot change fixtures.nul or execution.
    tampered = run_block.replace('mapfile -d',
        'printf "execution_plan_b64=modified\\n" > "$GITHUB_OUTPUT"\nmapfile -d')
    run(selected, 'selected', 'known_paths', block=tampered,
        output_override=b'execution_plan_b64=modified\n')
    # Selected must succeed even if the base planner cannot be retrieved/executed.
    run(selected, 'selected', 'known_paths', overrides={'GIT_FAILURE': 'planner-show'})
    set_planner('raise SystemExit(7)\n')
    run(selected, 'selected', 'known_paths')
    set_planner(planner_source.read_text())
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
    assert len(product_selected) == 22
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
    for overrides, reason in [({'BASE_SHA': 'invalid'}, 'planner_base_invalid'),
                              ({'HEAD_SHA': head.upper()}, 'sha_invalid'),
                              ({'MOCK_HEAD': base}, 'head_mismatch'),
                              ({'MOCK_BASE': head}, 'planner_base_unavailable'),
                              ({'GIT_FAILURE': 'base'}, 'planner_base_unavailable'),
                              ({'GIT_FAILURE': 'merge-base'}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': ''}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': 'invalid'}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': merge.upper()}, 'merge_base_failed'),
                              ({'MOCK_MERGE_BASE': merge + '\n' + base}, 'merge_base_failed'),
                              ({'GIT_FAILURE': 'diff'}, 'diff_failed'),
                              ({'GIT_FAILURE': 'show'}, 'base_selector_unavailable')]:
        if reason.startswith('planner_base_'):
            run([], 'full', reason, status=1, overrides=overrides)
        else:
            run(actual, 'full', reason, overrides=overrides)
    trusted.write_text('raise SystemExit(3)\n')
    run(actual, 'full', 'selector_failed')
    # Full caller ignores an otherwise well-formed selector's incomplete full list.
    full_record = {**record, 'mode': 'full', 'reason': 'unmapped_path', 'fixtures': selected[:1]}
    trusted.write_text('print(' + repr(json.dumps(full_record)) + ')\n')
    run(actual, 'full', 'unmapped_path', suites_override=sorted(full_record['suites']))
    for key, value in [('schema', 'unknown'), ('version', True), ('mode', 'unknown'),
                       ('reason', 'untrusted\ntext'), ('suites', ['unknown']),
                       ('suites', ['common', 'common']), ('fixtures', 'not-list'),
                       ('fixtures', selected + selected[:1]),
                       ('fixtures', [prefix + '../test-escape.sh']),
                       ('fixtures', [prefix + 'test-\ud800.sh']),
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
    # #763: actual production full path, trusted planner errors are terminal.
    changed_file.write_bytes(encode([prefix + 'unknown.py']))
    run(actual, 'full', 'unmapped_path')
    full_output = output_file.read_bytes()
    run(actual, 'full', 'unmapped_path')
    assert output_file.read_bytes() == full_output
    for order, expression in ((actual[::-1], 'actual[::-1]'),
                              (actual[::2] + actual[1::2], 'actual[::2] + actual[1::2]')):
        reordered = run_block.replace("for p in actual),", f"for p in {expression}),")
        assert reordered != run_block
        run(actual, 'full', 'unmapped_path', block=reordered, planner_input=order)
        assert output_file.read_bytes() == full_output
    run([], 'full', 'base_planner_unavailable', status=1,
        overrides={'GIT_FAILURE': 'planner-show'})
    trusted_planner.unlink()  # Blob missing at base is also a failed git show.
    run([], 'full', 'base_planner_unavailable', status=1)
    set_planner('raise SystemExit(7)\n')
    run([], 'full', 'planner_failed', status=1)
    set_planner('this is invalid Python\n')
    run([], 'full', 'planner_failed', status=1, planner_calls=0)
    valid_plan = planner_policy.plan(encode(actual))
    payloads = ['invalid JSON', '[]', 'null', json.dumps(valid_plan) + '\n{}',
                json.dumps(valid_plan)[:-1] + ',"policy":"observed-lpt-v1"}',
                json.dumps(valid_plan).replace('"id": 1', '"id": 1, "id": 1')]
    for key, value in [('schema', 'unknown'), ('version', True), ('version', 2),
                       ('policy', 'unknown'), ('shard_count', True), ('shard_count', 3),
                       ('shards', {}), ('shards', []), ('extra', None)]:
        payloads.append(json.dumps({**valid_plan, key: value}))
    for key in valid_plan:
        payloads.append(json.dumps({k: v for k, v in valid_plan.items() if k != key}))
    for field, value in [('id', True), ('id', 0), ('id', 2), ('extra', None),
                         ('fixtures', []), ('fixtures', actual[0]),
                         ('fixtures', [1]), ('fixtures', [prefix + 'test-.sh']),
                         ('fixtures', [prefix + '../test-escape.sh']),
                         ('fixtures', [prefix + 'test-a\\b.sh']),
                         ('fixtures', [prefix + 'test-a\0b.sh']),
                         ('fixtures', [prefix + 'test-\ud800.sh'])]:
        broken = json.loads(json.dumps(valid_plan))
        broken['shards'][0][field] = value
        payloads.append(json.dumps(broken))
    for key in ('id', 'fixtures'):
        broken = json.loads(json.dumps(valid_plan))
        del broken['shards'][0][key]
        payloads.append(json.dumps(broken))
    for action in ('duplicate-within', 'intersection', 'missing', 'extra', 'replace',
                   'missing-shard', 'extra-shard', 'non-object-shard'):
        broken = json.loads(json.dumps(valid_plan))
        shards = broken['shards']
        if action == 'duplicate-within': shards[0]['fixtures'].append(shards[0]['fixtures'][0])
        elif action == 'intersection': shards[0]['fixtures'].append(shards[1]['fixtures'][0])
        elif action == 'missing': shards[0]['fixtures'].pop()
        elif action == 'extra': shards[0]['fixtures'].append(prefix + 'test-extra.sh')
        elif action == 'replace': shards[0]['fixtures'][0] = prefix + 'test-extra.sh'
        elif action == 'missing-shard': shards.pop()
        elif action == 'extra-shard': shards.append(shards[0])
        else: shards[0] = []
        payloads.append(json.dumps(broken))
    for payload in payloads:
        set_planner('print(' + repr(payload) + ')\n')
        run([], 'full', 'planner_record_invalid', status=1)
    # Producer canonicalizes both valid planner orderings before handoff.
    valid_plan['shards'].reverse()
    for shard in valid_plan['shards']:
        shard['fixtures'].reverse()
    set_planner('print(' + repr(json.dumps(valid_plan)) + ')\n')
    run(actual, 'full', 'unmapped_path')
    assert output_file.read_bytes() == full_output
    # Selector failure must pass the same planner gate before full execution.
    trusted.write_text('raise SystemExit(3)\n')
    set_planner('raise SystemExit(7)\n')
    run([], 'full', 'planner_failed', status=1)
    # Mutations using head code or omitting coverage checks must fail this oracle.
    set_planner('print(' + repr(json.dumps({**valid_plan, 'shards': []})) + ')\n')
    for mutated in (
            run_block.replace("[sys.executable, '-B', str(planner)]",
                              "[sys.executable, '-B', str(root / prefix / 'plan-ai-workflow-shards.py')]"),
            run_block.replace("if mode == 'full':", 'if False:')):
        try:
            run([], 'full', 'planner_record_invalid', status=1, block=mutated)
        except AssertionError:
            pass
        else:
            raise AssertionError('head source / skipped planner accepted')
    reset()
    unusual_fixture = prefix + 'test-space name\nline-日本語-é-"\'.sh'
    fixture(unusual_fixture)
    changed_file.write_bytes(encode([unusual_fixture]))
    run(sorted(actual + [unusual_fixture]), 'full', 'inventory_mismatch')
    unusual_selected = sorted(selected + [unusual_fixture])
    trusted.write_text('print(' + repr(json.dumps({**record, 'fixtures': unusual_selected})) + ')\n')
    run(unusual_selected, 'selected', 'known_paths')
    (workspace / unusual_fixture).unlink()
    reset()
    # Invalid filesystem bytes arrive as surrogateescape argv under LC_ALL=C.
    bad_bytes = os.fsencode(scripts) + b'/test-invalid-\xff.sh'
    descriptor = os.open(bad_bytes, os.O_CREAT | os.O_WRONLY, 0o600)
    os.close(descriptor)
    run([], 'full', 'invalid_fixture_type', status=1)
    os.unlink(bad_bytes)
    # A real oversized record must stop, with no output and no fixture execution.
    for index in range(220):
        fixture(prefix + f'test-{index:03d}-' + '界' * 75 + '.sh')
    run([], 'full', 'execution_plan_output_invalid', status=1)
    reset()
    run([], 'full', 'execution_plan_invalid', status=1,
        overrides={'MOCK_HEAD': 'invalid'})
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
    reset()
    changed_file.write_bytes(encode([prefix + 'unknown.py']))
    run(actual, 'full', 'unmapped_path')
    full_encoded = output_value()
    full_plan = json.loads(base64.b64decode(full_encoded))
    selected_encoded = first_output.splitlines()[0].split(b'=', 1)[1].decode()

    def packed(value):
        return base64.b64encode(json.dumps(value, sort_keys=True, ensure_ascii=True,
                                          separators=(',', ':')).encode()).decode()

    def rejected_consumer(encoded=full_encoded, overrides=None, producer='success'):
        for role in ('1', '2', 'terminal'):
            execution_log.unlink(missing_ok=True)
            result = consumer(role, encoded, producer=producer, overrides=overrides)
            assert result.returncode != 0, (role, result.stdout, result.stderr)
            assert not execution_log.exists(), 'invalid plan acquired execution authority'

    # Prepublished output has no authority when producer failed, including cancellation.
    for producer in ('failure', 'cancelled', 'skipped', 'timed_out', 'startup_failure', ''):
        for role in ('1', '2'):
            execution_log.unlink(missing_ok=True)
            assert consumer(role, full_encoded, producer=producer).returncode != 0
            assert not execution_log.exists()
        assert consumer('terminal', 'corrupt', producer=producer).returncode == 0
    assert consumer('terminal', selected_encoded, routing='selected', results=('skipped', 'skipped')).returncode == 0
    for role in ('1', '2'):
        execution_log.unlink(missing_ok=True)
        assert consumer(role, selected_encoded).returncode != 0
        assert not execution_log.exists()
    for results in (('success', 'skipped'), ('failure', 'failure'), ('skipped', 'success')):
        assert consumer('terminal', selected_encoded, routing='selected', results=results).returncode != 0
    assert consumer('terminal', full_encoded).returncode == 0
    for status in ('failure', 'cancelled', 'skipped', 'timed_out', 'startup_failure', 'neutral', ''):
        for results in ((status, 'success'), ('success', status), (status, status)):
            assert consumer('terminal', full_encoded, results=results).returncode != 0
    for encoded, routing in ((full_encoded, 'selected'), (selected_encoded, 'full'), (full_encoded, '')):
        assert consumer('terminal', encoded, routing=routing).returncode != 0

    for encoded in ('', '!', full_encoded + '\n', '_' + full_encoded[1:],
                    base64.b64encode(b'\xff').decode(), base64.b64encode(b'{}{}').decode(),
                    base64.b64encode(json.dumps(full_plan)[:-1].encode() + b',"mode":"full"}').decode(),
                    base64.b64encode(b'{"mode":"full","mode":"full"}').decode()):
        rejected_consumer(encoded)
    # Inject oversized input inside Python, beyond Linux's single-env-entry exec limit.
    for role in ('1', '2', 'terminal'):
        oversized = subprocess.run([sys.executable, '-B', '-c',
            "import os, sys; os.environ['EXECUTION_PLAN_B64'] = sys.stdin.read(); "
            "exec(os.environ['EXECUTION_PLAN_VALIDATOR'])"], input=b'A' * (256 * 1024 + 1),
            env={**env, 'SHARD_ID': role, 'PRODUCER_RESULT': 'success'}, capture_output=True)
        assert oversized.returncode != 0
    mutations = []
    for key, value in [('schema', 'unknown'), ('version', True), ('version', 2),
                       ('base_sha', base.upper()), ('head_sha', 'invalid'), ('mode', 'unknown'),
                       ('reason', 'unknown'), ('reason', []), ('suites', ['unknown']),
                       ('suites', ['common', 'common']), ('suites', 'common'),
                       ('full_count', True), ('full_count', len(actual) + 1), ('execution_count', 78),
                       ('fixtures', []), ('fixtures', actual[::-1]), ('shards', []), ('extra', 1)]:
        mutations.append({**full_plan, key: value})
    for key in full_plan:
        mutations.append({k: v for k, v in full_plan.items() if k != key})
    for field, value in [('id', True), ('id', 2), ('extra', None), ('fixtures', []),
                         ('fixtures', [prefix + 'test-.sh']), ('fixtures', [prefix + 'test-\ud800.sh']),
                         ('fixtures', [prefix + '../test-escape.sh']), ('fixtures', [prefix + 'test-a\\b.sh']),
                         ('fixtures', [prefix + 'test-a\0b.sh'])]:
        broken = json.loads(json.dumps(full_plan))
        broken['shards'][0][field] = value
        mutations.append(broken)
    for action in ('duplicate', 'intersection', 'missing', 'extra', 'unsorted', 'reversed-ids'):
        broken = json.loads(json.dumps(full_plan))
        shards = broken['shards']
        if action == 'duplicate': shards[0]['fixtures'].append(shards[0]['fixtures'][0])
        elif action == 'intersection': shards[0]['fixtures'] = sorted(shards[0]['fixtures'] + shards[1]['fixtures'][:1])
        elif action == 'missing': shards[0]['fixtures'].pop()
        elif action == 'extra': shards[0]['fixtures'].append(prefix + 'test-extra.sh')
        elif action == 'unsorted': shards[0]['fixtures'].reverse()
        else: shards.reverse()
        mutations.append(broken)
    for broken in mutations:
        rejected_consumer(packed(broken))
    # Stale head and inventory drift are worker-only checkout validations.
    for role in ('1', '2'):
        execution_log.unlink(missing_ok=True)
        assert consumer(role, full_encoded, overrides={'MOCK_HEAD': base}).returncode != 0
        assert not execution_log.exists()
    for kind in ('missing', 'extra', 'symlink', 'directory', 'fifo', 'invalid-utf8', 'ancestor-symlink'):
        reset()
        target = workspace / actual[0]
        if kind == 'missing': target.unlink()
        elif kind == 'extra': fixture(prefix + 'test-extra.sh')
        elif kind == 'invalid-utf8':
            bad = os.fsencode(scripts) + b'/test-invalid-\xff.sh'
            descriptor = os.open(bad, os.O_CREAT | os.O_WRONLY, 0o600)
            os.close(descriptor)
        elif kind == 'ancestor-symlink':
            scripts.rename(workspace / '.github/real-scripts')
            scripts.symlink_to(workspace / '.github/real-scripts', target_is_directory=True)
        else:
            target.unlink()
            if kind == 'symlink': target.symlink_to(workspace / actual[1])
            elif kind == 'directory': target.mkdir()
            else: os.mkfifo(target)
        for role in ('1', '2'):
            execution_log.unlink(missing_ok=True)
            assert consumer(role, full_encoded).returncode != 0, kind
            assert not execution_log.exists()
        if kind == 'invalid-utf8': os.unlink(bad)
        if kind == 'ancestor-symlink':
            scripts.unlink()
            (workspace / '.github/real-scripts').rename(scripts)
    reset()
    # Failure in shard 1 must preserve its later fixtures and all shard 2 coverage.
    a, b = [s['fixtures'] for s in full_plan['shards']]
    fixture(a[0], fail=True)
    execution_log.unlink(missing_ok=True)
    assert consumer('1', full_encoded).returncode != 0
    assert consumer('2', full_encoded).returncode == 0
    assert execution_log.read_bytes() == encode(a + b)
    assert consumer('terminal', full_encoded, results=('failure', 'success')).returncode != 0
    # Recheck catches a fixture replaced by an earlier fixture, then continues.
    for role, shard in (('1', a), ('2', b)):
        reset()
        (workspace / shard[0]).write_text(
            f'printf "%s\\0" {shlex.quote(shard[0])} >> "$EXECUTION_LOG"\n'
            + f'rm -- {shlex.quote(shard[1])}\n'
            + f'ln -s -- {shlex.quote((workspace / shard[2]).as_posix())} {shlex.quote(shard[1])}\n')
        execution_log.unlink(missing_ok=True)
        assert consumer(role, full_encoded).returncode != 0
        assert execution_log.read_bytes() == encode([shard[0]] + shard[2:])
    reset()
print('AI Workflow Regression: parallel job topology, selected behavior, full coverage, validated consumers, terminal normalization and mutations passed.')
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
