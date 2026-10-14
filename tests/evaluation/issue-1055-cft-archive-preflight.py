#!/usr/bin/env python3
"""#1055 only: verify/extract a fixed Chrome for Testing ZIP in a fresh owned temp dir.

Never launches Chrome, changes the default browser, fetches network data or
overrides the main workflow. Self-test: python3 <this-file> --self-test
"""
from __future__ import annotations

import hashlib
import os
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

MAX_ENTRIES = 5000
MAX_UNCOMPRESSED = 850_000_000
CHUNK = 1024 * 1024
REQUIRED = "chrome-linux64/chrome"


class ArchiveReject(ValueError):
    pass


def _normalized(info: zipfile.ZipInfo) -> tuple[str, bool]:
    name = info.filename
    if not name.startswith("chrome-linux64/") or "\\" in name or "\x00" in name:
        raise ArchiveReject("path")
    directory = name.endswith("/")
    parts = name.rstrip("/").split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ArchiveReject("path")
    ftype = stat.S_IFMT(info.external_attr >> 16)
    if ftype == stat.S_IFLNK:
        raise ArchiveReject("symlink")
    if ftype not in (0, stat.S_IFDIR if directory else stat.S_IFREG):
        raise ArchiveReject("type")
    if info.flag_bits & 1:
        raise ArchiveReject("encrypted")
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise ArchiveReject("compression")
    return "/".join(parts), directory


def verify_extract(archive_path: Path, destination: Path) -> dict[str, int | str]:
    # Owner must supply a fresh destination under a run-owned temporary root.
    if destination.exists() or destination.is_symlink():
        raise ArchiveReject("destination")
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            if not 1 <= len(infos) <= MAX_ENTRIES:
                raise ArchiveReject("entries")
            paths: set[str] = set()
            file_paths: set[str] = set()
            planned = 0
            maximum_entry = 0
            for info in infos:
                normalized, is_dir = _normalized(info)
                if normalized in paths:
                    raise ArchiveReject("duplicate")
                paths.add(normalized)
                if not is_dir:
                    file_paths.add(normalized)
                planned += info.file_size
                maximum_entry = max(maximum_entry, info.file_size)
                if planned > MAX_UNCOMPRESSED:
                    raise ArchiveReject("total-size")
            if REQUIRED not in file_paths:
                raise ArchiveReject("browser-absent")
            for path in paths:
                parts = path.split("/")
                if any("/".join(parts[:i]) in file_paths for i in range(1, len(parts))):
                    raise ArchiveReject("file-parent")
            destination.mkdir(mode=0o700)
            actual = 0
            for info in infos:
                normalized, is_dir = _normalized(info)
                out = destination.joinpath(*normalized.split("/"))
                if is_dir:
                    out.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                written = 0
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(out, flags, 0o600)
                with os.fdopen(fd, "wb") as target, archive.open(info, "r") as source:
                    while True:
                        chunk = source.read(CHUNK)
                        if not chunk:
                            break
                        actual += len(chunk)
                        written += len(chunk)
                        if actual > MAX_UNCOMPRESSED or written > info.file_size:
                            raise ArchiveReject("expanded-size")
                        target.write(chunk)
                if written != info.file_size:
                    raise ArchiveReject("entry-size")
                if normalized == REQUIRED:
                    out.chmod(0o700)
            if actual != planned:
                raise ArchiveReject("total-size")
        with archive_path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        return {"entries": len(infos), "uncompressed": actual,
                "largest_entry": maximum_entry, "sha256": digest}
    except BaseException:
        # Reject and clean only this run-owned destination, never an existing one.
        import shutil
        if destination.exists() and not destination.is_symlink():
            shutil.rmtree(destination)
        raise


class FiniteArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="1055-archive-")
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def fixture(self, files: list[tuple[str, bytes, int | None]]) -> tuple[Path, Path]:
        path = self.root / "fixture.zip"
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for name, content, mode in files:
                i = zipfile.ZipInfo(name)
                i.compress_type = zipfile.ZIP_DEFLATED
                if mode is not None:
                    i.create_system = 3
                    i.external_attr = mode << 16
                z.writestr(i, content)
        return path, self.root / "out"

    def test_normal(self):
        p, out = self.fixture([(REQUIRED, b"chrome", None),
                               ("chrome-linux64/resources.pak", b"data", None)])
        result = verify_extract(p, out)
        self.assertEqual(result["uncompressed"], 10)
        self.assertEqual((out / REQUIRED).read_bytes(), b"chrome")

    def test_traversal(self):
        p, out = self.fixture([(REQUIRED, b"chrome", None),
                               ("chrome-linux64/../../escape", b"oops", None)])
        with self.assertRaisesRegex(ArchiveReject, "path"):
            verify_extract(p, out)
        self.assertFalse((self.root / "escape").exists())

    def test_symlink(self):
        p, out = self.fixture([(REQUIRED, b"chrome", stat.S_IFLNK | 0o777)])
        with self.assertRaisesRegex(ArchiveReject, "symlink"):
            verify_extract(p, out)

    def test_duplicate(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            p, out = self.fixture([(REQUIRED, b"x", None), (REQUIRED, b"y", None)])
        with self.assertRaisesRegex(ArchiveReject, "duplicate"):
            verify_extract(p, out)

    def test_missing_browser(self):
        p, out = self.fixture([("chrome-linux64/other", b"a", None)])
        with self.assertRaisesRegex(ArchiveReject, "browser-absent"):
            verify_extract(p, out)

    def test_parent_is_file(self):
        p, out = self.fixture([(REQUIRED, b"chrome", None),
                               ("chrome-linux64/other", b"file", None),
                               ("chrome-linux64/other/child", b"nested", None)])
        with self.assertRaisesRegex(ArchiveReject, "file-parent"):
            verify_extract(p, out)

    def test_existing_destination(self):
        p, out = self.fixture([(REQUIRED, b"chrome", None)])
        out.mkdir()
        with self.assertRaisesRegex(ArchiveReject, "destination"):
            verify_extract(p, out)

    def test_total_declared_limit(self):
        p, out = self.fixture([(REQUIRED, b"chrome", None)])
        old = globals()["MAX_UNCOMPRESSED"]
        try:
            globals()["MAX_UNCOMPRESSED"] = 5
            with self.assertRaisesRegex(ArchiveReject, "total-size"):
                verify_extract(p, out)
        finally:
            globals()["MAX_UNCOMPRESSED"] = old

    def test_over_200mb_entry_passes(self):
        # Actual 201 MB, compressed and then fully extracted. Not a forged ZIP header.
        p = self.root / "large.zip"
        count = 201_000_000
        with zipfile.ZipFile(p, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as z:
            with z.open(REQUIRED, "w", force_zip64=True) as file:
                block = b"A" * CHUNK
                for _ in range(count // CHUNK):
                    file.write(block)
                file.write(b"A" * (count % CHUNK))
        out = self.root / "out"
        result = verify_extract(p, out)
        self.assertEqual(result["largest_entry"], count)
        self.assertEqual((out / REQUIRED).stat().st_size, count)


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(FiniteArchiveTests)
        return 0 if unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful() else 1
    if len(argv) != 2:
        return 2
    try:
        result = verify_extract(Path(argv[0]), Path(argv[1]))
    except (ArchiveReject, zipfile.BadZipFile, OSError, EOFError, RuntimeError, NotImplementedError):
        print("H9_CFT_ARCHIVE stage=archive-validate; status=unproved")
        return 1
    print("H9_CFT_ARCHIVE stage=archive-validate; status=pass; entries=" + str(result["entries"]) +
          "; uncompressed=" + str(result["uncompressed"]) +
          "; largest_entry=" + str(result["largest_entry"]) +
          "; zip_sha256=" + str(result["sha256"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
