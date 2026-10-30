// #939: explicit prepared lifecycle only. Importing this module starts nothing.
import { execFile, spawn } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { root } from "./trusted-evaluation-seed.mjs";
import { checkBookingEnvironment, checkDirectoryIdentity, checkOwnedTree, directoryIdentity,
  origin, persistence, proxyOptions } from "./trusted-booking-seed.mjs";
import { verifyStudentAssets } from "./verify-student-assets.mjs";

const exec = promisify(execFile);
const binary = resolve(root, "node_modules/.bin/wrangler");
const failure = () => new Error("TRUSTED_BOOKING_WORKER_FAILED");
const check = (ok) => { if (!ok) throw failure(); };
const same = (a, b) => ["dev", "ino", "uid"].every((key) => a[key] === b[key]);

// Parent identity comes from the upstream run owner, never from argv or a request.
// Both createCertificate(TMPDIR) and the existing TLS browser-home are supported.
export function checkBookingCertificate(certificate, parent, identity, temporary) {
  try {
    check(parent === temporary || parent === resolve(temporary, "browser-home"));
    directoryIdentity(temporary);
    check((lstatSync(temporary).mode & 0o777) === 0o700);
    checkDirectoryIdentity(parent, identity);
    check((lstatSync(parent).mode & 0o777) === 0o700);
    return ["key", "cert"].map((key, i) => {
      const path = resolve(parent, i === 0 ? "server.key" : "server.pem");
      check(certificate[key] === path);
      const stat = lstatSync(path);
      check(stat.isFile() && stat.uid === identity.uid && stat.nlink === 1 && realpathSync(path) === path);
      return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    });
  } catch { throw failure(); }
}

export function bookingWorkerPreflight(input) {
  check(process.platform === "linux" && /^v24\./.test(process.version));
  const env = Object.freeze({ ...process.env });
  checkBookingEnvironment(env, JSON.parse(readFileSync(proxyOptions.configPath, "utf8")),
    [root, resolve(root, "tests"), resolve(root, "tests/evaluation")].flatMap((dir) => readdirSync(dir)));
  for (const path of ["package.json", "package-lock.json", "node_modules/wrangler/package.json"]) {
    const pkg = JSON.parse(readFileSync(resolve(root, path), "utf8"));
    check((path === "package.json" ? pkg.devDependencies.wrangler : path === "package-lock.json"
      ? pkg.packages["node_modules/wrangler"].version : pkg.version) === "4.146.0");
  }
  check(realpathSync(binary) === resolve(root, "node_modules/wrangler/bin/wrangler.js"));
  verifyStudentAssets(root);
  const temporary = env.TMPDIR, home = directoryIdentity(temporary);
  const parent = directoryIdentity(resolve(root, ".wrangler")), db = directoryIdentity(persistence);
  const files = checkBookingCertificate(input.certificate, input.certificateParent, input.certificateParentIdentity, temporary);
  const confirm = () => {
    checkDirectoryIdentity(temporary, home);
    checkDirectoryIdentity(resolve(root, ".wrangler"), parent);
    checkDirectoryIdentity(persistence, db);
    checkOwnedTree(persistence, db.uid);
    directoryIdentity(proxyOptions.persist.path);
    const current = checkBookingCertificate(input.certificate, input.certificateParent, input.certificateParentIdentity, temporary);
    check(current.every((file, i) => same(file, files[i])));
  };
  confirm();
  return { env, confirm };
}

const runtime = {
  preflight: bookingWorkerPreflight,
  spawn,
  read: readFileSync,
  async command(file, args, timeout, env) {
    return (await exec(file, args, { cwd: root, env, timeout, maxBuffer: 65536 })).stdout;
  },
  groupAlive(pid) {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw failure(); }
  },
  interrupt(pid) { process.kill(-pid, "SIGINT"); },
  now: () => performance.now(),
  sleep: () => new Promise((done) => setTimeout(done, 100)),
};

export const bookingListenerRows = (output) => {
  check(typeof output === "string" && output.length <= 65536 && !/[\r\x00]/.test(output));
  if (output === "") return [];
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  return lines.map((line) => {
    // ss -H -ltnp [-O --cgroup]: only the five TCP columns, optional
    // users tuples and optional mount-relative cgroup pathname are accepted.
    const match = /^[ \t]*LISTEN[ \t]+\d+[ \t]+\d+[ \t]+([^ \t]+)[ \t]+([^ \t]+)(?:[ \t]+(users:\(.*\)))?(?:[ \t]+cgroup:([^ \t]+))?[ \t]*$/.exec(line);
    check(match);
    const users = match[3];
    check(!users || /^users:\(\("(?:[^"\\\r\n]|\\[^\r\n])*",pid=[1-9]\d*,fd=\d+\)(?:,\("(?:[^"\\\r\n]|\\[^\r\n])*",pid=[1-9]\d*,fd=\d+\))*\)$/.test(users));
    check(/^(?:[\d.]+|\[[a-fA-F\d:]+\]|\*):(?:\d+|\*)$/.test(match[2]));
    const pids = [...(users ?? "").matchAll(/\("(?:[^"\\\r\n]|\\[^\r\n])*",pid=([1-9]\d*),fd=\d+\)/g)].map(m => m[1]);
    return { address: match[1], pids, cgroup: match[4] };
  });
};
const rows = bookingListenerRows;
const live = (child) => child && !child.spawnFailed && child.exitCode === null && child.signalCode === null;
const exited = (child) => Number.isInteger(child.exitCode) || typeof child.signalCode === "string";

// Test-only finite effects seam, analogous to #937's proxy factory. The default
// implementation fixes binary/config/persist/flags and never accepts overrides.
export function createBookingWorkerPort(input, effects = runtime, observe) {
  let firstFailure = false, observationClosed = false;
  const emit = (kind, value) => {
    if (observationClosed) throw failure();
    try {
      // No error/raw data or asynchronous observation is accepted.
      if (observe !== undefined && (typeof observe !== "function" || observe(kind, value) !== undefined)) throw failure();
    } catch { observationClosed = true; throw failure(); }
  };
  const recordFailure = value => {
    if (!firstFailure) { firstFailure = true; emit("failure", value); }
  };
  try {
    input = Object.freeze({ certificate: Object.freeze({ key: input.certificate.key, cert: input.certificate.cert }),
      certificateParent: input.certificateParent, certificateParentIdentity: Object.freeze({ ...input.certificateParentIdentity }) });
  } catch { recordFailure("preflight"); throw failure(); }
  let child, pid, setup, unit, startAttempted = false, stopAttempted = false, ready = false;
  let starting = false;
  let position = "unknown", stopPosition = "unknown", stopFinished = false;
  const startCheck = (ok, kind) => { if (!ok) { recordFailure(kind); throw failure(); } };
  const progress = value => { stopPosition = value; emit("stop", value); };
  const command = async (file, args, deadline) => {
    const remaining = Math.floor(deadline - effects.now());
    check(remaining > 0);
    return effects.command(file, args, Math.min(5000, remaining), setup.env);
  };
  const group = async (processId, deadline) => {
    try {
      const result = (await command("ps", ["-o", "pgid=", "-p", String(processId)], deadline)).trim();
      check(/^[1-9]\d*$/.test(result));
      return result;
    } catch { if (starting) recordFailure("group"); throw failure(); }
  };
  const alive = () => {
    try { const result = effects.groupAlive(pid); check(typeof result === "boolean"); return result; }
    catch { if (starting) recordFailure("group"); throw failure(); }
  };
  const groupCheck = ok => {
    if (!ok) { if (starting) recordFailure("group"); throw failure(); }
  };
  const childFailure = () => {
    ready = false;
    if (starting) {
      try { recordFailure("spawn"); }
      catch { /* Failed hook is closed; the child liveness check rejects startup. */ }
    }
  };
  const closed = async (deadline) => {
    check(rows(await command("ss", ["-H", "-ltn", "sport = :8789"], deadline)).length === 0);
  };
  const membership = () => {
    const current = effects.read("/proc/self/cgroup", "utf8");
    check(typeof current === "string" && /^0::\/system.slice\/nssscdl-browser-[a-f0-9]{32}\.service\n$/.exec(current)?.[0] === current);
    if (unit === undefined) unit = current;
    check(current === unit);
    return current.slice(3, -1);
  };
  const ownedListeners = async (deadline) => {
    const path = membership();
    const booking = rows(await command("ss", ["-H", "-ltnp", "sport = :8789"], deadline));
    check(booking.length <= 1);
    for (const row of booking) {
      check(row.address === "127.0.0.1:8789" && row.pids.length > 0);
      for (const owner of row.pids) groupCheck(await group(owner, deadline) === String(pid));
    }
    // Startup may wait for the reserved port; it cannot become ready (or
    // authorize a stop signal) without the filtered positive control below.
    if (!booking.length) { membership(); check(effects.now() < deadline); return false; }
    let all;
    try {
      all = rows(await command("ss", ["-H", "-ltnp", "-O", "--cgroup", "cgroup", "=", resolve("/sys/fs/cgroup", `.${path}`)], deadline));
    } catch { if (starting) recordFailure("listener-unattributed"); throw failure(); }
    for (const row of all) {
      if (row.cgroup !== path) {
        if (starting) recordFailure(/:8789$/.test(row.address) ? "booking-listener" : "listener-unattributed");
        throw failure();
      }
      if (!/^(127\.0\.0\.1|\[::1\]):\d+$/.test(row.address)) {
        if (starting) recordFailure("owned-listener");
        throw failure();
      }
    }
    const control = all.filter(row => /:8789$/.test(row.address));
    check(control.length === 1 && control[0].address === booking[0].address);
    const owners = row => [...new Set(row.pids)].sort();
    check(control[0].pids.length > 0 && JSON.stringify(owners(control[0])) === JSON.stringify(owners(booking[0])));
    for (const owner of owners(control[0])) groupCheck(await group(owner, deadline) === String(pid));
    membership(); check(effects.now() < deadline);
    return true;
  };
  return Object.freeze({
    async start() {
      let accepted = false;
      try {
        check(!startAttempted && !stopAttempted);
        startAttempted = true; starting = true; accepted = true;
        position = "preflight";
        setup = effects.preflight(input);
        position = "unknown";
        const deadline = effects.now() + 30000; // Existing read-only startup budget.
        position = "preflight";
        membership();
        position = "booking-listener";
        await closed(deadline);
        position = "preflight";
        setup.confirm();
        membership(); check(effects.now() < deadline);
        position = "spawn";
        child = effects.spawn(binary, ["dev", "--config", relative(root, proxyOptions.configPath),
          "--ip", "127.0.0.1", "--port", "8789", "--local-protocol", "https",
          "--persist-to", relative(root, persistence),
          "--https-key-path", input.certificate.key, "--https-cert-path", input.certificate.cert],
        { cwd: root, env: setup.env, detached: true, stdio: "ignore" });
        child.on("error", () => { child.spawnFailed = true; childFailure(); });
        child.on("exit", childFailure);
        pid = child.pid;
        check(Number.isSafeInteger(pid) && pid > 1);
        position = "unknown";
        while (effects.now() < deadline) {
          position = "spawn";
          startCheck(live(child), "spawn");
          groupCheck(alive() && await group(pid, deadline) === String(pid));
          position = "booking-listener";
          if (await ownedListeners(deadline)) {
            position = "preflight";
            setup.confirm();
            position = "spawn";
            startCheck(live(child) && child.pid === pid, "spawn");
            groupCheck(alive());
            membership(); check(effects.now() < deadline);
            ready = true;
            return origin; // Transport preparation only; no HTTP/TLS/write proof.
          }
          position = "unknown";
          await effects.sleep();
        }
        position = "deadline";
        throw failure();
      } catch { ready = false; recordFailure(position); throw failure(); }
      finally { if (accepted) starting = false; }
    },
    async stop() {
      let accepted = false;
      try {
        check(startAttempted && !starting && !stopAttempted);
        stopAttempted = true; accepted = true; ready = false; // Spent before any async effect.
        progress("ownership");
        check(child && Number.isSafeInteger(pid) && pid > 1 && child.pid === pid);
        const deadline = effects.now() + 10000; // No force-kill or second signal.
        membership();
        if (alive()) {
          check(live(child) && await group(pid, deadline) === String(pid));
          check(await ownedListeners(deadline));
          check(live(child) && alive());
          membership(); check(effects.now() < deadline);
          progress("signal");
          effects.interrupt(pid); // Exactly one owned group stop request.
          progress("signal-sent");
        }
        progress("wait");
        while (alive() && effects.now() < deadline) await effects.sleep();
        check(!alive() && exited(child));
        progress("port");
        membership();
        await closed(deadline); // Never reuse 8788's stopWorker result.
        membership(); check(effects.now() < deadline);
        progress("confirmed"); stopFinished = true;
        return Object.freeze({ stopped: true, portClosed: true });
      } catch {
        if (!stopFinished && accepted) {
          stopFinished = true;
          const detail = { ownership: "ownership-failed", signal: "signal-failed", wait: "wait-failed", port: "port-failed" }[stopPosition] ?? "unknown";
          emit("stop", detail);
        }
        throw failure(); // Retain child/files and spent state on unknown result.
      }
    },
    isReady() { return ready && !stopAttempted && live(child); },
  });
}
