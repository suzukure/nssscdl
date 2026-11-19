// #1164. Each process writes only to its own file in the fresh run directory.
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { types } from "node:util";
import { demand } from "./booking-operator-unit.mjs";

const stages = {
  controller: ["controller-start"],
  owner: ["controller-entry", "operator-preflight", "storage-owner", "migration-cli", "repreflight-owner",
    "wrangler-import", "proxy-start", "binding", "history", "seed", "baseline", "dispose", "handoff-capture",
    "child-admission", "child-start", "child-attestation", "packet-send", "unit-terminal", "unit-stop"],
  child: ["child-entry", "packet-accept", "certificate", "nss", "listen-8788", "playwright-import",
    "headless-launch", "headless-owner", "headless-context", "trusted-tls", "trusted-page-close",
    "san-tls", "san-page-close", "untrusted-tls", "untrusted-page-close",
    "headless-recheck", "headless-close", "headless-generated", "proof-close", "release-8788",
    "worker-preflight", "worker-spawn", "worker-process", "worker-listener", "headful-launch",
    "headful-owner", "headful-context", "initial-display", "worker-stop", "headful-recheck",
    "headful-close", "headful-generated", "ports-closed"],
};
const cleanup = new Set(["dispose", "unit-terminal", "unit-stop", "worker-stop", "proof-close", "release-8788",
  "trusted-page-close", "san-page-close", "untrusted-page-close", "ports-closed",
  "headless-recheck", "headless-close", "headless-generated", "headful-recheck", "headful-close", "headful-generated"]);
const limit = role => stages[role].length * 2 * 48 + 4;
export const directStage = (_name, action) => action();
export const progressPath = (directory, role) => join(directory, role + ".progress");

export function progressRecorder(role, append, interrupted = () => false) {
  const seen = new Set();
  let lost = false, halted = false;
  function write(line) {
    try { append(line + "\n"); } catch { lost = true; }
  }
  return {
    halt() { halted = true; },
    stage(name, action) {
      demand(stages[role].includes(name) && !seen.has(name));
      if (!cleanup.has(name)) demand(!lost && !halted && !interrupted());
      seen.add(name);
      write("start " + name);
      if (!cleanup.has(name)) demand(!lost);
      const completed = value => { write("ok " + name); return value; };
      const failed = error => { write("fail " + name); throw error; };
      let result;
      try { result = action(); } catch (error) { return failed(error); }
      return types.isPromise(result) ? result.then(completed, failed) : completed(result);
    },
    end() { if (!lost && !halted && !interrupted()) write("end"); },
  };
}

export function openProgress(directory, role, interrupted) {
  const fd = openSync(progressPath(directory, role), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    demand(privateFile(stat) && stat.size === 0);
    let closed = false;
    return { ...progressRecorder(role, line => demand(!closed && writeSync(fd, line) === Buffer.byteLength(line)), interrupted),
      close() { closed = true; closeSync(fd); } };
  } catch (error) { closeSync(fd); throw error; }
}

function privateFile(stat) {
  return stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600;
}

export function readProgress(directory, role) {
  try {
    const fd = openSync(progressPath(directory, role), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      demand(privateFile(fstatSync(fd)));
      const bytes = Buffer.alloc(limit(role) + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, size);
        if (!count) break;
        size += count;
      }
      return bytes.subarray(0, size).toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

export function parseProgress(role, text) {
  const completed = new Set();
  let index = -1, active, ended = false, valid = true, lastCompleted = "none";
  let firstFailure = "none", firstCleanupFailure = "none";
  const lines = text.slice(0, limit(role)).split("\n");
  for (const line of lines.slice(0, -1)) {
    if (ended) { valid = false; break; }
    if (line === "end" && !active) { ended = true; continue; }
    const [event, name, extra] = line.split(" ");
    const next = stages[role].indexOf(name);
    const afterFailure = firstFailure !== "none" || firstCleanupFailure !== "none";
    if (extra !== undefined || next < 0) { valid = false; break; }
    if (event === "start" && !active && (afterFailure ? cleanup.has(name) && next > index : next === index + 1)) {
      index = next; active = name;
    } else if (name === active && (event === "ok" || event === "fail")) {
      active = undefined;
      if (event === "ok") { completed.add(name); lastCompleted = name; }
      else if (cleanup.has(name)) {
        if (firstCleanupFailure === "none") firstCleanupFailure = name;
      } else if (firstFailure === "none") firstFailure = name;
    } else { valid = false; break; }
  }
  return { ended: ended && valid && lines.at(-1) === "" && text.length <= limit(role),
    complete: completed.size === stages[role].length, lastCompleted,
    active: active ?? "none", firstFailure, firstCleanupFailure, completed };
}

export function operatorProgressReport(observations, exited) {
  const controller = parseProgress("controller", observations.controller);
  const owner = parseProgress("owner", observations.owner);
  const child = parseProgress("child", observations.child);
  const childExpected = owner.completed.has("child-start") || observations.child.length > 0;
  const childAccountedFor = !childExpected || child.ended && (child.complete || child.firstFailure !== "none" || child.firstCleanupFailure !== "none");
  const firstFailure = owner.firstFailure === "child-attestation" && child.firstFailure === "child-entry"
    ? child.firstFailure : [controller, owner, child].find(value => value.firstFailure !== "none")?.firstFailure ?? "none";
  // Owner disposal precedes child execution. Manager cleanup follows child cleanup.
  const firstCleanupFailure = owner.firstCleanupFailure === "dispose" ? "dispose" :
    child.firstCleanupFailure !== "none" ? child.firstCleanupFailure : owner.firstCleanupFailure;
  const known = exited && controller.ended && owner.ended && childAccountedFor;
  const result = known && firstFailure === "none" && firstCleanupFailure === "none" && controller.complete && owner.complete && child.complete
    ? "NOT_REPRODUCED" : known && (firstFailure !== "none" || firstCleanupFailure !== "none") ? "FAILED" : "UNKNOWN";
  const summary = ({ lastCompleted, active }) => ({ lastCompleted, active });
  return { result, firstFailure: result === "UNKNOWN" && firstFailure === "none" ? "UNKNOWN" : firstFailure,
    firstCleanupFailure, controller: summary(controller), owner: summary(owner), child: summary(child) };
}
