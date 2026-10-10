// #945 prepared opt-in operator. No resource work on import or without --run.
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrowserUnit, browserUnitPreflight, ownedIdentity, verifyOwned } from "./trusted-browser-unit.mjs";
import { generatedBrowserFiles } from "./browser-tls-trust.mjs";
import { readBookingReport } from "./trusted-booking-report.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const persist = join(root, ".wrangler/student-booking-evaluation");
const oldPersist = join(root, ".wrangler/student-read-only-evaluation");
const exec = promisify(execFile);
const terminalReasons = ["timeout", "manager", "mismatch", "cancel", "unknown"];
const failure = (stage, reason = "unknown") => new Error(`TRUSTED_BOOKING_OUTER_FAILED; stage=${stage}${stage === "terminal" ? `; reason=${reason}` : ""}; retain owned files; do not retry`);
function terminalReason(unit) {
  // Only the first-latched category is evidence; never inspect the exception.
  try {
    const reason = unit.failure;
    for (const allowed of terminalReasons) {
      if (reason === allowed.toUpperCase()) return allowed;
    }
  } catch { /* Missing/hostile failure values cannot expose details. */ }
  return "unknown";
}
function sanitizedFailure(error) {
  // Exact fixed messages only; never reflect arbitrary error fields or causes.
  try {
    const message = error?.message;
    for (const stage of ["preflight", "start", "report", "ownership", "release", "remove", "listeners", "operator"]) {
      if (message === failure(stage).message) return failure(stage);
    }
    for (const reason of terminalReasons) {
      if (message === failure("terminal", reason).message) return failure("terminal", reason);
    }
  } catch { /* Unknown exception shapes remain non-secret. */ }
  return failure("unknown");
}
export const bookingOuterCheckpoint = "#945 booking: isolated child prepared / same invocation no-live / both ports closed / owned persistence,TMP,HOME,NSS,cert,key,report,log removed; partial evidence only; formal proof / Gate A-D unverified";
const present = path => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw failure("preflight"); } };

// The finite seam shares the real BrowserUnit protocol, never a production Port.
export async function useBookingOuter(unit, ports) {
  let stage = "preflight";
  try {
    unit.remaining(); await ports.preflight(); unit.remaining();
    stage = "start";
    await unit.start(process.execPath, ["--disable-warning=ExperimentalWarning", "tests/evaluation/trusted-booking-child.mjs", "--isolated-child"]);
    stage = "terminal";
    await unit.terminal(); // Two same-Invocation exited/cgroup observations before report or deletion.
    stage = "report";
    const report = await ports.report();
    if (report?.execution !== "isolated" || report.phase !== "complete" || report.status !== "prepared") throw failure(stage);
    stage = "ownership";
    await ports.finalCheck(); unit.remaining();
    stage = "release";
    await unit.dispose(true); unit.remaining(true);
    if (unit.failure) throw failure(stage);
    stage = "remove";
    await ports.remove();
    return Object.freeze({ success: true, status: "prepared" });
  } catch {
    const reason = stage === "terminal" ? terminalReason(unit) : undefined;
    try { unit.latch("UNKNOWN"); } catch { /* A throwing failure getter stays unknown. */ }
    try { await unit.dispose(); } catch { /* At most one stop; uncertain files retained. */ }
    throw failure(stage, reason);
  } finally { unit.close(); }
}

export async function runBookingOuter() {
  // One shared 180s budget begins before all preflight work. Never extend/retry.
  const deadline = Date.now() + 180000, controller = new AbortController();
  const interrupt = () => controller.abort();
  let temporary, unit;
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    if (process.platform !== "linux" || !/^v24\./.test(process.version)) throw failure("preflight");
    temporary = mkdtempSync(join(tmpdir(), "nssscdl-booking-"));
    const temporaryIdentity = ownedIdentity(temporary);
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
    let parentIdentity, persistenceIdentity, homeIdentity;
    const trees = [];
    return await useBookingOuter(unit, {
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
        if (present(join(root, ".wrangler"))) parentIdentity = supply.directoryIdentity(join(root, ".wrangler"));
        await closed();
        // Read-only availability probes; no Chrome launch/version process, NSS or cert generation.
        for (const name of ["openssl", "certutil", "dpkg-query", "ss", "sudo", "systemctl", "systemd-run"]) {
          await command("/usr/bin/which", [name]);
        }
        await browserUnitPreflight(options);
        // Reserve an existing .wrangler parent's identity, but leave booking persist and TMP empty for #937.
        if (!parentIdentity) {
          mkdirSync(join(root, ".wrangler"), { mode: 0o700 });
          parentIdentity = supply.directoryIdentity(join(root, ".wrangler"));
        }
        supply.checkDirectoryIdentity(join(root, ".wrangler"), parentIdentity);
        verifyOwned(temporaryIdentity);
        if (readdirSync(temporary).length || present(persist) || present(oldPersist)) throw failure("preflight");
        await closed();
      },
      report: () => { verifyOwned(temporaryIdentity); return readBookingReport(temporary); },
      async finalCheck() {
        await closed();
        if (generatedBrowserFiles(temporary).length || present(oldPersist)) throw failure("ownership");
        const supply = await import("./trusted-booking-seed.mjs");
        supply.checkDirectoryIdentity(join(root, ".wrangler"), parentIdentity);
        verifyOwned(temporaryIdentity);
        // Child alone created these exclusive roots after empty/absent preflight.
        persistenceIdentity = ownedIdentity(persist); homeIdentity = ownedIdentity(join(temporary, "browser-home"));
        trees.push(persist, temporary);
        for (const path of trees) supply.checkOwnedTree(path);
      },
      async remove() {
        unit.remaining(true);
        const supply = await import("./trusted-booking-seed.mjs");
        supply.checkDirectoryIdentity(join(root, ".wrangler"), parentIdentity);
        for (const identity of [temporaryIdentity, persistenceIdentity, homeIdentity]) verifyOwned(identity);
        for (const path of trees) supply.checkOwnedTree(path);
        controller.signal.throwIfAborted(); unit.remaining(true);
        if (unit.failure) throw failure("remove");
        // Check ALL identities/trees before either removal. No glob, force or failed-run deletion.
        rmSync(persist, { recursive: true }); rmSync(temporary, { recursive: true });
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
    console.error("Opt-in only: node tests/evaluation/trusted-booking-outer.mjs --run; separate human execution approval required");
    process.exitCode = 1;
  } else {
    try { await runBookingOuter(); console.log(bookingOuterCheckpoint); }
    catch (error) { console.error(sanitizedFailure(error).message); process.exitCode = 1; }
  }
}
