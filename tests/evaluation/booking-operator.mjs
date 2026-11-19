// #1104 opt-in human operator. No default workflow or production caller.
import { execFile, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { appendFileSync, writeFileSync, lstatSync, readFileSync, readdirSync, realpathSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { root } from "./trusted-evaluation-seed.mjs";
import * as supply from "./trusted-booking-seed.mjs";
import { verifyStudentAssets } from "./verify-student-assets.mjs";
import { migrations } from "./local-https-smoke.mjs";
import { checkFiles } from "./trusted-seed-process.mjs";
import { budget, bounded, demand, fail, userGroup, parseUnit, unitProperties, emptyGroup, procIdentity, sameProcess, guiEnvironment } from "./booking-operator-unit.mjs";
import { directStage, openProgress, operatorProgressReport, progressPath, readProgress } from "./booking-operator-progress.mjs";
import { diagnosePreparation, preparationReport } from "./booking-operator-diagnostic.mjs";
const exec = promisify(execFile), script = fileURLToPath(import.meta.url);
const present = path => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw fail(); } };
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
export const cleanEnvironment = temporary => Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: temporary, TMPDIR: temporary,
  XDG_CONFIG_HOME: temporary, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(temporary, "wrangler.log"), CI: "true" });

// Only the compiler may receive this extra key. The subsequent seed must still
// enter with its original credential-free environment and a genuinely empty home.
export async function verifyOperatorBuild(env, compile = exec) {
  const build = mkdtempSync(join(env.TMPDIR, "nssscdl-operator-build-")), identity = supply.directoryIdentity(build);
  await compile(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "src/web/tsconfig.json", "--outDir", build],
    { cwd: root, env: { ...env, NODE_DISABLE_COMPILE_CACHE: "1" }, timeout: 60000, maxBuffer: 65536 });
  for (const file of ["student.js", "view.js", "controller.js", "model.js"]) demand(hash(join(build, file)) === hash(join(root, "dist/student", file)));
  for (const file of ["student.html", "student.css"]) demand(hash(join(root, "src/web", file)) === hash(join(root, "dist/student", file)));
  const evidence = { config: hash(supply.proxyOptions.configPath), build: Object.fromEntries(readdirSync(join(root, "dist/student")).sort().map(file => [file, hash(join(root, "dist/student", file))])),
    migrations: migrations().map(file => [file, hash(join(root, "migrations", file))]), fixture: "trusted-booking-seed/empty-only/self/standard-slot", startedAt: new Date().toISOString() };
  supply.checkDirectoryIdentity(build, identity); supply.checkOwnedTree(build); rmSync(build, { recursive: true });
  return evidence;
}

export function listenOperatorInput(interrupt, input = process.stdin, signals = process) {
  signals.on("SIGINT", interrupt); signals.on("SIGTERM", interrupt);
  input.on("end", interrupt); input.resume();
  return () => {
    input.removeListener("end", interrupt); input.pause();
    signals.removeListener("SIGINT", interrupt); signals.removeListener("SIGTERM", interrupt);
  };
}

// stderr remains private. A failed bridge throws only the fixed failure, so the
// outer CLI's existing catch emits one public unknown/retained notice.
export async function bridgeOperator(child, input = process.stdin, output = process.stdout, signals = process) {
  let interrupted = false;
  const abort = () => { if (!interrupted) { interrupted = true; child.stdin.end(); } };
  child.stdin.on("error", () => {});
  signals.on("SIGINT", abort); signals.on("SIGTERM", abort);
  try {
    const completion = new Promise(done => { child.on("error", () => done(1)); child.on("exit", code => done(code)); });
    input.pipe(child.stdin); child.stdout?.pipe(output);
    const code = await completion;
    demand(!interrupted && code === 0);
  } finally {
    input.unpipe(child.stdin); input.pause();
    signals.removeListener("SIGINT", abort); signals.removeListener("SIGTERM", abort);
  }
}

// The seed handle never enters argv/IPC/report; the independent read remains in
// this credential-free owner, outside the Browser/Worker unit being proved empty.
export async function useOperator(ports) {
  let started = false, released = false;
  try {
    await ports.preflight();
    let used = false;
    const result = await ports.prepare(async (seed, handle) => {
      demand(!used); used = true;
      await ports.capture(); started = true;
      const reservationId = await ports.run(seed);
      demand(typeof reservationId === "string" && /^[a-f0-9-]{36}$/.test(reservationId));
      await ports.terminal(); // Two same-Invocation no-live samples before any D1 proxy.
      await ports.readback(handle, reservationId);
      await ports.scan(seed);
      await ports.release(); released = true;
      await ports.remove();
      return reservationId;
    });
    demand(used); return result;
  } catch {
    if (started && !released) { try { await ports.stopUnknown(); } catch { /* retain; never a second stop */ } }
    throw fail();
  }
}

async function owner(head, gui, diagnostic = false, progressDirectory) {
  process.umask(0o077);
  const deadline = performance.now() + budget.total, preparationEnd = performance.now() + budget.prepare;
  const env = process.env, temporary = env.TMPDIR;
  let aborted = false;
  if (progressDirectory) {
    demand(temporary === join(progressDirectory, "home"));
    supply.directoryIdentity(progressDirectory);
  }
  const progress = progressDirectory && openProgress(progressDirectory, "owner", () => aborted);
  const stage = progress?.stage ?? directStage;
  let temporaryIdentity;
  try {
    stage("controller-entry", () => {
      demand(readFileSync("/proc/self/cgroup", "utf8") === `0::${userGroup(process.getuid(), process.argv[5])}\n`);
      supply.checkBookingEnvironment(env, JSON.parse(readFileSync(supply.proxyOptions.configPath, "utf8")),
        [root, join(root, "tests"), join(root, "tests/evaluation")].flatMap(dir => readdirSync(dir)));
      temporaryIdentity = supply.directoryIdentity(temporary);
      demand((lstatSync(temporary).mode & 0o777) === 0o700);
      if (!diagnostic) gui = guiEnvironment(gui);
    });
  } catch (error) {
    if (!progress) throw error;
    progress.end(); progress.close();
    return;
  }
  const name = `nssscdl-operator-${randomBytes(16).toString("hex")}.service`, group = userGroup(process.getuid(), name);
  const managerEnv = { PATH: env.PATH, HOME: temporary, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
  let invocation, main, unitStarted = false, stopAttempted = false, bridge, bridgeExit, browserHome, persistIdentity, parentIdentity, runtimeSeconds;
  let endInteraction, reservationId, finishedAt, cleanupEnd = deadline;
  const interrupt = () => { aborted = true; bridge?.stdin.end(); endInteraction?.(); };
  const releaseInput = listenOperatorInput(interrupt);
  const remaining = () => { demand(!aborted && performance.now() < deadline); return deadline - performance.now(); };
  const command = async (file, args, manager = false, end = cleanupEnd) => (await exec(file, args, { cwd: root, env: manager ? managerEnv : env,
    timeout: Math.max(1, Math.min(5000, manager ? end - performance.now() : remaining())), maxBuffer: 65536 })).stdout;
  const show = end => command("systemctl", ["--user", "show", name, ...unitProperties.split(",").map(k => `--property=${k}`)], true, end);
  const closed = async () => { for (const port of [8788, 8789]) demand((await command("ss", ["-H", "-ltn", `sport = :${port}`])).trim() === ""); };
  const expected = () => ({ group, invocation, runtimeSeconds });
  const checkOwned = () => {
    supply.checkDirectoryIdentity(temporary, temporaryIdentity);
    supply.checkDirectoryIdentity(join(root, ".wrangler"), parentIdentity);
    supply.checkDirectoryIdentity(supply.persistence, persistIdentity);
    if (browserHome) supply.checkDirectoryIdentity(join(temporary, "browser-home"), browserHome);
    supply.checkOwnedTree(temporary); supply.checkOwnedTree(supply.persistence);
  };
  const stop = async () => {
    demand(unitStarted && invocation && !stopAttempted); stopAttempted = true;
    const textBeforeStop = await show();
    if (progress) parseUnit(textBeforeStop, expected(), true);
    const state = parseUnit(textBeforeStop, expected(), "stop");
    if (state.pid) sameProcess(main, procIdentity(state.pid, group));
    // Identity is freshly revalidated. Exactly one manager stop, even on unknown.
    if (progress) demand(!aborted && performance.now() < cleanupEnd);
    await command("systemctl", ["--user", "stop", name], true);
    const text = await command("systemctl", ["--user", "show", name, "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=InvocationID"], true);
    const data = Object.fromEntries(text.trim().split("\n").map(line => { const p = line.indexOf("="); return [line.slice(0, p), line.slice(p + 1)]; }));
    demand(Object.keys(data).length === 4 && (data.LoadState === "not-found" && data.ActiveState === "inactive" ||
      data.InvocationID === invocation && data.ActiveState === "inactive" && data.SubState === "dead"));
    emptyGroup(group);
  };
  const finishBridge = async () => {
    const client = bridge;
    if (!client) return;
    bridge = undefined;
    try {
      client.stdin.end();
      if (!client.pid || client.exitCode !== null || client.signalCode !== null) return;
      const waitForExit = () => bounded(() => bridgeExit, Math.min(1000, deadline - performance.now()));
      try { await waitForExit(); }
      catch {
        // Signal only the spawned systemd-run client. The unit and its resources remain under manager ownership.
        if (client.exitCode === null && client.signalCode === null) client.kill("SIGTERM");
        await waitForExit();
      }
    } finally {
      client.stdin.destroy(); client.stdout.destroy(); client.unref();
    }
  };
  let outputId, evidence;
  const checkSource = async () => {
    demand((await command("git", ["rev-parse", "HEAD"])).trim() === head && (await command("git", ["status", "--porcelain"])).trim() === "");
    if (evidence) {
      demand(hash(supply.proxyOptions.configPath) === evidence.config);
      for (const [file, value] of Object.entries(evidence.build)) demand(hash(join(root, "dist/student", file)) === value);
      for (const [file, value] of evidence.migrations) demand(hash(join(root, "migrations", file)) === value);
    }
  };
  try {
    const ports = {
      async preflight() {
        demand(process.platform === "linux" && /^v24\./.test(process.version) && process.getuid() > 0 && /^[a-f0-9]{40}$/.test(head));
        demand(readFileSync("/proc/1/comm", "utf8").trim() === "systemd" && readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").trim().length > 0);
        await checkSource();
        demand(!present(supply.persistence) && !present(join(root, ".wrangler/student-read-only-evaluation")) && readdirSync(temporary).length === 0);
        verifyStudentAssets(root); migrations(); await closed();
        for (const [pkg, version] of [["wrangler", "4.146.0"], ["playwright-core", "1.64.0"], ["typescript", "6.0.3"]]) {
          const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies[pkg];
          demand(declared === version && JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages[`node_modules/${pkg}`].version === version &&
            JSON.parse(readFileSync(join(root, `node_modules/${pkg}/package.json`), "utf8")).version === version);
        }
        for (const binary of [process.execPath, "/usr/bin/google-chrome", "/usr/bin/certutil", "/usr/bin/openssl", "/usr/bin/ss", "/usr/bin/systemd-run", "/usr/bin/systemctl"])
          demand(lstatSync(realpathSync(binary)).isFile());
        // Compile the existing UI into a fresh owned directory and compare bytes;
        // file presence alone does not establish that dist belongs to this HEAD.
        evidence = await verifyOperatorBuild(env);
        demand(performance.now() < preparationEnd); remaining();
      },
      async prepare(consume, stage) {
        // #937 deliberately discards callback results, so keep only the safe ID.
        await supply.prepareTrustedBooking(async (seed, handle) => { outputId = await consume(seed, handle); }, undefined, stage);
      },
      capture() {
        parentIdentity = supply.directoryIdentity(join(root, ".wrangler")); persistIdentity = supply.directoryIdentity(supply.persistence);
        mkdirSync(join(temporary, "browser-home"), { mode: 0o700 }); browserHome = supply.directoryIdentity(join(temporary, "browser-home")); checkOwned();
      },
      async run(seed) {
        await stage("child-admission", async () => {
          remaining(); demand(performance.now() < preparationEnd);
          await checkSource();
          demand(/^LoadState=not-found$/m.test(await show()));
          runtimeSeconds = Math.floor((remaining() - 2000) / 1000);
          demand(runtimeSeconds > 0 && runtimeSeconds <= 1800);
        });
        const args = ["--user", "--pipe", "--quiet", "--no-ask-password", `--unit=${name}`, `--working-directory=${root}`,
          "--property=Type=exec", "--property=RemainAfterExit=yes", "--property=Restart=no", `--property=RuntimeMaxSec=${runtimeSeconds}s`,
          "--property=TimeoutStopSec=2s", "--property=KillMode=control-group", "--property=NoNewPrivileges=yes",
          "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
          process.execPath, join(root, "tests/evaluation/booking-operator-child.mjs"),
          progress ? "--unit-diagnostic-child" : "--unit-child", name, JSON.stringify([name, gui])];
        const launched = stage("child-start", () => {
          unitStarted = true; bridge = spawn("systemd-run", args, { cwd: root, env: managerEnv, stdio: ["pipe", "pipe", "ignore"] });
          bridgeExit = new Promise(done => bridge.once("exit", done));
          if (progress) return new Promise((done, bad) => { bridge.once("spawn", done); bridge.once("error", bad); });
        });
        launched?.catch(() => {});
        bridge.stdin.on("error", interrupt);
        let displaySeen = false, preparationTimer;
        let ready = false, readySeen = false, received = false, settle, reject, buffer = "", handshake, receiveHandshake;
        const started = new Promise(done => { receiveHandshake = done; });
        const completion = new Promise((done, bad) => { settle = done; reject = bad; }); completion.catch(() => {});
        endInteraction = () => reject(fail());
        const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        input.on("line", line => { if (!progress && ready && line === "操作終了") { cleanupEnd = Math.min(deadline, performance.now() + budget.cleanup); bridge.stdin.write("操作終了\n"); ready = false; } });
        bridge.on("error", () => reject(fail())); bridge.on(progress ? "close" : "exit", () => { if (!received) reject(fail()); });
        bridge.stdout.on("data", chunk => {
          try {
            buffer += chunk.toString("utf8"); demand(buffer.length <= 4096);
            while (buffer.includes("\n")) {
              const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              const data = JSON.parse(line);
              if (!handshake && data.status === "started" && Object.keys(data).join(",") === "status,pid,start") {
                demand(Number.isSafeInteger(data.pid) && data.pid > 1 && /^\d+$/.test(data.start)); handshake = data; receiveHandshake();
              } else if (progress) {
                demand(handshake && !received && Object.keys(data).join(",") === "status");
                if (data.status === "diagnostic-display") {
                  demand(!displaySeen && performance.now() < preparationEnd);
                  displaySeen = true;
                  clearTimeout(preparationTimer);
                  cleanupEnd = Math.min(deadline, performance.now() + budget.cleanup);
                } else {
                  demand(data.status === "diagnostic-complete");
                  received = true;
                  clearTimeout(preparationTimer);
                  if (!displaySeen) cleanupEnd = Math.min(deadline, preparationEnd + budget.cleanup, performance.now() + budget.cleanup);
                  settle();
                }
              } else if (handshake && !readySeen && !received && Object.keys(data).join(",") === "status" && data.status === "ready") {
                demand(performance.now() < preparationEnd); ready = true; readySeen = true;
                console.log(`${seed.month}の15日10:00（日本時間）の予約可能枠を選び、Preview→確認して確定→本人履歴を操作してください。終わったら端末に「操作終了」と入力してください（最長20分）。`);
              } else {
                demand(readySeen && !ready && !received && data.status === "complete" && Object.keys(data).join(",") === "status,reservationId" && /^[a-f0-9-]{36}$/.test(data.reservationId));
                received = true; settle(data.reservationId);
              }
            }
          } catch { reject(fail()); }
        });
        try {
          // Do not put the Session in argv/env/files. Only a private inherited pipe
          // receives it, after manager + kernel identity of the trusted child.
          if (progress) {
            await bounded(() => launched, Math.min(15000, preparationEnd - performance.now()));
            preparationTimer = setTimeout(() => { if (!displaySeen && !received) interrupt(); }, Math.max(0, preparationEnd - performance.now()));
          }
          await stage("child-attestation", async () => {
            await bounded(() => Promise.race([started, completion.then(() => { throw fail(); })]), Math.min(15000, preparationEnd - performance.now()));
            const startEnd = Math.min(preparationEnd, performance.now() + 15000);
            let snapshot;
            while (!snapshot && performance.now() < startEnd) {
              const text = await show();
              if (/^LoadState=not-found$/m.test(text)) await new Promise(done => setTimeout(done, 100));
              else snapshot = parseUnit(text, { group, runtimeSeconds });
            }
            demand(snapshot); invocation = snapshot.invocation; main = procIdentity(snapshot.pid, group);
            demand(handshake.pid === main.pid && handshake.start === main.start && bridge.exitCode === null);
            demand(realpathSync(`/proc/${main.pid}/exe`) === realpathSync(process.execPath));
            const argv = readFileSync(`/proc/${main.pid}/cmdline`, "utf8").split("\0");
            demand(argv.includes(join(root, "tests/evaluation/booking-operator-child.mjs")) && argv.includes(name));
            sameProcess(main, procIdentity(main.pid, group));
          });
          const send = () => JSON.stringify({ cookie: seed.sessions.self.cookie().value, month: seed.month }) + "\n";
          if (progress) {
            await stage("packet-send", () => bounded(() => new Promise((done, rejectWrite) => {
              bridge.stdin.write(send(), error => error ? rejectWrite(fail()) : done());
            }), Math.min(remaining(), preparationEnd - performance.now())));
            await bounded(() => completion, Math.min(remaining(), cleanupEnd - performance.now(), preparationEnd - performance.now() + budget.cleanup));
            demand(!aborted); return;
          }
          bridge.stdin.write(send());
          reservationId = await bounded(() => completion, Math.min(remaining() - budget.cleanup, preparationEnd - performance.now() + budget.interaction + budget.cleanup));
          finishedAt = new Date().toISOString(); demand(!aborted); return reservationId;
        } finally { clearTimeout(preparationTimer); input.close(); endInteraction = undefined; }
      },
      async terminal() {
        for (let sample = 0; sample < 2; sample++) {
          const end = Math.min(cleanupEnd, performance.now() + 10000); let terminal = false;
          while (!terminal && performance.now() < end) {
            remaining();
            const snapshot = parseUnit(await show(end), expected(), "poll");
            if (snapshot.pid) {
              demand(snapshot.pid === main.pid);
              try { sameProcess(main, procIdentity(snapshot.pid, group)); }
              catch (error) {
                // A process that exits between manager and kernel reads requires a fresh manager sample.
                if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
              }
            }
            terminal = !snapshot.pending;
            if (!terminal) await new Promise(done => setTimeout(done, Math.max(0, Math.min(100, end - performance.now()))));
          }
          remaining(); demand(terminal && performance.now() < end); emptyGroup(group); await closed();
        }
        checkOwned(); remaining(); demand(performance.now() < cleanupEnd);
      },
      async readback(handle, id) { await bounded(() => supply.inspectTrustedBooking(handle, id), Math.min(cleanupEnd - performance.now(), remaining())); },
      scan(seed) {
        checkOwned(); const tokens = [seed.sessions.self, seed.sessions.other].map(s => s.cookie().value);
        const secrets = tokens.flatMap(t => [t, createHash("sha256").update(t).digest("hex"), createHash("sha256").update("student-csrf-v1:" + t).digest("base64url")]);
        checkFiles(temporary, secrets); checkFiles(supply.persistence, tokens);
        demand(secrets.every(s => !JSON.stringify(process.env).includes(s) && !JSON.stringify(process.argv).includes(s))); remaining();
      },
      release: stop,
      async remove() { await checkSource(); checkOwned(); remaining(); demand(performance.now() < cleanupEnd && stopAttempted); rmSync(supply.persistence, { recursive: true }); rmSync(temporary, { recursive: true }); },
      async stopUnknown() { cleanupEnd = Math.min(deadline, performance.now() + budget.cleanup); if (!stopAttempted) await stop(); },
    };
    if (progress) {
      try {
        await stage("operator-preflight", ports.preflight);
        let seed;
        await ports.prepare(value => {
          remaining(); demand(performance.now() < preparationEnd);
          ports.capture(); seed = value;
        }, stage);
        demand(seed);
        await ports.run(seed);
        await stage("unit-terminal", ports.terminal);
        await stage("unit-stop", ports.release);
      } catch { /* Only the stage journal classifies the failure. */ }
      progress.end();
      return;
    }
    if (diagnostic) {
      const directory = dirname(temporary);
      demand(temporary === join(directory, "home"));
      supply.directoryIdentity(directory);
      const report = join(directory, "observations");
      const stat = lstatSync(report);
      demand(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && stat.size === 0 && (stat.mode & 0o777) === 0o600);
      await diagnosePreparation({
        preflight: ports.preflight, prepare: ports.prepare,
        capture: () => { remaining(); demand(performance.now() < preparationEnd); ports.capture(); },
        interrupted: () => aborted || performance.now() >= preparationEnd,
      }, (event, name) => appendFileSync(report, name ? `${event} ${name}\n` : `${event}\n`));
      return;
    }
    await useOperator(ports);
    await finishBridge();
    demand(outputId === reservationId);
    console.log(JSON.stringify({ issue: 1104, head, ...evidence, completedAt: finishedAt, actor: "fictional-self", reservationId,
      browser: "human-one-confirm-history", readback: "five-tables", cleanup: "owned-removed", evidence: "local-human-partial; Gate-A-D/930-401/608-release-unproved" }));
  } finally {
    releaseInput();
    try { await finishBridge(); }
    finally { progress?.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv.length === 6 && ["--private-owner", "--private-diagnostic-owner", "--private-progress-owner"].includes(process.argv[2])) {
      demand(process.platform === "linux"); await owner(process.argv[3], JSON.parse(process.argv[4]), process.argv[2] === "--private-diagnostic-owner",
        process.argv[2] === "--private-progress-owner" ? dirname(process.env.TMPDIR) : undefined);
    } else {
      const diagnostic = process.argv[2] === "--diagnose-d1";
      const progressMode = process.argv[2] === "--diagnose-operator";
      demand(process.argv.length === 5 && (diagnostic || progressMode || process.argv[2] === "--run") && process.argv[3] === "--head" && /^[a-f0-9]{40}$/.test(process.argv[4]));
      demand(process.platform === "linux" && /^v24\./.test(process.version) && process.getuid() > 0 && process.stdin.isTTY);
      demand(!Object.keys(process.env).some(k => /TOKEN|SECRET|PASSWORD|API_KEY|PROXY|NODE_OPTIONS|PWDEBUG|^DEBUG$|SSLKEYLOG|NODE_TLS/i.test(k)));
      const gui = diagnostic ? null : guiEnvironment(Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"].filter(k => process.env[k]).map(k => [k, process.env[k]])));
      const directory = mkdtempSync(join(tmpdir(), "nssscdl-operator-"));
      const temporary = diagnostic || progressMode ? join(directory, "home") : directory;
      const report = diagnostic ? join(directory, "observations") : undefined;
      if (diagnostic || progressMode) mkdirSync(temporary, { mode: 0o700 });
      if (diagnostic) writeFileSync(report, "", { flag: "wx", mode: 0o600 });
      if (progressMode) for (const role of ["controller", "owner", "child"])
        writeFileSync(progressPath(directory, role), "", { flag: "wx", mode: 0o600 });
      const env = cleanEnvironment(temporary), name = `nssscdl-operator-${randomBytes(16).toString("hex")}.service`;
      const manager = { PATH: env.PATH, HOME: temporary, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
      // Outer controller has the whole-run hard cap. Browser/Worker live in a
      // separate bounded unit, permitting their empty-cgroup proof before readback.
      const launch = () => spawn("systemd-run", ["--user", "--pipe", "--wait", "--quiet", "--no-ask-password", `--unit=${name}`,
        `--working-directory=${root}`, "--property=Type=exec", "--property=Restart=no", "--property=RuntimeMaxSec=1800s",
        "--property=TimeoutStopSec=2s", "--property=KillMode=control-group", "--property=NoNewPrivileges=yes",
        "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        process.execPath, script, diagnostic ? "--private-diagnostic-owner" : progressMode ? "--private-progress-owner" : "--private-owner", process.argv[4], JSON.stringify(gui), name],
      { cwd: root, env: manager, stdio: ["pipe", diagnostic || progressMode ? "ignore" : "pipe", "ignore"] });
      // Private pipe EOF is observable even when a parent dies without a signal.
      if (progressMode) {
        const progress = openProgress(directory, "controller");
        let exited = false;
        try {
          let completion;
          await progress.stage("controller-start", () => new Promise((done, rejectStart) => {
            const child = launch();
            child.once("spawn", done); child.once("error", rejectStart);
            completion = bridgeOperator(child);
            completion.catch(() => {});
          }));
          progress.end();
          await completion;
          exited = true;
        } catch { /* A missing owner or abnormal controller exit is UNKNOWN. */ }
        finally { progress.close(); }
        const result = operatorProgressReport({
          controller: readProgress(directory, "controller"), owner: readProgress(directory, "owner"), child: readProgress(directory, "child"),
        }, exited);
        console.log(JSON.stringify(result));
        if (result.result !== "NOT_REPRODUCED") process.exitCode = 1;
      } else if (diagnostic) {
        const child = launch();
        let exited = false, observations = "";
        try { await bridgeOperator(child); exited = true; } catch { /* UNKNOWN */ }
        try {
          const stat = lstatSync(report);
          if (stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && stat.size <= 1024)
            observations = readFileSync(report, "utf8");
        } catch { /* UNKNOWN */ }
        const result = preparationReport(observations, exited);
        console.log(JSON.stringify(result));
        if (result.result !== "NOT_REPRODUCED") process.exitCode = 1;
      } else await bridgeOperator(launch());
    }
  } catch { console.error("BOOKING_OPERATOR_UNKNOWN; owned resources retained; do not retry"); process.exitCode = 1; }
}
