#!/usr/bin/env python3
"""Dormant trusted CONNECT forwarder; no npm execution or production wiring."""

import argparse
import ctypes
import errno
import functools
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import select
import socket
import socketserver
import ssl
import stat
import subprocess
import time


TARGET = "registry.npmjs.org:443"
HOST = "registry.npmjs.org"
TIMEOUT = 10
MAX_HEADER = 8192
MAX_TUNNEL_SECONDS = 60


class Rejected(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Rejected(reason)


def read_header(client):
    # Do not read past CONNECT headers into the opaque TLS stream.
    data = bytearray()
    deadline = time.monotonic() + TIMEOUT
    while not data.endswith(b"\r\n\r\n"):
        require(len(data) < MAX_HEADER, "header-too-large")
        remaining = deadline - time.monotonic()
        require(remaining > 0, "header-timeout")
        client.settimeout(remaining)
        byte = client.recv(1)
        require(bool(byte), "incomplete-header")
        data.extend(byte)
    client.settimeout(TIMEOUT)
    return bytes(data)


def authorize(header):
    require(len(header) <= MAX_HEADER and header.endswith(b"\r\n\r\n"), "invalid-header")
    lines = header[:-4].split(b"\r\n")
    require(lines[0] == b"CONNECT registry.npmjs.org:443 HTTP/1.1", "target-denied")
    fields = {}
    for line in lines[1:]:
        key, separator, value = line.partition(b":")
        require(separator and key and all(c in b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-"
                                         for c in key), "invalid-header")
        key = key.lower()
        require(key not in fields, "invalid-header")
        fields[key] = value.strip(b" \t")
    require(fields.get(b"host") == TARGET.encode("ascii"), "allowlist-mismatch")
    # Minimal CONNECT interface, without bodies, credentials, or alternate routing.
    require(set(fields) <= {b"host", b"user-agent", b"proxy-connection", b"connection"},
            "unsupported-header")
    require(all(all(32 <= c < 127 for c in value) for value in fields.values()),
            "invalid-header")


def connect_registry():
    # Resolve ONLY the fixed host, then connect to a checked numeric address.
    # A mixed/private answer is rejected rather than tried as an alternate route.
    answers = socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    require(bool(answers), "registry-resolution-failed")
    for family, kind, protocol, _, address in answers:
        require(family in (socket.AF_INET, socket.AF_INET6)
                and kind == socket.SOCK_STREAM and protocol == socket.IPPROTO_TCP
                and address[1] == 443 and ipaddress.ip_address(address[0]).is_global,
                "registry-address-denied")
    family, kind, protocol, _, address = answers[0]
    upstream = socket.socket(family, kind, protocol)
    try:
        upstream.settimeout(TIMEOUT)
        upstream.connect(address)
        return upstream
    except BaseException:
        upstream.close()
        raise


def relay(client, upstream):
    deadline = time.monotonic() + MAX_TUNNEL_SECONDS
    while time.monotonic() < deadline:
        ready, _, _ = select.select([client, upstream], [], [], min(1, deadline - time.monotonic()))
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            destination = upstream if source is client else client
            destination.sendall(data)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        established = False
        try:
            authorize(read_header(self.request))
            with connect_registry() as upstream:
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                established = True
                relay(self.request, upstream)
        except Rejected:
            if not established:
                self.reply(403)
        except (OSError, ValueError):
            if not established:
                self.reply(502)
        # No request, header, body, package payload, exception text, or credentials logged.

    def reply(self, status):
        try:
            self.request.sendall(f"HTTP/1.1 {status} Rejected\r\nContent-Length: 0\r\n"
                                 "Connection: close\r\n\r\n".encode("ascii"))
        except OSError:
            pass


class Proxy(socketserver.ThreadingTCPServer):
    # Bound resource use; each tunnel has an absolute lifetime and bounded reads.
    daemon_threads = False
    block_on_close = True

    def __init__(self, port):
        import threading
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(("127.0.0.1", port), Handler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # socketserver's default traceback could disclose supplied request data.
        pass


def exchange(port, request):
    with socket.create_connection(("127.0.0.1", port), TIMEOUT) as client:
        client.sendall(request)
        header = read_header(client)
        return header.split(b"\r\n", 1)[0]


def registry_get(port):
    # No environment proxy discovery, redirect following, auth, or direct fallback.
    with socket.create_connection(("127.0.0.1", port), TIMEOUT) as client:
        client.sendall(b"CONNECT registry.npmjs.org:443 HTTP/1.1\r\n"
                       b"Host: registry.npmjs.org:443\r\n\r\n")
        require(read_header(client).startswith(b"HTTP/1.1 200 "), "proxy-unavailable")
        with ssl.create_default_context().wrap_socket(client, server_hostname=HOST) as tls:
            tls.sendall(b"GET /is-number/7.0.0 HTTP/1.1\r\nHost: registry.npmjs.org\r\n"
                        b"Accept: application/json\r\nConnection: close\r\n\r\n")
            response = http.client.HTTPResponse(tls)
            try:
                response.begin()
                require(response.status == 200, "registry-response-rejected")
                body = response.read(65537)
                require(len(body) <= 65536, "registry-response-too-large")
                metadata = json.loads(body)
                require(isinstance(metadata, dict) and metadata.get("name") == "is-number"
                        and metadata.get("version") == "7.0.0", "registry-metadata-mismatch")
            finally:
                response.close()
    return {"target": TARGET, "tls_verified": True, "http_status": 200}


@functools.cache
def primitive():
    source = Path(__file__).with_name("codex-network-boundary.py")
    spec = importlib.util.spec_from_file_location("network_boundary", source)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def verify_snapshot(unit, path):
    require(re.fullmatch(r"codex-network-probe-[0-9a-f]{32}\.service", unit) is not None,
            "invalid-unit")
    require(path.parent == Path(__file__).resolve().parent
            and path.name == unit + ".json", "invalid-property-snapshot")
    deadline = time.monotonic() + 10
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0
                and not os.access(path, os.W_OK), "unsafe-property-snapshot")
        data = stream.read(4097)
        require(len(data) <= 4096, "invalid-property-snapshot")
    record = json.loads(data)
    require(isinstance(record, dict) and set(record) == {"unit", "properties"}
            and isinstance(record["properties"], str), "invalid-property-snapshot")
    require(record["unit"] == unit, "property-unit-mismatch")
    primitive().validate_properties(record["properties"])


def preflight(args):
    # Observe immutable trusted source and separate proxy identity BEFORE communication.
    directory = Path(__file__).resolve().parent
    require(os.getuid() != args.proxy_uid and os.getuid() != 0, "unsafe-proxy-identity")
    for path in (directory, Path(__file__), directory / "codex-network-boundary.py"):
        info = path.stat()
        require(info.st_uid == 0 and info.st_mode & 0o022 == 0, "unsafe-trusted-source")
        require(not os.access(path, os.W_OK), "trusted-source-writable")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines()
                  if ":" in line)
    require(status["NoNewPrivs"].strip() == "1" and all(int(status[name].strip(), 16) == 0
            for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")), "unsafe-privileges")
    require(platform.machine() in ("x86_64", "aarch64"), "unsupported-syscall-architecture")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    for number in (425, 426, 427):
        ctypes.set_errno(0)
        result = libc.syscall(ctypes.c_long(number), ctypes.c_long(-1), ctypes.c_long(0),
                              ctypes.c_long(0), ctypes.c_long(0), ctypes.c_long(0), ctypes.c_long(0))
        require(result == -1 and ctypes.get_errno() == errno.EPERM, "io-uring-deny-missing")
    require(len(args.protected_paths) == 13, "protected-socket-list-mismatch")
    for path in args.protected_paths:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            try:
                client.connect(path)
            except OSError as error:
                require(error.errno in (errno.EACCES, errno.EPERM, errno.ENOENT),
                        "protected-socket-deny-unconfirmed")
            else:
                raise Rejected("protected-socket-accessible")


def verify_boundary(args):
    preflight(args)
    # Verify the real filter and direct deny BEFORE trying the registry tunnel.
    network = primitive().probe(args.address, args.port, args.ipv6_port, args.unit,
                                verifier=lambda unit: verify_snapshot(unit, args.properties_file))
    for request in (
        b"CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n",
        b"GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n",
        b"CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n",
    ):
        try:
            reply = exchange(args.proxy_port, request)
        except OSError:
            raise Rejected("proxy-unavailable") from None
        require(reply == b"HTTP/1.1 403 Rejected", "proxy-deny-missing")
    return network


def probe(args):
    network = verify_boundary(args)
    evidence = registry_get(args.proxy_port)
    return {"status": "pass", "network": network, "proxy": evidence,
            "arbitrary_connect": 403, "arbitrary_http": 403, "allowlist_mismatch": 403,
            "trusted_source": "read-only", "proxy_identity": "separate-uid"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    commands = parser.add_subparsers(dest="command", required=True)
    server = commands.add_parser("serve", allow_abbrev=False)
    server.add_argument("--port", type=int, default=0)
    check = commands.add_parser("probe", allow_abbrev=False)
    for name in ("port", "ipv6-port", "proxy-port", "proxy-uid"):
        check.add_argument("--" + name, type=int, required=True)
    check.add_argument("--address", required=True)
    check.add_argument("--unit", required=True)
    check.add_argument("--properties-file", type=Path, required=True)
    check.add_argument("--protected-paths", nargs="+", required=True)
    args = parser.parse_args()
    try:
        if args.command == "serve":
            require(args.port == 0 or 1024 <= args.port <= 65535, "invalid-port")
            with Proxy(args.port) as proxy:
                print(json.dumps({"status": "ready", "address": "127.0.0.1",
                                  "port": proxy.server_address[1], "target": TARGET}), flush=True)
                proxy.serve_forever(poll_interval=0.1)
        else:
            require(all(1024 <= value <= 65535 for value in
                        (args.port, args.ipv6_port, args.proxy_port)), "invalid-port")
            result = probe(args)
            print(json.dumps(result, sort_keys=True))
    except Rejected as error:
        print(json.dumps({"status": "error", "reason": str(error)}))
        return 1
    except (OSError, ValueError, TypeError, subprocess.SubprocessError,
            http.client.HTTPException, primitive().Rejected):
        # Fixed diagnostic only; never print HTTP payloads or raw TLS errors.
        print(json.dumps({"status": "error", "reason": "registry-boundary-unavailable"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
