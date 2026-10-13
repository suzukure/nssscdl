// #1008 isolated opt-in only. Import never starts the Cookie-less inner.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unauthenticatedBookingChildComplete, unauthenticatedBookingFixtureComplete,
  unauthenticatedBookingPhases, formatUnauthenticatedBookingFailure, writeUnauthenticatedBookingReport } from "./trusted-unauthenticated-booking-report.mjs";

const consumed = new WeakSet();
export async function useUnauthenticatedBookingChild({ runInner, write, signal, isolated = false }) {
  // The single-use inner Port also prevents parallel/repeated entry from replacing a report.
  if (typeof runInner !== "function" || consumed.has(runInner)) return false;
  consumed.add(runInner);
  let interrupt, aborted, writeAttempted = false, observing = true, invalid = false;
  let entered = "unknown", confirmed = "unknown";
  const observe = event => {
    if (!observing || invalid || signal?.aborted) return;
    try {
      if (!event || typeof event !== "object" || Reflect.ownKeys(event).length !== 2) throw new Error();
      const phase = Object.getOwnPropertyDescriptor(event, "phase"), state = Object.getOwnPropertyDescriptor(event, "state");
      if (!phase || !state || !Object.hasOwn(phase, "value") || !Object.hasOwn(state, "value") ||
        !unauthenticatedBookingPhases.includes(phase.value) || phase.value === "unknown" || phase.value === "report-write" ||
        !["entered", "confirmed"].includes(state.value)) throw new Error();
      if (state.value === "entered") entered = phase.value;
      else { if (phase.value !== entered) throw new Error(); confirmed = phase.value; }
    } catch { invalid = true; entered = confirmed = "unknown"; }
  };
  try {
    signal.throwIfAborted();
    aborted = new Promise((_, reject) => {
      interrupt = () => reject(new Error("TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_FAILED"));
      signal.addEventListener("abort", interrupt, { once: true });
    });
    let inner;
    try { inner = runInner({ signal, observe }); } catch { inner = Promise.reject(new Error("TRUSTED_UNAUTHENTICATED_BOOKING_CHILD_FAILED")); }
    const result = await Promise.race([inner, aborted]); // Never replay, including abort + synchronous throw.
    signal.throwIfAborted();
    if (!result || typeof result !== "object" || Reflect.ownKeys(result).length !== 2 ||
      !["phase", "status"].every(key => Object.hasOwn(result, key))) throw new Error();
    const phase = Object.getOwnPropertyDescriptor(result, "phase"), status = Object.getOwnPropertyDescriptor(result, "status");
    if (!Object.hasOwn(phase, "value") || !Object.hasOwn(status, "value") ||
      phase.value !== "complete" || status.value !== "prepared") throw new Error();
    observing = false; entered = "report-write"; writeAttempted = true;
    await Promise.race([write(isolated === true ? unauthenticatedBookingChildComplete : unauthenticatedBookingFixtureComplete), aborted]);
    signal.throwIfAborted();
    return true;
  } catch {
    observing = false;
    if (!writeAttempted) {
      writeAttempted = true;
      try {
        const text = formatUnauthenticatedBookingFailure({ entered, confirmed });
        const attempt = write(text); await (aborted ? Promise.race([attempt, aborted]) : attempt);
      } catch { /* Keep uncertain/stale files; no repair or second write. */ }
    }
    return false;
  } finally { observing = false; if (interrupt) signal.removeEventListener("abort", interrupt); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--isolated-child") process.exitCode = 1;
  else {
    const controller = new AbortController(), interrupt = () => controller.abort();
    const timer = setTimeout(interrupt, 110000);
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    try {
      const runInner = async ({ signal, observe }) => {
        observe(Object.freeze({ phase: "import", state: "entered" }));
        const { runUnauthenticatedBookingProcess } = await import("./trusted-unauthenticated-booking-process.mjs");
        observe(Object.freeze({ phase: "import", state: "confirmed" }));
        return await runUnauthenticatedBookingProcess({ signal, observe });
      };
      if (!await useUnauthenticatedBookingChild({ runInner,
        signal: controller.signal, isolated: true,
        write: text => writeUnauthenticatedBookingReport(process.env.TMPDIR, text) })) process.exitCode = 1;
    } catch { process.exitCode = 1; }
    finally {
      clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    }
  }
}
