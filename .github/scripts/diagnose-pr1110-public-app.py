"""One public metadata GET; no credentials or production operation."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

URL = 'https://api.github.com/apps/nssscdl-claude-review'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def public_app():
    request = urllib.request.Request(URL, headers={
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nssscdl-pr1110-recovery',
    })
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=15) as response:
        if response.status != 200 or response.geturl() != URL:
            raise ValueError('response_identity')
        data = response.read(65537)
    if len(data) > 65536:
        raise ValueError('response_size')
    app = json.loads(data)
    if not (isinstance(app, dict) and type(app.get('id')) is int
            and app['id'] == 4777865 and app.get('slug') == 'nssscdl-claude-review'):
        raise ValueError('app_identity')
    return app

if __name__ == '__main__':
    operation, code = 'invocation_invalid', 1
    try:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        pr = event['pull_request']
        assert event['action'] == 'synchronize' and event['before'] == '4fc4e1fe78eb60729ffde14388736c4ba0058188'
        assert pr['number'] == 1117 and pr['draft'] is True
        assert pr['head']['ref'] == 'diagnostic/issue-1111-qualification-stage'
        assert pr['head']['repo']['full_name'] == pr['base']['repo']['full_name'] == 'suzukure/nssscdl'
        assert pr['base']['sha'] == '09759be3c42eb00b3120a4e777715d3c2a9b4bda'
        assert os.environ['GITHUB_ACTOR'] == os.environ['GITHUB_TRIGGERING_ACTOR'] == 'suzukure'
        assert os.environ['GITHUB_RUN_ATTEMPT'] == '1'
        operation = 'public_get_failed'
        public_app()
        operation, code = 'public_app_identity_verified', 0
    except urllib.error.HTTPError as error:
        operation = 'http_' + str(error.code) if error.code in (301,302,307,308,401,403,404,429,500,502,503,504) else 'http_error'
    except Exception:
        pass
    print(json.dumps({'stage': 'public_app_read', 'operation': operation, 'exit_code': code}, sort_keys=True))
    raise SystemExit(code)
