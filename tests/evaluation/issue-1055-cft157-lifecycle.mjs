// #1055 Stage3 synthetic diagnostic contracts. Pure event observers; no Chrome/HTTP.
import { classifyResponse } from "./issue-1055-cft157-admission.mjs";

const validArm = (r, arm) => r?.arm === arm && r.response === "401" &&
  r.page === "stopped" && r.jar === "empty";
const hostConfirmed = r => classifyResponse({
  status: r?.response === "401" ? 401 : null, authStopped: r?.page === "stopped",
  terminal: r?.request, hostBody: r?.body, drain: r?.drain,
}) === "host-confirmed";

/** Never attribute a differential synthetic result to a specific Chromium fix. */
export function classifyThreeArm({ records, getCount, wrongCount, ownedClean }) {
  if (!Array.isArray(records) || records.length !== 3 || getCount !== 3 ||
      wrongCount !== 0 || ownedClean !== true) return "unproved";
  const [base, manual, native] = records;
  if (!validArm(base, "baseline") || !validArm(manual, "treatment") ||
      !validArm(native, "native") || base.drain !== "not-applicable")
    return "unproved";
  const b = hostConfirmed(base), m = hostConfirmed(manual) && manual.drain === "eof";
  const n = hostConfirmed(native) && native.drain === "eof";
  if (b && m && n) return "baseline-no-reproduction";
  if (!b && m && n) return "synthetic-differential-observed";
  if (!b && !m && !n) return "all-unproved";
  return "mixed-inconclusive";
}

/** Track precisely the Playwright Request object, not just a matching URL. */
export function createTerminalObserver({ timeoutMs = 1500 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw Error("invalid deadline");
  const statuses = new Map(), pending = new Map();
  let disposed = false;
  function record(request, event) {
    if (disposed || !request || !["finished", "failed"].includes(event)) return;
    const previous = statuses.get(request);
    const next = previous ? "ambiguous" : event;
    statuses.set(request, next);
    const watcher = pending.get(request);
    if (watcher) {
      pending.delete(request);
      clearTimeout(watcher.timer);
      watcher.resolve(next);
    }
  }
  function waitFor(request) {
    if (!request || disposed) return Promise.resolve("unobserved");
    const known = statuses.get(request);
    if (known) return Promise.resolve(known);
    if (pending.has(request)) return pending.get(request).promise;
    let resolveWait;
    const promise = new Promise(resolve => { resolveWait = resolve; });
    const timer = setTimeout(() => {
      pending.delete(request);
      resolveWait("unobserved");
    }, timeoutMs);
    pending.set(request, { timer, resolve: resolveWait, promise });
    return promise;
  }
  function dispose() {
    disposed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve("unobserved");
    }
    pending.clear();
    statuses.clear();
  }
  return { record, waitFor, dispose };
}

/** Timeout is a loss of proof, not proof that the operation was cancelled. */
export async function boundedSettlement(operation, timeoutMs = 1500) {
  if (typeof operation !== "function" || !Number.isFinite(timeoutMs) || timeoutMs < 1)
    return "invalid";
  let timer;
  try {
    const outcome = Promise.resolve().then(operation).then(
      () => "settled", () => "failed",
    );
    return await Promise.race([
      outcome,
      new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Child owned temp roots must be under the current run-owned root. */
export function classifyRunRoot({ rootAbsolute = false, rootReal = false,
  rootOwned = false, rootPrivate = false, underRunner = false } = {}) {
  return rootAbsolute && rootReal && rootOwned && rootPrivate && underRunner ?
    "root-admitted" : "root-unknown";
}
