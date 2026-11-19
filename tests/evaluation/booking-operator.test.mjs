// Finite, secretless effects only. No GUI/WSLg/systemd/Worker/D1 startup.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { intervalLabel } from "../../src/web/model.ts";
import { errorResponse } from "../../src/http/application-error.ts";
import { readFileSync, mkdtempSync, readdirSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { spawnSync, spawn, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { useOperator, cleanEnvironment, verifyOperatorBuild, listenOperatorInput } from "./booking-operator.mjs";
import { openProgress, operatorProgressReport, parseProgress, progressPath, progressRecorder, readProgress } from "./booking-operator-progress.mjs";
import { diagnosePreparation, preparationReport } from "./booking-operator-diagnostic.mjs";
import { humanBookingObservation, observeHumanBrowser } from "./booking-operator-browser.mjs";
import { createOperatorWorker } from "./booking-operator-worker.mjs";
import { budget, userGroup, parseUnit, unitProperties, procIdentity, sameProcess, guiEnvironment, emptyGroup, unitDuration } from "./booking-operator-unit.mjs";
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
test("#1104 Browser unit lifetime consumes the controller remaining budget, never another fresh 30 minutes", () => {
  assert.equal(unitDuration("29min 58s"), 1798000000);
  assert.equal(parseUnit(unitText({ RuntimeMaxUSec: "24min 58s" }), { group, runtimeSeconds: 1498 }).pid, 42);
  assert.throws(() => parseUnit(unitText(), { group, runtimeSeconds: 1498 }));
  for (const value of ["infinity", "30min extra", "1min 1min", "1.5s", "-1s", "30000000000000000000000000h"])
    assert.throws(() => unitDuration(value));
  const source = readFileSync("tests/evaluation/booking-operator.mjs", "utf8");
  assert.match(source, /Math.floor\(\(remaining\(\) - 2000\) \/ 1000\)/);
  assert.match(source, /RuntimeMaxSec=\$\{runtimeSeconds\}s/);
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
function workerFixture(options = {}, stage) {
  let time = 0, started = false, live = false, stops = 0, owner = group;
  const launches = [], pgidQueries = [];
  const certificate = { key: "/owned/browser-home/server.key", cert: "/owned/browser-home/server.pem" };
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
  const listener = 'LISTEN 0 128 127.0.0.1:8789 0.0.0.0:* users:(("node",pid=42,fd=3))';
  const effects = {
    uid: 1000, setup: () => ({ env: cleanEnvironment("/owned"), confirm() {} }),
    spawn: (...args) => { launches.push(args); started = true; live = true; return child; },
    now: () => time, sleep: async () => { time += 100; },
    stat: () => ({ uid: 1000 }), read: path => path.endsWith("/stat") ? statLine(options.reused ? "8" : "7") : `0::${owner}\n`,
    alive: pid => { assert.equal(pid, child.pid); return live; }, stop: pid => { assert.equal(pid, child.pid); stops++; if (!options.unknownStop) { live = false; child.exitCode = 0; child.emit("exit"); } },
    async command(file, args) {
      if (file === "ps") { pgidQueries.push(args); return options.wrongPgid ? "43\n" : "42\n"; }
      if (!started) return options.occupied ? listener : "";
      if (!live) return "";
      if (args.includes("--cgroup")) return options.foreignListener ? listener + " cgroup:/foreign" : listener + ` cgroup:${group}`;
      return listener;
    },
  };
  return { port: createOperatorWorker({ certificate }, name, effects, stage), launches, pgidQueries, drift: () => { owner = group + "/other"; }, stops: () => stops };
}
test("#1104 new Worker Port: normal owned start/stop once; occupied/drift/filter/unknown retain and never retry", async () => {
  const good = workerFixture(); assert.equal(await good.port.start(), origin); assert.equal(good.port.isReady(), true);
  assert.deepEqual(good.launches, [[process.execPath, [
    resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--config", "tests/evaluation/wrangler.reservation.jsonc",
    "--ip", "127.0.0.1", "--port", "8789", "--local-protocol", "https", "--persist-to", ".wrangler/student-booking-evaluation",
    "--https-key-path", "/owned/browser-home/server.key", "--https-cert-path", "/owned/browser-home/server.pem",
  ], { cwd: resolve("."), env: cleanEnvironment("/owned"), detached: true, stdio: "ignore" }]]);
  assert.deepEqual(await good.port.stop(), { stopped: true, portClosed: true }); assert.equal(good.stops(), 1);
  await assert.rejects(good.port.stop()); assert.equal(good.stops(), 1);
  assert.deepEqual(good.pgidQueries, Array.from({ length: 4 }, () => ["-o", "pgid=", "-p", "42"]));
  const wrongPgid = workerFixture({ wrongPgid: true }); await assert.rejects(wrongPgid.port.start());
  await assert.rejects(wrongPgid.port.stop()); await assert.rejects(wrongPgid.port.start());
  assert.equal(wrongPgid.launches.length, 1); assert.equal(wrongPgid.stops(), 0);
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
function browserFixture(fixtureMonth = month, onNavigate) {
  const context = new EventEmitter(), page = new EventEmitter(), frame = {};
  let routeHandler, jar = [], forwarded = 0, denied = 0, failed = 0, navigations = 0;
  const value = "a".repeat(42) + "A", observation = humanBookingObservation(fixtureMonth, csrf);
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
  page.goto = async url => { assert.equal(url, origin + "/student"); navigations++; const response = await network("/student"); await onNavigate?.(network); return response; };
  page.waitForFunction = async (fn, arg, { timeout }) => {
    assert.equal(arg, undefined); assert.equal(timeout, 5000);
    assert.equal(runInNewContext(`(${fn})()`, { document: { querySelector: selector => ({
      "#schedule-status": { textContent: "予定を取得しました。" },
      "#daily-content button.slot.bookable": {},
      "#history-status": { textContent: "本人履歴を取得しました。" },
    })[selector] } }), true);
  };
  page.evaluate = async (_fn, values) => { assert.ok(values.includes(value)); return true; }; // DOM effects only, not a real trusted-click proof.
  page.locator = selector => ({
    textContent: async () => { assert.equal(selector, "#operation-status"); return "予約済みです。メールの配送完了を表すものではありません。"; },
    allTextContents: async () => { assert.equal(selector, "#history-content li"); return [`${intervalLabel(observation.slot)}予約状態：予約済み欠席状態：なし現在の区分：標準`]; },
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
const scheduleMonth = value => `/api/me/schedule-months/${value}`;
const unavailableMonth = () => errorResponse("SCHEDULE_MONTH_NOT_AVAILABLE").json();
test("#1158 TC-F-001-03: passive Browser adapter accepts initial December 404, January 200 and one booking with same-ID History", async () => {
  const fixtureMonth = "2027-01";
  const f = browserFixture(fixtureMonth), observer = await observeHumanBrowser(f.context, f.session, fixtureMonth, f.bad);
  let releaseInitialBody;
  const initialBodyPending = new Promise(resolve => { releaseInitialBody = resolve; });
  await f.network(scheduleMonth("2026-12"), "GET", null, 404, initialBodyPending);
  await f.network(scheduleMonth(fixtureMonth), "GET", null, 200, {
    month: fixtureMonth, slots: [{ ...f.observation.slot, view: "bookable" }],
  });
  releaseInitialBody(await unavailableMonth());
  await f.network(previewPath, "POST", { slotId: f.observation.slot.slotId }, 200, previewBody(f.observation));
  let releaseConfirmBody;
  const confirmBodyPending = new Promise(resolve => { releaseConfirmBody = resolve; });
  await f.network(confirmPath, "POST", { slotId: f.observation.slot.slotId, expectedStateToken: token }, 201, confirmBodyPending);
  await f.network(confirmPath, "GET", null, 200, { items: [{ ...confirmBody(f.observation).reservation, attendanceState: "none" }], nextCursor: null });
  releaseConfirmBody(confirmBody(f.observation));
  observer.closeAdmission(); assert.equal(await observer.finish(), id);
  assert.deepEqual(f.counts(), { forwarded: 6, denied: 0, failed: 0, navigations: 1 });
  await f.network(confirmPath); assert.equal(f.counts().denied, 1); await assert.rejects(observer.finish());
});
test("#1158 passive Browser adapter rejects other failures, malformed responses and subsequent 404s", async () => {
  const initialPath = scheduleMonth("2026-10");
  const initialError = await unavailableMonth();
  for (const [label, path, method, status, body, prior] of [
    ["wrong month", scheduleMonth(month), "GET", 404, initialError],
    ["wrong path", confirmPath, "GET", 404, initialError],
    ["wrong method", initialPath, "HEAD", 404, initialError],
    ["wrong code", initialPath, "GET", 404, await errorResponse("INVALID_REQUEST").json()],
    ["invalid body", initialPath, "GET", 404, null],
    ["missing message", initialPath, "GET", 404, { error: { code: initialError.error.code, retry: "none" } }],
    ["wrong retry", initialPath, "GET", 404, { error: { ...initialError.error, retry: "reload" } }],
    ["repeat 404", initialPath, "GET", 404, initialError, [initialPath, 404, initialError]],
    ["navigation after 200", initialPath, "GET", 404, initialError, [scheduleMonth(month), 200, { month, slots: [] }]],
    ...[401, 403, 503].map(status => [String(status), initialPath, "GET", status, initialError]),
  ]) {
    const f = browserFixture(), observer = await observeHumanBrowser(f.context, f.session, month, f.bad);
    if (prior) {
      const [priorPath, priorStatus, priorBody] = prior;
      await f.network(priorPath, "GET", null, priorStatus, priorBody);
      assert.equal(f.counts().failed, 0, label);
    }
    await f.network(path, method, null, status, body);
    assert.equal(f.counts().failed, 1, label);
    observer.closeAdmission();
    await assert.rejects(observer.finish(), undefined, label);
  }
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
  for (const args of [[], ["--run"], ["--run", "--head", "bad"], ["--diagnose-d1", "--head", "bad"], ["--diagnose-operator", "--head", "bad"], ["--private-diagnostic-owner", "a".repeat(40), "null", name], ["--private-owner", "a".repeat(40), "{}", name]]) {
    const denied = spawnSync(process.execPath, ["tests/evaluation/booking-operator.mjs", ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(denied.status, 1); assert.equal(denied.stdout, ""); assert.match(denied.stderr, /BOOKING_OPERATOR_UNKNOWN/);
  }
  const worker = readFileSync("tests/evaluation/trusted-booking-worker.mjs", "utf8");
  assert.match(worker, /system.slice/); assert.doesNotMatch(worker, /user.slice|booking-operator/);
  for (const file of ["src/index.ts", "tests/evaluation/worker.ts", ".github/workflows/product-ci.yml"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /booking-operator/);
});

// #1106 uses the actual compiler in the existing Linux Unit job, and the actual
// seed function's empty-home gate with all DB writes stopped at the first mkdir.
function seedEmptyGate(env) {
  const source = readFileSync("tests/evaluation/trusted-booking-seed.mjs", "utf8");
  const fn = source.slice(source.indexOf("export async function prepareTrustedBooking("), source.indexOf("// Separate read-only proxy;"));
  let writes = 0;
  const prepare = runInNewContext(`(${fn.replace("export ", "")})`, {
    process: { env }, preflight: async () => {}, present: () => false, persistence: "/finite/persist", root: "/finite", resolve,
    readdirSync, check: ok => { if (!ok) throw Error("finite-rejected"); }, failure: () => Error("TRUSTED_BOOKING_SEED_FAILED"),
    mkdirSync: () => { writes++; throw Error("finite-stop-before-write"); },
  });
  return { prepare, writes: () => writes };
}

test("#1106 actual compiler leaves the same seed home empty; cache suppression is compiler-local", async t => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-finite-build-"));
  t.after(() => rmSync(temporary, { recursive: true }));
  const env = cleanEnvironment(temporary), before = { ...env }, parentCache = process.env.NODE_DISABLE_COMPILE_CACHE;
  let calls = 0;
  const command = promisify(execFile);
  const evidence = await verifyOperatorBuild(env, async (file, args, options) => {
    calls++;
    assert.equal(file, process.execPath);
    assert.deepEqual(args.slice(0, 4), [join(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", "src/web/tsconfig.json", "--outDir"]);
    assert.equal(resolve(args[4], ".."), temporary);
    assert.deepEqual(options, { cwd: process.cwd(), env: { ...env, NODE_DISABLE_COMPILE_CACHE: "1" }, timeout: 60000, maxBuffer: 65536 });
    return command(file, args, options);
  });
  assert.equal(calls, 1); assert.equal(Object.keys(evidence.build).length, 6);
  assert.deepEqual(env, before); assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, parentCache);
  assert.deepEqual(readdirSync(temporary), []);
  const gate = seedEmptyGate(env);
  await assert.rejects(gate.prepare(() => assert.fail("no seed handoff")), /TRUSTED_BOOKING_SEED_FAILED/);
  assert.equal(gate.writes(), 1); // Passed empty gate; first mkdir was intercepted before mutation.
  mkdirSync(join(temporary, "node-compile-cache"));
  const occupied = seedEmptyGate(env);
  await assert.rejects(occupied.prepare(() => assert.fail("no seed handoff")), /TRUSTED_BOOKING_SEED_FAILED/);
  assert.equal(occupied.writes(), 0); // Existing cache is still refused, never adopted/deleted.
});

test("#1106 compiler failure or byte mismatch retains the build and prevents seed", async t => {
  for (const mode of ["compiler-failure", "byte-mismatch"]) {
    const temporary = mkdtempSync(join(tmpdir(), "nssscdl-finite-build-"));
    t.after(() => rmSync(temporary, { recursive: true }));
    let seeded = false, calls = 0;
    await assert.rejects(useOperator({
      preflight: () => verifyOperatorBuild(cleanEnvironment(temporary), async (_file, args) => {
        calls++;
        if (mode === "compiler-failure") throw Error("finite-compiler-canary");
        for (const file of ["student.js", "view.js", "controller.js", "model.js"]) writeFileSync(join(args[4], file), "finite mismatch");
      }),
      prepare: () => { seeded = true; },
    }), error => /retain/.test(error.message) && !error.message.includes("finite-compiler-canary"));
    assert.equal(calls, 1); assert.equal(seeded, false);
    assert.equal(readdirSync(temporary).length, 1);
    assert.ok(readdirSync(temporary)[0].startsWith("nssscdl-operator-build-"));
  }
});

async function finiteNode(code, input) {
  // The bounded child is only a Node fixture: never the opt-in Operator/systemd.
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  const completed = new Promise((done, bad) => { child.once("error", bad); child.once("close", (status, signal) => done({ status, signal, stdout, stderr })); });
  if (input !== undefined) child.stdin.end(input);
  return completed; // Default deliberately leaves the parent input pipe open.
}
const operatorUrl = pathToFileURL(resolve("tests/evaluation/booking-operator.mjs")).href;

async function finiteOwner(diagnostic) {
  return finiteNode(`
    import { readFileSync } from 'node:fs'; import { randomBytes } from 'node:crypto'; import { dirname, join } from 'node:path';
    const { diagnosePreparation } = await import(new URL('./booking-operator-diagnostic.mjs', ${JSON.stringify(operatorUrl)}));
    import { runInNewContext } from 'node:vm'; import { useOperator, listenOperatorInput } from ${JSON.stringify(operatorUrl)};
    const all = readFileSync('tests/evaluation/booking-operator.mjs', 'utf8');
    const source = all.slice(all.indexOf('async function owner('), all.indexOf('\\nif (process.argv[1]'));
    const diagnostic = ${diagnostic};
    const env = { TMPDIR: '/finite/home' }; let seedCalls = 0, commands = 0, captures = 0;
    let observations = '';
    const phases = ["storage-owner", "migration-cli", "repreflight-owner", "wrangler-import", "proxy-start",
      "binding", "history", "seed", "baseline", "dispose"];
    const versions = { wrangler: '4.146.0', 'playwright-core': '1.64.0', typescript: '6.0.3' };
    const fixtureProcess = new Proxy(process, { get: (p, key) => key === 'platform' ? 'linux' : key === 'getuid' ? () => 1000 : key === 'env' ? env : Reflect.get(p, key) });
    const owner = runInNewContext('(' + source + ')', { process: fixtureProcess, performance, console, randomBytes, join, useOperator, listenOperatorInput,
      root: '/finite', dirname, diagnosePreparation, directStage: (_name, action) => action(), appendFileSync: (_file, line) => { observations += line; },
      mkdirSync: path => { if (path !== '/finite/home/browser-home') throw Error('unexpected-mkdir'); captures++; },
      verifyStudentAssets() {}, migrations() {}, verifyOperatorBuild: async () => ({}), budget: { total: 1800000, prepare: 300000 }, demand: ok => { if (!ok) throw Error('finite-private-failure'); },
      fail: () => Error('finite-private-failure'), userGroup: () => '/finite/group', guiEnvironment: g => g,
      readFileSync: p => p === '/proc/self/cgroup' ? '0::/finite/group\\n' : p === '/proc/1/comm' ? 'systemd\\n' : p === '/sys/fs/cgroup/cgroup.controllers' ? 'cpu\\n' :
        p.includes('package') ? JSON.stringify({ version: versions[p.split('/').at(-2)],
          devDependencies: versions, packages: Object.fromEntries(Object.entries(versions).map(([k, version]) => ['node_modules/' + k, { version }])) }) : '{}',
      lstatSync: p => p === '/finite/observations' ? { mode: 0o600, isFile: () => true, uid: 1000, nlink: 1, size: 0 } :
        { mode: 0o40700, isFile: () => true }, realpathSync: p => p, present: () => false,
      readdirSync: p => !diagnostic && p === env.TMPDIR ? ['node-compile-cache'] : [],
      supply: { checkBookingEnvironment() {}, directoryIdentity: () => ({}), proxyOptions: { configPath: '/finite/config' }, persistence: '/finite/persist',
        checkDirectoryIdentity() {}, checkOwnedTree() {},
        async prepareTrustedBooking(consume, _entered, stage) {
          seedCalls++;
          for (const name of phases) await stage(name, () => {});
          await stage('handoff-capture', () => consume('FINITE_SECRET_SEED', {}));
        } },
      exec: async (file, args) => { if (!['git', 'ss'].includes(file)) throw Error('unexpected-command'); commands++; return { stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : '' }; } });
    try { await owner('a'.repeat(40), {}, diagnostic); } catch { process.exitCode = 1; }
    if (diagnostic) console.log(JSON.stringify({ observations, captures }));
    console.log(JSON.stringify({ seedCalls, commands, paused: process.stdin.isPaused(), sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') }));
  `);
}

test("#1106 actual owner preparation rejection releases stdin without waiting for parent EOF", async () => {
  const result = await finiteOwner(false);
  assert.equal(result.signal, null); assert.equal(result.status, 1); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { seedCalls: 0, commands: 2, paused: true, sigint: 0, sigterm: 0 });
});

test("#1160 actual owner ends at capture without entering any Browser or Worker command", async () => {
  const result = await finiteOwner(true);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /FINITE_SECRET_SEED/);
  const [trace, counts] = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(trace.captures, 1);
  assert.equal(preparationReport(trace.observations, true).result, "NOT_REPRODUCED");
  assert.deepEqual(counts, { seedCalls: 1, commands: 4, paused: true, sigint: 0, sigterm: 0 });
});

function bridgeCliFixture(mode) {
  const success = 'let input=""; process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end",()=>{ if (input !== "操作終了\\n") { process.exitCode=1; return; } console.log(JSON.stringify({finite:"unchanged-success"})); })';
  return `
    import { readFileSync } from 'node:fs'; import { randomBytes } from 'node:crypto'; import { join, resolve } from 'node:path';
    import { spawn } from 'node:child_process'; import { runInNewContext } from 'node:vm';
    import { cleanEnvironment, bridgeOperator } from ${JSON.stringify(operatorUrl)};
    const script = resolve('tests/evaluation/booking-operator.mjs'), all = readFileSync(script, 'utf8'); let starts = 0;
    const mode = ${JSON.stringify(mode)}, diagnostic = mode === 'diagnostic', progressMode = mode === 'progress';
    const { progressRecorder, operatorProgressReport, progressPath } = await import(new URL('./booking-operator-progress.mjs', ${JSON.stringify(operatorUrl)}));
    let controllerTrace = '';
    const { preparationReport } = await import(new URL('./booking-operator-diagnostic.mjs', ${JSON.stringify(operatorUrl)}));
    const report = 'completed operator-preflight\\ncompleted storage-owner\\nfailed migration-cli\\n';
    const fixtureProcess = new Proxy(process, { get: (p, key) => key === 'platform' ? 'linux' : key === 'getuid' ? () => 1000 :
      key === 'stdin' ? { isTTY: true } : key === 'env' ? {} : key === 'argv' ? ['node', script, diagnostic ? '--diagnose-d1' : progressMode ? '--diagnose-operator' : '--run', '--head', 'a'.repeat(40)] : Reflect.get(p, key) });
    const cli = runInNewContext('(async () => {' + all.slice(all.indexOf('if (process.argv[1]')) + '})', {
      process: fixtureProcess, console, script, resolve, join, randomBytes, root: process.cwd(), cleanEnvironment, bridgeOperator,
      demand: ok => { if (!ok) throw Error('finite-private-failure'); },
      guiEnvironment: () => { if (diagnostic) throw Error('unexpected-gui'); return {}; },
      mkdirSync() {}, writeFileSync() {}, preparationReport, operatorProgressReport, progressPath,
      openProgress: (_directory, role) => ({ ...progressRecorder(role, line => { controllerTrace += line; }), close() {} }),
      readProgress: (_directory, role) => role === 'controller' ? controllerTrace : role === 'owner' ?
        'start controller-entry\\n' : 'FINITE_SECRET_CORRUPTION\\n',
      readFileSync: () => report, lstatSync: () => ({ size: report.length, isFile: () => true, uid: 1000, nlink: 1 }),
      tmpdir: () => '/finite', mkdtempSync: () => '/finite/home',
      spawn: (file, args, options) => {
        if (++starts !== 1 || file !== 'systemd-run' || options.stdio.join(',') !== (diagnostic || progressMode ? 'pipe,ignore,ignore' : 'pipe,pipe,ignore') ||
            !args.includes(diagnostic ? '--private-diagnostic-owner' : progressMode ? '--private-progress-owner' : '--private-owner')) throw Error('unexpected-start');
        const code = diagnostic || progressMode ? 'process.stdout.write("FINITE_SECRET_STDOUT"); process.stderr.write("FINITE_SECRET_STDERR"); process.kill(process.pid,"SIGTERM")' :
          mode === 'success' ? ${JSON.stringify(success)} :
          mode === 'signal' ? 'process.stdin.resume()' : mode === 'eof' ? 'process.stdin.resume(); process.stdin.on("end",()=>{process.exitCode=1})' :
          mode === 'signal-exit' ? 'process.kill(process.pid,"SIGTERM")' :
          'process.stderr.write("FINITE_SECRET_STDERR_CANARY"); process.exitCode=1';
        const child = mode === 'spawn-error' ? spawn(process.execPath + '-finite-absent', [], { stdio: options.stdio }) : spawn(process.execPath, ['-e', code], { stdio: options.stdio });
        if (mode === 'signal') setImmediate(() => { process.emit('SIGINT'); process.emit('SIGTERM'); });
        return child;
      } });
    await cli();
    if (starts !== 1) throw Error('unexpected-call-count');
    if (!process.stdin.isPaused() || process.listenerCount('SIGINT') || process.listenerCount('SIGTERM')) throw Error('finite-input-not-released');
  `;
}

test("#1106 actual outer CLI: failure/spawn error/signal/EOF notify once, suppress raw stderr, and never wait for parent EOF", async () => {
  for (const mode of ["exit1", "spawn-error", "signal", "signal-exit", "eof"]) {
    const result = await finiteNode(bridgeCliFixture(mode), mode === "eof" ? "" : undefined);
    assert.equal(result.signal, null, mode); assert.equal(result.status, 1, mode); assert.equal(result.stdout, "", mode);
    assert.equal(result.stderr, "BOOKING_OPERATOR_UNKNOWN; owned resources retained; do not retry\n", mode);
  }
});

test("#1106 actual outer CLI preserves success output and finite signal/EOF listener disposal", async () => {
  const result = await finiteNode(bridgeCliFixture("success"), "操作終了\n");
  assert.equal(result.signal, null); assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.equal(result.stdout, '{"finite":"unchanged-success"}\n');
});

test("#1160 outer CLI suppresses raw child output and reports an abnormal unit exit as UNKNOWN", async () => {
  const result = await finiteNode(bridgeCliFixture("diagnostic"));
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /FINITE_SECRET/);
  assert.deepEqual(JSON.parse(result.stdout), {
    result: "UNKNOWN", firstFailure: "migration-cli", lastCompleted: "storage-owner", dispose: "UNKNOWN",
  });
});

test("#1160 shared preparation identifies each failing stage and disposes an acquired proxy once", async () => {
  const source = readFileSync("tests/evaluation/trusted-booking-seed.mjs", "utf8");
  const body = source.slice(source.indexOf("export async function useBookingSeedProxy"), source.indexOf("// Separate read-only proxy;"))
    .replaceAll("export ", "").replace('() => import("wrangler")', "loadWrangler");
  const phases = ["operator-preflight", "storage-owner", "migration-cli", "repreflight-owner", "wrangler-import",
    "proxy-start", "binding", "history", "seed", "baseline", "dispose", "handoff-capture"];
  for (const fault of [...phases, "none", "history+dispose", "interrupted", "missing"]) {
    const attempts = [];
    let observations = "", interrupted = false, captures = 0;
    const check = ok => { if (!ok) throw Error("FINITE_SECRET_CANARY"); };
    const owned = new WeakMap();
    const prepare = runInNewContext(`${body}\nprepareTrustedBooking`, {
      check, failure: () => Error("FINITE_SECRET_CANARY"), preflight: async () => {},
      isBookingWranglerEntry: () => true, bookingWranglerEntry: "/finite/node_modules/wrangler/bin/wrangler.js",
      process: { execPath: process.execPath, env: { TMPDIR: "/finite/home" } }, resolve, root: "/finite", persistence: "/finite/persist",
      present: () => false, readdirSync: () => [], mkdirSync() {}, directoryIdentity: () => ({}),
      owned, checkOwned: handle => owned.get(handle), proxyOptions: { configPath: "/finite/config" }, exec: async () => {},
      loadWrangler: async () => ({ getPlatformProxy: async () => ({ env: {}, dispose: async () => {} }) }),
      bookingD1: () => ({ prepare: () => ({ all: async () => ({ success: true, results: [{ name: "migration" }] }) }), withSession() {} }),
      migrations: () => ["migration"], validation() {}, seedTrustedStudents: async () => "FINITE_SECRET_CANARY",
      captureBookingBaseline: async () => "FINITE_SECRET_CANARY",
    });
    const first = fault === "history+dispose" ? "history" : fault;
    await diagnosePreparation({
      preflight() { if (first === "operator-preflight") check(false); }, interrupted: () => interrupted,
      capture(seed) { assert.equal(seed, "FINITE_SECRET_CANARY"); captures++; },
      prepare: (consume, stage) => prepare(consume, undefined, (name, action) => {
        attempts.push(name);
        return stage(name, () => {
          if (name === first || (name === "dispose" && fault === "history+dispose")) check(false);
          return action();
        });
      }),
    }, (event, name) => {
      if (name === "migration-cli" && fault === "missing") throw Error("FINITE_SECRET_CANARY");
      observations += name ? `${event} ${name}\n` : `${event}\n`;
      if (name === "proxy-start" && fault === "interrupted") interrupted = true;
    });
    const result = preparationReport(observations, true);
    assert.doesNotMatch(JSON.stringify(result) + observations, /FINITE_SECRET_CANARY/);
    if (["interrupted", "missing"].includes(fault)) {
      assert.equal(result.result, "UNKNOWN", fault);
      assert.equal(captures, 0, fault);
      if (fault === "interrupted") assert.equal(result.dispose, "completed");
    } else if (fault === "none") {
      assert.deepEqual(result, { result: "NOT_REPRODUCED", firstFailure: "none", lastCompleted: "handoff-capture", dispose: "completed" });
      assert.equal(captures, 1);
    } else {
      const index = phases.indexOf(first);
      const cleanup = index >= phases.indexOf("binding") && index <= phases.indexOf("baseline");
      assert.deepEqual(result, { result: "FAILED", firstFailure: first,
        lastCompleted: cleanup && fault !== "history+dispose" ? "dispose" : phases[index - 1] ?? "none",
        dispose: fault === "history+dispose" || first === "dispose" ? "failed" :
          cleanup || first === "handoff-capture" ? "completed" : "not-started" }, fault);
      assert.equal(captures, 0, fault);
    }
    assert.equal(new Set(attempts).size, attempts.length, fault);
    assert.equal(preparationReport(observations, false).result, "UNKNOWN", fault);
  }
});

const ownerPhases = ["controller-entry", "operator-preflight", "storage-owner", "migration-cli", "repreflight-owner",
  "wrangler-import", "proxy-start", "binding", "history", "seed", "baseline", "dispose", "handoff-capture",
  "child-admission", "child-start", "child-attestation", "packet-send", "unit-terminal", "unit-stop"];
const childPhases = ["child-entry", "packet-accept", "certificate", "nss", "listen-8788", "playwright-import",
  "headless-launch", "headless-owner", "headless-context", "trusted-tls", "trusted-page-close",
  "san-tls", "san-page-close", "untrusted-tls", "untrusted-page-close", "headless-recheck", "headless-close",
  "headless-generated", "proof-close", "release-8788", "worker-preflight", "worker-spawn", "worker-process",
  "worker-listener", "headful-launch", "headful-owner", "headful-context", "initial-display", "worker-stop",
  "headful-recheck", "headful-close", "headful-generated", "ports-closed"];
const fixtureJournal = (role, phases) => {
  let text = "";
  const record = progressRecorder(role, line => { text += line; });
  for (const name of phases) record.stage(name, () => {});
  record.end();
  return text;
};
const completedRun = () => ({
  controller: fixtureJournal("controller", ["controller-start"]),
  owner: fixtureJournal("owner", ownerPhases),
  child: fixtureJournal("child", childPhases),
});

test("#1164 diagnostic POST is denied before navigation finishes and after display admission closes", async () => {
  const injected = async network => {
    await network(previewPath, "POST", { slotId: "seed-slot-bookable" });
    await network(confirmPath, "POST", { slotId: "seed-slot-bookable", expectedStateToken: token });
  };
  const during = browserFixture(month, injected);
  await observeHumanBrowser(during.context, during.session, month, during.bad, true);
  assert.deepEqual(during.counts(), { forwarded: 1, denied: 2, failed: 2, navigations: 1 });
  const normalDisplay = browserFixture();
  const view = await observeHumanBrowser(normalDisplay.context, normalDisplay.session, month, normalDisplay.bad, true);
  assert.deepEqual(normalDisplay.counts(), { forwarded: 1, denied: 0, failed: 0, navigations: 1 });
  await injected(normalDisplay.network);
  await normalDisplay.network(confirmPath);
  assert.deepEqual(normalDisplay.counts(), { forwarded: 1, denied: 3, failed: 3, navigations: 1 });
  await assert.rejects(view.finish()); // Display never satisfies the normal one-booking proof.
});

test("#1164 process vs listener ownership and absent/unknown stop remain distinct", async () => {
  for (const [options, phase, stopCalls] of [
    [{ occupied: true }, "worker-preflight", 0],
    [{ wrongPgid: true }, "worker-process", 0],
    [{ foreignListener: true }, "worker-listener", 0],
    [{ unknownStop: true }, "worker-stop", 1],
  ]) {
    let trace = "";
    const record = progressRecorder("child", line => { trace += line; });
    for (const earlier of childPhases.slice(0, childPhases.indexOf("worker-preflight"))) record.stage(earlier, () => {});
    const f = workerFixture(options, record.stage);
    if (phase === "worker-stop") {
      assert.equal(await f.port.start(), origin);
      for (const phase of ["headful-launch", "headful-owner", "headful-context", "initial-display"]) record.stage(phase, () => {});
    }
    else await assert.rejects(f.port.start());
    if (f.port.hasChild()) await assert.rejects(record.stage("worker-stop", () => f.port.stop()));
    record.end();
    const outcome = parseProgress("child", trace);
    assert.equal(outcome.ended, true);
    assert.equal(phase === "worker-stop" ? outcome.firstCleanupFailure : outcome.firstFailure, phase);
    assert.equal(f.stops(), stopCalls);
  }
});

test("#1164 every fixed phase records the previous completion and distinct cleanup failures", async () => {
  for (const [role, phases] of [["owner", ownerPhases], ["child", childPhases]]) {
    for (const [position, failing] of phases.entries()) {
      let text = "";
      const record = progressRecorder(role, line => { text += line; });
      for (const earlier of phases.slice(0, position)) record.stage(earlier, () => {});
      await assert.rejects(record.stage(failing, async () => { throw Error("FINITE_SECRET_EXCEPTION"); }));
      record.end();
      const outcome = parseProgress(role, text);
      const cleanup = /^(dispose|unit-terminal|unit-stop|worker-stop|proof-close|release-8788|ports-closed)$|-(page-close|recheck|close|generated)$/.test(failing);
      assert.equal(outcome[cleanup ? "firstCleanupFailure" : "firstFailure"], failing);
      assert.equal(outcome.lastCompleted, phases[position - 1] ?? "none");
      assert.equal(outcome.ended, true);
      assert.equal(outcome.complete, false);
      assert.doesNotMatch(text, /FINITE_SECRET/);
    }
  }
  const run = completedRun();
  assert.equal(operatorProgressReport(run, true).result, "NOT_REPRODUCED");
  run.child = fixtureJournal("child", childPhases.slice(0, childPhases.indexOf("san-tls"))).slice(0, -4) +
    "start san-tls\nfail san-tls\nstart san-page-close\nfail san-page-close\nstart headless-recheck\nok headless-recheck\nend\n";
  const failure = operatorProgressReport(run, true);
  assert.equal(failure.result, "FAILED");
  assert.equal(failure.firstFailure, "san-tls");
  assert.equal(failure.firstCleanupFailure, "san-page-close");
  assert.equal(failure.child.lastCompleted, "headless-recheck");
});

test("#1164 absent, malformed, early and abnormal evidence remains UNKNOWN with its valid prefix", () => {
  const run = completedRun();
  assert.equal(operatorProgressReport(run, false).result, "UNKNOWN");
  for (const child of ["", "end\n", "start child-entry\nok child-entry\nend\n",
    "start child-entry\nok child-entry\nstart packet-accept\nFINITE_SECRET_CORRUPTION\nend\n",
    run.child + "FINITE_SECRET_TRAILER", run.child + " ".repeat(4096)]) {
    const result = operatorProgressReport({ ...run, child }, true);
    assert.equal(result.result, "UNKNOWN");
    assert.doesNotMatch(JSON.stringify(result), /FINITE_SECRET/);
  }
  let text = "";
  const lost = progressRecorder("child", line => {
    if (line.startsWith("ok ")) throw Error("FINITE_SECRET_DISK");
    text += line;
  });
  lost.stage("child-entry", () => {});
  assert.throws(() => lost.stage("packet-accept", () => assert.fail("must stop before next operation")));
  lost.end();
  assert.equal(text, "start child-entry\n");
});

test("#1164 killed finite Node writer leaves run-private phase evidence and rejects symlink evidence", async t => {
  const directory = mkdtempSync(join(tmpdir(), "operator-progress-finite-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const progressUrl = new URL("./booking-operator-progress.mjs", import.meta.url).href;
  writeFileSync(progressPath(directory, "child"), "", { mode: 0o600, flag: "wx" });
  const result = await finiteNode(`
    import { openProgress } from ${JSON.stringify(progressUrl)};
    const progress = openProgress(${JSON.stringify(directory)}, "child");
    progress.stage("child-entry", () => {});
    progress.stage("packet-accept", () => {});
    progress.stage("certificate", () => process.kill(process.pid, "SIGKILL"));
  `);
  assert.equal(result.signal, "SIGKILL");
  const run = completedRun();
  run.child = readProgress(directory, "child");
  const report = operatorProgressReport(run, true);
  assert.equal(report.result, "UNKNOWN");
  assert.deepEqual(report.child, { lastCompleted: "packet-accept", active: "certificate" });
  symlinkSync(progressPath(directory, "child"), progressPath(directory, "owner"));
  assert.equal(readProgress(directory, "owner"), "");
  assert.throws(() => openProgress(directory, "owner"));
});

async function finiteDiagnosticChild(failures = [], early = false) {
  const source = readFileSync("tests/evaluation/booking-operator-child.mjs", "utf8");
  const body = source.slice(source.indexOf("export async function runOperatorChild"), source.indexOf("\nif (process.argv[1]"))
    .replace("export async function", "async function").replace('import("playwright-core")', "loadPlaywright()");
  const lines = new EventEmitter(), processPort = new EventEmitter();
  const messages = [], calls = [];
  let text = "", serverRequest, stopped = false;
  const record = progressRecorder("child", line => { text += line; });
  const progress = {
    ...record,
    stage(name, action) {
      return record.stage(name, () => {
        if (failures.includes(name) && name !== "san-tls") throw Error("FINITE_SECRET_STAGE");
        return action();
      });
    },
  };
  lines.close = () => lines.emit("close");
  Object.assign(processPort, { env: { TMPDIR: "/finite/home" }, umask() {}, getuid: () => 1000, pid: 42,
    stdout: { write: line => messages.push(JSON.parse(line).status) } });
  const child = runInNewContext(`(${body})`, {
    process: processPort, join, userGroup: () => group, root: "/finite", tlsOrigin: "https://127.0.0.1:8788", body: "expected",
    budget, setTimeout, clearTimeout,
    demand(ok) { assert.ok(ok); }, fail: () => Error("FINITE_SECRET_FAILURE"),
    bounded: action => Promise.resolve().then(action),
    readFileSync: path => path.endsWith("/cgroup") ? `0::${group}\n` : path.endsWith("/status") ? "NoNewPrivs: 1" : "{}",
    checkBookingEnvironment() {}, proxyOptions: { configPath: "/finite/config" }, checkOwnedDirectory() {}, directoryIdentity: () => ({}),
    guiEnvironment: value => value, procIdentity: () => ({ pid: 42, start: "7", group }), sameProcess: assert.deepEqual,
    createInterface() {
      queueMicrotask(() => {
        if (early) lines.emit("close");
        else lines.emit("line", JSON.stringify({ cookie: "a".repeat(42) + "A", month }));
        if (early) lines.emit("line", "{}");
      });
      return lines;
    },
    exec: async () => ({ stdout: "" }), createCertificate: async () => ({ key: "fixture", cert: "fixture", ca: "fixture" }),
    mkdirSync() {}, realpathSync: path => path, nssPath: () => "/finite/nss", checkTrustListing() {},
    X509Certificate: class { fingerprint256 = "finite"; }, constants: {},
    createServer: (_options, receive) => {
      serverRequest = () => receive({}, { writeHead() {}, end() {} });
      return Object.assign(new EventEmitter(), {
        listen(port, host, done) { assert.equal(port, 8788); assert.equal(host, "127.0.0.1"); done(); },
        close(done) { calls.push("proof-close"); done(); }, closeAllConnections() {},
        setSecureContext() { calls.push("alternate-certificate"); },
      });
    },
    launchOptions: () => ({ env: {} }), loadPlaywright: async () => ({ chromium: {
      async launch({ headless = true }) {
        calls.push(headless ? "headless-launch" : "headful-launch");
        return { async close() { calls.push(headless ? "headless-close" : "headful-close"); }, async newContext() {
          return { async newPage() {
            return { async goto(url) {
              if (url.endsWith("/san-mismatch")) throw Error("ERR_CERT_COMMON_NAME_INVALID");
              if (url.endsWith("/untrusted")) throw Error("ERR_CERT_AUTHORITY_INVALID");
              serverRequest();
              return { status: () => 200, text: async () => "expected" };
            }, async close() { calls.push("page-close"); } };
          } };
        } };
      },
    } }),
    generatedBrowserFiles: () => ["/finite/playwright_chromiumdev_profile-fixture"],
    ownedProcesses: () => [{ main: true, pid: 42 }],
    checkGeneratedBrowserCleanup() {},
    checkTlsFailure(error, code) {
      assert.equal(error?.message, code);
      if (code === "ERR_CERT_COMMON_NAME_INVALID" && failures.includes("san-tls")) throw Error("FINITE_SECRET_TLS_RESULT");
    },
    createOperatorWorker(_input, _name, _effects, stage) {
      return {
        async start() { for (const phase of ["worker-preflight", "worker-spawn", "worker-process", "worker-listener"]) stage(phase, () => {}); },
        hasChild: () => true, isReady: () => !stopped,
        async stop() { calls.push("worker-stop"); stopped = true; return { stopped: true, portClosed: true }; },
      };
    },
    async observeHumanBrowser(_context, _session, _month, _bad, diagnostic) {
      assert.equal(diagnostic, true);
      calls.push("display");
      return { closeAdmission: () => calls.push("close-admission"), finish: () => assert.fail("human operation must be unreachable") };
    },
  });
  try { await child(name, {}, progress); record.end(); } catch (error) { if (!early) throw error; }
  assert.equal(lines.listenerCount("close"), 0);
  assert.equal(processPort.listenerCount("SIGINT"), 0);
  return { text, calls, messages };
}

test("#1164 shared child completes TLS and display, stops admission first and never hands off to human operation", async () => {
  const f = await finiteDiagnosticChild();
  assert.equal(f.text, fixtureJournal("child", childPhases));
  assert.deepEqual(f.messages, ["started", "diagnostic-display"]);
  assert.deepEqual(f.calls, ["headless-launch", "page-close", "page-close", "alternate-certificate", "page-close",
    "headless-close", "proof-close", "headful-launch", "display", "close-admission", "worker-stop", "headful-close"]);
  const early = await finiteDiagnosticChild([], true);
  assert.equal(parseProgress("child", early.text).ended, false);
  assert.deepEqual(early.calls, []);
});

test("#1164 shared child separately retains TLS, page-close and browser-close failures without retry", async () => {
  // Inject at TLS checking after the page has opened so teardown has a page to close.
  const f = await finiteDiagnosticChild(["san-tls", "san-page-close", "headless-close"]);
  const report = parseProgress("child", f.text);
  assert.equal(report.firstFailure, "san-tls");
  assert.equal(report.firstCleanupFailure, "san-page-close");
  assert.equal(report.lastCompleted, "release-8788");
  assert.deepEqual(f.calls, ["headless-launch", "page-close", "proof-close"]);
  assert.deepEqual(f.messages, ["started"]);
  const closeFault = await finiteDiagnosticChild(["headless-close"]);
  assert.equal(parseProgress("child", closeFault.text).firstCleanupFailure, "headless-close");
  assert.deepEqual(closeFault.calls, ["headless-launch", "page-close", "page-close", "alternate-certificate", "page-close", "proof-close"]);
});

async function finiteProgressOwner(outcome) {
  const source = readFileSync("tests/evaluation/booking-operator.mjs", "utf8");
  const body = source.slice(source.indexOf("async function owner("), source.indexOf("\nif (process.argv[1]"));
  const processPort = new EventEmitter(), bridge = new EventEmitter(), calls = [];
  let trace = "", captures = 0, sent = 0, terminal = false, stopped = false, terminalSamples = 0, clientSignals = 0, now = 0;
  const clientRetained = outcome === "failed-unit" || outcome === "client-timeout";
  Object.assign(processPort, { umask() {}, env: { TMPDIR: "/finite/home" }, getuid: () => 1000, platform: "linux",
    version: "v24.0.0", argv: [null, null, null, null, null, name], stdin: new PassThrough() });
  bridge.stdout = Object.assign(new EventEmitter(), { destroy() {} });
  bridge.exitCode = null; bridge.signalCode = null;
  bridge.pid = 43; bridge.unref = () => {};
  bridge.kill = signal => {
    assert.equal(signal, "SIGTERM"); clientSignals++;
    if (outcome !== "client-timeout") { bridge.signalCode = signal; bridge.emit("exit", null, signal); }
  };
  bridge.stdin = Object.assign(new EventEmitter(), {
    write(line, done) {
      assert.deepEqual(JSON.parse(line), { cookie: "FINITE_SECRET_SESSION", month });
      assert.deepEqual(calls, ["spawn", "attest"]); sent++;
      done();
      queueMicrotask(() => {
        if (outcome === "lost") bridge.emit("close", 1);
        else {
          terminal = true;
          bridge.stdout.emit("data", Buffer.from('{"status":"diagnostic-display"}\n{"status":"diagnostic-complete"}\n'));
        }
      });
    },
    end() { if (!clientRetained && bridge.exitCode === null) { bridge.exitCode = 0; bridge.emit("exit", 0); } },
    destroy() {},
  });
  const operatorPath = "/finite/tests/evaluation/booking-operator-child.mjs";
  const versions = { wrangler: "4.146.0", "playwright-core": "1.64.0", typescript: "6.0.3" };
  const owner = runInNewContext(`(${body})`, {
    process: processPort, join, performance: { now: () => now }, budget, clearTimeout,
    setTimeout(action, ms) {
      if (ms <= 100) { now += ms; queueMicrotask(action); return; }
      return setTimeout(action, ms);
    },
    randomBytes: () => Buffer.from("a".repeat(32), "hex"), root: "/finite", console,
    demand: assert.ok, fail: () => Error("FINITE_SECRET_ERROR"), listenOperatorInput, userGroup, parseUnit, unitProperties,
    guiEnvironment: value => value, procIdentity: pid => {
      if (terminal && outcome === "pid-gone") throw Object.assign(Error("finite"), { code: "ENOENT" });
      return { pid, start: "7", group };
    }, sameProcess: assert.deepEqual,
    openProgress: () => ({ ...progressRecorder("owner", line => { trace += line; }), close() {} }),
    present: () => false, readdirSync: () => [], realpathSync: value => value === "/proc/42/exe" ? processPort.execPath : value,
    lstatSync: () => ({ mode: 0o700, isFile: () => true }),
    readFileSync: path => path.endsWith("/cgroup") ? `0::${group}\n` : path === "/proc/1/comm" ? "systemd" :
      path.endsWith("cgroup.controllers") ? "cpu" : path.endsWith("/cmdline") ? [operatorPath, name].join("\0") :
      path.includes("package") ? JSON.stringify({ version: versions[path.split("/").at(-2)], devDependencies: versions,
        packages: Object.fromEntries(Object.entries(versions).map(([key, version]) => ["node_modules/" + key, { version }])) }) : "{}",
    verifyStudentAssets() {}, migrations() {}, verifyOperatorBuild: async () => undefined,
    bounded: (action, ms) => ms === 1000 && clientRetained && (!clientSignals || outcome === "client-timeout")
      ? Promise.reject(Error("finite client wait deadline")) : Promise.resolve().then(action),
    mkdirSync() { captures++; }, rmSync: () => assert.fail("retention is mandatory"),
    supply: { checkBookingEnvironment() {}, checkDirectoryIdentity() {}, checkOwnedTree() {}, directoryIdentity: () => ({}),
      proxyOptions: { configPath: "/finite/config" }, persistence: "/finite/persist",
      async prepareTrustedBooking(consume, _entered, stage) {
        for (const phase of ownerPhases.slice(2, 12)) await stage(phase, () => {});
        await stage("handoff-capture", () => consume({ month, sessions: { self: { cookie: () => ({ value: "FINITE_SECRET_SESSION" }) } } }, {}));
      },
      inspectTrustedBooking: () => assert.fail("reservation readback must be unreachable"),
    },
    createInterface: () => Object.assign(new EventEmitter(), { close() {} }),
    emptyGroup: () => { calls.push("empty"); },
    spawn(file, args) {
      assert.equal(file, "systemd-run"); assert.ok(args.includes("--unit-diagnostic-child")); assert.ok(args.includes("--property=RuntimeMaxSec=1798s"));
      assert.ok(!args.join(" ").includes("FINITE_SECRET_SESSION"));
      calls.push("spawn");
      queueMicrotask(() => {
        bridge.emit("spawn");
        bridge.stdout.emit("data", Buffer.from('{"status":"started","pid":42,"start":"7"}\n'));
      });
      return bridge;
    },
    async exec(file, args) {
      if (file === "git") return { stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" };
      if (file === "ss") return { stdout: "" };
      assert.equal(file, "systemctl");
      if (args[1] === "stop") {
        calls.push("stop"); assert.equal(terminal, true); stopped = true;
        return { stdout: "" };
      }
      if (stopped) return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nInvocationID=\n" };
      if (!calls.includes("spawn")) return { stdout: "LoadState=not-found\n" };
      const duration = { RuntimeMaxUSec: "29min 58s" };
      if (!terminal) {
        calls.push("attest");
        return { stdout: unitText({ ...duration, MainPID: outcome === "identity" ? "43" : "42" }) };
      }
      if (++terminalSamples === 1 && outcome === "pid-gone") return { stdout: unitText(duration) };
      if (outcome === "deadline" || (terminalSamples === 1 && outcome === "transition")) return { stdout: unitText({ ...duration,
        ActiveState: "deactivating", SubState: "stop-post", MainPID: "0", ExecMainCode: "1", ControlGroup: "" }) };
      if (terminalSamples === 1 && outcome === "replaced") return { stdout: unitText({ ...duration,
        ActiveState: "deactivating", SubState: "stop-post", MainPID: "0", ExecMainCode: "1", ControlGroup: "", InvocationID: "c".repeat(32) }) };
      return { stdout: unitText({ ...duration, SubState: clientRetained ? "failed" : "exited",
        ActiveState: clientRetained ? "failed" : "active", MainPID: "0", ExecMainCode: "1", ExecMainStatus: "0" }) };
    },
  });
  processPort.execPath = "/node";
  const result = owner("a".repeat(40), {}, false, "/finite");
  if (outcome === "client-timeout") await assert.rejects(result, /finite client wait deadline/);
  else await result;
  return { trace, captures, sent, calls, terminalSamples, clientSignals };
}

test("#1164 owner uses the attested pipe once, never stops a failed or unknown unit and retains assets", async () => {
  const good = await finiteProgressOwner("complete");
  assert.equal(good.trace, fixtureJournal("owner", ownerPhases));
  assert.equal(good.captures, 1);
  assert.equal(good.sent, 1);
  assert.deepEqual(good.calls, ["spawn", "attest", "empty", "empty", "stop", "empty"]);
  const lost = await finiteProgressOwner("lost");
  assert.equal(lost.sent, 1);
  assert.deepEqual(lost.calls, ["spawn", "attest"]);
  assert.equal(parseProgress("owner", lost.trace).lastCompleted, "packet-send");
  const failed = await finiteProgressOwner("failed-unit");
  assert.equal(failed.sent, 1);
  assert.deepEqual(failed.calls, ["spawn", "attest"]);
  assert.equal(parseProgress("owner", failed.trace).firstCleanupFailure, "unit-terminal");
  assert.equal(failed.clientSignals, 1);
  for (const outcome of ["pid-gone", "transition"]) {
    const result = await finiteProgressOwner(outcome);
    assert.equal(result.trace, good.trace);
    assert.equal(result.terminalSamples, 4);
    assert.equal(result.clientSignals, 0);
  }
  const deadline = await finiteProgressOwner("deadline");
  assert.equal(deadline.terminalSamples, 100);
  assert.equal(parseProgress("owner", deadline.trace).firstCleanupFailure, "unit-terminal");
  assert.ok(!deadline.calls.includes("stop"));
  const timedOutClient = await finiteProgressOwner("client-timeout");
  assert.equal(timedOutClient.clientSignals, 1);
  assert.equal(parseProgress("owner", timedOutClient.trace).firstCleanupFailure, "unit-terminal");
  assert.ok(!timedOutClient.calls.includes("stop"));
  const replaced = await finiteProgressOwner("replaced");
  assert.equal(parseProgress("owner", replaced.trace).firstCleanupFailure, "unit-terminal");
  assert.equal(replaced.terminalSamples, 1);
  assert.ok(!replaced.calls.includes("stop"));
  const identity = await finiteProgressOwner("identity");
  assert.equal(identity.sent, 0);
  assert.deepEqual(identity.calls, ["spawn", "attest"]);
  assert.equal(parseProgress("owner", identity.trace).firstFailure, "child-attestation");
  for (const value of [good, lost, failed, identity]) assert.doesNotMatch(value.trace, /FINITE_SECRET/);
});

test("#1164 outer opt-in ignores private subprocess streams and reports the active stage on sudden exit", async () => {
  const result = await finiteNode(bridgeCliFixture("progress"));
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /FINITE_SECRET/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, "UNKNOWN");
  assert.deepEqual(report.controller, { lastCompleted: "controller-start", active: "none" });
  assert.deepEqual(report.owner, { lastCompleted: "none", active: "controller-entry" });
});
