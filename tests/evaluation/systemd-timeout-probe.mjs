// #968 dormant observation only. No booking report, read gate or stopping proof.
import * as nativeFs from "node:fs";
import { pathToFileURL } from "node:url";
import { BrowserUnit } from "./trusted-browser-unit.mjs";

const ROOT = "/sys/fs/cgroup", PARENT = `${ROOT}/system.slice`, CGROUP2 = 0x63677270;
const enums = Object.freeze({
  terminal: ["complete", "timeout", "manager", "mismatch", "cancel", "unavailable", "unknown"],
  stop_observation: ["unknown", "stop-budget", "stop-unconfirmed", "show-budget", "show-unavailable",
    "show-invalid", "accepted", "identity-mismatch", "failed-state", "state-unaccepted"],
  cgroup_before: ["present-populated", "present-empty", "missing", "identity-mismatch", "unknown"],
  cgroup_after: ["present-populated", "present-empty", "missing", "identity-mismatch", "unknown"],
  manager: ["empty-observed", "nonempty-or-unaccepted", "unknown"],
  identity: ["same", "mismatch", "unknown"],
});
const unknown = () => Object.fromEntries(Object.keys(enums).map(key => [key, "unknown"]));

export function formatProbe(observation) {
  // Own data properties only: no arbitrary string conversion or getter execution.
  const values = Object.keys(enums).map(key => {
    let value;
    try { value = Object.getOwnPropertyDescriptor(observation, key)?.value; } catch { /* unknown */ }
    return `${key}=${typeof value === "string" && enums[key].includes(value) ? value : "unknown"}`;
  });
  return `SYSTEMD_TIMEOUT_PROBE; ${values.join("; ")}\n`;
}

export function parseCgroupEvents(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4096) return "unknown";
  // ASCII integer lines only. A single populated field is mandatory.
  const text = bytes.toString("ascii");
  if (!Buffer.from(text, "ascii").equals(bytes)) return "unknown";
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const seen = new Set(); let populated;
  for (const line of lines) {
    const match = /^([a-z][a-z0-9_]*) ([0-9]+)$/.exec(line);
    if (!match || seen.has(match[1])) return "unknown";
    seen.add(match[1]);
    if (match[1] === "populated") {
      if (!["0", "1"].includes(match[2])) return "unknown";
      populated = match[2];
    }
  }
  return populated === "0" ? "present-empty" : populated === "1" ? "present-populated" : "unknown";
}

const mismatch = () => { throw Object.assign(new Error(), { code: "PROBE_IDENTITY" }); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Small FS seam for finite fixtures. No FD survives a sample; deletion is never
// inferred from nlink, retained FDs, cgroup.procs or notifications.
export function createCgroupObserver(name, fs = nativeFs) {
  let baseline;
  const path = `${PARENT}/${name}`;
  const validName = /^nssscdl-browser-[a-f0-9]{32}\.service$/.test(name);
  function directory(path) {
    const before = fs.lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(path) !== path) mismatch();
    let fd;
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isDirectory() || !same(before, stat) || !same(stat, fs.lstatSync(path))) mismatch();
      if (fs.statfsSync(path).type !== CGROUP2) throw new Error();
      return stat;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function anchors() {
    const root = directory(ROOT), parent = directory(PARENT);
    if (root.dev !== parent.dev) mismatch();
    if (baseline && (!same(root, baseline.root) || !same(parent, baseline.parent))) mismatch();
    return { root, parent };
  }
  return {
    sample() {
      if (!validName) return "unknown";
      const established = Boolean(baseline);
      let fd;
      try {
        const anchor = anchors();
        let unit;
        try { unit = directory(path); }
        catch (e) {
          // Only a missing exact unit directory under validated anchors counts
          // as missing. ENODEV/read errors are unknown, never empty.
          if (e.code !== "ENOENT") throw e;
          anchors(); return "missing";
        }
        if (unit.dev !== anchor.root.dev || (baseline && !same(unit, baseline.unit))) mismatch();
        baseline ??= { ...anchor, unit };
        const events = `${path}/cgroup.events`, before = fs.lstatSync(events);
        if (!before.isFile() || before.isSymbolicLink() || before.dev !== unit.dev ||
          fs.realpathSync(events) !== events) mismatch();
        fd = fs.openSync(events, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || !same(before, stat)) mismatch();
        if (fs.statfsSync(events).type !== CGROUP2) throw new Error();
        const bytes = Buffer.alloc(4097); let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (!same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(events))) mismatch();
        anchors(); if (!same(unit, directory(path))) mismatch();
        return parseCgroupEvents(bytes.subarray(0, length));
      } catch (e) { return established && e.code === "PROBE_IDENTITY" ? "identity-mismatch" : "unknown"; }
      finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* observation only */ } } }
    },
  };
}

function boundedText(value) {
  return typeof value === "string" && Buffer.byteLength(value) <= 16384;
}
function postIdentity(text, invocation, controlGroup) {
  if (!boundedText(text) || !text.endsWith("\n")) return "unknown";
  const state = {};
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^(InvocationID|ControlGroup)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(state, match[1])) return "unknown";
    state[match[1]] = match[2];
  }
  if (!Object.hasOwn(state, "InvocationID") || !Object.hasOwn(state, "ControlGroup")) return "unknown";
  if (!/^[a-f0-9]{32}$/.test(state.InvocationID) || /^0+$/.test(state.InvocationID)) return "unknown";
  // systemd may clear ControlGroup after pruning; this is identity observation,
  // not a no-live assertion. A different nonempty path is rejected.
  return state.InvocationID === invocation && [controlGroup, ""].includes(state.ControlGroup) ? "same" : "mismatch";
}

export async function runTimeoutProbe({ optIn = false, fs = nativeFs, platform = process.platform,
  now = Date.now, sleep, command, uid = process.getuid(), gid = process.getgid(),
  signal, cwd = process.cwd(), env = { PATH: "/usr/bin:/bin" } } = {}) {
  if (optIn !== true) throw new Error("SYSTEMD_TIMEOUT_PROBE_OPT_IN_REQUIRED");
  const result = unknown();
  const unit = new BrowserUnit({ env, cwd, uid, gid, signal, command, now, sleep, deadline: now() + 30000 });
  let observer, invocation, controlGroup;
  const budget = () => now() < unit.deadline;
  const sample = () => {
    if (!observer || !budget()) return "unknown";
    const value = observer.sample(); return budget() ? value : "unknown";
  };
  try {
    if (platform !== "linux" || uid === 0 || gid === 0 || fs.readFileSync("/proc/1/comm", "utf8").trim() !== "systemd") {
      unit.latch("UNAVAILABLE"); throw new Error();
    }
    await unit.start("/usr/bin/sleep", ["60"]);
    const state = await unit.show(); unit.check(state);
    invocation = state.InvocationID; controlGroup = state.ControlGroup;
    if (controlGroup === `/system.slice/${unit.name}`) observer = createCgroupObserver(unit.name, fs);
    result.cgroup_before = sample();
    await unit.terminal(); result.terminal = "complete";
  } catch {
    unit.latch("UNKNOWN");
    result.terminal = ({ TIMEOUT: "timeout", MANAGER: "manager", MISMATCH: "mismatch",
      CANCEL: "cancel", UNAVAILABLE: "unavailable" })[unit.failure] ?? "unknown";
  } finally {
    // Exactly one disposal attempt, including an unknown start. No second stop.
    try { await unit.dispose(); } catch { /* keep first failure and observation */ }
    result.stop_observation = unit.stopObservation;
    result.cgroup_after = sample();
    if (unit.started && budget()) {
      try {
        const text = await unit.call(["busctl", "--system", "--no-pager", "--timeout=5s", "call",
          "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
          "GetUnitProcesses", "s", unit.name], true);
        if (budget() && boundedText(text)) result.manager = text === "a(sus) 0\n" ? "empty-observed" : "nonempty-or-unaccepted";
      } catch { /* timeout/error/overflow stays unknown */ }
    }
    if (invocation && budget()) {
      try {
        const text = await unit.call(["systemctl", "show", unit.name,
          "--property=InvocationID", "--property=ControlGroup"], true);
        if (budget()) result.identity = postIdentity(text, invocation, controlGroup);
      } catch { /* no retry */ }
    }
    unit.close();
  }
  return result;
}

export async function probeCli(args, { run = runTimeoutProbe, output = text => process.stdout.write(text), signal } = {}) {
  if (args.length !== 1 || args[0] !== "--run") {
    output("SYSTEMD_TIMEOUT_PROBE_OPT_IN_REQUIRED\n"); return 1;
  }
  try { output(formatProbe(await run({ optIn: true, signal }))); return 0; }
  catch { output(formatProbe(unknown())); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { process.exitCode = await probeCli(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
