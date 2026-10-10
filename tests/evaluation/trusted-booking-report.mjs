// #945 booking-only, closed non-secret grammar. Never read the #914 report.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
