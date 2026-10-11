// Finite Port doubles only; no Wrangler, Chrome, HTTPS, DB or systemd run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { handoffListener, cleanupOwned } from "./browser-tls-trust.mjs";
import { useTrustedBookingProcess } from "./trusted-booking-process.mjs";
import { createBookingWorkerPort } from "./trusted-booking-worker.mjs";
import { encodeBookingDiagnostic, parseBookingDiagnostic } from "./trusted-booking-report.mjs";

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
    async prepareTrustedBooking(consume, entered) {
      hit("seed"); assert.equal(events.includes("home"), false); // Fresh TMP remains empty before seed.
      entered?.();
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
  return { events, controller, ports, run: () => useTrustedBookingProcess(ports, controller.signal), options: () => tlsOptions,
    markWorkerClosed: () => { workerClosed = true; } };
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

// #959 oracles: Issue-defined boundaries, first observed failure and independent stop.
function observedFixture(fault = "", failWrite = () => false) {
  const f = fixture(fault), snapshots = [];
  let writes = 0;
  f.ports.observe = data => {
    writes++;
    if (failWrite(data)) throw new Error(canary);
    snapshots.push({ ...data });
  };
  return { ...f, snapshots, writes: () => writes };
}
test("#959 all prepared boundaries and complete are diagnostic-only; Worker stop progresses independently", async () => {
  const f = observedFixture(); await f.run();
  assert.deepEqual(f.snapshots.map(s => `${s.phase}/${s.boundary}`), [
    "seed/entered", "seed/completed", "home/entered", "home/completed", "tls/entered", "worker/entered", "worker/completed",
    "dom/entered", "dom/completed", "stop/entered", "stop/entered", "stop/entered", "stop/completed", "readback/entered", "readback/completed",
    "scan/entered", "scan/completed", "tls/completed", "complete/completed",
  ]);
  assert.ok(f.snapshots.every(s => s.primary === "none"));
  const stops = f.snapshots.filter(s => s.phase === "stop");
  assert.deepEqual(stops.map(s => s.worker_stop), ["not-attempted", "attempted", "confirmed", "confirmed"]);
  assert.equal(f.snapshots.at(-1).worker_stop, "confirmed");
});
test("#959 local first failure survives TLS finally/stop/inspect; stop uncertainty never confirms", async () => {
  for (const [fault, primary, stop] of [
    ["seed-dispose", "seed", "not-attempted"], ["home", "home", "not-attempted"],
    ["tls-negative", "tls", "not-attempted"], ["worker-create", "worker", "not-attempted"],
    ["start", "worker", "confirmed"], ["context", "dom", "confirmed"], ["cookie", "dom", "confirmed"],
    ["dom", "dom", "confirmed"], ["stop", "stop", "unknown"], ["stop-unknown", "stop", "unknown"],
    ["stop-port-open", "stop", "unknown"], ["readback", "readback", "confirmed"], ["scan", "scan", "confirmed"],
    ["abort-dom", "dom", "confirmed"], ["abort-readback", "readback", "confirmed"],
  ]) {
    const f = observedFixture(fault); await assert.rejects(f.run(), fixed);
    const failures = f.snapshots.filter(s => s.primary !== "none");
    assert.ok(failures.length > 0, fault);
    assert.ok(failures.every(s => s.primary === primary), fault);
    assert.equal(f.snapshots.at(-1).worker_stop, stop, fault);
    assert.ok(f.events.filter(e => e === "stop").length <= 1);
    assert.ok(!f.snapshots.some(s => s.phase === "complete"));
  }
  const early = observedFixture("seed"); await assert.rejects(early.run(), fixed);
  assert.deepEqual(early.snapshots, []); // Hook unreachable: diagnostic unknown.
});
test("#959 failed diagnostic write permanently suppresses later writes and success, with no replay", async () => {
  for (const phase of ["seed", "home", "worker", "dom", "stop", "readback", "scan", "complete"]) {
    const f = observedFixture("", s => s.phase === phase);
    await assert.rejects(f.run(), fixed);
    assert.equal(f.writes(), f.snapshots.length + 1, phase);
    assert.ok(f.events.filter(e => e === "stop").length <= 1);
    assert.ok(f.events.filter(e => e === "dom").length <= 1);
    assert.ok(!f.snapshots.some(s => s.phase === "complete"));
  }
});

test("#959 DOM primary remains first when helper finally also fails Worker stop", async () => {
  const f = observedFixture("dom"), create = f.ports.createBookingWorkerPort;
  f.ports.createBookingWorkerPort = input => ({ ...create(input), async stop() { f.events.push("stop"); throw new Error(canary); } });
  await assert.rejects(f.run(), fixed);
  assert.ok(f.snapshots.filter(s => s.primary !== "none").every(s => s.primary === "dom"));
  assert.equal(f.snapshots.at(-1).worker_stop, "unknown");
  assert.equal(f.events.filter(e => e === "stop").length, 1);
});

// The actual #939 Worker port consumes existing finite effects only.
function attachWorker(f, { unattributed = false, failStart = false, failStop = false } = {}) {
  let active = false, clock = 0;
  const effects = [], child = { pid: 42, exitCode: null, signalCode: null, on() {} };
  const line = 'LISTEN 0 128 127.0.0.1:8789 0.0.0.0:* users:(("node",pid=42,fd=3))';
  const fake = {
    read(path, encoding) { assert.equal(path, "/proc/self/cgroup"); assert.equal(encoding, "utf8"); return "0::/system.slice/nssscdl-browser-" + "a".repeat(32) + ".service\n"; },
    preflight() { effects.push("preflight"); return { env: {}, confirm() { effects.push("confirm"); } }; },
    spawn() { effects.push("spawn"); active = true; return child; },
    async command(file, args) {
      effects.push(file === "ps" ? "ps" : args.join(" "));
      if (file === "ps") return "42";
      if (args[1] === "-ltn") return "";
      if (failStart) throw new Error(canary);
      if (args.length === 3) return line;
      assert.deepEqual(args, ["-H", "-ltnp", "-O", "--cgroup", "cgroup", "=", "/sys/fs/cgroup/system.slice/nssscdl-browser-" + "a".repeat(32) + ".service"]);
      return line + " cgroup:/system.slice/nssscdl-browser-" + "a".repeat(32) + ".service" + (unattributed ? '\nLISTEN 0 128 0.0.0.0:8088 0.0.0.0:*' : "");
    },
    groupAlive() { effects.push("alive"); return active; },
    interrupt() {
      effects.push("SIGINT"); if (failStop) throw new Error(canary);
      active = false; child.signalCode = "SIGINT";
    },
    now: () => clock, sleep: async () => { effects.push("sleep"); clock += 1000; },
  };
  let actual;
  f.ports.createBookingWorkerPort = (input, defaults, hook) => {
    assert.equal(defaults, undefined);
    actual = createBookingWorkerPort(input, fake, hook);
    return { ...actual, async stop() { const result = await actual.stop(); f.markWorkerClosed(); return result; } };
  };
  return { effects, port: () => actual };
}

test("#976 actual Worker first failure and ownership refusal share six-field snapshots, with no signal or readback", async () => {
  const f = observedFixture(), worker = attachWorker(f, { unattributed: true });
  await assert.rejects(f.run(), fixed);
  const last = f.snapshots.at(-1);
  assert.equal(last.worker_failure, "listener-unattributed"); assert.equal(last.worker_stop_detail, "ownership-failed");
  assert.equal(last.primary, "worker"); assert.equal(last.worker_stop, "attempted");
  assert.equal(worker.effects.includes("SIGINT"), false);
  assert.equal(f.events.includes("readback"), false); assert.equal(f.events.includes("dom"), false);
  assert.ok(f.snapshots.filter(s => s.worker_failure !== "none").every(s => s.worker_failure === "listener-unattributed"));
  const saved = [...f.snapshots], effects = [...worker.effects];
  await assert.rejects(worker.port().stop()); await assert.rejects(worker.port().start());
  assert.deepEqual(f.snapshots, saved); assert.deepEqual(worker.effects, effects);
  for (const snapshot of f.snapshots) assert.deepEqual(parseBookingDiagnostic(encodeBookingDiagnostic(snapshot)), snapshot);
});

test("#976 DOM failure preserves worker_failure=none; startup and stop failure classifications are independent", async () => {
  for (const [fault, options, primary, start, stop] of [
    ["dom", {}, "dom", "none", "confirmed"],
    ["dom", { failStop: true }, "dom", "none", "signal-failed"],
    ["", { failStart: true }, "worker", "booking-listener", "ownership-failed"],
  ]) {
    const f = observedFixture(fault), worker = attachWorker(f, options);
    await assert.rejects(f.run(), fixed);
    const last = f.snapshots.at(-1);
    assert.equal(last.primary, primary); assert.equal(last.worker_failure, start); assert.equal(last.worker_stop_detail, stop);
    assert.equal(last.worker_stop, stop === "confirmed" ? "confirmed" : "attempted");
    assert.equal(worker.effects.filter(e => e === "SIGINT").length, start === "none" ? 1 : 0);
    assert.equal(f.events.includes("readback"), false);
  }
});

test("#976 progress snapshots are synchronous; any writer failure closes writing and suppresses success", async () => {
  const good = observedFixture(); attachWorker(good); await good.run();
  assert.deepEqual(good.snapshots.filter(s => s.phase === "stop" && s.boundary === "entered").map(s => s.worker_stop_detail),
    ["not-attempted", "ownership", "signal", "signal-sent", "wait", "port", "confirmed"]);
  for (const point of ["ownership", "signal", "signal-sent", "wait", "port", "confirmed"]) {
    const f = observedFixture("", data => data.worker_stop_detail === point), worker = attachWorker(f);
    await assert.rejects(f.run(), fixed);
    assert.equal(f.writes(), f.snapshots.length + 1, point);
    assert.equal(f.events.includes("readback"), false); assert.ok(!f.snapshots.some(s => s.phase === "complete"));
    assert.equal(worker.effects.filter(e => e === "SIGINT").length, ["ownership", "signal"].includes(point) ? 0 : 1);
  }
  const first = observedFixture("", data => data.worker_failure !== "none"), firstWorker = attachWorker(first, { unattributed: true });
  await assert.rejects(first.run(), fixed);
  assert.equal(first.writes(), first.snapshots.length + 1);
  assert.equal(firstWorker.effects.includes("SIGINT"), false);
  assert.equal(first.events.includes("readback"), false);
  const f = observedFixture(), worker = attachWorker(f);
  let writes = 0;
  f.ports.observe = () => { writes++; return Promise.resolve(); };
  await assert.rejects(f.run(), fixed); assert.equal(writes, 1); assert.deepEqual(worker.effects, []);
});
