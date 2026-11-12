import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ReservationPreviewService, previewReservation } from "../../src/application/reservation-preview";
import { ReservationPreviewHttpAdapter } from "../../src/http/reservation-preview";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { D1ReservationPreviewRepository } from "../../src/infrastructure/d1-reservation-preview";
import { db, identity, now, repository, seedPreviewFixture, sql } from "./reservation-preview-fixture";
import { hashToken, token } from "../integration/student-session-fixture";

const origin = "https://nssscdl.test";
const clearCookie = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
beforeAll(async () => seedPreviewFixture("preview-http-file"));
beforeEach(async () => {
  // Test-only source time reuses #863 isolation; auth View/migrations unchanged.
  // Fresh Session is seeded after restoring access so suspension cannot revive it.
  await sql("UPDATE student_security_access SET access_state = 'active'").run();
  await sql("DELETE FROM student_sessions WHERE id = 'session'").run();
  await sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
    .bind(await hashToken(), now - 60, now + 86400).run();
  await sql("DELETE FROM student_monthly_lesson_configs").run();
  await sql("UPDATE schedule_months SET published_at = 0").run();
  await sql("UPDATE lesson_slots SET availability_status = 'enabled'").run();
});

async function request(slotId = "target") {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("student-csrf-v1:" + token));
  const csrf = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return new Request(origin + "/api/me/reservations/preview", { method: "POST", body: JSON.stringify({ slotId }),
    headers: { "content-type": "application/json", origin, "x-csrf-token": csrf, cookie: `__Host-student_session=${token}` } });
}

function composition(readRepository = repository()) {
  const source = { withSession(constraint: "first-primary") {
    const session = db.withSession(constraint);
    return { prepare(query: string) {
      return session.prepare(query.replace("CAST(strftime('%s','now') AS INTEGER)", String(now)));
    } };
  } };
  const guard = new D1StudentAccessGuard(source);
  const resolve = vi.spyOn(guard, "resolve");
  const read = vi.spyOn(readRepository, "readPreview");
  const http = new ReservationPreviewHttpAdapter(guard, new ReservationPreviewService(readRepository), origin);
  return { http, resolve, read };
}

it("[TC-F-003-01 / TC-F-003-02 partial D1/HTTP] composes real Guard, read and core with exact Views", async () => {
  const fixture = composition();
  for (const n of [null, 1, 2]) {
    await sql("DELETE FROM student_monthly_lesson_configs").run();
    if (n !== null) await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', ?, 0, 'actor')").bind(n).run();
    const before = (await sql("SELECT * FROM student_reservations ORDER BY id").all()).results;
    const response = await fixture.http.fetch(await request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const captured = await repository().readPreview(identity, "target");
    const view = await response.json();
    expect(view).toEqual(await previewReservation(identity, captured.state, captured.evaluatedAt));
    expect(view).toMatchObject({ previewClassification: n === 1 ? "additional" : "standard",
      classificationChanges: n === 1 || n === 2 ? [{ reservationId: "later-r", startsAt: "2026-11-22T10:00:00+09:00", before: "standard", after: "additional" }] : [] });
    expect((await sql("SELECT * FROM student_reservations ORDER BY id").all()).results).toEqual(before);
    for (const value of [token, await hashToken(), "private-other", "canonicalSnapshot", '"studentId"', "standardCount"]) {
      expect(JSON.stringify(view)).not.toContain(value);
    }
  }
  expect(fixture.resolve).toHaveBeenCalledTimes(3);
  expect(fixture.read).toHaveBeenCalledTimes(3);
  expect(fixture.read).toHaveBeenCalledWith(identity, "target");
  expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it.each(["expired", "revoked", "suspended"])("[TC-F-207-03 partial D1/HTTP] rejects %s before CSRF/read", async (mode) => {
  const fixture = composition();
  if (mode === "expired") {
    await sql("DELETE FROM student_sessions WHERE id = 'session'").run();
    await sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
      .bind(await hashToken(), now - 60, now).run();
  }
  if (mode === "revoked") await sql("UPDATE student_sessions SET revoked_at = ? WHERE id = 'session'").bind(now).run();
  if (mode === "suspended") await sql("UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'").run();
  const req = await request();
  req.headers.delete("x-csrf-token");
  const response = await fixture.http.fetch(req);
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBe(clearCookie);
  expect(fixture.read).not.toHaveBeenCalled();
});

it("[#865 isolated D1] bad CSRF does not enter Preview Repository", async () => {
  const fixture = composition();
  const req = await request();
  req.headers.set("origin", "null");
  const response = await fixture.http.fetch(req);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });
  expect(fixture.resolve).toHaveBeenCalledTimes(1);
  expect(fixture.read).not.toHaveBeenCalled();
});

it.each([
  ["missing", 409, "RESERVATION_NOT_AVAILABLE"], ["admin", 409, "RESERVATION_NOT_AVAILABLE"],
  ["group", 409, "RESERVATION_NOT_AVAILABLE"], ["past", 409, "RESERVATION_WINDOW_CLOSED"],
  ["integrity", 503, "INTEGRITY_STATE_UNAVAILABLE"], ["sql-error", 503, "SERVICE_UNAVAILABLE"],
] as const)("[TC-NF-914-04 partial D1/HTTP] maps %s safely and preserves Cookie", async (mode, status, code) => {
  const readRepository = mode === "sql-error" ? repository(now, (query) => query.replace("student_session_access_v1", "missing_source")) : repository();
  const fixture = composition(readRepository);
  const start = Date.parse("2026-11-22T10:00:00+09:00") / 1000;
  if (mode === "integrity") await sql("UPDATE lesson_slots SET lesson_date = 'invalid' WHERE id = 'later'").run();
  let response;
  try { response = await fixture.http.fetch(await request(["integrity", "sql-error"].includes(mode) ? "target" : mode)); }
  finally {
    if (mode === "integrity") await sql("UPDATE lesson_slots SET lesson_date = '2026-11-22', starts_at = ? WHERE id = 'later'").bind(start).run();
  }
  expect(response.status).toBe(status);
  expect(response.headers.get("set-cookie")).toBeNull();
  const body = await response.json();
  expect(body).toMatchObject({ error: { code, retry: status === 409 ? "reload" : "later" } });
  for (const value of [token, await hashToken(), "private-other", "SELECT", "missing_source", "canonicalSnapshot"]) {
    expect(JSON.stringify(body)).not.toContain(value);
  }
});

it("[#865 real D1 time partial evidence] resolves and previews without synthetic T0", async () => {
  await sql("DELETE FROM student_sessions WHERE id = 'session'").run();
  await sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, CAST(strftime('%s','now') AS INTEGER) - 60, CAST(strftime('%s','now') AS INTEGER) + 3600, NULL)")
    .bind(await hashToken()).run();
  const http = new ReservationPreviewHttpAdapter(new D1StudentAccessGuard(db),
    new ReservationPreviewService(new D1ReservationPreviewRepository(db)), origin);
  // Missing target gives a deterministic business rejection for any wall date;
  // authenticated real-time D1 resolution must have succeeded to reach 409.
  const response = await http.fetch(await request("missing"));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "RESERVATION_NOT_AVAILABLE" } });
});
