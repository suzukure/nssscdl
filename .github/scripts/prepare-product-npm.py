#!/usr/bin/env python3
"""Dormant trusted setup helper. Never execute from a workload-modified copy."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


REGISTRY = "https://registry.npmjs.org/"
VERSION = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
NAME = re.compile(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*")
SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
MAX_INPUT = 16 * 1024 * 1024


class Rejected(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Rejected(reason)


def directory(path):
    """Walk using directory descriptors: no symlink ancestors or '..' aliases."""
    require(path.is_absolute() and ".." not in path.parts, "unsafe-path")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            new_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_input(fd, name):
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return None
    with os.fdopen(file_fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "unsafe-input")
        data = stream.read(MAX_INPUT + 1)
        require(len(data) <= MAX_INPUT, "input-too-large")
        return data


def parse(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate-json-key")
            result[key] = value
        return result
    try:
        value = json.loads(data, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Rejected("invalid-json") from None
    require(isinstance(value, dict), "invalid-json-object")
    return value


def exact(value):
    return isinstance(value, str) and VERSION.fullmatch(value) is not None


def manifest_dependencies(manifest):
    # These mechanisms can introduce dependencies outside the validated root set.
    for key in ("workspaces", "overrides", "resolutions", "bundledDependencies", "bundleDependencies"):
        require(key not in manifest, "unsupported-manifest-mechanism")
    dependencies = {}
    for section in SECTIONS:
        items = manifest.get(section, {})
        require(isinstance(items, dict), "invalid-dependencies")
        for name, version in items.items():
            require(NAME.fullmatch(name) is not None and exact(version), "non-exact-dependency")
            require(name not in dependencies or dependencies[name] == version, "dependency-conflict")
            dependencies[name] = version
    return dependencies


def package_name(location):
    parts = location.split("/")
    name = None
    while parts:
        require(parts.pop(0) == "node_modules" and parts, "unsafe-lock-path")
        name = parts.pop(0)
        if name.startswith("@"):
            require(bool(parts), "unsafe-lock-path")
            name += "/" + parts.pop(0)
        require(NAME.fullmatch(name) is not None, "unsafe-lock-path")
    return name


def validate_package(name, entry):
    require(isinstance(entry, dict) and exact(entry.get("version")), "invalid-locked-version")
    require(not any(entry.get(key) for key in ("link", "inBundle", "bundled")), "unsupported-lock-entry")
    require(entry.get("name", name) == name, "locked-name-mismatch")
    # Bind source to package AND version, rejecting alternate origins, userinfo,
    # queries, fragments, encoded traversal, and same-origin arbitrary paths.
    expected = f"{REGISTRY}{name}/-/{name.split('/')[-1]}-{entry['version']}.tgz"
    require(entry.get("resolved") == expected, "non-registry-source")
    integrity = entry.get("integrity")
    require(isinstance(integrity, str) and bool(integrity.split()), "missing-integrity")
    for token in integrity.split():
        algorithm, separator, encoded = token.partition("-")
        require(separator and algorithm in ("sha1", "sha256", "sha384", "sha512"), "invalid-integrity")
        try:
            digest = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise Rejected("invalid-integrity") from None
        require(len(digest) == hashlib.new(algorithm).digest_size, "invalid-integrity")
    # Transitive ranges are normal; external sources and aliases are not.
    for section in (*SECTIONS, "requires"):
        items = entry.get(section, {})
        require(isinstance(items, dict), "invalid-locked-dependencies")
        for dependency, spec in items.items():
            require(NAME.fullmatch(dependency) is not None and isinstance(spec, str)
                    and re.fullmatch(r"[0-9A-Za-z.*+^~<>=| -]+", spec) is not None,
                    "non-registry-dependency")


def validate_lock(manifest, lock):
    dependencies = manifest_dependencies(manifest)
    for key in ("name", "version"):
        if key in manifest:
            require(lock.get(key) == manifest[key], "manifest-lock-mismatch")
    require(type(lock.get("lockfileVersion")) is int and lock["lockfileVersion"] in (2, 3),
            "unsupported-lock-version")
    packages = lock.get("packages")
    require(isinstance(packages, dict) and isinstance(packages.get(""), dict), "missing-lock-root")
    root = packages[""]
    for key in (*SECTIONS, "peerDependenciesMeta", "name", "version"):
        default = {} if key in (*SECTIONS, "peerDependenciesMeta") else None
        require(root.get(key, default) == manifest.get(key, default), "manifest-lock-mismatch")
    for location, entry in packages.items():
        if location:
            validate_package(package_name(location), entry)
    for name, version in dependencies.items():
        entry = packages.get("node_modules/" + name)
        require(isinstance(entry, dict) and entry.get("version") == version, "manifest-lock-mismatch")
    # npm v2's legacy tree must also obey the source/integrity contract.
    def legacy(tree):
        require(isinstance(tree, dict), "invalid-legacy-lock")
        for name, entry in tree.items():
            require(NAME.fullmatch(name) is not None, "invalid-legacy-lock")
            validate_package(name, entry)
            legacy(entry.get("dependencies", {}))
    if "dependencies" in lock:
        legacy(lock["dependencies"])


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest() if data is not None else None


def run(command, cwd, env, timeout=180):
    try:
        result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Rejected("tool-execution-failed") from None
    require(result.returncode == 0, "tool-execution-failed")
    return result.stdout


def prepare(workspace, run_root, node, npm):
    evidence = {"schema_version": 1, "state": "unknown", "status": "error",
                "manifest_hash": None, "lockfile_hash": None,
                "registry": REGISTRY, "source_contract": "npm-official-tarball-with-integrity-v1",
                "node_version": None, "npm_version": None, "cache_path": None}
    destination = None
    try:
        workspace_fd = directory(workspace)
        try:
            manifest_bytes = read_input(workspace_fd, "package.json")
            lock_bytes = read_input(workspace_fd, "package-lock.json")
        finally:
            os.close(workspace_fd)
        evidence.update(manifest_hash=sha(manifest_bytes), lockfile_hash=sha(lock_bytes))
        evidence["state"] = ("no-manifest" if manifest_bytes is None else
                             "bootstrap" if lock_bytes is None else "locked")
        manifest = None
        if manifest_bytes is not None:
            manifest = parse(manifest_bytes)
            manifest_dependencies(manifest)
            if lock_bytes is not None:
                validate_lock(manifest, parse(lock_bytes))
        root_fd = directory(run_root)
        try:
            info = os.fstat(root_fd)
            require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "unsafe-run-root")
            require(workspace != run_root and workspace not in run_root.parents
                    and run_root not in workspace.parents, "overlapping-paths")
            # Create relative to the verified descriptor, then verify the path
            # still addresses it before any subprocess/path-based write.
            destination = Path(tempfile.mkdtemp(prefix="product-npm-", dir=f"/proc/self/fd/{root_fd}"))
            destination = run_root / destination.name
            require(os.stat(run_root).st_ino == info.st_ino
                    and os.stat(run_root).st_dev == info.st_dev, "run-root-changed")
        finally:
            os.close(root_fd)
        evidence["preparation_path"] = str(destination)
        cache = destination / "cache"
        cache.mkdir(mode=0o700)
        evidence["cache_path"] = str(cache)
        home = destination / "home"
        home.mkdir(mode=0o700)
        config = destination / "empty.npmrc"
        config.write_text("")
        global_config = destination / "global.npmrc"
        global_config.write_text("")
        # No inherited npm config, NODE_OPTIONS, credentials, proxy, or HOME.
        env = {"PATH": str(node.parent) + ":/usr/bin:/bin", "HOME": str(home), "LC_ALL": "C"}
        for key, executable in (("node_version", node), ("npm_version", npm)):
            require(executable.is_absolute(), "unsafe-tool-path")
            version = run([str(executable), "--version"], destination, env, 20).decode("ascii").strip()
            require(re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+", version) is not None, "invalid-tool-version")
            evidence[key] = version
        if manifest is None:
            evidence["status"] = "no-manifest"
        else:
            with tempfile.TemporaryDirectory(prefix="install-", dir=destination) as disposable:
                project = Path(disposable)
                (project / "package.json").write_bytes(manifest_bytes)
                flags = ["--ignore-scripts", "--registry=" + REGISTRY, "--cache=" + str(cache),
                         "--allow-git=none", "--allow-remote=none",
                         "--allow-file=none", "--allow-directory=none",
                         "--userconfig=" + str(config), "--globalconfig=" + str(global_config),
                         "--audit=false", "--fund=false", "--update-notifier=false", "--workspaces=false",
                         "--include=dev", "--include=optional", "--include=peer"]
                if lock_bytes is None:
                    run([str(npm), "install", "--package-lock-only", *flags], project, env)
                    project_fd = directory(project)
                    try:
                        lock_bytes = read_input(project_fd, "package-lock.json")
                    finally:
                        os.close(project_fd)
                    require(lock_bytes is not None, "generated-lock-missing")
                    evidence["lockfile_hash"] = sha(lock_bytes)
                    validate_lock(manifest, parse(lock_bytes))
                else:
                    (project / "package-lock.json").write_bytes(lock_bytes)
                run([str(npm), "ci", *flags], project, env)
                project_fd = directory(project)
                try:
                    require(read_input(project_fd, "package.json") == manifest_bytes
                            and read_input(project_fd, "package-lock.json") == lock_bytes,
                            "npm-input-mutated")
                finally:
                    os.close(project_fd)
                # Rehash/revalidate the exact lock retained as the setup artifact.
                validate_lock(manifest, parse(lock_bytes))
            (destination / "package.json").write_bytes(manifest_bytes)
            (destination / "package-lock.json").write_bytes(lock_bytes)
            evidence["status"] = "prepared"
    except Rejected as error:
        evidence["reason"] = str(error)
    except (OSError, ValueError, RecursionError):
        evidence["reason"] = "invalid-input-or-filesystem"
    if destination is not None:
        try:
            (destination / "provenance.json").write_text(json.dumps(evidence, sort_keys=True) + "\n")
        except OSError:
            evidence.update(status="error", reason="provenance-write-failed")
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--npm", type=Path, required=True)
    args = parser.parse_args()
    evidence = prepare(args.workspace, args.run_root, args.node, args.npm)
    print(json.dumps(evidence, sort_keys=True))
    return 1 if evidence["status"] == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
