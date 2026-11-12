// #1104 only. Never substitute this user-unit contract for BrowserUnit.
import { readFileSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
export const fail = () => new Error("BOOKING_OPERATOR_UNKNOWN; retain owned resources; do not retry");
export const demand = value => { if (!value) throw fail(); };
export const budget = Object.freeze({ prepare: 300000, interaction: 1200000, cleanup: 180000, total: 1800000 });
export async function bounded(action, ms) {
  demand(Number.isFinite(ms) && ms > 0);
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), ms); })]); }
  finally { clearTimeout(timer); }
}
export function userGroup(uid, name) {
  demand(Number.isSafeInteger(uid) && uid > 0 && /^nssscdl-operator-[a-f0-9]{32}\.service$/.test(name));
  return `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${name}`;
}
export function procIdentity(pid, group, io = { read: readFileSync, stat: lstatSync, uid: process.getuid?.() }) {
  demand(Number.isSafeInteger(pid) && pid > 1);
  const path = `/proc/${pid}`, before = io.read(`${path}/stat`, "utf8");
  const match = /^(\d+) \(.*\) ([^\n]+)\n?$/.exec(before), fields = match?.[2].split(/\s+/);
  demand(Number(match?.[1]) === pid && /^[RSDTtKWIP]$/.test(fields?.[0]) && /^\d+$/.test(fields?.[19]));
  demand(io.stat(path).uid === io.uid && io.read(`${path}/cgroup`, "utf8") === `0::${group}\n`);
  const after = /^(\d+) \(.*\) ([^\n]+)\n?$/.exec(io.read(`${path}/stat`, "utf8"));
  demand(Number(after?.[1]) === pid && after?.[2].split(/\s+/)[19] === fields[19] && io.stat(path).uid === io.uid);
  return Object.freeze({ pid, start: fields[19], group });
}
export function sameProcess(a, b) { demand(a.pid === b.pid && a.start === b.start && a.group === b.group); }
export function unitDuration(text) {
  // systemctl's fixed C-locale presentation, e.g. 29min 58s. No rounding.
  demand(typeof text === "string" && /^(?:\d+(?:h|min|s|ms|us))(?: \d+(?:h|min|s|ms|us))*$/.test(text));
  const weights = { h: 3600000000, min: 60000000, s: 1000000, ms: 1000, us: 1 };
  const seen = new Set(); let total = 0;
  for (const part of text.split(" ")) {
    const [, count, unit] = /^(\d+)(h|min|s|ms|us)$/.exec(part);
    demand(!seen.has(unit)); seen.add(unit); total += Number(count) * weights[unit];
  }
  demand(Number.isSafeInteger(total)); return total;
}
export function parseUnit(text, expected, terminal = false) {
  const keys = ["LoadState", "ActiveState", "SubState", "Result", "InvocationID", "ControlGroup", "MainPID",
    "ControlPID", "RuntimeMaxUSec", "TimeoutStopUSec", "KillMode", "Restart", "RemainAfterExit", "NoNewPrivileges", "ExecMainCode", "ExecMainStatus"];
  const lines = text.trimEnd().split("\n"), data = {};
  demand(lines.length === keys.length);
  for (const line of lines) {
    const split = line.indexOf("="), key = line.slice(0, split);
    demand(keys.includes(key) && !Object.hasOwn(data, key)); data[key] = line.slice(split + 1);
  }
  demand(data.LoadState === "loaded" && /^[a-f0-9]{32}$/.test(data.InvocationID) && !/^0+$/.test(data.InvocationID));
  demand(!expected.invocation || data.InvocationID === expected.invocation);
  const lifetime = expected.runtimeSeconds ?? 1800;
  demand(Number.isSafeInteger(lifetime) && lifetime > 0 && lifetime <= 1800);
  demand(unitDuration(data.RuntimeMaxUSec) === lifetime * 1000000 && unitDuration(data.TimeoutStopUSec) === 2000000 && data.KillMode === "control-group" &&
    data.Restart === "no" && data.RemainAfterExit === "yes" && data.NoNewPrivileges === "yes");
  demand(data.ControlPID === "0");
  if (terminal === "stop") demand(["", expected.group].includes(data.ControlGroup) && /^\d+$/.test(data.MainPID));
  else if (terminal) demand(data.ActiveState === "active" && data.SubState === "exited" && data.Result === "success" && data.MainPID === "0" && data.ExecMainCode === "1" && data.ExecMainStatus === "0" &&
    ["", expected.group].includes(data.ControlGroup));
  else demand(data.ActiveState === "active" && data.SubState === "running" && data.Result === "success" &&
    /^[1-9]\d*$/.test(data.MainPID) && data.ControlGroup === expected.group);
  return Object.freeze({ invocation: data.InvocationID, pid: Number(data.MainPID) });
}
export const unitProperties = "LoadState,ActiveState,SubState,Result,InvocationID,ControlGroup,MainPID,ControlPID,RuntimeMaxUSec,TimeoutStopUSec,KillMode,Restart,RemainAfterExit,NoNewPrivileges,ExecMainCode,ExecMainStatus";
export function emptyGroup(group, io = { stat: lstatSync, real: realpathSync, list: readdirSync, read: readFileSync }) {
  const path = resolve("/sys/fs/cgroup", `.${group}`);
  const visit = dir => {
    const stat = io.stat(dir); demand(stat.isDirectory() && !stat.isSymbolicLink() && io.real(dir) === dir);
    demand(io.read(`${dir}/cgroup.procs`, "utf8").trim() === "");
    const events = io.read(`${dir}/cgroup.events`, "utf8"); demand(/^populated 0$/m.test(events));
    for (const entry of io.list(dir, { withFileTypes: true })) {
      demand(!entry.isSymbolicLink()); if (entry.isDirectory()) visit(resolve(dir, entry.name));
    }
  };
  try { visit(path); }
  catch (error) { if (error.code !== "ENOENT") throw fail();
    // Missing cgroup is admissible only to the caller after same-Invocation exited observations.
    try { io.stat(path); throw fail(); } catch (second) { demand(second.code === "ENOENT"); }
  }
}
export function guiEnvironment(input, io = { stat: lstatSync, real: realpathSync, uid: process.getuid?.() }) {
  demand(input && Object.keys(input).every(k => ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "PULSE_SERVER"].includes(k)));
  demand(input.DISPLAY === ":0" && input.WAYLAND_DISPLAY === "wayland-0" && input.XDG_RUNTIME_DIR === `/run/user/${io.uid}`);
  demand(io.real(`${input.XDG_RUNTIME_DIR}/wayland-0`) === "/mnt/wslg/runtime-dir/wayland-0");
  demand(!input.PULSE_SERVER || input.PULSE_SERVER === "unix:/mnt/wslg/PulseServer");
  for (const path of ["/mnt/wslg/.X11-unix/X0", "/mnt/wslg/runtime-dir/wayland-0", ...(input.PULSE_SERVER ? ["/mnt/wslg/PulseServer"] : [])])
    demand(io.stat(io.real(path)).isSocket());
  return Object.freeze({ ...input });
}
