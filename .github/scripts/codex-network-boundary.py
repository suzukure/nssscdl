#!/usr/bin/env python3
"""Dormant localhost-only systemd contract and local, secret-free probe."""

import argparse
import errno
import ipaddress
import json
import re
import socket
import subprocess


PROPERTIES = ("IPAddressDeny=any", "IPAddressAllow=localhost")
TIMEOUT = 2


class Rejected(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Rejected(reason)


def local_addresses():
    result = subprocess.run(["/usr/sbin/ip", "-j", "-4", "address", "show", "up"],
                            capture_output=True, text=True, check=True, timeout=5)
    return {item["local"] for interface in json.loads(result.stdout)
            for item in interface.get("addr_info", [])
            if item.get("family") == "inet" and item.get("scope") == "global"}


def validate_endpoint(address, port):
    try:
        parsed = ipaddress.IPv4Address(address)
    except ipaddress.AddressValueError:
        raise Rejected("invalid-address") from None
    require(str(parsed) == address and not parsed.is_loopback
            and not parsed.is_multicast and not parsed.is_unspecified
            and address != "255.255.255.255", "invalid-address")
    require(type(port) is int and 1024 <= port <= 65535, "invalid-port")
    # Never resolve names or probe an address not assigned to this runner.
    require(address in local_addresses(), "address-not-local")


def verify_properties(unit):
    require(re.fullmatch(r"codex-network-probe-[0-9a-f]{32}\.service", unit) is not None,
            "invalid-unit")
    result = subprocess.run(["/usr/bin/systemctl", "show", unit, "--no-pager",
                             "--property=IPAddressDeny", "--property=IPAddressAllow"],
                            capture_output=True, text=True, check=True, timeout=5)
    lines = result.stdout.splitlines()
    require(len(lines) == 2, "network-properties-unavailable")
    values = dict(line.split("=", 1) for line in lines)
    expected = {"IPAddressDeny": {"0.0.0.0/0", "::/0"},
                "IPAddressAllow": {"127.0.0.0/8", "::1/128"}}
    require(set(values) == set(expected), "network-properties-unavailable")
    for name, networks in expected.items():
        actual = {str(ipaddress.ip_network(item)) for item in values[name].split()}
        require(actual == networks, "network-properties-mismatch")


def tcp(address, port):
    family = socket.AF_INET6 if address == "::1" else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as client:
        client.settimeout(TIMEOUT)
        try:
            client.connect((address, port))
        except TimeoutError:
            return {"result": "timeout"}
        except OSError as error:
            return {"result": "error", "errno": error.errno}
        # A successful connection must reach the trusted fixture listener.
        # A missing/wrong reply fails closed, never becomes a deny result.
        require(client.recv(64) == b"network-probe", "invalid-local-response")
        return {"result": "connected"}


def udp(address, port):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(TIMEOUT)
        try:
            client.sendto(b"network-probe", (address, port))
            payload, peer = client.recvfrom(64)
            require(payload == b"network-probe" and peer == (address, port),
                    "invalid-local-response")
        except TimeoutError:
            return {"result": "timeout"}
        except OSError as error:
            return {"result": "error", "errno": error.errno}
        return {"result": "received"}


def explicit_deny(result):
    return result == {"result": "error", "errno": errno.EPERM}


def probe(address, port, ipv6_port, unit=None):
    validate_endpoint(address, port)
    require(type(ipv6_port) is int and 1024 <= ipv6_port <= 65535, "invalid-port")
    if unit is not None:
        verify_properties(unit)
    # Preserve creation of both families needed by Codex/bubblewrap.
    for family in (socket.AF_UNIX, socket.AF_INET):
        with socket.socket(family, socket.SOCK_STREAM):
            pass
    results = {"localhost_tcp": tcp("127.0.0.1", port),
               "localhost_ipv6_tcp": tcp("::1", ipv6_port),
               "localhost_udp": udp("127.0.0.1", port),
               "non_loopback_tcp": tcp(address, port),
               "non_loopback_udp": udp(address, port)}
    require(results["localhost_tcp"] == {"result": "connected"}
            and results["localhost_ipv6_tcp"] == {"result": "connected"}
            and results["localhost_udp"] == {"result": "received"}, "localhost-failed")
    if unit is None:
        require(results["non_loopback_tcp"] == {"result": "connected"}
                and results["non_loopback_udp"] == {"result": "received"}, "control-failed")
    else:
        # cgroup IP packet filtering may leave TCP connect pending. A timeout
        # alone is inconclusive: require synchronous UDP EPERM at the SAME IP
        # and port, plus the trusted fixture's TCP control/accept observations.
        require(explicit_deny(results["non_loopback_udp"]), "explicit-deny-missing")
        require(explicit_deny(results["non_loopback_tcp"])
                or results["non_loopback_tcp"] == {"result": "timeout"},
                "non-loopback-tcp-not-denied")
    return {"status": "pass", "mode": "restricted" if unit else "control", **results}


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("properties", allow_abbrev=False)
    check = commands.add_parser("probe", allow_abbrev=False)
    check.add_argument("--address", required=True)
    check.add_argument("--port", type=int, required=True)
    check.add_argument("--ipv6-port", type=int, required=True)
    check.add_argument("--unit")
    args = parser.parse_args()
    if args.command == "properties":
        print("\n".join("--property=" + value for value in PROPERTIES))
        return 0
    try:
        result = probe(args.address, args.port, args.ipv6_port, args.unit)
    except Rejected as error:
        result = {"status": "error", "reason": str(error)}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        result = {"status": "error", "reason": "network-probe-unavailable"}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
