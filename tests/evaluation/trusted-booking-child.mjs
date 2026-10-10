// #945 isolated entry. Import is inert; the operator supplies sanitized env.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bookingChildComplete, bookingFixtureComplete, bookingChildUnknown, writeBookingReport } from "./trusted-booking-report.mjs";

export async function useBookingChild({ runInner, write, signal, isolated = false }) {
  try {
    signal.throwIfAborted();
    const result = await runInner({ signal }); // Sole seed / booking call; never replay.
    signal.throwIfAborted();
    if (!result || Object.keys(result).sort().join(",") !== "phase,status" ||
      result.phase !== "complete" || result.status !== "prepared") throw new Error();
    write(isolated ? bookingChildComplete : bookingFixtureComplete);
    return true;
  } catch {
    try { write(bookingChildUnknown); } catch { /* Partial/stale report is retained, never replaced. */ }
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--isolated-child") process.exitCode = 1;
  else {
    const controller = new AbortController(), interrupt = () => controller.abort();
    // 110s soft deadline; an existing shorter manager runtime remains authoritative.
    const timer = setTimeout(interrupt, 110000);
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    try {
      const { runTrustedBookingProcess } = await import("./trusted-booking-process.mjs");
      if (!await useBookingChild({ runInner: runTrustedBookingProcess, signal: controller.signal, isolated: true,
        write: text => writeBookingReport(process.env.TMPDIR, text) })) process.exitCode = 1;
    } catch { process.exitCode = 1; }
    finally {
      clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    }
  }
}
