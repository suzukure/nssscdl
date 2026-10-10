// #945 booking-only, closed non-secret grammar. Never read the #914 report.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedIdentity } from "./trusted-browser-unit.mjs";

const fail = () => new Error("TRUSTED_BOOKING_REPORT_FAILED");
export const bookingReportName = "booking-report";
export const bookingChildComplete = "TRUSTED_BOOKING_CHILD_V1; execution=isolated; phase=complete; status=prepared\n";
export const bookingFixtureComplete = "TRUSTED_BOOKING_CHILD_V1; execution=fixture; phase=complete; status=prepared\n";
export const bookingChildUnknown = "TRUSTED_BOOKING_CHILD_V1; phase=unknown; status=failed\n";

export function parseBookingReport(text) {
  if (text === bookingChildComplete) return Object.freeze({ execution: "isolated", phase: "complete", status: "prepared" });
  if (text === bookingFixtureComplete) return Object.freeze({ execution: "fixture", phase: "complete", status: "prepared" });
  if (text === bookingChildUnknown) return Object.freeze({ phase: "unknown", status: "failed" });
  throw fail();
}

// #957 prepared diagnostic data only: no report, commit, stop or cleanup authority.
export const bookingDiagnosticName = "booking-diagnostic";
const diagnosticFail = () => new Error("TRUSTED_BOOKING_DIAGNOSTIC_FAILED");
const diagnosticFields = {
  phase: ["entry", "seed", "home", "tls", "worker", "dom", "stop", "readback", "scan", "complete", "unknown"],
  boundary: ["entered", "completed", "unknown"],
  primary: ["none", "entry", "seed", "home", "tls", "worker", "dom", "stop", "readback", "scan", "unknown"],
  worker_stop: ["not-attempted", "attempted", "confirmed", "unknown"],
};
const diagnosticKeys = Object.keys(diagnosticFields);
const diagnosticGrammar = new RegExp("^TRUSTED_BOOKING_DIAGNOSTIC_V1; " +
  diagnosticKeys.map(key => `${key}=(${diagnosticFields[key].join("|")})`).join("; ") + "\\n$");
const diagnosticStatKeys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
const diagnosticOwnerKeys = ["path", "dev", "ino", "uid", "gid", "mode"];
// Reuse the captured directory identity object for updates. A new writer never
// adopts a pre-existing final; any writer failure permanently closes this writer.
const diagnosticWriters = new WeakMap();

export function encodeBookingDiagnostic(data) {
  try {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw diagnosticFail();
    const keys = Reflect.ownKeys(data);
    if (keys.length !== diagnosticKeys.length || keys.some((key, i) => key !== diagnosticKeys[i])) throw diagnosticFail();
    const values = diagnosticKeys.map(key => {
      const field = Object.getOwnPropertyDescriptor(data, key);
      if (!field || !Object.hasOwn(field, "value") || typeof field.value !== "string" ||
        !diagnosticFields[key].includes(field.value)) throw diagnosticFail();
      return `${key}=${field.value}`;
    });
    return `TRUSTED_BOOKING_DIAGNOSTIC_V1; ${values.join("; ")}\n`;
  } catch { throw diagnosticFail(); }
}
export function parseBookingDiagnostic(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > 256) throw diagnosticFail();
    const match = diagnosticGrammar.exec(text);
    if (!match || match[0] !== text) throw diagnosticFail();
    return Object.freeze(Object.fromEntries(diagnosticKeys.map((key, i) => [key, match[i + 1]])));
  } catch { throw diagnosticFail(); }
}
function diagnosticDirectory(owner) {
  if (owner.mode !== 0o700) throw diagnosticFail();
  const current = ownedIdentity(owner.path);
  if (["dev", "ino", "uid", "gid"].some(key => current[key] !== owner[key]) ||
    (lstatSync(owner.path).mode & 0o7777) !== 0o700) throw diagnosticFail();
}
function diagnosticAbsent(path) {
  try { lstatSync(path); } catch (e) { if (e.code === "ENOENT") return; throw diagnosticFail(); }
  throw diagnosticFail();
}
function diagnosticSame(a, b) {
  if (diagnosticStatKeys.some(key => a[key] !== b[key])) throw diagnosticFail();
}
function diagnosticFile(owner) {
  let fd;
  try {
    diagnosticDirectory(owner);
    const path = join(owner.path, bookingDiagnosticName);
    diagnosticAbsent(path + ".partial");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== owner.uid || (before.mode & 0o7777) !== 0o600 ||
      before.nlink !== 1 || before.size < 1 || before.size > 256) throw diagnosticFail();
    const bytes = Buffer.alloc(257), count = readSync(fd, bytes, 0, bytes.length, 0);
    const data = parseBookingDiagnostic(bytes.subarray(0, count).toString("utf8"));
    diagnosticSame(before, fstatSync(fd));
    const entry = lstatSync(path);
    diagnosticSame(before, entry);
    if (entry.isSymbolicLink() || count !== before.size ||
      !bytes.subarray(0, count).equals(Buffer.from(encodeBookingDiagnostic(data)))) throw diagnosticFail();
    diagnosticAbsent(path + ".partial"); diagnosticDirectory(owner);
    return { data, stat: before };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readBookingDiagnostic(owner) {
  try {
    const state = diagnosticWriters.get(owner);
    if (state?.failed) throw diagnosticFail();
    if (state && diagnosticOwnerKeys.some(key => owner[key] !== state.owner[key])) throw diagnosticFail();
    const result = diagnosticFile(owner);
    if (state?.stat) diagnosticSame(state.stat, result.stat);
    return result.data;
  } catch { throw diagnosticFail(); }
}
export function writeBookingDiagnostic(owner, data) {
  let state, fd;
  try {
    state = diagnosticWriters.get(owner);
    if (!state) {
      state = { owner: { ...owner }, failed: false };
      diagnosticWriters.set(owner, state);
    }
    if (state.failed) throw diagnosticFail();
    state.failed = true; // No automatic repair or retry after an uncertain write.
    if (diagnosticOwnerKeys.some(key => owner[key] !== state.owner[key])) throw diagnosticFail();
    const text = encodeBookingDiagnostic(data);
    diagnosticDirectory(state.owner);
    const path = join(state.owner.path, bookingDiagnosticName), partial = path + ".partial";
    diagnosticAbsent(partial);
    if (state.stat) diagnosticSame(state.stat, diagnosticFile(state.owner).stat);
    else diagnosticAbsent(path);
    fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, text);
    const pending = fstatSync(fd);
    if (!pending.isFile() || pending.uid !== state.owner.uid || (pending.mode & 0o7777) !== 0o600 ||
      pending.nlink !== 1 || pending.size !== Buffer.byteLength(text)) throw diagnosticFail();
    diagnosticSame(pending, lstatSync(partial));
    const written = fd; fd = undefined; closeSync(written);
    diagnosticDirectory(state.owner);
    if (state.stat) diagnosticSame(state.stat, lstatSync(path));
    else diagnosticAbsent(path);
    renameSync(partial, path);
    const final = diagnosticFile(state.owner);
    if (final.stat.dev !== pending.dev || final.stat.ino !== pending.ino || encodeBookingDiagnostic(final.data) !== text) throw diagnosticFail();
    state.stat = final.stat; state.failed = false;
  } catch { throw diagnosticFail(); }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { throw diagnosticFail(); }
    }
  }
}
export function writeBookingReport(temporary, text) {
  try {
    parseBookingReport(text); ownedIdentity(temporary);
    const path = join(temporary, bookingReportName);
    try { lstatSync(path); throw fail(); } catch (e) { if (e.code !== "ENOENT") throw fail(); }
    const partial = path + ".partial";
    writeFileSync(partial, text, { mode: 0o600, flag: "wx" });
    renameSync(partial, path);
  } catch { throw fail(); }
}
export function readBookingReport(temporary) {
  let fd;
  try {
    ownedIdentity(temporary);
    const path = join(temporary, bookingReportName);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o600 ||
      before.nlink !== 1 || before.size < 1 || before.size > 256) throw fail();
    const text = readFileSync(fd, "utf8"), after = fstatSync(fd), entry = lstatSync(path);
    for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]) {
      if (before[key] !== after[key] || after[key] !== entry[key]) throw fail();
    }
    if (Buffer.byteLength(text) !== before.size || entry.isSymbolicLink()) throw fail();
    return parseBookingReport(text);
  } catch { throw fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
