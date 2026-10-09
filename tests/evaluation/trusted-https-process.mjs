// Secret-owning sanitized Node child. No raw secrets leave this process except
// the fixed loopback TLS Cookie header. No browser, IPC or owner-shell input.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { createCertificate, launchWorker, request, stopGroup, stopWorker, waitForWorker } from "./local-https-smoke.mjs";
import { checkSetup, persistence, proxyOptions, root, withTrustedEvaluationSeed } from "./trusted-evaluation-seed.mjs";
import { checkFiles, inspect } from "./trusted-seed-process.mjs";
import { check, checkError, checkSuccess, httpsProofCheckpoint } from "./trusted-https-assertions.mjs";

const exec = promisify(execFile);
const origin = "https://127.0.0.1:8788";
const controller = new AbortController();
const interrupt = () => controller.abort();
// Outer owner allows 120s: 90s execution + up to 15s stop + margin.
const deadline = setTimeout(interrupt, 90000);
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
let child;
let stopUnknown = false;

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
  checkSetup();
  const { key, cert, ca } = await createCertificate(process.env.TMPDIR, command);
  await withTrustedEvaluationSeed(async (seed) => {
    const before = await inspect(seed);
    const secrets = [seed.sessions.self.cookie().value, seed.sessions.other.cookie().value];
    const hashes = secrets.map((value) => createHash("sha256").update(value).digest("hex"));
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
  console.log(httpsProofCheckpoint); // Only fixed non-secret evidence escapes.
} catch {
  process.exitCode = 1; // No raw cause, HTTP body, assertion diff or child output.
} finally {
  try { await stop(); } catch { process.exitCode = 1; }
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
}
