// #1008 closed prepared evidence only; no normal booking report or cleanup authority.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { types } from "node:util";
import { ownedIdentity } from "./trusted-browser-unit.mjs";

const fail = () => new Error("TRUSTED_UNAUTHENTICATED_BOOKING_REPORT_FAILED");
export const unauthenticatedBookingReportName = "unauthenticated-booking-report";
export const unauthenticatedBookingChildComplete = "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; execution=isolated; phase=complete; status=prepared; readback=unchanged\n";
export const unauthenticatedBookingFixtureComplete = "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; execution=fixture; phase=complete; status=prepared; readback=unchanged\n";
export const unauthenticatedBookingChildUnknown = "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=unknown; status=failed\n";
// #1018: observations are progress only, never success/cleanup evidence.
export const unauthenticatedBookingPhases = Object.freeze([
  "unknown", "import", "preflight", "seed", "home", "tls-setup", "worker-start",
  "dom-401", "dom-context", "dom-setup", "dom-net", "dom-request", "dom-response", "dom-ui",
  "tls-cleanup", "worker-stop", "d1-unchanged", "secret-scan", "report-write",
]);
// #1023 private TLS diagnostics, not success/cleanup authority.
export const unauthenticatedBookingTlsPrimary = Object.freeze([
  "none", "unknown", "tls-preflight", "tls-cert", "tls-listener", "tls-browser-launch",
  "tls-browser-ownership", "tls-browser-context", "tls-browser-nss", "tls-positive", "tls-san", "tls-untrusted", "tls-consumer",
]);
export const unauthenticatedBookingTlsCleanup = Object.freeze([
  "none", "unknown", "browser-close", "browser-ownership", "browser-process", "proof-listener",
  "worker-stop", "port-close", "generated-files", "owned-inspect", "owned-remove",
]);
export const unauthenticatedBookingTlsErrors = Object.freeze([
  "ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_COMMON_NAME_INVALID", "ERR_CERT_INVALID", "ERR_SSL_PROTOCOL_ERROR",
  "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "TIMEOUT", "UNCLASSIFIED", "unknown",
]);
export const unauthenticatedBookingReportMaxBytes = 256;
const failureGrammar = new RegExp("^TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=failed; entered=(" +
  unauthenticatedBookingPhases.join("|") + "); confirmed=(" + unauthenticatedBookingPhases.join("|") + "); status=failed\\n$");
const tlsFailureGrammar = new RegExp("^TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=failed; entered=(" +
  unauthenticatedBookingPhases.join("|") + "); confirmed=(" + unauthenticatedBookingPhases.join("|") +
  "); tls_primary=(" + unauthenticatedBookingTlsPrimary.join("|") + "); tls_cleanup=(" +
  unauthenticatedBookingTlsCleanup.join("|") + "); tls_err=(" + unauthenticatedBookingTlsErrors.join("|") + "); status=failed\\n$");

export function formatUnauthenticatedBookingFailure(observation) {
  try {
    if (!observation || typeof observation !== "object" || types.isProxy(observation)) throw fail();
    const count = Reflect.ownKeys(observation).length;
    if (count !== 2 && count !== 5) throw fail();
    const values = ["entered", "confirmed"].map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(observation, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !unauthenticatedBookingPhases.includes(descriptor.value)) throw fail();
      return descriptor.value;
    });
    if (count === 5) {
      const tls = ["tls_primary", "tls_cleanup", "tls_err"].map((key, i) => {
        const d = Object.getOwnPropertyDescriptor(observation, key);
        if (!d || !Object.hasOwn(d, "value") ||
          ![unauthenticatedBookingTlsPrimary, unauthenticatedBookingTlsCleanup, unauthenticatedBookingTlsErrors][i].includes(d.value)) throw fail();
        return d.value;
      });
      return `TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=failed; entered=${values[0]}; confirmed=${values[1]}; tls_primary=${tls[0]}; tls_cleanup=${tls[1]}; tls_err=${tls[2]}; status=failed\n`;
    }
    // Retain the legacy formatter for existing fixture/Consumer callers.
    if (values.every(value => value === "unknown")) return unauthenticatedBookingChildUnknown;
    return `TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=failed; entered=${values[0]}; confirmed=${values[1]}; status=failed\n`;
  } catch { throw fail(); }
}
const states = new Map(); // A failed writer cannot regenerate, even if no file was created.
const statKeys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];

export function parseUnauthenticatedBookingReport(text) {
  if (text === unauthenticatedBookingChildComplete) return Object.freeze({ execution: "isolated", phase: "complete", status: "prepared", readback: "unchanged" });
  if (text === unauthenticatedBookingFixtureComplete) return Object.freeze({ execution: "fixture", phase: "complete", status: "prepared", readback: "unchanged" });
  if (text === unauthenticatedBookingChildUnknown) return Object.freeze({ phase: "unknown", status: "failed" });
  if (typeof text === "string" && Buffer.byteLength(text) <= unauthenticatedBookingReportMaxBytes) {
    const tls = tlsFailureGrammar.exec(text);
    if (tls && tls[0] === text) return Object.freeze({ phase: "failed", entered: tls[1], confirmed: tls[2],
      tls_primary: tls[3], tls_cleanup: tls[4], tls_err: tls[5], status: "failed" });
    const match = failureGrammar.exec(text);
    if (match && match[0] === text) return Object.freeze({ phase: "failed", entered: match[1], confirmed: match[2], status: "failed" });
  }
  throw fail();
}
function directory(owner) {
  const current = ownedIdentity(owner.path);
  if (["dev", "ino", "uid", "gid"].some(key => current[key] !== owner[key]) ||
    (lstatSync(owner.path).mode & 0o7777) !== 0o700) throw fail();
}
function absent(path) {
  try { lstatSync(path); } catch (e) { if (e.code === "ENOENT") return; throw fail(); }
  throw fail();
}
function same(a, b) {
  if (statKeys.some(key => a[key] !== b[key])) throw fail();
}
function file(owner, name) {
  let fd;
  try {
    directory(owner);
    const path = join(owner.path, name);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== owner.uid || (before.mode & 0o7777) !== 0o600 ||
      before.nlink !== 1 || before.size < 1 || before.size > unauthenticatedBookingReportMaxBytes) throw fail();
    const bytes = Buffer.alloc(unauthenticatedBookingReportMaxBytes + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, count).toString("utf8"), data = parseUnauthenticatedBookingReport(text);
    same(before, fstatSync(fd)); same(before, lstatSync(path));
    if (count !== before.size || !bytes.subarray(0, count).equals(Buffer.from(text))) throw fail();
    directory(owner);
    return { data, text, stat: before };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readUnauthenticatedBookingReport(temporary) {
  try {
    const state = states.get(temporary);
    if (state?.failed) throw fail();
    const owner = state?.owner ?? ownedIdentity(temporary);
    const path = join(temporary, unauthenticatedBookingReportName);
    absent(path + ".partial");
    const result = file(owner, unauthenticatedBookingReportName);
    if (state?.stat) same(state.stat, result.stat);
    absent(path + ".partial"); directory(owner);
    return result.data;
  } catch { throw fail(); }
}
export function writeUnauthenticatedBookingReport(temporary, text) {
  let fd;
  try {
    if (states.has(temporary)) throw fail();
    const state = { failed: true };
    states.set(temporary, state); // Latch before parsing, ownership or any I/O.
    parseUnauthenticatedBookingReport(text);
    state.owner = ownedIdentity(temporary); directory(state.owner);
    const path = join(temporary, unauthenticatedBookingReportName), partial = path + ".partial";
    absent(path); absent(partial);
    fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, text);
    const pending = fstatSync(fd);
    const written = fd; fd = undefined; closeSync(written);
    const checked = file(state.owner, unauthenticatedBookingReportName + ".partial");
    same(pending, checked.stat);
    if (checked.text !== text) throw fail();
    directory(state.owner); absent(path); same(checked.stat, lstatSync(partial));
    renameSync(partial, path);
    const final = file(state.owner, unauthenticatedBookingReportName);
    // rename may change ctime, but not the other captured file identity/content attributes.
    if (statKeys.filter(key => key !== "ctimeMs").some(key => final.stat[key] !== pending[key]) || final.text !== text) throw fail();
    absent(partial); directory(state.owner);
    state.stat = final.stat; state.failed = false;
  } catch { throw fail(); }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { throw fail(); } }
  }
}
