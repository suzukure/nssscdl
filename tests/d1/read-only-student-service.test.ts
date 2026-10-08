import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createReadOnlyStudentService, type ReadOnlyStudentConfig, type ReadOnlyStudentService } from "../fixtures/read-only-student-service";
import { seedTrustedStudents, checkTrustedSeedIntegrity } from "../fixtures/d1/trusted-student-seed";
import { HmacReservationHistoryCursorCodec } from "../../src/infrastructure/reservation-history-cursor";
import type { ScheduleMonthView } from "../../src/application/schedule-query";
import type { ReservationHistoryView } from "../../src/application/reservation-history";

const db = env.AUTH_DB;
const origin = "https://nssscdl.test";
const validation = { authSql: env.AUTH_INTEGRITY_SQL, reservationScans: env.RESERVATION_INTEGRITY_SCANS };
let seed: Awaited<ReturnType<typeof seedTrustedStudents>>;
let key: CryptoKey;
let service: ReadOnlyStudentService;
let failRead = false;
let otherRole = false;
const queries: string[] = [];
const sessions: string[] = [];
// Existing D1 interface, real local SELECTs. Fault/role projection is test-only;
// the actual Production Guard still resolves and classifies every Session.
const database: ReadOnlyStudentConfig["database"] = {
  prepare(query) { return statement(db, query); },
  withSession(constraint) {
    sessions.push(constraint);
    const session = db.withSession(constraint);
    return { prepare(query) { return statement(session, query); } };
  },
};
function statement(source: { prepare: typeof db.prepare }, query: string) {
  queries.push(query);
  const prepared = source.prepare(query);
  return { bind(...values: unknown[]) {
    const bound = prepared.bind(...values);
    return { async all<T>() {
      if (failRead) throw new Error("private fixture D1 failure");
      const result = await bound.all<T>();
      if (otherRole && query.includes("student_session_access_v1")) {
        result.results = result.results.map((row: T) => ({ ...row, role_scope: "admin" }));
      }
      return result;
    } };
  } };
}
const paths = () => [`/api/me/schedule-months/${seed.month}`, "/api/me/reservations", "/api/auth/student/csrf"];
function request(path: string, owner: "self" | "other" | "missing" = "self", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("sec-fetch-site", "same-origin");
  if (owner !== "missing") {
    const cookie = seed.sessions[owner].cookie();
    headers.set("cookie", `${cookie.name}=${cookie.value}`);
  }
  return new Request(origin + path, { ...init, headers });
}
// Compare digest booleans, never expose secret-bearing DB rows in test diffs.
async function snapshot() {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name")
    .all<{ name: string }>()).results;
  const rows = await Promise.all(tables.map(async ({ name }) => (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows))));
}
async function unchanged(before: Uint8Array) {
  const after = await snapshot();
  expect(before.length === after.length && before.every((byte, index) => byte === after[index])).toBe(true);
  expect(queries.every((query) => /^\s*SELECT\b/i.test(query))).toBe(true);
  expect(sessions.every((constraint) => constraint === "first-primary")).toBe(true);
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("set-cookie") !== null).toBe(status === 401);
  const body = await response.json();
  expect(body).toMatchObject({ error: { code } });
  expect(JSON.stringify(body)).not.toMatch(/private|fixture|SQL|seed-|token|hash|account/);
}
beforeAll(async () => {
  await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
  seed = await seedTrustedStudents(db, validation);
  // Isolated saved-history fixture on a free Slot; no occupancy or new Command.
  await db.prepare(`INSERT INTO student_reservations VALUES ('history-cancelled','seed-self','seed-slot-bookable',
    'student_cancelled','standard',NULL,CAST(strftime('%s','now') AS INTEGER),
    CAST(strftime('%s','now') AS INTEGER),CAST(strftime('%s','now') AS INTEGER))`).run();
  await checkTrustedSeedIntegrity(db, validation);
  key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  service = createReadOnlyStudentService({ database, applicationOrigin: origin, cursorKey: key });
});
beforeEach(() => { queries.length = 0; sessions.length = 0; failRead = false; otherRole = false; });

it("[TC-F-001-01 / TC-F-002-02 / TC-F-005-01 / TC-F-207-02 partial #899] composes all three real GETs with one read-only binding and owner isolation", async () => {
  const before = await snapshot();
  for (const owner of ["self", "other"] as const) {
    const schedule = await service.fetch(request(paths()[0], owner));
    expect(schedule.status).toBe(200);
    const view = await schedule.json() as ScheduleMonthView;
    expect(view).toEqual({ month: seed.month, slots: ["bookable", "self", "other", "group", "admin"].map((id, index) => ({
      slotId: `seed-slot-${id}`, startsAt: `${seed.date}T${10 + index}:00:00+09:00`, endsAt: `${seed.date}T${11 + index}:00:00+09:00`,
      view: id === "bookable" ? "bookable" : id === "group" ? "group_lesson" : id === owner ? "reserved_by_me" : "unavailable",
      ...(id === owner ? { reservationId: `seed-reservation-${owner}`, classification: "standard" } : {}),
    })) });
    const history = await service.fetch(request("/api/me/reservations", owner));
    expect(history.status).toBe(200);
    const result = await history.json() as ReservationHistoryView;
    expect(result.items.map((item) => item.reservationId)).toEqual(owner === "self"
      ? ["seed-reservation-self", "history-cancelled"] : ["seed-reservation-other"]);
    expect(result.items[0]).toEqual({ reservationId: `seed-reservation-${owner}`, reservationState: "confirmed", attendanceState: "none",
      classification: "standard", startsAt: `${seed.date}T${owner === "self" ? 11 : 12}:00:00+09:00`,
      endsAt: `${seed.date}T${owner === "self" ? 12 : 13}:00:00+09:00` });
    expect(result.nextCursor).toBeNull();
    const csrf = await service.fetch(request(paths()[2], owner));
    expect(csrf.status).toBe(200);
    expect(csrf.headers.get("referrer-policy")).toBe("no-referrer");
    const token = await csrf.json() as { csrfToken: string; scope: string };
    // Independently derive the existing domain-separated CSRF contract.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("student-csrf-v1:" + seed.sessions[owner].cookie().value));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(token.csrfToken === expected && token.scope === "session").toBe(true);
    for (const response of [schedule, history, csrf]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  }
  expect(queries.length).toBe(10); // Per owner: Guard+Schedule, Guard+History, Guard.
  expect(sessions.length).toBe(8); // Schedule Reader uses prepare; others Primary.
  await unchanged(before);
});

it("[TC-F-005-01 partial #899] paginates, rejects another owner, wrong-key and altered signed cursors before history read", async () => {
  const before = await snapshot();
  const first = await service.fetch(request("/api/me/reservations?limit=1"));
  expect(first.status).toBe(200);
  const page = await first.json() as ReservationHistoryView;
  expect(page.items.map((item) => item.reservationId)).toEqual(["seed-reservation-self"]);
  expect(typeof page.nextCursor === "string").toBe(true);
  const next = await service.fetch(request(`/api/me/reservations?limit=1&cursor=${page.nextCursor}`));
  expect(next.status).toBe(200);
  const last = await next.json() as ReservationHistoryView;
  expect(last.items.map((item) => [item.reservationId, item.reservationState, item.classification])).toEqual([
    ["history-cancelled", "student_cancelled", "not_applicable"],
  ]);
  expect(last.nextCursor).toBeNull();
  const wrongKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const position = (await db.prepare("SELECT starts_at FROM lesson_slots WHERE id='seed-slot-self'").first<{ starts_at: number }>())!;
  const wrongCursor = await new HmacReservationHistoryCursorCodec(wrongKey).encode("seed-self", {
    startsAt: position.starts_at, reservationId: "seed-reservation-self",
  });
  const cursor = page.nextCursor!;
  const parts = cursor.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  for (const [value, owner] of [[cursor, "other"], [wrongCursor, "self"], [parts.join("."), "self"]] as const) {
    queries.length = 0;
    await error(await service.fetch(request(`/api/me/reservations?cursor=${value}`, owner)), 400, "INVALID_REQUEST");
    expect(queries.length).toBe(1); // Auth only; rejected cursor cannot reach Repository.
  }
  await unchanged(before);
});

it("[TC-F-207-03 / TC-F-211-02 / TC-NF-914-04 partial #899] keeps 401, 403, API 404 and DB/integrity 503 classifications", async () => {
  const before = await snapshot();
  for (const path of paths()) {
    await error(await service.fetch(request(path, "missing")), 401, "UNAUTHENTICATED");
    otherRole = true;
    await error(await service.fetch(request(path)), 403, "FORBIDDEN");
    otherRole = false;
    failRead = true;
    await error(await service.fetch(request(path)), 503, "SERVICE_UNAVAILABLE");
    failRead = false;
  }
  await error(await service.fetch(request("/api/me/schedule-months/2000-01")), 404, "SCHEDULE_MONTH_NOT_AVAILABLE");
  await error(await service.fetch(request("/api/me/schedule-months/invalid")), 400, "INVALID_REQUEST");
  await unchanged(before);
  await db.prepare("UPDATE student_security_access SET access_state='suspended' WHERE student_id='seed-self'").run();
  try {
    const suspended = await snapshot();
    for (const path of paths()) {
      await error(await service.fetch(request(path)), 401, "UNAUTHENTICATED");
      expect((await service.fetch(request(path, "other"))).status).toBe(200);
    }
    await unchanged(suspended);
  } finally { await db.prepare("UPDATE student_security_access SET access_state='active' WHERE student_id='seed-self'").run(); }
  const row = await db.prepare("SELECT * FROM student_security_access WHERE student_id='seed-self'").first();
  await db.prepare("DELETE FROM student_security_access WHERE student_id='seed-self'").run();
  try {
    const broken = await snapshot();
    for (const path of paths()) await error(await service.fetch(request(path)), 503, "INTEGRITY_STATE_UNAVAILABLE");
    await unchanged(broken);
  } finally { await db.prepare("INSERT INTO student_security_access VALUES (?,?,?)").bind(row!.student_id, row!.access_state, row!.updated_at).run(); }
});

it("[TC-NF-914-04 partial #899] refuses unsupported methods/paths and foreign or non-HTTPS Request URLs before any D1 read", async () => {
  const before = await snapshot();
  for (const path of ["/", "/student", "/student/student.js", "/student/student.css", "/login", "/debug", "/api/auth/student/google/callback", "/api/me/reservations/preview", "/api/me/schedule-months/"]) {
    await error(await service.fetch(request(path)), 503, "SERVICE_UNAVAILABLE");
  }
  for (const path of paths()) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      await error(await service.fetch(request(path, "self", { method })), 503, "SERVICE_UNAVAILABLE");
    }
    for (const base of ["http://nssscdl.test", "https://other.test"]) {
      await error(await service.fetch(new Request(base + path)), 503, "SERVICE_UNAVAILABLE");
    }
  }
  expect(queries).toEqual([]);
  expect(sessions).toEqual([]);
  await unchanged(before);
});

it("[TC-F-207-02 partial #899] inherits CSRF GET Origin and Fetch Metadata refusal and never trusts public identity", async () => {
  const before = await snapshot();
  for (const headers of [{ origin: "https://other.test" }, { origin: "null" }]) {
    const response = await service.fetch(request(paths()[2], "self", { headers }));
    await error(response, 403, "CSRF_INVALID");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  for (const site of ["cross-site", "same-site", "none", ""]) {
    const req = request(paths()[2]);
    if (site) req.headers.set("sec-fetch-site", site); else req.headers.delete("sec-fetch-site");
    await error(await service.fetch(req), 403, "CSRF_INVALID");
  }
  expect(queries.length).toBe(0);
  for (const path of paths()) {
    const req = request(path, "missing", { headers: { "x-student-id": "seed-self", "x-role": "student", cookie: "__Host-student_preauth=public" } });
    await error(await service.fetch(req), 401, "UNAUTHENTICATED");
  }
  await error(await service.fetch(request("/api/me/reservations?studentId=seed-other")), 400, "INVALID_REQUEST");
  await unchanged(before);
});

it("[#899 trusted config fail-closed] missing/nonconforming binding, canonical origin or native non-exportable signing key disables all routes", async () => {
  const before = await snapshot();
  const exportable = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
  const wrongHash = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-384" }, false, ["sign"]);
  const verifyOnly = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const valid = { database, applicationOrigin: origin, cursorKey: key };
  const invalid: unknown[] = [undefined, null, {}, { ...valid, database: undefined },
    { ...valid, database: {} }, { ...valid, database: { prepare: database.prepare } },
    { ...valid, database: { withSession: database.withSession } },
    ...[undefined, "http://nssscdl.test", origin + "/", origin + "/student", "https://user:pass@nssscdl.test", origin.toUpperCase()]
      .map((applicationOrigin) => ({ ...valid, applicationOrigin })),
    ...[undefined, "env-text", {}, exportable, wrongHash, verifyOnly, aes,
      { type: "secret", extractable: false, algorithm: { name: "HMAC", hash: { name: "SHA-256" } }, usages: ["sign"] }]
      .map((cursorKey) => ({ ...valid, cursorKey })),
  ];
  for (const config of invalid) {
    const disabled = createReadOnlyStudentService(config as Partial<ReadOnlyStudentConfig>);
    for (const path of paths()) {
      const response = await disabled.fetch(request(path));
      await error(response, 503, "SERVICE_UNAVAILABLE");
      if (path === paths()[2]) expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  }
  expect(queries).toEqual([]);
  expect(sessions).toEqual([]);
  await unchanged(before);
});
