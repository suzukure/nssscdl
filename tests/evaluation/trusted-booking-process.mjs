// #943: prepared inner child only. No CLI, import-time work, report or removal.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ownedIdentity } from "./trusted-browser-unit.mjs";
import { writeBookingDiagnostic } from "./trusted-booking-report.mjs";

const origin = "https://127.0.0.1:8789";
const failure = phase => new Error(`TRUSTED_BOOKING_PROCESS_FAILED (${phase})`);

// Finite test-only Port seam. The operator-facing function below fixes all Ports.
export async function useTrustedBookingProcess(ports, signal) {
  let phase = "entry", failed = false, consumed = false, handed = false;
  let worker, startAttempted = false, stopAttempted = false, stopped = false;
  let domDone = false, inspectAttempted = false, inspected = false;
  let seed, handle, reservationId, home, identity, browserSignal;
  let observing = false, observerClosed = false, primary = "none", workerStop = "not-attempted";
  const observe = boundary => {
    if (!observing || observerClosed) return;
    try { ports.observe?.({ phase, boundary, primary, worker_stop: workerStop }); }
    catch { observerClosed = true; failed = true; throw failure(phase); }
  };
  const recordFailure = () => {
    if (primary === "none") { primary = phase; observe("entered"); }
  };
  const at = async (next, action) => {
    phase = next;
    try { observe("entered"); const result = await action(); phase = next; observe("completed"); return result; }
    catch { phase = next; recordFailure(); throw failure(phase); }
  };
  const check = ok => { if (!ok) { failed = true; throw failure(phase); } };
  const alive = () => { check(!failed && !signal.aborted); };
  try {
    check(signal && typeof signal.throwIfAborted === "function"); alive();
    phase = "seed";
    try {
      await ports.prepareTrustedBooking(async (preparedSeed, preparedHandle) => {
        phase = "seed";
        check(!consumed); consumed = true; alive();
        observe("completed");
        seed = preparedSeed; handle = preparedHandle;
        // Diagnostic initialization followed the seed empty check; HOME is still exclusive.
        await at("home", () => { ({ home, identity } = ports.createBrowserHome()); alive(); });
        await at("tls", () => ports.withIsolatedBrowserTls(async ({ browser, certificate, signal: tlsSignal }) => {
          try {
            check(!handed); handed = true; alive();
            check(tlsSignal && !tlsSignal.aborted);
            browserSignal = tlsSignal;
            ports.checkBrowserHome(home, identity);
            // Only the sealed helper's post-close/post-port-check callback gets here.
            await at("worker", async () => {
              worker = ports.createBookingWorkerPort({ certificate: { key: certificate.key, cert: certificate.cert },
                certificateParent: home, certificateParentIdentity: identity });
              startAttempted = true;
              check(await worker.start() === origin); alive(); check(worker.isReady());
            });
            await at("dom", async () => {
              const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
              alive(); check(!tlsSignal.aborted);
              const cookie = seed.sessions.self.cookie();
              check(cookie.name === "__Host-student_session" && cookie.path === "/" && cookie.secure &&
                cookie.httpOnly && cookie.sameSite === "Lax" && !("domain" in cookie));
              await context.addCookies([{ name: cookie.name, value: cookie.value, url: origin,
                secure: true, httpOnly: true, sameSite: "Lax" }]);
              alive(); check(!tlsSignal.aborted);
              reservationId = await ports.proveTrustedBookingDom({ browser, context, session: seed.sessions.self, seed, signal: tlsSignal });
              alive(); check(!tlsSignal.aborted);
              check(typeof reservationId === "string" && reservationId.length > 0);
              domDone = true; // Browser close belongs to the sealed TLS owner, not this callback.
            });
          } catch { recordFailure(); throw failure(phase); }
        }, {
          workerHandoff: true, executablePath: "/usr/bin/google-chrome", signal,
          report: () => {}, // Old TLS/read-only report strings are never booking evidence.
          stopConsumer: async () => {
            if (!startAttempted) return;
            await at("stop", async () => {
              check(!stopAttempted); stopAttempted = true;
              workerStop = "attempted"; observe("entered");
              const result = await worker.stop();
              check(result?.stopped === true && result?.portClosed === true);
              stopped = true; workerStop = "confirmed";
            }); // Unknown outcome never opens the independent proxy.
          },
          inspectOwned: async inspectedHome => {
            try {
              check(!inspectAttempted); inspectAttempted = true;
              alive(); check(domDone && stopped && !browserSignal?.aborted && inspectedHome === home);
              ports.checkBrowserHome(home, identity);
              await at("readback", async () => { await ports.inspectTrustedBooking(handle, reservationId); alive(); });
              await at("scan", async () => { await ports.scanOwnedSecrets(seed, home); alive(); });
              inspected = true;
            } catch { recordFailure(); throw failure(phase); }
          },
        }));
        alive(); check(inspected);
      }, () => {
        // Synchronous, exactly once, only after #937's existing empty-only gate.
        check(!observing); observing = true; phase = "seed"; observe("entered");
      });
    } catch {
      if (primary === "none") phase = "seed";
      recordFailure(); throw failure(phase);
    }
    alive(); check(consumed && handed && inspected);
    phase = "complete"; observe("completed");
    return Object.freeze({ phase: "complete", status: "prepared" });
  } catch {
    if (phase !== "complete") recordFailure();
    failed = true;
    throw failure(phase); // No cause, ID, Session, SQL, payload, PII or raw CLI stderr.
  }
}

// Called only by a future isolated operator child with sanitized Node24/Linux
// env, fresh TMPDIR === HOME === XDG_CONFIG_HOME and its owned deadline signal.
export async function runTrustedBookingProcess({ signal } = {}) {
  try {
    const supply = await import("./trusted-booking-seed.mjs");
    const { withIsolatedBrowserTls } = await import("./browser-tls-trust.mjs");
    const { createBookingWorkerPort } = await import("./trusted-booking-worker.mjs");
    const { proveTrustedBookingDom } = await import("./trusted-booking-dom.mjs");
    const { checkFiles } = await import("./trusted-seed-process.mjs");
    let temporaryIdentity;
    return await useTrustedBookingProcess({
      observe(data) {
        temporaryIdentity ??= ownedIdentity(process.env.TMPDIR);
        writeBookingDiagnostic(temporaryIdentity, data);
      },
      prepareTrustedBooking: supply.prepareTrustedBooking, inspectTrustedBooking: supply.inspectTrustedBooking,
      withIsolatedBrowserTls, createBookingWorkerPort, proveTrustedBookingDom,
      createBrowserHome() {
        const home = resolve(process.env.TMPDIR, "browser-home");
        mkdirSync(home, { mode: 0o700 }); // Exclusive; no adoption, reset or cleanup.
        return { home, identity: supply.directoryIdentity(home) };
      },
      checkBrowserHome: supply.checkDirectoryIdentity,
      scanOwnedSecrets(seed, home) {
        supply.checkOwnedTree(supply.persistence); supply.checkOwnedTree(process.env.TMPDIR);
        const tokens = [seed.sessions.self, seed.sessions.other].map(s => s.cookie().value);
        const hashes = tokens.map(t => createHash("sha256").update(t).digest("hex"));
        const csrf = tokens.map(t => createHash("sha256").update("student-csrf-v1:" + t).digest("base64url"));
        checkFiles(supply.persistence, [...tokens, ...csrf]); // Session hashes belong in D1.
        checkFiles(home, [...tokens, ...hashes, ...csrf]);
        checkFiles(process.env.TMPDIR, [...tokens, ...hashes, ...csrf]);
        if ([...tokens, ...hashes, ...csrf].some(s => JSON.stringify(process.env).includes(s) || JSON.stringify(process.argv).includes(s)))
          throw failure("scan");
      },
    }, signal);
  } catch { throw failure("inner"); }
}
