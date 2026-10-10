// Finite Port doubles only; no Wrangler, Chrome, HTTPS, DB or systemd run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { handoffListener, cleanupOwned } from "./browser-tls-trust.mjs";
import { useTrustedBookingProcess } from "./trusted-booking-process.mjs";

const canary = "private-session-csrf-state-sql-pii-stderr";
const id = "opaque-confirm-201-only";
const origin = "https://127.0.0.1:8789";
const fixed = error => error instanceof Error && /^TRUSTED_BOOKING_PROCESS_FAILED \([a-z]+\)$/.test(error.message) &&
  !("cause" in error) && !String(error.stack).includes(canary) && !String(error.stack).includes(id);

function fixture(fault = "") {
  // Oracle: Issue #943 fixed ordering; #937 dispose gate; sealed #914
  // handoffListener/cleanupOwned; #939 stop result; #941 strict context/self jar.
  const events = [], controller = new AbortController(), handle = Object.freeze({});
  const tlsController = new AbortController();
  const callbackSignal = fault === "abort-tls-after-dom" ? tlsController.signal : controller.signal;
  const home = "/fixture/browser-home", identity = Object.freeze({ dev: 1, ino: 2, uid: 3 });
  const certificate = { key: `${home}/server.key`, cert: `${home}/server.pem` };
  const cookie = { name: "__Host-student_session", value: canary, path: "/", secure: true, httpOnly: true, sameSite: "Lax" };
  const seed = { sessions: { self: { cookie: () => cookie }, other: { cookie: () => ({ ...cookie, value: "other-secret" }) } } };
  let seeded = false, proofClosed = false, browserClosed = false, workerClosed = false, tlsOptions;
  const fail = () => { throw new Error(canary); };
  const hit = name => {
    events.push(name);
    if (fault === name) fail();
    if (fault === `abort-${name}`) controller.abort(canary);
    if (fault === `timeout-${name}`) { const e = new Error(canary); e.name = "TimeoutError"; throw e; }
  };
  const context = { async addCookies(jar) {
    hit("cookie");
    assert.deepEqual(jar, [{ name: cookie.name, value: canary, url: origin, secure: true, httpOnly: true, sameSite: "Lax" }]);
  } };
  const browser = { async newContext(options) {
    hit("context"); assert.deepEqual(options, { ignoreHTTPSErrors: false, serviceWorkers: "block" });
    assert.equal(browserClosed, false); return context;
  } };
  const ports = {
    async prepareTrustedBooking(consume) {
      hit("seed"); assert.equal(events.includes("home"), false); // Fresh TMP remains empty before seed.
      hit("seed-dispose"); seeded = true;
      await consume(seed, handle);
      if (fault === "duplicate-seed") await consume(seed, handle);
      return canary; // prepare's return is deliberately irrelevant to the child interface.
    },
    createBrowserHome() { hit("home"); assert.equal(seeded, true); return { home, identity }; },
    checkBrowserHome(path, captured) { hit("identity"); assert.equal(path, home); assert.equal(captured, identity); },
    async withIsolatedBrowserTls(consume, options) {
      tlsOptions = options;
      assert.equal(options.workerHandoff, true); assert.equal(options.executablePath, "/usr/bin/google-chrome");
      assert.equal(options.signal, controller.signal);
      assert.equal(options.report(canary), undefined); // No read-only report is forwarded.
      let stopAttempted = false;
      const stopOnce = async () => { if (!stopAttempted) { stopAttempted = true; await options.stopConsumer(); } };
      try {
        hit("tls-positive"); hit("tls-negative");
        await handoffListener(async () => { hit("proof-close"); proofClosed = true; },
          async () => { hit("proof-port"); return fault === "proof-port-open" ? false : proofClosed; },
          consume, { browser, certificate, signal: callbackSignal });
        if (fault === "duplicate-handoff") await consume({ browser, certificate, signal: callbackSignal });
        if (fault === "abort-after-dom") controller.abort(canary);
        if (fault === "abort-tls-after-dom") tlsController.abort(canary);
        if (fault === "early-inspect") await options.inspectOwned(home);
      } finally {
        try {
          await cleanupOwned({ managed: true,
            closeBrowser: async () => { hit("browser-close"); browserClosed = true; },
            closeServer: stopOnce, portClosed: async () => proofClosed || !events.includes("tls-positive"),
            remove: async () => {
              if (fault === "duplicate-stop") await options.stopConsumer();
              await options.inspectOwned(home);
              if (fault === "duplicate-inspect") await options.inspectOwned(home);
            },
          });
        } catch (error) { await stopOnce(); throw error; } // Existing sealed emergency stop; no retry.
      }
    },
    createBookingWorkerPort(input) {
      hit("worker-create"); assert.equal(proofClosed, true);
      assert.deepEqual(input, { certificate, certificateParent: home, certificateParentIdentity: identity });
      return {
        async start() { hit("start"); return fault === "wrong-origin" ? "https://127.0.0.1:8788" : origin; },
        isReady() { hit("ready"); return fault !== "not-ready"; },
        async stop() {
          hit("stop");
          if (fault === "stop-unknown") return { stopped: true };
          if (fault === "stop-port-open") return { stopped: true, portClosed: false };
          workerClosed = true; hit("worker-port"); return { stopped: true, portClosed: true };
        },
      };
    },
    async proveTrustedBookingDom(input) {
      hit("dom"); assert.deepEqual(input, { browser, context, session: seed.sessions.self, seed, signal: callbackSignal });
      if (fault === "missing-id") return undefined;
      if (fault === "empty-id") return "";
      return id;
    },
    async inspectTrustedBooking(actualHandle, actualId) {
      hit("readback"); assert.equal(browserClosed && workerClosed, true);
      assert.equal(actualHandle, handle); assert.equal(actualId, id);
      return canary; // No serialized readback data leaves the inner child.
    },
    scanOwnedSecrets(actualSeed, actualHome) { hit("scan"); assert.equal(actualSeed, seed); assert.equal(actualHome, home); },
  };
  return { events, controller, ports, run: () => useTrustedBookingProcess(ports, controller.signal), options: () => tlsOptions };
}

test("#943: seed/dispose → sealed TLS/closed → one strict DOM → Browser close → one stop/closed → independent readback/scan", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { phase: "complete", status: "prepared" });
  assert.deepEqual(f.events, ["seed", "seed-dispose", "home", "tls-positive", "tls-negative", "proof-close", "proof-port", "identity",
    "worker-create", "start", "ready", "context", "cookie", "dom", "browser-close", "stop", "worker-port", "identity", "readback", "scan"]);
  assert.equal(JSON.stringify(await fixture().run()).includes(id), false);
});

test("#943: negative, unknown and timeout fail closed without replay, re-stop, guessed ID or readback before closed", async () => {
  for (const fault of ["seed", "seed-dispose", "home", "identity", "tls-positive", "tls-negative", "proof-close", "proof-port-open",
    "worker-create", "start", "wrong-origin", "not-ready", "context", "cookie", "dom", "timeout-dom", "missing-id", "empty-id",
    "browser-close", "stop", "stop-unknown", "stop-port-open", "worker-port", "readback", "scan"]) {
    const f = fixture(fault);
    await assert.rejects(f.run(), fixed, fault);
    for (const name of ["seed", "home", "worker-create", "start", "context", "cookie", "dom", "stop", "readback", "scan"])
      assert.ok(f.events.filter(e => e === name).length <= 1, `${fault}: ${name}`);
    if (["seed", "seed-dispose", "home", "tls-positive", "tls-negative", "proof-close", "proof-port-open"].includes(fault))
      assert.equal(f.events.includes("start"), false, fault);
    if (!["readback", "scan"].includes(fault)) assert.equal(f.events.includes("readback"), false, fault);
  }
});

test("#943: duplicate callbacks and premature inspect cannot re-enter side effects", async () => {
  for (const fault of ["duplicate-seed", "duplicate-handoff", "duplicate-stop", "duplicate-inspect", "early-inspect"]) {
    const f = fixture(fault); await assert.rejects(f.run(), fixed);
    for (const name of ["start", "dom", "stop", "readback", "scan"])
      assert.ok(f.events.filter(e => e === name).length <= 1, `${fault}: ${name}`);
    if (["duplicate-handoff", "duplicate-stop", "early-inspect"].includes(fault)) assert.equal(f.events.includes("readback"), false);
  }
});

test("#943: abort at every awaited boundary prevents later work and still requests at most one owned stop", async () => {
  const pre = fixture(); pre.controller.abort(canary); await assert.rejects(pre.run(), fixed); assert.deepEqual(pre.events, []);
  for (const name of ["seed", "seed-dispose", "home", "start", "context", "cookie", "dom", "after-dom", "tls-after-dom", "readback", "scan"]) {
    const f = fixture(`abort-${name}`); await assert.rejects(f.run(), fixed);
    assert.ok(f.events.filter(e => e === "stop").length <= 1);
    assert.ok(f.events.filter(e => e === "dom").length <= 1);
    if (!["readback", "scan"].includes(name)) assert.equal(f.events.includes("readback"), false, name);
  }
  await assert.rejects(useTrustedBookingProcess({}, undefined), fixed);
});

test("#943: loading module exits silently, without resource work; Production/workflow/read-only have no caller", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./tests/evaluation/trusted-booking-process.mjs')"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  const source = readFileSync("tests/evaluation/trusted-booking-process.mjs", "utf8");
  assert.doesNotMatch(source, /console\.|process\.(?:on|argv\[|exitCode)|\b(?:rmSync|unlinkSync|spawn|execFile|fetch)\s*\(/);
  const scan = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) scan(path);
      else assert.doesNotMatch(readFileSync(path, "utf8"), /trusted-booking-process|runTrustedBookingProcess|useTrustedBookingProcess/, path);
    }
  };
  scan("src"); scan(".github/workflows");
  for (const name of ["trusted-https-process.mjs", "trusted-https-smoke.mjs", "trusted-browser-smoke.mjs", "worker.ts", "wrangler.jsonc"])
    assert.doesNotMatch(readFileSync(`tests/evaluation/${name}`, "utf8"), /trusted-booking-process/);
});
