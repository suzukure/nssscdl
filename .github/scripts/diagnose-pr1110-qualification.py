"""Temporary read-only observation; never a production qualification or writer."""
import ast
import json
import os
from pathlib import Path
import re
import subprocess
import sys

MAIN = 'c9ed0a3c4e6963e1fece9d96d2c3588c38cd3107'
BRANCH = 'diagnostic/issue-1111-qualification-stage'
REPO = 'suzukure/nssscdl'
STAGE = 'diagnostic_entry'
OPERATION = 'validate_invocation'


class Stop(Exception):
    def __init__(self, stage, operation, code=1):
        self.stage, self.operation, self.code = stage, operation, code


def operation(args):
    # Never serialize argv, API bodies, paths, stderr or exception messages.
    if args[:2] == ['gh', 'api']:
        endpoint = args[-1].split('?', 1)[0]
        fixed = {
            '/repos/' + REPO: 'get_repository',
            '/repos/' + REPO + '/collaborators/suzukure/permission': 'get_actor_permission',
            '/repos/' + REPO + '/git/ref/heads/main': 'get_main_ref',
            '/repos/' + REPO + '/pulls/1110': 'get_target_pr',
            '/repos/' + REPO + '/pulls/1110/files': 'get_pr_files',
            '/repos/' + REPO + '/pulls/1110/reviews': 'get_pr_reviews',
            '/repos/' + REPO + '/issues/1109': 'get_issue_labels',
            '/repos/' + REPO + '/issues/1110': 'get_pr_labels',
            '/repos/' + REPO + '/issues/comments/6625324624': 'get_source_pause',
            '/repos/' + REPO + '/actions/runs': 'get_head_runs',
            '/repos/' + REPO + '/actions/runs/41793021156': 'get_failed_run',
            '/repos/' + REPO + '/actions/runs/41793021156/attempts/1/jobs': 'get_failed_jobs',
            '/repos/' + REPO + '/actions/runs/41793316677': 'get_renderer_run',
            '/repos/' + REPO + '/commits/17f63a0a9e9ebf2ecd03c1e9329f8200362aebc5': 'get_base_commit',
        }
        return fixed.get(endpoint, 'api_get')
    if args[:3] == ['gh', 'pr', 'view']:
        return 'pr_metadata'
    if args and args[0] == 'git':
        words = set(args[1:])
        for verb in ('merge-tree', 'merge-base', 'rev-parse', 'rev-list', 'diff', 'show', 'log'):
            if verb in words:
                return 'git_' + verb.replace('-', '_')
    if args and args[0] == 'bash':
        names = {
            'builder.sh': 'build_review_context',
            'human-pause-record.sh': 'parse_pause_record',
            'list-human-pause-records.sh': 'list_pause_records',
            'validate-human-pause-record-graph.sh': 'validate_graph',
            'decompose-human-pause-record-graph.sh': 'decompose_graph',
            'derive-human-pause-pre-resume-state.sh': 'derive_pause_state',
            'reconcile-human-pause-resume-acceptance.sh': 'reconcile_acceptance',
            'reconcile-human-pause-active-pause.sh': 'reconcile_active_pause',
        }
        if len(args) > 1:
            return names.get(Path(args[1]).name, 'unknown_process')
    return 'unknown_process'


def emit(error):
    # Three fields only; all strings come from constants in this file.
    print(json.dumps(dict(stage=error.stage, operation=error.operation,
                          exit_code=error.code), sort_keys=True), file=sys.stderr)


def observe(module):
    original_run = module['run']

    def observed_run(args, *a, **kw):
        global OPERATION
        OPERATION = operation(args)
        try:
            return original_run(args, *a, **kw)
        except subprocess.CalledProcessError as error:
            if OPERATION == 'get_source_pause':
                match = re.search(r'\(HTTP (401|403|404|410|422|429|500|502|503|504)\)', error.stderr or '')
                name = 'source_pause_http_' + match[1] if match else 'source_pause_gh_failed'
                raise Stop(STAGE, name, error.returncode) from None
            raise Stop(STAGE, OPERATION, error.returncode) from None
        except Exception:
            raise Stop(STAGE, OPERATION) from None

    module['run'] = observed_run
    original_api = module['api']

    def source_api(path):
        if path != 'issues/comments/6625324624':
            return original_api(path)
        raw = module['run'](['gh', 'api', '/repos/' + REPO + '/' + path])
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            raise Stop(STAGE, 'source_pause_json_invalid') from None
        if not isinstance(value, dict):
            raise Stop(STAGE, 'source_pause_object_invalid')
        if 'id' not in value:
            raise Stop(STAGE, 'source_pause_id_missing')
        if value['id'] != 6625324624:
            raise Stop(STAGE, 'source_pause_id_mismatch')
        if 'performed_via_github_app' not in value:
            raise Stop(STAGE, 'source_pause_app_missing')
        app = value['performed_via_github_app']
        if app is None:
            raise Stop(STAGE, 'source_pause_app_null')
        if not isinstance(app, dict) or 'id' not in app:
            raise Stop(STAGE, 'source_pause_app_invalid')
        if app['id'] != 4777865:
            raise Stop(STAGE, 'source_pause_app_mismatch')
        return value

    module['api'] = source_api
    for name in ('current', 'verify_relation', 'graph', 'labels', 'qualify', 'normal_review'):
        original = module[name]

        def wrapped(*args, _name=name, _original=original, **kwargs):
            global STAGE, OPERATION
            previous = STAGE
            STAGE, OPERATION = _name, 'validate_state'
            try:
                return _original(*args, **kwargs)
            except Stop:
                raise
            except Exception:
                raise Stop(STAGE, OPERATION) from None
            finally:
                STAGE = previous

        module[name] = wrapped


def load(path):
    raw = path.read_bytes()
    source = raw.decode().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
    tree = ast.parse(source)
    if not isinstance(tree.body[-1], ast.Try):
        raise Stop('diagnostic_entry', 'load_frozen_helper')
    tree.body.pop()  # Definitions only. Do not execute the shell entry handler.
    old_argv = sys.argv
    try:
        sys.argv = ['-', 'check', str(path.parent)]
        module = {}
        exec(compile(tree, '<frozen-recovery>', 'exec'), module)
    finally:
        sys.argv = old_argv
    return module


def main():
    global STAGE, OPERATION
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    pr = event['pull_request']
    if not (os.environ['GITHUB_EVENT_NAME'] == 'pull_request'
            and event['action'] == 'synchronize' and pr['number'] == 1117
            and event['before'] == '9703d6ad7e0285f1be11692dfca8ab696f2c4df3'
            and os.environ['GITHUB_RUN_ATTEMPT'] == '1'
            and os.environ['GITHUB_ACTOR'] == os.environ['GITHUB_TRIGGERING_ACTOR'] == 'suzukure'
            and pr['user']['login'] == 'suzukure' and pr['draft'] is True
            and pr['head']['repo']['full_name'] == pr['base']['repo']['full_name'] == REPO
            and pr['head']['ref'] == BRANCH and pr['base']['ref'] == 'main'
            and pr['base']['sha'] == MAIN and 'GH_WRITE_TOKEN' not in os.environ):
        raise Stop(STAGE, OPERATION)
    trusted = Path(os.environ['DIAGNOSTIC_TRUSTED'])
    module = load(trusted / '.github/scripts/recover-pr1110-claude-pause.sh')
    observe(module)

    def diagnostic_authorize():
        # Explicit different invocation, never forge workflow_dispatch context.
        # Same reader API/permission/main/checkout checks as original authorize.
        global STAGE, OPERATION
        STAGE, OPERATION = 'authorize', 'validate_state'
        try:
            module['require'](module['api']('')['default_branch'] == 'main', 'default branch')
            permission = module['api']('collaborators/suzukure/permission')
            module['require'](permission['user']['login'] == 'suzukure'
                              and permission['permission'] in ('admin', 'write'), 'actor permission')
            module['require'](module['api']('git/ref/heads/main')['object']['sha'] == MAIN, 'main drift')
            module['require'](module['run'](['git', '-C', str(trusted), 'rev-parse', 'HEAD']).strip()
                              == MAIN, 'trusted checkout')
            STAGE = 'recovery_check'
            return MAIN
        except Stop:
            raise
        except Exception:
            raise Stop(STAGE, OPERATION) from None

    def forbidden(*args, **kwargs):
        raise Stop('diagnostic_entry', 'writer_forbidden')

    module['authorize'] = diagnostic_authorize
    module['write_once'] = module['first_apply'] = forbidden
    module['MODE'] = 'check'
    # Suppress production success prose; a successful diagnostic is not a Go.
    module['print'] = lambda *args, **kwargs: None
    diagnostic_authorize()
    STAGE = 'source_pause_read'
    module['api']('issues/comments/6625324624')
    emit(Stop('source_pause_read', 'source_pause_valid', 0))


if __name__ == '__main__':
    try:
        main()
    except Stop as error:
        emit(error)
        sys.exit(1)
    except Exception:
        emit(Stop(STAGE, OPERATION))
        sys.exit(1)
