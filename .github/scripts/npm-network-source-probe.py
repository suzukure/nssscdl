#!/usr/bin/env python3
"""Dormant #652 fixture: real npm/git sources inside the unchanged #649 boundary."""

import argparse
import errno
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import threading


def proxy_helper():
    spec = importlib.util.spec_from_file_location(
        "source_registry_proxy", Path(__file__).with_name("npm-registry-proxy.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SourceEndpoints:
    """Trusted runner-local HTTP controls; never resolve or dial an external host."""
    def __init__(self, address):
        self.accepted = 0
        self.http = self.udp = None
        self.threads = []
        self.stop = threading.Event()
        owner = self

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = False
            def get_request(self):
                client, peer = super().get_request()
                client.settimeout(2)
                owner.accepted += 1
                return client, peer

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/escape-fixture":
                    body = json.dumps({"name": "escape-fixture", "dist-tags": {"latest": "1.0.0"},
                                       "versions": {"1.0.0": {"name": "escape-fixture",
                                                                "version": "1.0.0"}}}).encode()
                    kind = "application/json"
                elif self.path == "/repo.git/info/refs?service=git-upload-pack":
                    # Valid empty smart-HTTP repository advertisement; no clone/install.
                    line = b"# service=git-upload-pack\n"
                    body = f"{len(line) + 4:04x}".encode() + line + b"00000000"
                    kind = "application/x-git-upload-pack-advertisement"
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        try:
            self.http = Server((address, 0), Handler)
            self.port = self.http.server_port
            self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.udp.bind((address, self.port))
            self.udp.settimeout(0.1)
            thread = threading.Thread(target=self.http.serve_forever,
                                      kwargs={"poll_interval": 0.05})
            thread.start()
            self.threads.append(thread)
            thread = threading.Thread(target=self.echo)
            thread.start()
            self.threads.append(thread)
        except BaseException:
            self.close()
            raise

    def echo(self):
        while not self.stop.is_set():
            try:
                body, peer = self.udp.recvfrom(64)
            except socket.timeout:
                continue
            self.udp.sendto(body, peer)

    def close(self):
        self.stop.set()
        if self.http:
            if self.threads:
                self.http.shutdown()
            self.http.server_close()
        for thread in self.threads:
            thread.join(3)
            assert not thread.is_alive(), "source listener cleanup failed"
        if self.udp:
            self.udp.close()
        assert not self.http or self.http.socket.fileno() == -1
        assert not self.udp or self.udp.fileno() == -1


def execute(command, cwd, env, direct=False):
    # npm may spawn git. Kill the entire process group on timeout, including locally.
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=5 if direct else 10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=3)
        if direct:
            return {"result": "timeout", "timeout_seconds": 5}, "", ""
        raise
    finally:
        # Remove any subprocess still in the group after its parent exits.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return {"result": "exited", "returncode": process.returncode}, stdout, stderr


def failed(result):
    return result["result"] == "timeout" or result.get("returncode", 0) > 0


def sources(args, proxy):
    require = proxy.require
    proxy.primitive().validate_endpoint(args.address, args.source_port)
    udp = proxy.primitive().udp(args.address, args.source_port)
    restricted = args.mode != "control"
    require(udp == ({"result": "error", "errno": errno.EPERM} if restricted else
                    {"result": "received"}), "source-port-filter-unconfirmed")
    for name in ("node", "npm", "git"):
        path = getattr(args, name)
        require(path.is_absolute() and path.is_file() and not os.access(path, os.W_OK),
                "unsafe-source-runtime")
    evidence = {"source_port_udp": udp}
    with tempfile.TemporaryDirectory(prefix="npm-source-probe-") as directory:
        root = Path(directory)
        config = root / "empty.npmrc"
        config.touch()
        global_config = root / "global.npmrc"
        global_config.touch()
        env = {"PATH": str(args.node.parent) + ":" + str(args.git.parent) + ":/usr/bin:/bin",
               "HOME": directory, "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
        npm = [str(args.node), str(args.npm), "--userconfig=" + str(config),
               "--globalconfig=" + str(global_config), "--cache=" + str(root / "cache"),
               "--ignore-scripts", "--package-lock=false", "--audit=false", "--fund=false",
               "--fetch-retries=0", "--fetch-timeout=2500", "--allow-git=all",
               "--allow-remote=all"]
        git = [str(args.git), "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=2"]
        local = f"http://{args.address}:{args.source_port}"
        for name, command in (
            ("npm_direct", [*npm, "--proxy=", "--https-proxy=", "view", "escape-fixture",
                            "version", "--registry=" + local]),
            ("git_direct", [*git, "-c", "http.proxy=", "ls-remote", local + "/repo.git"]),
        ):
            result, stdout, stderr = execute(command, root, env, direct=restricted)
            require(failed(result) if restricted else result.get("returncode") == 0,
                    name + "-unexpected-result")
            if not restricted and name == "npm_direct":
                require(stdout.strip() == "1.0.0", "npm-control-mismatch")
            evidence[name] = result
        if restricted:
            endpoint = f"http://127.0.0.1:{args.proxy_port}"
            # Numeric runner-local targets make even an accidental client fallback local.
            remote = f"https://{args.address}:{args.source_port}"
            proxied_env = {**env, "HTTPS_PROXY": endpoint, "https_proxy": endpoint,
                           "HTTP_PROXY": endpoint, "http_proxy": endpoint,
                           "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.proxy",
                           "GIT_CONFIG_VALUE_0": endpoint}
            for name, command in (
                ("git_https", [*git, "ls-remote", remote + "/repo.git"]),
                ("npm_git_https", [*npm, "--proxy=" + endpoint, "--https-proxy=" + endpoint,
                                   "cache", "add", "git+" + remote + "/repo.git"]),
                ("npm_remote_tarball", [*npm, "--proxy=" + endpoint, "--https-proxy=" + endpoint,
                                        "cache", "add", remote + "/escape-fixture.tgz"]),
            ):
                result, stdout, stderr = execute(command, root, proxied_env)
                output = stdout + stderr
                require(result.get("returncode", 0) > 0, name + "-accepted")
                if name == "npm_git_https":
                    require("git" in output and "ls-remote" in output,
                            "npm-git-subprocess-unconfirmed")
                    result["git_subprocess"] = True
                if args.mode == "unavailable":
                    require("ECONNREFUSED" in output or "Failed to connect to 127.0.0.1" in output,
                            name + "-proxy-failure-unconfirmed")
                    result["proxy"] = "unavailable"
                else:
                    require(re.search(r"\b(?:E403|response 403|403 (?:Forbidden|Rejected))\b", output)
                            is not None, name + "-proxy-deny-unconfirmed")
                    result["proxy_http_status"] = 403
                evidence[name] = result
        require(not list(root.rglob("*lock*.json")) and not (root / "node_modules").exists(),
                "unexpected-lock-or-install")
    evidence["disposable_directory"] = "removed"
    require(not root.exists(), "source-directory-cleanup-failed")
    return evidence


def probe(args, proxy):
    if args.mode == "control":
        network = proxy.primitive().probe(args.address, args.port, args.ipv6_port)
        boundary = {"network": network}
    elif args.mode == "restricted":
        # #649 positive proof and source/UID/socket/syscall checks, before npm/git.
        boundary = proxy.probe(args)
    else:
        proxy.preflight(args)
        network = proxy.primitive().probe(args.address, args.port, args.ipv6_port, args.unit,
                    verifier=lambda unit: proxy.verify_snapshot(unit, args.properties_file))
        boundary = {"network": network, "proxy": "unavailable"}
    return {**boundary, "status": "pass", "mode": args.mode, "sources": sources(args, proxy)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("command", choices=["probe"])
    parser.add_argument("--mode", choices=["control", "restricted", "unavailable"], required=True)
    parser.add_argument("--address", required=True)
    for name in ("port", "ipv6-port", "source-port"):
        parser.add_argument("--" + name, type=int, required=True)
    for name in ("node", "npm", "git"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("proxy-port", "proxy-uid"):
        parser.add_argument("--" + name, type=int)
    parser.add_argument("--unit")
    parser.add_argument("--properties-file", type=Path)
    parser.add_argument("--protected-paths", nargs="+")
    args = parser.parse_args()
    proxy = proxy_helper()
    try:
        if args.mode != "control":
            proxy.require(all(value is not None for value in (args.proxy_port, args.proxy_uid,
                          args.unit, args.properties_file, args.protected_paths)), "boundary-input-missing")
            proxy.require(1024 <= args.proxy_port <= 65535, "invalid-port")
            info = Path(__file__).stat()
            proxy.require(info.st_uid == 0 and info.st_mode & 0o022 == 0
                          and not os.access(__file__, os.W_OK), "unsafe-source-probe")
        result = probe(args, proxy)
    except (proxy.Rejected, proxy.primitive().Rejected) as error:
        result = {"status": "error", "reason": str(error)}
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        result = {"status": "error", "reason": "source-probe-unavailable"}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
