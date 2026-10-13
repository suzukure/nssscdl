// #1010: finite only. Real BrowserUnit protocol, dedicated child/report, sealed operator VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, chmodSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { BrowserUnit } from "./trusted-browser-unit.mjs";
import { useUnauthenticatedBookingChild } from "./trusted-unauthenticated-booking-child.mjs";
import { useUnauthenticatedBookingOuter, unauthenticatedBookingOuterCheckpoint } from "./trusted-unauthenticated-booking-outer.mjs";
import { parseUnauthenticatedBookingReport, readUnauthenticatedBookingReport, writeUnauthenticatedBookingReport,
  unauthenticatedBookingChildComplete, unauthenticatedBookingFixtureComplete, unauthenticatedBookingChildUnknown } from "./trusted-unauthenticated-booking-report.mjs";

const canary = "private-session-csrf-sql-cause";
const failed = stage => `TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=${stage}; retain owned files; do not retry`;
const good = () => ({ execution: "isolated", phase: "complete", status: "prepared", readback: "unchanged" });
function fixture(fault = "", preflightTime = 0) {
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
          runInner: async () => { events.push("inner"); if (fault === "child") throw new Error(canary);
            events.push("unchanged/secret-scan"); if (fault === "secret-scan") throw new Error(canary); return { phase: "complete", status: "prepared" }; },
          write: wire => { events.push("child-report"); text = wire; if (fault === "write") throw new Error(canary); } });
        f.exit = completed ? "0" : "1"; f.hook("child"); return "";
      }
      if (args[2] === "stop") {
        events.push("stop"); f.hook("stop");
        if (fault === "stop") throw new Error(canary);
        return "";
      }
      events.push(unit.stopped ? "disposed-show" : "show"); shows++;
      if (fault === "show" || (unit.stopped && fault === "dispose-show")) throw new Error(canary);
      const state = unit.stopped ? { LoadState: "not-found", ActiveState: "inactive", SubState: "dead", InvocationID: "" } : {
        Type: "exec", ExitType: "cgroup", RemainAfterExit: "yes", Restart: "no", NRestarts: "0", OOMPolicy: "stop",
        Delegate: "no", NoNewPrivileges: "yes", ProtectControlGroups: "yes", KillMode: "control-group",
        StandardOutput: "null", StandardError: "null", User: "7", Group: "7", RuntimeMaxUSec: `${unit.runtime}s`, TimeoutStopUSec: "2s",
        LoadState: "loaded", ActiveState: "active", SubState: "exited", Result: "success", ExecMainCode: "1",
        ExecMainStatus: f.exit, InvocationID: "b".repeat(32), ControlGroup: "/system.slice/" + unit.name };
      if (!unit.stopped && shows >= 2) {
        if (fault === "live") { state.SubState = "running"; time += 60000; }
        if (fault === "timeout") { state.Result = "timeout"; state.SubState = "failed"; }
        if (fault === "unknown-exit") state.ExecMainCode = "0";
        if (fault === "invocation" && shows === 3) state.InvocationID = "c".repeat(32);
        if (fault === "abort") controller.abort(canary);
      }
      if (unit.stopped) {
        if (fault === "release") state.ActiveState = "active";
        if (fault === "late-abort") controller.abort(canary);
        if (fault === "late-budget") time = 180000;
      }
      f.hook(unit.stopped ? "disposed" : "show");
      return Object.entries(state).map(([key, value]) => `${key}=${value}`).join("\n");
    } });
  const ports = {
    async preflight() { events.push("preflight"); time += preflightTime; if (fault === "preflight") throw new Error(canary); },
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
    await assert.rejects(useUnauthenticatedBookingOuter(f.unit, f.ports), { message: failed(stage) }, fault);
    assert.ok(!f.events.includes("delete"), fault);
    for (const event of ["start", "inner", "stop"]) assert.ok(f.events.filter(v => v === event).length <= 1, fault);
    if (["preflight", "start", "terminal"].includes(stage)) assert.ok(!f.events.includes("report"));
    if (["preflight", "start", "terminal", "ownership"].includes(stage)) assert.ok(!f.events.includes("remove-check"));
    if (fault === "invocation") assert.equal(f.unit.failure, "MISMATCH");
    if (fault === "timeout" || fault === "live") assert.equal(f.unit.failure, "TIMEOUT");
    if (fault === "abort") assert.equal(f.unit.failure, "CANCEL");
  }
  const late = fixture("after-delete-abort");
  await assert.rejects(useUnauthenticatedBookingOuter(late.unit, late.ports), { message: failed("remove") });
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
async function operatorFixture(fault = "", injectedRun) {
  const f = fixture();
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
      if (fault === "report-toctou") nodes.get(reportPath).mtimeMs++;
      return good(); },
    BrowserUnit: class { constructor(options) { assert.equal(options.deadline, 180000); f.unit.signal.removeEventListener("abort", f.unit.cancel); f.unit.signal = options.signal;
      options.signal.addEventListener("abort", f.unit.cancel, { once: true }); return f.unit; } },
    browserUnitPreflight: async options => { assert.equal(options.deadline, 180000); f.events.push("capability"); if (fault === "capability") err(); },
    exec: async (file, args, options) => { assert.ok(options.timeout > 0 && options.timeout <= 5000); assert.equal(options.env.HOME, temporary);
      if (file === "ss") { assert.deepEqual(Array.from(args).slice(0, 2), ["-H", "-ltn"]); probes++; f.events.push(`port:${phase}:${args[2]}`);
        if (fault === `port-${phase}-${args[2].endsWith("8788") ? "8788" : "8789"}`) return { stdout: "fixture-listener" }; }
      else { assert.equal(file, "/usr/bin/which"); if (fault === "tool") err(); }
      return { stdout: "" }; },
    console: { log: value => stdout.push(value), error: value => stderr.push(value) },
  };
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
  for (const stage of ["preflight", "start", "terminal", "report", "ownership", "release", "remove", "listeners", "operator", "unknown"]) {
    const r = await operatorFixture("", async () => { throw new Error(failed(stage), { cause: canary }); });
    assert.deepEqual(r.stderr, [failed(stage)]); assert.deepEqual(r.stdout, []);
  }
  let touched = 0;
  for (const error of [new Error(canary), new Error(failed("report") + "\n"), new Error(failed("made-up")),
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
              for (const allowed of ['preflight', 'start', 'terminal', 'report', 'ownership', 'release', 'remove', 'listeners', 'operator', 'unknown']) {
                if (result.stderr === 'TRUSTED_UNAUTHENTICATED_BOOKING_OUTER_FAILED; stage=' + allowed + '; retain owned files; do not retry\\n') stage = allowed;
              }
            }
            console.error('UNAUTHENTICATED_BOOKING_PROOF_FAILED; stage=' + stage);
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

test("#1012 bounded single spawn; exact success or fixed failure stage; raw/normal diagnostics never escape", () => {
  const success = { status: 0, signal: null, stdout: unauthenticatedBookingOuterCheckpoint + "\n", stderr: "" };
  assert.deepEqual(proofFixture(success), { stdout: [unauthenticatedBookingOuterCheckpoint], stderr: [], status: 0 });
  const failure = { status: 1, signal: null, stdout: "", stderr: failed("terminal") + "\n" };
  for (const stage of ["preflight", "start", "terminal", "report", "ownership", "release", "remove", "listeners", "operator", "unknown"]) {
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
    ...[failed("terminal"), failed("terminal") + "\r\n", failed("terminal") + "\0\n", failed("made-up") + "\n",
      failed("terminal").replace("do not retry", "retry") + "\n", canary + failed("terminal") + "\n",
      "TRUSTED_BOOKING_OUTER_FAILED; stage=terminal; retain owned files; do not retry\n",
      failed("terminal").replace("; retain", "; diagnostic=observed; phase=dom; retain") + "\n"]
      .map(stderr => ({ ...failure, stderr })),
  ];
  for (const [index, result] of unknown.entries()) assert.deepEqual(proofFixture(result), {
    stdout: [], stderr: ["UNAUTHENTICATED_BOOKING_PROOF_FAILED; stage=unknown"], status: 1 }, `output denial ${index}`);
});
