// #1104 opt-in human operator. No default workflow or production caller.
import { execFile, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
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
const exec = promisify(execFile), script = fileURLToPath(import.meta.url);
const present = path => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw fail(); } };
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
export const cleanEnvironment = temporary => Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: temporary, TMPDIR: temporary,
  XDG_CONFIG_HOME: temporary, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(temporary, "wrangler.log"), CI: "true" });

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

async function owner(head, gui) {
  process.umask(0o077);
  const deadline = performance.now() + budget.total, preparationEnd = performance.now() + budget.prepare;
  const env = process.env, temporary = env.TMPDIR;
  demand(readFileSync("/proc/self/cgroup", "utf8") === `0::${userGroup(process.getuid(), process.argv[5])}\n`);
  supply.checkBookingEnvironment(env, JSON.parse(readFileSync(supply.proxyOptions.configPath, "utf8")),
    [root, join(root, "tests"), join(root, "tests/evaluation")].flatMap(dir => readdirSync(dir)));
  const temporaryIdentity = supply.directoryIdentity(temporary);
  demand((lstatSync(temporary).mode & 0o777) === 0o700);
  gui = guiEnvironment(gui);
  const name = `nssscdl-operator-${randomBytes(16).toString("hex")}.service`, group = userGroup(process.getuid(), name);
  const managerEnv = { PATH: env.PATH, HOME: temporary, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
  let invocation, main, unitStarted = false, stopAttempted = false, bridge, browserHome, persistIdentity, parentIdentity;
  let aborted = false, endInteraction, reservationId, finishedAt, cleanupEnd = deadline;
  const interrupt = () => { aborted = true; bridge?.stdin.end(); endInteraction?.(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt); process.stdin.on("end", interrupt); process.stdin.resume();
  const remaining = () => { demand(!aborted && performance.now() < deadline); return deadline - performance.now(); };
  const command = async (file, args, manager = false) => (await exec(file, args, { cwd: root, env: manager ? managerEnv : env,
    timeout: Math.max(1, Math.min(5000, manager ? cleanupEnd - performance.now() : remaining())), maxBuffer: 65536 })).stdout;
  const show = () => command("systemctl", ["--user", "show", name, ...unitProperties.split(",").map(k => `--property=${k}`)], true);
  const closed = async () => { for (const port of [8788, 8789]) demand((await command("ss", ["-H", "-ltn", `sport = :${port}`])).trim() === ""); };
  const expected = () => ({ group, invocation });
  const checkOwned = () => {
    supply.checkDirectoryIdentity(temporary, temporaryIdentity);
    supply.checkDirectoryIdentity(join(root, ".wrangler"), parentIdentity);
    supply.checkDirectoryIdentity(supply.persistence, persistIdentity);
    if (browserHome) supply.checkDirectoryIdentity(join(temporary, "browser-home"), browserHome);
    supply.checkOwnedTree(temporary); supply.checkOwnedTree(supply.persistence);
  };
  const stop = async () => {
    demand(unitStarted && invocation && !stopAttempted); stopAttempted = true;
    const state = parseUnit(await show(), expected(), "stop");
    if (state.pid) sameProcess(main, procIdentity(state.pid, group));
    // Identity is freshly revalidated. Exactly one manager stop, even on unknown.
    await command("systemctl", ["--user", "stop", name], true);
    const text = await command("systemctl", ["--user", "show", name, "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=InvocationID"], true);
    const data = Object.fromEntries(text.trim().split("\n").map(line => { const p = line.indexOf("="); return [line.slice(0, p), line.slice(p + 1)]; }));
    demand(Object.keys(data).length === 4 && (data.LoadState === "not-found" && data.ActiveState === "inactive" ||
      data.InvocationID === invocation && data.ActiveState === "inactive" && data.SubState === "dead"));
    emptyGroup(group);
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
    await useOperator({
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
        const build = mkdtempSync(join(tmpdir(), "nssscdl-operator-build-")), identity = supply.directoryIdentity(build);
        await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "src/web/tsconfig.json", "--outDir", build],
          { cwd: root, env, timeout: 60000, maxBuffer: 65536 });
        for (const file of ["student.js", "view.js", "controller.js", "model.js"]) demand(hash(join(build, file)) === hash(join(root, "dist/student", file)));
        for (const file of ["student.html", "student.css"]) demand(hash(join(root, "src/web", file)) === hash(join(root, "dist/student", file)));
        evidence = { config: hash(supply.proxyOptions.configPath), build: Object.fromEntries(readdirSync(join(root, "dist/student")).sort().map(file => [file, hash(join(root, "dist/student", file))])),
          migrations: migrations().map(file => [file, hash(join(root, "migrations", file))]), fixture: "trusted-booking-seed/empty-only/self/standard-slot", startedAt: new Date().toISOString() };
        supply.checkDirectoryIdentity(build, identity); supply.checkOwnedTree(build); rmSync(build, { recursive: true });
        demand(performance.now() < preparationEnd); remaining();
      },
      async prepare(consume) {
        // #937 deliberately discards callback results, so keep only the safe ID.
        await supply.prepareTrustedBooking(async (seed, handle) => { outputId = await consume(seed, handle); });
      },
      capture() {
        parentIdentity = supply.directoryIdentity(join(root, ".wrangler")); persistIdentity = supply.directoryIdentity(supply.persistence);
        mkdirSync(join(temporary, "browser-home"), { mode: 0o700 }); browserHome = supply.directoryIdentity(join(temporary, "browser-home")); checkOwned();
      },
      async run(seed) {
        remaining(); demand(performance.now() < preparationEnd);
        await checkSource();
        demand(/^LoadState=not-found$/m.test(await show()));
        const args = ["--user", "--pipe", "--quiet", "--no-ask-password", `--unit=${name}`, `--working-directory=${root}`,
          "--property=Type=exec", "--property=RemainAfterExit=yes", "--property=Restart=no", "--property=RuntimeMaxSec=1800s",
          "--property=TimeoutStopSec=2s", "--property=KillMode=control-group", "--property=NoNewPrivileges=yes",
          "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
          process.execPath, join(root, "tests/evaluation/booking-operator-child.mjs"), "--unit-child", name, JSON.stringify([name, gui])];
        unitStarted = true; bridge = spawn("systemd-run", args, { cwd: root, env: managerEnv, stdio: ["pipe", "pipe", "ignore"] });
        bridge.stdin.on("error", interrupt);
        let ready = false, readySeen = false, received = false, settle, reject, buffer = "", handshake, receiveHandshake;
        const started = new Promise(done => { receiveHandshake = done; });
        const completion = new Promise((done, bad) => { settle = done; reject = bad; }); completion.catch(() => {});
        endInteraction = () => reject(fail());
        const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        input.on("line", line => { if (ready && line === "操作終了") { cleanupEnd = Math.min(deadline, performance.now() + budget.cleanup); bridge.stdin.write("操作終了\n"); ready = false; } });
        bridge.on("error", () => reject(fail())); bridge.on("exit", () => { if (!received) reject(fail()); });
        bridge.stdout.on("data", chunk => {
          try {
            buffer += chunk.toString("utf8"); demand(buffer.length <= 4096);
            while (buffer.includes("\n")) {
              const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              const data = JSON.parse(line);
              if (!handshake && data.status === "started" && Object.keys(data).join(",") === "status,pid,start") {
                demand(Number.isSafeInteger(data.pid) && data.pid > 1 && /^\d+$/.test(data.start)); handshake = data; receiveHandshake();
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
          await bounded(() => Promise.race([started, completion.then(() => { throw fail(); })]), Math.min(15000, preparationEnd - performance.now()));
          const startEnd = Math.min(preparationEnd, performance.now() + 15000);
          let snapshot;
          while (!snapshot && performance.now() < startEnd) {
            const text = await show();
            if (/^LoadState=not-found$/m.test(text)) await new Promise(done => setTimeout(done, 100));
            else snapshot = parseUnit(text, { group });
          }
          demand(snapshot); invocation = snapshot.invocation; main = procIdentity(snapshot.pid, group);
          demand(handshake.pid === main.pid && handshake.start === main.start && bridge.exitCode === null);
          demand(realpathSync(`/proc/${main.pid}/exe`) === realpathSync(process.execPath));
          const argv = readFileSync(`/proc/${main.pid}/cmdline`, "utf8").split("\0");
          demand(argv.includes(join(root, "tests/evaluation/booking-operator-child.mjs")) && argv.includes(name));
          sameProcess(main, procIdentity(main.pid, group));
          bridge.stdin.write(JSON.stringify({ cookie: seed.sessions.self.cookie().value, month: seed.month }) + "\n");
          reservationId = await bounded(() => completion, Math.min(remaining() - budget.cleanup, preparationEnd - performance.now() + budget.interaction + budget.cleanup));
          finishedAt = new Date().toISOString(); demand(!aborted); return reservationId;
        } finally { input.close(); endInteraction = undefined; }
      },
      async terminal() {
        for (let sample = 0; sample < 2; sample++) {
          const end = Math.min(cleanupEnd, performance.now() + 10000); let terminal = false;
          while (!terminal && performance.now() < end) {
            const text = await show();
            if (/^SubState=running$/m.test(text)) {
              const snapshot = parseUnit(text, expected()); sameProcess(main, procIdentity(snapshot.pid, group));
              await new Promise(done => setTimeout(done, 100));
            } else { parseUnit(text, expected(), true); terminal = true; }
          }
          demand(terminal); emptyGroup(group); await closed();
        }
        checkOwned(); remaining();
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
    });
    demand(outputId === reservationId);
    console.log(JSON.stringify({ issue: 1104, head, ...evidence, completedAt: finishedAt, actor: "fictional-self", reservationId,
      browser: "human-one-confirm-history", readback: "five-tables", cleanup: "owned-removed", evidence: "local-human-partial; Gate-A-D/930-401/608-release-unproved" }));
  } finally {
    bridge?.stdin.end(); process.stdin.removeListener("end", interrupt);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv.length === 6 && process.argv[2] === "--private-owner") {
      demand(process.platform === "linux"); await owner(process.argv[3], JSON.parse(process.argv[4]));
    } else {
      demand(process.argv.length === 5 && process.argv[2] === "--run" && process.argv[3] === "--head" && /^[a-f0-9]{40}$/.test(process.argv[4]));
      demand(process.platform === "linux" && /^v24\./.test(process.version) && process.getuid() > 0 && process.stdin.isTTY);
      demand(!Object.keys(process.env).some(k => /TOKEN|SECRET|PASSWORD|API_KEY|PROXY|NODE_OPTIONS|PWDEBUG|^DEBUG$|SSLKEYLOG|NODE_TLS/i.test(k)));
      const gui = guiEnvironment(Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"].filter(k => process.env[k]).map(k => [k, process.env[k]])));
      const temporary = mkdtempSync(join(tmpdir(), "nssscdl-operator-"));
      const env = cleanEnvironment(temporary), name = `nssscdl-operator-${randomBytes(16).toString("hex")}.service`;
      const manager = { PATH: env.PATH, HOME: temporary, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
      // Outer controller has the whole-run hard cap. Browser/Worker live in a
      // separate bounded unit, permitting their empty-cgroup proof before readback.
      const child = spawn("systemd-run", ["--user", "--pipe", "--wait", "--quiet", "--no-ask-password", `--unit=${name}`,
        `--working-directory=${root}`, "--property=Type=exec", "--property=Restart=no", "--property=RuntimeMaxSec=1800s",
        "--property=TimeoutStopSec=2s", "--property=KillMode=control-group", "--property=NoNewPrivileges=yes",
        "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        process.execPath, script, "--private-owner", process.argv[4], JSON.stringify(gui), name],
      { cwd: root, env: manager, stdio: ["pipe", "pipe", "ignore"] });
      // Private pipe EOF is observable even when a parent dies without a signal.
      process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
      child.stdin.on("error", () => {});
      let interrupted = false;
      const abort = () => { if (!interrupted) { interrupted = true; child.stdin.end(); } };
      process.on("SIGINT", abort); process.on("SIGTERM", abort);
      try { process.exitCode = await new Promise(done => { child.on("error", () => done(1)); child.on("exit", code => done(!interrupted && code === 0 ? 0 : 1)); }); }
      finally { process.stdin.unpipe(child.stdin); process.stdin.pause(); process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
    }
  } catch { console.error("BOOKING_OPERATOR_UNKNOWN; owned resources retained; do not retry"); process.exitCode = 1; }
}
