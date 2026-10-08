import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { seedTrustedStudents, checkTrustedSeedIntegrity } from "../fixtures/d1/trusted-student-seed";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { D1ScheduleQueryRepository } from "../../src/infrastructure/d1-schedule-query";
import { ScheduleQueryService, type ScheduleMonthView } from "../../src/application/schedule-query";
import { ScheduleMonthHttpAdapter } from "../../src/http/schedule-month";
import { D1ReservationHistoryRepository } from "../../src/infrastructure/d1-reservation-history";
import { HmacReservationHistoryCursorCodec } from "../../src/infrastructure/reservation-history-cursor";
import { ReservationHistoryService, type ReservationHistoryView } from "../../src/application/reservation-history";
import { ReservationHistoryHttpAdapter } from "../../src/http/reservation-history";

// Unchanged Production migrations on the existing file-isolated local AUTH_DB.
const db = env.AUTH_DB;
const validation = { authSql: env.AUTH_INTEGRITY_SQL, reservationScans: env.RESERVATION_INTEGRITY_SCANS };
const sql = (query: string) => db.prepare(query);
let seed: Awaited<ReturnType<typeof seedTrustedStudents>>;
let history: ReservationHistoryHttpAdapter;
const guard = new D1StudentAccessGuard(db);
const schedule = new ScheduleMonthHttpAdapter(guard,
  new ScheduleQueryService(new D1ScheduleQueryRepository(db), { now: () => Math.floor(Date.now() / 1000) }));
const request = (path: string, owner: "self" | "other" = "self") => {
  const cookie = seed.sessions[owner].cookie();
  return new Request(`https://nssscdl.test${path}`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
};
// Never feed secret-bearing rows to an assertion diff or artifact.
const snapshot = async () => {
  const rows = (await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '_cf_METADATA') ORDER BY name")
    .all<{ name: string }>()).results;
  const data = await Promise.all(rows.map(async ({ name }) => (await sql(`SELECT * FROM ${name} ORDER BY rowid`).all()).results));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(data))));
};
const unchanged = async (before: Uint8Array) => {
  const after = await snapshot();
  expect(before.every((byte, index) => byte === after[index]) && before.length === after.length).toBe(true);
};
beforeAll(async () => {
  expect([...env.AUTH_MIGRATIONS, ...env.RESERVATION_MIGRATIONS].map((m: { name: string }) => m.name.slice(0, 4)))
    .toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0")));
  await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
  await checkTrustedSeedIntegrity(db, validation);
  seed = await seedTrustedStudents(db, validation);
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  history = new ReservationHistoryHttpAdapter(guard,
    new ReservationHistoryService(new D1ReservationHistoryRepository(db), new HmacReservationHistoryCursorCodec(key)));
});

it("[TC-F-207-02 / TC-F-207-03 partial local D1 / #898] seeds independent canonical Sessions, only hashes in DB, correct owners and fixed D1 expiry", async () => {
  const tokens = [seed.sessions.self.cookie().value, seed.sessions.other.cookie().value];
  expect(tokens[0] !== tokens[1]).toBe(true);
  for (const [index, owner] of (["self", "other"] as const).entries()) {
    const { value, ...attributes } = seed.sessions[owner].cookie();
    expect(attributes).toEqual({ name: "__Host-student_session", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    expect(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)).toBe(true);
    expect(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=").length === 32).toBe(true);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const row = await sql(`SELECT *, CAST(strftime('%s','now') AS INTEGER) AS t
      FROM student_session_access_v1 WHERE session_id=?`).bind(`seed-session-${owner}`).first();
    expect(row?.token_hash === digest && /^[0-9a-f]{64}$/.test(String(row?.token_hash))).toBe(true);
    expect(row?.student_id === `seed-${owner}` && row?.account_id === `seed-account-${owner}` &&
      row?.role_scope === "student" && row?.access_state === "active" && row?.lifecycle === "active").toBe(true);
    expect(Number(row?.created_at) <= Number(row?.t) && Number(row?.t) < Number(row?.expires_at) &&
      Number(row?.expires_at) - Number(row?.created_at) === 86400 && row?.revoked_at === null).toBe(true);
    const stored = JSON.stringify((await sql("SELECT * FROM student_sessions").all()).results);
    expect(!stored.includes(tokens[index]) && !JSON.stringify(seed).includes(tokens[index])).toBe(true);
    expect(await guard.authorize(request("/", owner))).toEqual({ status: "authenticated", studentId: `seed-${owner}` });
  }
  await checkTrustedSeedIntegrity(db, validation);
});

it("[TC-F-001-01 / TC-F-001-02 / TC-F-002-01 / TC-F-002-02 partial local D1/HTTP / #898] real Guard and Read Adapter return published future Tokyo Slots and four Views without other owner data", async () => {
  const before = await snapshot();
  expect(await sql(`SELECT COUNT(*) AS n FROM lesson_slots WHERE starts_at > CAST(strftime('%s','now') AS INTEGER)
    AND lesson_date = ?`).bind(seed.date).first("n")).toBe(5);
  expect(await sql("SELECT published_at IS NOT NULL AS published FROM schedule_months WHERE month_key=?")
    .bind(seed.month).first("published")).toBe(1);
  // Independent D1 calendar calculation; host timezone cannot choose the month.
  expect(seed.date).toBe(await sql("SELECT strftime('%Y-%m-%d','now','+9 hours','start of month','+1 month','+14 days') AS d").first("d"));
  for (const owner of ["self", "other"] as const) {
    const response = await schedule.fetch(request(`/api/me/schedule-months/${seed.month}`, owner));
    expect(response.status).toBe(200);
    const view = await response.json() as ScheduleMonthView;
    expect(view).toEqual({ month: seed.month, slots: ["bookable", "self", "other", "group", "admin"].map((id, index) => ({
      slotId: `seed-slot-${id}`, startsAt: `${seed.date}T${10 + index}:00:00+09:00`,
      endsAt: `${seed.date}T${11 + index}:00:00+09:00`,
      view: id === "bookable" ? "bookable" : id === "group" ? "group_lesson" : id === owner ? "reserved_by_me" : "unavailable",
      ...(id === owner ? { reservationId: `seed-reservation-${owner}`, classification: "standard" } : {}),
    })) });
    const wire = JSON.stringify(view);
    expect(!wire.includes(`seed-reservation-${owner === "self" ? "other" : "self"}`) &&
      !/studentId|account|session|token|hash|email|operator|occupancy/.test(wire)).toBe(true);
  }
  await unchanged(before);
});

it("[TC-F-005-01 partial local D1/HTTP / #898] returns only current owner's history through real Guard/Repository", async () => {
  const before = await snapshot();
  for (const owner of ["self", "other"] as const) {
    const response = await history.fetch(request("/api/me/reservations", owner));
    expect(response.status).toBe(200);
    const view = await response.json() as ReservationHistoryView;
    const hour = owner === "self" ? 11 : 12;
    expect(view).toEqual({ items: [{ reservationId: `seed-reservation-${owner}`, reservationState: "confirmed",
      attendanceState: "none", classification: "standard", startsAt: `${seed.date}T${hour}:00:00+09:00`,
      endsAt: `${seed.date}T${hour + 1}:00:00+09:00` }], nextCursor: null });
  }
  await unchanged(before);
  await checkTrustedSeedIntegrity(db, validation);
});

it("[#898 seed fail-closed] rejects populated DB without changing any authoritative rows", async () => {
  const before = await snapshot();
  await expect(seedTrustedStudents(db, validation)).rejects.toThrow("TRUSTED_LOCAL_SEED_FAILED");
  await unchanged(before);
});

it("[TC-F-207-03 partial local D1/HTTP / #898] revoked Session fails closed on both GETs without revoking another Session or extending expiry", async () => {
  await sql("UPDATE student_sessions SET revoked_at=created_at WHERE id='seed-session-self'").run();
  const before = await snapshot();
  for (const [adapter, path] of [[schedule, `/api/me/schedule-months/${seed.month}`], [history, "/api/me/reservations"]] as const) {
    const response = await adapter.fetch(request(path));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect((await adapter.fetch(request(path, "other"))).status).toBe(200);
  }
  await unchanged(before);
  await checkTrustedSeedIntegrity(db, validation);
});

it("[TC-F-207-02 partial local D1/HTTP / #898] D1 expiry equality fails closed for the seeded credential", async () => {
  // Only this isolated test replaces immutable Session timestamps. The helper
  // has no expiry control, reset or update interface.
  const row = await sql("SELECT * FROM student_sessions WHERE id='seed-session-self'").first();
  await db.batch([sql("DELETE FROM student_sessions WHERE id='seed-session-self'"),
    sql(`INSERT INTO student_sessions VALUES ('seed-session-self','seed-account-self','student',?,
      CAST(strftime('%s','now') AS INTEGER)-86400,CAST(strftime('%s','now') AS INTEGER),NULL)`).bind(row!.token_hash)]);
  try {
    const before = await snapshot();
    for (const [adapter, path] of [[schedule, `/api/me/schedule-months/${seed.month}`], [history, "/api/me/reservations"]] as const) {
      expect((await adapter.fetch(request(path))).status).toBe(401);
      expect((await adapter.fetch(request(path, "other"))).status).toBe(200);
    }
    await unchanged(before);
  } finally {
    await db.batch([sql("DELETE FROM student_sessions WHERE id='seed-session-self'"),
      sql("INSERT INTO student_sessions VALUES (?,?,?,?,?,?,?)")
        .bind(row!.id, row!.account_id, row!.role_scope, row!.token_hash, row!.created_at, row!.expires_at, row!.revoked_at)]);
  }
});
