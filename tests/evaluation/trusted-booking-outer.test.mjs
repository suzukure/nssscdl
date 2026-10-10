// Issue #945 oracles: strict success order, fixed grammar, no replay, failure retention.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BrowserUnit, ownedIdentity, verifyOwned } from "./trusted-browser-unit.mjs";
import { useTrustedBookingProcess } from "./trusted-booking-process.mjs";
import { useBookingChild } from "./trusted-booking-child.mjs";
import { useBookingOuter } from "./trusted-booking-outer.mjs";
import { bookingChildComplete, bookingChildUnknown, bookingFixtureComplete, parseBookingReport, readBookingReport, writeBookingReport } from "./trusted-booking-report.mjs";

const canary = "private-session-state-csrf-sql-pii-stderr";
const fixed = e => /^TRUSTED_BOOKING_OUTER_FAILED; stage=[a-z]+; retain owned files; do not retry$/.test(e.message) && !e.stack.includes(canary) && !("cause" in e);

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

function fixture(fault = "") {
  let time = 0, observations = 0, stopped = false, text;
  const controller = new AbortController(), events = [];
  const unit = new BrowserUnit({ env: { PATH: "/usr/bin", HOME: "fixture", TMPDIR: "fixture" }, cwd: "fixture",
    uid: 7, gid: 7, signal: controller.signal, now: () => time, deadline: 180000, sleep: async ms => { time += ms; },
    command: async (file, args) => {
      assert.equal(file, "sudo"); assert.equal(args[0], "-n");
      if (args[1] === "systemd-run") {
        events.push("start");
        assert.ok(args.includes("--property=RuntimeMaxSec=120s"));
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
        StandardOutput: "null", StandardError: "null", User: "7", Group: "7", RuntimeMaxUSec: "2min", TimeoutStopUSec: "2s",
        LoadState: "loaded", ActiveState: "active", SubState: "exited", Result: "success", ExecMainCode: "1",
        ExecMainStatus: events.includes("child-exit1") ? "1" : "0", InvocationID: "b".repeat(32), ControlGroup: "/system.slice/" + unit.name };
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
    async preflight() { events.push("preflight"); if (fault === "preflight") throw new Error(canary); },
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
  for (const fault of ["preflight", "start", "manager", "invocation", "live", "timeout", "abort", "late-abort", "fixture-report", "report",
    "listener", "generated", "ownership", "identity-drift", "release", "stop", "seed", "confirm201", "worker-stop", "readback-five-tables", "secret-scan"]) {
    const f = fixture(fault);
    await assert.rejects(useBookingOuter(f.unit, f.ports), fixed, fault);
    assert.ok(!f.events.includes("delete"), fault);
    for (const event of ["start", "seed", "confirm201", "stop"]) assert.ok(f.events.filter(e => e === event).length <= 1, fault);
    const calls = f.events.length; await f.unit.dispose(); assert.equal(f.events.length, calls);
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

test("#945 inert imports and non-opt-in CLI; sealed read-only, Production and workflows have no caller", () => {
  const imports = spawnSync(process.execPath, ["--input-type=module", "-e",
    "await import('./tests/evaluation/trusted-booking-outer.mjs'); await import('./tests/evaluation/trusted-booking-child.mjs')"], { encoding: "utf8" });
  assert.equal(imports.status, 0); assert.equal(imports.stdout, ""); assert.equal(imports.stderr, "");
  for (const [name, args] of [["outer", []], ["child", []], ["outer", ["--run", "--remote"]], ["child", ["--isolated-child", "--remote"]]]) {
    const result = spawnSync(process.execPath, [`tests/evaluation/trusted-booking-${name}.mjs`, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.ok(!result.stderr.includes(canary));
  }
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const files = [...walk("src"), ...walk(".github/workflows"), ...["trusted-seed-smoke.mjs", "trusted-https-process.mjs", "trusted-browser-unit.mjs", "browser-tls-trust.mjs", "trusted-booking-process.mjs"].map(n => join("tests/evaluation", n))];
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /trusted-booking-(outer|child|report)\./, file);
});
