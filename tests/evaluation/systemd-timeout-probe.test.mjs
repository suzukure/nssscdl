import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, readFileSync, readdirSync } from "node:fs";
import * as nativeFs from "node:fs";
import { runInNewContext } from "node:vm";
import { createCgroupObserver, formatProbe, parseCgroupEvents, probeCli, runTimeoutProbe } from "./systemd-timeout-probe.mjs";

const name = `nssscdl-browser-${"a".repeat(32)}.service`, root = "/sys/fs/cgroup";
const privateCanary = "PRIVATE_CANARY";

function fsFixture() {
  const f = { content: "populated 1\nfrozen 0\n", missing: false, drift: false, symlink: false,
    fsType: 0x63677270, reads: 0, opens: [], closes: [], rootDrift: false, parentDrift: false };
  const handles = new Map(); let next = 1;
  function stat(path) {
    if (f.error) throw Object.assign(new Error(privateCanary), { code: f.error });
    const event = path.endsWith("/cgroup.events"), unit = path.includes(".service");
    if (unit && f.missing) throw Object.assign(new Error(privateCanary), { code: "ENOENT" });
    const base = event ? 4 : unit ? 3 : path === root ? 1 : 2;
    const ino = base + (unit && f.drift || path === root && f.rootDrift || path === `${root}/system.slice` && f.parentDrift ? 10 : 0);
    return { dev: f.deviceMismatch && unit ? 99 : 1, ino,
      isDirectory: () => !event && !(unit && f.symlink), isFile: () => event,
      isSymbolicLink: () => unit && f.symlink };
  }
  const fs = {
    constants, readFileSync: () => "systemd\n", lstatSync: stat,
    realpathSync: path => f.realpathMismatch && path.includes(".service") ? `${path}-other` : path,
    openSync: (path, flags) => {
      assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK);
      if (!path.endsWith("cgroup.events")) assert.ok(flags & constants.O_DIRECTORY);
      const fd = next++; f.opens.push(path); handles.set(fd, { path, stat: stat(path), offset: 0 }); return fd;
    },
    fstatSync: fd => handles.get(fd).stat,
    statfsSync: path => { assert.ok(path.startsWith(root)); return { type: f.fsType }; },
    readSync: (fd, buffer, offset, length) => {
      f.reads++;
      assert.equal(buffer.length, 4097);
      if (f.readError) throw Object.assign(new Error(privateCanary), { code: "ENODEV" });
      const h = handles.get(fd), text = Buffer.from(f.content);
      const count = Math.min(length, text.length - h.offset, f.chunk ?? length);
      text.copy(buffer, offset, h.offset, h.offset + count); h.offset += count;
      if (f.driftDuringRead) f.drift = true;
      return count;
    },
    closeSync: fd => { f.closes.push(fd); handles.delete(fd); },
  };
  return { f, fs, handles };
}

function fixture(options = {}) {
  const { f, fs, handles } = fsFixture(), events = [], configs = [];
  let time = 0, shows = 0, stopped = false, unitName;
  const controller = new AbortController();
  const config = { optIn: true, fs, platform: "linux", uid: 7, gid: 7, cwd: "/fixture",
    env: { PATH: "/usr/bin:/bin" }, signal: controller.signal, now: () => time,
    sleep: async ms => { time += ms; }, command: async (file, args, cfg) => {
      assert.equal(file, "sudo"); assert.equal(args[0], "-n");
      assert.ok(cfg.timeout > 0 && cfg.timeout <= 5000); assert.equal(cfg.maxBuffer, 16384);
      configs.push(cfg);
      if (args[1] === "systemd-run") {
        events.push("start"); unitName = args.find(a => a.startsWith("--unit=")).slice(7);
        assert.match(unitName, /^nssscdl-browser-[a-f0-9]{32}\.service$/);
        assert.deepEqual(args.slice(-2), ["/usr/bin/sleep", "60"]);
        assert.ok(args.includes("--property=RuntimeMaxSec=20s"));
        assert.ok(args.includes("--property=TimeoutStopSec=2s"));
        if (options.startError) throw new Error(privateCanary);
        return "";
      }
      if (args[2] === "stop") {
        events.push("stop"); assert.equal("signal" in cfg, false); stopped = true;
        f.content = options.afterContent ?? "populated 0\n";
        f.missing = options.afterMissing ?? false;
        if (options.afterDrift) f.drift = true;
        if (options.stopBudget) time = 30000;
        if (options.stopTimeout) { time = 30000; throw new Error(privateCanary); }
        if (options.stopError) throw new Error(privateCanary);
        return "";
      }
      if (args[1] === "busctl") {
        events.push("manager"); assert.equal("signal" in cfg, false);
        assert.deepEqual(args.slice(2), ["--system", "--no-pager", "--timeout=5s", "call",
          "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
          "GetUnitProcesses", "s", unitName]);
        if (options.managerTimeout) time = 30000;
        if (options.managerError || options.managerTimeout) throw new Error(privateCanary);
        return options.manager ?? "a(sus) 0\n";
      }
      assert.equal(args[1], "systemctl"); assert.equal(args[2], "show"); assert.equal(args[3], unitName);
      const keys = args.slice(4).map(a => a.slice("--property=".length));
      if (keys.length === 2) {
        events.push("identity"); assert.equal("signal" in cfg, false);
        if (options.identityTimeout) { time = 30000; throw new Error(privateCanary); }
        if (options.identityError) throw new Error(privateCanary);
        return options.identity ?? `InvocationID=${"b".repeat(32)}\nControlGroup=${f.missing ? "" : `/system.slice/${unitName}`}\n`;
      }
      events.push(stopped ? "stop-show" : "show"); shows++;
      if (stopped && options.cleanupTimeout) { time = 30000; throw new Error(privateCanary); }
      if (stopped && options.shortCleanup) time = 29000;
      if (stopped && options.cleanupError) throw new Error(privateCanary);
      if (stopped && options.cleanupInvalid) return `${privateCanary}\n`;
      const state = {
        Type: "exec", ExitType: "cgroup", RemainAfterExit: "yes", Restart: "no", NRestarts: "0", OOMPolicy: "stop",
        Delegate: "no", NoNewPrivileges: "yes", ProtectControlGroups: "yes", KillMode: "control-group",
        StandardOutput: "null", StandardError: "null", User: "7", Group: "7", RuntimeMaxUSec: "20s", TimeoutStopUSec: "2s",
        LoadState: "loaded", ActiveState: "active", SubState: "running", Result: "success", ExecMainCode: "0", ExecMainStatus: "0",
        InvocationID: "b".repeat(32), ControlGroup: `/system.slice/${unitName}`,
      };
      if (shows >= 3 || stopped) Object.assign(state, { ActiveState: "failed", SubState: "failed", Result: "timeout" });
      if (shows === 3) {
        if (options.deadline) time = 30000;
        if (options.cancel) { controller.abort(); throw new Error(privateCanary); }
        if (options.terminalError) throw new Error(privateCanary);
        if (options.managerFailure) state.Result = "exit-code";
        if (options.mismatch) state.InvocationID = "c".repeat(32);
      }
      return keys.map(k => `${k}=${state[k]}`).join("\n") + "\n";
    } };
  return { config, f, events, configs, handles, controller };
}

test("#968 failed same Invocation: empty / missing / populated remain observations; one stop", async () => {
  for (const [change, expected] of [[{}, "present-empty"], [{ afterMissing: true }, "missing"],
    [{ afterContent: "populated 1\n" }, "present-populated"]]) {
    const f = fixture(change), result = await runTimeoutProbe(f.config);
    assert.deepEqual(result, { terminal: "timeout", stop_observation: "failed-state", cgroup_before: "present-populated",
      cgroup_after: expected, manager: "empty-observed", identity: "same" });
    assert.deepEqual(f.events, ["start", "show", "show", "show", "stop", "stop-show", "manager", "identity"]);
    assert.equal(f.handles.size, 0); assert.doesNotMatch(formatProbe(result), /confirmed|PRIVATE|\.service/);
  }
});

test("#968 manager accepts only exact empty response, errors/timeout/overflow are unknown", async () => {
  for (const [change, expected] of [
    [{}, "empty-observed"], [{ manager: "a(sus) 1 PRIVATE_CANARY\n" }, "nonempty-or-unaccepted"],
    [{ manager: "a(sus) 0\n\n" }, "nonempty-or-unaccepted"], [{ manager: "a(sus) 0\r\n" }, "nonempty-or-unaccepted"],
    [{ manager: "" }, "nonempty-or-unaccepted"], [{ manager: "PRIVATE_CANARY" }, "nonempty-or-unaccepted"],
    [{ manager: "x".repeat(16385) }, "unknown"], [{ managerError: true }, "unknown"], [{ managerTimeout: true }, "unknown"],
  ]) {
    const f = fixture(change), result = await runTimeoutProbe(f.config);
    assert.equal(result.manager, expected); assert.equal(result.terminal, "timeout");
    assert.equal(f.events.filter(x => x === "manager").length, 1);
    assert.equal(f.events.filter(x => x === "stop").length, 1);
    if (change.managerTimeout) assert.ok(!f.events.includes("identity"));
    assert.doesNotMatch(formatProbe(result), /PRIVATE_CANARY/);
  }
});

test("#968 cgroup.events finite parser: no duplicate, malformed, missing, oversize or raw reflection", () => {
  for (const [text, expected] of [["populated 0\n", "present-empty"], ["populated 1", "present-populated"],
    ["frozen 123\npopulated 0\n", "present-empty"], ["populated 0\npopulated 0\n", "unknown"],
    ["populated 2\n", "unknown"], ["populated 01\n", "unknown"], ["frozen 0\n", "unknown"],
    ["populated 0\n\n", "unknown"], ["populated -1\n", "unknown"], ["populated 0\r\n", "unknown"],
    ["populated 0\nPRIVATE_CANARY\n", "unknown"], ["frozen 1\nfrozen 1\npopulated 0\n", "unknown"],
    ["x".repeat(4097), "unknown"], ["populated 0\né 0\n", "unknown"], ["", "unknown"]]) {
    assert.equal(parseCgroupEvents(Buffer.from(text)), expected);
  }
  assert.equal(parseCgroupEvents("populated 0\n"), "unknown");
  const exact = Buffer.from("populated 0\nfrozen " + "1".repeat(4096 - 20) + "\n");
  assert.equal(exact.length, 4096); assert.equal(parseCgroupEvents(exact), "present-empty");
  const { f, fs } = fsFixture(); f.content = exact.toString();
  assert.equal(createCgroupObserver(name, fs).sample(), "present-empty");
});

test("#968 filesystem, anchors, symlink, path and before/after identity checks fail closed", () => {
  for (const method of ["lstatSync", "realpathSync", "openSync", "fstatSync", "statfsSync", "readSync", "closeSync"]) {
    assert.equal(typeof nativeFs[method], "function");
  }
  for (const [change, expected] of [
    [{ missing: true }, "missing"], [{ symlink: true }, "unknown"], [{ realpathMismatch: true }, "unknown"],
    [{ deviceMismatch: true }, "unknown"], [{ fsType: 0x1234 }, "unknown"], [{ readError: true }, "unknown"],
    [{ error: "ENOENT" }, "unknown"], [{ content: "x".repeat(4097) }, "unknown"],
    [{ driftDuringRead: true }, "unknown"],
  ]) {
    const { f, fs, handles } = fsFixture(); Object.assign(f, change);
    assert.equal(createCgroupObserver(name, fs).sample(), expected); assert.equal(handles.size, 0);
  }
  for (const key of ["drift", "rootDrift", "parentDrift", "symlink", "realpathMismatch", "driftDuringRead"]) {
    const { f, fs } = fsFixture(), observer = createCgroupObserver(name, fs);
    assert.equal(observer.sample(), "present-populated"); f[key] = true;
    assert.equal(observer.sample(), "identity-mismatch");
  }
  const { f, fs } = fsFixture(); f.chunk = 1;
  assert.equal(createCgroupObserver(name, fs).sample(), "present-populated");
  assert.equal(createCgroupObserver("../PRIVATE_CANARY", fs).sample(), "unknown");
});

test("#968 post identity mismatch/unknown and cgroup drift are never stopping proof", async () => {
  for (const [change, expected] of [[{ identity: `InvocationID=${"c".repeat(32)}\nControlGroup=\n` }, "mismatch"],
    [{ identity: `InvocationID=${"b".repeat(32)}\nControlGroup=/different\n` }, "mismatch"],
    [{ identity: `InvocationID=${"b".repeat(32)}\n` }, "unknown"], [{ identity: "PRIVATE_CANARY\n" }, "unknown"],
    [{ identity: `InvocationID=${"b".repeat(32)}\nControlGroup=\n\n` }, "unknown"],
    [{ identity: `InvocationID=${"b".repeat(32)}\nInvocationID=${"b".repeat(32)}\nControlGroup=\n` }, "unknown"],
    [{ identityError: true }, "unknown"], [{ identity: "x".repeat(16385) }, "unknown"]]) {
    const result = await runTimeoutProbe(fixture(change).config);
    assert.equal(result.identity, expected); assert.doesNotMatch(formatProbe(result), /PRIVATE|=confirmed(?:;|\n)/);
  }
  assert.equal((await runTimeoutProbe(fixture({ afterDrift: true }).config)).cgroup_after, "identity-mismatch");
});

test("#968 budget exhaustion, unknown start, cancel, first failure and dispose exactly once", async () => {
  for (const [change, terminal, observation] of [
    [{ deadline: true }, "timeout", "stop-budget"], [{ stopBudget: true }, "timeout", "show-budget"],
    [{ stopError: true }, "timeout", "stop-unconfirmed"], [{ stopTimeout: true }, "timeout", "stop-unconfirmed"],
    [{ cleanupError: true }, "timeout", "show-unavailable"], [{ cleanupTimeout: true }, "timeout", "show-unavailable"],
    [{ cleanupInvalid: true }, "timeout", "show-invalid"], [{ startError: true }, "unknown", "identity-mismatch"],
    [{ cancel: true }, "cancel", "failed-state"], [{ terminalError: true }, "unknown", "failed-state"],
    [{ managerFailure: true }, "manager", "failed-state"], [{ mismatch: true }, "mismatch", "failed-state"],
    [{ managerFailure: true, stopError: true }, "manager", "stop-unconfirmed"],
    [{ cancel: true, managerError: true }, "cancel", "failed-state"],
  ]) {
    const f = fixture(change), result = await runTimeoutProbe(f.config);
    assert.equal(result.terminal, terminal); assert.equal(result.stop_observation, observation);
    assert.equal(f.events.filter(x => x === "stop").length, change.deadline ? 0 : 1);
    assert.equal(f.events.filter(x => x === "start").length, 1);
    if (change.deadline || change.stopBudget || change.stopTimeout || change.cleanupTimeout) {
      assert.equal(result.manager, "unknown"); assert.equal(result.identity, "unknown");
      assert.equal(result.cgroup_after, "unknown"); assert.ok(!f.events.includes("manager"));
    }
    if (change.startError) {
      assert.equal(result.cgroup_before, "unknown"); assert.equal(result.cgroup_after, "unknown");
      assert.equal(result.identity, "unknown"); assert.equal(f.f.reads, 0);
    }
    assert.doesNotMatch(formatProbe(result), /PRIVATE|=confirmed(?:;|\n)/);
  }
  const short = fixture({ shortCleanup: true, identityTimeout: true });
  const shortResult = await runTimeoutProbe(short.config);
  assert.equal(shortResult.manager, "empty-observed"); assert.equal(shortResult.identity, "unknown");
  assert.equal(shortResult.terminal, "timeout");
  assert.deepEqual(short.configs.slice(-2).map(config => config.timeout), [1000, 1000]);
  for (const change of [{ platform: "other" }, { uid: 0 }, { gid: 0 }]) {
    const f = fixture(); Object.assign(f.config, change);
    assert.equal((await runTimeoutProbe(f.config)).terminal, "unavailable"); assert.deepEqual(f.events, []);
  }
});

test("#968 opt-in rejection, fixed one-line CLI and no ordinary runtime/workflow caller", async () => {
  const f = fixture(); f.config.optIn = false;
  await assert.rejects(runTimeoutProbe(f.config), { message: "SYSTEMD_TIMEOUT_PROBE_OPT_IN_REQUIRED" });
  assert.deepEqual(f.events, []);
  for (const args of [[], ["--run", "PRIVATE_CANARY"], ["PRIVATE_CANARY"]]) {
    let output = "", calls = 0;
    assert.equal(await probeCli(args, { run: () => { calls++; }, output: text => { output += text; } }), 1);
    assert.equal(calls, 0); assert.equal(output, "SYSTEMD_TIMEOUT_PROBE_OPT_IN_REQUIRED\n");
  }
  let output = "";
  assert.equal(await probeCli(["--run"], { run: async config => {
    assert.equal(config.optIn, true); return { terminal: "timeout", manager: privateCanary };
  }, output: text => { output += text; } }), 0);
  assert.equal(output, "SYSTEMD_TIMEOUT_PROBE; terminal=timeout; stop_observation=unknown; cgroup_before=unknown; cgroup_after=unknown; manager=unknown; identity=unknown\n");
  assert.doesNotMatch(formatProbe({ get terminal() { throw new Error(privateCanary); }, manager: { toString() { throw new Error(privateCanary); } } }), /PRIVATE/);
  // Exercise the actual entry block with finite process/CLI adapters; no subprocess.
  const source = readFileSync("tests/evaluation/systemd-timeout-probe.mjs", "utf8");
  const entry = source.slice(source.indexOf("if (process.argv[1]"))
    .replace("import.meta.url", '"file:///probe.mjs"');
  let cliOutput = "", listens = 0, removes = 0;
  const finiteProcess = { argv: ["node", "/probe.mjs"],
    once: () => { listens++; }, removeListener: () => { removes++; } };
  await runInNewContext(`(async () => { ${entry} })()`, {
    process: finiteProcess, pathToFileURL: () => ({ href: "file:///probe.mjs" }), AbortController,
    probeCli: args => probeCli(args, { run: () => { throw new Error(privateCanary); },
      output: text => { cliOutput += text; } }),
  });
  assert.equal(finiteProcess.exitCode, 1); assert.equal(cliOutput, "SYSTEMD_TIMEOUT_PROBE_OPT_IN_REQUIRED\n");
  assert.equal(listens, 2); assert.equal(removes, 2);
  for (const dir of [".github/workflows", "tests/evaluation"]) {
    for (const file of readdirSync(dir)) {
      if (file.startsWith("systemd-timeout-probe") || !/\.(mjs|yml)$/.test(file)) continue;
      assert.doesNotMatch(readFileSync(`${dir}/${file}`, "utf8"), /systemd-timeout-probe\.mjs/);
    }
  }
  for (const file of readdirSync("src", { recursive: true })) {
    if (!/\.(ts|js|mjs|html)$/.test(file)) continue;
    assert.doesNotMatch(readFileSync(`src/${file}`, "utf8"), /systemd-timeout-probe\.mjs/);
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["test:unit"], /systemd-timeout-probe\.test\.mjs/);
  for (const script of Object.values(pkg.scripts)) assert.doesNotMatch(script, /systemd-timeout-probe\.mjs/);
});
