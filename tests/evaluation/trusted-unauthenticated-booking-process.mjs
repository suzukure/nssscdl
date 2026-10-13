// #1006: prepared Cookie-less inner only. No CLI, report, autostart or removal.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { unauthenticatedBookingTlsCleanup, unauthenticatedBookingTlsErrors } from "./trusted-unauthenticated-booking-report.mjs";

const origin = "https://127.0.0.1:8789";
// The sealed operator forwards only these fixed synchronous records. Observer
// failure is passive: it cannot prevent an owned emergency stop or change a latch.
const observePhase = (observe, phase, state) => {
  try { if (typeof observe === "function") observe(Object.freeze({ phase, state })); } catch { /* No effect on control. */ }
};
const failure = () => new Error("TRUSTED_UNAUTHENTICATED_BOOKING_PROCESS_FAILED");

// Exact #914 Helper syntax. Optional fixed ownership/process axes are checked
// and discarded, never promoted to evidence or forwarded to the private Port.
const tlsStageNames = Object.freeze({ preflight: "tls-preflight", "certificate/NSS": "tls-cert", listener: "tls-listener",
  "browser launch/HOME": "tls-browser-launch", "launch-resolved ownership": "tls-browser-ownership",
  "Browser.newContext": "tls-browser-context", "NSS candidate": "tls-browser-nss", "positive trust": "tls-positive",
  "SAN mismatch": "tls-san", "unregistered certificate": "tls-untrusted", "helper callback": "tls-consumer" });
const tlsOwnership = "none|unknown|proc-list|proc-read|proc-environ|root-unverified|group-mismatch|session-mismatch|tracked-drift|tracked-owner|home-mismatch|home-profile-main|home-profile-child|home-crash-db|home-tracked|home-descendant|home-descendant-unknown|home-descendant-(?:missing|different|ambiguous)-type-(?:known|absent|unknown)|home-unknown|profile-argv|profile-location|main-count|profile-set|profile-missing|profile-count|directory-read|directory-type|directory-owner|directory-mode|directory-path|generated-changed|related-process-remains";
const tlsSuffix = "(?:; ownership=(?:" + tlsOwnership + "))?(?:; observation=(?:profile|Crashpad|tracked|descendant|unknown),(?:live|zombie|dead|unknown),(?:exact|missing|different|ambiguous|unreadable|unknown),(?:renderer|zygote|gpu-process|utility|other|absent|unknown),(?:stable|changed|vanished|unreadable|unknown))?";
const tlsFailure = new RegExp("^failure: stage=(" + Object.keys(tlsStageNames).map(s => s.replace(/\./g, "\\.")).join("|") +
  "); category=(" + unauthenticatedBookingTlsErrors.filter(s => s !== "unknown").join("|") +
  "); TLS proof incomplete; raw cause withheld" + tlsSuffix + "$");
const tlsCleanupFailure = new RegExp("^cleanup failure: stage=(" + unauthenticatedBookingTlsCleanup.filter(s => !["none", "unknown"].includes(s)).join("|") +
  "); primary=(?:none|failed)" + tlsSuffix + "$");

// Finite test-only Port seam; the operator function below seals every Port.
export async function useUnauthenticatedBookingProcess(ports, signal, observe, observeTls) {
  let failed = false, open = true, seedOpen = false, tlsOpen = false;
  // #930 Draft-only finite trial: freeze the first failing operation *before*
  // the cleanup observer can overwrite entered/confirmed with worker-stop.
  let firstFailureObserved = false, currentPhase = "unknown", workerStopConfirmed = false;
  let consumed = false, handed = false, seedDone = false, tlsDone = false;
  let worker, startAttempted = false, stopAttempted = false, stopped = false;
  let domDone = false, inspectAttempted = false, inspected = false;
  let seed, handle, home, identity, browserSignal;
  const firstFailure = () => {
    failed = true;
    if (!firstFailureObserved && open) {
      // A successful emergency stop is not evidence that stop caused a
      // subsequent TLS/owned-inspect failure. Keep the failure coarse, but true.
      if (currentPhase === "worker-stop" && workerStopConfirmed) enter("tls-cleanup");
      firstFailureObserved = true;
      observePhase(observe, currentPhase, "first-failure");
    }
  };
  const check = ok => { if (!ok) { firstFailure(); throw failure(); } };
  const alive = () => check(open && !failed && !signal.aborted && !browserSignal?.aborted);
  const action = async use => {
    try { const value = await use(); alive(); return value; }
    catch { firstFailure(); throw failure(); }
  };
  const enter = phase => { if (open) { currentPhase = phase; observePhase(observe, phase, "entered"); } };
  const confirm = phase => { if (open) observePhase(observe, phase, "confirmed"); };
  let primaryObserved = false, cleanupObserved = false;
  const reportTls = line => {
    try {
      if (!open || !seedOpen || !tlsOpen || signal?.aborted || typeof line !== "string" || line.length > 512) return;
      const primary = tlsFailure.exec(line);
      if (primary && primary[0] === line && !primaryObserved && !cleanupObserved) {
        primaryObserved = true; // Latch even when the passive observer throws.
        if (typeof observeTls === "function") observeTls(Object.freeze({ tls_primary: tlsStageNames[primary[1]], tls_err: primary[2] }));
        return;
      }
      const cleanup = tlsCleanupFailure.exec(line);
      if (cleanup && cleanup[0] === line && !cleanupObserved) {
        cleanupObserved = true;
        if (typeof observeTls === "function") observeTls(Object.freeze({ tls_cleanup: cleanup[1] }));
      }
    } catch { /* No I/O, raw retention or execution-control effect. */ }
  };
  try {
    enter("preflight");
    check(signal && typeof signal.throwIfAborted === "function"); alive();
    await action(() => ports.prepareTrustedBooking(async (preparedSeed, preparedHandle) => {
      check(open && !consumed); consumed = true; seedOpen = true;
      try {
        alive(); confirm("seed"); seed = preparedSeed; handle = preparedHandle;
        enter("home");
        await action(() => { ({ home, identity } = ports.createBrowserHome()); });
        confirm("home");
        tlsOpen = true; enter("tls-setup");
        try {
          await action(() => ports.withIsolatedBrowserTls(async input => {
            check(open && seedOpen && tlsOpen && !handed && !stopAttempted);
            handed = true;
            await action(async () => {
              const { browser, certificate, signal: tlsSignal } = input;
              alive(); check(tlsSignal && typeof tlsSignal.throwIfAborted === "function" && !tlsSignal.aborted);
              browserSignal = tlsSignal; confirm("tls-setup");
              enter("worker-start");
              ports.checkBrowserHome(home, identity);
              worker = ports.createBookingWorkerPort({ certificate: { key: certificate.key, cert: certificate.cert },
                certificateParent: home, certificateParentIdentity: identity });
              startAttempted = true;
              check(await worker.start() === origin); alive();
              check(worker.isReady() === true); confirm("worker-start");
              enter("dom-401");
              const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
              alive();
              // The #1002 helper checks the actual empty Cookie jar and GET/POST
              // traffic. No Session, Cookie injection, ID or positive write latch.
              check(await ports.proveUnauthenticatedBookingDom({ context, fixture: { month: seed.month }, signal: tlsSignal }) === undefined);
              alive(); domDone = true; confirm("dom-401");
              enter("tls-cleanup");
            });
          }, {
            workerHandoff: true, executablePath: "/usr/bin/google-chrome", signal,
            report: reportTls,
            stopConsumer: async () => {
              check(open && seedOpen && tlsOpen && !stopAttempted);
              stopAttempted = true; // Also closes any late browser handoff.
              if (!domDone) failed = true; // A pending DOM cannot succeed after stop.
              if (!startAttempted) return;
              // Emergency owned stop remains possible after DOM/abort/close
              // failure, but no such failure can authorize inspection.
              enter("worker-stop");
              let ownerMatches = true;
              try { ports.checkBrowserHome(home, identity); }
              catch { ownerMatches = false; failed = true; }
              try {
                const result = await worker.stop();
                check(result?.stopped === true && result?.portClosed === true);
                ports.checkBrowserHome(home, identity);
                check(ownerMatches); stopped = true; confirm("worker-stop"); workerStopConfirmed = true;
              } catch { firstFailure(); throw failure(); }
            },
            inspectOwned: async inspectedHome => {
              check(open && seedOpen && tlsOpen && !inspectAttempted);
              inspectAttempted = true;
              await action(async () => {
                alive(); check(domDone && stopped && handed && inspectedHome === home);
                enter("d1-unchanged");
                ports.checkBrowserHome(home, identity);
                await ports.inspectTrustedBookingUnchanged(handle); alive(); confirm("d1-unchanged");
                enter("secret-scan");
                ports.checkBrowserHome(home, identity);
                await ports.scanOwnedSecrets(seed, home); alive(); confirm("secret-scan");
                inspected = true;
              });
            },
          }));
          check(inspected); tlsDone = true;
        } finally { tlsOpen = false; }
        alive(); seedDone = true;
      } catch { firstFailure(); throw failure(); }
      finally { seedOpen = false; }
    }, () => { confirm("preflight"); enter("seed"); }));
    alive(); check(consumed && handed && seedDone && tlsDone && inspected);
    return Object.freeze({ phase: "complete", status: "prepared" });
  } catch { firstFailure(); throw failure(); }
  finally { open = false; seedOpen = false; tlsOpen = false; }
}

// Future isolated operator only: unchanged #937 environment/empty-home gates,
// #914 strict TLS/close owner and #939 single owned Worker start/SIGINT stop.
export async function runUnauthenticatedBookingProcess({ signal, observe, observeTls } = {}) {
  try {
    observePhase(observe, "import", "entered");
    const supply = await import("./trusted-booking-seed.mjs");
    const { withIsolatedBrowserTls } = await import("./browser-tls-trust.mjs");
    const { createBookingWorkerPort } = await import("./trusted-booking-worker.mjs");
    const { proveUnauthenticatedBookingDom } = await import("./trusted-booking-dom.mjs");
    const { checkFiles } = await import("./trusted-seed-process.mjs");
    observePhase(observe, "import", "confirmed");
    return await useUnauthenticatedBookingProcess({
      prepareTrustedBooking: supply.prepareTrustedBooking,
      inspectTrustedBookingUnchanged: supply.inspectTrustedBookingUnchanged,
      withIsolatedBrowserTls, createBookingWorkerPort, proveUnauthenticatedBookingDom,
      createBrowserHome() {
        const home = resolve(process.env.TMPDIR, "browser-home");
        mkdirSync(home, { mode: 0o700 });
        return { home, identity: supply.directoryIdentity(home) };
      },
      checkBrowserHome: supply.checkDirectoryIdentity,
      scanOwnedSecrets(seed, home) {
        supply.checkOwnedTree(supply.persistence); supply.checkOwnedTree(process.env.TMPDIR);
        const tokens = [seed.sessions.self, seed.sessions.other].map(session => session.cookie().value);
        const hashes = tokens.map(token => createHash("sha256").update(token).digest("hex"));
        const csrf = tokens.map(token => createHash("sha256").update("student-csrf-v1:" + token).digest("base64url"));
        checkFiles(supply.persistence, [...tokens, ...csrf]); // Session hashes belong only in D1.
        checkFiles(home, [...tokens, ...hashes, ...csrf]);
        checkFiles(process.env.TMPDIR, [...tokens, ...hashes, ...csrf]);
        if ([...tokens, ...hashes, ...csrf].some(secret => JSON.stringify(process.env).includes(secret) || JSON.stringify(process.argv).includes(secret)))
          throw failure();
      },
    }, signal, observe, observeTls);
  } catch { throw failure(); }
}
