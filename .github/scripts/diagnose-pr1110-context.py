"""Temporary real-input context proof. GET/read token only; no paid model."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

MAIN = 'f4a152780f76d8cf8dfaa6143646e4cba93dfd45'
HEAD = '50ac09107c1d80fdcdbb03dc0e0a63e012be9137'
BASE = '17f63a0a9e9ebf2ecd03c1e9329f8200362aebc5'
REPO = 'suzukure/nssscdl'
STAGE = 'entry'
OPERATION = 'fixed_event'
TRUSTED = 'nssscdl-chatgpt-dev,nssscdl-chatgpt-dev[bot],app/nssscdl-chatgpt-dev,nssscdl-claude-review,nssscdl-claude-review[bot],app/nssscdl-claude-review'
REVIEWERS = 'nssscdl-claude-review,nssscdl-claude-review[bot],app/nssscdl-claude-review'

def emit(code):
    print(json.dumps(dict(stage=STAGE, operation=OPERATION, exit_code=code)), flush=True)

def require(value):
    if not value:
        raise ValueError('fixed condition mismatch')

def run(args, *, cwd=None, env=None):
    return subprocess.run(args, cwd=cwd, env=env, text=True, encoding='utf-8',
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=True, timeout=180).stdout

def api(path):
    # All callers below are fixed GET endpoints; no request body or write flags.
    return json.loads(run(['gh', 'api', '/repos/' + REPO + '/' + path]))

def facts():
    require(api('git/ref/heads/main')['object']['sha'] == MAIN)
    pr = api('pulls/1110')
    require(pr['number'] == 1110 and pr['state'] == 'open' and pr['draft'] is False)
    require(pr['head']['sha'] == HEAD and pr['base']['sha'] == BASE)
    require(pr['head']['ref'] == 'docs/issue-1108-student-booking-ux-contract')
    require(pr['head']['repo']['full_name'] == pr['base']['repo']['full_name'] == REPO)
    require(any(x['name'] == 'human-review-required' for x in pr['labels']))
    issue = api('issues/1109')
    require(issue['state'] == 'open' and any(x['name'] == 'human-review-required' for x in issue['labels']))
    comments = api('issues/1110/comments?per_page=100')
    require(isinstance(comments, list) and len(comments) < 100)
    selected = [x for x in comments if x['id'] in (6660744739, 6660775078)]
    require(len(selected) == 2 and {x['id'] for x in selected} == {6660744739, 6660775078})
    require(all(type(x['performed_via_github_app']['id']) is int and
                x['performed_via_github_app']['id'] == 4777865 for x in selected))
    # Bind before/after to the exact accepted and new-pause record bodies.
    return sorted((x['id'], x['body']) for x in selected)

def main():
    global STAGE, OPERATION
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    pr = event['pull_request']
    require(event['action'] == 'reopened' and pr['number'] == 1117 and pr['draft'] is True)
    require(pr['head']['ref'] == 'diagnostic/issue-1111-qualification-stage')
    require(pr['head']['repo']['full_name'] == pr['base']['repo']['full_name'] == REPO)
    require(pr['base']['ref'] == 'main')
    require(os.environ['GITHUB_RUN_ATTEMPT'] == '1')
    require(os.environ['GITHUB_ACTOR'] == os.environ['GITHUB_TRIGGERING_ACTOR'] == 'suzukure')
    require('GH_WRITE_TOKEN' not in os.environ)
    trusted, qualification = map(Path, (os.environ['DIAGNOSTIC_TRUSTED'], os.environ['RECOVERY_SOURCE']))
    require(run(['git', '-C', str(trusted), 'rev-parse', 'HEAD']).strip() == MAIN)
    require(run(['git', '-C', str(qualification), 'rev-parse', 'HEAD']).strip() == HEAD)
    emit(0)
    STAGE, OPERATION = 'preflight', 'fixed_target_and_pause'
    before = facts()
    emit(0)
    STAGE, OPERATION = 'context', 'normal_review_builder'
    env = dict(os.environ, SOURCE_BASE_SHA=MAIN, BASE_SHA=MAIN)
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'review.md'
        # Same builder, caller identities, allowlists and CI snapshot opt-in as
        # normal Review. Job Summary measurement alone is omitted.
        run(['bash', str(trusted / '.github/scripts/build-review-context.sh'),
             REPO, '1110', str(output), TRUSTED, REVIEWERS, '', HEAD],
            cwd=str(qualification), env=env)
        require(output.is_file() and output.stat().st_size > 0)
    emit(0)
    STAGE, OPERATION = 'postflight', 'fixed_target_and_pause'
    require(facts() == before)
    emit(0)

if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        emit(error.returncode)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        emit(124)
        sys.exit(1)
    except Exception:
        emit(1)
        sys.exit(1)
