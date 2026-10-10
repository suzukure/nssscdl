// #943: prepared inner child only. No CLI, import-time work, report or removal.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const origin = "https://127.0.0.1:8789";
const failure = phase => new Error(`TRUSTED_BOOKING_PROCESS_FAILED (${phase})`);

// Finite test-only Port seam. The operator-facing function below fixes all Ports.
export async function useTrustedBookingProcess(ports, signal) {
  let phase = "entry", failed = false, consumed = false, handed = false;
  let worker, startAttempted = false, stopAttempted = false, stopped = false;
  let domDone = false, inspectAttempted = false, inspected = false;
  let seed, handle, reservationId, home, identity, browserSignal;
  const check = ok => { if (!ok) { failed = true; throw failure(phase); } };
  const alive = () => { check(!failed && !signal.aborted); };
  try {
    check(signal && typeof signal.throwIfAborted === "function"); alive();
    phase = "seed";
    await ports.prepareTrustedBooking(async (preparedSeed, preparedHandle) => {
      check(!consumed); consumed = true; alive();
      seed = preparedSeed; handle = preparedHandle;
      // #937 requires empty TMPDIR until seed and its initial proxy disposal.
      phase = "home";
      ({ home, identity } = ports.createBrowserHome()); alive();
      phase = "tls";
      await ports.withIsolatedBrowserTls(async ({ browser, certificate, signal: tlsSignal }) => {
        check(!handed); handed = true; alive();
        check(tlsSignal && !tlsSignal.aborted);
        browserSignal = tlsSignal;
        ports.checkBrowserHome(home, identity);
        // Only the sealed helper's post-close/post-port-check callback gets here.
        phase = "worker";
        worker = ports.createBookingWorkerPort({ certificate: { key: certificate.key, cert: certificate.cert },
          certificateParent: home, certificateParentIdentity: identity });
        startAttempted = true;
        check(await worker.start() === origin); alive(); check(worker.isReady());
        phase = "dom";
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
      }, {
        workerHandoff: true, executablePath: "/usr/bin/google-chrome", signal,
        report: () => {}, // Old TLS/read-only report strings are never booking evidence.
        stopConsumer: async () => {
          if (!startAttempted) return;
          check(!stopAttempted); stopAttempted = true; phase = "stop";
          const result = await worker.stop();
          check(result?.stopped === true && result?.portClosed === true);
          stopped = true; // Unknown outcome never opens the independent proxy.
        },
        inspectOwned: async inspectedHome => {
          check(!inspectAttempted); inspectAttempted = true;
          alive(); check(domDone && stopped && !browserSignal?.aborted && inspectedHome === home);
          ports.checkBrowserHome(home, identity);
          phase = "readback";
          await ports.inspectTrustedBooking(handle, reservationId); alive();
          phase = "scan";
          await ports.scanOwnedSecrets(seed, home); alive();
          inspected = true;
        },
      });
      alive(); check(inspected);
    });
    alive(); check(consumed && handed && inspected);
    return Object.freeze({ phase: "complete", status: "prepared" });
  } catch {
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
    return await useTrustedBookingProcess({
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
