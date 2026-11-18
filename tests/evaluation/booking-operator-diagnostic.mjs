// #1160: private, fixed observations for the D1-only Operator run.
import { types } from "node:util";

const phases = ["operator-preflight", "storage-owner", "migration-cli", "repreflight-owner",
  "wrangler-import", "proxy-start", "binding", "history", "seed", "baseline", "dispose", "handoff-capture"];

export async function diagnosePreparation(ports, record) {
  let observationLost = false;
  function observe(event, name) {
    try { record(event, name); } catch { observationLost = true; }
  }
  function stage(name, action) {
    if (name !== "dispose" && (observationLost || ports.interrupted())) throw new Error("DIAGNOSTIC_INTERRUPTED");
    const failed = error => { observe("failed", name); throw error; };
    const completed = result => { observe("completed", name); return result; };
    let result;
    try { result = action(); } catch (error) { return failed(error); }
    return types.isPromise(result) ? result.then(completed, failed) : completed(result);
  }

  try {
    await stage("operator-preflight", ports.preflight);
    await ports.prepare(ports.capture, stage);
  } catch {
    // The stage already recorded the first failure before any secondary dispose.
  }
  if (!observationLost && !ports.interrupted()) observe("end");
}

const afterProxy = phases.indexOf("binding");
const beforeDispose = phases.indexOf("dispose");
const needsDispose = phase => phases.slice(afterProxy, beforeDispose).includes(phase);

export function preparationReport(text, exited) {
  let next = 0, firstFailure = "none", lastCompleted = "none", dispose = "not-started";
  let ended = false, valid = true, stoppedEarly = false;
  const lines = text.split("\n");
  for (const line of lines.slice(0, -1)) {
    if (ended || stoppedEarly) { valid = false; break; }
    if (line === "end") { ended = true; continue; }
    const [event, name, extra] = line.split(" ");
    const expected = firstFailure === "none" ? phases[next] :
      needsDispose(firstFailure) && dispose === "not-started" ? "dispose" : undefined;
    // An interrupted run can go straight to disposal after obtaining the proxy.
    const earlyDispose = name === "dispose" && firstFailure === "none" && next >= afterProxy && next < beforeDispose;
    if (!name || extra !== undefined || !["completed", "failed"].includes(event) || (!earlyDispose && name !== expected)) {
      valid = false;
      break;
    }
    if (event === "completed") lastCompleted = name;
    if (name === "dispose") dispose = event;
    if (earlyDispose) stoppedEarly = true;
    else if (firstFailure === "none") {
      if (event === "failed") firstFailure = name;
      else next++;
    }
  }
  const failed = firstFailure !== "none";
  const complete = failed ? !needsDispose(firstFailure) || dispose !== "not-started" : next === phases.length;
  const known = exited && ended && valid && complete && lines.at(-1) === "";
  return {
    result: !known ? "UNKNOWN" : failed ? "FAILED" : "NOT_REPRODUCED",
    firstFailure: !known && !failed ? "UNKNOWN" : firstFailure,
    lastCompleted,
    dispose: !known && dispose === "not-started" ? "UNKNOWN" : dispose,
  };
}
