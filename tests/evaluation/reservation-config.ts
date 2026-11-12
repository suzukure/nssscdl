function sameShape(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object" ||
      Array.isArray(actual) !== Array.isArray(expected)) return false;
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(e).length &&
    Object.keys(e).every((key) => Object.hasOwn(a, key) && sameShape(a[key], e[key]));
}

// Closed static contract: no remote/public/extra bindings or config overrides.
export function verifyReservationConfig(config: unknown) {
  const expected = {
    name: "nssscdl-local-booking-evaluation", main: "reservation-worker.ts", compatibility_date: "2026-10-06",
    workers_dev: false, preview_urls: false,
    dev: { ip: "127.0.0.1", port: 8789, local_protocol: "https" },
    assets: { directory: "../../dist/student", binding: "ASSETS", run_worker_first: true, html_handling: "none", not_found_handling: "none" },
    d1_databases: [{ binding: "EVALUATION_BOOKING_DB", database_name: "nssscdl-local-booking-evaluation",
      database_id: "00000000-0000-4000-8000-000000000929", migrations_dir: "../../migrations" }],
  };
  if (!sameShape(config, expected)) throw new Error("BOOKING_EVALUATION_CONFIG_INVALID");
}
