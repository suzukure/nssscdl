// #1010: finite only. Real BrowserUnit protocol, dedicated child/report, sealed operator VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, chmodSync, writeFileSync, readdirSync, linkSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { BrowserUnit } from "./trusted-browser-unit.mjs";
import { useUnauthenticatedBookingChild } from "./trusted-unauthenticated-booking-child.mjs";
import { useUnauthenticatedBookingOuter, unauthenticatedBookingOuterCheckpoint,
  parseUnauthenticatedBookingTerminal, formatUnauthenticatedBookingTerminal,
  unauthenticatedBookingTerminalGrammar, unauthenticatedBookingTerminalMaxBytes } from "./trusted-unauthenticated-booking-outer.mjs";
import { parseUnauthenticatedBookingReport, readUnauthenticatedBookingReport, writeUnauthenticatedBookingReport,
  unauthenticatedBookingChildComplete, unauthenticatedBookingFixtureComplete, unauthenticatedBookingChildUnknown,
  unauthenticatedBookingPhases, unauthenticatedBookingTlsPrimary, unauthenticatedBookingTlsCleanup,
  unauthenticatedBookingTlsErrors, formatUnauthenticatedBookingFailure } from "./trusted-unauthenticated-booking-report.mjs";

const canary = "private-session-csrf-sql-cause";
const failed = stage => `TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=${stage}; retain owned files; do not retry`;
const good = () => ({ execution: "isolated", phase: "complete", status: "prepared", readback: "unchanged" });
function fixture(fault = "", preflightTime = 0, tlsEvents = []) {
  const events = [], controller = new AbortController();
  let time = 0, shows = 0, text;
  const f = { events, controller, fault, hook: () => {}, time: value => { time = value; } };
  const unit = new BrowserUnit({ env: { PATH: "/usr/bin" }, cwd: "fixture", signal: controller.signal,
    uid: 7, gid: 7, deadline: 180000, now: () => time, sleep: async ms => { time += ms; },
    command: async (file, args) => {
      assert.equal(file, "sudo"); assert.equal(args[0], "-n");
      if (args[1] === "systemd-run") {
        events.push("start");
        assert.deepEqual(args.slice(-4), [process.execPath, "--disable-warning=ExperimentalWarning",
          "tests/evaluation/trusted-unauthenticated-booking-child.mjs", "--isolated-child"]);
        assert.ok(args.includes(`--property=RuntimeMaxSec=${unit.runtime}s`));
        if (fault === "start") throw new Error(canary);
        const completed = await useUnauthenticatedBookingChild({ isolated: true, signal: controller.signal,
          runInner: async ({ observeTls }) => { events.push("inner"); for (const event of tlsEvents) observeTls(event); if (fault === "child") throw new Error(canary);
            events.push("unchanged/secret-scan"); if (fault === "secret-scan") throw new Error(canary); return { phase: "complete", status: "prepared" }; },
          write: wire => { events.push("child-report"); text = wire; if (fault === "write") throw new Error(canary); } });
        f.exit = completed ? "0" : "1"; f.hook("child"); return "";
      }
      if (args[2] === "stop") {
        events.push("stop"); f.hook("stop");
        if (fault === "stop" || f.stopFault === "stop") throw new Error(canary);
        return "";
      }
      if (args.includes("--property=MainPID")) { events.push("diagnostic-show"); return canary; }
      events.push(unit.stopped ? "disposed-show" : "show"); shows++;
      if (fault === "show" || (!unit.stopped && shows === 2 && fault === "terminal-io") ||
        (!unit.stopped && shows === 3 && fault === "second-io") || (unit.stopped && (fault === "dispose-show" || f.stopFault === "dispose-show"))) throw new Error(canary);
      const state = unit.stopped ? { LoadState: "not-found", ActiveState: "inactive", SubState: "dead", InvocationID: "" } : {
        Type: "exec", ExitType: "cgroup", RemainAfterExit: "yes", Restart: "no", NRestarts: "0", OOMPolicy: "stop",
        Delegate: "no", NoNewPrivileges: "yes", ProtectControlGroups: "yes", KillMode: "control-group",
        StandardOutput: "null", StandardError: "null", User: "7", Group: "7", RuntimeMaxUSec: `${unit.runtime}s`, TimeoutStopUSec: "2s",
        LoadState: "loaded", ActiveState: "active", SubState: "exited", Result: "success", ExecMainCode: "1",
        ExecMainStatus: f.exit, InvocationID: "b".repeat(32), ControlGroup: "/system.slice/" + unit.name };
      if (!unit.stopped && shows >= 2) {
        if (fault === "live" || fault === "poll-deadline") { state.SubState = "running"; time += fault === "live" ? 60000 : 85000; }
        if (fault === "timeout") { state.Result = "timeout"; state.SubState = "failed"; }
        if (fault === "unknown-exit") state.ExecMainCode = "0";
        if (fault === "invocation" && shows === 3) state.InvocationID = "c".repeat(32);
        if (fault === "abort") controller.abort(canary);
        if (fault === "cgroup") state.ControlGroup = canary;
        if (fault === "second-live" && shows === 3) state.SubState = "running";
        if (fault === "second-exit" && shows === 3) state.ExecMainStatus = "2";
        if (fault === "second-code" && shows === 3) state.ExecMainCode = "2";
        if (fault === "manager") state.Result = canary;
        if (fault === "budget") time = 180000;
      }
      if (unit.stopped) {
        if (fault === "release") state.ActiveState = "active";
        if (f.stopFault === "failed-state") Object.assign(state, { LoadState: "loaded", ActiveState: "failed", SubState: "failed", InvocationID: "b".repeat(32) });
        if (f.stopFault === "identity-mismatch") Object.assign(state, { ActiveState: "active", InvocationID: "c".repeat(32) });
        if (f.stopFault === "state-unaccepted") Object.assign(state, { ActiveState: "active", InvocationID: "b".repeat(32) });
        if (fault === "late-abort") controller.abort(canary);
        if (fault === "late-budget") time = 180000;
      }
      f.hook(unit.stopped ? "disposed" : "show");
      if ((!unit.stopped && ((shows === 2 && fault === "show1-invalid") || (shows === 3 && fault === "show2-invalid"))) ||
        (unit.stopped && f.stopFault === "show-invalid")) return "Result=" + canary;
      return Object.entries(state).map(([key, value]) => `${key}=${value}`).join("\n");
    } });
  const ports = {
    async preflight() { events.push("preflight"); time += preflightTime; if (fault === "preflight") throw new Error(canary); },
    failureReport() { events.push("failure-read"); return parseUnauthenticatedBookingReport(text); },
    report() { events.push("report"); if (fault === "report-abort") controller.abort(canary); return parseUnauthenticatedBookingReport(text); },
    async finalCheck() { events.push("final-check"); if (fault === "ownership") throw new Error(canary);
      if (fault === "ownership-abort") controller.abort(canary); if (fault === "ownership-budget") time = 170000; },
    async remove() { events.push("remove-check"); if (fault === "remove") throw new Error(canary);
      events.push("delete"); if (fault === "after-delete-abort") controller.abort(canary); },
  };
  return Object.assign(f, { unit, ports });
}

test("dedicated isolated child once; terminal twice before report; release then delete; no reentry", async () => {
  const f = fixture();
  assert.deepEqual(await useUnauthenticatedBookingOuter(f.unit, f.ports), { success: true, status: "prepared", readback: "unchanged" });
  assert.deepEqual(f.events, ["preflight", "start", "inner", "unchanged/secret-scan", "child-report", "show", "show", "show",
    "report", "final-check", "stop", "disposed-show", "remove-check", "delete"]);
  assert.deepEqual(f.unit.terminalObservation, { boundary: "double-exit", state: "exited", result: "success",
    exit: "zero", invocation: "matched", cgroup: "expected", second: "observed", budget: "adequate" });
  const before = f.events.length;
  await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), { message: failed("start") });
  assert.equal(f.events.length, before);
});

test("failure matrix retains files, first latch and at most one start/stop; no normal diagnostics", async () => {
  const faults = { preflight: "preflight", start: "start", show: "start", child: "terminal", write: "terminal", "secret-scan": "terminal", "report-abort": "report",
    invocation: "terminal", live: "terminal", timeout: "terminal", "unknown-exit": "terminal", abort: "terminal",
    ownership: "ownership", "ownership-abort": "ownership", "ownership-budget": "ownership", stop: "release", release: "release", "dispose-show": "release",
    "late-abort": "release", "late-budget": "release", remove: "remove" };
  for (const [fault, stage] of Object.entries(faults)) {
    const f = fixture(fault);
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), error => {
      if (stage === "terminal") assert.ok(parseUnauthenticatedBookingTerminal(error.message), fault);
      else assert.equal(error.message, failed(stage), fault);
      return true;
    });
    assert.ok(!f.events.includes("delete"), fault);
    for (const event of ["start", "inner", "stop"]) assert.ok(f.events.filter(v => v === event).length <= 1, fault);
    if (["preflight", "start", "terminal"].includes(stage)) assert.ok(!f.events.includes("report"));
    if (stage !== "terminal") assert.equal(f.events.includes("failure-read"), false, fault);
    if (["preflight", "start", "terminal", "ownership"].includes(stage)) assert.ok(!f.events.includes("remove-check"));
    if (fault === "invocation") assert.equal(f.unit.failure, "MISMATCH");
    if (fault === "timeout" || fault === "live") assert.equal(f.unit.failure, "TIMEOUT");
    if (fault === "abort") assert.equal(f.unit.failure, "CANCEL");
  }
  const late = fixture("after-delete-abort");
  await assert.rejects(useUnauthenticatedBookingOuter(late.unit, late.ports), { message: failed("remove") });
});

const terminalRecord = overrides => ({ reason: "manager", boundary: "first-exit", state: "exited", result: "success",
  exit: "nonzero", invocation: "matched", cgroup: "expected", second: "not-observed", budget: "adequate", stop: "confirmed", unit_stop: "confirmed", report: "unknown", entered: "unknown", confirmed: "unknown",
  tls_primary: "unknown", tls_cleanup: "unknown", tls_err: "unknown", ...overrides });

test("#1020 real BrowserUnit finite terminal fault families; success report/retry/deletion forbidden", async () => {
  // Expected classifications derive from the existing manager checks and #1015 enums.
  const matrix = [
    ["child", { report: "observed" }], ["write", {}], ["secret-scan", { report: "observed" }],
    ["unknown-exit", { exit: "abnormal-code" }],
    ["invocation", { reason: "mismatch", boundary: "second-show", exit: "zero", invocation: "mismatched", second: "observed" }],
    ["cgroup", { reason: "mismatch", boundary: "pre-show", exit: "zero", cgroup: "other" }],
    ["timeout", { reason: "timeout", boundary: "pre-show", state: "failed", result: "timeout", exit: "not-observed" }],
    ["manager", { boundary: "pre-show", state: "other", result: "other", exit: "zero" }],
    ["live", { reason: "timeout", boundary: "polling", state: "running", exit: "not-observed", budget: "exhausted", stop: "stop-budget", unit_stop: "unknown", report: "unread" }],
    ["poll-deadline", { reason: "timeout", boundary: "polling", state: "running", exit: "not-observed", budget: "exhausted" }],
    ["budget", { reason: "timeout", boundary: "pre-show", exit: "zero", budget: "exhausted", stop: "stop-budget", unit_stop: "unknown", report: "unread" }],
    ["abort", { reason: "cancel", boundary: "pre-show", exit: "zero", budget: "aborted", unit_stop: "unknown", report: "unread" }],
    ["terminal-io", { reason: "unknown", boundary: "pre-show", state: "unavailable", result: "not-observed",
      exit: "not-observed", invocation: "not-compared", cgroup: "unknown" }],
    ["show1-invalid", { reason: "unknown", boundary: "pre-show", state: "invalid", result: "not-observed",
      exit: "not-observed", invocation: "not-compared", cgroup: "unknown" }],
    ["second-io", { reason: "unknown", boundary: "second-show", state: "unavailable", exit: "zero" }],
    ["show2-invalid", { reason: "unknown", boundary: "second-show", state: "invalid", exit: "zero" }],
    ["second-live", { reason: "mismatch", boundary: "second-show", state: "running", exit: "not-observed", second: "observed" }],
    ["second-exit", { reason: "mismatch", boundary: "second-show", second: "observed" }],
    ["second-code", { reason: "mismatch", boundary: "second-show", exit: "abnormal-code", second: "observed" }],
  ];
  for (const [fault, expected] of matrix) {
    const f = fixture(fault);
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), error => {
      assert.deepEqual(parseUnauthenticatedBookingTerminal(error.message), terminalRecord(expected), fault);
      assert.equal(error.message.includes(canary), false);
      assert.ok(Buffer.byteLength(error.message + "\n") <= unauthenticatedBookingTerminalMaxBytes);
      return true;
    });
    assert.equal(f.events.filter(e => e === "start").length, 1);
    assert.equal(f.events.filter(e => e === "stop").length, ["budget", "live"].includes(fault) ? 0 : 1);
    assert.equal(f.events.filter(e => e === "disposed-show").length, ["budget", "live"].includes(fault) ? 0 : 1);
    assert.equal(f.events.filter(e => e === "show").length,
      fault === "live" ? 4 : fault.startsWith("second-") || ["invocation", "show2-invalid", "poll-deadline"].includes(fault) ? 3 : 2);
    for (const e of ["report", "final-check", "remove-check", "delete"]) assert.equal(f.events.includes(e), false, fault);
    assert.equal(f.unit.accepted, undefined, fault);
  }
});

test("#1015 one disposal observation; first failure unchanged even with stop failure/invalid cleanup", async () => {
  for (const [fault, stop] of [["stop", "unknown"], ["dispose-show", "show-unavailable"], ["show-invalid", "show-unavailable"],
    ["failed-state", "failed-state"], ["identity-mismatch", "identity-mismatch"], ["state-unaccepted", "state-unaccepted"],
    ["stop-budget", "stop-budget"], ["show-budget", "stop-budget"]]) {
    const f = fixture("child"); f.stopFault = fault;
    f.hook = phase => {
      if (fault === "show-budget" && phase === "stop") f.time(180000);
    };
    if (fault === "stop-budget") {
      const terminal = f.unit.terminal.bind(f.unit);
      f.unit.terminal = async () => { try { await terminal(); } finally { f.time(180000); } };
    }
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), error => {
      assert.equal(parseUnauthenticatedBookingTerminal(error.message).stop, stop, fault);
      assert.equal(parseUnauthenticatedBookingTerminal(error.message).reason, "manager");
      return true;
    });
    assert.ok(f.events.filter(e => e === "stop").length <= 1);
    assert.ok(f.events.filter(e => e === "disposed-show").length <= 1);
    assert.ok(!f.events.includes("report") && !f.events.includes("delete"));
    assert.equal(f.unit.failure, "MANAGER");
  }
});

test("#1015 malformed passive observations and accessors cannot reflect raw data or authorize reads", async () => {
  let touched = 0;
  for (const fault of ["accessor", "inherited", "extra", "enum", "field-accessor", "reason-object"]) {
    const f = fixture("child"), terminal = f.unit.terminal.bind(f.unit);
    f.unit.terminal = async () => {
      try { await terminal(); } finally {
        if (fault === "accessor") Object.defineProperty(f.unit, "terminalObservation", { get() { touched++; throw new Error(canary); } });
        if (fault === "inherited") { const observation = f.unit.terminalObservation; delete f.unit.terminalObservation;
          // Preserve BrowserUnit methods while making the observation inherited.
          Object.setPrototypeOf(f.unit, Object.assign(Object.create(BrowserUnit.prototype), { terminalObservation: observation })); }
        if (fault === "extra") f.unit.terminalObservation = { ...f.unit.terminalObservation, extra: canary };
        if (fault === "enum") f.unit.terminalObservation = { ...f.unit.terminalObservation, state: canary };
        if (fault === "field-accessor") { const observation = { ...f.unit.terminalObservation };
          Object.defineProperty(observation, "exit", { get() { touched++; throw new Error(canary); } }); f.unit.terminalObservation = observation; }
        if (fault === "reason-object") f.unit.failure = { toString() { touched++; throw new Error(canary); } };
      }
    };
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), error => {
      const diagnostic = parseUnauthenticatedBookingTerminal(error.message);
      assert.ok(diagnostic); assert.equal(error.message.includes(canary), false);
      if (fault === "reason-object") assert.equal(diagnostic.reason, "unknown");
      else { assert.equal(diagnostic.reason, "manager"); assert.equal(diagnostic.boundary, "unknown"); }
      return true;
    });
    assert.equal(f.events.filter(e => e === "stop").length, 1);
    assert.equal(f.events.filter(e => e === "disposed-show").length, 1);
    assert.ok(!f.events.includes("report") && !f.events.includes("delete"));
  }
  assert.equal(touched, 0);
});

test("#1015 exact terminal codec rejects hostile records without invoking getters", () => {
  let touched = 0;
  const wire = formatUnauthenticatedBookingTerminal(terminalRecord());
  assert.deepEqual(parseUnauthenticatedBookingTerminal(wire), terminalRecord());
  const proxy = new Proxy(terminalRecord(), { ownKeys() { touched++; throw new Error(canary); } });
  const accessor = terminalRecord(); Object.defineProperty(accessor, "reason", { get() { touched++; throw new Error(canary); } });
  for (const record of [null, {}, Object.create(terminalRecord()), accessor, proxy, { ...terminalRecord(), extra: canary },
    { ...terminalRecord(), [Symbol("extra")]: true }, ...Object.keys(terminalRecord()).flatMap(key => {
      const missing = terminalRecord(); delete missing[key];
      return [missing, terminalRecord({ [key]: canary }), terminalRecord({ [key]: "" }), terminalRecord({ [key]: undefined })];
    })]) assert.equal(formatUnauthenticatedBookingTerminal(record), undefined);
  assert.equal(touched, 0);
  for (const text of ["", wire + "\n", wire + "\r\n", wire + "\0", canary + wire, wire + wire,
    wire.replace("; exit=", "; extra=unknown; exit="), wire.replace("; exit=", "; reason=manager; exit="),
    wire.replace("reason=manager", "reason=unknown-value"), wire.replace("report=unknown", "report=read"),
    wire.replace("evidence=unproved", "evidence=proved"), "x".repeat(513), Buffer.from(wire)]) {
    assert.equal(parseUnauthenticatedBookingTerminal(text), undefined);
  }
});

// #1020 reuses the real private manager gate through its existing command seam.
const progress = () => ({ phase: "failed", entered: "tls-cleanup", confirmed: "dom-401", status: "failed" });
function managerFailureFixture({ group = "empty", mutate = () => {}, fault = "", api = "a(sus) 0\n" } = {}) {
  const f = fixture("child"), command = f.unit.command;
  let initial, samples = 0, apis = 0, confirms = 0;
  f.stopFault = "failed-state";
  const confirm = f.unit.confirmDiagnosticStop.bind(f.unit);
  f.unit.confirmDiagnosticStop = async () => { confirms++; return confirm(); };
  f.unit.command = async (file, args, options) => {
    if (args[1] === "busctl") {
      f.events.push("manager-api"); apis++;
      if (fault === "api-throw") throw new Error(canary);
      if (fault === "api-abort") f.controller.abort();
      if (fault === "api-budget") f.time(180000);
      return api;
    }
    if (args.includes("--property=MainPID")) {
      f.events.push("diagnostic-show"); samples++;
      assert.equal(options.signal, f.controller.signal);
      const state = { ...initial, ActiveState: "failed", SubState: "failed", MainPID: "0", ControlPID: "0",
        ControlGroup: group === "empty" ? "" : `/system.slice/${f.unit.name}` };
      mutate(state, samples, f);
      if (fault === `show-${samples}-throw`) throw new Error(canary);
      if (fault === `show-${samples}-abort`) f.controller.abort();
      if (fault === `show-${samples}-budget`) f.time(180000);
      const keys = args.filter(arg => arg.startsWith("--property=")).map(arg => arg.slice(11));
      const text = keys.filter(key => Object.hasOwn(state, key)).map(key => `${key}=${state[key]}`).join("\n") + "\n";
      return fault === "duplicate" ? text + "MainPID=0\n" : fault === "malformed" ? canary : text;
    }
    const text = await command(file, args, options);
    if (args[2] === "show" && !f.unit.stopped && !initial) initial = Object.fromEntries(text.split("\n").map(line => line.split("=")));
    if (args[2] === "show" && f.unit.stopped) {
      if (fault === "cleanup-abort") f.controller.abort();
      if (fault === "cleanup-budget") f.time(180000);
    }
    return text;
  };
  f.ports.failureReport = () => { f.events.push("failure-read"); return progress(); };
  f.counts = () => ({ samples, apis, confirms });
  return f;
}
async function terminalDiagnostic(f) {
  let record;
  await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), error => {
    record = parseUnauthenticatedBookingTerminal(error.message);
    assert.ok(record); assert.equal(error.message.includes(canary), false);
    assert.ok(Buffer.byteLength(error.message + "\n") <= 512);
    return true;
  });
  if (record.report !== "observed") for (const key of ["entered", "confirmed", "tls_primary", "tls_cleanup", "tls_err"]) {
    assert.equal(record[key], "unknown", key);
  }
  assert.ok(f.events.filter(e => e === "stop").length <= 1);
  for (const event of ["report", "final-check", "remove-check", "delete"]) assert.equal(f.events.includes(event), false);
  return record;
}

test("#1020 same invocation accepted stop or private failed-state show/API/show before one failure read", async () => {
  for (const group of ["empty", "path"]) {
    const f = managerFailureFixture({ group });
    const record = await terminalDiagnostic(f);
    assert.deepEqual(record, terminalRecord({ stop: "failed-state", report: "observed", entered: "tls-cleanup", confirmed: "dom-401" }));
    assert.deepEqual(f.events.slice(-6), ["stop", "disposed-show", "diagnostic-show", "manager-api", "diagnostic-show", "failure-read"]);
    assert.deepEqual(f.counts(), { samples: 2, apis: 1, confirms: 1 });
    assert.equal(f.unit.failure, "MANAGER");
    const calls = f.events.length;
    assert.equal(await f.unit.confirmDiagnosticStop(), false);
    await f.unit.dispose(false); assert.equal(f.events.length, calls);
  }
  const f = fixture("child"); f.ports.failureReport = () => { f.events.push("failure-read"); return progress(); };
  const record = await terminalDiagnostic(f);
  assert.equal(record.report, "observed"); assert.equal(record.unit_stop, "confirmed");
  assert.deepEqual(f.events.slice(-3), ["stop", "disposed-show", "failure-read"]);
});

test("#1020 real manager before/after strict identity/settings/PID/budget failures read zero", async () => {
  const invalid = { Type: "simple", ExitType: "main", RemainAfterExit: "no", Restart: "always", NRestarts: "1",
    OOMPolicy: "continue", Delegate: "yes", NoNewPrivileges: "no", ProtectControlGroups: "no", KillMode: "process",
    StandardOutput: "journal", StandardError: "journal", User: "8", Group: "8", LoadState: "not-found",
    ActiveState: "inactive", SubState: "dead", InvocationID: "c".repeat(32), MainPID: "1", ControlPID: "1",
    RuntimeMaxUSec: "121s", TimeoutStopUSec: "3s", ControlGroup: "/other" };
  for (const sample of [1, 2]) for (const [key, value] of Object.entries(invalid)) for (const missing of [false, true]) {
    const f = managerFailureFixture({ mutate(state, n) { if (n === sample) { if (missing) delete state[key]; else state[key] = value; } } });
    const record = await terminalDiagnostic(f);
    assert.equal(record.unit_stop, "unknown", `${sample}/${key}/${missing}`); assert.equal(record.report, "unread");
    assert.equal(f.events.includes("failure-read"), false); assert.equal(f.unit.failure, "MANAGER");
    assert.deepEqual(f.counts(), { samples: sample, apis: sample - 1, confirms: 1 });
  }
  for (const group of ["empty", "path"]) {
    const f = managerFailureFixture({ group, mutate(state, n) { if (n === 2) state.ControlGroup = group === "empty" ? `/system.slice/${f.unit.name}` : ""; } });
    assert.equal((await terminalDiagnostic(f)).report, "unread");
  }
  for (const options of [
    ...["", "a(sus) 0", "a(sus) 0\n\n", "a(sus) 1 1 7 process\n", canary, null, {}, "x".repeat(16385)].map(api => ({ api })),
    ...["api-throw", "api-abort", "api-budget", "duplicate", "malformed", "cleanup-abort", "cleanup-budget",
      ...[1, 2].flatMap(n => ["throw", "abort", "budget"].map(reason => `show-${n}-${reason}`))].map(fault => ({ fault })),
  ]) {
    const f = managerFailureFixture(options), record = await terminalDiagnostic(f);
    assert.equal(record.report, "unread"); assert.equal(record.unit_stop, "unknown");
    assert.equal(f.events.includes("failure-read"), false); assert.equal(f.unit.failure, "MANAGER");
    assert.ok(f.counts().apis <= 1); assert.equal(f.counts().confirms, 1);
  }
});

test("#1020 start eligibility, disposal rejection, private false/throw and identity drift stay unread", async () => {
  let getters = 0;
  for (const kind of ["missing", "zero", "uppercase", "short", "object", "getter", "inherited", "prototype", "not-started", "already-stopped"]) {
    const f = fixture("child"), terminal = f.unit.terminal.bind(f.unit);
    f.unit.terminal = async () => { try { await terminal(); } finally {
      if (kind === "getter") Object.defineProperty(f.unit, "invocation", { get() { getters++; throw new Error(canary); } });
      else if (kind === "inherited") { delete f.unit.invocation; Object.setPrototypeOf(f.unit, Object.assign(Object.create(BrowserUnit.prototype), { invocation: "b".repeat(32) })); }
      else if (kind === "prototype") Object.setPrototypeOf(f.unit, Object.create(BrowserUnit.prototype));
      else if (kind === "not-started") f.unit.started = false;
      else if (kind === "already-stopped") f.unit.stopped = true;
      else f.unit.invocation = { missing: undefined, zero: "0".repeat(32), uppercase: "B".repeat(32), short: "bb", object: { toString() { throw new Error(canary); } } }[kind];
    } };
    const record = await terminalDiagnostic(f);
    assert.equal(record.report, "unread", kind); assert.equal(record.unit_stop, "unknown", kind);
    assert.equal(f.events.includes("failure-read"), false);
  }
  // An accessor may be encountered by existing BrowserUnit disposal, never used as read authority.
  assert.ok(getters <= 1);
  const hostile = fixture("child"), target = hostile.unit;
  hostile.unit = new Proxy(target, {
    get(object, key) { const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value; },
    getOwnPropertyDescriptor() { throw new Error(canary); },
  });
  assert.equal((await terminalDiagnostic(hostile)).report, "unread");
  assert.equal(hostile.events.includes("failure-read"), false);
  for (const key of ["started", "stopped"]) {
    const f = fixture("child"), terminal = f.unit.terminal.bind(f.unit);
    f.unit.terminal = async () => { try { await terminal(); } finally {
      Object.defineProperty(f.unit, key, { get() { throw new Error(canary); } });
    } };
    assert.equal((await terminalDiagnostic(f)).report, "unread"); assert.equal(f.events.includes("stop"), false);
  }
  for (const fault of ["stop", "dispose-show", "show-invalid", "identity-mismatch", "state-unaccepted"]) {
    const f = fixture("child"); f.stopFault = fault;
    let queries = 0; f.unit.confirmDiagnosticStop = async () => { queries++; return true; };
    assert.equal((await terminalDiagnostic(f)).report, "unread"); assert.equal(queries, 0);
  }
  for (const value of [false, "true", "throw", "drift"]) {
    const f = managerFailureFixture(); let calls = 0;
    f.unit.confirmDiagnosticStop = async () => { calls++; if (value === "throw") throw new Error(canary);
      if (value === "drift") f.unit.invocation = "c".repeat(32); return value === "drift" ? true : value; };
    assert.equal((await terminalDiagnostic(f)).report, "unread"); assert.equal(calls, 1);
  }
  for (const phase of ["disposed", "confirmed"]) {
    const f = phase === "disposed" ? fixture("child") : managerFailureFixture();
    if (phase === "disposed") f.hook = stage => { if (stage === "disposed") f.unit.invocation = "c".repeat(32); };
    else { const confirm = f.unit.confirmDiagnosticStop; f.unit.confirmDiagnosticStop = async () => { const result = await confirm(); f.unit.invocation = "c".repeat(32); return result; }; }
    assert.equal((await terminalDiagnostic(f)).report, "unread");
  }
});

test("#1020 no-live failure Port accepts only legacy four or TLS seven fixed failed own data fields; reader errors stay unknown", async () => {
  let getters = 0;
  const accessor = progress(); Object.defineProperty(accessor, "entered", { get() { getters++; throw new Error(canary); } });
  const proxy = new Proxy(progress(), { ownKeys() { throw new Error(canary); } });
  const values = [undefined, null, {}, good(), { phase: "unknown", status: "failed" },
    { ...progress(), entered: canary }, { ...progress(), status: "complete" }, { ...progress(), extra: canary },
    { ...progress(), [Symbol("extra")]: true }, Object.create(progress()), accessor, proxy];
  for (const value of values) {
    const f = fixture("child"); f.ports.failureReport = () => { f.events.push("failure-read"); return value; };
    const record = await terminalDiagnostic(f);
    assert.equal(record.unit_stop, "confirmed"); assert.equal(record.report, "unknown");
    assert.equal(record.entered, "unknown"); assert.equal(record.confirmed, "unknown");
    assert.equal(f.events.filter(e => e === "failure-read").length, 1);
  }
  assert.equal(getters, 0);
  for (const missing of [false, true]) {
    const f = fixture("child");
    if (missing) delete f.ports.failureReport;
    else f.ports.failureReport = () => { f.events.push("failure-read"); throw new Error(canary); };
    const record = await terminalDiagnostic(f);
    assert.equal(record.unit_stop, "confirmed"); assert.equal(record.report, "unknown");
    assert.equal(record.entered, "unknown"); assert.equal(record.confirmed, "unknown");
    assert.equal(f.events.filter(e => e === "failure-read").length, missing ? 0 : 1);
  }
  for (const fault of ["valid", "tls-valid", "absent", "partial", "old", "complete", "invalid", "mode", "link", "oversize", "directory-mode", "symlink"]) {
    const dir = mkdtempSync(join(tmpdir(), "unauthenticated-failure-fixture-"));
    try {
      const path = join(dir, "unauthenticated-booking-report");
      if (fault !== "absent") writeFileSync(path, fault === "old" ? unauthenticatedBookingChildUnknown :
        fault === "complete" ? unauthenticatedBookingChildComplete : fault === "invalid" ? canary :
        fault === "oversize" ? "x".repeat(257) :
        fault === "tls-valid" ? formatUnauthenticatedBookingFailure({ entered: "tls-cleanup", confirmed: "dom-401",
          tls_primary: "tls-san", tls_cleanup: "browser-close", tls_err: "ERR_CERT_COMMON_NAME_INVALID" }) : formatUnauthenticatedBookingFailure({ entered: "tls-cleanup", confirmed: "dom-401" }), { mode: 0o600 });
      if (fault === "partial") writeFileSync(path + ".partial", canary, { mode: 0o600 });
      if (fault === "mode") chmodSync(path, 0o644);
      if (fault === "link") linkSync(path, path + "-alias");
      if (fault === "directory-mode") chmodSync(dir, 0o755);
      if (fault === "symlink") { renameSync(path, path + "-target"); symlinkSync(path + "-target", path); }
      const before = readdirSync(dir);
      const f = managerFailureFixture(); f.ports.failureReport = () => { f.events.push("failure-read"); return readUnauthenticatedBookingReport(dir); };
      const record = await terminalDiagnostic(f);
      assert.equal(record.report, ["valid", "tls-valid"].includes(fault) ? "observed" : "unknown", fault);
      assert.equal(record.confirmed, ["valid", "tls-valid"].includes(fault) ? "dom-401" : "unknown");
      for (const [key, value] of Object.entries({ tls_primary: "tls-san", tls_cleanup: "browser-close", tls_err: "ERR_CERT_COMMON_NAME_INVALID" })) {
        assert.equal(record[key], fault === "tls-valid" ? value : "unknown");
      }
      assert.deepEqual(readdirSync(dir), before);
    } finally { rmSync(dir, { recursive: true }); }
  }
});

// #1024 consumes the current #1023 report; it never reconstructs raw Helper output.
const tlsProgress = overrides => ({ ...progress(), tls_primary: "tls-san", tls_cleanup: "browser-close",
  tls_err: "ERR_CERT_COMMON_NAME_INVALID", ...overrides });
test("#1024 real Child codec preserves primary/cleanup, cleanup-only and unobserved TLS axes", async () => {
  for (const [events, expected] of [
    [[{ tls_primary: "tls-san", tls_err: "ERR_CERT_COMMON_NAME_INVALID" }, { tls_cleanup: "browser-close" }],
      { tls_primary: "tls-san", tls_cleanup: "browser-close", tls_err: "ERR_CERT_COMMON_NAME_INVALID" }],
    [[{ tls_cleanup: "owned-remove" }], { tls_primary: "unknown", tls_cleanup: "owned-remove", tls_err: "unknown" }],
    [[], { tls_primary: "unknown", tls_cleanup: "unknown", tls_err: "unknown" }],
  ]) {
    const f = fixture("child", 0, events), record = await terminalDiagnostic(f);
    assert.deepEqual(record, terminalRecord({ report: "observed", ...expected }));
    assert.equal(f.unit.failure, "MANAGER");
    assert.equal(f.events.filter(e => e === "failure-read").length, 1);
    assert.deepEqual(f.events.slice(-3), ["stop", "disposed-show", "failure-read"]);
  }
});

test("#1024 legacy/new own-data reports reflect only after accepted or private no-live gate", async () => {
  for (const privateGate of [false, true]) for (const value of [progress(), tlsProgress(),
    tlsProgress({ entered: "tls-setup", confirmed: "home" }),
    tlsProgress({ entered: "unknown", confirmed: "unknown", tls_primary: "unknown", tls_cleanup: "unknown", tls_err: "unknown" })]) {
    const f = privateGate ? managerFailureFixture() : fixture("child");
    f.ports.failureReport = () => {
      assert.equal(f.unit.stopped, true);
      if (privateGate) assert.deepEqual(f.counts(), { samples: 2, apis: 1, confirms: 1 });
      f.events.push("failure-read"); return value;
    };
    const record = await terminalDiagnostic(f);
    assert.deepEqual(record, terminalRecord({ stop: privateGate ? "failed-state" : "confirmed", report: "observed",
      entered: value.entered, confirmed: value.confirmed,
      ...Object.fromEntries(["tls_primary", "tls_cleanup", "tls_err"].map(key => [key, value[key] ?? "unknown"])) }));
    assert.equal(f.events.filter(e => e === "failure-read").length, 1);
    const before = f.events.length;
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), { message: failed("start") });
    assert.equal(f.events.length, before);
  }
});

test("#1024 pre-try Child failure stays unknown; TLS never overwrites mismatch or nonterminal stage", async () => {
  const controller = new AbortController(); controller.abort(); let text, calls = 0;
  assert.equal(await useUnauthenticatedBookingChild({ signal: controller.signal, isolated: true,
    runInner: () => { calls++; }, write: wire => { text = wire; } }), false);
  assert.equal(calls, 0);
  const f = fixture("child"); f.ports.failureReport = () => parseUnauthenticatedBookingReport(text);
  assert.deepEqual(await terminalDiagnostic(f), terminalRecord({ report: "observed" }));
  const mismatch = fixture("invocation"); mismatch.ports.failureReport = () => tlsProgress({ entered: "tls-setup", confirmed: "home" });
  const record = await terminalDiagnostic(mismatch);
  assert.equal(record.reason, "mismatch"); assert.equal(mismatch.unit.failure, "MISMATCH");
  assert.equal(record.tls_primary, "tls-san"); assert.equal(record.entered, "tls-setup"); assert.equal(record.confirmed, "home");
  for (const [fault, stage] of [["preflight", "preflight"], ["start", "start"], ["ownership", "ownership"], ["remove", "remove"]]) {
    const f = fixture(fault); let reads = 0;
    f.ports.failureReport = () => { reads++; return tlsProgress(); };
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), { message: failed(stage) });
    assert.equal(reads, 0);
  }
});

test("#1024 hostile TLS fields close all progress to unknown without getters/proxy traps", async () => {
  let touched = 0;
  const values = [Object.create(tlsProgress()),
    new Proxy(tlsProgress(), { ownKeys() { touched++; throw new Error(canary); } }),
    { ...tlsProgress(), extra: canary }, { ...tlsProgress(), [Symbol("extra")]: canary },
    { ...tlsProgress(), ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`extra${i}`, canary])) }];
  for (const key of Object.keys(tlsProgress())) {
    const missing = tlsProgress(); delete missing[key]; values.push(missing);
    const accessor = tlsProgress(); Object.defineProperty(accessor, key, { get() { touched++; throw new Error(canary); } }); values.push(accessor);
    for (const value of [undefined, null, "", canary, "秘密", "unknown\n", "unknown\r\n", "unknown\nunknown", "x".repeat(513)]) {
      values.push(tlsProgress({ [key]: value }));
    }
  }
  for (const value of values) {
    const f = managerFailureFixture(); f.ports.failureReport = () => { f.events.push("failure-read"); return value; };
    const record = await terminalDiagnostic(f);
    assert.equal(record.unit_stop, "confirmed"); assert.equal(record.report, "unknown");
    assert.equal(f.events.filter(e => e === "failure-read").length, 1);
  }
  assert.equal(touched, 0);
  // A valid new report cannot open a rejected manager gate.
  const f = managerFailureFixture({ fault: "api-throw" });
  f.ports.failureReport = () => { touched++; return tlsProgress(); };
  assert.equal((await terminalDiagnostic(f)).report, "unread"); assert.equal(touched, 0);
});

test("only exact four own data fields; old normal, fixture, unknown, extra symbol and getters rejected", async () => {
  let touched = 0;
  const accessor = good(); Object.defineProperty(accessor, "readback", { get() { touched++; throw new Error(canary); } });
  const values = [null, {}, { execution: "isolated", phase: "complete", status: "prepared" },
    { ...good(), readback: "changed" }, { ...good(), status: "success" }, { ...good(), extra: canary },
    { ...good(), [Symbol("extra")]: true }, Object.create(good()), accessor,
    parseUnauthenticatedBookingReport(unauthenticatedBookingFixtureComplete), parseUnauthenticatedBookingReport(unauthenticatedBookingChildUnknown)];
  for (const value of values) {
    const f = fixture(); f.ports.report = () => value;
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), { message: failed("report") });
    assert.ok(!f.events.includes("final-check") && !f.events.includes("delete"));
    assert.equal(f.events.filter(v => v === "stop").length, 1);
  }
  assert.equal(touched, 0);
});

test("180s total / 10s reserve / 120s unit cap with preflight debit; exhausted budget never starts", async () => {
  for (const [cost, runtime] of [[0, 120], [50000, 120], [50001, 119], [60000, 110], [169000, 1]]) {
    const f = fixture("", cost); await useUnauthenticatedBookingOuter(f.unit, f.ports);
    assert.equal(f.unit.runtime, runtime); assert.equal(f.unit.deadline, 180000);
  }
  const f = fixture("", 170000);
  await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), { message: failed("preflight") });
  assert.deepEqual(f.events, ["preflight"]);
});

test("parallel use cannot stop or close the active original owner", async () => {
  const f = fixture(); let resume;
  f.ports.preflight = () => new Promise(done => { resume = done; });
  const active = useUnauthenticatedBookingOuter(f.unit, f.ports);
  await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), { message: failed("start") });
  assert.deepEqual(f.events, []); resume(); await active;
});

test("actual private report reader is used after terminal and before owned cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unauthenticated-outer-fixture-"));
  try {
    const f = fixture();
    f.ports.report = () => { assert.equal(f.unit.accepted, true); assert.equal(f.unit.stopped, false); return readUnauthenticatedBookingReport(dir); };
    writeUnauthenticatedBookingReport(dir, unauthenticatedBookingChildComplete);
    await useUnauthenticatedBookingOuter(f.unit, f.ports);
    for (const fault of ["malformed", "mode", "partial"]) {
      const bad = fixture(); bad.ports.report = () => readUnauthenticatedBookingReport(dir);
      const path = join(dir, "unauthenticated-booking-report");
      if (fault === "malformed") writeFileSync(path, "TRUSTED_BOOKING_CHILD_V1; execution=isolated; phase=complete; status=prepared\n");
      if (fault === "mode") chmodSync(path, 0o644);
      if (fault === "partial") writeFileSync(path + ".partial", canary, { mode: 0o600 });
      await assert.rejects(useUnauthenticatedBookingOuter(bad.unit, bad.ports), { message: failed("report") });
      assert.ok(!bad.events.includes("delete"));
    }
  } finally { rmSync(dir, { recursive: true }); }
});

// Execute the whole sealed operator, catch/finally and CLI with a virtual owned
// filesystem and command adapter. No real CLI --run, manager, Chrome or D1.
async function operatorFixture(fault = "", injectedRun, failureOptions = {}) {
  const f = fixture(fault.startsWith("terminal-") ? fault.slice("terminal-".length) : "");
  const root = "/fixture", temporary = "/fixture-tmp/run", parent = join(root, ".wrangler");
  const persist = join(parent, "student-booking-evaluation"), home = join(temporary, "browser-home");
  const reportPath = join(temporary, "unauthenticated-booking-report"), old = join(parent, "student-read-only-evaluation");
  let serial = 0, phase = "preflight", probes = 0, reads = 0;
  const nodes = new Map(), stdout = [], stderr = [], listeners = new Map();
  const node = (path, mode = 0o700) => nodes.set(path, { path, mode, dev: 1, ino: ++serial, uid: 7, gid: 7, nlink: 1, size: 114, mtimeMs: 1, ctimeMs: 1 });
  node(temporary);
  if (fault !== "create-parent") node(parent, 0o755);
  const err = () => { throw new Error(canary); };
  const stat = path => { if (!nodes.has(path)) throw Object.assign(new Error(canary), { code: "ENOENT" }); return { ...nodes.get(path) }; };
  const owned = (path, mode = 0o700) => { const s = stat(path); if (s.mode !== mode || s.symlink || s.uid !== 7) err(); return { ...s, mode }; };
  const verify = identity => { const s = owned(identity.path, identity.mode); if (["dev", "ino", "uid", "gid"].some(k => s[k] !== identity[k])) err(); };
  const mutation = () => {
    const path = fault.startsWith("parent-") ? parent : fault.startsWith("persist-") ? persist : fault.startsWith("home-") ? home : temporary;
    if (fault.endsWith("inode")) nodes.get(path).ino++;
    if (fault.endsWith("gid")) nodes.get(path).gid++;
    if (fault.endsWith("mode")) nodes.get(path).mode ^= 0o020;
    if (fault.endsWith("special-mode")) nodes.get(path).mode |= 0o2000;
    if (fault.endsWith("symlink")) nodes.get(path).symlink = true;
  };
  f.hook = stage => {
    if (stage === "child") { phase = "final"; node(persist); node(home); node(reportPath, 0o600); }
    if (stage === "stop") { phase = "remove"; mutation();
      if (failureOptions.owner === "inode") nodes.get(temporary).ino++;
      if (failureOptions.owner === "mode") nodes.get(temporary).mode = 0o755;
      if (fault === "report-replaced") nodes.get(reportPath).ino++;
      if (fault === "late-signal") listeners.get("SIGTERM")();
      if (fault === "stop-unknown") err(); }
  };
  const pkg = { devDependencies: { wrangler: "4.146.0" }, packages: { "node_modules/wrangler": { version: "4.146.0" } }, version: "4.146.0" };
  const supply = { proxyOptions: { configPath: "fixture-config" },
    checkBookingEnvironment(env) { f.events.push("environment"); assert.deepEqual(Array.from(Object.keys(env)).sort(), ["CI", "HOME", "PATH", "TMPDIR", "WRANGLER_LOG_PATH", "WRANGLER_SEND_METRICS", "XDG_CONFIG_HOME"]);
      assert.equal(env.HOME, temporary); assert.equal(env.TMPDIR, temporary); assert.equal(env.XDG_CONFIG_HOME, temporary); assert.equal(env.WRANGLER_SEND_METRICS, "false"); },
    checkOwnedTree(path) { f.events.push(`tree:${phase}:${path === persist ? "persist" : "tmp"}`); if (fault === `tree-${phase}`) err(); },
  };
  const dependencies = {
    "./trusted-booking-seed.mjs": supply,
    "./trusted-browser-reads.mjs": { browserPreflight() { f.events.push("browser-preflight"); if (fault === "strict-preflight") err(); } },
    "./verify-student-assets.mjs": { verifyStudentAssets() { f.events.push("assets"); } },
    "./local-https-smoke.mjs": { migrations() { f.events.push("migrations"); } },
  };
  const source = readFileSync("tests/evaluation/trusted-unauthenticated-booking-outer.mjs", "utf8")
    .slice(readFileSync("tests/evaluation/trusted-unauthenticated-booking-outer.mjs", "utf8").indexOf("const root ="))
    .replace("const exec = promisify(execFile);", "")
    .replace(/const root = .*?;/, 'const root = "/fixture";')
    .replaceAll("export ", "").replaceAll("import.meta.url", '"fixture-outer"')
    .replace(/await import\(("[^"]+")\)/g, "await load($1)");
  const proc = { platform: "linux", version: "v24.0.0", execPath: process.execPath, argv: ["fixture-node", "fixture-outer", "--run"],
    on: (name, fn) => listeners.set(name, fn), removeListener: name => listeners.delete(name) };
  const context = { process: proc, AbortController, Date: { now: () => 0 }, join, resolve: value => value,
    types, unauthenticatedBookingPhases, unauthenticatedBookingTlsPrimary, unauthenticatedBookingTlsCleanup, unauthenticatedBookingTlsErrors,
    fileURLToPath: value => value, tmpdir: () => "/fixture-tmp", constants: { X_OK: 1 },
    load: async name => { assert.ok(Object.hasOwn(dependencies, name)); return dependencies[name]; },
    mkdtempSync: () => { f.events.push("temporary"); return temporary; }, lstatSync: stat, ownedIdentity: owned, verifyOwned: verify,
    readdirSync: path => path === temporary ? (phase === "preflight" ? [] : ["browser-home", "unauthenticated-booking-report"]) : [],
    readFileSync: () => JSON.stringify(fault === "dependency-version" ? { ...pkg, version: "bad" } : pkg),
    accessSync: () => { if (fault === "executable") err(); },
    mkdirSync: path => { f.events.push("mkdir"); node(path); },
    rmSync: path => { f.events.push(path === persist ? "delete-persist" : "delete-tmp"); if (fault === (path === persist ? "delete-first" : "delete-second")) err(); nodes.delete(path);
      if (fault === "after-delete-signal" && path === temporary) listeners.get("SIGINT")(); },
    generatedBrowserFiles: () => fault === `generated-${phase}` ? ["fixture-generated"] : [],
    unauthenticatedBookingReportName: "unauthenticated-booking-report",
    readUnauthenticatedBookingReport: path => { assert.equal(path, temporary); reads++;
      if (fault === "report-read") err();
      if (fault === "report-toctou" || failureOptions.reportDrift) nodes.get(reportPath).mtimeMs++;
      return failureOptions.value ?? good(); },
    BrowserUnit: function(options) { assert.equal(options.deadline, 180000); f.unit.signal.removeEventListener("abort", f.unit.cancel); f.unit.signal = options.signal;
      options.signal.addEventListener("abort", f.unit.cancel, { once: true }); return f.unit; },
    browserUnitPreflight: async options => { assert.equal(options.deadline, 180000); f.events.push("capability"); if (fault === "capability") err(); },
    exec: async (file, args, options) => { assert.ok(options.timeout > 0 && options.timeout <= 5000); assert.equal(options.env.HOME, temporary);
      if (file === "ss") { assert.deepEqual(Array.from(args).slice(0, 2), ["-H", "-ltn"]); probes++; f.events.push(`port:${phase}:${args[2]}`);
        if (fault === `port-${phase}-${args[2].endsWith("8788") ? "8788" : "8789"}`) return { stdout: "fixture-listener" }; }
      else { assert.equal(file, "/usr/bin/which"); if (fault === "tool") err(); }
      return { stdout: "" }; },
    console: { log: value => stdout.push(value), error: value => stderr.push(value) },
  };
  context.BrowserUnit.prototype = BrowserUnit.prototype;
  if (fault === "old-persist") node(old);
  if (fault === "existing-persist") node(persist);
  if (injectedRun) {
    // Bypass only finite seam to exercise sanitizer/CLI unknown-error handling.
    context.injectedRun = injectedRun;
  }
  const runnable = injectedRun ? source.replace("return await useUnauthenticatedBookingOuter(unit, {", "return await injectedRun(unit, {") : source;
  await runInNewContext(`(async () => { ${runnable}\n })()`, context);
  assert.equal(listeners.size, 0);
  return { stdout, stderr, status: proc.exitCode ?? 0, events: f.events, probes, reads };
}

test("sealed operator: preflight, strict environment, fixed port probes, all identity/tree checks then deletion and checkpoint", async () => {
  for (const fault of ["", "create-parent"]) {
    const r = await operatorFixture(fault);
    assert.deepEqual(r.stdout, [unauthenticatedBookingOuterCheckpoint]); assert.deepEqual(r.stderr, []); assert.equal(r.status, 0);
    assert.equal(r.probes, 8); assert.equal(r.reads, 2);
    assert.ok(r.events.indexOf("capability") < r.events.indexOf("start"));
    for (const path of ["persist", "tmp"]) assert.ok(r.events.indexOf(`tree:remove:${path}`) < r.events.indexOf("delete-persist"));
    assert.deepEqual(r.events.slice(-2), ["delete-persist", "delete-tmp"]);
  }
});

test("sealed operator representative fault matrix suppresses checkpoint, prevents unauthorized deletion and retry", async () => {
  const faults = ["strict-preflight", "dependency-version", "executable", "capability", "tool", "old-persist", "existing-persist",
    ...["preflight", "final", "remove"].flatMap(phase => [8788, 8789].map(port => `port-${phase}-${port}`)),
    "report-read", "report-toctou", "report-replaced", "tree-final", "tree-remove", "generated-final", "generated-remove",
    ...["parent", "persist", "home", "tmp"].flatMap(path => ["inode", "gid", "mode", "special-mode", "symlink"].map(change => `${path}-${change}`)),
    "stop-unknown", "late-signal", "delete-first", "delete-second", "after-delete-signal"];
  for (const fault of faults) {
    const r = await operatorFixture(fault);
    assert.deepEqual(r.stdout, [], fault); assert.equal(r.status, 1, fault);
    assert.equal(r.stderr.length, 1); assert.ok(r.stderr[0].startsWith("TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage="));
    assert.ok(!r.stderr[0].includes(canary));
    assert.ok(r.events.filter(v => v === "start").length <= 1); assert.ok(r.events.filter(v => v === "stop").length <= 1);
    if (!["delete-first", "delete-second", "after-delete-signal"].includes(fault)) assert.ok(!r.events.includes("delete-persist"), fault);
    if (fault === "delete-first") assert.ok(!r.events.includes("delete-tmp"));
  }
});

test("CLI accepts only fixed failure enums; accessor/cause/normal diagnostic/raw text never reflected", async () => {
  const terminalWire = formatUnauthenticatedBookingTerminal(terminalRecord());
  const terminal = await operatorFixture("", async () => { throw new Error(terminalWire, { cause: canary }); });
  assert.deepEqual(terminal.stderr, [terminalWire]); assert.deepEqual(terminal.stdout, []); assert.equal(terminal.status, 1);
  for (const stage of ["preflight", "start", "report", "ownership", "release", "remove", "listeners", "operator", "unknown"]) {
    const r = await operatorFixture("", async () => { throw new Error(failed(stage), { cause: canary }); });
    assert.deepEqual(r.stderr, [failed(stage)]); assert.deepEqual(r.stdout, []);
  }
  let touched = 0;
  for (const error of [new Error(canary), new Error(failed("terminal")), new Error(terminalWire + "\n"),
    new Error(terminalWire.replace("exit=nonzero", "exit=" + canary)), new Error(failed("report") + "\n"), new Error(failed("made-up")),
    new Error("TRUSTED_BOOKING_OUTER_FAILED; stage=terminal"), null,
    { get message() { touched++; throw new Error(canary); } }]) {
    const r = await operatorFixture("", async () => { throw error; });
    assert.deepEqual(r.stderr, [failed("unknown")]); assert.deepEqual(r.stdout, []);
  }
  assert.equal(touched, 0);
});

test("import and non-exact opt-in stay inert", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./tests/evaluation/trusted-unauthenticated-booking-outer.mjs')"], { encoding: "utf8" });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  for (const args of [[], ["--unknown"], ["--run", "--remote"]]) {
    const r = spawnSync(process.execPath, ["tests/evaluation/trusted-unauthenticated-booking-outer.mjs", ...args], { encoding: "utf8" });
    assert.equal(r.error, undefined); assert.equal(r.status, 1); assert.equal(r.stdout, ""); assert.ok(r.stderr.startsWith("Opt-in only:"));
  }
});

// #1012: fixture grammar only; no workflow write or execution authorization.
const productWorkflow = ".github/workflows/product-ci.yml";
const unauthenticatedCaller = /trusted-unauthenticated-booking-(outer|child|report)/;
const strictText = bytes => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const proofStep = `
      - name: '#930 booking unauthenticated proof (temporary)'
        if: steps.applicability.outputs.applicable == 'true' && github.event.action == 'opened' && github.run_attempt == 1
        timeout-minutes: 4
        shell: bash
        run: |
          node --input-type=module <<'NODE'
          import { spawnSync } from 'node:child_process';
          const result = spawnSync(process.execPath, ['tests/evaluation/trusted-unauthenticated-booking-outer.mjs', '--run'], {
            encoding: 'utf8', timeout: 190000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe']
          });
          if (result.error !== undefined || result.signal !== null || result.status !== 0 || result.stderr !== '' ||
              result.stdout !== ${JSON.stringify(unauthenticatedBookingOuterCheckpoint + "\n")}) {
            let stage = 'unknown';
            if (result.error === undefined && result.signal === null && result.status === 1 && result.stdout === '') {
              for (const allowed of ['preflight', 'start', 'report', 'ownership', 'release', 'remove', 'listeners', 'operator', 'unknown']) {
                if (result.stderr === 'TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=' + allowed + '; retain owned files; do not retry\\n') stage = allowed;
              }
            }
            let diagnostic = '';
            if (result.error === undefined && result.signal === null && result.status === 1 && result.stdout === '' &&
                typeof result.stderr === 'string' && result.stderr.length <= ${unauthenticatedBookingTerminalMaxBytes} && result.stderr.endsWith('\\n')) {
              const text = result.stderr.slice(0, -1);
              const match = new RegExp('^(?:' + ${JSON.stringify(unauthenticatedBookingTerminalGrammar)} + ')$').exec(text);
              if (match && match[0] === text) { stage = 'terminal'; diagnostic = text.slice('TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=terminal'.length); }
            }
            console.error('UNAUTHENTICATED_BOOKING_PROOF_FAILED; stage=' + stage + diagnostic);
            process.exitCode = 1;
          } else {
            console.log(${JSON.stringify(unauthenticatedBookingOuterCheckpoint)});
          }
          NODE
`;

function allowsUnauthenticatedCaller(files, context) {
  try {
    for (const [path, content] of files) {
      if (typeof content !== "string" || (path !== productWorkflow && unauthenticatedCaller.test(content))) return false;
    }
    const workflow = files.get(productWorkflow);
    if (typeof workflow !== "string") return false;
    if (!unauthenticatedCaller.test(workflow)) return true; // Ordinary CI stays inert.
    const { env, event, head, base, main, mergeBase, changed, diff, clean, baseWorkflow } = context;
    const pr = event.pull_request, repository = "suzukure/nssscdl";
    const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "pull_request" ||
        env.GITHUB_RUN_ATTEMPT !== "1" || event.action !== "opened" ||
        env.GITHUB_REPOSITORY !== repository || env.GITHUB_WORKFLOW !== "Product CI" ||
        event.repository.full_name !== repository || event.repository.default_branch !== "main" ||
        !Number.isSafeInteger(event.number) || event.number <= 0 || pr.number !== event.number || pr.state !== "open" ||
        env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
        pr.base.repo.full_name !== repository || pr.head.repo.full_name !== repository ||
        pr.base.ref !== "main" || env.GITHUB_BASE_REF !== "main" ||
        typeof pr.head.ref !== "string" || !/^proof\/930-booking-unauthenticated-[a-z0-9][a-z0-9-]*$/.test(pr.head.ref) ||
        env.GITHUB_HEAD_REF !== pr.head.ref || !sha(head) || !sha(base) || head === base ||
        head !== pr.head.sha || base !== pr.base.sha || base !== main || mergeBase !== base ||
        clean !== "" || changed !== productWorkflow + "\0" || diff !== `M\0${productWorkflow}\0` ||
        typeof baseWorkflow !== "string" || !baseWorkflow.endsWith("\n") ||
        unauthenticatedCaller.test(baseWorkflow) || /trusted-booking-(outer|child|report)/.test(baseWorkflow)) return false;
    return workflow === baseWorkflow + proofStep;
  } catch { return false; }
}

function proofContext(env, event, git) {
  // Read-only Git evidence from the existing fetch-depth:0 checkout.
  const base = event.pull_request.base.sha;
  if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) throw new Error("PROOF_CONTEXT_UNAVAILABLE");
  const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  if (!/^[0-9a-f]{40}$/.test(head) || git("rev-parse", "--verify", `${base}^{commit}`).trim() !== base) {
    throw new Error("PROOF_CONTEXT_UNAVAILABLE");
  }
  return { env, event, head, base,
    main: git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}").trim(),
    mergeBase: git("merge-base", base, head).trim(),
    changed: git("diff", "--no-renames", "--name-only", "-z", base, head),
    diff: git("diff", "--no-renames", "--name-status", "-z", base, head),
    clean: git("status", "--porcelain=v1", "--untracked-files=normal"),
    baseWorkflow: git("show", `${base}:${productWorkflow}`) };
}

test("production/workflows/normal operator remain disconnected except exact #1012 candidate", () => {
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)]);
  const files = new Map([...walk("src"), ...walk(".github/workflows"), "tests/evaluation/trusted-booking-outer.mjs"]
    .map(path => [path, strictText(readFileSync(path))]));
  let context;
  if (unauthenticatedCaller.test(files.get(productWorkflow))) {
    try {
      const git = (...args) => {
        const result = spawnSync("git", args, { timeout: 5000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"] });
        if (result.error || result.signal !== null || result.status !== 0) throw new Error("PROOF_CONTEXT_UNAVAILABLE");
        return strictText(result.stdout);
      };
      context = proofContext(process.env, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), git);
    } catch { /* Unknown event/Git facts deny; never infer approval. */ }
  }
  assert.equal(allowsUnauthenticatedCaller(files, context), true, "401 workflow/source caller guard");
});

function callerFixture(branch = "proof/930-booking-unauthenticated-fixture", number = 17) {
  const current = strictText(readFileSync(productWorkflow));
  // Permit finite fixtures to run on a future candidate, without changing guard input.
  const baseWorkflow = current.endsWith(proofStep) ? current.slice(0, -proofStep.length) : current;
  const head = "a".repeat(40), base = "b".repeat(40);
  const repository = { full_name: "suzukure/nssscdl", default_branch: "main" };
  return { files: new Map([[productWorkflow, baseWorkflow + proofStep]]), context: {
    env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: repository.full_name, GITHUB_WORKFLOW: "Product CI", GITHUB_BASE_REF: "main",
      GITHUB_HEAD_REF: branch, GITHUB_REF: `refs/pull/${number}/merge` },
    event: { repository, action: "opened", number, pull_request: { number, state: "open",
      head: { ref: branch, sha: head, repo: { ...repository } }, base: { ref: "main", sha: base, repo: { ...repository } } } },
    head, base, main: base, mergeBase: base, clean: "", changed: productWorkflow + "\0",
    diff: `M\0${productWorkflow}\0`, baseWorkflow } };
}

test("#1012 exact opened/attempt1/same-repository/fresh-main candidate only; ordinary CI inert", () => {
  const f = callerFixture();
  assert.equal(allowsUnauthenticatedCaller(new Map([[productWorkflow, f.context.baseWorkflow]])), true);
  assert.equal(allowsUnauthenticatedCaller(f.files), false);
  assert.equal(allowsUnauthenticatedCaller(f.files, f.context), true);
  const fresh = callerFixture("proof/930-booking-unauthenticated-next", 203);
  fresh.context.base = fresh.context.main = fresh.context.mergeBase = fresh.context.event.pull_request.base.sha = "d".repeat(40);
  fresh.context.baseWorkflow += "\n      # Fresh baseline fixture\n";
  fresh.files.set(productWorkflow, fresh.context.baseWorkflow + proofStep);
  assert.equal(allowsUnauthenticatedCaller(fresh.files, fresh.context), true);
  for (const key of Object.keys(f.context.env)) {
    const missing = callerFixture(); delete missing.context.env[key];
    assert.equal(allowsUnauthenticatedCaller(missing.files, missing.context), false, key);
  }
  const changes = [
    c => { c.env.GITHUB_ACTIONS = "false"; },
    ...["push", "pull_request_target", "workflow_dispatch"].map(value => c => { c.env.GITHUB_EVENT_NAME = value; }),
    ...["synchronize", "reopened", "ready_for_review", undefined].map(value => c => { c.event.action = value; }),
    ...["2", "3", "01", 1, undefined].map(value => c => { c.env.GITHUB_RUN_ATTEMPT = value; }),
    c => { c.env.GITHUB_REPOSITORY = "fork/nssscdl"; }, c => { c.env.GITHUB_WORKFLOW = "Other"; },
    c => { c.event.repository.full_name = "fork/nssscdl"; }, c => { c.event.repository.default_branch = "other"; },
    c => { c.event.pull_request.head.repo.full_name = "fork/nssscdl"; },
    c => { c.event.pull_request.base.repo.full_name = "fork/nssscdl"; },
    c => { c.event.pull_request.base.ref = "other"; }, c => { c.env.GITHUB_BASE_REF = "other"; },
    ...["ordinary", "proof/930-booking-normal-fixture", "proof/930-booking-unauthenticated-", "proof/930-booking-unauthenticated-X"]
      .map(value => c => { c.event.pull_request.head.ref = c.env.GITHUB_HEAD_REF = value; }),
    c => { c.env.GITHUB_HEAD_REF += "-forged"; }, c => { c.env.GITHUB_REF = "refs/heads/main"; },
    ...[0, -1, "17", 1.5].map(value => c => { c.event.number = c.event.pull_request.number = value; }),
    c => { c.event.pull_request.number++; }, c => { c.event.pull_request.state = "closed"; },
    c => { c.event.pull_request.head.sha = "c".repeat(40); }, c => { c.head = "invalid"; },
    c => { c.event.pull_request.base.sha = "c".repeat(40); }, c => { c.base = c.head; },
    c => { c.main = "c".repeat(40); }, c => { c.mergeBase = "c".repeat(40); },
    c => { c.clean = " M tests/evaluation/trusted-unauthenticated-booking-outer.test.mjs\n"; },
    c => { c.clean = "?? src/extra.ts\n"; },
    ...["src/worker.ts", "tests/evaluation/trusted-unauthenticated-booking-outer.test.mjs", ".github/workflows/extra.yml"]
      .map(path => c => { c.changed += path + "\0"; }),
    c => { c.changed = productWorkflow; }, c => { c.changed = ""; },
    ...["A", "D", "T", "R100"].map(status => c => { c.diff = `${status}\0${productWorkflow}\0`; }),
    c => { c.diff += `M\0src/worker.ts\0`; }, c => { c.baseWorkflow += proofStep; },
    c => { c.baseWorkflow = undefined; }, c => { c.baseWorkflow = c.baseWorkflow.trimEnd(); },
    c => { c.baseWorkflow += "trusted-booking-outer.mjs\n"; }, c => { c.event = {}; },
    c => { c.event.pull_request.body = "APPROVED"; c.env.GITHUB_ACTIONS = "false"; },
  ];
  for (const [index, change] of changes.entries()) {
    const candidate = callerFixture(); change(candidate.context);
    assert.equal(allowsUnauthenticatedCaller(candidate.files, candidate.context), false, `context denial ${index}`);
  }
});

test("#1012 source/other workflows deny; baseline and sole suffix stay byte-exact", () => {
  const f = callerFixture(), original = f.files.get(productWorkflow);
  for (const path of ["src/worker.ts", ".github/workflows/other.yml", "tests/evaluation/trusted-booking-outer.mjs"]) {
    for (const name of ["outer", "child", "report"]) {
      assert.equal(allowsUnauthenticatedCaller(new Map([...f.files, [path, `trusted-unauthenticated-booking-${name}.mjs`]]), f.context), false);
    }
  }
  const edits = [
    ["contents: read", "contents: write"], ["pull_request:", "push:"], ["fetch-depth: 0", "fetch-depth: 1"],
    ["node-version-file: .node-version", "node-version: 24"], ["timeout-minutes: 4", "timeout-minutes: 5"],
    ["github.event.action == 'opened'", "true"], ["github.run_attempt == 1", "true"],
    ["timeout: 190000", "timeout: 300000"], ["maxBuffer: 4096", "maxBuffer: 8192"],
    ["'ignore', 'pipe', 'pipe'", "'inherit', 'pipe', 'pipe'"], ["encoding: 'utf8'", "encoding: 'ascii'"],
    ["'--run'", "'--run', '--remote'"], ["result.stderr !== ''", "false"],
    ["result.stdout !==", "false && result.stdout !=="], ["result.signal !== null", "result.signal"],
    ["stage=' + stage", "stage=' + result.stderr"], ["          NODE\n", "          NODE\n          npm test\n"],
    ["trusted-unauthenticated-booking-outer.mjs", "trusted-unauthenticated-booking-child.mjs"],
    ["        shell: bash", "        continue-on-error: true\n        shell: bash"],
    ...["npm ci", "npm run build", "npm run typecheck", "npm run lint", "npm run test:unit", "npm run test:integration", "npm run d1:local", "npm run test:d1"]
      .map(command => [command, "echo bypass"]),
    ...Array.from(original.matchAll(/uses: ([^\n]+)/g), match => [match[0], "uses: unsafe/action@main"]),
  ];
  for (const [index, workflow] of [original + proofStep, proofStep + f.context.baseWorkflow,
    original + "      - run: echo extra\n", ...edits.map(([from, to]) => original.replace(from, to))].entries()) {
    assert.notEqual(workflow, original, `effective mutation ${index}`);
    assert.equal(allowsUnauthenticatedCaller(new Map([[productWorkflow, workflow]]), f.context), false, `workflow denial ${index}`);
  }
});

test("#1012 Git adapter verifies checkout/base/fresh main/file status/clean tree; every read error denies", () => {
  assert.throws(() => strictText(Buffer.from([0xff])));
  assert.equal(strictText(Buffer.from("\ufeffworkflow\n")), "\ufeffworkflow\n");
  const f = callerFixture(), c = f.context;
  const outputs = new Map([
    [["rev-parse", "--verify", "HEAD^{commit}"], c.head + "\n"],
    [["rev-parse", "--verify", `${c.base}^{commit}`], c.base + "\n"],
    [["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], c.main + "\n"],
    [["merge-base", c.base, c.head], c.base + "\n"],
    [["diff", "--no-renames", "--name-only", "-z", c.base, c.head], c.changed],
    [["diff", "--no-renames", "--name-status", "-z", c.base, c.head], c.diff],
    [["status", "--porcelain=v1", "--untracked-files=normal"], ""],
    [["show", `${c.base}:${productWorkflow}`], c.baseWorkflow],
  ].map(([args, value]) => [JSON.stringify(args), value]));
  const git = (...args) => { const key = JSON.stringify(args); assert.ok(outputs.has(key)); return outputs.get(key); };
  assert.equal(allowsUnauthenticatedCaller(f.files, proofContext(c.env, c.event, git)), true);
  for (const key of outputs.keys()) {
    let context;
    try { context = proofContext(c.env, c.event, (...args) => {
      if (JSON.stringify(args) === key) throw new Error(canary);
      return git(...args);
    }); } catch { /* Same fail-closed adapter as inventory test. */ }
    assert.equal(allowsUnauthenticatedCaller(f.files, context), false);
  }
  for (const value of ["", "invalid", "c".repeat(40)]) {
    assert.throws(() => proofContext(c.env, c.event, (...args) => args[2] === `${c.base}^{commit}` ? value : git(...args)));
  }
});

function proofFixture(result) {
  const script = proofStep.split("          node --input-type=module <<'NODE'\n")[1]
    .replace("          import { spawnSync } from 'node:child_process';\n", "").replace(/          NODE\n$/, "");
  let calls = 0;
  const stdout = [], stderr = [], proc = { execPath: "fixture-node", exitCode: undefined };
  runInNewContext(script, { process: proc,
    console: { log: value => stdout.push(value), error: value => stderr.push(value) },
    spawnSync(file, args, options) {
      calls++; assert.equal(file, "fixture-node");
      assert.deepEqual(Array.from(args), ["tests/evaluation/trusted-unauthenticated-booking-outer.mjs", "--run"]);
      assert.equal(options.timeout, 190000); assert.equal(options.maxBuffer, 4096); assert.equal(options.encoding, "utf8");
      assert.deepEqual(Array.from(options.stdio), ["ignore", "pipe", "pipe"]);
      return result;
    } });
  assert.equal(calls, 1);
  return { stdout, stderr, status: proc.exitCode ?? 0 };
}

test("#1020 terminal failure through sealed operator/CLI and exact proofStep; one gated read, no port reread", async () => {
  const r = await operatorFixture("terminal-child");
  const expected = formatUnauthenticatedBookingTerminal(terminalRecord());
  assert.deepEqual(r.stderr, [expected]); assert.deepEqual(r.stdout, []); assert.equal(r.status, 1);
  assert.equal(r.reads, 1); assert.equal(r.probes, 4);
  assert.equal(r.events.filter(e => e === "start").length, 1);
  assert.equal(r.events.filter(e => e === "stop").length, 1);
  for (const e of ["delete-persist", "delete-tmp", "final-check"]) assert.equal(r.events.includes(e), false);
  assert.deepEqual(proofFixture({ status: r.status, signal: null, stdout: "", stderr: r.stderr[0] + "\n" }), {
    stdout: [], stderr: [expected.replace("TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED", "UNAUTHENTICATED_BOOKING_PROOF_FAILED")], status: 1 });
});

test("#1020 sealed failure report Port and proofStep publish progress only after stop/owner/stat checks", async () => {
  for (const options of [{ value: progress() }, { value: tlsProgress() }, { value: tlsProgress(), owner: "inode" },
    { value: tlsProgress(), owner: "mode" }, { value: tlsProgress(), reportDrift: true }, { value: progress(), owner: "inode" },
    { value: progress(), owner: "mode" }, { value: progress(), reportDrift: true }]) {
    const r = await operatorFixture("terminal-child", undefined, options);
    const record = parseUnauthenticatedBookingTerminal(r.stderr[0]);
    const observed = !options.owner && !options.reportDrift;
    assert.equal(record.report, observed ? "observed" : "unknown");
    assert.equal(record.confirmed, observed ? "dom-401" : "unknown");
    for (const key of ["tls_primary", "tls_cleanup", "tls_err"]) assert.equal(record[key], observed ? options.value[key] ?? "unknown" : "unknown");
    assert.equal(record.unit_stop, "confirmed");
    assert.equal(r.reads, options.owner ? 0 : 1); assert.equal(r.probes, 4);
    assert.deepEqual(proofFixture({ status: 1, signal: null, stdout: "", stderr: r.stderr[0] + "\n" }), {
      stdout: [], stderr: [r.stderr[0].replace("TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED", "UNAUTHENTICATED_BOOKING_PROOF_FAILED")], status: 1 });
    assert.equal(r.events.filter(e => e === "stop").length, 1);
    assert.equal(r.events.some(e => e.startsWith("delete")), false);
  }
});

test("#1012 bounded single spawn; exact success or fixed failure stage; raw/normal diagnostics never escape", () => {
  const success = { status: 0, signal: null, stdout: unauthenticatedBookingOuterCheckpoint + "\n", stderr: "" };
  assert.deepEqual(proofFixture(success), { stdout: [unauthenticatedBookingOuterCheckpoint], stderr: [], status: 0 });
  const failure = { status: 1, signal: null, stdout: "", stderr: failed("terminal") + "\n" };
  for (const stage of ["preflight", "start", "report", "ownership", "release", "remove", "listeners", "operator", "unknown"]) {
    assert.deepEqual(proofFixture({ ...failure, stderr: failed(stage) + "\n" }), {
      stdout: [], stderr: ["UNAUTHENTICATED_BOOKING_PROOF_FAILED; stage=" + stage], status: 1 });
  }
  const unknown = [
    ...[success, failure].flatMap(result => [
      ...[undefined, "", "SIGTERM", "SIGKILL"].map(signal => ({ ...result, signal })),
      ...[null, new Error(canary), Object.assign(new Error(canary), { code: "ETIMEDOUT" }),
        Object.assign(new Error(canary), { code: "ENOBUFS" })].map(error => ({ ...result, error })),
      ...[2, null, "0", "1"].map(status => ({ ...result, status })),
      ...[canary, Buffer.from(result.stdout), result.stdout + "\n", result.stdout + canary].map(stdout => ({ ...result, stdout })),
      ...[canary, Buffer.from(result.stderr), result.stderr + "\n", result.stderr + canary].map(stderr => ({ ...result, stderr })),
    ]),
    ...["", success.stdout.trimEnd(), success.stdout.replace("\n", "\r\n"), "TRUSTED_BOOKING_OUTER_V1\n"]
      .map(stdout => ({ ...success, stdout })),
    { ...success, status: 1 }, { ...failure, status: 0 }, { ...failure, stdout: success.stdout },
    ...[failed("terminal"), failed("terminal") + "\n", failed("terminal") + "\r\n", failed("terminal") + "\0\n", failed("made-up") + "\n",
      failed("terminal").replace("do not retry", "retry") + "\n", canary + failed("terminal") + "\n",
      "TRUSTED_BOOKING_OUTER_FAILED; stage=terminal; retain owned files; do not retry\n",
      failed("terminal").replace("; retain", "; diagnostic=observed; phase=dom; retain") + "\n"]
      .map(stderr => ({ ...failure, stderr })),
  ];
  for (const [index, result] of unknown.entries()) assert.deepEqual(proofFixture(result), {
    stdout: [], stderr: ["UNAUTHENTICATED_BOOKING_PROOF_FAILED; stage=unknown"], status: 1 }, `output denial ${index}`);
});

test("#1015/#1024 exact CLI/proofStep publishes only each fixed terminal enum; unknown/normal/raw closes without retry", async () => {
  // Independent reviewed enum inventory: additions require codec and wrapper synchronization.
  const enums = {
    reason: ["cancel", "timeout", "manager", "mismatch", "unknown", "unavailable", "none"],
    boundary: ["pre-show", "polling", "first-exit", "second-show", "double-exit", "unknown"],
    state: ["running", "exited", "failed", "other", "invalid", "unavailable"],
    result: ["success", "timeout", "other", "not-observed"],
    exit: ["zero", "nonzero", "abnormal-code", "not-observed", "unknown"],
    invocation: ["matched", "mismatched", "not-compared", "unknown"], cgroup: ["expected", "empty", "other", "unknown"],
    second: ["observed", "not-observed"], budget: ["adequate", "exhausted", "aborted", "unknown"],
    stop: ["confirmed", "failed-state", "identity-mismatch", "state-unaccepted", "stop-budget", "show-unavailable", "not-attempted", "unknown"],
    unit_stop: ["confirmed", "unknown"], report: ["observed", "unknown", "unread"],
    entered: ["unknown", "import", "preflight", "seed", "home", "tls-setup", "worker-start", "dom-401", "tls-cleanup", "worker-stop", "d1-unchanged", "secret-scan", "report-write"],
    confirmed: ["unknown", "import", "preflight", "seed", "home", "tls-setup", "worker-start", "dom-401", "tls-cleanup", "worker-stop", "d1-unchanged", "secret-scan", "report-write"],
    tls_primary: ["none", "unknown", "tls-preflight", "tls-cert", "tls-listener", "tls-browser-launch", "tls-browser-ownership", "tls-browser-context", "tls-browser-nss", "tls-positive", "tls-san", "tls-untrusted", "tls-consumer"],
    tls_cleanup: ["none", "unknown", "browser-close", "browser-ownership", "browser-process", "proof-listener", "worker-stop", "port-close", "generated-files", "owned-inspect", "owned-remove"],
    tls_err: ["ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_COMMON_NAME_INVALID", "ERR_CERT_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "TIMEOUT", "UNCLASSIFIED", "unknown"],
  };
  const result = { status: 1, signal: null, stdout: "", stderr: "" };
  const unknown = { stdout: [], stderr: ["UNAUTHENTICATED_BOOKING_PROOF_FAILED; stage=unknown"], status: 1 };
  const prefix = "TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED";
  const sealed = wire => proofFixture({ ...result, stderr: wire + "\n" });
  const wire = formatUnauthenticatedBookingTerminal(terminalRecord());
  const longest = Object.fromEntries(Object.entries(enums).map(([key, values]) => [key, values.reduce((a, b) => a.length > b.length ? a : b)]));
  const longestWire = formatUnauthenticatedBookingTerminal(longest);
  const expectedWire = prefix + "; stage=terminal" + Object.entries(longest).map(([key, value]) => `; ${key}=${value}`).join("") +
    "; evidence=unproved; retain owned files; do not retry";
  assert.equal(longestWire, expectedWire); // Independently fixes all 17 fields, their order and end markers.
  assert.equal(unauthenticatedBookingTerminalMaxBytes, 512);
  const cli = await operatorFixture("", async () => { throw new Error(expectedWire); });
  assert.deepEqual(cli.stderr, [expectedWire]); assert.deepEqual(cli.stdout, []); assert.equal(cli.status, 1);
  assert.deepEqual(enums.tls_primary, unauthenticatedBookingTlsPrimary);
  assert.deepEqual(enums.tls_cleanup, unauthenticatedBookingTlsCleanup);
  assert.deepEqual(enums.tls_err, unauthenticatedBookingTlsErrors);
  const legacyWire = longestWire.replace(/; tls_primary=.*?; evidence=/, "; evidence=");
  assert.equal(Buffer.byteLength(legacyWire + "\n"), 405);
  assert.equal(Buffer.byteLength(legacyWire.replace("; evidence=", "; tls_primary=tls-browser-ownership; evidence=") + "\n"), 440);
  assert.equal(Buffer.byteLength(longestWire.replace(/; tls_err=.*?; evidence=/, "; evidence=") + "\n"), 471);
  assert.equal(Buffer.byteLength(longestWire.replace("tls_err=", "tls_category=") + "\n"), 514);
  assert.equal(Buffer.byteLength(longestWire + "\n"), 509); // Fixed enum maxima + ASCII grammar + LF.
  assert.ok(Buffer.byteLength(longestWire + "\n") <= 512);
  for (const key of ["tls_primary", "tls_cleanup", "tls_err"]) for (const report of ["unknown", "unread"]) {
    const value = enums[key].find(value => value !== "unknown");
    assert.equal(formatUnauthenticatedBookingTerminal(terminalRecord({ report, [key]: value })), undefined);
    assert.deepEqual(sealed(wire.replace(`${key}=unknown`, `${key}=${value}`).replace("report=unknown", `report=${report}`)), unknown);
  }
  for (const record of [terminalRecord({ report: "unread", entered: "dom-401" }),
    terminalRecord({ report: "unknown", confirmed: "dom-401" }),
    terminalRecord({ unit_stop: "unknown", report: "observed" })]) {
    assert.equal(formatUnauthenticatedBookingTerminal(record), undefined);
  }
  assert.deepEqual(sealed(wire.replace("entered=unknown", "entered=dom-401")), unknown);
  assert.deepEqual(sealed(wire.replace("report=unknown", "report=observed").replace("unit_stop=confirmed", "unit_stop=unknown")), unknown);
  assert.deepEqual(sealed(longestWire), { stdout: [], stderr: [longestWire.replace(prefix, "UNAUTHENTICATED_BOOKING_PROOF_FAILED")], status: 1 });
  for (const [key, values] of Object.entries(enums)) {
    for (const value of values) {
      const record = terminalRecord({ [key]: value });
      if (["entered", "confirmed", "tls_primary", "tls_cleanup", "tls_err"].includes(key) && value !== "unknown") record.report = "observed";
      const text = formatUnauthenticatedBookingTerminal(record);
      assert.deepEqual(parseUnauthenticatedBookingTerminal(text), record);
      assert.deepEqual(sealed(text), { stdout: [], stderr: [text.replace(prefix, "UNAUTHENTICATED_BOOKING_PROOF_FAILED")], status: 1 });
    }
    for (const value of ["", "invalid-enum", canary, "秘密", "active", "dead", "1", "success\n"]) {
      assert.deepEqual(sealed(wire.replace(`${key}=${terminalRecord()[key]}`, `${key}=${value}`)), unknown, key);
    }
    assert.deepEqual(sealed(wire.replace(`; ${key}=${terminalRecord()[key]}`, "")), unknown);
    assert.deepEqual(sealed(wire.replace(`; ${key}=`, `; ${key}=${terminalRecord()[key]}; ${key}=`)), unknown);
  }
  for (const text of [wire + "\n", wire + "\r", wire + "\n" + wire, canary + wire, wire + canary,
    wire.replace("report=unknown", "report=read"), wire.replace("evidence=unproved", "evidence=proved"),
    wire.replace("; stop=", "; extra=unknown; stop="), wire.slice(1), wire + "x".repeat(513),
    wire.replace(/; unit_stop=.*?; evidence=/, "; report=unread; evidence="),
    "TRUSTED_BOOKING_OUTER_FAILED; stage=terminal; reason=timeout; stop=confirmed; retain owned files; do not retry",
    "TRUSTED_BOOKING_DIAGNOSTIC_V2; phase=dom; fault=unknown", failed("terminal")]) assert.deepEqual(sealed(text), unknown);
  // A valid terminal record cannot relax the wrapper's process/stream envelope.
  const valid = { ...result, stderr: wire + "\n" };
  for (const altered of [
    ...[0, 2, null, "1"].map(status => ({ ...valid, status })),
    ...[undefined, "SIGTERM", "SIGKILL"].map(signal => ({ ...valid, signal })),
    ...[null, new Error(canary)].map(error => ({ ...valid, error })),
    { ...valid, stdout: canary }, { ...valid, stderr: Buffer.from(valid.stderr) },
    { ...valid, stderr: wire }, { ...valid, stderr: wire + "\r\n" },
  ]) assert.deepEqual(proofFixture(altered), unknown);
});
