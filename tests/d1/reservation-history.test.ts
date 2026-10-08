import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ReservationHistoryService, type ReservationHistoryView } from "../../src/application/reservation-history";
import { ReservationHistoryHttpAdapter } from "../../src/http/reservation-history";
import { D1ReservationHistoryRepository, reservationHistorySql } from "../../src/infrastructure/d1-reservation-history";
import { HmacReservationHistoryCursorCodec } from "../../src/infrastructure/reservation-history-cursor";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { hashToken, token } from "../integration/student-session-fixture";

const db = env.AUTH_DB;
const sql = (query: string) => db.prepare(query);
const start = Date.parse("2026-11-01T10:00:00+09:00") / 1000;
const now = "CAST(strftime('%s','now') AS INTEGER)";
const repository = new D1ReservationHistoryRepository(db);
let codec: HmacReservationHistoryCursorCodec, adapter: ReservationHistoryHttpAdapter;
const request = (suffix = "", sessionToken = token) => new Request(`https://nssscdl.test/api/me/reservations${suffix}`, {
  headers: { cookie: `__Host-student_session=${sessionToken}` },
});
const expectedIds = ["r-z", "r-y", "r-x", "r-w", "r-v", "r-u"];
beforeAll(async () => {
  await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
  codec = new HmacReservationHistoryCursorCodec(await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  adapter = new ReservationHistoryHttpAdapter(new D1StudentAccessGuard(db), new ReservationHistoryService(repository, codec));
  await db.batch([
    sql("INSERT INTO students VALUES ('student', 'active', NULL), ('private-other', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 0), ('private-other', 'active', 0)"),
    sql("INSERT INTO student_accounts VALUES ('account', 'student', 'student'), ('other-account', 'private-other', 'student')"),
    sql(`INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ${now}, ${now}+86400, NULL)`)
      .bind(await hashToken()),
    sql(`INSERT INTO student_sessions VALUES ('other-session', 'other-account', 'student', ?, ${now}, ${now}+86400, NULL)`)
      .bind(await hashToken("B".repeat(43))),
    sql("INSERT INTO schedule_months VALUES ('month', '2026-11', 0, 0, 0)"),
    sql("INSERT INTO lesson_slots VALUES ('slot', 'month', '2026-11-01', '10:00', '11:00', ?, ?, 'enabled')")
      .bind(start, start + 3600),
    sql("INSERT INTO lesson_slots VALUES ('older', 'month', '2026-11-01', '09:00', '10:00', ?, ?, 'enabled')")
      .bind(start - 3600, start),
    sql(`INSERT INTO student_reservations VALUES
      ('r-z', 'student', 'slot', 'confirmed', 'standard', 'standard', 0, NULL, 0),
      ('r-y', 'student', 'slot', 'confirmed', 'additional', 'additional', 0, NULL, 0),
      ('r-x', 'student', 'slot', 'confirmed', 'standard', NULL, 0, NULL, 0),
      ('r-w', 'student', 'slot', 'student_cancelled', 'standard', NULL, 0, 1, 1),
      ('r-v', 'student', 'slot', 'school_cancelled', 'standard', NULL, 0, 1, 1),
      ('r-u', 'student', 'older', 'system_cancelled', 'standard', NULL, 0, 1, 1),
      ('private-reservation', 'private-other', 'slot', 'student_cancelled', 'standard', NULL, 0, 1, 1)`),
    sql("INSERT INTO reservation_absences VALUES ('r-x', 1, 'actor'), ('r-v', 1, 'actor')"),
  ]);
});
// These are schema-state history fixtures, not proof of cancellation/absence
// Commands, current occupancy integrity, Browser UI or System/Acceptance Pass.
describe("[TC-F-005-01] real D1 + Production Guard + isolated HTTP partial evidence", () => {
  it("returns exact independent public states and current effective classifications", async () => {
    const response = await adapter.fetch(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const view = await response.json() as ReservationHistoryView;
    expect(view).toEqual({ items: [
      ["r-z", "confirmed", "none", "standard"], ["r-y", "confirmed", "none", "additional"],
      ["r-x", "confirmed", "absent", "not_applicable"], ["r-w", "student_cancelled", "none", "not_applicable"],
      ["r-v", "school_cancelled", "absent", "not_applicable"], ["r-u", "system_cancelled", "none", "not_applicable"],
    ].map(([reservationId, reservationState, attendanceState, classification]) => ({
      reservationId, reservationState, attendanceState, classification,
      startsAt: reservationId === "r-u" ? "2026-11-01T09:00:00+09:00" : "2026-11-01T10:00:00+09:00",
      endsAt: reservationId === "r-u" ? "2026-11-01T10:00:00+09:00" : "2026-11-01T11:00:00+09:00",
    })), nextCursor: null });
    expect(JSON.stringify(view)).not.toMatch(/private-|studentId|slotId|sort|override|rowid|createdAt/);
  });
  it("pages in exact DESC order without duplicates/omissions in unchanged fixture", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await adapter.fetch(request(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`));
      expect(response.status).toBe(200);
      const view = await response.json() as ReservationHistoryView;
      ids.push(...view.items.map((item) => item.reservationId));
      cursor = view.nextCursor;
    } while (cursor);
    expect(ids).toEqual(expectedIds);
    expect((await new ReservationHistoryService(repository, codec).execute("student", 100)).nextCursor).toBeNull();
  });
  it("never mixes another owner and rejects cursor substitution at HTTP", async () => {
    const first = await (await adapter.fetch(request("?limit=1"))).json() as ReservationHistoryView;
    const other = await adapter.fetch(request(`?cursor=${first.nextCursor}`, "B".repeat(43)));
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    const view = await (await adapter.fetch(request("", "B".repeat(43)))).json() as ReservationHistoryView;
    expect(view.items.map((item) => item.reservationId)).toEqual(["private-reservation"]);
  });
  it("maps real unauthenticated Session to 401 and cookie deletion", async () => {
    const response = await adapter.fetch(request("", "C".repeat(43)));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("does not modify Reservation, Occupancy, Audit, Intent or Session (including paging)", async () => {
    const tables = ["student_reservations", "slot_occupancies", "business_audit_logs", "notification_intents",
      "notification_outbox", "command_guards", "student_sessions", "reservation_absences"];
    const snapshot = async () => Promise.all(tables.map(async (table) => (await sql(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
    const before = await snapshot();
    await adapter.fetch(request("?limit=1"));
    await adapter.fetch(request());
    expect(await snapshot()).toEqual(before);
    expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("detects a persisted unrepresentable datetime instead of guessing", async () => {
    await sql("UPDATE lesson_slots SET starts_at = ? WHERE id = 'older'").bind(-Number.MAX_SAFE_INTEGER).run();
    try {
      const response = await adapter.fetch(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "INTEGRITY_STATE_UNAVAILABLE" } });
    } finally { await sql("UPDATE lesson_slots SET starts_at = ? WHERE id = 'older'").bind(start - 3600).run(); }
  });
  it("abstracts actual D1 query failure as SERVICE_UNAVAILABLE", async () => {
    const broken = new D1ReservationHistoryRepository({ withSession(constraint) {
      const session = db.withSession(constraint);
      return { prepare: (query) => session.prepare(query.replace("FROM student_reservations AS r", "FROM missing_test_relation AS r")) };
    } });
    const http = new ReservationHistoryHttpAdapter(new D1StudentAccessGuard(db), new ReservationHistoryService(broken, codec));
    const response = await http.fetch(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
  });
  it.each([false, true])("verifies existing owner index + Slot PK and permitted temporary sort (cursor=%s)", async (hasCursor) => {
    const args = hasCursor ? ["student", start + 1, start + 1, "z", 51] : ["student", 51];
    const plan = (await sql(`EXPLAIN QUERY PLAN ${reservationHistorySql(hasCursor)}`).bind(...args).all()).results;
    const detail = plan.map((item) => item.detail).join("\n");
    expect(detail).toContain("ix_reservations_student_slot");
    expect(detail).toMatch(/SEARCH s USING INDEX sqlite_autoindex_lesson_slots_1/);
    expect(detail).toContain("USE TEMP B-TREE FOR ORDER BY");
  });
});
