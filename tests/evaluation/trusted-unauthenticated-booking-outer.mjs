// #1010 prepared opt-in only. No resources on import or without exact --run.
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, types } from "node:util";
import { BrowserUnit, browserUnitPreflight, ownedIdentity, verifyOwned } from "./trusted-browser-unit.mjs";
import { generatedBrowserFiles } from "./browser-tls-trust.mjs";
import { readUnauthenticatedBookingReport, unauthenticatedBookingReportName, unauthenticatedBookingPhases,
  unauthenticatedBookingTlsPrimary, unauthenticatedBookingTlsCleanup, unauthenticatedBookingTlsErrors } from "./trusted-unauthenticated-booking-report.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const persist = join(root, ".wrangler/student-booking-evaluation");
const oldPersist = join(root, ".wrangler/student-read-only-evaluation");
const exec = promisify(execFile);
const stages = ["preflight", "start", "terminal", "report", "ownership", "release", "remove", "listeners", "operator", "unknown"];
const failure = stage => new Error(`TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=${stage}; retain owned files; do not retry`);
// #1020: independent 401 grammar; progress never grants success/cleanup authority.
const terminalEnums = Object.freeze({
  reason: ["cancel", "timeout", "manager", "mismatch", "unknown", "unavailable", "none"],
  boundary: ["pre-show", "polling", "first-exit", "second-show", "double-exit", "unknown"],
  state: ["running", "exited", "failed", "other", "invalid", "unavailable"],
  result: ["success", "timeout", "other", "not-observed"],
  exit: ["zero", "nonzero", "abnormal-code", "not-observed", "unknown"],
  invocation: ["matched", "mismatched", "not-compared", "unknown"],
  cgroup: ["expected", "empty", "other", "unknown"],
  second: ["observed", "not-observed"],
  budget: ["adequate", "exhausted", "aborted", "unknown"],
  stop: ["confirmed", "failed-state", "identity-mismatch", "state-unaccepted", "stop-budget", "show-unavailable", "not-attempted", "unknown"],
  unit_stop: ["confirmed", "unknown"],
  report: ["observed", "unknown", "unread"],
  entered: unauthenticatedBookingPhases,
  confirmed: unauthenticatedBookingPhases,
  tls_primary: unauthenticatedBookingTlsPrimary,
  tls_cleanup: unauthenticatedBookingTlsCleanup,
  tls_err: unauthenticatedBookingTlsErrors,
});
export const unauthenticatedBookingTerminalMaxBytes = 512; // Includes the CLI LF.
// Unread/unknown cannot carry phases or TLS diagnostics; observed requires the manager no-live gate.
const progressConstraint = "(?=.*; unit_stop=confirmed; report=observed;|.*; report=(?:unknown|unread); entered=unknown; confirmed=unknown; tls_primary=unknown; tls_cleanup=unknown; tls_err=unknown;)";
export const unauthenticatedBookingTerminalGrammar = progressConstraint + "TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=terminal" +
  Object.entries(terminalEnums).map(([key, values]) => `; ${key}=(${values.join("|")})`).join("") +
  "; evidence=unproved; retain owned files; do not retry";
const terminalPattern = new RegExp("^(?:" + unauthenticatedBookingTerminalGrammar + ")$");
export function parseUnauthenticatedBookingTerminal(text) {
  if (typeof text !== "string" || text.length + 1 > unauthenticatedBookingTerminalMaxBytes) return undefined;
  const match = terminalPattern.exec(text);
  // JS $ also matches before a trailing LF: require the entire record explicitly.
  if (!match || match[0] !== text) return undefined;
  return Object.freeze(Object.fromEntries(Object.keys(terminalEnums).map((key, i) => [key, match[i + 1]])));
}
export function formatUnauthenticatedBookingTerminal(record) {
  try {
    if (!record || typeof record !== "object" || types.isProxy(record) || Reflect.ownKeys(record).length !== Object.keys(terminalEnums).length) return undefined;
    let text = "TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=terminal";
    for (const [key, values] of Object.entries(terminalEnums)) {
      const d = Object.getOwnPropertyDescriptor(record, key);
      if (!d || !Object.hasOwn(d, "value") || !values.includes(d.value)) return undefined;
      text += `; ${key}=${d.value}`;
    }
    text += "; evidence=unproved; retain owned files; do not retry";
    return parseUnauthenticatedBookingTerminal(text) ? text : undefined;
  } catch { return undefined; }
}
function ownData(object, key) {
  if (!object || types.isProxy(object)) return undefined;
  const d = Object.getOwnPropertyDescriptor(object, key);
  return d && Object.hasOwn(d, "value") ? d.value : undefined;
}
function sameStopped(unit, invocation) {
  return ownData(unit, "invocation") === invocation && ownData(unit, "started") === true &&
    ownData(unit, "stopped") === true;
}
function failedProgress(report) {
  if (!report || typeof report !== "object" || types.isProxy(report)) return undefined;
  const count = Reflect.ownKeys(report).length;
  if (![4, 7].includes(count) || ownData(report, "phase") !== "failed" || ownData(report, "status") !== "failed" ||
      !["entered", "confirmed"].every(key => unauthenticatedBookingPhases.includes(ownData(report, key)))) return undefined;
  const progress = { entered: ownData(report, "entered"), confirmed: ownData(report, "confirmed"),
    tls_primary: "unknown", tls_cleanup: "unknown", tls_err: "unknown" };
  if (count === 7) {
    for (const key of ["tls_primary", "tls_cleanup", "tls_err"]) {
      const value = ownData(report, key);
      if (!terminalEnums[key].includes(value)) return undefined;
      progress[key] = value;
    }
  }
  return progress;
}
function terminalFailure(unit, diagnostic) {
  const record = { reason: "unknown", boundary: "unknown", state: "unavailable", result: "not-observed",
    exit: "not-observed", invocation: "not-compared", cgroup: "unknown", second: "not-observed", budget: "unknown", stop: "unknown", ...diagnostic };
  const data = ownData;
  try {
    const observation = data(unit, "terminalObservation"), keys = Object.keys(terminalEnums).filter(k => !["reason", "stop", "unit_stop", "report", "entered", "confirmed", "tls_primary", "tls_cleanup", "tls_err"].includes(k));
    if (observation && typeof observation === "object" && Reflect.ownKeys(observation).length === keys.length &&
      keys.every(key => terminalEnums[key].includes(data(observation, key)))) {
      for (const key of keys) record[key] = data(observation, key);
    }
    const first = Object.getOwnPropertyDescriptor(unit, "failure"), reason = data(unit, "failure");
    const reasons = { CANCEL: "cancel", TIMEOUT: "timeout", MANAGER: "manager",
      MISMATCH: "mismatch", UNKNOWN: "unknown", UNAVAILABLE: "unavailable" };
    record.reason = first && Object.hasOwn(first, "value") && reason === undefined ? "none" :
      typeof reason === "string" && Object.hasOwn(reasons, reason) ? reasons[reason] : "unknown";
    const stop = data(unit, "stopObservation");
    const stops = { accepted: "confirmed", "stop-unconfirmed": "unknown", "show-budget": "stop-budget", "show-invalid": "show-unavailable" };
    record.stop = data(unit, "stopped") === false ? "not-attempted" :
      typeof stop === "string" && Object.hasOwn(stops, stop) ? stops[stop] : terminalEnums.stop.includes(stop) ? stop : "unknown";
  } catch { /* Malformed/accessor observations never produce authority or raw output. */ }
  return new Error(formatUnauthenticatedBookingTerminal(record));
}
function sanitizedFailure(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor && Object.hasOwn(descriptor, "value")) {
      if (parseUnauthenticatedBookingTerminal(descriptor.value)) return new Error(descriptor.value);
      for (const stage of stages.filter(value => value !== "terminal")) if (descriptor.value === failure(stage).message) return failure(stage);
    }
  } catch { /* Unknown error shapes never reflect raw values. */ }
  return failure("unknown");
}
export const unauthenticatedBookingOuterCheckpoint = "#1010 unauthenticated booking: isolated child prepared / readback unchanged / same invocation no-live / both ports closed / owned persistence,TMP,HOME,NSS,cert,key,report,log removed; partial evidence only; formal proof / Gate A-D unverified";
const present = path => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw failure("preflight"); } };
const consumed = new WeakSet();
function prepared(report) {
  const expected = { execution: "isolated", phase: "complete", status: "prepared", readback: "unchanged" };
  if (!report || typeof report !== "object" || Reflect.ownKeys(report).length !== 4) throw failure("report");
  for (const [key, value] of Object.entries(expected)) {
    const descriptor = Object.getOwnPropertyDescriptor(report, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.value !== value) throw failure("report");
  }
}

// Test-only finite Port seam. The operator below seals report and cleanup Ports.
export async function useUnauthenticatedBookingOuter(unit, ports) {
  // Reject reentry without stopping/closing another use of this same owner.
  if (consumed.has(unit)) throw failure("start");
  consumed.add(unit);
  let stage = "preflight";
  try {
    unit.remaining(); await ports.preflight(); unit.remaining();
    stage = "start";
    await unit.start(process.execPath, ["--disable-warning=ExperimentalWarning",
      "tests/evaluation/trusted-unauthenticated-booking-child.mjs", "--isolated-child"]);
    stage = "terminal";
    await unit.terminal(); // Existing two independent same-Invocation exited/cgroup observations.
    unit.remaining();
    stage = "report";
    prepared(await ports.report()); unit.remaining();
    stage = "ownership";
    await ports.finalCheck(); unit.remaining();
    stage = "release";
    await unit.dispose(true); unit.remaining(true);
    if (unit.failure) throw failure(stage);
    stage = "remove";
    await ports.remove(); unit.remaining(true);
    if (unit.failure) throw failure(stage);
    return Object.freeze({ success: true, status: "prepared", readback: "unchanged" });
  } catch {
    const diagnostic = { unit_stop: "unknown", report: "unread", entered: "unknown", confirmed: "unknown",
      tls_primary: "unknown", tls_cleanup: "unknown", tls_err: "unknown" };
    let eligible = false, invocation, disposed = false, confirmed = false;
    try {
      invocation = ownData(unit, "invocation");
      eligible = stage === "terminal" && !types.isProxy(unit) &&
        Object.getPrototypeOf(unit) === BrowserUnit.prototype &&
        ownData(unit, "started") === true && ownData(unit, "stopped") === false &&
        typeof invocation === "string" && /^[a-f0-9]{32}$/.test(invocation) && !/^0+$/.test(invocation);
    } catch { /* Unknown/accessor/prototype identity never authorizes a read. */ }
    try { unit.latch("UNKNOWN"); } catch { /* Preserve first failure. */ }
    // Same single dispose(false) as normal Outer; a release attempt is never repeated.
    try {
      if (ownData(unit, "started") === true && ownData(unit, "stopped") === false) {
        await unit.dispose(false);
        disposed = true;
        confirmed = eligible && ownData(unit, "stopObservation") === "accepted" && sameStopped(unit, invocation);
      }
    } catch { /* Only private failed-state confirmation below can admit a read. */ }
    if (eligible && !disposed && ownData(unit, "stopObservation") === "failed-state") {
      try { confirmed = await unit.confirmDiagnosticStop() === true && sameStopped(unit, invocation); }
      catch { /* No retry, additional stop, or alternative manager. */ }
    }
    if (confirmed) {
      try {
        // Cleanup budget ignores the failure latch, but abort/identity still close the read gate.
        unit.remaining(true);
        if (ownData(unit, "signal")?.aborted || !sameStopped(unit, invocation)) throw failure("terminal");
        diagnostic.unit_stop = "confirmed";
        diagnostic.report = "unknown";
        const progress = failedProgress(await ports.failureReport());
        if (progress) Object.assign(diagnostic, { report: "observed", ...progress });
      } catch { /* Missing/unknown/partial/hostile report stays unknown; never write or erase. */ }
    }
    throw stage === "terminal" ? terminalFailure(unit, diagnostic) : failure(stage);
  } finally { unit.close(); }
}

export async function runUnauthenticatedBookingOuter() {
  // One shared 180s budget begins before all preflight work. Never extend/retry.
  const deadline = Date.now() + 180000, controller = new AbortController();
  const interrupt = () => controller.abort();
  let temporary, unit;
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    if (process.platform !== "linux" || !/^v24\./.test(process.version)) throw failure("preflight");
    temporary = mkdtempSync(join(tmpdir(), "nssscdl-unauthenticated-booking-"));
    const temporaryIdentity = ownedIdentity(temporary);
    const strictDirectory = (identity) => {
      verifyOwned(identity);
      if (lstatSync(identity.path).mode !== identity.fullMode) throw failure("ownership");
    };
    const capture = (path, mode = 0o700) => {
      const identity = ownedIdentity(path, mode), fullMode = lstatSync(path).mode;
      if ((fullMode & 0o7777) !== mode) throw failure("ownership");
      return { ...identity, fullMode };
    };
    temporaryIdentity.fullMode = lstatSync(temporary).mode;
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: temporary, TMPDIR: temporary, XDG_CONFIG_HOME: temporary,
      WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(temporary, "wrangler.log"), CI: "true" };
    const options = { env, cwd: root, signal: controller.signal, deadline };
    unit = new BrowserUnit(options);
    const command = async (file, args) => (await exec(file, args, { cwd: root, env,
      signal: controller.signal, timeout: Math.min(5000, unit.remaining()), maxBuffer: 65536 })).stdout;
    const closed = async () => {
      for (const port of [8788, 8789]) {
        if ((await command("ss", ["-H", "-ltn", `sport = :${port}`])).trim()) throw failure("listeners");
      }
    };
    let parentIdentity, persistenceIdentity, homeIdentity, reportIdentity;
    const reportPath = join(temporary, unauthenticatedBookingReportName);
    const reportKeys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
    const report = () => {
      strictDirectory(temporaryIdentity);
      const before = lstatSync(reportPath);
      const result = readUnauthenticatedBookingReport(temporary);
      const after = lstatSync(reportPath);
      if (reportKeys.some(key => before[key] !== after[key] ||
        (reportIdentity && reportIdentity[key] !== after[key]))) throw failure("report");
      strictDirectory(temporaryIdentity);
      reportIdentity ??= after;
      return result;
    };
    const trees = [];
    return await useUnauthenticatedBookingOuter(unit, {
      async preflight() {
        // Static/dependency checks precede capability unit, D1, certificate and browser creation.
        const supply = await import("./trusted-booking-seed.mjs");
        const { browserPreflight } = await import("./trusted-browser-reads.mjs");
        const { verifyStudentAssets } = await import("./verify-student-assets.mjs");
        const { migrations } = await import("./local-https-smoke.mjs");
        supply.checkBookingEnvironment(env, JSON.parse(readFileSync(supply.proxyOptions.configPath, "utf8")),
          [root, join(root, "tests"), join(root, "tests/evaluation")].flatMap(dir => readdirSync(dir)));
        for (const path of ["package.json", "package-lock.json", "node_modules/wrangler/package.json"]) {
          const pkg = JSON.parse(readFileSync(join(root, path), "utf8"));
          if ((path === "package.json" ? pkg.devDependencies.wrangler : path === "package-lock.json" ?
            pkg.packages["node_modules/wrangler"].version : pkg.version) !== "4.146.0") throw failure("preflight");
        }
        browserPreflight(); verifyStudentAssets(root); migrations();
        for (const path of [process.execPath, "/usr/bin/google-chrome", join(root, "node_modules/.bin/wrangler")]) accessSync(path, constants.X_OK);
        if (present(persist) || present(oldPersist)) throw failure("preflight");
        if (present(join(root, ".wrangler"))) parentIdentity = capture(join(root, ".wrangler"), lstatSync(join(root, ".wrangler")).mode & 0o777);
        await closed();
        // Read-only availability probes; no Chrome launch/version process, NSS or cert generation.
        for (const name of ["openssl", "certutil", "dpkg-query", "ss", "sudo", "systemctl", "systemd-run", "busctl"]) {
          await command("/usr/bin/which", [name]);
        }
        await browserUnitPreflight(options);
        // Reserve an existing .wrangler parent's identity, but leave booking persist and TMP empty for #937.
        if (!parentIdentity) {
          mkdirSync(join(root, ".wrangler"), { mode: 0o700 });
          parentIdentity = capture(join(root, ".wrangler"), lstatSync(join(root, ".wrangler")).mode & 0o777);
        }
        strictDirectory(parentIdentity);
        strictDirectory(temporaryIdentity);
        if (readdirSync(temporary).length || present(persist) || present(oldPersist)) throw failure("preflight");
        await closed();
      },
      report,
      // Independent read authority: no finalCheck, port/D1 access, or success report reuse.
      failureReport() {
        strictDirectory(temporaryIdentity);
        const before = lstatSync(reportPath);
        const result = readUnauthenticatedBookingReport(temporary);
        const after = lstatSync(reportPath);
        if (reportKeys.some(key => before[key] !== after[key])) throw failure("report");
        strictDirectory(temporaryIdentity);
        return result;
      },
      async finalCheck() {
        await closed();
        if (generatedBrowserFiles(temporary).length || present(oldPersist)) throw failure("ownership");
        const supply = await import("./trusted-booking-seed.mjs");
        strictDirectory(parentIdentity);
        strictDirectory(temporaryIdentity);
        // Child alone created these exclusive roots after empty/absent preflight.
        persistenceIdentity = capture(persist); homeIdentity = capture(join(temporary, "browser-home"));
        // The dedicated complete report follows the inner exact-token secret scan.
        // Outer checks ownership, TLS remnants and report stability; it never receives secrets.
        trees.push(persist, temporary);
        for (const path of trees) supply.checkOwnedTree(path);
      },
      async remove() {
        unit.remaining(true);
        if (unit.failure) throw failure("remove");
        await closed();
        if (generatedBrowserFiles(temporary).length || present(oldPersist)) throw failure("remove");
        const supply = await import("./trusted-booking-seed.mjs");
        strictDirectory(parentIdentity);
        for (const identity of [temporaryIdentity, persistenceIdentity, homeIdentity]) strictDirectory(identity);
        for (const path of trees) supply.checkOwnedTree(path);
        prepared(report());
        controller.signal.throwIfAborted(); unit.remaining(true);
        if (unit.failure) throw failure("remove");
        // Check ALL identities/trees before either removal. No glob, force or failed-run deletion.
        rmSync(persist, { recursive: true }); rmSync(temporary, { recursive: true });
        if (present(persist) || present(temporary)) throw failure("remove");
      },
    });
  } catch (error) { throw sanitizedFailure(error); }
  finally {
    unit?.close();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    // No finally deletion: preflight/unknown/abort failures retain their exclusive files.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--run") {
    console.error("Opt-in only: node tests/evaluation/trusted-unauthenticated-booking-outer.mjs --run; separate human execution approval required");
    process.exitCode = 1;
  } else {
    try { await runUnauthenticatedBookingOuter(); console.log(unauthenticatedBookingOuterCheckpoint); }
    catch (error) { console.error(sanitizedFailure(error).message); process.exitCode = 1; }
  }
}
