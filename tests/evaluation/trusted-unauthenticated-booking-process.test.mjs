// #1006 finite Port doubles only: no Chrome, listener, systemd or persistent D1.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { handoffListener, cleanupOwned } from "./browser-tls-trust.mjs";
import { useUnauthenticatedBookingChild } from "./trusted-unauthenticated-booking-child.mjs";
import { parseUnauthenticatedBookingReport } from "./trusted-unauthenticated-booking-report.mjs";
import { useUnauthenticatedBookingProcess } from "./trusted-unauthenticated-booking-process.mjs";

const canary = "private-session-csrf-sql-https://private.invalid/error";
const fixed = error => error?.message === "TRUSTED_UNAUTHENTICATED_BOOKING_PROCESS_FAILED" &&
  !("cause" in error) && !String(error.stack).includes(canary);

function fixture(fault = "") {
  // Oracle: #1006 ordering; existing #914 sealed handoff/cleanup, #939 stop
  // result, #1002 void DOM/empty Cookie jar and #1004 same opaque capability.
  const observations = [], events = [], controller = new AbortController(), tlsController = new AbortController();
  const home = "/fixture/browser-home", identity = Object.freeze({ dev: 1, ino: 2, uid: 3 });
  const handle = Object.freeze({}), seed = { month: "2026-11" };
  const certificate = { key: `${home}/server.key`, cert: `${home}/server.pem` };
  let proofClosed = false, contextClosed = false, browserClosed = false, workerClosed = false, options, seedCallback, tlsCallback;
  let resume;
  const fail = () => { throw new Error(canary); };
  const hit = name => {
    events.push(name);
    if (fault === name) fail();
    if (fault === `abort-${name}`) controller.abort(canary);
    if (fault === `tls-abort-${name}`) tlsController.abort(canary);
    if (fault === `timeout-${name}`) { const error = new Error(canary); error.name = "TimeoutError"; throw error; }
  };
  const context = { cookies: async () => [], addCookies: fail };
  const browser = { async newContext(input) {
    hit("context"); assert.deepEqual(input, { ignoreHTTPSErrors: false, serviceWorkers: "block" });
    return context;
  } };
  const input = { browser, certificate, signal: tlsController.signal };
  const ports = {
    async prepareTrustedBooking(consume, entered) {
      hit("preflight"); entered(); hit("seed"); seedCallback = consume;
      if (fault === "seed-skipped") return;
      await consume(seed, handle);
      if (fault === "duplicate-seed") await consume(seed, handle);
      return canary; // Discarded, never public evidence.
    },
    createBrowserHome() { hit("home"); return { home, identity }; },
    checkBrowserHome(path, actual) {
      hit("identity"); assert.equal(path, home); assert.equal(actual, identity);
      const count = events.filter(event => event === "identity").length;
      if (fault === `identity-${count}`) fail();
    },
    async withIsolatedBrowserTls(consume, supplied) {
      options = supplied; tlsCallback = consume;
      assert.equal(options.workerHandoff, true);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.executablePath, "/usr/bin/google-chrome");
      assert.equal(options.report(canary), undefined);
      let stopAttempted = false;
      const stopOnce = async () => {
        if (!stopAttempted) { stopAttempted = true; await options.stopConsumer(); }
      };
      try {
        hit("tls");
        if (fault !== "handoff-skipped") {
          await handoffListener(async () => { hit("proof-close"); proofClosed = true; },
            async () => { hit("proof-port"); return fault !== "handoff-port-unknown" && proofClosed; }, consume, input);
        }
        if (fault === "duplicate-handoff") await consume(input);
        if (fault === "early-inspect") await options.inspectOwned(home);
        hit("after-dom");
      } finally {
        try {
          await cleanupOwned({ managed: true,
            closeBrowser: async () => {
              hit("context-close"); contextClosed = true;
              hit("browser-close"); browserClosed = true;
            },
            closeServer: fault === "stop-skipped" ? async () => {} : stopOnce,
            portClosed: async () => { hit("tls-port"); return fault !== "tls-port-unknown"; },
            remove: async () => {
              if (fault === "duplicate-stop") await options.stopConsumer();
              if (fault === "late-handoff") await consume(input);
              if (fault === "inspect-skipped") return;
              await options.inspectOwned(fault === "wrong-home" ? "/different-home" : home);
              if (fault === "duplicate-inspect") await options.inspectOwned(home);
            },
          });
        } catch (error) { await stopOnce(); throw error; }
      }
      if (fault === "tls-after-cleanup") fail();
    },
    createBookingWorkerPort(actual) {
      hit("worker-create"); assert.equal(proofClosed, true);
      assert.deepEqual(actual, { certificate, certificateParent: home, certificateParentIdentity: identity });
      return {
        async start() { hit("start"); return fault === "wrong-origin" ? "https://127.0.0.1:8788" : "https://127.0.0.1:8789"; },
        isReady() { hit("ready"); return fault !== "not-ready"; },
        async stop() {
          hit("stop");
          if (fault === "stop-unknown") return undefined;
          if (fault === "stopped-unknown") return { portClosed: true };
          if (fault === "worker-port-open") return { stopped: true, portClosed: false };
          hit("worker-port"); workerClosed = true; return { stopped: true, portClosed: true };
        },
      };
    },
    async proveUnauthenticatedBookingDom(actual) {
      hit("dom");
      assert.deepEqual(actual, { context, fixture: { month: seed.month }, signal: tlsController.signal });
      assert.deepEqual(await actual.context.cookies(), []);
      if (fault === "pending-dom") await new Promise(done => { resume = done; });
      if (fault === "unexpected-dom-value") return canary;
    },
    async inspectTrustedBookingUnchanged(actual) {
      hit("readback"); assert.equal(contextClosed && browserClosed && workerClosed, true);
      assert.equal(actual, handle); assert.equal(arguments.length, 1);
      return canary;
    },
    scanOwnedSecrets(actual, path) { hit("scan"); assert.equal(actual, seed); assert.equal(path, home); },
    inspectTrustedBooking: fail, writeBookingDiagnostic: fail,
  };
  return { ports, observations, events, seed, home, identity, controller, tlsController, input,
    run: () => useUnauthenticatedBookingProcess(ports, controller.signal, event => observations.push(event)), resume: () => resume(),
    options: () => options, seedCallback: () => seedCallback, tlsCallback: () => tlsCallback };
}

const atMostOnce = f => {
  for (const event of ["seed", "home", "worker-create", "start", "ready", "context", "dom", "stop", "readback", "scan"])
    assert.ok(f.events.filter(value => value === event).length <= 1, event);
};

test("#1006: empty-Cookie strict context → void GET-only DOM → Browser close → owned stop/closed → unchanged/scan → prepared", async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(result, { phase: "complete", status: "prepared" }); assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(f.events, ["preflight", "seed", "home", "tls", "proof-close", "proof-port", "identity", "worker-create", "start", "ready",
    "context", "dom", "after-dom", "context-close", "browser-close", "identity", "stop", "worker-port", "identity",
    "tls-port", "identity", "readback", "identity", "scan"]);
  atMostOnce(f); assert.equal(JSON.stringify(result).includes(canary), false);
});

test("#1006: finite failures/unknowns never authorize readback before confirmed close/stop, retry or normal success", async () => {
  for (const fault of ["seed", "home", "tls", "proof-close", "proof-port", "handoff-port-unknown", "worker-create", "start",
    "wrong-origin", "not-ready", "ready", "context", "dom", "timeout-dom", "unexpected-dom-value",
    "context-close", "browser-close", "stop", "stop-unknown", "stopped-unknown", "worker-port-open", "worker-port",
    "tls-port", "tls-port-unknown", "stop-skipped", "wrong-home", "identity-1", "identity-2", "identity-3", "identity-4",
    "identity-5", "readback", "scan", "seed-skipped", "handoff-skipped", "inspect-skipped", "tls-after-cleanup"]) {
    const f = fixture(fault); await assert.rejects(f.run(), fixed, fault); atMostOnce(f);
    if (!["identity-5", "readback", "scan", "tls-after-cleanup"].includes(fault))
      assert.equal(f.events.includes("readback"), false, fault);
    if (!["scan", "tls-after-cleanup"].includes(fault)) assert.equal(f.events.includes("scan"), false, fault);
    if (["start", "dom", "context-close", "browser-close", "identity-2", "identity-3"].includes(fault))
      assert.equal(f.events.filter(value => value === "stop").length, 1, fault);
  }
});

test("#1006: duplicate/late callbacks cannot restart, reinspect or promote cleanup", async () => {
  for (const fault of ["duplicate-seed", "duplicate-handoff", "duplicate-stop", "duplicate-inspect", "early-inspect", "late-handoff"]) {
    const f = fixture(fault); await assert.rejects(f.run(), fixed); atMostOnce(f);
    if (!["duplicate-seed", "duplicate-inspect"].includes(fault)) assert.equal(f.events.includes("readback"), false);
  }
  for (const fault of ["", "dom", "browser-close"]) {
    const f = fixture(fault);
    if (fault) await assert.rejects(f.run(), fixed); else await f.run();
    const before = [...f.events];
    await assert.rejects(f.seedCallback()(f.seed, {}), fixed);
    await assert.rejects(f.tlsCallback()(f.input), fixed);
    await assert.rejects(f.tlsCallback()(null), fixed);
    await assert.rejects(f.options().stopConsumer(), fixed);
    await assert.rejects(f.options().inspectOwned(f.home), fixed);
    assert.deepEqual(f.events, before);
  }
});

test("#1006: concurrent duplicate handoffs spend the boundary before any second async effect", async () => {
  for (const boundary of ["seed", "tls"]) {
    const f = fixture(); let results;
    if (boundary === "seed") f.ports.prepareTrustedBooking = async consume => {
      results = await Promise.allSettled([consume(f.seed, {}), consume(f.seed, {})]);
    };
    else f.ports.withIsolatedBrowserTls = async consume => {
      results = await Promise.allSettled([consume(f.input), consume(f.input)]);
    };
    await assert.rejects(f.run(), fixed);
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.status === "rejected" && fixed(result.reason)));
    assert.equal(f.events.includes("readback"), false); assert.equal(f.events.includes("scan"), false); atMostOnce(f);
  }
});

test("#1006: parent/TLS abort at every awaited boundary suppresses subsequent inspection/scan", async () => {
  const pre = fixture(); pre.controller.abort(canary);
  await assert.rejects(pre.run(), fixed); assert.deepEqual(pre.events, []);
  await assert.rejects(useUnauthenticatedBookingProcess({}, undefined), fixed);
  for (const prefix of ["abort", "tls-abort"]) {
    for (const name of ["seed", "home", "tls", "start", "context", "dom", "after-dom", "context-close", "browser-close", "stop",
      "worker-port", "readback", "scan"]) {
      const f = fixture(`${prefix}-${name}`); await assert.rejects(f.run(), fixed); atMostOnce(f);
      if (!["readback", "scan"].includes(name)) assert.equal(f.events.includes("readback"), false, `${prefix}-${name}`);
      if (name === "readback") assert.equal(f.events.includes("scan"), false);
    }
  }
});

test("#1006: pending DOM resolved after abort cannot advance to inspection or scan", async () => {
  const f = fixture("pending-dom"), operation = f.run();
  while (!f.events.includes("dom")) await new Promise(done => setImmediate(done));
  f.controller.abort(canary); f.resume();
  await assert.rejects(operation, fixed); atMostOnce(f);
  assert.equal(f.events.includes("readback"), false); assert.equal(f.events.includes("scan"), false);
});

test("#1006: stop while DOM is pending prevents late completion from promoting readback", async () => {
  const f = fixture("pending-dom");
  f.ports.withIsolatedBrowserTls = async (consume, options) => {
    // The real sealed owner awaits DOM before close. A bad/late Port callback
    // still cannot turn premature cleanup into success after the await resolves.
    const pending = consume(f.input); pending.catch(() => {});
    while (!f.events.includes("dom")) await new Promise(done => setImmediate(done));
    await options.stopConsumer(); f.resume();
    await assert.rejects(pending, fixed);
    await assert.rejects(options.inspectOwned(f.home), fixed);
  };
  // This isolated owner fixture represents its completed TLS handoff.
  f.ports.createBookingWorkerPort = input => {
    assert.deepEqual(input.certificate, f.input.certificate);
    return { start: async () => "https://127.0.0.1:8789", isReady: () => true,
      stop: async () => { f.events.push("stop"); return { stopped: true, portClosed: true }; } };
  };
  await assert.rejects(f.run(), fixed); atMostOnce(f);
  assert.equal(f.events.includes("readback"), false); assert.equal(f.events.includes("scan"), false);
});

test("#1006: owner returning without awaiting its seed/handoff cannot prepare; pending continuation is closed", async () => {
  for (const boundary of ["seed", "tls"]) {
    const f = fixture("pending-dom"); let pending;
    if (boundary === "seed") f.ports.prepareTrustedBooking = consume => { pending = consume(f.seed, {}); pending.catch(() => {}); };
    else f.ports.withIsolatedBrowserTls = consume => { pending = consume(f.input); pending.catch(() => {}); };
    await assert.rejects(f.run(), fixed);
    if (f.events.includes("dom")) f.resume();
    await assert.rejects(pending, fixed);
    assert.equal(f.events.includes("readback"), false); assert.equal(f.events.includes("scan"), false); atMostOnce(f);
  }
});

test("#1006: sealed operator reuses fixed dependencies and scans only after unchanged, withholding private tokens", async () => {
  const f = fixture(), scans = [], trees = [];
  f.seed.sessions = { self: { cookie: () => ({ value: "self-private" }) }, other: { cookie: () => ({ value: "other-private" }) } };
  const source = readFileSync("tests/evaluation/trusted-unauthenticated-booking-process.mjs", "utf8")
    .replace(/^import .*;$/gm, "").replace(/export /g, "")
    .replace(/await import\("([^"]+)"\)/g, (_, path) => `dependencies[${JSON.stringify(path)}]`);
  const dependencies = {
    "./trusted-booking-seed.mjs": { ...f.ports, persistence: "fixture-db", directoryIdentity: () => f.identity,
      checkDirectoryIdentity: f.ports.checkBrowserHome, checkOwnedTree: path => { trees.push(path); } },
    "./browser-tls-trust.mjs": f.ports, "./trusted-booking-worker.mjs": f.ports, "./trusted-booking-dom.mjs": f.ports,
    "./trusted-seed-process.mjs": { checkFiles: (path, secrets) => { assert.equal(f.events.includes("readback"), true); scans.push({ path, secrets }); } },
  };
  const run = runInNewContext(`${source}\nrunUnauthenticatedBookingProcess`, { dependencies, createHash, resolve,
    mkdirSync: (path, options) => { assert.equal(path, f.home); assert.equal(options.mode, 0o700); },
    process: { env: { TMPDIR: "/fixture" }, argv: [] } });
  // Cross-realm records are compared through JSON at the external fake Ports.
  const contextPort = f.ports.createBookingWorkerPort;
  f.ports.createBookingWorkerPort = input => contextPort(JSON.parse(JSON.stringify(input)));
  dependencies["./trusted-booking-worker.mjs"] = f.ports;
  const tls = f.ports.withIsolatedBrowserTls;
  // newContext/fixture checks also see cross-realm objects.
  const browser = f.input.browser, newContext = browser.newContext;
  browser.newContext = input => newContext(JSON.parse(JSON.stringify(input)));
  const dom = f.ports.proveUnauthenticatedBookingDom;
  f.ports.proveUnauthenticatedBookingDom = input => dom({ ...input, fixture: JSON.parse(JSON.stringify(input.fixture)) });
  dependencies["./browser-tls-trust.mjs"] = { withIsolatedBrowserTls: tls };
  assert.equal(JSON.stringify(await run({ signal: f.controller.signal })), '{"phase":"complete","status":"prepared"}');
  assert.deepEqual(trees, ["fixture-db", "/fixture"]);
  const tokens = ["self-private", "other-private"];
  const hashes = tokens.map(token => createHash("sha256").update(token).digest("hex"));
  const csrf = tokens.map(token => createHash("sha256").update("student-csrf-v1:" + token).digest("base64url"));
  assert.equal(scans.length, 3);
  assert.equal(scans[0].path, "fixture-db"); assert.deepEqual([...scans[0].secrets], [...tokens, ...csrf]);
  for (const scan of scans.slice(1)) assert.deepEqual([...scan.secrets], [...tokens, ...hashes, ...csrf]);
});

test("#1006: import is silent, no CLI/report/delete or caller in Product/workflow/normal owners", () => {
  const path = "tests/evaluation/trusted-unauthenticated-booking-process.mjs";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import('./${path}')`], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  const source = readFileSync(path, "utf8");
  assert.doesNotMatch(source, /console\.|addCookies|writeBookingDiagnostic|bookingChildComplete|bookingOuterCheckpoint|inspectTrustedBooking\(|\b(?:rmSync|unlinkSync|spawn|execFile|fetch)\s*\(/);
  const scan = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) scan(file);
      else assert.doesNotMatch(readFileSync(file, "utf8"), /trusted-unauthenticated-booking-process|(?:use|run)UnauthenticatedBookingProcess/, file);
    }
  };
  scan("src"); scan(".github/workflows");
  for (const name of ["trusted-booking-process.mjs", "trusted-booking-child.mjs", "trusted-booking-outer.mjs", "trusted-booking-report.mjs"])
    assert.doesNotMatch(readFileSync(`tests/evaluation/${name}`, "utf8"), /UnauthenticatedBookingProcess|trusted-unauthenticated-booking-process/);
  assert.ok(JSON.parse(readFileSync("package.json", "utf8")).scripts["test:unit"].includes("trusted-unauthenticated-booking-process.test.mjs"));
});

// #1018 oracle: only boundaries exposed by the existing Ports. TLS setup is
// aggregate trust/handoff preparation, not a claim about its internal preflight.
const phaseOracle = [
  ["preflight", "preflight", "unknown"], ["seed", "seed", "preflight"],
  ["home", "home", "seed"], ["tls", "tls-setup", "home"],
  ["worker-create", "worker-start", "tls-setup"], ["start", "worker-stop", "worker-stop"],
  ["context", "worker-stop", "worker-stop"], ["dom", "worker-stop", "worker-stop"],
  ["browser-close", "worker-stop", "worker-stop"], ["stop", "worker-stop", "dom-401"],
  ["readback", "d1-unchanged", "worker-stop"], ["scan", "secret-scan", "d1-unchanged"],
];
test("#1018 exact last entered/confirmed at each failing Port, including emergency stop", async () => {
  for (const [fault, entered, confirmed] of phaseOracle) {
    const f = fixture(fault); await assert.rejects(f.run(), fixed); atMostOnce(f);
    assert.equal(f.observations.filter(e => e.state === "entered").at(-1).phase, entered, fault);
    assert.equal(f.observations.filter(e => e.state === "confirmed").at(-1)?.phase ?? "unknown", confirmed, fault);
    assert.ok(f.observations.every(Object.isFrozen));
    assert.ok(!JSON.stringify(f.observations).includes(canary));
  }
  const f = fixture(); await f.run();
  assert.deepEqual(f.observations.map(e => `${e.phase}:${e.state}`), [
    "preflight:entered", "preflight:confirmed", "seed:entered", "seed:confirmed", "home:entered", "home:confirmed",
    "tls-setup:entered", "tls-setup:confirmed", "worker-start:entered", "worker-start:confirmed",
    "dom-401:entered", "dom-401:confirmed", "tls-cleanup:entered", "worker-stop:entered", "worker-stop:confirmed",
    "d1-unchanged:entered", "d1-unchanged:confirmed", "secret-scan:entered", "secret-scan:confirmed",
  ]);
});

test("#1018 observer throws never change effects, failure latch or single owned stop", async () => {
  for (const fault of ["", "dom", "stop", "readback"]) {
    const f = fixture(fault);
    const operation = useUnauthenticatedBookingProcess(f.ports, f.controller.signal, () => { throw new Error(canary); });
    if (fault) await assert.rejects(operation, fixed); else assert.deepEqual(await operation, { phase: "complete", status: "prepared" });
    atMostOnce(f); assert.equal(f.events.filter(e => e === "stop").length, 1);
  }
});

test("#1018 real process → Child fixed failure report at every phase, one write and no replay", async () => {
  for (const [fault, entered, confirmed] of phaseOracle) {
    const f = fixture(fault), writes = []; let calls = 0;
    const input = { isolated: true, signal: f.controller.signal,
      runInner: ({ signal, observe }) => { calls++; return useUnauthenticatedBookingProcess(f.ports, signal, observe); },
      write: text => { writes.push(text); },
    };
    assert.equal(await useUnauthenticatedBookingChild(input), false, fault);
    assert.equal(calls, 1); atMostOnce(f);
    assert.deepEqual(writes, [`TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=failed; entered=${entered}; confirmed=${confirmed}; status=failed\n`], fault);
    assert.deepEqual(parseUnauthenticatedBookingReport(writes[0]), { phase: "failed", entered, confirmed, status: "failed" });
    const before = [...f.events]; assert.equal(await useUnauthenticatedBookingChild(input), false);
    assert.equal(calls, 1); assert.equal(writes.length, 1); assert.deepEqual(f.events, before);
  }
});

test("#1018 sealed operator dependency import failures retain import entered without confirmation", async () => {
  const source = readFileSync("tests/evaluation/trusted-unauthenticated-booking-process.mjs", "utf8")
    .replace(/^import .*;$/gm, "").replace(/export /g, "")
    .replace(/await import\("([^"]+)"\)/g, (_, path) => `dependencies[${JSON.stringify(path)}]`);
  for (const path of ["./trusted-booking-seed.mjs", "./browser-tls-trust.mjs", "./trusted-booking-worker.mjs",
    "./trusted-booking-dom.mjs", "./trusted-seed-process.mjs"]) {
    const dependencies = new Proxy({}, { get(_, key) { if (key === path) throw new Error(canary); return {}; } });
    const observations = [];
    const run = runInNewContext(`${source}\nrunUnauthenticatedBookingProcess`, { dependencies });
    await assert.rejects(run({ signal: new AbortController().signal, observe: event => observations.push(JSON.parse(JSON.stringify(event))) }), fixed);
    assert.deepEqual(observations, [{ phase: "import", state: "entered" }]);
  }
});
