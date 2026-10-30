// Finite, secretless effects only. No GUI/WSLg/systemd/Worker/D1 startup.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { intervalLabel } from "../../src/web/model.ts";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { useOperator, cleanEnvironment } from "./booking-operator.mjs";
import { humanBookingObservation, observeHumanBrowser } from "./booking-operator-browser.mjs";
import { createOperatorWorker } from "./booking-operator-worker.mjs";
import { budget, userGroup, parseUnit, unitProperties, procIdentity, sameProcess, guiEnvironment, emptyGroup } from "./booking-operator-unit.mjs";
import { origin } from "./trusted-booking-seed.mjs";
const name = `nssscdl-operator-${"a".repeat(32)}.service`, group = userGroup(1000, name);
const id = "11111111-1111-4111-8111-111111111111", token = "v1." + "a".repeat(42) + "A";
const month = "2026-11", csrf = "finite-private-csrf", headers = { origin, "content-type": "application/json", "x-csrf-token": csrf };
const previewPath = "/api/me/reservations/preview", confirmPath = "/api/me/reservations";
const freshObservation = () => humanBookingObservation(month, csrf);
const previewBody = observation => ({ slot: observation.slot, previewClassification: "standard", classificationChanges: [], expectedStateToken: token });
const confirmBody = observation => ({ slot: { ...observation.slot, view: "reserved_by_me" },
  reservation: { reservationId: id, startsAt: observation.slot.startsAt, endsAt: observation.slot.endsAt, reservationState: "confirmed", classification: "standard" }, classificationChanges: [] });
function recorded() {
  const observation = freshObservation();
  observation.request(previewPath, "POST", { slotId: observation.slot.slotId }, headers);
  observation.response(previewPath, "POST", 200, previewBody(observation));
  observation.request(confirmPath, "POST", { slotId: observation.slot.slotId, expectedStateToken: token }, headers);
  observation.response(confirmPath, "POST", 201, confirmBody(observation));
  observation.response(confirmPath, "GET", 200, { items: [{ ...confirmBody(observation).reservation, attendanceState: "none" }], nextCursor: null });
  return observation;
}
test("#1104 Issue time contract: 5m preparation / 20m human / 3m cleanup / 30m total", () => {
  assert.deepEqual(budget, { prepare: 300000, interaction: 1200000, cleanup: 180000, total: 1800000 });
  assert.equal(budget.total - budget.prepare - budget.interaction - budget.cleanup, 120000);
  assert.deepEqual(Object.keys(cleanEnvironment("/owned")).sort(), ["CI", "HOME", "PATH", "TMPDIR", "WRANGLER_LOG_PATH", "WRANGLER_SEND_METRICS", "XDG_CONFIG_HOME"]);
});
function lifecycle(failure) {
  const events = [], seed = {}, handle = {};
  const step = name => async (...args) => { events.push(name); if (failure === name) throw new Error("SECRET_CANARY");
    if (name === "run") { assert.equal(args[0], seed); return id; }
    if (name === "readback") assert.deepEqual(args, [handle, id]);
  };
  const ports = Object.fromEntries(["preflight", "capture", "run", "terminal", "readback", "scan", "release", "remove", "stopUnknown"].map(n => [n, step(n)]));
  ports.prepare = async consume => { events.push("prepare"); if (failure === "prepare") throw Error("SECRET_CANARY"); await consume(seed, handle); };
  return { ports, events };
}
test("#1104 owner retains private seed capability outside unit: terminal empty precedes independent readback and cleanup", async () => {
  const f = lifecycle(); await useOperator(f.ports);
  assert.deepEqual(f.events, ["preflight", "prepare", "capture", "run", "terminal", "readback", "scan", "release", "remove"]);
});
test("#1104 occupied/persist/config and every unknown/abort/timeout boundary retain files, no readback-before-terminal, one stop", async () => {
  for (const phase of ["preflight", "prepare", "capture", "run", "terminal", "readback", "scan", "release", "remove"]) {
    const f = lifecycle(phase);
    await assert.rejects(useOperator(f.ports), error => !error.message.includes("SECRET_CANARY") && /retain/.test(error.message));
    assert.equal(f.events.filter(n => n === "stopUnknown").length, ["run", "terminal", "readback", "scan", "release"].includes(phase) ? 1 : 0, phase);
    if (["preflight", "prepare", "capture", "run", "terminal"].includes(phase)) assert.ok(!f.events.includes("readback"));
    if (phase !== "remove") assert.ok(!f.events.includes("remove"));
  }
});
test("#1104 one observed Preview/201/same-ID History is required; open or unknown never succeeds", () => {
  const observation = recorded(); assert.throws(() => observation.result()); observation.close(); assert.equal(observation.result(), id);
  for (const changed of ["missing-history", "wrong-history", "unknown", "duplicate-confirm", "timeout"]) {
    const o = freshObservation();
    o.request(previewPath, "POST", { slotId: o.slot.slotId }, headers); o.response(previewPath, "POST", 200, previewBody(o));
    o.request(confirmPath, "POST", { slotId: o.slot.slotId, expectedStateToken: token }, headers);
    if (changed !== "timeout") o.response(confirmPath, "POST", 201, confirmBody(o));
    if (changed === "wrong-history") o.response(confirmPath, "GET", 200, { items: [], nextCursor: null });
    if (changed === "unknown") o.invalidate();
    if (changed === "duplicate-confirm") assert.throws(() => o.request(confirmPath, "POST", { slotId: o.slot.slotId, expectedStateToken: token }, headers));
    o.close(); assert.throws(() => o.result(), changed);
  }
});
test("#1104 no provider/Production/debug/foreign method/body/CSRF admission or replay after rejection", () => {
  for (const [path, method, body, hdr] of [
    ["/debug-login", "GET", null, {}], [confirmPath, "DELETE", null, headers],
    [confirmPath, "POST", {}, headers], [previewPath, "POST", { slotId: "other" }, headers],
    [previewPath, "POST", { slotId: "seed-slot-bookable" }, { ...headers, origin: "https://production.invalid" }],
    [previewPath, "POST", { slotId: "seed-slot-bookable" }, { ...headers, "x-csrf-token": "wrong" }],
    [previewPath, "POST", { slotId: "seed-slot-bookable" }, { ...headers, "sec-fetch-site": "cross-site" }],
  ]) {
    const o = freshObservation(); assert.throws(() => o.request(path, method, body, hdr));
    assert.throws(() => o.request("/student", "GET", null, {})); o.close(); assert.throws(() => o.result());
  }
});
function unitText(changes = {}) {
  const data = { LoadState: "loaded", ActiveState: "active", SubState: "running", Result: "success", InvocationID: "b".repeat(32),
    ControlGroup: group, MainPID: "42", ControlPID: "0", RuntimeMaxUSec: "30min", TimeoutStopUSec: "2s", KillMode: "control-group",
    Restart: "no", RemainAfterExit: "yes", NoNewPrivileges: "yes", ExecMainCode: "0", ExecMainStatus: "0", ...changes };
  return unitProperties.split(",").map(k => `${k}=${data[k]}`).join("\n") + "\n";
}
test("#1104 exact user manager identity / lifetime / exit; unit name or UID alone grants nothing", () => {
  const expected = { group, invocation: "b".repeat(32) };
  assert.equal(parseUnit(unitText(), expected).pid, 42);
  const terminal = { SubState: "exited", MainPID: "0", ExecMainCode: "1", ExecMainStatus: "0" };
  assert.equal(parseUnit(unitText(terminal), expected, true).pid, 0);
  for (const changes of [{ InvocationID: "c".repeat(32) }, { ControlGroup: "/system.slice/" + name }, { RuntimeMaxUSec: "infinity" },
    { NoNewPrivileges: "no" }, { KillMode: "process" }, { ControlPID: "44" }, { ...terminal, ExecMainCode: "2" }, { ...terminal, ExecMainStatus: "1" }])
    assert.throws(() => parseUnit(unitText(changes), expected, Boolean(changes.SubState)));
  assert.throws(() => userGroup(0, name)); assert.throws(() => parseUnit(unitText() + "MainPID=42\n", expected));
});
const statLine = (start = "7") => "42 (node) " + ["S", ...Array(18).fill("0"), start, "0"].join(" ") + "\n";
test("#1104 PID reuse/cgroup/owner/read uncertainty deny ownership", () => {
  let unit = group, uid = 1000, start = "7";
  const io = { uid: 1000, stat: () => ({ uid }), read: path => path.endsWith("/stat") ? statLine(start) : `0::${unit}\n` };
  const identity = procIdentity(42, group, io); assert.equal(identity.start, "7");
  start = "8"; assert.throws(() => sameProcess(identity, procIdentity(42, group, io)));
  unit = group + "/foreign"; assert.throws(() => procIdentity(42, group, io)); unit = group; uid = 1001;
  assert.throws(() => procIdentity(42, group, io));
  uid = 1000; let reads = 0;
  assert.throws(() => procIdentity(42, group, { ...io, read: path => path.endsWith("/stat") ? statLine(++reads === 1 ? "7" : "8") : `0::${group}\n` }));
  // CPU/accounting fields legitimately change; only stable birth identity may
  // distinguish PID reuse, never whole-stat byte equality.
  reads = 0;
  assert.equal(procIdentity(42, group, { ...io, read: path => path.endsWith("/stat") ? statLine().replace("S 0", `S ${++reads}`) : `0::${group}\n` }).start, "7");
});
test("#1104 GUI allowlist matches supplied WSLg sockets; never joins credential-free seed/Worker env", () => {
  const gui = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", PULSE_SERVER: "unix:/mnt/wslg/PulseServer" };
  const io = { uid: 1000, real: p => p === "/run/user/1000/wayland-0" ? "/mnt/wslg/runtime-dir/wayland-0" : p, stat: () => ({ isSocket: () => true }) };
  assert.deepEqual(guiEnvironment(gui, io), gui);
  for (const change of [{ DISPLAY: ":1" }, { XDG_RUNTIME_DIR: "/tmp/foreign" }, { TOKEN: "canary" }, { PULSE_SERVER: "tcp:remote" }])
    assert.throws(() => guiEnvironment({ ...gui, ...change }, io));
  assert.throws(() => guiEnvironment(gui, { ...io, stat: () => ({ isSocket: () => false }) }));
});
function workerFixture(options = {}) {
  let time = 0, started = false, live = false, stops = 0, owner = group;
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
  const listener = 'LISTEN 0 128 127.0.0.1:8789 0.0.0.0:* users:(("node",pid=42,fd=3))';
  const effects = {
    uid: 1000, setup: () => ({ env: cleanEnvironment("/owned"), confirm() {} }),
    spawn: () => { started = true; live = true; return child; },
    now: () => time, sleep: async () => { time += 100; },
    stat: () => ({ uid: 1000 }), read: path => path.endsWith("/stat") ? statLine(options.reused ? "8" : "7") : `0::${owner}\n`,
    alive: () => live, stop: () => { stops++; if (!options.unknownStop) { live = false; child.exitCode = 0; child.emit("exit"); } },
    async command(file, args) {
      if (file === "ps") return "42\n";
      if (!started) return options.occupied ? listener : "";
      if (!live) return "";
      if (args.includes("--cgroup")) return options.foreignListener ? listener + " cgroup:/foreign" : listener + ` cgroup:${group}`;
      return listener;
    },
  };
  return { port: createOperatorWorker({ certificate: {} }, name, effects), drift: () => { owner = group + "/other"; }, stops: () => stops };
}
test("#1104 new Worker Port: normal owned start/stop once; occupied/drift/filter/unknown retain and never retry", async () => {
  const good = workerFixture(); assert.equal(await good.port.start(), origin); assert.equal(good.port.isReady(), true);
  assert.deepEqual(await good.port.stop(), { stopped: true, portClosed: true }); assert.equal(good.stops(), 1);
  await assert.rejects(good.port.stop()); assert.equal(good.stops(), 1);
  const occupied = workerFixture({ occupied: true }); await assert.rejects(occupied.port.start()); assert.equal(occupied.stops(), 0);
  const drift = workerFixture(); await drift.port.start(); drift.drift(); await assert.rejects(drift.port.stop()); assert.equal(drift.stops(), 0);
  const foreign = workerFixture({ foreignListener: true }); await assert.rejects(foreign.port.start()); assert.equal(foreign.stops(), 0);
  const unknown = workerFixture({ unknownStop: true }); await unknown.port.start(); await assert.rejects(unknown.port.stop());
  await assert.rejects(unknown.port.stop()); assert.equal(unknown.stops(), 1);
});
test("#1104 cgroup empty requires kernel events plus all descendants, not absence of a visible PID", () => {
  const path = "/sys/fs/cgroup" + group;
  const io = { stat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), real: p => p,
    list: () => [], read: p => p.endsWith("cgroup.procs") ? "" : "populated 0\nfrozen 0\n" };
  emptyGroup(group, io);
  assert.throws(() => emptyGroup(group, { ...io, read: p => p.endsWith("cgroup.procs") ? "99\n" : "populated 0\n" }));
  assert.throws(() => emptyGroup(group, { ...io, read: () => "populated 1\n" }));
  assert.ok(path.startsWith("/sys/fs/cgroup/user.slice/"));
});
function browserFixture() {
  const context = new EventEmitter(), page = new EventEmitter(), frame = {};
  let routeHandler, jar = [], forwarded = 0, denied = 0, failed = 0, navigations = 0;
  const value = "a".repeat(42) + "A", observation = freshObservation();
  const expectedCsrf = createHash("sha256").update("student-csrf-v1:" + value).digest("base64url");
  const tick = () => new Promise(done => setTimeout(done, 0));
  const network = async (path, method = "GET", data = null, status = 200, responseBody, foreign = false) => {
    const url = (foreign ? "https://production.invalid" : origin) + path;
    const request = { url: () => url, redirectedFrom: () => null, frame: () => frame,
      isNavigationRequest: () => path === "/student", method: () => method, postData: () => data,
      postDataJSON: () => data, allHeaders: async () => ({ ...headers, "x-csrf-token": expectedCsrf }) };
    const response = { request: () => request, url: () => url, fromServiceWorker: () => false, status: () => status,
      allHeaders: async () => ({ "cache-control": "no-store", "content-type": "application/json" }), json: async () => responseBody };
    await routeHandler({ request: () => request, continue: async (...args) => {
      assert.equal(args.length, 0); forwarded++; page.emit("response", response);
      if (path === "/student") page.emit("framenavigated", frame);
    }, abort: async () => { denied++; } });
    await tick(); await tick(); return response;
  };
  frame.url = () => origin + "/student";
  page.mainFrame = () => frame;
  page.addInitScript = async fn => { assert.match(fn.toString(), /event.isTrusted/); };
  page.goto = async url => { assert.equal(url, origin + "/student"); navigations++; return network("/student"); };
  page.evaluate = async (_fn, values) => { assert.ok(values.includes(value)); return true; }; // DOM effects only, not a real trusted-click proof.
  page.locator = selector => ({
    textContent: async () => { assert.equal(selector, "#operation-status"); return "予約済みです。メールの配送完了を表すものではありません。"; },
    allTextContents: async () => { assert.equal(selector, "section ol li"); return [`${intervalLabel(observation.slot)}予約状態：予約済み欠席状態：なし現在の区分：標準`]; },
  });
  context.cookies = async () => jar;
  context.addCookies = async cookies => { assert.equal(navigations, 0); jar = cookies.map(c => ({ ...c, domain: "127.0.0.1", path: "/", expires: -1 })); };
  context.pages = () => [];
  context.route = async (_pattern, handler) => { routeHandler = handler; };
  context.routeWebSocket = async () => {};
  context.newPage = async () => { assert.equal(jar.length, 1); return page; };
  return { context, network, session: { cookie: () => ({ name: "__Host-student_session", value, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }) },
    observation, bad: () => { failed++; }, counts: () => ({ forwarded, denied, failed, navigations }) };
}
test("#1104 actual passive Browser adapter: Cookie before page, one navigation, unchanged route continue, human-only responses and final ID", async () => {
  const f = browserFixture(), observer = await observeHumanBrowser(f.context, f.session, month, f.bad);
  await f.network(previewPath, "POST", { slotId: f.observation.slot.slotId }, 200, previewBody(f.observation));
  await f.network(confirmPath, "POST", { slotId: f.observation.slot.slotId, expectedStateToken: token }, 201, confirmBody(f.observation));
  await f.network(confirmPath, "GET", null, 200, { items: [{ ...confirmBody(f.observation).reservation, attendanceState: "none" }], nextCursor: null });
  observer.closeAdmission(); assert.equal(await observer.finish(), id);
  assert.deepEqual(f.counts(), { forwarded: 4, denied: 0, failed: 0, navigations: 1 });
  await f.network(confirmPath); assert.equal(f.counts().denied, 1); await assert.rejects(observer.finish());
});
test("#1104 actual Browser adapter blocks remote/Production before connection; unknown never becomes a normal result", async () => {
  const f = browserFixture(), observer = await observeHumanBrowser(f.context, f.session, month, f.bad);
  await f.network("/api/me/reservations", "GET", null, 200, {}, true);
  assert.deepEqual(f.counts(), { forwarded: 1, denied: 1, failed: 1, navigations: 1 });
  observer.closeAdmission(); await assert.rejects(observer.finish());
});
test("#1104 all imports/non-opt-in CLI are inert, internal owner cannot run outside its attested unit", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./tests/evaluation/booking-operator.mjs'); await import('./tests/evaluation/booking-operator-child.mjs')"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  for (const args of [[], ["--run"], ["--run", "--head", "bad"], ["--private-owner", "a".repeat(40), "{}", name]]) {
    const denied = spawnSync(process.execPath, ["tests/evaluation/booking-operator.mjs", ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(denied.status, 1); assert.equal(denied.stdout, ""); assert.match(denied.stderr, /BOOKING_OPERATOR_UNKNOWN/);
  }
  const worker = readFileSync("tests/evaluation/trusted-booking-worker.mjs", "utf8");
  assert.match(worker, /system.slice/); assert.doesNotMatch(worker, /user.slice|booking-operator/);
  for (const file of ["src/index.ts", "tests/evaluation/worker.ts", ".github/workflows/product-ci.yml"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /booking-operator/);
});
