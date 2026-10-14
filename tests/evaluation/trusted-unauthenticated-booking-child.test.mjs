// #1008 finite Child Ports and VM operator gate; never execute the real CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { useUnauthenticatedBookingChild } from "./trusted-unauthenticated-booking-child.mjs";
import { useUnauthenticatedBookingProcess } from "./trusted-unauthenticated-booking-process.mjs";
import * as report from "./trusted-unauthenticated-booking-report.mjs";

const good = () => ({ phase: "complete", status: "prepared" });
const canary = "private-session-csrf-sql-https://private.invalid/credential";
const failureReport = observation => report.formatUnauthenticatedBookingFailure({ tls_primary: "unknown", tls_cleanup: "unknown", tls_err: "unknown", ...observation });
const unknown = failureReport({ entered: "unknown", confirmed: "unknown" });
const complete = "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; execution=isolated; phase=complete; status=prepared; readback=unchanged\n";
function fixture(options = {}) {
  const controller = new AbortController(), writes = []; let calls = 0;
  const runInner = async input => { calls++; assert.deepEqual(Object.keys(input), ["signal", "observe", "observeTls"]); assert.equal(input.signal, controller.signal);
    return options.inner ? options.inner(controller, input.observe, input.observeTls) : good(); };
  const input = { runInner, write: async text => { writes.push(text); if (options.write) await options.write(text, controller); },
    signal: controller.signal, isolated: options.isolated ?? true };
  return { input, controller, writes, calls: () => calls };
}

test("#1008 one inner, prepared unchanged only, fixture distinct; repeat and parallel have no effects", async () => {
  for (const isolated of [true, false, undefined, "true"]) {
    const f = fixture(); f.input.isolated = isolated;
    assert.equal(await useUnauthenticatedBookingChild(f.input), true);
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.writes, [isolated === true ? complete : complete.replace("isolated", "fixture")]);
    assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    assert.equal(f.calls(), 1); assert.equal(f.writes.length, 1);
  }
  let finish; const f = fixture({ inner: () => new Promise(done => { finish = done; }) });
  const first = useUnauthenticatedBookingChild(f.input);
  assert.equal(await useUnauthenticatedBookingChild({ ...f.input }), false);
  assert.deepEqual(f.writes, []); finish(good()); assert.equal(await first, true);
  assert.equal(f.calls(), 1); assert.deepEqual(f.writes, [complete]);
});

test("#930 first-failure finite snapshot is latched before cleanup and separate TLS axes remain observable", async () => {
  const f = fixture({ inner: (_, observe, observeTls) => {
    const emit = (phase, state) => observe(Object.freeze({ phase, state }));
    emit("import", "entered"); emit("import", "confirmed");
    emit("worker-start", "entered");
    emit("worker-start", "first-failure");
    // Cleanup completion must not conceal the first failure.
    emit("worker-stop", "entered"); emit("worker-stop", "confirmed");
    observeTls(Object.freeze({ tls_primary: "tls-consumer", tls_err: "UNCLASSIFIED" }));
    observeTls(Object.freeze({ tls_cleanup: "owned-inspect" }));
    throw new Error(canary);
  } });
  assert.equal(await useUnauthenticatedBookingChild(f.input), false);
  assert.deepEqual(f.writes, [failureReport({
    entered: "worker-start", confirmed: "import", tls_primary: "tls-consumer",
    tls_cleanup: "owned-inspect", tls_err: "UNCLASSIFIED",
  })]);
  assert.equal(f.calls(), 1);
  assert.equal(await useUnauthenticatedBookingChild(f.input), false);
  assert.equal(f.writes.length, 1);

  const invalid = fixture({ inner: (_, observe) => {
    observe(Object.freeze({ phase: "import", state: "entered" }));
    observe(Object.freeze({ phase: "dom-401", state: "first-failure" })); // Not the active phase.
    observe(Object.freeze({ phase: "worker-stop", state: "entered" }));
    throw new Error(canary);
  } });
  assert.equal(await useUnauthenticatedBookingChild(invalid.input), false);
  assert.deepEqual(invalid.writes, [unknown]);
});

test("#1044 response first-failure phases pass the existing Child enum and latch once", async () => {
  for (const selected of ["dom-rsp-id", "dom-rsp-code", "dom-rsp-hdr", "dom-rsp-body", "dom-rsp-jar", "dom-rsp-drv", "rsp-meta-err", "rsp-hdr-err", "rsp-hdr-to", "rsp-body-err", "rsp-body-to", "rsp-jar-err", "rsp-jar-to", "rsp-guard-ex", "rsp-outer-to"]) {
    const f = fixture({ inner: (_, observe) => {
      const emit = (phase, state) => observe(Object.freeze({ phase, state }));
      emit("dom-context", "entered"); emit("dom-context", "confirmed");
      emit("dom-response", "entered"); // The existing coarse phase remains legal.
      emit(selected, "entered"); emit(selected, "first-failure");
      emit("dom-rsp-drv", "entered"); emit("worker-stop", "entered"); emit("worker-stop", "confirmed");
      emit(canary, "first-failure");
      throw new Error(canary);
    } });
    assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    assert.deepEqual(f.writes, [failureReport({ entered: selected, confirmed: "dom-context" })]);
    assert.equal(f.calls(), 1);
    assert.equal(await useUnauthenticatedBookingChild(f.input), false); assert.equal(f.writes.length, 1);
  }
});

test("#1008 exact result mismatch, raw throw and rejected Promise are unknown once without replay", async () => {
  const invalid = [null, undefined, true, "complete", [], {}, { phase: "complete" }, { phase: "complete", status: "success" },
    { phase: "unknown", status: "prepared" }, { ...good(), readback: "unchanged" }, { ...good(), [Symbol("secret")]: canary },
    Object.defineProperty(good(), "raw", { value: canary }), { get phase() { return "complete"; }, status: "prepared" }, new Proxy({}, { ownKeys() { throw new Error(canary); } })];
  for (const result of invalid) {
    const f = fixture({ inner: () => result }); assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    assert.equal(f.calls(), 1); assert.deepEqual(f.writes, [unknown]);
  }
  for (const inner of [() => { throw new Error(canary, { cause: canary }); }, () => Promise.reject(new Error(canary))]) {
    const f = fixture({ inner }); assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    assert.equal(f.calls(), 1); assert.deepEqual(f.writes, [unknown]);
  }
});

test("#1008 abort before/during/after inner, pending and late resolution never publish success", async () => {
  const pre = fixture(); pre.controller.abort(canary);
  assert.equal(await useUnauthenticatedBookingChild(pre.input), false); assert.equal(pre.calls(), 0); assert.deepEqual(pre.writes, [unknown]);
  for (const throwAfterAbort of [false, true]) {
    const during = fixture({ inner: c => { c.abort(canary); if (throwAfterAbort) throw new Error(canary); return good(); } });
    assert.equal(await useUnauthenticatedBookingChild(during.input), false); assert.deepEqual(during.writes, [unknown]);
  }
  for (const late of ["resolve", "reject", "double"]) {
    let resolveInner, rejectInner;
    const f = fixture({ inner: () => new Promise((done, reject) => { resolveInner = done; rejectInner = reject; }) });
    const result = useUnauthenticatedBookingChild(f.input); f.controller.abort(canary);
    assert.equal(await result, false); assert.deepEqual(f.writes, [unknown]);
    if (late === "reject") rejectInner(new Error(canary));
    else { resolveInner(good()); if (late === "double") { resolveInner(good()); rejectInner(new Error(canary)); } }
    await new Promise(done => setImmediate(done));
    assert.equal(f.calls(), 1); assert.deepEqual(f.writes, [unknown]);
  }
});

test("#1008 write uncertainty/async rejection or abort never retry the writer; stale success is not overwritten", async () => {
  for (const write of [() => { throw new Error(canary); }, () => Promise.reject(new Error(canary)), (_, c) => c.abort(canary)]) {
    const f = fixture({ write }); assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    assert.equal(f.calls(), 1); assert.deepEqual(f.writes, [complete]);
    assert.equal(await useUnauthenticatedBookingChild(f.input), false); assert.equal(f.writes.length, 1);
  }
  let release;
  const pending = fixture({ write: text => text === complete ? new Promise(done => { release = done; }) : undefined });
  const pendingResult = useUnauthenticatedBookingChild(pending.input);
  await new Promise(done => setImmediate(done)); pending.controller.abort(canary);
  assert.equal(await pendingResult, false); release();
  await new Promise(done => setImmediate(done)); assert.deepEqual(pending.writes, [complete]);
  const f = fixture({ inner: () => { throw new Error(canary); }, write: () => { throw new Error(canary); } });
  assert.equal(await useUnauthenticatedBookingChild(f.input), false); assert.deepEqual(f.writes, [unknown]);
  const dir = mkdtempSync(join(tmpdir(), "nssscdl-negative-child-"));
  try {
    report.writeUnauthenticatedBookingReport(dir, report.unauthenticatedBookingFixtureComplete);
    const blocked = fixture(); blocked.input.write = text => report.writeUnauthenticatedBookingReport(dir, text);
    assert.equal(await useUnauthenticatedBookingChild(blocked.input), false);
    assert.equal(report.readUnauthenticatedBookingReport(dir).execution, "fixture");
    assert.deepEqual(readdirSync(dir), ["unauthenticated-booking-report"]);
  } finally { rmSync(dir, { recursive: true }); }
  const uncertainDir = mkdtempSync(join(tmpdir(), "nssscdl-negative-written-"));
  try {
    const uncertain = fixture(); let attempts = 0;
    uncertain.input.write = text => {
      attempts++; report.writeUnauthenticatedBookingReport(uncertainDir, text);
      throw new Error(canary); // Success file exists, but its caller did not observe write completion.
    };
    assert.equal(await useUnauthenticatedBookingChild(uncertain.input), false);
    assert.equal(attempts, 1); assert.equal(uncertain.calls(), 1);
    assert.deepEqual(report.readUnauthenticatedBookingReport(uncertainDir),
      { execution: "isolated", phase: "complete", status: "prepared", readback: "unchanged" });
  } finally { rmSync(uncertainDir, { recursive: true }); }
});

test("#1008 real prepared inner through finite Ports reaches unchanged/scan before the dedicated report", async () => {
  const f = fixture(), events = [], signal = f.controller.signal;
  f.input.runInner = ({ signal: inputSignal, observe }) => useUnauthenticatedBookingProcess({
    async prepareTrustedBooking(consume, entered) { entered(); events.push("seed"); await consume({ month: "2026-10" }, "private-handle"); },
    createBrowserHome() { return { home: "fixture-home", identity: {} }; }, checkBrowserHome() {},
    createBookingWorkerPort() { return { async start() { events.push("worker"); return "https://127.0.0.1:8789"; }, isReady: () => true,
      async stop() { events.push("stop"); return { stopped: true, portClosed: true }; } }; },
    async withIsolatedBrowserTls(consume, options) {
      assert.equal(options.workerHandoff, true);
      await consume({ signal, certificate: {}, browser: { async newContext(settings) {
        assert.deepEqual(settings, { ignoreHTTPSErrors: false, serviceWorkers: "block" }); return {}; } } });
      events.push("close"); await options.stopConsumer(); await options.inspectOwned("fixture-home");
    },
    async proveUnauthenticatedBookingDom(input) { assert.deepEqual(input.fixture, { month: "2026-10" }); events.push("dom401"); },
    async inspectTrustedBookingUnchanged(handle) { assert.equal(handle, "private-handle"); events.push("unchanged"); },
    async scanOwnedSecrets() { events.push("scan"); },
  }, inputSignal, observe);
  f.input.write = text => { events.push("report"); assert.equal(text, complete); };
  assert.equal(await useUnauthenticatedBookingChild(f.input), true);
  assert.deepEqual(events, ["seed", "worker", "dom401", "close", "stop", "unchanged", "scan", "report"]);
});

async function operator({ argv = ["node", "fixture-child", "--isolated-child"], fault, interruptBy } = {}) {
  const events = [], listeners = new Map(); let timer, timerCleared, receivedSignal;
  const fakeProcess = { argv, env: { TMPDIR: "owned-fixture" }, on(name, fn) { listeners.set(name, fn); events.push("on:" + name); },
    removeListener(name, fn) { assert.equal(listeners.get(name), fn); listeners.delete(name); events.push("off:" + name); } };
  const source = readFileSync("tests/evaluation/trusted-unauthenticated-booking-child.mjs", "utf8")
    .replace(/^import[\s\S]*?from .*;\n/gm, "").replace(/^export /gm, "")
    .replace("fileURLToPath(import.meta.url)", "resolve('fixture-child')")
    .replace('await import("./trusted-unauthenticated-booking-process.mjs")', "await loadInner()");
  await runInNewContext(`(async () => { ${source} })()`, {
    ...report, types, process: fakeProcess, resolve, AbortController,
    setTimeout(fn, ms) { assert.equal(ms, 110000); timer = fn; events.push("timer"); return "timer-id"; },
    clearTimeout(id) { assert.equal(id, "timer-id"); timerCleared = true; events.push("clear"); },
    writeUnauthenticatedBookingReport(dir, text) { assert.equal(dir, "owned-fixture"); events.push(text);
      if (fault === "write") throw new Error(canary); },
    async loadInner() {
      events.push("load-negative"); if (fault === "load") throw new Error(canary);
      return { async runUnauthenticatedBookingProcess(input) {
        assert.deepEqual(Object.keys(input), ["signal", "observe", "observeTls"]);
        assert.equal(typeof input.observeTls, "function");
        receivedSignal = input.signal; events.push("inner");
        if (interruptBy === "timer") timer(); else if (interruptBy) listeners.get(interruptBy)();
        if (fault === "tls") {
          input.observeTls(Object.freeze({ tls_primary: "tls-cert", tls_err: "ERR_CERT_INVALID" }));
          input.observeTls(Object.freeze({ tls_cleanup: "browser-close" }));
          throw new Error(canary);
        }
        if (fault === "inner") throw new Error(canary);
        return good();
      } };
    },
  });
  return { events, listeners, timerCleared, receivedSignal, exitCode: fakeProcess.exitCode };
}

test("#1008 operator 110s soft abort, SIGINT/SIGTERM and teardown, sealed negative path, raw secrecy", async () => {
  for (const options of [{}, { fault: "load" }, { fault: "inner" }, { fault: "write" }, { fault: "tls" },
    { interruptBy: "timer" }, { interruptBy: "SIGINT" }, { interruptBy: "SIGTERM" }]) {
    const result = await operator(options);
    assert.equal(result.timerCleared, true); assert.equal(result.listeners.size, 0);
    assert.equal(result.exitCode, Object.keys(options).length ? 1 : undefined);
    assert.ok(!JSON.stringify(result.events).includes(canary));
    assert.equal(result.events.filter(e => e === "inner").length, options.fault === "load" ? 0 : 1);
    if (options.interruptBy) { assert.equal(result.receivedSignal.aborted, true); assert.ok(result.events.includes(failureReport({ entered: "import", confirmed: "import" }))); }
    if (!Object.keys(options).length) assert.ok(result.events.includes(complete));
    if (options.fault === "load") assert.ok(result.events.includes(failureReport({ entered: "import", confirmed: "unknown" })));
    if (options.fault === "tls") assert.ok(result.events.includes(failureReport({ entered: "import", confirmed: "import",
      tls_primary: "tls-cert", tls_cleanup: "browser-close", tls_err: "ERR_CERT_INVALID" })));
    assert.equal(result.events.filter(e => typeof e === "string" && e.startsWith("TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1;")).length, 1);
  }
});

test("#1008 import and invalid CLI gates are inert: no timer, dependency load, output or files", async () => {
  for (const argv of [["node"], ["node", "other-entry", "--isolated-child"], ["node", "fixture-child"],
    ["node", "fixture-child", "--other"], ["node", "fixture-child", "--isolated-child", "extra"]]) {
    const result = await operator({ argv }); assert.deepEqual(result.events, []);
    assert.equal(result.exitCode, argv[1] === "fixture-child" ? 1 : undefined);
  }
});

test("#1008 subprocess import and invalid CLI do not load the real inner or create files", () => {
  const dir = mkdtempSync(join(tmpdir(), "nssscdl-negative-gate-"));
  const path = resolve("tests/evaluation/trusted-unauthenticated-booking-child.mjs");
  try {
    for (const args of [["--input-type=module", "-e", `await import(${JSON.stringify(path)})`], [path], [path, "--other"], [path, "--isolated-child", "extra"]]) {
      const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: dir, HOME: dir, XDG_CONFIG_HOME: dir }, timeout: 5000 });
      assert.equal(result.error, undefined); assert.equal(result.signal, null);
      assert.equal(result.status, args[0] === "--input-type=module" ? 0 : 1);
      assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); assert.deepEqual(readdirSync(dir), []);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test("#1018 private observations reject getters/unknown/extra, retain no raw exception or invalid phase", async () => {
  let getters = 0;
  for (const event of [{ phase: "seed", state: "entered", raw: canary },
    { phase: "seed", state: "entered", [Symbol()]: canary }, { phase: canary, state: "entered" },
    { phase: "unknown", state: "entered" }, { phase: "report-write", state: "entered" },
    { phase: "seed", state: "completed" }, { phase: "seed", state: "confirmed" },
    { get phase() { getters++; throw new Error(canary); }, state: "entered" },
    new Proxy({}, { ownKeys() { throw new Error(canary); } })]) {
    const f = fixture({ inner: (_, observe) => { observe(event);
      observe({ phase: "home", state: "entered" }); throw new Error(canary); } });
    assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    assert.equal(f.calls(), 1); assert.deepEqual(f.writes, [unknown]);
  }
  assert.equal(getters, 0);
});

test("#1018 timeout/abort freezes last observed phase; late continuation cannot alter report", async () => {
  for (const mode of ["abort", "timeout"]) {
    let late, release;
    const f = fixture({ inner: (controller, observe) => {
      observe({ phase: "worker-start", state: "entered" }); observe({ phase: "worker-start", state: "confirmed" });
      observe({ phase: "dom-401", state: "entered" }); late = observe;
      if (mode === "timeout") { const error = new Error(canary); error.name = "TimeoutError"; throw error; }
      return new Promise(done => { release = done; });
    } });
    const result = useUnauthenticatedBookingChild(f.input);
    if (mode === "abort") f.controller.abort(canary);
    assert.equal(await result, false); assert.equal(f.calls(), 1);
    assert.deepEqual(f.writes, [failureReport({ entered: "dom-401", confirmed: "worker-start" })]);
    late({ phase: "dom-401", state: "confirmed" }); late({ phase: "secret-scan", state: "entered" });
    if (release) release(good()); await new Promise(done => setImmediate(done));
    assert.equal(f.writes.length, 1);
  }
});

test("#1018 import failure progress and report writer failure do not regenerate absent files", async () => {
  for (const when of ["import", "inner"]) {
    const dir = mkdtempSync(join(tmpdir(), "nssscdl-negative-observation-"));
    try {
      let attempts = 0;
      const f = fixture({ inner: (_, observe) => {
        observe({ phase: "import", state: "entered" });
        if (when === "inner") observe({ phase: "import", state: "confirmed" });
        throw new Error(canary);
      } });
      f.input.write = text => { attempts++; assert.equal(text, failureReport({ entered: "import", confirmed: when === "inner" ? "import" : "unknown" }));
        throw new Error(canary); };
      assert.equal(await useUnauthenticatedBookingChild(f.input), false);
      assert.equal(attempts, 1); assert.equal(f.calls(), 1); assert.deepEqual(readdirSync(dir), []);
    } finally { rmSync(dir, { recursive: true }); }
  }
});

test("#1023 TLS Port accepts own non-Proxy enums only; invalid events preserve first valid axes and never call getters/traps", async () => {
  let touched = 0;
  const primary = { tls_primary: "tls-cert", tls_err: "ERR_CERT_INVALID" }, cleanup = { tls_cleanup: "browser-close" };
  const proxy = new Proxy(primary, { ownKeys() { touched++; return Reflect.ownKeys(primary); },
    getOwnPropertyDescriptor(_, key) { touched++; return Object.getOwnPropertyDescriptor(primary, key); } });
  const revocable = Proxy.revocable(primary, {}); revocable.revoke();
  const invalid = [null, undefined, true, canary, {}, [], proxy, revocable.proxy, Object.create(primary),
    { ...primary, raw: canary }, { ...primary, [Symbol()]: canary }, { tls_primary: canary, tls_err: "TIMEOUT" },
    { tls_primary: "none", tls_err: "UNCLASSIFIED" }, { tls_primary: "unknown", tls_err: "TIMEOUT" },
    { tls_primary: "tls-cert", tls_err: "unknown" }, { tls_primary: "tls-cert", tls_err: canary },
    { tls_primary: "tls-cert" }, { tls_err: "TIMEOUT" }, { tls_cleanup: "none" }, { tls_cleanup: "unknown" },
    { tls_cleanup: canary }, { ...cleanup, raw: canary }, { ...cleanup, ...primary },
    { get tls_primary() { touched++; throw new Error(canary); }, tls_err: "TIMEOUT" },
    { tls_primary: "tls-cert", get tls_err() { touched++; throw new Error(canary); } },
    { get tls_cleanup() { touched++; throw new Error(canary); } }];
  for (const event of invalid) for (const validFirst of [false, true]) {
    const f = fixture({ inner: (_, observe, observeTls) => {
      observe({ phase: "tls-setup", state: "entered" });
      if (validFirst) { observeTls(primary); observeTls(cleanup); }
      assert.equal(observeTls(event), undefined);
      throw new Error(canary);
    } });
    assert.equal(await useUnauthenticatedBookingChild(f.input), false); assert.equal(f.calls(), 1);
    assert.deepEqual(f.writes, [failureReport({ entered: "tls-setup", confirmed: "unknown",
      tls_primary: validFirst ? "tls-cert" : "unknown", tls_cleanup: validFirst ? "browser-close" : "unknown",
      tls_err: validFirst ? "ERR_CERT_INVALID" : "unknown" })]);
  }
  assert.equal(touched, 0);
});

test("#1023 first primary and bound error survive duplicate/cleanup/abort/timeout; write and late callbacks stay closed", async () => {
  for (const mode of ["throw", "abort", "timeout", "write-throw"]) {
    let late; const f = fixture({ inner: (controller, observe, observeTls) => {
      late = observeTls;
      observe({ phase: "dom-401", state: "entered" });
      observeTls({ tls_primary: "tls-san", tls_err: "ERR_CERT_COMMON_NAME_INVALID" });
      observeTls({ tls_primary: "tls-consumer", tls_err: "TIMEOUT" });
      observeTls({ tls_cleanup: "browser-ownership" }); observeTls({ tls_cleanup: "worker-stop" });
      if (mode === "abort") { controller.abort(canary); observeTls({ tls_cleanup: "owned-remove" }); }
      if (mode === "timeout") { const error = new Error(canary); error.name = "TimeoutError"; throw error; }
      throw new Error(canary);
    }, write: mode === "write-throw" ? () => { throw new Error(canary); } : undefined });
    assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.writes, [failureReport({ entered: "dom-401", confirmed: "unknown",
      tls_primary: "tls-san", tls_cleanup: "browser-ownership", tls_err: "ERR_CERT_COMMON_NAME_INVALID" })]);
    late({ tls_primary: "tls-preflight", tls_err: "UNCLASSIFIED" }); late({ tls_cleanup: "owned-remove" });
    assert.equal(await useUnauthenticatedBookingChild(f.input), false); assert.equal(f.writes.length, 1);
  }
  for (const primaryFirst of [false, true]) {
    const f = fixture({ inner: (_, __, observeTls) => {
      observeTls({ tls_primary: "tls-cert", tls_err: canary }); // Partial primary cannot latch the stage.
      if (primaryFirst) observeTls({ tls_primary: "tls-cert", tls_err: "ERR_CERT_INVALID" });
      observeTls({ tls_cleanup: "worker-stop" });
      observeTls({ tls_primary: "tls-positive", tls_err: "TIMEOUT" }); // Inconsistent late primary.
      throw new Error(canary);
    } });
    assert.equal(await useUnauthenticatedBookingChild(f.input), false);
    const parsed = report.parseUnauthenticatedBookingReport(f.writes[0]);
    assert.equal(parsed.tls_primary, primaryFirst ? "tls-cert" : "unknown");
    assert.equal(parsed.tls_err, primaryFirst ? "ERR_CERT_INVALID" : "unknown"); assert.equal(parsed.tls_cleanup, "worker-stop");
  }
});

test("#1023 TLS diagnostics remain passive on complete; failed report uses new schema even before entry", async () => {
  const f = fixture({ inner: (_, __, observeTls) => {
    observeTls({ tls_primary: "tls-preflight", tls_err: "UNCLASSIFIED" }); observeTls({ tls_cleanup: "browser-close" });
    return good();
  } });
  assert.equal(await useUnauthenticatedBookingChild(f.input), true); assert.deepEqual(f.writes, [complete]);
  const before = fixture(); before.controller.abort(canary);
  assert.equal(await useUnauthenticatedBookingChild(before.input), false); assert.equal(before.calls(), 0);
  assert.equal(before.writes[0], "TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_V1; phase=failed; entered=unknown; confirmed=unknown; tls_primary=unknown; tls_cleanup=unknown; tls_err=unknown; status=failed\n");
});
