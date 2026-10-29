#!/usr/bin/env bash
set -euo pipefail
# #1100 dormant consumer. No production caller until atomic #1098 Activation.
# Caller MUST already own codex-writer-ai/issue-N concurrency; this program
# cannot acquire a GitHub Actions concurrency group on its own.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$script_dir" "$@" <<'PY'
import json
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = 'suzukure/nssscdl'
ROOT = Path(sys.argv[1]).resolve()
DEC = re.compile(r'[1-9][0-9]*\Z')
SHA = re.compile(r'[0-9a-f]{40}\Z')
HUMAN = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}\Z')
COMMAND = re.compile(r'/ai resume handoff pause:([1-9][0-9]*) pr:([1-9][0-9]*) head:([0-9a-f]{40})\Z')
RUN_END = time.monotonic() + 500  # Leave Actions job cleanup headroom.
GRAPH = ['validate-human-pause-record-graph', 'decompose-human-pause-record-graph',
         'derive-human-pause-pre-resume-state', 'reconcile-human-pause-resume-acceptance']

class Stop(Exception):
    pass

def stop(code):
    raise Stop(code)

def budget(reserve=10):
    remaining = RUN_END - time.monotonic()
    if remaining <= reserve:
        stop('runtime_budget_exhausted')
    return min(60, remaining - reserve)

def invoke(args, stdin=None):
    proc = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=budget())
    if proc.returncode != 0:
        stop('trusted_read_or_write_failed')
    return proc.stdout

def parse(s):
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        stop('invalid_api_shape')

def api(endpoint):
    return parse(invoke(['gh', 'api', endpoint]))

def shell_helper(name, *args, stdin=None):
    path = ROOT / (name + '.sh')
    if not path.is_file():
        stop('trusted_helper_missing')
    return invoke(['bash', str(path), *map(str, args)], stdin=stdin)

def num(x):
    return type(x) is int and x > 0

def dec(x):
    return type(x) is str and DEC.fullmatch(x) is not None

def full_pr_list():
    # Use explicit GraphQL pagination, not the `gh pr list` default cap 30.
    query = '''query($endCursor:String) {
      repository(owner:"suzukure",name:"nssscdl") {
        pullRequests(first:100,after:$endCursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
          nodes { number state isDraft headRefOid baseRefName
            author { login } headRepository { nameWithOwner } baseRepository { nameWithOwner }
            closingIssuesReferences(first:100) {nodes {number repository {nameWithOwner}}
              pageInfo {hasNextPage} }
          }
          pageInfo {hasNextPage endCursor}
        }
      }
    }'''
    pages = parse(invoke(['gh', 'api', 'graphql', '--paginate', '--slurp', '-f', 'query='+query]))
    if type(pages) is not list or not (1 <= len(pages) <= 10):
        stop('pr_listing_incomplete')
    found, seen = [], set()
    for ix, page in enumerate(pages):
        try:
            if not (type(page) is dict and not page.get('errors')): raise ValueError("invalid_trusted_snapshot")
            container = page['data']['repository']['pullRequests']
            nodes, info = container['nodes'], container['pageInfo']
            if not (type(nodes) is list and type(info) is dict and len(nodes) <= 100): raise ValueError("invalid_trusted_snapshot")
            if not (type(info['hasNextPage']) is bool): raise ValueError("invalid_trusted_snapshot")
            if not (info['hasNextPage'] == (ix < len(pages)-1)): raise ValueError("invalid_trusted_snapshot")
            if info['hasNextPage']:
                if not (type(info['endCursor']) is str and bool(info['endCursor'])): raise ValueError("invalid_trusted_snapshot")
            for pr in nodes:
                if not (type(pr) is dict and num(pr['number']) and pr['number'] not in seen): raise ValueError("invalid_trusted_snapshot")
                if not (pr['state'] == 'OPEN' and type(pr['isDraft']) is bool): raise ValueError("invalid_trusted_snapshot")
                if not (type(pr['closingIssuesReferences']['nodes']) is list): raise ValueError("invalid_trusted_snapshot")
                if not (pr['closingIssuesReferences']['pageInfo']['hasNextPage'] is False): raise ValueError("invalid_trusted_snapshot")
                if not (len(pr['closingIssuesReferences']['nodes']) <= 100): raise ValueError("invalid_trusted_snapshot")
                for relation in pr['closingIssuesReferences']['nodes']:
                    if not (num(relation['number']) and type(relation['repository']['nameWithOwner']) is str): raise ValueError("invalid_trusted_snapshot")
                seen.add(pr['number'])
                found.append(pr)
        except (AssertionError, ValueError, IndexError, KeyError, TypeError):
            stop('pr_listing_incomplete')
    if len(found) >= 1000:
        stop('pr_listing_bound')
    return found

def canonical_pr(issue, requested):
    open_prs = full_pr_list()
    matching = [p for p in open_prs if any(
        rel['number'] == issue and rel['repository']['nameWithOwner'] == REPO
        for rel in p['closingIssuesReferences']['nodes'])]
    if len(matching) != 1 or matching[0]['number'] != requested:
        stop('ambiguous_closing_pr')
    links = matching[0]['closingIssuesReferences']['nodes']
    if links != [{'number':issue,'repository':{'nameWithOwner':REPO}}]:
        stop('multi_closing_issue')
    return matching[0]

def graph(issue, app_id):
    # Stricter than the generic listing: edited trusted App comments, even
    # after record-marker removal, must never prove absence of a handoff.
    ownership = parse(shell_helper('inspect-ai-handoff-ownership', REPO, issue, app_id))
    if ownership.get('result') not in ('no_handoff_record', 'handoff_owned'):
        stop('ambiguous_handoff_ownership')
    listing = shell_helper('list-human-pause-records', REPO, issue, '-', app_id)
    listing_json = parse(listing)
    if listing_json.get('target') != 'issue:' + str(issue):
        stop('wrong_record_target')
    current = listing
    for stage in GRAPH:
        current = shell_helper(stage, stdin=current)
    reconciled = parse(current)
    # Previous fully consumed resume chains are legitimate (#1077 has them).
    # The existing graph/active-pause reconciler detects multiple active chains;
    # accepted_status below binds this handoff to exactly one source chain.
    if type(reconciled.get('chains')) is not list or not reconciled['chains']:
        stop('invalid_pause_chains')
    active = parse(shell_helper('reconcile-human-pause-active-pause', stdin=current))
    if active.get('target') != 'issue:'+str(issue) or active.get('result') == 'state_inconsistent':
        stop('ambiguous_pause')
    return ownership, listing_json, reconciled, active

def accepted_status(snapshot, pause, actor, pr, head):
    owner, listing, chain, active = snapshot
    matches = [r for r in listing['records'] if r['record'].get('kind') == 'ai-resume-accepted'
               and r['record'].get('payload', {}).get('action') == 'handoff']
    # A different handoff accepted or an accepted-record duplicate is not an
    # invitation to retry. Compare all identity fields including the source.
    if len(matches) > 1:
        stop('ambiguous_accepted_record')
    if not matches:
        if owner.get('result') != 'no_handoff_record' or active.get('result') != 'active':
            stop('unaccepted_pause_not_active')
        if active.get('active_pause') != {'pause_id':pause, 'reason':'developer_execution_failed'}:
            stop('different_active_pause')
        recs = [r['record'] for r in listing['records'] if r['pause_id'] == pause]
        if len(recs) != 1 or recs[0].get('kind') != 'pause' or recs[0].get('payload',{}).get('failed_action') != 'develop':
            stop('invalid_source_pause')
        return None, recs[0]
    match = matches[0]
    expected = {'version':1, 'kind':'ai-resume-accepted', 'target':'issue:'+str(issue_number),
                'reason':'developer_execution_failed', 'source_pause_id':pause,
                'payload':{'action':'handoff','actor':actor,'pr_number':pr,'pr_head':head}}
    if match['record'] != expected or owner.get('result') != 'handoff_owned':
        stop('accepted_identity_mismatch')
    if owner.get('accepted_record_id') != match['pause_id']:
        stop('accepted_provenance_mismatch')
    relevant = [c['effective'] for c in chain.get('chains',[]) if c.get('pre_resume',{}).get('pause_id') == pause]
    if relevant != [{'status':'consumed','pause_id':pause,'reason':'developer_execution_failed',
                     'accepted_record_id':match['pause_id']}]:
        stop('source_not_consumed')
    if active.get('result') != 'no_active_pause':
        stop('active_pause_persists')
    return match['pause_id'], None

def facts(issue, pr, actor, head):
    issue_fact = api('/repos/'+REPO+'/issues/'+str(issue))
    pr_fact = api('/repos/'+REPO+'/pulls/'+str(pr))
    pr_issue_fact = api('/repos/'+REPO+'/issues/'+str(pr))
    if issue_fact.get('number') != issue or issue_fact.get('state') != 'open' or 'pull_request' in issue_fact:
        stop('invalid_closing_issue')
    # No cryptographic claim about the last pusher: this is the repository's
    # positive *human-managed branch namespace* admission, not an author-only
    # negative match against developer-owned ai/issue-N.
    if (pr_fact.get('number') != pr or pr_fact.get('state') != 'open' or pr_fact.get('draft') is not True
        or pr_fact.get('user',{}).get('login') != actor or not HUMAN.fullmatch(actor)
        or pr_fact.get('head',{}).get('sha') != head
        or pr_fact.get('head',{}).get('repo',{}).get('full_name') != REPO
        or pr_fact.get('base',{}).get('repo',{}).get('full_name') != REPO
        or pr_fact.get('base',{}).get('ref') != 'main'
        or not pr_fact.get('head',{}).get('ref','').startswith('human/issue-'+str(issue)+'-')):
        stop('stale_or_invalid_pr')
    def label_state(f, number):
        labels = f.get('labels')
        if f.get('number') != number or f.get('state') != 'open' or type(labels) is not list:
            stop('invalid_labels')
        if any(type(x) is not dict or type(x.get('name')) is not str for x in labels):
            stop('invalid_labels')
        return 'human-review-required' in [l['name'] for l in labels]
    return label_state(issue_fact,issue), label_state(pr_issue_fact,pr), pr_fact['head']['ref']

def current_head_check(head, pr, branch):
    raw = parse(invoke(['gh','api','--paginate','--slurp',
                        '/repos/'+REPO+'/commits/'+head+'/check-runs?per_page=100']))
    if type(raw) is not list or not (1 <= len(raw) <= 10):
        stop('checks_incomplete')
    try:
        checks = sum((p['check_runs'] for p in raw), [])
        count = raw[0]['total_count']
        if not (num(count) and count == len(checks) and len(checks) < 1000): raise ValueError("invalid_trusted_snapshot")
        if not (all(type(c['id']) is int and c['head_sha'] == head for c in checks)): raise ValueError("invalid_trusted_snapshot")
    except (AssertionError, KeyError, TypeError, ValueError):
        stop('checks_incomplete')
    product = [c for c in checks if c.get('name') == 'Product CI']
    if len(product) != 1 or product[0].get('status') != 'completed' or product[0].get('conclusion') != 'success':
        stop('product_ci_not_success')
    ci = product[0]
    # The check name alone is not a trusted Product CI identity: another App
    # or workflow can publish a successful check with the same display name.
    if ci.get('app', {}).get('id') != 15368 or ci.get('app', {}).get('slug') != 'github-actions':
        stop('product_ci_provenance_invalid')
    link = ci.get('details_url')
    run_link = re.fullmatch(r'https://github\.com/suzukure/nssscdl/actions/runs/([1-9][0-9]*)/job/'
                            + str(ci['id']), link) if type(link) is str else None
    if run_link is None:
        stop('product_ci_run_link_invalid')
    run_id = int(run_link.group(1))
    run = api('/repos/' + REPO + '/actions/runs/' + str(run_id))
    if (run.get('id') != run_id or run.get('head_sha') != head or run.get('event') != 'pull_request'
        or run.get('path') != '.github/workflows/product-ci.yml'
        or run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        stop('product_ci_run_invalid')
    # Commit-level check-run success alone is not authorization for an unrelated
    # PR which happens to reference that SHA. Pin the trusted Actions run to
    # the exact PR, branch and repository; missing/ambiguous data fail closed.
    links = run.get('pull_requests')
    if (run.get('head_branch') != branch
        or run.get('repository', {}).get('full_name') != REPO
        or run.get('head_repository', {}).get('full_name') != REPO
        or not num(run.get('repository', {}).get('id'))
        or run.get('head_repository', {}).get('id') != run['repository']['id']
        or type(links) is not list or len(links) != 1):
        stop('product_ci_pr_identity_invalid')
    link_pr = links[0]
    if (not isinstance(link_pr, dict) or link_pr.get('number') != pr
        or link_pr.get('head', {}).get('sha') != head
        or link_pr.get('head', {}).get('ref') != branch
        or link_pr.get('head', {}).get('repo', {}).get('id') != run['repository']['id']
        or link_pr.get('base', {}).get('ref') != 'main'
        or link_pr.get('base', {}).get('repo', {}).get('id') != run['repository']['id']):
        stop('product_ci_pr_identity_invalid')

def command_fact(comment_id, issue, pause, pr, head):
    comment = api('/repos/'+REPO+'/issues/comments/'+str(comment_id))
    if (comment.get('id') != comment_id or comment.get('issue_url') != 'https://api.github.com/repos/'+REPO+'/issues/'+str(issue)
        or type(comment.get('created_at')) is not str or not comment['created_at']
        or comment.get('created_at') != comment.get('updated_at')
        or comment.get('author_association') not in ('OWNER','MEMBER','COLLABORATOR')
        or type(comment.get('user',{}).get('login')) is not str):
        stop('command_provenance_invalid')
    parsed = parse(shell_helper('parse-ai-resume-command', stdin=json.dumps({
        'actor': comment['user']['login'], 'author_association':comment['author_association'],
        'body':comment.get('body')})))
    if parsed != {'result':'accepted','action':'handoff','actor':comment['user']['login'],
                  'pause_id':pause,'pr_number':pr,'head_sha':head}:
        stop('command_identity_mismatch')
    return comment['user']['login'], comment['created_at']

def source_fact(pause, issue, command_id, command_time, app_id):
    original = api('/repos/'+REPO+'/issues/comments/'+pause)
    if (not num(original.get('id')) or str(original['id']) != pause or original['id'] >= command_id
        or original.get('issue_url') != 'https://api.github.com/repos/'+REPO+'/issues/'+str(issue)
        or original.get('performed_via_github_app',{}).get('id') != app_id
        or type(original.get('created_at')) is not str or original.get('updated_at') != original.get('created_at')
        or not original['created_at'] or original['created_at'] > command_time):
        stop('source_provenance_invalid')

def writer_terminal():
    # Conservative global absence proof; exclude only the verified current
    # Actions run of an eventual same-Issue consumer. Other active AI Developer
    # runs are treated as unresolved rather than guessed irrelevant.
    # `action_required` is a *completed conclusion* in the workflow-runs API,
    # not a live writer state. Including it would make an old approval-required
    # run permanently block handoff, even after the writer finished.
    for status in ('in_progress','queued','pending','waiting','requested'):
        page = api('/repos/'+REPO+'/actions/workflows/ai-developer.yml/runs?per_page=100&status='+status)
        if type(page.get('total_count')) is not int or type(page.get('workflow_runs')) is not list:
            stop('writer_run_state_unavailable')
        current_run = __import__('os').environ.get('GITHUB_RUN_ID','')
        own = [x for x in page['workflow_runs'] if str(x.get('id')) == current_run and status == 'in_progress']
        if page['total_count'] != len(own):
            stop('writer_run_nonterminal')

def collector(issue, cid, pause, pr, head, app):
    actor, when = command_fact(cid,issue,pause,pr,head)
    source_fact(pause,issue,cid,when,app)
    candidate = canonical_pr(issue,pr)
    if (candidate['isDraft'] is not True or candidate['headRefOid'] != head or candidate['baseRefName'] != 'main'
        or candidate.get('author',{}).get('login') != actor
        or candidate.get('headRepository',{}).get('nameWithOwner') != REPO
        or candidate.get('baseRepository',{}).get('nameWithOwner') != REPO):
        stop('pr_canonical_identity_mismatch')
    labels = facts(issue,pr,actor,head)
    current_head_check(head, pr, labels[2])
    writer_terminal()
    return actor,labels

def transition_label(number):
    # Never retry a request with uncertain outcome. Caller must read back.
    budget(90)  # Do not initiate a label write without readback budget.
    try:
        subprocess.run(['gh','issue','edit',str(number),'--repo',REPO,'--remove-label','human-review-required'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
    except subprocess.TimeoutExpired:
        pass  # The caller MUST still read back. Never issue a second remove.

def main():
    global issue_number
    if len(sys.argv) != 6:
        stop('invalid_arguments')
    repo, issue, command_id, app_id = sys.argv[2:]
    if repo != REPO or not all(DEC.fullmatch(v) for v in (issue,command_id,app_id)):
        stop('invalid_arguments')
    issue_number,cid,app = map(int,(issue,command_id,app_id))
    # Only the trusted command comment supplies the PR/head/pause binding.
    comment = api('/repos/'+REPO+'/issues/comments/'+str(cid))
    body = comment.get('body')
    hit = COMMAND.fullmatch(body) if type(body) is str else None
    if hit is None:
        stop('invalid_command')
    pause,pr_text,head = hit.groups()
    pr = int(pr_text)
    actor, labels = collector(issue_number,cid,pause,pr,head,app)
    record = {'version':1,'kind':'ai-resume-accepted','reason':'developer_execution_failed',
              'target':'issue:'+issue,'source_pause_id':pause,
              'payload':{'action':'handoff','actor':actor,'pr_number':pr,'pr_head':head}}
    shell_helper('human-pause-record','validate',json.dumps(record))
    state = graph(issue,app_id)
    accepted, source = accepted_status(state,pause,actor,pr,head)
    if accepted is None:
        # Only new acceptance goes through #1097 active-pause pure preflight.
        envelope = {'command':{'result':'accepted','action':'handoff','actor':actor,
                                'pause_id':pause,'pr_number':pr,'head_sha':head},
                    'target':'issue:'+issue,
                    'closing_issue':{'number':issue_number,'state':'open'},
                    'pause':{'result':'active','pause_id':pause,'reason':'developer_execution_failed','record':source},
                    'pull_request':{'number':pr,'state':'open','draft':True,'author_login':actor,
                                    'head_repo':REPO,'base_repo':REPO,'base_ref':'main',
                                    'head_sha':head,'closing_issue_numbers':[issue_number],
                                    'writer_runs_terminal':True,
                                    'checks':{'current_head':head,'result':'success'}}}
        output = parse(shell_helper('prepare-ai-resume-handoff',stdin=json.dumps(envelope)))
        if output.get('result') != 'prepared_snapshot_only' or output.get('write_authorized') is not False:
            stop('prepared_policy_failed')
        if labels[0] is not True:
            stop('source_label_not_paused')
        # Fresh readback before irreversible acceptance. Never POST if an
        # acceptance was added between the two snapshots.
        collector(issue_number,cid,pause,pr,head,app)
        before = graph(issue,app_id)
        already, _ = accepted_status(before,pause,actor,pr,head)
        if already is not None:
            stop('concurrent_acceptance_detected')
        record_body = shell_helper('human-pause-record','create',json.dumps(record))
        # Unknown response: one POST attempt only. All cases reconcile by graph.
        budget(90)  # Leave room to reconcile an uncertain POST.
        try:
            subprocess.run(['gh','api','-X','POST','/repos/'+REPO+'/issues/'+issue+'/comments',
                                   '-f','body='+record_body], capture_output=True,text=True, timeout=45)
        except subprocess.TimeoutExpired:
            # A cancelled HTTP request can already have committed its comment.
            # Continue to the one trusted graph readback; never retry POST.
            pass
        # Do not assume timeout, failed, or non-JSON response means absent write.
        after = graph(issue,app_id)
        accepted, _ = accepted_status(after,pause,actor,pr,head)
        if accepted is None:
            stop('unknown_post_no_verified_acceptance')
    # Existing unique acceptance is permitted only for post-accept cleanup.
    for number in (issue_number,pr):
        actor2, labels = collector(issue_number,cid,pause,pr,head,app)
        if actor2 != actor:
            stop('actor_changed')
        current, _ = accepted_status(graph(issue,app_id),pause,actor,pr,head)
        if current != accepted:
            stop('accepted_changed')
        present = labels[0] if number == issue_number else labels[1]
        if present:
            transition_label(number)
        # Fail-closed readback whether edit succeeded, failed or was skipped.
        fresh = facts(issue_number,pr,actor,head)
        if (fresh[0] if number == issue_number else fresh[1]) is not False:
            stop('label_transition_unconfirmed')
        # Never touch PR label unless Issue is already verified unpaused.
        if number == issue_number and fresh[0] is not False:
            stop('issue_label_still_paused')
    if accepted_status(graph(issue,app_id),pause,actor,pr,head)[0] != accepted:
        stop('final_accepted_mismatch')
    print(json.dumps({'result':'handoff_consumer_complete','accepted_record_id':accepted,
                      'issue':issue_number,'pr':pr,'draft_unchanged':True}))

try:
    main()
except Exception as err:
    code = str(err) if type(err) is Stop else 'runtime_or_api_shape_unknown'
    print('consume-ai-resume-handoff: STOP '+code, file=sys.stderr)
    sys.exit(1)
PY
