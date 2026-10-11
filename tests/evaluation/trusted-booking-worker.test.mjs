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
function fixture(options = {}, observe) {
  let clock = 0, spawned = 0, signals = 0, commands = 0, confirms = 0, active = false, stopped = false;
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
  const calls = [], order = [];
  const effects = {
    preflight(value) {
      order.push("preflight");
      assert.deepEqual(value, input);
      if (options.preflight) throw new Error("private-canary");
      return { env: { WRANGLER_SEND_METRICS: "false" }, confirm() {
        order.push("confirm");
        confirms++; if (options.drift && confirms === 2) throw new Error("private-canary");
      } };
    },
    spawn(file, args, spawnOptions) {
      order.push("spawn");
      spawned++; calls.push({ file, args, spawnOptions }); active = true;
      if (options.spawnThrows) throw new Error("private-canary");
      if (options.earlyExit) { child.exitCode = 1; active = false; }
      if (options.unknownExit) delete child.exitCode;
      if (options.noPid) delete child.pid;
      return child;
    },
    async command(file, args, timeout) {
      order.push(file === "ps" ? `ps:${args[3]}` : args.join(" "));
      commands++; assert.ok(timeout > 0 && timeout <= 5000);
      if (options.commandThrows) throw new Error("private-canary");
      if (file === "ps") {
        if (options.psThrows) throw new Error("private-canary");
        return String(options.groups?.[args[3]] ?? (args[3] === "88" ? 88 : 42));
      }
      assert.equal(file, "ss");
      if (args[1] === "-ltn") {
        if (!spawned) return options.preexisting ?? "";
        return stopped && !options.portRemains ? "" : (options.booking ?? listener());
      }
      if (!active || options.neverReady) return "";
      if (args.length === 3) return options.booking ?? listener();
      return options.all ?? options.booking ?? listener();
    },
    groupAlive() { order.push("alive"); if (options.unknownGroup) return undefined; return active; },
    interrupt(pid) {
      order.push("SIGINT");
      assert.equal(pid, 42); signals++;
      if (options.stopThrows) throw new Error("private-canary");
      if (!options.stopTimeout) { active = false; stopped = true; child.signalCode = "SIGINT"; child.emit("exit"); }
      if (options.unknownTerminal) { delete child.exitCode; delete child.signalCode; }
    },
    now: () => clock,
    sleep: async () => { order.push("sleep"); clock += 1000; },
  };
  return { port: createBookingWorkerPort(input, effects, observe), child, calls, effects, order,
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

// #976 oracles: confirmed Issue's fixed positions, independent of error text.
test("#976 first startup failure uses the most direct fixed position, once; stop never overwrites it", async () => {
  const cases = [
    [{ preflight: true }, "preflight"], [{ drift: true }, "preflight"],
    [{ spawnThrows: true }, "spawn"], [{ noPid: true }, "spawn"], [{ earlyExit: true }, "spawn"],
    [{ unknownExit: true }, "spawn"], [{ unknownGroup: true }, "group"],
    [{ psThrows: true }, "group"],
    [{ groups: { 42: 88 } }, "group"], [{ groups: { 42: "invalid" } }, "group"],
    [{ booking: listener("127.0.0.1:8789", 43), groups: { 43: 88 } }, "group"],
    [{ preexisting: listener() }, "booking-listener"], [{ commandThrows: true }, "booking-listener"],
    [{ booking: "malformed" }, "booking-listener"], [{ booking: `${listener()}\n${listener()}` }, "booking-listener"],
    [{ booking: listener("0.0.0.0:8789") }, "booking-listener"],
    [{ booking: listener("127.0.0.1:8789", null) }, "booking-listener"],
    [{ all: listener("127.0.0.1:8789", null) }, "booking-listener"],
    [{ all: "" }, "booking-listener"],
    [{ all: `${listener()}\n${listener("0.0.0.0:8088", null)}` }, "listener-unattributed"],
    [{ all: `${listener()}\n${listener("0.0.0.0:9229", 43)}` }, "owned-listener"],
    [{ neverReady: true }, "deadline"],
  ];
  for (const [options, expected] of cases) {
    const observed = [], f = fixture(options, (kind, value) => { observed.push([kind, value]); });
    await assert.rejects(f.port.start(), fixed);
    await f.port.stop().catch(error => assert.ok(fixed(error)));
    const before = f.counts(), saved = [...observed];
    await assert.rejects(f.port.start(), fixed); await assert.rejects(f.port.stop(), fixed);
    assert.deepEqual(observed.filter(([kind]) => kind === "failure"), [["failure", expected]], JSON.stringify(options));
    assert.deepEqual(observed, saved); assert.deepEqual(f.counts(), before);
    assert.equal(before.signals, options.drift || options.neverReady ? 1 : 0, JSON.stringify(options));
    if (options.neverReady) assert.equal(f.order.filter(step => step === "sleep").length, 30);
  }
  const observed = [], f = fixture({}, (kind, value) => { observed.push([kind, value]); });
  f.effects.sleep = async () => { throw new Error("private-canary"); };
  f.effects.command = async (file, args) => file === "ps" ? "42" : "";
  await assert.rejects(f.port.start(), fixed);
  assert.deepEqual(observed, [["failure", "unknown"]]);
  const create = [];
  assert.throws(() => createBookingWorkerPort(null, {}, (kind, value) => { create.push([kind, value]); }), fixed);
  assert.deepEqual(create, [["failure", "preflight"]]);
});

test("#976 success, unrelated known PGID, owned loopback and stop boundary snapshots preserve effect order", async () => {
  for (const options of [{}, { all: `${listener()}\n${listener("0.0.0.0:8088", 88)}` },
    { all: `${listener()}\n${listener("[::1]:9229", 43)}` }]) {
    const plain = fixture(options), observed = [], traced = fixture(options, (kind, value) => { observed.push([kind, value]); });
    await plain.port.start(); await plain.port.stop();
    await traced.port.start(); await traced.port.stop();
    assert.deepEqual(traced.order, plain.order); assert.deepEqual(traced.counts(), plain.counts());
    if (!options.all) {
      // Existing #939 effect sequence, including every ss/ps/alive call.
      assert.deepEqual(traced.order, ["preflight", "-H -ltn sport = :8789", "confirm", "spawn", "alive", "ps:42",
        "-H -ltnp sport = :8789", "ps:42", "-H -ltnp", "ps:42", "ps:42", "confirm", "alive",
        "alive", "ps:42", "-H -ltnp sport = :8789", "ps:42", "-H -ltnp", "ps:42", "ps:42", "alive",
        "SIGINT", "alive", "alive", "-H -ltn sport = :8789"]);
      assert.deepEqual(traced.counts(), { spawned: 1, signals: 1, commands: 14, confirms: 2 });
    }
    assert.deepEqual(observed, ["ownership", "signal", "signal-sent", "wait", "port", "confirmed"].map(value => ["stop", value]));
    const saved = [...observed]; await assert.rejects(traced.port.stop(), fixed); assert.deepEqual(observed, saved);
  }
});

test("#976 independent stop failure freezes at ownership, signal, wait or port without extra effects", async () => {
  for (const [options, expected, signals] of [
    [{ all: `${listener()}\n${listener("0.0.0.0:8088", null)}` }, "ownership-failed", 0],
    [{ stopThrows: true }, "signal-failed", 1], [{ stopTimeout: true }, "wait-failed", 1],
    [{ unknownTerminal: true }, "wait-failed", 1], [{ portRemains: true }, "port-failed", 1],
  ]) {
    const observed = [], f = fixture(options, (kind, value) => { observed.push([kind, value]); });
    if (signals === 0) await assert.rejects(f.port.start(), fixed); else await f.port.start();
    await assert.rejects(f.port.stop(), fixed);
    assert.deepEqual(observed.at(-1), ["stop", expected]);
    assert.equal(f.counts().signals, signals);
    if (options.stopTimeout) assert.equal(f.order.filter(step => step === "sleep").length, 10);
    const saved = [...observed], counts = f.counts();
    await assert.rejects(f.port.stop(), fixed); assert.deepEqual(observed, saved); assert.deepEqual(f.counts(), counts);
    if (signals) assert.equal(observed.some(([kind]) => kind === "failure"), false);
  }
  const observed = [], f = fixture({ earlyExit: true }, (kind, value) => { observed.push([kind, value]); });
  await assert.rejects(f.port.start(), fixed);
  f.effects.command = async () => "";
  await f.port.stop();
  assert.deepEqual(observed, [["failure", "spawn"], ...["ownership", "wait", "port", "confirmed"].map(value => ["stop", value])]);
  assert.equal(f.counts().signals, 0);
});

test("#976 unknown wait inspection and closed-port command failure use stop positions; hook fails closed", async () => {
  for (const stage of ["wait", "port"]) {
    const options = {}, observed = [], f = fixture(options, (kind, value) => {
      observed.push([kind, value]);
      if (value === "wait" && stage === "wait") options.unknownGroup = true;
      if (value === "port" && stage === "port") options.commandThrows = true;
    });
    await f.port.start(); await assert.rejects(f.port.stop(), fixed);
    assert.deepEqual(observed.at(-1), ["stop", `${stage}-failed`]); assert.equal(f.counts().signals, 1);
  }
  for (const hook of [() => { throw new Error("private-canary"); }, () => Promise.resolve(), () => ({ then() { throw new Error("private-canary"); } })]) {
    const f = fixture({}, hook); await f.port.start(); await assert.rejects(f.port.stop(), fixed);
    const counts = f.counts(); await assert.rejects(f.port.stop(), fixed);
    assert.deepEqual(f.counts(), counts); assert.equal(counts.signals, 0);
  }
});

test("#976 startup child events latch spawn before a later group failure; ready-time events do not rewrite none", async () => {
  for (const event of ["error", "exit"]) {
    const observed = [], f = fixture({}, (kind, value) => { observed.push([kind, value]); });
    const command = f.effects.command;
    f.effects.command = async (file, args, ...rest) => {
      if (file === "ps") {
        if (event === "exit") f.child.exitCode = 1;
        f.child.emit(event, new Error("private-canary"));
        return "invalid-group";
      }
      return command(file, args, ...rest);
    };
    await assert.rejects(f.port.start(), fixed);
    assert.deepEqual(observed, [["failure", "spawn"]]); assert.equal(f.counts().signals, 0);
  }
  const observed = [], f = fixture({}, (kind, value) => { observed.push([kind, value]); });
  await f.port.start(); f.child.emit("error", new Error("private-canary"));
  assert.equal(f.port.isReady(), false); await assert.rejects(f.port.stop(), fixed);
  assert.deepEqual(observed, [["stop", "ownership"], ["stop", "ownership-failed"]]);
  let hooks = 0;
  const broken = fixture({}, () => { hooks++; throw new Error("private-canary"); });
  const command = broken.effects.command;
  broken.effects.command = async (file, args, ...rest) => {
    if (file === "ps") { broken.child.emit("error", new Error("private-canary")); return "invalid"; }
    return command(file, args, ...rest);
  };
  await assert.rejects(broken.port.start(), fixed); await assert.rejects(broken.port.stop(), fixed);
  assert.equal(hooks, 1); assert.equal(broken.counts().signals, 0);
});
