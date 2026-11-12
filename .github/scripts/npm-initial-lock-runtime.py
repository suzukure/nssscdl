#!/usr/bin/env python3
"""Dormant #660 local registry and independent initial-lock runner fixture."""
import base64
import errno
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
import uuid
import importlib.util

ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
NAME = 'initial-lock-dependency'


def lifecycle(repo):
    spec = importlib.util.spec_from_file_location(
        'initial_lock_lifecycle', repo / '.github/scripts/npm-lifecycle-boundary-runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def manifest(repo, token):
    value = {'name': 'initial-lock-project', 'version': '1.0.0',
             'dependencies': {NAME: '1.0.0'}, 'scripts': lifecycle(repo).scripts(token, 'project')}
    # Reuse authoritative #645 policy; fixture source does not relax Product policy.
    lifecycle(repo).filesystem(repo).validate_manifest(repo, value)
    return value


def dependency(repo, token):
    return {'name': NAME, 'version': '1.0.0',
            'scripts': lifecycle(repo).scripts(token, 'dependency')}


def archive(value, writer):
    # Deterministic package contents built directly; never invoke npm pack.
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as output:
        for name, content in [('package.json', json.dumps(value, sort_keys=True).encode()),
                              ('lifecycle-marker.js', writer)]:
            info = tarfile.TarInfo('package/' + name)
            info.size, info.mode, info.mtime = len(content), 0o644, 0
            output.addfile(info, io.BytesIO(content))
    return gzip.compress(buffer.getvalue(), mtime=0)


class Registry:
    """No upstream sockets/DNS. Log metadata vs content requests on trusted side."""
    def __init__(self, value, writer):
        self.requests = []
        self.payload = archive(value, writer)
        self.value = value
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(2)

            def do_GET(self):
                owner.requests.append(('GET', self.path))
                if self.path == '/' + NAME:
                    version = {**owner.value, 'hasInstallScript': True, 'dist': {
                        'tarball': owner.url + NAME + '/-/' + NAME + '-1.0.0.tgz',
                        'integrity': 'sha512:' + base64.b64encode(
                            hashlib.sha512(owner.payload).digest()).decode()}}
                    data = json.dumps({'name': NAME, 'dist-tags': {'latest': '1.0.0'},
                                       'versions': {'1.0.0': version}}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                else:
                    # Content fetch is unsupported by this proof, not a script
                    # suppression success. Even an attempted fetch fails evidence.
                    data = b'unsupported fixture request'
                    self.send_response(403)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                owner.requests.append(('POST', self.path))
                self.send_error(403)

            def send_error(self, code, message=None, explain=None):
                if code == 501:
                    owner.requests.append((self.command, self.path))
                super().send_error(code, message, explain)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        assert 1024 <= self.port <= 65535
        self.url = f'http://127.0.0.1:{self.port}/'
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={'poll_interval': 0.05})

    def __enter__(self):
        try:
            self.thread.start()
        except BaseException:
            self.server.server_close()
            raise
        return self

    def evidence(self):
        assert self.requests and all(item == ('GET', '/' + NAME) for item in self.requests), \
            'dependency content/unsupported request observed'
        return {'metadata_requests': len(self.requests), 'tarball_requests': 0,
                'dependency_execution_path': 'not-entered'}

    def __exit__(self, *args):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()
        assert not self.thread.is_alive(), 'registry thread cleanup failed'
        with socket.socket() as check:
            check.settimeout(2)
            try:
                check.connect(('127.0.0.1', self.port))
            except OSError as error:
                assert error.errno == errno.ECONNREFUSED, 'registry cleanup unconfirmed'
            else:
                raise AssertionError('registry still listening')


def build_root(repo, root, node, npm, token, host_marker):
    previous = lifecycle(repo)
    previous.build_root(repo, root, node, npm, token)
    writer = root / 'project/lifecycle-marker.js'
    # The host sentinel is deliberately writable by the service UID outside
    # isolation. Inside RootDirectory it is absent; execution still makes the
    # project marker. Neither control runs an enabled lifecycle script.
    writer.write_text("try{require('node:fs').appendFileSync(" + json.dumps(str(host_marker)) +
                      ",process.argv[2]+'\\n');}catch(e){if(e.code!=='ENOENT')throw e;}\n" +
                      writer.read_text())
    (root / 'project/package.json').write_text(json.dumps(manifest(repo, token)))
    (root / 'project/fixture').mkdir()
    (root / 'project/fixture/package.json').write_text(json.dumps(dependency(repo, token)))
    shutil.copy2(root / 'project/lifecycle-marker.js', root / 'project/fixture/lifecycle-marker.js')
    shutil.copy2(repo / '.github/scripts/npm-initial-lock-probe.js', root / 'runtime/probe.js')
    # Built-in config is also part of the disposable exact config contract.
    builtin = root / 'runtime/npm/npmrc'
    assert not builtin.is_symlink(), 'unsupported built-in npmrc symlink'
    builtin.write_text('')
    for entry in (root / 'project').rglob('*'):
        entry.chmod(0o755 if entry.is_dir() else 0o644)
    (root / 'runtime/npm/npmrc').chmod(0o644)


def runtime(repo, node, npm):
    assert os.getuid() != 0, 'independent runtime requires non-root runner UID'
    boundary = lifecycle(repo).filesystem(repo)
    roots = []
    for cycle in range(2):
        staged = Path(subprocess.check_output(['sudo', '-n', 'mktemp', '-d',
                      '/run/npm-filesystem-fixture-XXXXXXXX'], text=True, timeout=5, env=ENV).strip())
        assert re.fullmatch(r'/run/npm-filesystem-fixture-[A-Za-z0-9]{8}', str(staged))
        roots.append(staged)
        token = uuid.uuid4().hex
        host = None
        record = {'token': token, 'hidden': {'workspace-root': str(repo),
                  'repository-head': str(repo / '.git/HEAD'), 'host-env': '/usr/bin/env',
                  'host-os-release': '/etc/os-release', 'staging-root': str(staged)}}
        try:
            host = tempfile.TemporaryDirectory(prefix='npm-initial-lock-host-', dir='/tmp')
            host_marker = Path(host.name) / 'side-effects'
            Path(host.name).chmod(0o755)
            host_marker.write_text('')
            host_marker.chmod(0o666)
            record['hidden']['lifecycle-host-marker'] = str(host_marker)
            with tempfile.TemporaryDirectory(prefix='npm-initial-lock-build-') as build:
                root = Path(build) / 'root'
                build_root(repo, root, node, npm, token, host_marker)
                value = json.loads((root / 'project/fixture/package.json').read_text())
                writer = (root / 'project/lifecycle-marker.js').read_bytes()
                subprocess.run(['sudo', '-n', 'cp', '-a', str(root), str(staged / 'root')],
                               check=True, timeout=15, env=ENV)
            subprocess.run(['sudo', '-n', 'chown', '-R', 'root:root', str(staged)],
                           check=True, timeout=10, env=ENV)
            subprocess.run(['sudo', '-n', 'chmod', '0755', str(staged)],
                           check=True, timeout=5, env=ENV)
            subprocess.run(['sudo', '-n', 'chown', '-R', 'nobody:nogroup',
                            str(staged / 'root/project'), str(staged / 'root/tmp')],
                           check=True, timeout=5, env=ENV)
            with Registry(value, writer) as source:
                record['port'] = source.port
                # Exact #654 launcher/hardening/cleanup, not production integration.
                evidence = boundary.service(repo, staged / 'root', record)
                assert evidence['operations'] == ['config', 'lock']
                assert evidence['markers'] == [] and evidence['node_modules'] is False
                assert evidence['candidate'] == 'package-lock.json'
                assert host_marker.read_bytes() == b'', 'trusted-host lifecycle side effect detected'
                print(json.dumps({**evidence, **source.evidence(), 'host_side_effects': 0}), flush=True)
        finally:
            try:
                subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(staged)],
                               check=True, timeout=10, env=ENV)
                assert not staged.exists(), 'initial-lock root cleanup failed'
            finally:
                if host is not None:
                    host.cleanup()
                    assert not Path(host.name).exists(), 'host marker cleanup failed'
        print(json.dumps({'cycle': cycle + 1, 'cleanup': 'pass'}), flush=True)
    assert len(set(roots)) == 2, 'initial-lock root reused'
