// Separate user-unit Port. Formal system.slice membership and settings stay sealed.
import { execFile, spawn } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { resolve, relative } from "node:path";
import { promisify } from "node:util";
import { root } from "./trusted-evaluation-seed.mjs";
import { bookingWranglerEntry, origin, persistence, proxyOptions } from "./trusted-booking-seed.mjs";
import { bookingWorkerPreflight, bookingListenerRows } from "./trusted-booking-worker.mjs";
import { demand, fail, procIdentity, sameProcess, userGroup } from "./booking-operator-unit.mjs";
import { directStage } from "./booking-operator-progress.mjs";
const exec = promisify(execFile);
const runtime = {
  setup: bookingWorkerPreflight, spawn, read: readFileSync, stat: lstatSync, uid: process.getuid?.(),
  now: () => performance.now(), sleep: () => new Promise(done => setTimeout(done, 100)),
  async command(file, args, env, timeout) { return (await exec(file, args, { cwd: root, env, timeout, maxBuffer: 65536 })).stdout; },
  alive(pid) { try { process.kill(-pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw fail(); } },
  stop(pid) { process.kill(-pid, "SIGINT"); },
};
export function createOperatorWorker(input, unitName, effects = runtime, stage = directStage) {
  const group = userGroup(effects.uid, unitName);
  let setup, child, identity, attempted = false, stopAttempted = false, ready = false, starting = false;
  const member = pid => procIdentity(pid, group, effects);
  const self = () => demand(effects.read("/proc/self/cgroup", "utf8") === `0::${group}\n`);
  const command = (file, args, end) => { demand(effects.now() < end); return effects.command(file, args, setup.env, Math.min(5000, end - effects.now())); };
  const closed = async end => demand(bookingListenerRows(await command("ss", ["-H", "-ltn", "sport = :8789"], end)).length === 0);
  const processGroup = async end => {
    self(); sameProcess(identity, member(child.pid));
    demand(effects.alive(child.pid));
    demand((await command("ps", ["-o", "pgid=", "-p", String(child.pid)], end)).trim() === String(child.pid));
  };
  const owns = async (end, checkProcess = true) => {
    if (checkProcess) await processGroup(end);
    const rows = bookingListenerRows(await command("ss", ["-H", "-ltnp", "sport = :8789"], end));
    demand(rows.length <= 1); if (!rows.length) return false;
    demand(rows[0].address === "127.0.0.1:8789" && rows[0].pids.length > 0);
    const all = bookingListenerRows(await command("ss", ["-H", "-ltnp", "-O", "--cgroup", "cgroup", "=", resolve("/sys/fs/cgroup", `.${group}`)], end));
    demand(all.every(row => row.cgroup === group && /^(127\.0\.0\.1|\[::1\]):\d+$/.test(row.address)));
    const control = all.filter(row => row.address.endsWith(":8789"));
    demand(control.length === 1 && control[0].address === rows[0].address &&
      JSON.stringify([...control[0].pids].sort()) === JSON.stringify([...rows[0].pids].sort()));
    for (const owner of rows[0].pids) {
      member(Number(owner)); demand((await command("ps", ["-o", "pgid=", "-p", owner], end)).trim() === String(child.pid));
    }
    sameProcess(identity, member(child.pid)); self(); demand(effects.now() < end); return true;
  };
  return Object.freeze({
    async start() {
      demand(!attempted && !stopAttempted); attempted = true; starting = true;
      try {
        const end = await stage("worker-preflight", async () => {
          setup = effects.setup(input); self(); const end = effects.now() + 30000;
          await closed(end); setup.confirm();
          return end;
        });
        stage("worker-spawn", () => {
          child = effects.spawn(process.execPath, [bookingWranglerEntry, "dev", "--config", relative(root, proxyOptions.configPath),
            "--ip", "127.0.0.1", "--port", "8789", "--local-protocol", "https", "--persist-to", relative(root, persistence),
            "--https-key-path", input.certificate.key, "--https-cert-path", input.certificate.cert],
          { cwd: root, env: setup.env, detached: true, stdio: "ignore" });
          child.on("error", () => { ready = false; }); child.on("exit", () => { ready = false; });
        });
        const diagnostic = stage !== directStage;
        const identify = () => { identity = member(child.pid); };
        if (diagnostic) await stage("worker-process", async () => {
          identify();
          demand(child.exitCode === null && child.signalCode === null);
          await processGroup(end);
        });
        else identify();
        return await stage("worker-listener", async () => {
          let recheck = !diagnostic;
          while (effects.now() < end) {
            demand(child.exitCode === null && child.signalCode === null);
            if (await owns(end, recheck)) { setup.confirm(); ready = true; return origin; }
            recheck = true;
            await effects.sleep();
          }
          throw fail();
        });
      } finally { starting = false; }
    },
    async stop() {
      demand(attempted && !starting && !stopAttempted); stopAttempted = true; ready = false;
      demand(child && identity); self(); setup.confirm();
      const end = effects.now() + 10000;
      if (effects.alive(child.pid)) {
        demand(child.exitCode === null && child.signalCode === null && await owns(end));
        sameProcess(identity, member(child.pid)); self(); effects.stop(child.pid);
      }
      while (effects.alive(child.pid) && effects.now() < end) await effects.sleep();
      demand(!effects.alive(child.pid) && (Number.isInteger(child.exitCode) || typeof child.signalCode === "string"));
      self(); await closed(end); self(); return Object.freeze({ stopped: true, portClosed: true });
    },
    hasChild: () => child !== undefined,
    isReady: () => ready && !stopAttempted && child.exitCode === null && child.signalCode === null,
  });
}
