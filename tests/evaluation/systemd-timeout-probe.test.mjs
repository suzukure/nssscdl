import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, readFileSync, readdirSync } from "node:fs";
import * as nativeFs from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
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

test("#968 opt-in rejection and fixed one-line CLI", async () => {
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
});

// #970 prepared text only; a candidate is not a human execution approval.
const productWorkflow = ".github/workflows/product-ci.yml";
const probeCaller = /systemd-timeout-probe\.mjs/;
const strictText = bytes => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const probeStep = `
      - name: '#930 systemd timeout probe (temporary)'
        if: steps.applicability.outputs.applicable == 'true'
        timeout-minutes: 1
        shell: bash
        run: |
          node --input-type=module <<'NODE'
          import { spawnSync } from 'node:child_process';
          const query = (file, args, timeout) => {
            try { return spawnSync(file, args, {
              encoding: 'utf8', timeout, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe']
            }); } catch { return {}; }
          };
          const accepted = r => !r.error && !r.signal && r.status === 0 && r.stderr === '' &&
            typeof r.stdout === 'string' && Buffer.byteLength(r.stdout) <= 4096;
          const kernel = query('uname', ['-r'], 5000);
          const systemd = query('systemctl', ['--version'], 5000);
          const k = accepted(kernel) && /^[0-9][A-Za-z0-9._+-]{0,127}\\n$/.test(kernel.stdout) ? kernel.stdout.slice(0, -1) : 'unknown';
          const v = accepted(systemd) && /^systemd ([1-9][0-9]{0,5})(?: [ -~]*)?\\n(?:[ -~]*\\n)*$/.exec(systemd.stdout);
          console.log('SYSTEMD_TIMEOUT_PROBE_ENV; kernel=' + k + '; systemd=' + (v ? v[1] : 'unknown'));
          const result = query(process.execPath, ['tests/evaluation/systemd-timeout-probe.mjs', '--run'], 40000);
          const fields = [
            ['terminal', ['complete', 'timeout', 'manager', 'mismatch', 'cancel', 'unavailable', 'unknown']],
            ['stop_observation', ['unknown', 'stop-budget', 'stop-unconfirmed', 'show-budget', 'show-unavailable', 'show-invalid', 'accepted', 'identity-mismatch', 'failed-state', 'state-unaccepted']],
            ['cgroup_before', ['present-populated', 'present-empty', 'missing', 'identity-mismatch', 'unknown']],
            ['cgroup_after', ['present-populated', 'present-empty', 'missing', 'identity-mismatch', 'unknown']],
            ['manager', ['empty-observed', 'nonempty-or-unaccepted', 'unknown']],
            ['identity', ['same', 'mismatch', 'unknown']]
          ];
          const parts = accepted(result) ? result.stdout.split('; ') : [];
          const values = fields.map(([key, enums], i) => enums.find(value => parts[i + 1] === key + '=' + value + (i === fields.length - 1 ? '\\n' : '')));
          const line = 'SYSTEMD_TIMEOUT_PROBE; ' + fields.map(([key], i) => key + '=' + values[i]).join('; ');
          if (parts.length === fields.length + 1 && values.every(value => value !== undefined) && result.stdout === line + '\\n') {
            console.log(line);
          } else {
            console.error('SYSTEMD_TIMEOUT_PROBE_FAILED; observation=unknown');
            process.exitCode = 1;
          }
          NODE
`;

// The #948 Git/event contract, dedicated to this sole probe suffix.
function allowsProbeCaller(files, context) {
  try {
    for (const [path, source] of files) {
      if (typeof source !== "string" || path !== productWorkflow && probeCaller.test(source)) return false;
    }
    const workflow = files.get(productWorkflow);
    if (typeof workflow !== "string") return false;
    if (!probeCaller.test(workflow)) return true;
    const { env, event, head, base, main, mergeBase, changed, clean, baseWorkflow, diff } = context;
    const pr = event.pull_request, repository = "suzukure/nssscdl";
    const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "pull_request" ||
        env.GITHUB_REPOSITORY !== repository || env.GITHUB_WORKFLOW !== "Product CI" ||
        event.repository.full_name !== repository || !Number.isSafeInteger(event.number) || event.number <= 0 ||
        pr.number !== event.number || pr.state !== "open" || env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
        pr.base.repo.full_name !== repository || pr.head.repo.full_name !== repository ||
        pr.base.ref !== "main" || env.GITHUB_BASE_REF !== "main" ||
        typeof pr.head.ref !== "string" || !/^proof\/930-systemd-timeout-[a-z0-9][a-z0-9-]*$/.test(pr.head.ref) ||
        env.GITHUB_HEAD_REF !== pr.head.ref || !sha(head) || !sha(base) || head === base ||
        head !== pr.head.sha || base !== pr.base.sha || base !== main || mergeBase !== base ||
        clean !== "" || changed !== productWorkflow + "\0" || diff !== `M\0${productWorkflow}\0` ||
        typeof baseWorkflow !== "string" || probeCaller.test(baseWorkflow) || !baseWorkflow.endsWith("\n")) return false;
    return workflow === baseWorkflow + probeStep;
  } catch { return false; }
}

function proofContext(env, event, git) {
  const base = event.pull_request.base.sha;
  if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) throw new Error("PROBE_CONTEXT_UNAVAILABLE");
  const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("PROBE_CONTEXT_UNAVAILABLE");
  return { env, event, head, base,
    main: git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}").trim(),
    mergeBase: git("merge-base", base, head).trim(),
    changed: git("diff", "--no-renames", "--name-only", "-z", base, head),
    diff: git("diff", "--no-renames", "--name-status", "-z", base, head),
    clean: git("status", "--porcelain=v1", "--untracked-files=normal"),
    baseWorkflow: git("show", `${base}:${productWorkflow}`) };
}

function boundedSource(path, fs = nativeFs) {
  const fd = fs.openSync(path, constants.O_RDONLY), bytes = Buffer.alloc(1048577);
  let size = 0;
  try {
    while (size < bytes.length) {
      const n = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > 1048576) throw new Error("PROBE_CONTEXT_UNAVAILABLE");
    return strictText(bytes.subarray(0, size));
  } finally { fs.closeSync(fd); }
}

function gitEvidence(...args) {
  const r = spawnSync("git", args, { timeout: 5000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.signal || r.status !== 0) throw new Error("PROBE_CONTEXT_UNAVAILABLE");
  return strictText(r.stdout);
}

function checkRepositoryCaller() {
  const paths = ["package.json"];
  for (const dir of ["src", ".github/workflows", "tests/evaluation"]) {
    for (const file of readdirSync(dir, { recursive: true })) {
      const path = `${dir}/${file}`;
      if (!/\.(?:[cm]?js|tsx?|jsx|sh|html|jsonc?|ya?ml)$/.test(file) ||
          ["tests/evaluation/systemd-timeout-probe.mjs", "tests/evaluation/systemd-timeout-probe.test.mjs"].includes(path)) continue;
      paths.push(path);
    }
  }
  const files = new Map(paths.map(path => [path, boundedSource(path)]));
  let context;
  if (probeCaller.test(files.get(productWorkflow))) {
    try { context = proofContext(process.env, JSON.parse(boundedSource(process.env.GITHUB_EVENT_PATH)), gitEvidence); }
    catch { /* Unknown evidence denies; never fetch or execute a probe. */ }
  }
  assert.equal(allowsProbeCaller(files, context), true, "probe workflow/source caller guard");
  assert.match(JSON.parse(files.get("package.json")).scripts["test:unit"], /systemd-timeout-probe\.test\.mjs/);
}

test("#970 actual repository caller guard: ordinary CI inert, only exact temporary candidate", checkRepositoryCaller);

// Strip only fixture input, never the guard's current-source evidence.
function fixtureBase(workflow) {
  return workflow.endsWith(probeStep) ? workflow.slice(0, -probeStep.length) : workflow;
}
function callerFixture(workflow = boundedSource(productWorkflow)) {
  const baseWorkflow = fixtureBase(workflow), head = "a".repeat(40), base = "b".repeat(40);
  const repository = { full_name: "suzukure/nssscdl" }, number = 17, branch = "proof/930-systemd-timeout-fixture";
  return { files: new Map([[productWorkflow, baseWorkflow + probeStep]]), context: {
    env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: repository.full_name,
      GITHUB_WORKFLOW: "Product CI", GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: branch, GITHUB_REF: `refs/pull/${number}/merge` },
    event: { repository, number, pull_request: { number, state: "open",
      head: { ref: branch, sha: head, repo: repository }, base: { ref: "main", sha: base, repo: repository } } },
    head, base, main: base, mergeBase: base, clean: "", changed: productWorkflow + "\0",
    diff: `M\0${productWorkflow}\0`, baseWorkflow } };
}

test("#970 candidate fixtures remain valid on ordinary and exact-candidate source, twice", () => {
  const f = callerFixture();
  assert.equal(allowsProbeCaller(new Map([[productWorkflow, f.context.baseWorkflow]])), true);
  assert.equal(allowsProbeCaller(f.files), false);
  for (const workflow of [f.context.baseWorkflow, f.files.get(productWorkflow)]) {
    for (let pass = 0; pass < 2; pass++) {
      const candidate = callerFixture(workflow);
      assert.equal(candidate.context.baseWorkflow, f.context.baseWorkflow);
      assert.equal(allowsProbeCaller(candidate.files, candidate.context), true);
    }
  }
  const fresh = callerFixture();
  fresh.context.base = fresh.context.main = fresh.context.mergeBase = fresh.context.event.pull_request.base.sha = "d".repeat(40);
  fresh.context.baseWorkflow += "\n      # Fresh main\n";
  fresh.files.set(productWorkflow, fresh.context.baseWorkflow + probeStep);
  assert.equal(allowsProbeCaller(fresh.files, fresh.context), true);
  for (const key of Object.keys(f.context.env)) {
    const c = callerFixture(); delete c.context.env[key]; assert.equal(allowsProbeCaller(c.files, c.context), false);
  }
  const changes = [
    c => { c.env.GITHUB_ACTIONS = "false"; }, c => { c.env.GITHUB_EVENT_NAME = "push"; },
    c => { c.env.GITHUB_EVENT_NAME = "pull_request_target"; }, c => { c.env.GITHUB_REPOSITORY = "fork/repo"; },
    c => { c.env.GITHUB_WORKFLOW = "Other"; }, c => { c.event.repository.full_name = "fork/repo"; },
    c => { c.event.number = 0; }, c => { c.event.number = "17"; }, c => { c.event.pull_request.number++; },
    c => { c.event.pull_request.state = "closed"; }, c => { c.event.pull_request.head.repo = { full_name: "fork/repo" }; },
    c => { c.event.pull_request.base.repo = { full_name: "fork/repo" }; }, c => { c.event.pull_request.base.ref = "other"; },
    c => { c.env.GITHUB_BASE_REF = "other"; }, c => { c.env.GITHUB_REF = "refs/heads/main"; },
    c => { c.env.GITHUB_HEAD_REF = "other"; }, c => { c.head = "invalid"; }, c => { c.base = "invalid"; },
    c => { c.event.pull_request.head.sha = "c".repeat(40); }, c => { c.event.pull_request.base.sha = "c".repeat(40); },
    c => { c.base = c.head; }, c => { c.main = "c".repeat(40); }, c => { c.mergeBase = "c".repeat(40); },
    c => { c.clean = " M src/worker.ts\n"; }, c => { c.clean = "?? extra\n"; },
    c => { c.changed += "src/worker.ts\0"; }, c => { c.changed += ".github/workflows/extra.yml\0"; },
    c => { c.changed = productWorkflow; }, c => { c.diff = `A\0${productWorkflow}\0`; }, c => { c.diff = `T\0${productWorkflow}\0`; },
    c => { c.baseWorkflow += probeStep; }, c => { c.baseWorkflow = undefined; }, c => { c.baseWorkflow = c.baseWorkflow.trimEnd(); },
    c => { c.event = {}; }, c => { c.env.GITHUB_ACTIONS = "false"; c.event.pull_request.body = "APPROVED"; },
  ];
  for (const branch of ["main", "ordinary", "proof/930-systemd-timeout-", "proof/930-systemd-timeout-UPPER", "proof/930-booking-normal-fixture"]) {
    changes.push(c => { c.event.pull_request.head.ref = c.env.GITHUB_HEAD_REF = branch; });
  }
  for (const [i, change] of changes.entries()) {
    const c = callerFixture(); change(c.context); assert.equal(allowsProbeCaller(c.files, c.context), false, `context ${i}`);
  }
});

test("#970 actual scanner with finite candidate Git/event/source adapters, twice", () => {
  const f = callerFixture(), c = f.context;
  const outputs = new Map([
    [["rev-parse", "--verify", "HEAD^{commit}"], c.head + "\n"],
    [["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], c.main + "\n"],
    [["merge-base", c.base, c.head], c.base + "\n"],
    [["diff", "--no-renames", "--name-only", "-z", c.base, c.head], c.changed],
    [["diff", "--no-renames", "--name-status", "-z", c.base, c.head], c.diff],
    [["status", "--porcelain=v1", "--untracked-files=normal"], ""],
    [["show", `${c.base}:${productWorkflow}`], c.baseWorkflow],
  ].map(([args, value]) => [JSON.stringify(args), value]));
  for (let pass = 0; pass < 2; pass++) {
    const seen = [];
    runInNewContext(checkRepositoryCaller.toString() + "\ncheckRepositoryCaller();", {
      readdirSync, productWorkflow, probeCaller, proofContext, allowsProbeCaller, assert,
      process: { env: { ...c.env, GITHUB_EVENT_PATH: "finite-event" } },
      boundedSource(path) {
        if (path === "finite-event") return JSON.stringify(c.event);
        return f.files.get(path) ?? boundedSource(path);
      },
      gitEvidence(...args) {
        const key = JSON.stringify(args); assert.ok(outputs.has(key)); seen.push(key); return outputs.get(key);
      },
    });
    assert.deepEqual(seen, [...outputs.keys()]);
  }
});

test("#970 denies other source/package/sealed/workflow callers and any template deviation", () => {
  const f = callerFixture(), original = f.files.get(productWorkflow);
  for (const path of ["src/worker.ts", "package.json", ".github/workflows/other.yml", "tests/evaluation/trusted-seed-smoke.mjs",
    "tests/evaluation/trusted-https-process.mjs", "tests/evaluation/trusted-booking-outer.mjs", "tests/evaluation/extra.test.mjs"]) {
    assert.equal(allowsProbeCaller(new Map([...f.files, [path, "systemd-timeout-probe.mjs"]]), f.context), false);
  }
  const variants = [original + probeStep, probeStep + f.context.baseWorkflow, original + "      - run: echo extra\n",
    original.replace("contents: read", "contents: write"), original.replace("pull_request:", "push:"),
    original.replace("fetch-depth: 0", "fetch-depth: 1"), original.replace("github.event.pull_request.head.sha", "github.sha"),
    original.replace("timeout-minutes: 1", "timeout-minutes: 2"), original.replace("40000", "50000"),
    original.replace("5000", "6000"), original.replace("4096", "8192"), original.replace("'--run'", "'--run', '--retry'"),
    original.replace("        shell: bash", "        continue-on-error: true\n        shell: bash"),
    original.replace("        shell: bash", "        env:\n          TOKEN: unsafe\n        shell: bash"),
    original.replace("applicable == 'true'", "applicable != 'true'"), original.replace(/\n/g, "\r\n"), original.trimEnd(),
    original.replace("observation=unknown", "observation=' + result.stderr + '"), original + "# APPROVED\n"];
  for (const cmd of ["npm ci", "npm run build", "npm run typecheck", "npm run lint", "npm run test:unit", "npm run test:integration",
    "npm run d1:local", "npm run test:d1", "npm test"]) variants.push(original.replace(cmd, "echo bypass"));
  for (const [i, workflow] of variants.entries()) {
    assert.notEqual(workflow, original);
    assert.equal(allowsProbeCaller(new Map([[productWorkflow, workflow]]), f.context), false, `template ${i}`);
  }
});

test("#970 bounded strict source and read-only Git evidence: unavailable evidence fails closed", () => {
  assert.throws(() => strictText(Buffer.from([0xff])));
  assert.equal(strictText(Buffer.from("\ufeffworkflow\n")), "\ufeffworkflow\n");
  for (const size of [1048576, 1048577]) {
    let offset = 0, closes = 0;
    const fs = { openSync: () => 1, closeSync: () => { closes++; }, readSync: (_fd, b, at, length) => {
      const n = Math.min(97, length, size - offset); b.fill(97, at, at + n); offset += n; return n;
    } };
    if (size === 1048576) assert.equal(boundedSource("fixture", fs).length, size);
    else assert.throws(() => boundedSource("fixture", fs));
    assert.equal(closes, 1);
  }
  const f = callerFixture(), c = f.context;
  const outputs = new Map([
    [["rev-parse", "--verify", "HEAD^{commit}"], c.head + "\n"],
    [["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], c.main + "\n"],
    [["merge-base", c.base, c.head], c.base + "\n"],
    [["diff", "--no-renames", "--name-only", "-z", c.base, c.head], c.changed],
    [["diff", "--no-renames", "--name-status", "-z", c.base, c.head], c.diff],
    [["status", "--porcelain=v1", "--untracked-files=normal"], ""],
    [["show", `${c.base}:${productWorkflow}`], c.baseWorkflow],
  ].map(([args, value]) => [JSON.stringify(args), value]));
  const git = (...args) => { const key = JSON.stringify(args); assert.ok(outputs.has(key)); return outputs.get(key); };
  assert.equal(allowsProbeCaller(f.files, proofContext(c.env, c.event, git)), true);
  for (const key of outputs.keys()) {
    assert.throws(() => proofContext(c.env, c.event, (...args) => {
      if (JSON.stringify(args) === key) throw new Error(privateCanary);
      return git(...args);
    }));
  }
  const script = gitEvidence.toString() + '\n gitEvidence("status", "--porcelain=v1", "--untracked-files=normal");';
  for (const result of [{ error: new Error(privateCanary) }, { signal: "SIGTERM" }, { status: 1 },
    { status: 0, stdout: Buffer.from([0xff]) }, { status: 0, stdout: Buffer.from("") }]) {
    const adapter = { strictText, spawnSync(file, args, cfg) {
      assert.equal(file, "git"); assert.equal(cfg.timeout, 5000); assert.equal(cfg.maxBuffer, 1048576);
      assert.deepEqual(Array.from(cfg.stdio), ["ignore", "pipe", "pipe"]); return result;
    } };
    if (result.status === 0 && result.stdout.length === 0) assert.equal(runInNewContext(script, adapter), "");
    else assert.throws(() => runInNewContext(script, adapter));
  }
});

function stepFixture(result, kernel, systemd) {
  const script = probeStep.split("          node --input-type=module <<'NODE'\n")[1]
    .replace("          import { spawnSync } from 'node:child_process';\n", "").replace(/          NODE\n$/, "");
  const stdout = [], stderr = [], calls = [], process = { execPath: "fixture-node" };
  runInNewContext(script, { Buffer, process, console: { log: v => stdout.push(v), error: v => stderr.push(v) },
    spawnSync(file, args, options) {
      calls.push([file, Array.from(args)]);
      assert.equal(options.encoding, "utf8"); assert.equal(options.maxBuffer, 4096);
      assert.equal(options.timeout, file === "fixture-node" ? 40000 : 5000);
      assert.deepEqual(Array.from(options.stdio), ["ignore", "pipe", "pipe"]);
      const r = file === "uname" ? kernel : file === "systemctl" ? systemd : result;
      if (r instanceof Error) throw r;
      return r;
    } });
  assert.deepEqual(calls, [["uname", ["-r"]], ["systemctl", ["--version"]],
    ["fixture-node", ["tests/evaluation/systemd-timeout-probe.mjs", "--run"]]]);
  return { stdout, stderr, status: process.exitCode };
}
const spawnResult = stdout => ({ status: 0, signal: null, stdout, stderr: "" });
const envUnknown = "SYSTEMD_TIMEOUT_PROBE_ENV; kernel=unknown; systemd=unknown";

test("#970 VM template: exact runtime enums/order, single LF, failures and canary nonreflection", () => {
  // Runtime formatProbe is authoritative; read its unexported finite enum without running the CLI.
  const runtime = readFileSync("tests/evaluation/systemd-timeout-probe.mjs", "utf8");
  const enums = runInNewContext(runtime.slice(runtime.indexOf("const enums"), runtime.indexOf("const unknown")) + "enums;");
  const script = probeStep.split("          const fields = ")[1].split(";\n          const parts")[0];
  const fields = runInNewContext(script);
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), Object.entries(JSON.parse(JSON.stringify(enums))));
  const observation = Object.fromEntries(Object.keys(enums).map(key => [key, "unknown"]));
  for (const [key, values] of Object.entries(enums)) {
    for (const value of values) {
      const text = formatProbe({ ...observation, [key]: value });
      assert.deepEqual(stepFixture(spawnResult(text), {}, {}), { stdout: [envUnknown, text.slice(0, -1)], stderr: [], status: undefined });
    }
  }
  const line = formatProbe({ terminal: "timeout", stop_observation: "failed-state", cgroup_before: "present-populated",
    cgroup_after: "missing", manager: "empty-observed", identity: "same" });
  const invalid = [line.trimEnd(), line + "\n", line.replace(/\n/g, "\r\n"), line + privateCanary,
    line.replace("SYSTEMD_TIMEOUT_PROBE", privateCanary), line.replace("timeout", "future"),
    line.replace("identity=same\n", "identity=same; extra=unknown\n"), line.replace("terminal=timeout; ", ""),
    line.replace("terminal=timeout; stop_observation=failed-state", "stop_observation=failed-state; terminal=timeout"),
    line.replace("identity=same", "identity=1"), 1, null, {}, "x".repeat(4097)];
  const bad = invalid.map(stdout => spawnResult(stdout));
  bad.push(...[1, null, "0"].map(status => ({ ...spawnResult(line), status })),
    { ...spawnResult(line), signal: "SIGTERM" }, { ...spawnResult(line), stderr: privateCanary },
    { ...spawnResult(line), error: new Error(privateCanary) },
    ...["ETIMEDOUT", "ENOBUFS", "ENOENT"].map(code => Object.assign(new Error(privateCanary), { code })));
  for (const result of bad) {
    assert.deepEqual(stepFixture(result, {}, {}), { stdout: [envUnknown], stderr: ["SYSTEMD_TIMEOUT_PROBE_FAILED; observation=unknown"], status: 1 });
  }
  assert.deepEqual(stepFixture(spawnResult(line), spawnResult("6.8.0-101-generic\n"),
    spawnResult("systemd 255 (255.4-1ubuntu8)\n+PAM +AUDIT\n")), {
    stdout: ["SYSTEMD_TIMEOUT_PROBE_ENV; kernel=6.8.0-101-generic; systemd=255", line.slice(0, -1)], stderr: [], status: undefined });
  for (const r of [spawnResult(privateCanary + "\n"), spawnResult("6.8.0\r\n"), spawnResult("6.8.0\n\n"),
    spawnResult("6" + "a".repeat(128) + "\n"), spawnResult("systemd 0255\n"), spawnResult("systemd 255\r\n"),
    spawnResult("x".repeat(4097)), { ...spawnResult("6.8.0\n"), status: 1 },
    { ...spawnResult("systemd 255\n"), signal: "SIGTERM" }, { ...spawnResult("systemd 255\n"), stderr: privateCanary },
    { ...spawnResult("systemd 255\n"), error: new Error(privateCanary) }, new Error(privateCanary), spawnResult(null)]) {
    const output = stepFixture(spawnResult(line), r, r);
    assert.deepEqual(output, { stdout: [envUnknown, line.slice(0, -1)], stderr: [], status: undefined });
  }
});
