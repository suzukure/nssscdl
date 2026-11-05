"""Temporary read-only prewrite boundary observation."""
import ast
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from unittest.mock import patch

MAIN = '09759be3c42eb00b3120a4e777715d3c2a9b4bda'
SOURCE_RUN = '42033641429'
STAGE = 'entry'

def emit(operation, code):
    print(json.dumps({'stage': STAGE, 'operation': operation, 'exit_code': code}, sort_keys=True))

def classify(error):
    if isinstance(error, subprocess.CalledProcessError):
        m = re.search(r'\(HTTP (401|403|404|410|422|429|500|502|503|504)\)', error.stderr or '')
        return ('http_' + m[1] if m else 'process_failed', error.returncode)
    if isinstance(error, json.JSONDecodeError):
        return 'json_invalid', 1
    if isinstance(error, KeyError):
        return 'field_missing', 1
    if isinstance(error, TypeError):
        return 'field_type_invalid', 1
    return 'validation_failed', 1

def main():
    global STAGE
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    pr = event['pull_request']
    assert event['action'] == 'synchronize' and event['before'] == '6089df2aafad9421d9eb5e7923b9dd24197ae368'
    assert pr['number'] == 1117 and pr['draft'] is True
    assert pr['head']['ref'] == 'diagnostic/issue-1111-qualification-stage'
    assert pr['head']['repo']['full_name'] == pr['base']['repo']['full_name'] == 'suzukure/nssscdl'
    assert os.environ['GITHUB_RUN_ATTEMPT'] == '1'
    assert os.environ['GITHUB_ACTOR'] == os.environ['GITHUB_TRIGGERING_ACTOR'] == 'suzukure'
    assert 'GH_WRITE_TOKEN' not in os.environ
    trusted = Path(os.environ['DIAGNOSTIC_TRUSTED'])
    text = (trusted / '.github/scripts/recover-pr1110-claude-pause.sh').read_text()
    source = text.split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
    tree = ast.parse(source)
    assert isinstance(tree.body[-1], ast.Try)
    tree.body.pop()
    with patch.object(sys, 'argv', ['-', 'check', str(trusted / '.github/scripts')]):
        module = {}
        exec(compile(tree, '<frozen-main>', 'exec'), module)
    assert module['api']('git/ref/heads/main')['object']['sha'] == MAIN
    assert module['run'](['git', '-C', str(trusted), 'rev-parse', 'HEAD']).strip() == MAIN
    failures = 0
    STAGE = 'source_history_readonly_replay'
    try:
        # Explicit source-run scenario. No first_apply of this diagnostic run,
        # no writer invocation and no reset/continuation of production state.
        with patch.dict(os.environ, GITHUB_RUN_ID=SOURCE_RUN, GITHUB_RUN_ATTEMPT='1'):
            module['first_apply']()
        emit('passed', 0)
    except Exception as error:
        emit(*classify(error))
        failures += 1
    STAGE = 'app_identity_read'
    try:
        app = json.loads(module['run'](['gh', 'api', '/apps/nssscdl-claude-review']))
        assert type(app['id']) is int and app['id'] == 4777865
        emit('passed', 0)
    except Exception as error:
        emit(*classify(error))
        failures += 1
    return 1 if failures else 0

if __name__ == '__main__':
    try:
        result = main()
    except Exception as error:
        emit(*classify(error))
        result = 1
    sys.exit(result)
