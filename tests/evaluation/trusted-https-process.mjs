// Secret-owning sanitized Node child. No raw secrets leave this process except
// the fixed loopback TLS Cookie header or #914's isolated official Cookie jar.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { createCertificate, launchWorker, request, stopGroup, stopWorker, waitForWorker } from "./local-https-smoke.mjs";
import { checkSetup, persistence, proxyOptions, root, withTrustedEvaluationSeed } from "./trusted-evaluation-seed.mjs";
import { checkFiles, inspect } from "./trusted-seed-process.mjs";
import { check, checkError, checkSuccess, httpsProofCheckpoint } from "./trusted-https-assertions.mjs";
import { browserDiagnostic, observeTlsDiagnostic, recordBrowserFailure, withIsolatedBrowserTls } from "./browser-tls-trust.mjs";
import { browserBinary, browserFailureCheckpoint, browserPreflight, browserProofCheckpoint, checkCertificate, checkWorkerCertificate, proveBrowserReads, withStoppedProxy } from "./trusted-browser-reads.mjs";

const exec = promisify(execFile);
const origin = "https://127.0.0.1:8788";
const controller = new AbortController();
const interrupt = () => controller.abort();
const browserMode = process.argv[2] === "--browser";
const failAfterPositive = process.argv[3] === "--fail-after-positive";
// Browser adds the existing 30s launch budget; outer owner reserves cleanup.
const deadline = setTimeout(interrupt, browserMode ? 120000 : 90000);
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
let child;
let stopUnknown = false;
let intentionalObserved = false, browserCleanupConfirmed = false;
let browserCertificate;
// Fixed non-secret runtime stage only; never emit original error, request or child output.
let browserStage = "entry";
const diagnostic = { primary: "none", cleanup: "none" };

async function command(file, args, cleanup = false) {
  const pending = exec(file, args, { cwd: root, env: process.env, detached: true,
    timeout: 5000, maxBuffer: 1024 * 1024, ...(cleanup ? {} : { signal: controller.signal }) });
  try { return (await pending).stdout; }
  finally {
    if (pending.child.pid) check(await stopGroup(pending.child));
  }
}

async function stop() {
  check(!stopUnknown); // Never retry a failed/unknown stop.
  if (child?.pid) {
    stopUnknown = true;
    check(await stopWorker(child, (f, a) => command(f, a, true)));
    child = undefined; // Only a confirmed graceful stop opens the proxy boundary.
    stopUnknown = false;
  }
}

async function revokeSelf(seed) {
  check(!child);
  checkSetup(); // Requires closed 8788, exact config and local-only environment.
  const { getPlatformProxy } = await import("wrangler");
  let proxy;
  try {
    proxy = await getPlatformProxy(proxyOptions);
    check(Object.keys(proxy.env).length === 1 && !!proxy.env.EVALUATION_READ_DB);
    const db = proxy.env.EVALUATION_READ_DB;
    const hash = createHash("sha256").update(seed.sessions.self.cookie().value).digest("hex");
    // Existing D1 §8.5 revocation, test-owned Session only; no business write.
    const result = await db.prepare(`UPDATE student_sessions SET revoked_at=CAST(strftime('%s','now') AS INTEGER)
      WHERE id='seed-session-self' AND token_hash=? AND revoked_at IS NULL`).bind(hash).run();
    check(result.success && result.meta.changes === 1);
    const row = await db.prepare("SELECT revoked_at,created_at FROM student_sessions WHERE id='seed-session-self'").first();
    check(Number.isSafeInteger(row?.revoked_at) && row.revoked_at >= row.created_at);
    return row.revoked_at;
  } finally { if (proxy) await proxy.dispose(); }
}

try {
  check(process.argv.length === 2 || (browserMode && (process.argv.length === 3 ||
    (process.argv.length === 4 && failAfterPositive))));
  checkSetup();
  if (browserMode) browserStage = "seed";
  if (browserMode) browserPreflight();
  const certificate = browserMode ? undefined : await createCertificate(process.env.TMPDIR, command);
  await withTrustedEvaluationSeed(async (seed) => {
    if (browserMode) browserStage = "seed-inspect";
    const before = await inspect(seed);
    const secrets = [seed.sessions.self.cookie().value, seed.sessions.other.cookie().value];
    const hashes = secrets.map((value) => createHash("sha256").update(value).digest("hex"));
    if (browserMode) {
      let revokedAt = null;
      const proxyState = { stopped: () => !child && !stopUnknown, unknown: false };
      const inspectStopped = () => withStoppedProxy(proxyState, async () => {
        check(before === await inspect(seed, revokedAt));
      });
      browserStage = "tls-setup";
      await withIsolatedBrowserTls(async ({ browser, context, certificate, signal }) => {
        browserStage = "worker-start";
        browserCertificate = `certificate: SHA256=${checkCertificate(certificate).fingerprint256}; SAN=127.0.0.1; same Node/Worker cert`;
        const start = async () => {
          browserStage = "worker-start";
          signal.throwIfAborted();
          check(!child && !proxyState.unknown); checkSetup();
          checkCertificate(certificate);
          child = launchWorker(process.env, certificate.key, certificate.cert);
          await waitForWorker(child, command, signal);
          await checkWorkerCertificate(certificate);
          browserStage = "browser-read";
        };
        try {
          await proveBrowserReads({ browser, context, signal, seed, secrets, hashes, start, stop,
            revoke: () => withStoppedProxy(proxyState, async () => { revokedAt = await revokeSelf(seed); }),
            inspect: inspectStopped, failAfterPositive });
        } catch (error) {
          intentionalObserved = failAfterPositive && error.message === "TRUSTED_BROWSER_INTENTIONAL_FAILURE";
          throw error;
        }
      }, {
        workerHandoff: true, executablePath: browserBinary, signal: controller.signal,
        report: (line) => {
          observeTlsDiagnostic(diagnostic, line, browserStage);
          if (line === "cleanup: browser processes stopped / HTTPS listener and port closed / owned HOME,NSS,profile,cert,key removed") browserCleanupConfirmed = true;
        }, stopConsumer: stop,
        inspectOwned: async (home) => {
          await inspectStopped();
          checkFiles(persistence, secrets);
          for (const directory of [home, process.env.TMPDIR]) {
            checkFiles(directory, [...secrets, ...hashes]);
          }
          check(secrets.every((value) => !JSON.stringify(process.env).includes(value) && !JSON.stringify(process.argv).includes(value)));
        },
      });
      browserStage = "none"; // A later failure has no confirmed browser processing stage.
      return;
    }
    const { key, cert, ca } = certificate;
    const paths = [`/api/me/schedule-months/${seed.month}`, "/api/me/reservations", "/api/auth/student/csrf"];
    const kinds = ["schedule", "history", "csrf"];
    const cookie = (owner) => {
      const value = seed.sessions[owner].cookie();
      return `${value.name}=${value.value}`;
    };
    const send = async (path, headers, method = "GET") => {
      controller.signal.throwIfAborted();
      check(child && !child.spawnFailed && child.exitCode === null && child.signalCode === null);
      const response = await request(path, ca, headers, method);
      // No secret echoed in headers; CSRF is allowed only in its exact JSON.
      check([...secrets, ...hashes].every((value) => !JSON.stringify(response.headers).includes(value)));
      check([...secrets.slice(0, 2), ...hashes].every((value) => !response.body.includes(value)));
      return response;
    };
    const authenticated = async (owner) => {
      for (const [i, path] of paths.entries()) {
        const response = await send(path, { cookie: cookie(owner), "sec-fetch-site": "same-origin" });
        const csrf = checkSuccess(response, kinds[i], seed, owner);
        if (csrf) secrets.push(csrf);
      }
      const response = await send(paths[2], { cookie: cookie(owner), origin });
      checkSuccess(response, "csrf", seed, owner);
    };
    const start = async () => {
      controller.signal.throwIfAborted();
      check(!child);
      checkSetup();
      child = launchWorker(process.env, key, cert);
      await waitForWorker(child, command, controller.signal);
    };
    await start();
    for (const owner of ["self", "other"]) await authenticated(owner);
    check(secrets[2] !== secrets[3]); // Different sessions cannot share CSRF.
    // Identity headers cannot select an owner; Query is existing 400 rejection.
    for (const owner of ["self", "other"]) {
      const target = owner === "self" ? "other" : "self";
      for (const [i, path] of paths.entries()) {
        checkSuccess(await send(path, { cookie: cookie(owner), "sec-fetch-site": "same-origin",
          "x-student-id": `seed-${target}`, "x-account-id": `seed-account-${target}`, "x-role": "admin" }), kinds[i], seed, owner);
        checkError(await send(path + `?studentId=seed-${target}`, { cookie: cookie(owner), "sec-fetch-site": "same-origin" }), 400, i === 2);
      }
    }
    const raw = seed.sessions.self.cookie().value;
    const tampered = (raw[0] === "A" ? "B" : "A") + raw.slice(1);
    check(tampered !== seed.sessions.other.cookie().value);
    secrets.push(tampered);
    for (const value of [undefined, "__Host-student_session=invalid", `__Host-student_session=${tampered}`]) {
      for (const [i, path] of paths.entries()) {
        checkError(await send(path, { ...(value ? { cookie: value } : {}), "sec-fetch-site": "same-origin",
          "x-student-id": "seed-self" }), 401, i === 2);
      }
    }
    for (const headers of [{}, { origin: "https://other.test" }, { origin: "null" },
      ...["cross-site", "same-site", "none"].map((site) => ({ origin, "sec-fetch-site": site }))]) {
      checkError(await send(paths[2], { cookie: cookie("self"), ...headers }), 403, true);
    }
    checkError(await send("/unknown", { cookie: cookie("self") }), 503);
    for (const [i, path] of paths.entries()) {
      checkError(await send(path, { cookie: cookie("self"), origin, "sec-fetch-site": "same-origin" }, "POST"), 503, i === 2);
    }
    await stop();
    check(before === await inspect(seed));
    const revokedAt = await revokeSelf(seed); // No Worker overlaps proxy writes.
    check(before === await inspect(seed, revokedAt));
    await start();
    for (const [i, path] of paths.entries()) {
      checkError(await send(path, { cookie: cookie("self"), "sec-fetch-site": "same-origin" }), 401, i === 2);
    }
    await authenticated("other");
    await stop();
    check(before === await inspect(seed, revokedAt));
    checkFiles(persistence, secrets);
    checkFiles(process.env.TMPDIR, secrets);
    // Hashes are permitted in D1 only, never in temporary CLI logs.
    checkFiles(process.env.TMPDIR, hashes);
    check(secrets.every((value) => !JSON.stringify(process.env).includes(value) && !JSON.stringify(process.argv).includes(value)));
    controller.signal.throwIfAborted();
  });
  if (!browserMode) console.log(httpsProofCheckpoint);
} catch {
  process.exitCode = 1; // No raw cause, HTTP body, assertion diff or child output.
  if (browserMode && diagnostic.cleanup === "none") {
    recordBrowserFailure(diagnostic, browserStage);
  }
} finally {
  try { await stop(); } catch {
    process.exitCode = 1;
    if (browserMode && diagnostic.cleanup === "none") diagnostic.cleanup = "worker-stop";
  }
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
}
// Publish only after the last stop attempt: cleanup failure cannot look like
// a confirmed intentional failure, nor overwrite an earlier processing stage.
if (process.exitCode === 1) {
  if (browserMode) {
    if (intentionalObserved && browserCleanupConfirmed && diagnostic.cleanup === "none") {
      console.log(browserCertificate);
      console.log(browserFailureCheckpoint);
    } else console.error(browserDiagnostic(diagnostic));
  }
} else if (browserMode) {
  console.log(browserCertificate);
  console.log(browserProofCheckpoint);
}
