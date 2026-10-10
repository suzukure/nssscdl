// #914 only: bounded, non-interactive system manager adapter. No secrets or raw errors.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { browserEvidence } from "./trusted-browser-reads.mjs";
import { parseBrowserDiagnostic } from "./browser-tls-trust.mjs";

const exec = promisify(execFile);
const fail = (reason) => new Error(`TRUSTED_BROWSER_UNIT_${reason}`);
const settings = { Type: "exec", ExitType: "cgroup", RemainAfterExit: "yes", Restart: "no",
  NRestarts: "0", OOMPolicy: "stop", Delegate: "no", NoNewPrivileges: "yes",
  ProtectControlGroups: "yes", KillMode: "control-group", StandardOutput: "null", StandardError: "null" };
const stateKeys = ["LoadState", "ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus", "InvocationID", "ControlGroup"];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export function ownedIdentity(path, mode = 0o700) {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o777) !== mode || realpathSync(path) !== path) throw fail("OWNERSHIP");
  return { path, dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid, mode };
}
export function verifyOwned(identity) {
  const current = ownedIdentity(identity.path, identity.mode);
  if (["dev", "ino", "uid", "gid"].some((key) => current[key] !== identity[key])) throw fail("OWNERSHIP");
}

export function writeBrowserReport(temporary, report) {
  // Only fixed complete checkpoints/diagnostics may reach the private file.
  validateReport(report);
  const path = join(temporary, "browser-report"), partial = path + ".partial";
  ownedIdentity(temporary);
  try { lstatSync(path); throw fail("REPORT"); } catch (e) { if (e.code !== "ENOENT") throw fail("REPORT"); }
  writeFileSync(partial, report, { mode: 0o600, flag: "wx" });
  renameSync(partial, path);
}
function validateReport(report, intentional) {
  if (typeof report !== "string" || Buffer.byteLength(report) > 8192) throw fail("REPORT");
  const diagnostic = parseBrowserDiagnostic(report);
  if (diagnostic && /^TRUSTED_BROWSER_STAGE=[a-z-]+; CLEANUP=[a-z-]+$/.test(diagnostic) &&
    diagnostic !== "TRUSTED_BROWSER_STAGE=none; CLEANUP=none") return { diagnostic };
  try {
    const certificate = browserEvidence(report, intentional ?? false);
    return { certificate };
  } catch {
    if (intentional === undefined) {
      try { return { certificate: browserEvidence(report, true) }; } catch { /* fixed failure below */ }
    }
    throw fail("REPORT");
  }
}
export function readBrowserReport(temporary, intentional) {
  ownedIdentity(temporary);
  let fd;
  try {
    fd = openSync(join(temporary, "browser-report"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 8192) throw fail("REPORT");
    const report = readFileSync(fd, "utf8"), after = fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || Buffer.byteLength(report) !== stat.size) throw fail("REPORT");
    return validateReport(report, intentional);
  } catch { throw fail("REPORT"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

// A single 180s owner deadline includes capability checks, migration, execution,
// final checks and disposal. Reserve 10s for one stop (5s) + one show (5s).
export class BrowserUnit {
  constructor({ env, cwd, signal, deadline = Date.now() + 180000,
    command = async (file, args, options) => (await exec(file, args, options)).stdout,
    now = Date.now, sleep = wait, uid = process.getuid(), gid = process.getgid() }) {
    Object.assign(this, { env, cwd, signal, deadline, command, now, sleep, uid, gid });
    this.name = `nssscdl-browser-${randomBytes(16).toString("hex")}.service`;
    this.failure = undefined;
    this.started = false; this.stopped = false;
    this.cancel = () => { this.latch("CANCEL"); };
    signal?.addEventListener("abort", this.cancel, { once: true });
  }
  latch(reason) { this.failure ??= reason; }
  remaining(cleanup = false) {
    if (this.signal?.aborted) this.latch("CANCEL");
    const left = this.deadline - this.now() - (cleanup ? 0 : 10000);
    if (left <= 0) this.latch("TIMEOUT");
    if (left <= 0 || (!cleanup && this.failure)) throw fail(this.failure);
    return left;
  }
  async call(args, cleanup = false) {
    try {
      const timeout = Math.min(5000, this.remaining(cleanup));
      return await this.command("sudo", ["-n", ...args], { cwd: this.cwd,
        env: { PATH: this.env.PATH }, timeout, maxBuffer: 16384,
        ...(!cleanup ? { signal: this.signal } : {}) });
    } catch { this.latch(this.signal?.aborted ? "CANCEL" : this.now() >= this.deadline - 10000 ? "TIMEOUT" : "UNKNOWN"); throw fail(this.failure); }
  }
  async show(cleanup = false) {
    const keys = cleanup ? ["LoadState", "ActiveState", "SubState", "InvocationID"] :
      [...Object.keys(settings), ...stateKeys, "User", "Group", "RuntimeMaxUSec", "TimeoutStopUSec"];
    const output = await this.call(["systemctl", "show", this.name, ...keys.map((key) => `--property=${key}`)], cleanup);
    const state = {};
    try {
      for (const line of output.trimEnd().split("\n")) {
        const split = line.indexOf("="), key = line.slice(0, split);
        if (split < 1 || !keys.includes(key) || Object.hasOwn(state, key)) throw fail("MISMATCH");
        state[key] = line.slice(split + 1);
      }
      if (keys.some((key) => !Object.hasOwn(state, key))) throw fail("MISMATCH");
      return state;
    } catch { this.latch("UNKNOWN"); throw fail(this.failure); }
  }
  check(state) {
    // systemctl displays time spans as e.g. 2min or 1min 59s; use the
    // requested microseconds comparison via the fixed duration parser below.
    if (Object.entries(settings).some(([key, value]) => state[key] !== value) ||
      state.User !== String(this.uid) || state.Group !== String(this.gid) ||
      state.LoadState !== "loaded" || !/^[a-f0-9]{32}$/.test(state.InvocationID) || /^0+$/.test(state.InvocationID) ||
      (this.invocation && state.InvocationID !== this.invocation) ||
      !(state.ControlGroup === `/system.slice/${this.name}` || (state.SubState === "exited" && state.ControlGroup === "")) ||
      duration(state.RuntimeMaxUSec) !== this.runtime * 1000000 || duration(state.TimeoutStopUSec) !== 2000000) {
      this.latch("MISMATCH"); throw fail(this.failure);
    }
    this.invocation ??= state.InvocationID;
    if (state.Result !== "success" || !["running", "exited"].includes(state.SubState) || state.ActiveState !== "active") {
      this.latch(state.Result === "timeout" ? "TIMEOUT" : "MANAGER"); throw fail(this.failure);
    }
    this.remaining();
  }
  async start(file, args) {
    this.runtime = Math.min(120, Math.floor(this.remaining() / 1000));
    if (this.runtime < 1 || this.uid === 0 || this.gid === 0 || this.started) { this.latch("UNAVAILABLE"); throw fail(this.failure); }
    this.started = true; // Unknown start is never retried; dispose this name only.
    const properties = Object.entries(settings).filter(([key]) => key !== "NRestarts")
      .concat([["User", String(this.uid)], ["Group", String(this.gid)], ["RuntimeMaxSec", `${this.runtime}s`], ["TimeoutStopSec", "2s"]]);
    await this.call(["systemd-run", "--quiet", "--no-ask-password", `--unit=${this.name}`,
      `--working-directory=${this.cwd}`, ...properties.map(([key, value]) => `--property=${key}=${value}`),
      "/usr/bin/env", "-i", ...Object.entries(this.env).map(([key, value]) => `${key}=${value}`), file, ...args]);
    this.check(await this.show());
  }
  async terminal() {
    for (;;) {
      const state = await this.show(); this.check(state);
      if (state.SubState === "exited") {
        if (state.ExecMainCode !== "1" || state.ExecMainStatus !== "0") { this.latch("MANAGER"); throw fail(this.failure); }
        const second = await this.show(); this.check(second);
        if (second.SubState !== "exited" || second.ExecMainCode !== "1" || second.ExecMainStatus !== "0") {
          this.latch("MISMATCH"); throw fail(this.failure);
        }
        this.accepted = true; return;
      }
      await this.sleep(Math.min(100, this.remaining()));
    }
  }
  async dispose(release = false) {
    if (!this.started || this.stopped) return;
    if (!release || !this.accepted || this.failure) this.latch("STOP");
    this.stopped = true;
    await this.call(["systemctl", "stop", this.name], true);
    const state = await this.show(true);
    // Collection after a confirmed stop is disposal evidence only, never proof
    // of normal completion. Failure/unknown remains latched.
    if (!((state.LoadState === "not-found" && state.ActiveState === "inactive") ||
      (state.InvocationID === this.invocation && state.ActiveState === "inactive" && state.SubState === "dead"))) {
      this.latch("UNKNOWN"); throw fail(this.failure);
    }
    if (release && this.failure) throw fail(this.failure);
  }
  close() { this.signal?.removeEventListener("abort", this.cancel); }
}

function duration(value) {
  if (!/^(?:\d+(?:\.\d+)?(?:min|ms|us|s|h) ?)+$/.test(value ?? "")) return NaN;
  return [...value.matchAll(/(\d+(?:\.\d+)?)(min|ms|us|s|h)/g)]
    .reduce((total, [, n, unit]) => total + Number(n) * ({ h: 3600000000, min: 60000000, s: 1000000, ms: 1000, us: 1 })[unit], 0);
}

export async function browserUnitPreflight(options) {
  const unit = new BrowserUnit(options);
  try {
    if (process.platform !== "linux" || unit.uid === 0 || unit.gid === 0 ||
      readFileSync("/proc/1/comm", "utf8").trim() !== "systemd" ||
      !readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").trim()) throw fail("UNAVAILABLE");
    await unit.start("/usr/bin/true", []);
    await unit.terminal(); await unit.dispose(true);
  } catch {
    unit.latch("UNAVAILABLE");
    try { await unit.dispose(); } catch { /* no retry or alternative manager */ }
    throw fail("UNAVAILABLE");
  } finally { unit.close(); }
}

export async function finishBrowserUnit(unit, { report, finalCheck, remove, intentional }) {
  try {
    await unit.terminal();
    const result = await report(intentional);
    if (!result.certificate || result.diagnostic) { unit.latch("REPORT"); throw fail(unit.failure); }
    await finalCheck(); unit.remaining();
    await unit.dispose(true);
    // cancel/deadline after acceptance or release still suppresses deletion.
    unit.remaining(true);
    if (unit.failure) throw fail(unit.failure);
    await remove();
    return result.certificate;
  } catch {
    unit.latch("UNKNOWN");
    try { await unit.dispose(); } catch { /* preserve the first failure */ }
    throw fail(unit.failure);
  } finally { unit.close(); }
}
