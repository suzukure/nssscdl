// #1008 fixed grammar and file-isolated ownership/failure oracles. No live services.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { ownedIdentity } from "./trusted-browser-unit.mjs";
import * as report from "./trusted-unauthenticated-booking-report.mjs";
import { bookingChildComplete, bookingFixtureComplete, bookingChildUnknown } from "./trusted-booking-report.mjs";

const name = "unauthenticated-booking-report";
const complete = "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; execution=isolated; phase=complete; status=prepared; readback=unchanged\n";
const fixtureText = "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; execution=fixture; phase=complete; status=prepared; readback=unchanged\n";
const unknown = "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=unknown; status=failed\n";
const canary = "秘密-session-csrf-sql-https://private.invalid/credential";
const fixed = e => e.message === "TRUSTED_UNAUTHENTICATED_BOOKING_REPORT_FAILED" && !("cause" in e) && !e.stack.includes(canary);
function fixture(run) {
  const dir = fs.mkdtempSync(join(tmpdir(), "nssscdl-negative-report-"));
  try { run(dir, join(dir, name)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function codec(overrides = {}) {
  const source = fs.readFileSync("tests/evaluation/trusted-unauthenticated-booking-report.mjs", "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  return runInNewContext(`${source}\n({ writeUnauthenticatedBookingReport, readUnauthenticatedBookingReport })`,
    { ...fs, Buffer, process, join, ownedIdentity, ...overrides });
}
const write = (api, dir, text = complete) => api.writeUnauthenticatedBookingReport(dir, text);
const read = (api, dir) => api.readUnauthenticatedBookingReport(dir);

test("#1008 exact identifier, name, fields, spaces, ordering, LF and 160-byte bound", () => {
  assert.equal(report.unauthenticatedBookingReportName, name);
  assert.equal(report.unauthenticatedBookingReportMaxBytes, 160);
  assert.equal(report.unauthenticatedBookingChildComplete, complete);
  assert.equal(report.unauthenticatedBookingFixtureComplete, fixtureText);
  assert.equal(report.unauthenticatedBookingChildUnknown, unknown);
  for (const [text, expected] of [[complete, { execution: "isolated", phase: "complete", status: "prepared", readback: "unchanged" }],
    [fixtureText, { execution: "fixture", phase: "complete", status: "prepared", readback: "unchanged" }],
    [unknown, { phase: "unknown", status: "failed" }]]) {
    assert.ok(Buffer.byteLength(text) <= 114);
    assert.deepEqual(report.parseUnauthenticatedBookingReport(text), expected);
    assert.ok(Object.isFrozen(report.parseUnauthenticatedBookingReport(text)));
    fixture((dir, path) => {
      write(report, dir, text); assert.equal(fs.readFileSync(path, "utf8"), text);
      assert.equal(fs.statSync(path).mode & 0o7777, 0o600);
      assert.deepEqual(read(report, dir), expected);
      assert.throws(() => write(report, dir, unknown), fixed);
      assert.equal(fs.readFileSync(path, "utf8"), text);
      assert.deepEqual(fs.readdirSync(dir), [name]);
      // A fresh reader (future Outer process) accepts the same fixed file.
      assert.equal(read(codec(), dir).phase, expected.phase);
    });
  }
});

test("#1008 arbitrary/old/CRLF/nonASCII/extra bytes and fields cannot become a report", () => {
  const invalid = [undefined, null, {}, Buffer.from(complete), canary, "", bookingChildComplete, bookingFixtureComplete, bookingChildUnknown,
    complete.trimEnd(), complete.replace("\n", "\r\n"), complete + "\n", complete + "x", complete + "\0", complete + canary,
    complete.replace("isolated", "real"), complete.replace("prepared", "success"), complete.replace("unchanged", canary),
    complete.replace("; execution=isolated", ""), complete.replace("; ", ";"), complete.replace("phase=complete; status=prepared", "status=prepared; phase=complete"),
    complete.replace("\n", "; secret=" + canary + "\n"), "x".repeat(161)];
  for (const text of invalid) {
    assert.throws(() => report.parseUnauthenticatedBookingReport(text), fixed);
    fixture(dir => {
      const api = codec(); assert.throws(() => api.writeUnauthenticatedBookingReport(dir, text), fixed);
      assert.deepEqual(fs.readdirSync(dir), []);
      assert.throws(() => write(api, dir), fixed); // No regeneration after failure.
    });
    if (typeof text === "string") fixture((dir, path) => {
      fs.writeFileSync(path, text, { mode: 0o600 }); assert.throws(() => read(codec(), dir), fixed);
    });
  }
});

test("#1008 pre-existing final/partial, symlink, hardlink, directory and mode fail closed", () => {
  for (const kind of ["final", "partial", "final-symlink", "partial-symlink", "hardlink", "directory", "mode"]) fixture((dir, path) => {
    const api = codec(), target = join(dir, "target");
    fs.writeFileSync(target, complete, { mode: 0o600 });
    if (kind === "final") fs.writeFileSync(path, complete, { mode: 0o600 });
    if (kind === "partial") fs.writeFileSync(path + ".partial", complete, { mode: 0o600 });
    if (kind === "final-symlink") fs.symlinkSync(target, path);
    if (kind === "partial-symlink") fs.symlinkSync(target, path + ".partial");
    if (kind === "hardlink") fs.linkSync(target, path);
    if (kind === "directory") fs.mkdirSync(path);
    if (kind === "mode") { fs.writeFileSync(path, complete, { mode: 0o644 }); }
    const before = fs.readdirSync(dir);
    assert.throws(() => write(api, dir), fixed); assert.deepEqual(fs.readdirSync(dir), before);
    assert.throws(() => read(api, dir), fixed);
    assert.equal(fs.readFileSync(target, "utf8"), complete);
    if (!["final", "mode"].includes(kind)) assert.throws(() => read(codec(), dir), fixed);
    if (kind === "mode") assert.throws(() => read(codec(), dir), fixed);
  });
});

test("#1008 bounded reads, owner/stat drift, interrupted I/O and rename uncertainty retain files", () => {
  const faults = ["short-write", "write-throw", "close-throw", "rename-before", "rename-after", "rename-replace", "read-throw", "short-read",
    "uid", "mode", "nlink", "nonregular", ...["dev", "ino", "gid", "size", "mtimeMs", "ctimeMs"].map(key => "after-" + key), "owner", "directory-mode"];
  for (const fault of faults) fixture((dir, path) => {
    let stats = 0, reads = 0, owners = 0;
    const api = codec({
      ownedIdentity(p) { const owner = ownedIdentity(p); if (fault === "owner" && ++owners > 1) owner.ino++; return owner; },
      lstatSync(p) { const stat = fs.lstatSync(p); if (fault === "directory-mode" && p === dir) stat.mode |= 0o1000; return stat; },
      writeFileSync(fd, text) {
        if (fault === "short-write") return fs.writeFileSync(fd, text.slice(0, 20));
        fs.writeFileSync(fd, text); if (fault === "write-throw") throw new Error(canary);
      },
      closeSync(fd) { fs.closeSync(fd); if (fault === "close-throw") throw new Error(canary); },
      renameSync(from, to) {
        if (fault === "rename-before") throw new Error(canary);
        fs.renameSync(from, to);
        if (fault === "rename-after") throw new Error(canary);
        if (fault === "rename-replace") { fs.unlinkSync(to); fs.writeFileSync(to, unknown, { mode: 0o600 }); }
      },
      fstatSync(fd) {
        const stat = fs.fstatSync(fd); stats++;
        if (fault === "uid") stat.uid++;
        if (fault === "mode") stat.mode |= 0o040;
        if (fault === "nlink") stat.nlink++;
        if (fault === "nonregular") stat.isFile = () => false;
        if (fault.startsWith("after-") && stats >= 3) stat[fault.slice(6)]++;
        return stat;
      },
      readSync(fd, bytes, offset, length, position) {
        reads++; assert.equal(length, 161); assert.equal(position, 0);
        if (fault === "read-throw") throw new Error(canary);
        return fs.readSync(fd, bytes, offset, fault === "short-read" ? 20 : length, position);
      },
    });
    assert.throws(() => write(api, dir), fixed, fault);
    const before = fs.readdirSync(dir);
    assert.throws(() => write(api, dir, unknown), fixed); assert.throws(() => read(api, dir), fixed);
    assert.deepEqual(fs.readdirSync(dir), before);
    assert.ok(reads <= 2);
  });
});

test("#1008 read-time tampering, directory replacement, partial, uid/mode/stat drift and unknown reads reject", () => {
  for (const kind of ["text", "partial", "mode", "owner", "inode", "hardlink"]) fixture((dir, path) => {
    const api = codec(); write(api, dir);
    if (kind === "text") fs.writeFileSync(path, unknown);
    if (kind === "partial") fs.writeFileSync(path + ".partial", complete, { mode: 0o600 });
    if (kind === "mode") fs.chmodSync(path, 0o644);
    if (kind === "owner") { fs.renameSync(dir, dir + ".old"); fs.mkdirSync(dir, { mode: 0o700 }); fs.writeFileSync(path, complete, { mode: 0o600 }); }
    if (kind === "inode") { fs.renameSync(path, path + ".old"); fs.writeFileSync(path, complete, { mode: 0o600 }); }
    if (kind === "hardlink") fs.linkSync(path, path + ".link");
    try { assert.throws(() => read(api, dir), fixed); }
    finally { if (kind === "owner") fs.rmSync(dir + ".old", { recursive: true }); }
  });
  for (const fault of ["read", "close", "uid", "mode", "nlink", "inode", "path-inode", "owner"]) fixture((dir, path) => {
    fs.writeFileSync(path, complete, { mode: 0o600 }); let stats = 0, owners = 0;
    const api = codec({
      ownedIdentity(p) { const owner = ownedIdentity(p); if (fault === "owner" && ++owners > 1) owner.ino++; return owner; },
      fstatSync(fd) { const s = fs.fstatSync(fd); stats++;
        if (fault === "uid") s.uid++;
        if (fault === "mode") s.mode |= 0o040;
        if (fault === "nlink") s.nlink++;
        if (fault === "inode" && stats > 1) s.ino++; return s; },
      lstatSync(p) { const s = fs.lstatSync(p); if (fault === "path-inode" && p === path) s.ino++; return s; },
      readSync(...args) { if (fault === "read") throw new Error(canary); return fs.readSync(...args); },
      closeSync(fd) { fs.closeSync(fd); if (fault === "close") throw new Error(canary); },
    });
    assert.throws(() => read(api, dir), fixed, fault);
  });
});

const failureText = (entered, confirmed) => `TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=failed; entered=${entered}; confirmed=${confirmed}; status=failed\n`;
test("#1018 finite phase codec roundtrip, exact bytes/ownership and old unknown compatibility", () => {
  assert.deepEqual(report.unauthenticatedBookingPhases, ["unknown", "import", "preflight", "seed", "home", "tls-setup",
    "worker-start", "dom-401", "tls-cleanup", "worker-stop", "d1-unchanged", "secret-scan", "report-write"]);
  for (const entered of report.unauthenticatedBookingPhases) for (const confirmed of report.unauthenticatedBookingPhases) {
    const expected = { phase: "failed", entered, confirmed, status: "failed" };
    const text = failureText(entered, confirmed);
    assert.ok(Buffer.byteLength(text) <= 160);
    assert.deepEqual(report.parseUnauthenticatedBookingReport(text), expected);
    assert.equal(report.formatUnauthenticatedBookingFailure({ entered, confirmed }),
      entered === "unknown" && confirmed === "unknown" ? unknown : text);
  }
  for (const phase of report.unauthenticatedBookingPhases) fixture((dir, path) => {
    const text = failureText(phase, "unknown"), api = codec();
    write(api, dir, text); assert.equal(fs.readFileSync(path, "utf8"), text);
    assert.equal(read(codec(), dir).entered, phase);
    assert.throws(() => write(api, dir, text), fixed); assert.deepEqual(fs.readdirSync(dir), [name]);
  });
});

test("#1018 unknown enums, getters, extra/duplicate fields, CRLF and canaries rejected without reflection", () => {
  const observation = { entered: "seed", confirmed: "preflight" }, text = failureText("seed", "preflight");
  let getters = 0;
  for (const bad of [null, undefined, {}, { ...observation, raw: canary }, { ...observation, [Symbol()]: canary },
    { ...observation, entered: canary }, { entered: "seed", get confirmed() { getters++; throw new Error(canary); } },
    new Proxy({}, { ownKeys() { throw new Error(canary); } })]) assert.throws(() => report.formatUnauthenticatedBookingFailure(bad), fixed);
  assert.equal(getters, 0);
  for (const bad of [text.replace("seed", canary), text.replace("seed", "tls-preflight"), text.replace("\n", "\r\n"),
    text + "\n", text + canary, text.trimEnd(), text.replace("; confirmed=", "; entered=seed; confirmed="),
    text.replace("entered=seed; confirmed=preflight", "confirmed=preflight; entered=seed"), text.replace("status=failed", "status=prepared")]) {
    assert.throws(() => report.parseUnauthenticatedBookingReport(bad), fixed);
    fixture(dir => { const api = codec(); assert.throws(() => write(api, dir, bad), fixed);
      assert.throws(() => write(api, dir, text), fixed); assert.deepEqual(fs.readdirSync(dir), []); });
  }
});

test("#1018 failure report partial write remains latched and is never regenerated", () => {
  fixture((dir, path) => {
    const api = codec({ writeFileSync(fd, text) { fs.writeFileSync(fd, text.slice(0, 30)); } });
    assert.throws(() => write(api, dir, failureText("dom-401", "worker-start")), fixed);
    assert.deepEqual(fs.readdirSync(dir), [name + ".partial"]);
    const bytes = fs.readFileSync(path + ".partial");
    assert.throws(() => write(api, dir, unknown), fixed); assert.throws(() => read(api, dir), fixed);
    assert.deepEqual(fs.readFileSync(path + ".partial"), bytes);
  });
});
