// Issue #945 oracles: strict success order, fixed grammar, no replay, failure retention.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fileSystem from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { BrowserUnit, ownedIdentity, verifyOwned } from "./trusted-browser-unit.mjs";
import { useTrustedBookingProcess } from "./trusted-booking-process.mjs";
import { useBookingChild } from "./trusted-booking-child.mjs";
import { bookingOuterCheckpoint, useBookingOuter } from "./trusted-booking-outer.mjs";
import { bookingChildComplete, bookingChildUnknown, bookingFixtureComplete, parseBookingReport, readBookingReport, writeBookingReport } from "./trusted-booking-report.mjs";
import { bookingDiagnosticName, encodeBookingDiagnostic, parseBookingDiagnostic, readBookingDiagnostic, writeBookingDiagnostic } from "./trusted-booking-report.mjs";

const canary = "private-session-state-csrf-sql-pii-stderr";
const stages = ["preflight", "start", "terminal", "report", "ownership", "release", "remove", "listeners", "operator"];
const reasons = ["timeout", "manager", "mismatch", "cancel", "unknown"];
const diagnostic = (stage, reason = "unknown") => `TRUSTED_BOOKING_OUTER_FAILED; stage=${stage}${stage === "terminal" ? `; reason=${reason}` : ""}; retain owned files; do not retry`;
const legacyTerminal = "TRUSTED_BOOKING_OUTER_FAILED; stage=terminal; retain owned files; do not retry";
const terminalFaultReason = fault => ({ invocation: "mismatch", live: "timeout", timeout: "timeout", abort: "cancel" }[fault] ?? "manager");
const fixed = e => ([...stages, "unknown"].some(stage => e.message === diagnostic(stage)) || reasons.some(reason => e.message === diagnostic("terminal", reason))) && !e.stack.includes(canary) && !("cause" in e);

// The real inner controller through finite Ports: no D1/TLS/Chrome/systemd execution.
function innerPorts(events, fault, signal) {
  const hit = name => { events.push(name); if (fault === name) throw new Error(canary); signal.throwIfAborted(); };
  const cookie = { name: "__Host-student_session", value: canary, path: "/", secure: true, httpOnly: true, sameSite: "Lax" };
  return {
    async prepareTrustedBooking(consume) {
      hit("seed"); assert.equal(events.includes("home"), false); hit("seed-dispose");
      await consume({ sessions: { self: { cookie: () => cookie } } }, {});
    },
    createBrowserHome() { hit("home"); return { home: "fixture-home", identity: {} }; },
    checkBrowserHome() { hit("identity"); },
    async withIsolatedBrowserTls(consume, options) {
      try {
        hit("tls-positive"); hit("tls-negative"); hit("8788-closed");
        await consume({ browser: { async newContext() { hit("context"); return { async addCookies() { hit("cookie"); } }; } },
          certificate: {}, signal });
      } finally {
        hit("browser-close"); await options.stopConsumer(); await options.inspectOwned("fixture-home");
      }
    },
    createBookingWorkerPort() { return { async start() { hit("worker"); return "https://127.0.0.1:8789"; }, isReady: () => true,
      async stop() { hit("worker-stop"); hit("8789-closed"); return { stopped: true, portClosed: true }; } }; },
    async proveTrustedBookingDom() { hit("preview200"); hit("confirm201"); hit("history"); return "opaque-memory-only"; },
    async inspectTrustedBooking() { hit("readback-five-tables"); },
    async scanOwnedSecrets() { hit("secret-scan"); },
  };
}

function fixture(fault = "", { preflightTime = 0, terminalState = {} } = {}) {
  let time = 0, observations = 0, stopped = false, text;
  const controller = new AbortController(), events = [];
  const unit = new BrowserUnit({ env: { PATH: "/usr/bin", HOME: "fixture", TMPDIR: "fixture" }, cwd: "fixture",
    uid: 7, gid: 7, signal: controller.signal, now: () => time, deadline: 180000, sleep: async ms => { time += ms; },
    command: async (file, args) => {
      assert.equal(file, "sudo"); assert.equal(args[0], "-n");
      if (args[1] === "systemd-run") {
        events.push("start");
        assert.ok(args.includes(`--property=RuntimeMaxSec=${Math.min(120, Math.floor((170000 - preflightTime) / 1000))}s`));
        assert.ok(args.includes("tests/evaluation/trusted-booking-child.mjs"));
        if (fault === "start") throw new Error(canary);
        const ok = await useBookingChild({ signal: controller.signal, isolated: true,
          runInner: options => useTrustedBookingProcess(innerPorts(events, fault, options.signal), options.signal),
          write: value => { events.push("child-report"); text = value; } });
        events.push(ok ? "child-exit0" : "child-exit1"); return "";
      }
      if (args[2] === "stop") {
        events.push("stop"); stopped = true;
        if (fault === "stop") throw new Error(canary); return "";
      }
      events.push("show"); observations++;
      if (fault === "manager") throw new Error(canary);
      const state = stopped ? { LoadState: "not-found", ActiveState: "inactive", SubState: "dead", InvocationID: "" } : {
        Type: "exec", ExitType: "cgroup", RemainAfterExit: "yes", Restart: "no", NRestarts: "0", OOMPolicy: "stop",
        Delegate: "no", NoNewPrivileges: "yes", ProtectControlGroups: "yes", KillMode: "control-group",
        StandardOutput: "null", StandardError: "null", User: "7", Group: "7", RuntimeMaxUSec: `${unit.runtime}s`, TimeoutStopUSec: "2s",
        LoadState: "loaded", ActiveState: "active", SubState: "exited", Result: "success", ExecMainCode: "1",
        ExecMainStatus: events.includes("child-exit1") ? "1" : "0", InvocationID: "b".repeat(32), ControlGroup: "/system.slice/" + unit.name };
      if (!stopped && observations >= 2) Object.assign(state, terminalState);
      if (!stopped && observations === 3) {
        if (fault === "invocation") state.InvocationID = "c".repeat(32);
        if (fault === "timeout") time = 170000;
        if (fault === "abort") controller.abort(canary);
      }
      if (fault === "live" && !stopped) { state.SubState = "running"; time += 60000; }
      if (fault === "release" && stopped) state.ActiveState = "active";
      return Object.entries(state).map(([k, v]) => `${k}=${v}`).join("\n");
    } });
  const ports = {
    async preflight() { events.push("preflight"); time += preflightTime; if (fault === "preflight") throw new Error(canary); },
    async report() {
      events.push("report");
      return parseBookingReport(fault === "fixture-report" ? bookingFixtureComplete : fault === "report" ? canary : text);
    },
    async finalCheck() {
      events.push("ports/generated/identities");
      if (["listener", "generated", "ownership"].includes(fault)) throw new Error(canary);
      if (fault === "late-abort") controller.abort(canary);
    },
    async remove() { if (fault === "identity-drift") throw new Error(canary); events.push("delete"); },
  };
  return { unit, ports, events, controller };
}

test("#945 one inner seed/Confirm/readback, same-invocation terminal, booking report, independent checks, release, then delete", async () => {
  const f = fixture(); assert.deepEqual(await useBookingOuter(f.unit, f.ports), { success: true, status: "prepared" });
  for (const event of ["seed", "confirm201", "readback-five-tables", "start", "stop", "delete"]) assert.equal(f.events.filter(e => e === event).length, 1);
  const required = ["seed-dispose", "home", "tls-positive", "tls-negative", "8788-closed", "worker", "preview200", "confirm201", "history",
    "browser-close", "worker-stop", "8789-closed", "readback-five-tables", "secret-scan", "child-report", "child-exit0"];
  assert.deepEqual(f.events.filter(e => required.includes(e)), required);
  assert.deepEqual(f.events.slice(-8), ["show", "show", "show", "report", "ports/generated/identities", "stop", "show", "delete"]);
  await assert.rejects(useBookingOuter(f.unit, f.ports), fixed);
  assert.equal(f.events.filter(e => e === "start").length, 1);
  assert.equal(f.events.filter(e => e === "delete").length, 1);
});

test("#945 unknown/partial child, readback missing, cgroup live, drift, abort/timeout, bad report or release retain files; no re-run/re-stop", async () => {
  const faults = { preflight: "preflight", start: "start", manager: "start", invocation: "terminal", live: "terminal",
    timeout: "terminal", abort: "terminal", "late-abort": "ownership", "fixture-report": "report", report: "report",
    listener: "ownership", generated: "ownership", ownership: "ownership", "identity-drift": "remove", release: "release",
    stop: "release", seed: "terminal", confirm201: "terminal", "worker-stop": "terminal", "readback-five-tables": "terminal", "secret-scan": "terminal" };
  for (const [fault, stage] of Object.entries(faults)) {
    const f = fixture(fault);
    await assert.rejects(useBookingOuter(f.unit, f.ports), e => fixed(e) && e.message === diagnostic(stage, stage === "terminal" ? terminalFaultReason(fault) : undefined), fault);
    assert.ok(!f.events.includes("delete"), fault);
    for (const event of ["start", "seed", "confirm201", "stop"]) assert.ok(f.events.filter(e => e === event).length <= 1, fault);
    const calls = f.events.length; await f.unit.dispose(); assert.equal(f.events.length, calls);
  }
});

test("#955 real BrowserUnit terminal categories remain first-latched through outer catch, disposal and CLI", async () => {
  // Oracles are the #914 check/show/terminal contracts, not error messages.
  const cases = [
    [{ terminalState: { Result: "timeout" } }, "timeout", "TIMEOUT"],
    [{ terminalState: { Result: "exit-code" } }, "manager", "MANAGER"],
    [{ terminalState: { ExecMainStatus: "1" } }, "manager", "MANAGER"],
    [{ terminalState: { ExecMainCode: "2" } }, "manager", "MANAGER"],
    [{ terminalState: { ExitType: "main" } }, "mismatch", "MISMATCH"],
    [{ fault: "invocation" }, "mismatch", "MISMATCH"],
    [{ fault: "timeout" }, "timeout", "TIMEOUT"],
    [{ fault: "abort" }, "cancel", "CANCEL"],
    [{ show: "throw" }, "unknown", "UNKNOWN"],
    [{ show: "missing" }, "unknown", "UNKNOWN"],
  ];
  for (const [options, reason, latched] of cases) {
    const f = fixture(options.fault, options), command = f.unit.command;
    f.unit.command = async (file, args, config) => {
      const output = await command(file, args, config);
      if (f.events.filter(e => e === "show").length === 2) {
        if (options.show === "throw") throw new Error(canary);
        if (options.show === "missing") return output.replace(/Result=.*\n/, "");
      }
      return output;
    };
    assert.deepEqual(await outerCliFixture(() => useBookingOuter(f.unit, f.ports)),
      { stdout: [], stderr: [diagnostic("terminal", reason)], status: 1 });
    assert.equal(f.unit.failure, latched);
    f.unit.latch("UNKNOWN"); assert.equal(f.unit.failure, latched);
    assert.equal(f.events.filter(e => e === "start").length, 1);
    assert.equal(f.events.filter(e => e === "stop").length, 1);
    for (const event of ["report", "ports/generated/identities", "delete"]) assert.ok(!f.events.includes(event));
    const calls = f.events.length; await f.unit.dispose(); assert.equal(f.events.length, calls);
  }
});

test("#955 terminal classification uses failure alone before latch/dispose, invalid values and throwing getter stay unknown", async () => {
  const values = [
    ...[["TIMEOUT", "timeout"], ["MANAGER", "manager"], ["MISMATCH", "mismatch"], ["CANCEL", "cancel"], ["UNKNOWN", "unknown"]],
    ...[undefined, null, "STOP", "UNAVAILABLE", "timeout", "TIMEOUT\n", canary, 1, {},
      { toString() { throw new Error(canary); } }, Symbol(canary)].map(value => [value, "unknown"]),
    ["throw", "unknown"],
  ];
  for (const [value, reason] of values) {
    const events = [];
    const unit = {
      remaining() {}, async start() { events.push("start"); },
      async terminal() { events.push("terminal"); throw { get message() { throw new Error(canary); }, stack: canary, cause: canary }; },
      get failure() { events.push("failure"); if (value === "throw") throw new Error(canary); return value; },
      latch(category) { events.push("latch"); assert.equal(category, "UNKNOWN"); if (value === "throw") throw new Error(canary); },
      async dispose() { events.push("stop"); Object.defineProperty(this, "failure", { value: "CANCEL" }); throw new Error(canary); },
      close() { events.push("close"); },
    };
    const ports = { async preflight() {}, async report() { assert.fail("no report"); },
      async finalCheck() { assert.fail("no ownership check"); }, async remove() { assert.fail("no deletion"); } };
    assert.deepEqual(await outerCliFixture(() => useBookingOuter(unit, ports)),
      { stdout: [], stderr: [diagnostic("terminal", reason)], status: 1 });
    assert.deepEqual(events, ["start", "terminal", "failure", "latch", "stop", "close"]);
  }
});

test("#955 static preflight budget reduces the existing unit bound without extending the owner deadline", async () => {
  // 180s owner minus 10s disposal reserve minus P; cap unit at 120s.
  for (const [preflightTime, runtime] of [[0, 120], [50000, 120], [50001, 119], [60000, 110], [169000, 1]]) {
    const f = fixture("", { preflightTime });
    await useBookingOuter(f.unit, f.ports);
    assert.equal(f.unit.runtime, runtime); assert.equal(f.unit.deadline, 180000);
  }
  const expired = fixture("", { preflightTime: 170000 });
  await assert.rejects(useBookingOuter(expired.unit, expired.ports), e => e.message === diagnostic("preflight"));
  assert.deepEqual(expired.events, ["preflight"]); assert.equal(expired.unit.failure, "TIMEOUT");
});

// Execute the real outer catch/finally and CLI text with finite resource adapters.
// No --run subprocess, filesystem provisioning, commands or manager are invoked.
async function outerCliFixture(run) {
  const source = readFileSync("tests/evaluation/trusted-booking-outer.mjs", "utf8");
  const sanitizing = source.slice(source.indexOf("const terminalReasons ="), source.indexOf("export const bookingOuterCheckpoint"));
  const operator = source.slice(source.indexOf("export async function runBookingOuter"))
    .replace("export async function", "async function").replace("fileURLToPath(import.meta.url)", "'fixture-outer'")
    .replace("\nif (process.argv[1]", `
const actualRun = runBookingOuter;
runBookingOuter = async () => {
  try { return await actualRun(); } catch (error) { inspectError(error); throw error; }
};
if (process.argv[1]`);
  const stdout = [], stderr = [], listeners = new Set(); let calls = 0, closes = 0;
  const process = { platform: "linux", version: "v24.0.0", execPath: "fixture-node", argv: ["fixture-node", "fixture-outer", "--run"],
    on: name => listeners.add(name), removeListener: name => listeners.delete(name) };
  await runInNewContext(`(async () => { ${sanitizing}\n${operator}\n })()`, {
    process, AbortController, bookingOuterCheckpoint, root: "fixture-root", persist: "fixture-persist", oldPersist: "fixture-old",
    join, tmpdir: () => "fixture-tmp", resolve: value => value, mkdtempSync: () => "fixture-owned", ownedIdentity: () => ({}),
    BrowserUnit: class { close() { closes++; } },
    useBookingOuter: async () => { calls++; return run(); },
    inspectError: error => assert.ok(fixed(error), "outer rethrow is sanitized before CLI"),
    exec: () => { throw new Error("fixture must not execute commands"); },
    console: { log: value => stdout.push(value), error: value => stderr.push(value) },
  });
  assert.equal(calls, 1); assert.equal(closes, 1); assert.equal(listeners.size, 0);
  return { stdout, stderr, status: process.exitCode ?? 0 };
}

test("#951 real outer catch and CLI preserve finite stages and unchanged success; no raw error reflection", async () => {
  const success = await outerCliFixture(async () => {
    const f = fixture(); return useBookingOuter(f.unit, f.ports);
  });
  assert.deepEqual(success, { stdout: [bookingOuterCheckpoint], stderr: [], status: 0 });
  for (const fault of ["preflight", "start", "report", "ownership", "release", "identity-drift", "seed", "manager", "timeout", "abort"]) {
    const f = fixture(fault);
    const stage = { "identity-drift": "remove", seed: "terminal", manager: "start", timeout: "terminal", abort: "terminal" }[fault] ?? fault;
    assert.deepEqual(await outerCliFixture(() => useBookingOuter(f.unit, f.ports)),
      { stdout: [], stderr: [diagnostic(stage, stage === "terminal" ? terminalFaultReason(fault) : undefined)], status: 1 }, fault);
    assert.ok(!f.events.includes("delete"));
  }
  for (const stage of stages) {
    const error = new Error(diagnostic(stage), { cause: new Error(canary) }); error.stack = canary;
    assert.deepEqual(await outerCliFixture(async () => { throw error; }),
      { stdout: [], stderr: [diagnostic(stage)], status: 1 });
  }
  for (const reason of reasons) {
    const error = new Error(diagnostic("terminal", reason), { cause: new Error(canary) }); error.stack = canary;
    assert.deepEqual(await outerCliFixture(async () => { throw error; }),
      { stdout: [], stderr: [diagnostic("terminal", reason)], status: 1 });
  }
  for (const error of [new Error(canary), null, undefined, diagnostic("terminal"), {},
    new Error(legacyTerminal),
    ...["TIMEOUT", "", "fake", canary, "timeout; reason=manager", "timeout\n"].map(reason => new Error(diagnostic("terminal", reason))),
    ...stages.filter(stage => stage !== "terminal").map(stage => new Error(diagnostic(stage).replace("; retain", "; reason=timeout; retain"))),
    ...reasons.flatMap(reason => ["\n", "\r\n", canary, "\0"].map(suffix => new Error(diagnostic("terminal", reason) + suffix))),
    { message: { toString() { throw new Error(canary); } } }, { get message() { throw new Error(canary); } },
    ...["inner", "TERMINAL", "", canary].map(stage => new Error(diagnostic(stage))),
    ...["\n", "\r\n", canary, "\0"].map(suffix => new Error(diagnostic("terminal") + suffix)),
    new Error(canary + diagnostic("terminal")), new Error(diagnostic("terminal").replace("do not retry", "retry"))]) {
    assert.deepEqual(await outerCliFixture(async () => { throw error; }),
      { stdout: [], stderr: [diagnostic("unknown")], status: 1 });
  }
});

test("#945 child accepts only complete prepared; fixture differs from isolated and failure never reflects raw cause", async () => {
  for (const result of [{ phase: "complete", status: "prepared" }, { phase: "readback", status: "prepared" },
    { phase: "complete", status: "unknown" }, { phase: "complete", status: "prepared", raw: canary }, null]) {
    const writes = []; let calls = 0;
    const ok = await useBookingChild({ signal: new AbortController().signal, runInner: async () => { calls++; return result; }, write: s => writes.push(s) });
    assert.equal(calls, 1); assert.equal(ok, result?.phase === "complete" && result?.status === "prepared" && !result?.raw);
    assert.deepEqual(writes, [ok ? bookingFixtureComplete : bookingChildUnknown]);
  }
  for (const abort of [true, false]) {
    const controller = new AbortController(), writes = []; let calls = 0;
    if (abort) controller.abort(canary);
    assert.equal(await useBookingChild({ signal: controller.signal, runInner: async () => { calls++; throw new Error(canary); }, write: s => writes.push(s) }), false);
    assert.equal(calls, abort ? 0 : 1); assert.deepEqual(writes, [bookingChildUnknown]);
  }
});

test("#945 actual private report: one atomic write; partial/symlink/hardlink/mode/size/grammar/identity failure denied", () => {
  const dir = mkdtempSync(join(tmpdir(), "nssscdl-booking-fixture-")), path = join(dir, "booking-report");
  try {
    const identity = ownedIdentity(dir);
    writeBookingReport(dir, bookingChildComplete); assert.deepEqual(readBookingReport(dir), parseBookingReport(bookingChildComplete));
    assert.throws(() => writeBookingReport(dir, bookingChildComplete));
    chmodSync(path, 0o644); assert.throws(() => readBookingReport(dir)); chmodSync(path, 0o600);
    linkSync(path, join(dir, "hardlink")); assert.throws(() => readBookingReport(dir)); rmSync(join(dir, "hardlink"));
    for (const value of ["", bookingChildComplete.slice(0, -1), bookingChildComplete + canary, "x".repeat(257), "TRUSTED_BROWSER_STAGE=none; CLEANUP=none\n"]) {
      writeFileSync(path, value); assert.throws(() => readBookingReport(dir));
    }
    rmSync(path); writeFileSync(path + ".partial", bookingChildComplete, { mode: 0o600 });
    assert.throws(() => readBookingReport(dir)); assert.throws(() => writeBookingReport(dir, bookingChildComplete));
    assert.ok(existsSync(path + ".partial"));
    symlinkSync(path + ".partial", path); assert.throws(() => readBookingReport(dir));
    assert.throws(() => verifyOwned({ ...identity, ino: -1 }));
    chmodSync(dir, 0o755); assert.throws(() => readBookingReport(dir)); chmodSync(dir, 0o700);
  } finally { rmSync(dir, { recursive: true }); }
});

// #957: Issue-defined independent enums, not a runtime transition oracle.
const diagnosticEnums = [
  ["entry", "seed", "home", "tls", "worker", "dom", "stop", "readback", "scan", "complete", "unknown"],
  ["entered", "completed", "unknown"],
  ["none", "entry", "seed", "home", "tls", "worker", "dom", "stop", "readback", "scan", "unknown"],
  ["not-attempted", "attempted", "confirmed", "unknown"],
];
const diagnosticData = (phase = "entry", boundary = "entered", primary = "none", worker_stop = "not-attempted") =>
  ({ phase, boundary, primary, worker_stop });
const diagnosticText = (phase = "entry", boundary = "entered", primary = "none", stop = "not-attempted") =>
  `TRUSTED_BOOKING_DIAGNOSTIC_V1; phase=${phase}; boundary=${boundary}; primary=${primary}; worker_stop=${stop}\n`;
const diagnosticError = e => e.message === "TRUSTED_BOOKING_DIAGNOSTIC_FAILED" &&
  !e.stack.includes(canary) && !Object.hasOwn(e, "cause");
function diagnosticFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "nssscdl-diagnostic-fixture-"));
  try { run({ dir, owner: ownedIdentity(dir), path: join(dir, bookingDiagnosticName) }); }
  finally { rmSync(dir, { recursive: true }); }
}
// Execute the actual codec with fixture-local fs fault adapters; never a process.
function diagnosticCodec(overrides) {
  const source = readFileSync("tests/evaluation/trusted-booking-report.mjs", "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  return runInNewContext(`${source}\n({ readBookingDiagnostic, writeBookingDiagnostic })`,
    { ...fileSystem, Buffer, process, join, ownedIdentity, ...overrides });
}

test("#957 every finite snapshot is exact diagnostic data, with no success/report authority", () => {
  for (const phase of diagnosticEnums[0]) for (const boundary of diagnosticEnums[1])
    for (const primary of diagnosticEnums[2]) for (const stop of diagnosticEnums[3]) {
      const data = diagnosticData(phase, boundary, primary, stop), text = diagnosticText(phase, boundary, primary, stop);
      assert.ok(Buffer.byteLength(text) <= 256);
      assert.equal(encodeBookingDiagnostic(data), text);
      const result = parseBookingDiagnostic(text);
      assert.deepEqual(result, data); assert.ok(Object.isFrozen(result));
      assert.throws(() => parseBookingReport(text));
    }
  for (const report of [bookingChildComplete, bookingFixtureComplete, bookingChildUnknown]) {
    assert.throws(() => parseBookingDiagnostic(report), diagnosticError);
  }
});

test("#957 strict types/fields/order/LF/bytes reject canary and alternative schemas", () => {
  const good = diagnosticData(), text = diagnosticText();
  for (const data of [null, undefined, text, [], { ...good, raw: canary },
    { boundary: "entered", phase: "entry", primary: "none", worker_stop: "not-attempted" },
    { ...good, [Symbol("extra")]: canary }, { ...good, get phase() { throw new Error(canary); } },
    ...Object.keys(good).flatMap(key => [null, 1, true, {}, [], "", canary, good[key] + "\n"].map(value => ({ ...good, [key]: value })))]) {
    assert.throws(() => encodeBookingDiagnostic(data), diagnosticError);
    diagnosticFixture(({ owner, dir }) => {
      assert.throws(() => writeBookingDiagnostic(owner, data), diagnosticError);
      assert.deepEqual(readdirSync(dir), []);
      assert.throws(() => writeBookingDiagnostic(owner, good), diagnosticError);
    });
  }
  const badTexts = [null, 1, Buffer.from(text), "", text.slice(0, -1), text + "\n", text.replace("\n", "\r\n"),
    text + canary, canary + text, text.replace("phase=entry", "phase=" + canary), text.replace("phase=entry", "phase=ENTRY"),
    text.replace("V1", "V2"), text.replace("; boundary=entered", ""), text.replace("; primary=none", "; raw=none; primary=none"),
    text.replace("phase=entry; boundary=entered", "boundary=entered; phase=entry"), text.replace("; primary=none", "; primary=none; primary=none"),
    text.replace("entry", "entry\0"), text.replace("entry", "entr\u00ff"), "x".repeat(257), bookingChildComplete];
  for (const value of badTexts) {
    assert.throws(() => parseBookingDiagnostic(value), diagnosticError);
    if (typeof value !== "string") continue;
    diagnosticFixture(({ owner, path }) => {
      writeFileSync(path, value, { mode: 0o600 });
      assert.throws(() => readBookingDiagnostic(owner), diagnosticError);
      assert.throws(() => writeBookingDiagnostic(owner, good), diagnosticError);
      assert.equal(readFileSync(path, "utf8"), value);
    });
  }
});

test("#957 exclusive first write and many atomic updates preserve report grammar and independent reads", () => {
  diagnosticFixture(({ owner, dir, path }) => {
    writeBookingReport(dir, bookingChildComplete);
    assert.throws(() => readBookingDiagnostic(owner), diagnosticError);
    for (const phase of diagnosticEnums[0]) {
      const data = diagnosticData(phase, "completed", "unknown", "confirmed");
      writeBookingDiagnostic(owner, data);
      assert.equal(readFileSync(path, "utf8"), diagnosticText(phase, "completed", "unknown", "confirmed"));
      assert.deepEqual(readBookingDiagnostic(owner), data);
      assert.deepEqual(readBookingDiagnostic(ownedIdentity(dir)), data);
      assert.equal(fileSystem.lstatSync(path).mode & 0o7777, 0o600);
      assert.ok(!existsSync(path + ".partial"));
      assert.deepEqual(readBookingReport(dir), parseBookingReport(bookingChildComplete));
    }
    const before = readFileSync(path);
    assert.throws(() => writeBookingDiagnostic(ownedIdentity(dir), diagnosticData()), diagnosticError);
    assert.deepEqual(readFileSync(path), before); // A new writer cannot adopt an old final.
    assert.throws(() => writeBookingReport(dir, bookingChildComplete));
  });
});

test("#957 partial leftovers (including stop), wrong mode, symlink/hardlink, missing or replaced final are retained", () => {
  const faults = [
    ({ path }) => writeFileSync(path + ".partial", diagnosticText("stop"), { mode: 0o600 }),
    ({ path }) => symlinkSync(path, path + ".partial"),
    ({ path }) => chmodSync(path, 0o640),
    ({ path }) => chmodSync(path, 0o4600),
    ({ path }) => linkSync(path, path + ".link"),
    ({ path }) => { fileSystem.renameSync(path, path + ".old"); symlinkSync(path + ".old", path); },
    ({ path }) => { fileSystem.renameSync(path, path + ".old"); writeFileSync(path, diagnosticText(), { mode: 0o600 }); },
    ({ path }) => { writeFileSync(path, diagnosticText()); fileSystem.utimesSync(path, 1, 1); },
    ({ path }) => rmSync(path),
    ({ dir }) => chmodSync(dir, 0o755),
    ({ owner }) => { owner.ino = -1; },
    ({ owner }) => { owner.mode = 0o755; },
    ({ path }) => writeFileSync(path, Buffer.from([0xff])),
  ];
  for (const fault of faults) diagnosticFixture(f => {
    writeBookingDiagnostic(f.owner, diagnosticData()); fault(f);
    const entries = readdirSync(f.dir);
    assert.throws(() => readBookingDiagnostic(f.owner), diagnosticError);
    assert.throws(() => writeBookingDiagnostic(f.owner, diagnosticData("stop")), diagnosticError);
    assert.throws(() => writeBookingDiagnostic(f.owner, diagnosticData("unknown")), diagnosticError);
    assert.deepEqual(readdirSync(f.dir), entries);
  });
  for (const finalExists of [false, true]) diagnosticFixture(({ owner, path }) => {
    if (finalExists) writeBookingDiagnostic(owner, diagnosticData());
    writeFileSync(path + ".partial", diagnosticText("stop"), { mode: 0o600 });
    assert.throws(() => readBookingDiagnostic(owner), diagnosticError);
    assert.throws(() => writeBookingDiagnostic(owner, diagnosticData()), diagnosticError);
    assert.equal(readFileSync(path + ".partial", "utf8"), diagnosticText("stop"));
  });
});

test("#957 stable fd/path/owner/directory checks reject mid-read changes with fixed errors", () => {
  for (const fault of ["replace", "grow", "shrink", "partial", "owner", "gid", "not-regular", "directory"]) {
    diagnosticFixture(({ owner, path }) => {
      let active = false;
      const codec = diagnosticCodec({
        readSync(...args) {
          const count = fileSystem.readSync(...args);
          if (!active) return count;
          if (fault === "replace") { fileSystem.renameSync(path, path + ".old"); writeFileSync(path, diagnosticText(), { mode: 0o600 }); }
          if (fault === "grow") fileSystem.appendFileSync(path, "\n");
          if (fault === "shrink") fileSystem.truncateSync(path, 1);
          if (fault === "partial") writeFileSync(path + ".partial", diagnosticText("stop"), { mode: 0o600 });
          return count;
        },
        fstatSync(fd) {
          const s = fileSystem.fstatSync(fd);
          if (active && fault === "owner") s.uid += 1;
          if (active && fault === "gid") s.gid += 1;
          if (active && fault === "not-regular") s.isFile = () => false;
          return s;
        },
        ownedIdentity(dir) { const identity = ownedIdentity(dir); if (active && fault === "directory") identity.ino = -1; return identity; },
      });
      codec.writeBookingDiagnostic(owner, diagnosticData()); active = true;
      assert.throws(() => codec.readBookingDiagnostic(owner), diagnosticError, fault);
      assert.throws(() => codec.writeBookingDiagnostic(owner, diagnosticData("stop")), diagnosticError, fault);
    });
  }
  for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]) {
    diagnosticFixture(({ owner, path }) => {
      writeFileSync(path, diagnosticText(), { mode: 0o600 });
      let reads = 0;
      const codec = diagnosticCodec({
        openSync(file, flags) {
          assert.equal(flags, fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW | fileSystem.constants.O_NONBLOCK);
          return fileSystem.openSync(file, flags);
        },
        readSync(fd, bytes, offset, length, position) {
          assert.equal(length, 257); assert.equal(position, 0);
          return fileSystem.readSync(fd, bytes, offset, length, position);
        },
        fstatSync(fd) { const stat = fileSystem.fstatSync(fd); if (++reads === 2) stat[key] += 1; return stat; },
      });
      assert.throws(() => codec.readBookingDiagnostic(owner), diagnosticError, key);
    });
  }
});

test("#957 write/rename/close failure or last-moment replacement: no retry, repair, removal or raw reflection", () => {
  for (const fault of ["open", "rename"]) diagnosticFixture(({ owner, dir, path }) => {
    let opens = 0, renames = 0;
    const codec = diagnosticCodec({
      openSync(file, flags, mode) {
        opens++;
        assert.equal(file, path + ".partial"); assert.equal(mode, 0o600);
        assert.ok(flags & fileSystem.constants.O_EXCL);
        if (fault === "open") throw new Error(canary);
        return fileSystem.openSync(file, flags, mode);
      },
      renameSync() { renames++; throw new Error(canary); },
    });
    assert.throws(() => codec.writeBookingDiagnostic(owner, diagnosticData()), diagnosticError);
    assert.equal(opens, 1); assert.equal(renames, fault === "rename" ? 1 : 0);
    assert.throws(() => codec.writeBookingDiagnostic(owner, diagnosticData()), diagnosticError);
    assert.equal(opens, 1); assert.equal(renames, fault === "rename" ? 1 : 0);
    assert.deepEqual(readdirSync(dir), fault === "rename" ? [bookingDiagnosticName + ".partial"] : []);
  });
  for (const fault of ["write", "rename", "close", "replace", "partial-replace"]) diagnosticFixture(({ owner, path, dir }) => {
    let writes = 0, renames = 0, closes = 0;
    const codec = diagnosticCodec({
      writeFileSync(fd, text) {
        writes++; fileSystem.writeFileSync(fd, text);
        if (writes === 2 && fault === "write") throw new Error(canary);
        if (writes === 2 && fault === "replace") { fileSystem.renameSync(path, path + ".old"); writeFileSync(path, diagnosticText(), { mode: 0o600 }); }
        if (writes === 2 && fault === "partial-replace") {
          fileSystem.renameSync(path + ".partial", path + ".pending"); symlinkSync(path + ".pending", path + ".partial");
        }
      },
      renameSync(from, to) { renames++; if (renames === 2 && fault === "rename") throw new Error(canary); fileSystem.renameSync(from, to); },
      closeSync(fd) { closes++; fileSystem.closeSync(fd); if (writes === 2 && fault === "close") throw new Error(canary); },
    });
    codec.writeBookingDiagnostic(owner, diagnosticData());
    assert.throws(() => codec.writeBookingDiagnostic(owner, diagnosticData("stop")), diagnosticError, fault);
    const entries = readdirSync(dir), counts = [writes, renames, closes];
    assert.throws(() => codec.writeBookingDiagnostic(owner, diagnosticData("unknown")), diagnosticError);
    assert.deepEqual([writes, renames, closes], counts);
    assert.deepEqual(readdirSync(dir), entries);
    assert.ok(existsSync(path + ".partial"));
    assert.equal(readFileSync(path, "utf8"), diagnosticText());
  });
});

// #948: exact append-only grammar, not an approval credential. This string is
// fixture data; this Issue never writes a workflow or executes the proof.
const productWorkflow = ".github/workflows/product-ci.yml";
const bookingCaller = /trusted-booking-(outer|child|report)\./;
const strictText = bytes => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const proofStep = `
      - name: '#930 booking normal proof (temporary)'
        if: steps.applicability.outputs.applicable == 'true'
        timeout-minutes: 4
        shell: bash
        run: |
          node --input-type=module <<'NODE'
          import { spawnSync } from 'node:child_process';
          const result = spawnSync(process.execPath, ['tests/evaluation/trusted-booking-outer.mjs', '--run'], {
            encoding: 'utf8', timeout: 190000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe']
          });
          if (result.error || result.signal || result.status !== 0 || result.stderr !== '' ||
              result.stdout !== ${JSON.stringify(bookingOuterCheckpoint + "\n")}) {
            let stage = 'unknown';
            if (!result.error && !result.signal && result.status === 1 && result.stdout === '') {
              for (const allowed of ['preflight', 'start', 'report', 'ownership', 'release', 'remove', 'listeners', 'operator']) {
                if (result.stderr === 'TRUSTED_BOOKING_OUTER_FAILED; stage=' + allowed + '; retain owned files; do not retry\\n') stage = allowed;
              }
              for (const reason of ['timeout', 'manager', 'mismatch', 'cancel', 'unknown']) {
                if (result.stderr === 'TRUSTED_BOOKING_OUTER_FAILED; stage=terminal; reason=' + reason + '; retain owned files; do not retry\\n') stage = 'terminal; reason=' + reason;
              }
            }
            console.error('BOOKING_PROOF_FAILED; stage=' + stage);
            process.exitCode = 1;
          } else {
            console.log(${JSON.stringify(bookingOuterCheckpoint)});
          }
          NODE
`;

// All authority/identity inputs are supplied separately from the workflow text.
// No PR title/body/comment, approval marker, network call, or hidden command.
function allowsBookingCaller(files, context) {
  try {
    for (const [path, content] of files) {
      if (path !== productWorkflow && bookingCaller.test(content)) return false;
    }
    const workflow = files.get(productWorkflow);
    if (typeof workflow !== "string") return false;
    if (!bookingCaller.test(workflow)) return true; // Ordinary CI stays inert.
    const { env, event, head, base, main, mergeBase, changed, clean, baseWorkflow, diff } = context;
    const pr = event.pull_request, repository = "suzukure/nssscdl";
    const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "pull_request" ||
        env.GITHUB_REPOSITORY !== repository || env.GITHUB_WORKFLOW !== "Product CI" ||
        event.repository.full_name !== repository || !Number.isSafeInteger(event.number) || event.number <= 0 ||
        pr.number !== event.number || pr.state !== "open" ||
        env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
        pr.base.repo.full_name !== repository || pr.head.repo.full_name !== repository ||
        pr.base.ref !== "main" || env.GITHUB_BASE_REF !== "main" ||
        typeof pr.head.ref !== "string" || !/^proof\/930-booking-normal-[a-z0-9][a-z0-9-]*$/.test(pr.head.ref) ||
        env.GITHUB_HEAD_REF !== pr.head.ref || !sha(head) || !sha(base) || head === base ||
        head !== pr.head.sha || base !== pr.base.sha || base !== main || mergeBase !== base ||
        clean !== "" || changed !== productWorkflow + "\0" ||
        diff !== `M\0${productWorkflow}\0` || typeof baseWorkflow !== "string" ||
        bookingCaller.test(baseWorkflow) || !baseWorkflow.endsWith("\n")) return false;
    // Byte-for-byte prefix preserves all nine commands, permissions, triggers,
    // actions and step ordering; the only suffix is one bounded, no-retry step.
    return workflow === baseWorkflow + proofStep;
  } catch { return false; }
}

function proofContext(env, event, git) {
  // Read only: checkout supplies the PR head and freshly fetched origin/main.
  // Missing/stale base or dirty tracked/untracked source cannot gain permission.
  const base = event.pull_request.base.sha;
  if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) throw new Error("PROOF_CONTEXT_UNAVAILABLE");
  const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("PROOF_CONTEXT_UNAVAILABLE");
  return { env, event, head, base,
    main: git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}").trim(),
    mergeBase: git("merge-base", base, head).trim(),
    changed: git("diff", "--no-renames", "--name-only", "-z", base, head),
    diff: git("diff", "--no-renames", "--name-status", "-z", base, head),
    clean: git("status", "--porcelain=v1", "--untracked-files=normal"),
    baseWorkflow: git("show", `${base}:${productWorkflow}`) };
}

test("#945 inert imports and non-opt-in CLI; #948 narrowly guarded caller, sealed read-only and Production deny", () => {
  const imports = spawnSync(process.execPath, ["--input-type=module", "-e",
    "await import('./tests/evaluation/trusted-booking-outer.mjs'); await import('./tests/evaluation/trusted-booking-child.mjs')"], { encoding: "utf8" });
  assert.equal(imports.status, 0); assert.equal(imports.stdout, ""); assert.equal(imports.stderr, "");
  for (const [name, args] of [["outer", []], ["child", []], ["outer", ["--run", "--remote"]], ["child", ["--isolated-child", "--remote"]]]) {
    const result = spawnSync(process.execPath, [`tests/evaluation/trusted-booking-${name}.mjs`, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.ok(!result.stderr.includes(canary));
  }
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const files = [...walk("src"), ...walk(".github/workflows"), ...["trusted-seed-smoke.mjs", "trusted-https-process.mjs", "trusted-browser-unit.mjs", "browser-tls-trust.mjs", "trusted-booking-process.mjs"].map(n => join("tests/evaluation", n))];
  const contents = new Map(files.map(file => [file, file === productWorkflow ? strictText(readFileSync(file)) : readFileSync(file, "utf8")]));
  let context;
  if (bookingCaller.test(contents.get(productWorkflow))) {
    try {
      const git = (...args) => {
        const result = spawnSync("git", args, { timeout: 5000, maxBuffer: 1048576 });
        if (result.error || result.signal || result.status !== 0) throw new Error("PROOF_CONTEXT_UNAVAILABLE");
        return strictText(result.stdout);
      };
      context = proofContext(process.env, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), git);
    } catch { /* Unavailable Git/GitHub facts must deny, never bypass. */ }
  }
  assert.equal(allowsBookingCaller(contents, context), true, "booking workflow/source caller guard");
});

function callerFixture(branch = "proof/930-booking-normal-fixture", number = 17) {
  const currentWorkflow = readFileSync(productWorkflow, "utf8");
  // The same finite tests run twice in standard CI, including on a Proof PR.
  // Remove only the exact candidate suffix from fixture input, never from the guard.
  const baseWorkflow = currentWorkflow.endsWith(proofStep) ? currentWorkflow.slice(0, -proofStep.length) : currentWorkflow;
  const head = "a".repeat(40), base = "b".repeat(40);
  const repository = { full_name: "suzukure/nssscdl" };
  return { files: new Map([[productWorkflow, baseWorkflow + proofStep]]), context: {
    env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: repository.full_name,
      GITHUB_WORKFLOW: "Product CI", GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: branch, GITHUB_REF: `refs/pull/${number}/merge` },
    event: { repository, number, pull_request: { number, state: "open",
      head: { ref: branch, sha: head, repo: repository }, base: { ref: "main", sha: base, repo: repository } } },
    head, base, main: base, mergeBase: base, clean: "", changed: productWorkflow + "\0",
    diff: `M\0${productWorkflow}\0`, baseWorkflow } };
}

test("#948 finite proof candidate; ordinary main/PR deny caller, names and approval text alone grant nothing", () => {
  const f = callerFixture();
  assert.equal(allowsBookingCaller(new Map([[productWorkflow, f.context.baseWorkflow]])), true);
  assert.equal(allowsBookingCaller(f.files), false);
  for (const [branch, number] of [["proof/930-booking-normal-fixture", 17], ["proof/930-booking-normal-next-run", 203]]) {
    const candidate = callerFixture(branch, number);
    assert.equal(allowsBookingCaller(candidate.files, candidate.context), true);
  }
  const fresh = callerFixture();
  fresh.context.base = fresh.context.main = fresh.context.mergeBase = fresh.context.event.pull_request.base.sha = "d".repeat(40);
  fresh.context.baseWorkflow += "\n      # Fresh main baseline\n";
  fresh.files.set(productWorkflow, fresh.context.baseWorkflow + proofStep);
  assert.equal(allowsBookingCaller(fresh.files, fresh.context), true);
  for (const key of Object.keys(f.context.env)) {
    const missing = callerFixture(); delete missing.context.env[key];
    assert.equal(allowsBookingCaller(missing.files, missing.context), false, `missing ${key}`);
  }
  const changes = [
    c => { c.env.GITHUB_ACTIONS = "false"; }, c => { c.env.GITHUB_EVENT_NAME = "push"; },
    c => { c.env.GITHUB_EVENT_NAME = "pull_request_target"; }, c => { c.env.GITHUB_REPOSITORY = "fork/nssscdl"; },
    c => { c.env.GITHUB_WORKFLOW = "Other"; }, c => { c.event.repository.full_name = "fork/nssscdl"; },
    c => { c.event.pull_request.head.repo = { full_name: "fork/nssscdl" }; },
    c => { c.event.pull_request.base.repo = { full_name: "fork/nssscdl" }; },
    c => { c.event.pull_request.base.ref = "other"; }, c => { c.env.GITHUB_BASE_REF = "other"; },
    c => { c.event.pull_request.head.ref = "ordinary"; c.env.GITHUB_HEAD_REF = "ordinary"; },
    c => { c.env.GITHUB_HEAD_REF = "proof/930-booking-normal-forged"; },
    c => { c.event.pull_request.head.sha = "c".repeat(40); }, c => { c.head = "invalid"; },
    c => { c.event.pull_request.base.sha = "c".repeat(40); }, c => { c.base = c.head; },
    c => { c.main = "c".repeat(40); }, c => { c.mergeBase = "c".repeat(40); },
    c => { c.env.GITHUB_REF = "refs/heads/main"; }, c => { c.event.pull_request.number++; },
    c => { c.event.pull_request.state = "closed"; }, c => { c.clean = " M tests/evaluation/trusted-booking-outer.test.mjs\n"; },
    c => { c.clean = "?? src/extra.ts\n"; }, c => { c.changed += "src/worker.ts\0"; },
    c => { c.changed += "tests/evaluation/trusted-booking-outer.test.mjs\0"; },
    c => { c.changed += ".github/workflows/extra.yml\0"; }, c => { c.diff = `A\0${productWorkflow}\0`; },
    c => { c.changed = productWorkflow; }, c => { c.diff = `T\0${productWorkflow}\0`; },
    c => { c.baseWorkflow += proofStep; }, c => { c.baseWorkflow = undefined; },
    c => { c.event = {}; }, c => { c.event.pull_request.body = "APPROVED"; c.env.GITHUB_ACTIONS = "false"; },
  ];
  for (const [index, change] of changes.entries()) {
    const candidate = callerFixture(); change(candidate.context);
    assert.equal(allowsBookingCaller(candidate.files, candidate.context), false, `context denial ${index}`);
  }
});

test("#948 deny source/sealed/other workflow references and all deviations from the sole trailing step", () => {
  const f = callerFixture(), original = f.files.get(productWorkflow);
  for (const path of ["src/worker.ts", ".github/workflows/other.yml", ...["trusted-seed-smoke.mjs", "trusted-https-process.mjs",
    "trusted-browser-unit.mjs", "browser-tls-trust.mjs", "trusted-booking-process.mjs"].map(name => `tests/evaluation/${name}`)]) {
    for (const name of ["outer", "child", "report"]) {
      assert.equal(allowsBookingCaller(new Map([...f.files, [path, `trusted-booking-${name}.mjs`]]), f.context), false);
    }
  }
  const workflows = [
    original + proofStep, proofStep + f.context.baseWorkflow,
    original.replace("contents: read", "contents: write"), original.replace("pull_request:", "push:"),
    original.replace("npm run test:unit", "echo bypass"), original.replace("fetch-depth: 0", "fetch-depth: 1"),
    original.replace("timeout-minutes: 4", "timeout-minutes: 5"), original.replace("timeout: 190000", "timeout: 300000"),
    original.replace("'--run'", "'--run', '--remote'"), original.replace("result.stderr !== ''", "false"),
    original.replace("result.stdout !==", "false && result.stdout !=="),
    original.replace("result.status === 1", "true"), original.replace("result.stdout === ''", "true"),
    original.replace("result.stderr ===", "String(result.stderr) ==="),
    original.replace("stage=' + stage", "stage=' + result.stderr"),
    original.replace("        shell: bash", "        continue-on-error: true\n        shell: bash"),
    original.replace("        shell: bash", "        env:\n          TOKEN: unsafe\n        shell: bash"),
    original + "      - run: echo extra\n", original.replace("          NODE\n", "          NODE\n          npm test\n"),
    original.replace("trusted-booking-outer.mjs", "trusted-booking-child.mjs"),
  ];
  for (const [index, workflow] of workflows.entries()) {
    assert.equal(allowsBookingCaller(new Map([[productWorkflow, workflow]]), f.context), false, `workflow denial ${index}`);
  }
});

test("#948 Git evidence adapter: base-to-head file set, fresh main and working source; read errors fail closed", () => {
  assert.throws(() => strictText(Buffer.from([0xff])));
  assert.equal(strictText(Buffer.from("\ufeffworkflow\n")), "\ufeffworkflow\n");
  const f = callerFixture(), c = f.context;
  const outputs = new Map([
    [JSON.stringify(["rev-parse", "--verify", "HEAD^{commit}"]), c.head + "\n"],
    [JSON.stringify(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]), c.main + "\n"],
    [JSON.stringify(["merge-base", c.base, c.head]), c.base + "\n"],
    [JSON.stringify(["diff", "--no-renames", "--name-only", "-z", c.base, c.head]), c.changed],
    [JSON.stringify(["diff", "--no-renames", "--name-status", "-z", c.base, c.head]), `M\0${productWorkflow}\0`],
    [JSON.stringify(["status", "--porcelain=v1", "--untracked-files=normal"]), ""],
    [JSON.stringify(["show", `${c.base}:${productWorkflow}`]), c.baseWorkflow],
  ]);
  const git = (...args) => { const key = JSON.stringify(args); assert.ok(outputs.has(key)); return outputs.get(key); };
  assert.equal(allowsBookingCaller(f.files, proofContext(c.env, c.event, git)), true);
  for (const key of outputs.keys()) {
    assert.throws(() => proofContext(c.env, c.event, (...args) => {
      if (JSON.stringify(args) === key) throw new Error("unavailable");
      return git(...args);
    }));
  }
});

test("#948 candidate output filter runs once, bounds execution and emits only fixed non-secret text", () => {
  const script = proofStep.split("          node --input-type=module <<'NODE'\n")[1]
    .replace("          import { spawnSync } from 'node:child_process';\n", "").replace(/          NODE\n$/, "");
  const success = { status: 0, signal: null, stdout: bookingOuterCheckpoint + "\n", stderr: "" };
  const failed = { status: 1, signal: null, stdout: "", stderr: diagnostic("terminal") + "\n" };
  const unknown = [
    { ...success, stdout: canary }, { ...success, stderr: canary },
    { ...success, status: 1 }, { ...success, signal: "SIGTERM" }, { ...success, error: new Error(canary) },
    { ...success, stdout: success.stdout + "\n" },
    { ...failed, stdout: canary }, { ...failed, stdout: bookingOuterCheckpoint + "\n" },
    { ...failed, stdout: Buffer.from("") }, { ...failed, signal: "SIGTERM" },
    ...[0, 2, null, "1"].map(status => ({ ...failed, status })),
    ...["SIGTERM", "SIGKILL"].map(signal => ({ ...failed, status: null, signal })),
    ...["ETIMEDOUT", "ENOBUFS", "ENOENT"].map(code => ({ ...failed, error: Object.assign(new Error(canary), { code }) })),
    { ...failed, stderr: canary }, { ...failed, stderr: Buffer.from(failed.stderr) },
    { ...failed, stderr: legacyTerminal + "\n" },
    ...["TIMEOUT", "", "fake", canary, "timeout; reason=manager", "timeout\n"].map(reason => ({ ...failed, stderr: diagnostic("terminal", reason) + "\n" })),
    ...stages.filter(stage => stage !== "terminal").map(stage => ({ ...failed, stderr: diagnostic(stage).replace("; retain", "; reason=timeout; retain") + "\n" })),
    ...reasons.flatMap(reason => [diagnostic("terminal", reason), diagnostic("terminal", reason) + "\r\n",
      diagnostic("terminal", reason) + "\n\n", diagnostic("terminal", reason) + "\n" + canary,
      canary + diagnostic("terminal", reason) + "\n", diagnostic("terminal", reason) + "\0\n",
      diagnostic("terminal", reason).replace("do not retry", "retry") + "\n"].map(stderr => ({ ...failed, stderr }))),
    ...["inner", "unknown", "TERMINAL", "", canary].map(stage => ({ ...failed, stderr: diagnostic(stage) + "\n" })),
    ...stages.flatMap(stage => [diagnostic(stage), diagnostic(stage) + "\r\n", diagnostic(stage) + "\n\n",
      diagnostic(stage) + "\n" + canary, canary + diagnostic(stage) + "\n", diagnostic(stage) + "\0\n",
      diagnostic(stage).replace("do not retry", "retry") + "\n"].map(stderr => ({ ...failed, stderr }))),
  ];
  const cases = [[success, undefined], ...stages.filter(stage => stage !== "terminal").map(stage => [{ ...failed, stderr: diagnostic(stage) + "\n" }, stage]),
    ...reasons.map(reason => [{ ...failed, stderr: diagnostic("terminal", reason) + "\n" }, `terminal; reason=${reason}`]),
    ...unknown.map(result => [result, "unknown"])];
  for (const [result, stage] of cases) {
    let calls = 0;
    const stdout = [], stderr = [], process = { execPath: "fixture-node", exitCode: undefined };
    runInNewContext(script, { process,
      console: { log: value => stdout.push(value), error: value => stderr.push(value) },
      spawnSync(file, args, options) {
        calls++;
        assert.equal(file, "fixture-node");
        assert.deepEqual(Array.from(args), ["tests/evaluation/trusted-booking-outer.mjs", "--run"]);
        assert.equal(options.timeout, 190000); assert.equal(options.maxBuffer, 4096);
        assert.deepEqual(Array.from(options.stdio), ["ignore", "pipe", "pipe"]);
        return result;
      } });
    assert.equal(calls, 1);
    assert.deepEqual(stdout, result === success ? [bookingOuterCheckpoint] : []);
    assert.deepEqual(stderr, result === success ? [] : [`BOOKING_PROOF_FAILED; stage=${stage}`]);
    assert.equal(process.exitCode, result === success ? undefined : 1);
  }
});
