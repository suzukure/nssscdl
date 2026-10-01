#!/usr/bin/env python3
"""Independent runner fixture, never a production launcher."""

import importlib.util
import errno
import json
import os
from pathlib import Path
import re
import select
import socket
import subprocess
import threading
import time
import uuid


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Servers:
    """Local-only control endpoints for the unchanged #646 probe."""
    def __init__(self, address):
        self.sockets = []
        self.accepted = 0
        self.thread = None
        self.stop = threading.Event()
        try:
            self.port = self.bind(socket.AF_INET, socket.SOCK_STREAM, "127.0.0.1", 0)
            self.non_loopback = self.bind(socket.AF_INET, socket.SOCK_STREAM, address, self.port)
            self.bind(socket.AF_INET, socket.SOCK_DGRAM, "127.0.0.1", self.port)
            self.bind(socket.AF_INET, socket.SOCK_DGRAM, address, self.port)
            self.ipv6_port = self.bind(socket.AF_INET6, socket.SOCK_STREAM, "::1", 0)
            self.thread = threading.Thread(target=self.serve)
            self.thread.start()
        except BaseException:
            self.close()
            raise

    def bind(self, family, kind, address, port):
        server = socket.socket(family, kind)
        self.sockets.append(server)
        server.bind((address, port))
        if kind == socket.SOCK_STREAM:
            server.listen(8)
        server.setblocking(False)
        return server.getsockname()[1]

    def serve(self):
        while not self.stop.is_set():
            ready, _, _ = select.select(self.sockets, [], [], 0.05)
            for server in ready:
                if server.type == socket.SOCK_STREAM:
                    client, _ = server.accept()
                    if server.getsockname()[0] not in ("127.0.0.1", "::1"):
                        self.accepted += 1
                    with client:
                        client.sendall(b"network-probe")
                else:
                    body, peer = server.recvfrom(64)
                    server.sendto(body, peer)

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(3)
            assert not self.thread.is_alive(), "local server cleanup failed"
        for server in self.sockets:
            server.close()


def hardening(repo):
    workflow = (repo / ".github/workflows/ai-developer.yml").read_text()
    masks = re.findall(r'protected_unix_socket_paths="([^"]+)"', workflow)
    assert len(masks) == 2 and masks[0] == masks[1], "production socket mask drift"
    filters = re.findall(r'--property="(SystemCallFilter=[^"]+)"', workflow)
    assert len(filters) == 2 and filters[0] == filters[1], "production syscall filter drift"
    return ("NoNewPrivileges=yes", "CapabilityBoundingSet=", "AmbientCapabilities=",
            "SupplementaryGroups=", "SystemCallArchitectures=native", filters[0],
            "InaccessiblePaths=" + " ".join("-" + path for path in masks[0].split()),
            "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes")


def service(repo, staged, address, servers, proxy_port=None, expect_error=False):
    boundary = load(staged / "codex-network-boundary.py", "runtime_network_boundary")
    unit = "codex-network-probe-" + uuid.uuid4().hex + ".service"
    properties = ("Type=exec", "RuntimeMaxSec=45s", "TimeoutStopSec=2s",
                  "KillMode=control-group", "SendSIGKILL=yes", "User=nobody", "Group=nogroup",
                  *hardening(repo))
    script = "codex-network-boundary.py"
    arguments = ["probe", "--address", address, "--port", str(servers.port),
                 "--ipv6-port", str(servers.ipv6_port)]
    if proxy_port is not None:
        properties += boundary.PROPERTIES
        script = "npm-registry-proxy.py"
        arguments += ["--unit", unit, "--proxy-port", str(proxy_port),
                      "--proxy-uid", str(os.getuid()),
                      "--properties-file", str(staged / (unit + ".json")), "--protected-paths",
                      *next(value.split("=", 1)[1].split() for value in hardening(repo)
                            if value.startswith("InaccessiblePaths="))]
        # systemd's optional '-' prefix is not part of the filesystem path.
        arguments = [value[1:] if value.startswith("-/run/") else value for value in arguments]
    command = ["sudo", "-n", "/usr/bin/systemd-run", "--quiet", "--wait", "--pipe", "--collect",
               "--unit=" + unit, *["--property=" + value for value in properties],
               "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LC_ALL=C", "PYTHONDONTWRITEBYTECODE=1",
               "/usr/bin/python3", "-I", str(staged / script), *arguments]
    observer_errors = []
    done = threading.Event()

    def observe():
        try:
            deadline = time.monotonic() + 10
            while not done.is_set() and time.monotonic() < deadline:
                shown = subprocess.run(["sudo", "-n", "/usr/bin/systemctl", "show", unit,
                                        "--no-pager", "--property=IPAddressDeny",
                                        "--property=IPAddressAllow"],
                                       capture_output=True, text=True, timeout=5)
                if shown.returncode == 0 and "IPAddressDeny=" in shown.stdout:
                    boundary.validate_properties(shown.stdout)
                    record = json.dumps({"unit": unit, "properties": shown.stdout})
                    # Atomic root-owned snapshot, never writable by the service or proxy.
                    writer = ("import os,sys; p=sys.argv[1]; "
                              "f=os.open(p+'.tmp',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o444); "
                              "os.write(f,sys.argv[2].encode()); os.close(f); os.rename(p+'.tmp',p)")
                    subprocess.run(["sudo", "-n", "/usr/bin/python3", "-I", "-c", writer,
                                    str(staged / (unit + ".json")), record], check=True, timeout=5)
                    return
                done.wait(0.05)
            raise AssertionError("effective property snapshot unavailable")
        except BaseException as error:
            observer_errors.append(error)

    observer = threading.Thread(target=observe) if proxy_port is not None else None
    try:
        if observer:
            observer.start()
        result = subprocess.run(command, capture_output=True, text=True, timeout=55)
        if observer:
            observer.join(12)
            assert not observer.is_alive() and not observer_errors, \
                (observer_errors, result.returncode, result.stdout, result.stderr)
        evidence = json.loads(result.stdout) if result.stdout else None
        if expect_error:
            assert result.returncode != 0 and evidence == {"status": "error", "reason": "proxy-unavailable"}, \
                (result.returncode, result.stdout, result.stderr)
        else:
            assert result.returncode == 0 and evidence and evidence["status"] == "pass", \
                (result.returncode, result.stdout, result.stderr)
        print(json.dumps(evidence, sort_keys=True), flush=True)
        return evidence
    finally:
        done.set()
        if observer:
            observer.join(12)
            assert not observer.is_alive(), "property observer cleanup failed"
        subprocess.run(["sudo", "-n", "/usr/bin/systemctl", "stop", unit],
                       capture_output=True, timeout=10)
        state = subprocess.run(["sudo", "-n", "/usr/bin/systemctl", "show", unit,
                                "--property=LoadState", "--value"],
                               capture_output=True, text=True, timeout=10)
        assert state.returncode in (0, 1) and state.stdout.strip() == "not-found", \
            ("unit cleanup unconfirmed", unit, state.stdout, state.stderr)


def stop_proxy(process):
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)
    assert process.poll() is not None, "proxy cleanup unconfirmed"
    if process.stdout:
        process.stdout.close()


def verify_proxy_stopped(port):
    # TIME_WAIT can prevent rebind after exit; check listener absence instead.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        try:
            client.connect(("127.0.0.1", port))
        except OSError as error:
            assert error.errno == errno.ECONNREFUSED, \
                ("proxy listener cleanup unconfirmed", error)
        else:
            raise AssertionError("proxy listener still reachable")


def start_proxy(staged):
    process = subprocess.Popen(["/usr/bin/python3", "-I", str(staged / "npm-registry-proxy.py"),
                                "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL,
                               env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    try:
        ready, _, _ = select.select([process.stdout], [], [], 5)
        assert ready, "proxy readiness timeout"
        # Binary unbuffered OS read cannot wait indefinitely for a partial line.
        record = json.loads(os.read(process.stdout.fileno(), 1024))
        assert record["status"] == "ready" and record["target"] == "registry.npmjs.org:443"
        assert record["address"] == "127.0.0.1" and 1024 <= record["port"] <= 65535
        return process, record["port"]
    except BaseException:
        stop_proxy(process)
        raise


def snapshot(repo):
    masks = re.search(r'protected_unix_socket_paths="([^"]+)"',
                      (repo / ".github/workflows/ai-developer.yml").read_text()).group(1).split()
    metadata = []
    for name in masks:
        try:
            info = os.stat(name)
        except FileNotFoundError:
            continue
        metadata.append((name, info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode))
    resolver = subprocess.check_output(["/usr/bin/systemctl", "show", "systemd-resolved.service",
                                       "--no-pager", "--property=ActiveState", "--property=SubState",
                                       "--property=MainPID", "--property=NRestarts"], text=True)
    return metadata, resolver


def runtime(repo):
    assert os.getuid() != 0, "independent runtime requires non-root runner UID"
    subprocess.run(["sudo", "-n", "true"], check=True, timeout=5)
    boundary = load(repo / ".github/scripts/codex-network-boundary.py", "runtime_boundary")
    addresses = sorted(boundary.local_addresses())
    assert addresses, "no assigned non-loopback IPv4; fail closed"
    before = snapshot(repo)
    # Root-owned directory AND copies; mode 0700 under runner UID alone is insufficient.
    staged = Path(subprocess.check_output(["sudo", "-n", "mktemp", "-d",
                                          "/run/npm-registry-fixture-XXXXXXXX"], text=True).strip())
    assert re.fullmatch(r"/run/npm-registry-fixture-[A-Za-z0-9]{8}", str(staged)), "unsafe staging path"
    try:
        subprocess.run(["sudo", "-n", "chmod", "0755", str(staged)], check=True, timeout=5)
        for name in ("npm-registry-proxy.py", "codex-network-boundary.py"):
            subprocess.run(["sudo", "-n", "install", "-o", "root", "-g", "root", "-m", "0444",
                            str(repo / ".github/scripts" / name), str(staged / name)],
                           check=True, timeout=5)
        for cycle in range(2):
            started = time.monotonic()
            servers = Servers(addresses[0])
            proxy = None
            try:
                proxy, port = start_proxy(staged)
                service(repo, staged, addresses[0], servers)
                assert servers.accepted == 1
                service(repo, staged, addresses[0], servers, port)
                assert servers.accepted == 1, "restricted direct TCP reached listener"
                service(repo, staged, addresses[0], servers)
                assert servers.accepted == 2 and servers.thread.is_alive()
                stop_proxy(proxy)
                # Unavailable proxy fails the SAME restricted service, without direct fallback.
                service(repo, staged, addresses[0], servers, port, expect_error=True)
                assert servers.accepted == 2, "fallback reached direct listener"
                verify_proxy_stopped(port)
            finally:
                if proxy:
                    stop_proxy(proxy)
                servers.close()
            assert all(server.fileno() == -1 for server in servers.sockets)
            print(json.dumps({"cycle": cycle + 1, "elapsed_seconds": round(time.monotonic() - started, 2),
                              "cleanup": "pass"}), flush=True)
    finally:
        subprocess.run(["sudo", "-n", "rm", "-rf", "--", str(staged)], check=True, timeout=10)
        assert not staged.exists(), "trusted fixture directory cleanup failed"
        assert snapshot(repo) == before, "host socket/resolver integrity changed"
