import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { ScheduleQueryService } from "../../src/application/schedule-query";
import { ScheduleMonthHttpAdapter } from "../../src/http/schedule-month";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { hashToken, request, token } from "../integration/student-session-fixture";

// #842: actual Production migration and Guard in isolated local AUTH_DB.
// Read consumer uses its existing Repository Port; no new reservation schema.
const db = env.AUTH_DB;
const sql = (query: string) => db.prepare(query);
const guard = () => new D1StudentAccessGuard(db);

beforeEach(async () => {
  await db.batch([
    sql("DELETE FROM student_sessions"), sql("DELETE FROM student_accounts"),
    sql("DELETE FROM student_security_access"), sql("DELETE FROM students"),
    sql("INSERT INTO students VALUES ('student', 'active', NULL), ('other', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 100), ('other', 'active', 100)"),
    sql("INSERT INTO student_accounts VALUES ('account', 'student', 'student'), ('other-account', 'other', 'student')"),
    sql(`INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?,
      CAST(strftime('%s','now') AS INTEGER) - 60,
      CAST(strftime('%s','now') AS INTEGER) + 2591900, NULL)`).bind(await hashToken()),
  ]);
});

it("[TC-F-003-06 partial D1/HTTP] resolves real D1 identity and internal Context, ignoring supplied identity", async () => {
  const input = request();
  input.headers.set("studentId", "other");
  input.headers.set("email", "other@example.test");
  input.headers.set("role", "admin");
  expect(await guard().authorize(input)).toEqual({ status: "authenticated", studentId: "student" });
  expect(await guard().resolve(input)).toEqual({ status: "authenticated", context: {
    sessionId: "session", tokenHash: await hashToken(), studentId: "student",
  } });
  const startsAt = Date.parse("2026-11-01T10:00:00+09:00") / 1000;
  const readMonth = vi.fn(async () => ({ month: "2026-11", publishedAt: 100, slots: [{
    slotId: "slot", startsAt, endsAt: startsAt + 3600, availability: "enabled" as const,
    occupancies: [{ slotId: "slot", type: "student_reservation" as const, reservationId: "own" }],
    reservations: [{ reservationId: "own", slotId: "slot", studentId: "student", status: "confirmed" as const, classification: "standard" as const }],
    integrity: "consistent" as const,
  }] }));
  const http = new ScheduleMonthHttpAdapter(guard(), new ScheduleQueryService({ readMonth }, { now: () => startsAt - 1 }));
  const response = await http.fetch(input);
  expect(response.status).toBe(200);
  const body = await response.json() as { slots: { view: string; reservationId: string }[] };
  expect(body.slots[0]).toMatchObject({ view: "reserved_by_me", reservationId: "own" });
  expect(JSON.stringify(body)).not.toContain(await hashToken());
  expect(JSON.stringify(body)).not.toContain('"studentId"');
  const context = await guard().resolve(input);
  if (context.status !== "authenticated") expect.unreachable();
  // Existing §8.3 predicate consumes real resolved Context, not a fake ID.
  const allowed = (studentId: string) => sql(`SELECT EXISTS (
    SELECT 1 FROM student_session_access_v1 AS a
    WHERE a.session_id = ? AND a.token_hash = ? AND a.student_id = ? AND a.role_scope = 'student'
      AND a.revoked_at IS NULL AND a.created_at <= CAST(strftime('%s','now') AS INTEGER)
      AND a.expires_at > CAST(strftime('%s','now') AS INTEGER)
      AND a.lifecycle = 'active' AND a.deleted_at IS NULL AND a.access_state = 'active'
  ) AS allowed`).bind(context.context.sessionId, context.context.tokenHash, studentId).first("allowed");
  expect(await allowed(context.context.studentId)).toBe(1);
  expect(await allowed("other")).toBe(0);
  await sql("UPDATE student_sessions SET revoked_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = 'session'").run();
  expect(await allowed(context.context.studentId)).toBe(0);
});

it.each(["expired", "equal-expiry", "future", "revoked"])(
  "[TC-F-207-02 / TC-F-207-03 partial D1] rejects %s using SQL time", async (mode) => {
    await sql("DELETE FROM student_sessions").run();
    const now = "CAST(strftime('%s','now') AS INTEGER)";
    const created = mode === "future" ? `${now} + 60` : `${now} - 100`;
    const expires = mode === "expired" ? `${now} - 1` : mode === "equal-expiry" ? now : `${now} + 120`;
    await sql(`INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ${created}, ${expires}, ${mode === "revoked" ? now : "NULL"})`)
      .bind(await hashToken()).run();
    expect(await guard().authorize(request())).toEqual({ status: "unauthenticated" });
  },
);

it("[TC-F-207-02 partial D1] leaves expiry unchanged across repeated Requests", async () => {
  const before = await sql("SELECT created_at, expires_at FROM student_sessions").first();
  const adapter = guard();
  await adapter.authorize(request());
  await adapter.authorize(request());
  expect(await sql("SELECT created_at, expires_at FROM student_sessions").first()).toEqual(before);
});

it.each(["access", "lifecycle"])(
  "[TC-F-211-02 / TC-F-311-02 partial D1] observes %s changes on next Request without cache", async (mode) => {
    const adapter = guard();
    expect((await adapter.authorize(request())).status).toBe("authenticated");
    await sql(mode === "access"
      ? "UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"
      : "UPDATE students SET lifecycle = 'deleted', deleted_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = 'student'").run();
    expect(await adapter.authorize(request())).toEqual({ status: "unauthenticated" });
  },
);

it("[TC-F-211-03 partial D1] does not revive revoked Session after suspension release; new Session is required", async () => {
  const adapter = guard();
  await db.withSession("first-primary").batch([
    sql("UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"),
    sql("UPDATE student_sessions SET revoked_at = CAST(strftime('%s','now') AS INTEGER) WHERE account_id = 'account' AND revoked_at IS NULL"),
  ]);
  expect(await adapter.authorize(request())).toEqual({ status: "unauthenticated" });
  await sql("UPDATE student_security_access SET access_state = 'active' WHERE student_id = 'student'").run();
  expect(await adapter.authorize(request())).toEqual({ status: "unauthenticated" });
  const newToken = "B".repeat(42) + "A";
  await sql(`INSERT INTO student_sessions VALUES ('new', 'account', 'student', ?,
    CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER) + 2592000, NULL)`)
    .bind(await hashToken(newToken)).run();
  expect(await adapter.authorize(request(`__Host-student_session=${newToken}`)))
    .toEqual({ status: "authenticated", studentId: "student" });
});

it("[#842 D1 integrity] rejects missing SecurityAccess as safe 503 and keeps Cookie", async () => {
  await sql("DELETE FROM student_security_access WHERE student_id = 'student'").run();
  await expect(guard().authorize(request())).rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
  const readMonth = vi.fn(async () => null);
  const http = new ScheduleMonthHttpAdapter(guard(), new ScheduleQueryService({ readMonth }, { now: () => 150 }));
  const response = await http.fetch(request());
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toMatchObject({ error: { code: "INTEGRITY_STATE_UNAVAILABLE" } });
  expect(readMonth).not.toHaveBeenCalled();
  expect(await sql("SELECT COUNT(*) AS n FROM student_security_access WHERE student_id = 'student'").first("n")).toBe(0);
});

it("[#842 D1 token] rejects unknown / Admin token without granting another role", async () => {
  expect(await guard().authorize(request(`__Host-student_session=${"C".repeat(42)}A`)))
    .toEqual({ status: "unauthenticated" });
  expect(await guard().authorize(request(`__Host-admin_session=${token}`)))
    .toEqual({ status: "unauthenticated" });
});

it("[TC-NF-914-04 partial D1/HTTP] abstracts real SQL lookup failure without clearing Cookie", async () => {
  // Test-only source adapter triggers an actual local D1 error, without changing
  // Production schema, disabling constraints or adding a runtime bypass.
  const failed = new D1StudentAccessGuard({ withSession(constraint) {
    const session = db.withSession(constraint);
    return { prepare(query) {
      return session.prepare(query.replace("student_session_access_v1", "missing_auth_source"));
    } };
  } });
  const readMonth = vi.fn(async () => null);
  const http = new ScheduleMonthHttpAdapter(failed, new ScheduleQueryService({ readMonth }, { now: () => 150 }));
  const response = await http.fetch(request());
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toEqual({ error: {
    code: "SERVICE_UNAVAILABLE", message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later",
  } });
  expect(readMonth).not.toHaveBeenCalled();
});
