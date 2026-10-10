// Finite synthetic effects only: no Worker/Chrome/TLS/network/D1 startup.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import production from "../../src/index.ts";
import { root } from "./trusted-evaluation-seed.mjs";
import { directoryIdentity, origin, persistence, proxyOptions } from "./trusted-booking-seed.mjs";
import { checkBookingCertificate, createBookingWorkerPort } from "./trusted-booking-worker.mjs";

const fixed = (e) => e instanceof Error && e.message === "TRUSTED_BOOKING_WORKER_FAILED" && !("cause" in e);
const input = { certificate: { key: "/fixture/server.key", cert: "/fixture/server.pem" },
  certificateParent: "/fixture", certificateParentIdentity: { dev: 1, ino: 2, uid: 3 } };
// ss columns follow the existing waitForWorker fixture contract; external
// Wrangler/ss compatibility is intentionally not claimed by these finite rows.
const listener = (address = "127.0.0.1:8789", pid = 42) =>
  `LISTEN 0 128 ${address} 0.0.0.0:*${pid === null ? "" : ` users:((\"node\",pid=${pid},fd=3))`}`;
function fixture(options = {}) {
  let clock = 0, spawned = 0, signals = 0, commands = 0, confirms = 0, active = false, stopped = false;
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
  const calls = [];
  const effects = {
    preflight(value) {
      assert.deepEqual(value, input);
      if (options.preflight) throw new Error("private-canary");
      return { env: { WRANGLER_SEND_METRICS: "false" }, confirm() {
        confirms++; if (options.drift && confirms === 2) throw new Error("private-canary");
      } };
    },
    spawn(file, args, spawnOptions) {
      spawned++; calls.push({ file, args, spawnOptions }); active = true;
      if (options.spawnThrows) throw new Error("private-canary");
      if (options.earlyExit) { child.exitCode = 1; active = false; }
      if (options.unknownExit) delete child.exitCode;
      if (options.noPid) delete child.pid;
      return child;
    },
    async command(file, args, timeout) {
      commands++; assert.ok(timeout > 0 && timeout <= 5000);
      if (options.commandThrows) throw new Error("private-canary");
      if (file === "ps") return String(options.groups?.[args[3]] ?? (args[3] === "88" ? 88 : 42));
      assert.equal(file, "ss");
      if (args[1] === "-ltn") {
        if (!spawned) return options.preexisting ?? "";
        return stopped && !options.portRemains ? "" : (options.booking ?? listener());
      }
      if (!active || options.neverReady) return "";
      if (args.length === 3) return options.booking ?? listener();
      return options.all ?? options.booking ?? listener();
    },
    groupAlive() { if (options.unknownGroup) return undefined; return active; },
    interrupt(pid) {
      assert.equal(pid, 42); signals++;
      if (options.stopThrows) throw new Error("private-canary");
      if (!options.stopTimeout) { active = false; stopped = true; child.signalCode = "SIGINT"; child.emit("exit"); }
      if (options.unknownTerminal) { delete child.exitCode; delete child.signalCode; }
    },
    now: () => clock,
    sleep: async () => { clock += 1000; },
  };
  return { port: createBookingWorkerPort(input, effects), child, calls, effects,
    counts: () => ({ spawned, signals, commands, confirms }), exit() { active = false; child.exitCode = 1; child.emit("exit"); } };
}

test("#939: import/creation are dormant; exact independent local CLI and single owned stop", async () => {
  const f = fixture();
  assert.equal(f.counts().spawned, 0); assert.equal(f.counts().commands, 0); assert.equal(f.port.isReady(), false);
  assert.equal(await f.port.start(), origin); assert.equal(f.port.isReady(), true);
  assert.deepEqual(f.calls, [{ file: resolve(root, "node_modules/.bin/wrangler"), args: [
    "dev", "--config", "tests/evaluation/wrangler.reservation.jsonc", "--ip", "127.0.0.1", "--port", "8789",
    "--local-protocol", "https", "--persist-to", ".wrangler/student-booking-evaluation",
    "--https-key-path", input.certificate.key, "--https-cert-path", input.certificate.cert,
  ], spawnOptions: { cwd: root, env: { WRANGLER_SEND_METRICS: "false" }, detached: true, stdio: "ignore" } }]);
  assert.equal(proxyOptions.configPath, resolve(root, "tests/evaluation/wrangler.reservation.jsonc"));
  assert.equal(persistence, resolve(root, ".wrangler/student-booking-evaluation"));
  assert.equal(proxyOptions.remoteBindings, false);
  assert.deepEqual(await f.port.stop(), { stopped: true, portClosed: true });
  assert.equal(f.port.isReady(), false);
  const before = f.counts();
  await assert.rejects(f.port.stop(), fixed); await assert.rejects(f.port.start(), fixed);
  assert.deepEqual(f.counts(), before); assert.equal(before.spawned, 1); assert.equal(before.signals, 1);
});

test("#939: preexisting/unknown port and preflight failure have no spawn or signal", async () => {
  for (const options of [{ preexisting: listener() }, { preexisting: listener("0.0.0.0:8789", null) },
    { preexisting: "unknown" }, { preflight: true }, { commandThrows: true }]) {
    const f = fixture(options);
    await assert.rejects(f.port.start(), fixed); await assert.rejects(f.port.start(), fixed);
    await assert.rejects(f.port.stop(), fixed);
    assert.equal(f.counts().spawned, 0); assert.equal(f.counts().signals, 0);
  }
});

test("#939: ambiguous socket, PGID, hidden owner and nonloopback inspector never become ready", async () => {
  for (const options of [
    { booking: listener("0.0.0.0:8789") }, { booking: listener("[::1]:8789") },
    { booking: listener("127.0.0.1:8788") }, { booking: `${listener()}\n${listener()}` },
    { booking: listener("127.0.0.1:8789", null) }, { groups: { 42: 88 } }, { groups: { 42: "" } },
    { booking: listener("127.0.0.1:8789", 43), groups: { 43: 88 } },
    { all: `${listener()}\n${listener("0.0.0.0:9229", 43)}` },
    { all: `${listener()}\n${listener("127.0.0.1:9229", null)}` },
    { all: listener("127.0.0.1:8789", 88) }, { all: "" },
    { earlyExit: true }, { unknownExit: true }, { noPid: true }, { unknownGroup: true },
    { spawnThrows: true }, { drift: true }, { neverReady: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.port.start(), fixed); assert.equal(f.port.isReady(), false);
    const before = f.counts(); await assert.rejects(f.port.start(), fixed);
    assert.deepEqual(f.counts(), before); assert.equal(before.spawned, 1); assert.equal(before.signals, 0);
  }
});

test("#939: owned inspector may use loopback; unrelated 8088 is never signalled", async () => {
  const f = fixture({ all: `${listener()}\n${listener("[::1]:9229", 43)}\n${listener("0.0.0.0:8088", 88)}` });
  await f.port.start(); await f.port.stop(); assert.equal(f.counts().signals, 1);
});

test("#939: failure/unknown stop is terminal, retains child and never repeats kill/restart", async () => {
  for (const options of [{ stopThrows: true }, { stopTimeout: true }, { portRemains: true }, { unknownTerminal: true }]) {
    const f = fixture(options); await f.port.start();
    await assert.rejects(f.port.stop(), fixed); assert.equal(f.port.isReady(), false);
    const before = f.counts();
    await assert.rejects(f.port.stop(), fixed); await assert.rejects(f.port.start(), fixed);
    assert.deepEqual(f.counts(), before); assert.equal(before.signals, 1); assert.equal(before.spawned, 1);
    assert.equal(f.child.pid, 42);
  }
});

test("#939: ownership loss or unknown command immediately before stop suppresses signal", async () => {
  for (const kind of ["group", "listener", "command", "unknown", "pid", "exit"]) {
    const options = {}, f = fixture(options); await f.port.start();
    if (kind === "group") options.groups = { 42: 88 };
    if (kind === "listener") options.booking = listener("127.0.0.1:8789", 88);
    if (kind === "command") options.commandThrows = true;
    if (kind === "unknown") options.unknownGroup = true;
    if (kind === "pid") f.child.pid = 88;
    if (kind === "exit") f.child.exitCode = 1; // Parent gone, group still alive: unknown descendants.
    await assert.rejects(f.port.stop(), fixed); await assert.rejects(f.port.stop(), fixed);
    assert.equal(f.counts().signals, 0);
  }
});

test("#939: observed early exit can prove closed without signalling unrelated resources", async () => {
  const options = { earlyExit: true }, f = fixture(options);
  await assert.rejects(f.port.start(), fixed); options.portRemains = false;
  // The finite port observation is independent of the exited process.
  const command = f.effects.command;
  f.effects.command = (file, args, ...rest) => args[1] === "-ltn" ? Promise.resolve("") : command(file, args, ...rest);
  assert.deepEqual(await f.port.stop(), { stopped: true, portClosed: true }); assert.equal(f.counts().signals, 0);
});

test("#939: concurrent start/stop cannot spend another start's foreground ownership", async () => {
  const f = fixture(); const first = f.port.start();
  await assert.rejects(f.port.start(), fixed); await assert.rejects(f.port.stop(), fixed);
  await first; await f.port.stop(); assert.equal(f.counts().spawned, 1); assert.equal(f.counts().signals, 1);
  const second = fixture(); await second.port.start();
  const stopping = second.port.stop(); await assert.rejects(second.port.stop(), fixed);
  await stopping; assert.equal(second.counts().signals, 1);
});

test("#939: caller overrides never select CLI; asynchronous child failure revokes ready", async () => {
  const f = fixture();
  const port = createBookingWorkerPort({ ...input, config: "other", port: 8788, persist: "other",
    env: { TOKEN: "private-canary" }, argv: ["--remote"], headers: { cookie: "private-canary" } }, f.effects);
  await port.start();
  assert.equal(f.calls[0].args.includes("other"), false); assert.equal(f.calls[0].args.includes("--remote"), false);
  f.child.emit("error", new Error("private-canary")); assert.equal(port.isReady(), false);
  await assert.rejects(port.stop(), fixed); assert.equal(f.counts().signals, 0);
});

test("#939: run-owned generated certificate paths/parents reject substitution without reading secrets", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "booking-worker-fixture-"));
  try {
    for (const parent of [temporary, resolve(temporary, "browser-home")]) {
      if (parent !== temporary) mkdirSync(parent, { mode: 0o700 });
      const certificate = { key: resolve(parent, "server.key"), cert: resolve(parent, "server.pem") };
      writeFileSync(certificate.key, "fixture-key"); writeFileSync(certificate.cert, "fixture-cert");
      const identity = directoryIdentity(parent);
      assert.equal(checkBookingCertificate(certificate, parent, identity, temporary).length, 2);
      assert.throws(() => checkBookingCertificate({ ...certificate, key: certificate.cert }, parent, identity, temporary), fixed);
      assert.throws(() => checkBookingCertificate(certificate, parent, { ...identity, ino: -1 }, temporary), fixed);
      const saved = resolve(parent, "saved"); renameSync(certificate.key, saved);
      symlinkSync(saved, certificate.key);
      assert.throws(() => checkBookingCertificate(certificate, parent, identity, temporary), fixed);
      rmSync(certificate.key); linkSync(saved, certificate.key);
      assert.throws(() => checkBookingCertificate(certificate, parent, identity, temporary), fixed);
      rmSync(certificate.key); renameSync(saved, certificate.key);
      chmodSync(parent, 0o755);
      assert.throws(() => checkBookingCertificate(certificate, parent, identity, temporary), fixed);
      chmodSync(parent, 0o700);
    }
    const other = resolve(temporary, "other"); mkdirSync(other, { mode: 0o700 });
    assert.throws(() => checkBookingCertificate({}, other, directoryIdentity(other), temporary), fixed);
  } finally { rmSync(temporary, { recursive: true }); } // Only synthetic fixture files.
});

test("#939: sealed 8788 CLI/config and Production 503 remain separate", async () => {
  const source = readFileSync("tests/evaluation/local-https-smoke.mjs", "utf8");
  assert.ok(source.includes('"--port", "8788"')); assert.ok(source.includes('"sport = :8788"'));
  assert.ok(source.includes('const persist = ".wrangler/student-read-only-evaluation"'));
  const config = JSON.parse(readFileSync("tests/evaluation/wrangler.jsonc", "utf8"));
  assert.equal(config.dev.port, 8788); assert.equal(config.d1_databases[0].binding, "EVALUATION_READ_DB");
  // Detailed design §9.2 requires default entrypoint to remain unavailable.
  for (const path of ["/student", "/api/auth/student/csrf", "/api/me/reservations",
    "/api/me/reservations/preview", "/api/me/schedule-months/2026-11", "/unknown"]) {
    for (const method of ["GET", "POST"]) {
      const response = production.fetch(new Request(`https://production.example${path}`, { method }));
      assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});
