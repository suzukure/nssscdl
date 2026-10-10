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

function preflight(input) {
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
  preflight,
  spawn,
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

const rows = (output) => {
  check(typeof output === "string");
  return output.trim() ? output.trim().split("\n").map((line) => {
    const fields = line.trim().split(/\s+/);
    check(fields[0] === "LISTEN" && fields.length >= 5);
    return { address: fields[3], pids: [...line.matchAll(/pid=(\d+)/g)].map((m) => m[1]) };
  }) : [];
};
const live = (child) => child && !child.spawnFailed && child.exitCode === null && child.signalCode === null;
const exited = (child) => Number.isInteger(child.exitCode) || typeof child.signalCode === "string";

// Test-only finite effects seam, analogous to #937's proxy factory. The default
// implementation fixes binary/config/persist/flags and never accepts overrides.
export function createBookingWorkerPort(input, effects = runtime) {
  try {
    input = Object.freeze({ certificate: Object.freeze({ key: input.certificate.key, cert: input.certificate.cert }),
      certificateParent: input.certificateParent, certificateParentIdentity: Object.freeze({ ...input.certificateParentIdentity }) });
  } catch { throw failure(); }
  let child, pid, setup, startAttempted = false, stopAttempted = false, ready = false;
  let starting = false;
  const command = async (file, args, deadline) => {
    const remaining = Math.floor(deadline - effects.now());
    check(remaining > 0);
    return effects.command(file, args, Math.min(5000, remaining), setup.env);
  };
  const group = async (processId, deadline) => {
    const result = (await command("ps", ["-o", "pgid=", "-p", String(processId)], deadline)).trim();
    check(/^[1-9]\d*$/.test(result));
    return result;
  };
  const alive = () => { const result = effects.groupAlive(pid); check(typeof result === "boolean"); return result; };
  const closed = async (deadline) => {
    check(rows(await command("ss", ["-H", "-ltn", "sport = :8789"], deadline)).length === 0);
  };
  const ownedListeners = async (deadline) => {
    const booking = rows(await command("ss", ["-H", "-ltnp", "sport = :8789"], deadline));
    check(booking.length <= 1);
    for (const row of booking) {
      check(row.address === "127.0.0.1:8789" && row.pids.length > 0);
      for (const owner of row.pids) check(await group(owner, deadline) === String(pid));
    }
    const all = rows(await command("ss", ["-H", "-ltnp"], deadline));
    check(all.filter((row) => /:8789$/.test(row.address)).length === booking.length);
    for (const row of all) {
      check(row.pids.length > 0); // Hidden ownership is unknown, never evidence.
      if (/:8789$/.test(row.address)) {
        check(row.address === "127.0.0.1:8789");
        for (const owner of row.pids) check(await group(owner, deadline) === String(pid));
      }
      for (const owner of row.pids) {
        if (await group(owner, deadline) === String(pid))
          check(/^(127\.0\.0\.1|\[::1\]):\d+$/.test(row.address));
      }
    }
    return booking.length === 1;
  };
  return Object.freeze({
    async start() {
      let accepted = false;
      try {
        check(!startAttempted && !stopAttempted);
        startAttempted = true; starting = true; accepted = true;
        setup = effects.preflight(input);
        const deadline = effects.now() + 30000; // Existing read-only startup budget.
        await closed(deadline);
        setup.confirm();
        child = effects.spawn(binary, ["dev", "--config", relative(root, proxyOptions.configPath),
          "--ip", "127.0.0.1", "--port", "8789", "--local-protocol", "https",
          "--persist-to", relative(root, persistence),
          "--https-key-path", input.certificate.key, "--https-cert-path", input.certificate.cert],
        { cwd: root, env: setup.env, detached: true, stdio: "ignore" });
        child.on("error", () => { child.spawnFailed = true; ready = false; });
        child.on("exit", () => { ready = false; });
        pid = child.pid;
        check(Number.isSafeInteger(pid) && pid > 1);
        while (effects.now() < deadline) {
          check(live(child) && alive() && await group(pid, deadline) === String(pid));
          if (await ownedListeners(deadline)) {
            setup.confirm();
            check(live(child) && child.pid === pid && alive());
            ready = true;
            return origin; // Transport preparation only; no HTTP/TLS/write proof.
          }
          await effects.sleep();
        }
        throw failure();
      } catch { ready = false; throw failure(); }
      finally { if (accepted) starting = false; }
    },
    async stop() {
      try {
        check(startAttempted && !starting && !stopAttempted);
        stopAttempted = true; ready = false; // Spent before any async effect.
        check(child && Number.isSafeInteger(pid) && pid > 1 && child.pid === pid);
        const deadline = effects.now() + 10000; // No force-kill or second signal.
        if (alive()) {
          check(live(child) && await group(pid, deadline) === String(pid));
          await ownedListeners(deadline);
          check(live(child) && alive());
          effects.interrupt(pid); // Exactly one owned group stop request.
        }
        while (alive() && effects.now() < deadline) await effects.sleep();
        check(!alive() && exited(child));
        await closed(deadline); // Never reuse 8788's stopWorker result.
        return Object.freeze({ stopped: true, portClosed: true });
      } catch { throw failure(); } // Retain child/files and spent state on unknown result.
    },
    isReady() { return ready && !stopAttempted && live(child); },
  });
}
