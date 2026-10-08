import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import { ReservationPreviewService } from "../../src/application/reservation-preview";
import { ReservationConfirmHttpAdapter } from "../../src/http/reservation-confirm";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { D1ReservationPreviewRepository } from "../../src/infrastructure/d1-reservation-preview";
import { D1ReservationConfirmExecutor } from "../../src/infrastructure/d1-reservation-confirm";
import { D1ReservationConfirmTransaction } from "../../src/infrastructure/d1-reservation-confirm-transaction";
import { D1ReservationCommitVerifier } from "../../src/infrastructure/d1-reservation-commit-verification";
import { hashToken, token } from "../integration/student-session-fixture";

const db = env.AUTH_DB;
const sql = (query: string) => db.prepare(query);
const origin = "https://nssscdl.test";
const time = Date.parse("2026-11-10T10:00:00+09:00") / 1000;
const start = Date.parse("2026-11-15T10:00:00+09:00") / 1000;
const nowSql = "CAST(strftime('%s','now') AS INTEGER)";

beforeAll(async () => { await applyD1Migrations(db, env.RESERVATION_MIGRATIONS); });
beforeEach(async () => {
  await db.batch([
    ...["notification_outbox", "notification_intents", "business_audit_logs", "command_guards", "slot_occupancies",
      "student_reservations", "student_monthly_lesson_configs", "lesson_slots", "schedule_months", "student_sessions",
      "student_accounts", "student_security_access", "students"].map((table) => sql(`DELETE FROM ${table}`)),
    sql("INSERT INTO students VALUES ('student', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 0)"),
    sql("INSERT INTO student_accounts VALUES ('account', 'student', 'student')"),
    sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
      .bind(await hashToken(), time - 1, start + 86400),
    sql("INSERT INTO schedule_months VALUES ('month', '2026-11', 0, 0, 0)"),
    sql("INSERT INTO lesson_slots VALUES ('target', 'month', '2026-11-15', '10:00', '11:00', ?, ?, 'enabled')")
      .bind(start, start + 3600),
  ]);
});

async function setup(mode = "normal") {
  let now = time;
  const primary = vi.fn();
  // Existing D1 interface and isolated time injection, without runtime wiring.
  const reads = { withSession(constraint: "first-primary") {
    primary(constraint);
    const session = db.withSession(constraint);
    return { prepare(query: string) { return session.prepare(query.replaceAll(nowSql, String(now))); } };
  } };
  const guard = new D1StudentAccessGuard(reads);
  const resolve = vi.spyOn(guard, "resolve");
  const repository = new D1ReservationPreviewRepository(reads);
  const preparation = new ReservationConfirmPreparationService(repository);
  const prepare = vi.spyOn(preparation, "prepare");
  const preview = await new ReservationPreviewService(repository).execute("target", { studentId: "student" });
  primary.mockClear();
  const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
    if (mode === "changed") await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 0, 0, 'actor')").run();
    if (mode === "unavailable") await sql("UPDATE lesson_slots SET availability_status = 'disabled'").run();
    if (mode === "revoked") await sql("UPDATE student_sessions SET revoked_at = ?").bind(time).run();
    if (mode === "started") now = start;
    if (mode === "not-applied" || mode === "started") throw new Error("private lost response");
    const result = await db.withSession("first-primary").batch(statements);
    if (mode === "lost-commit") throw new Error("private lost response");
    return result;
  });
  const executor = new D1ReservationConfirmExecutor({ withSession(constraint) {
    const session = db.withSession(constraint);
    return { prepare(query) { return session.prepare(query.replaceAll(nowSql, String(now))); }, batch };
  } });
  const verifier = new D1ReservationCommitVerifier(db);
  const verify = vi.spyOn(verifier, "verify");
  const generator = { generateId: vi.fn(() => crypto.randomUUID()) };
  const transaction = new D1ReservationConfirmTransaction(executor, verifier, generator);
  const commit = vi.spyOn(transaction, "commit");
  const http = new ReservationConfirmHttpAdapter(guard, preparation, transaction, origin);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("student-csrf-v1:" + token));
  const csrf = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const request = new Request(origin + "/api/me/reservations", { method: "POST",
    body: JSON.stringify({ slotId: "target", expectedStateToken: preview.expectedStateToken }),
    headers: { "content-type": "application/json", origin, "x-csrf-token": csrf,
      "sec-fetch-site": "same-origin", cookie: `__Host-student_session=${token}` } });
  return { http, request, resolve, prepare, commit, batch, verify, generator, primary };
}

async function count(table: string) {
  return Number(await sql(`SELECT count(*) FROM ${table}`).first("count(*)"));
}

describe("[TC-F-003-01 / TC-F-003-05〜06 / TC-NF-911-01 / TC-NF-914-04 partial HTTP / D1] #880", () => {
  it.each(["normal", "lost-commit"])("returns exact 201 from real Commit, including %s outcome", async (mode) => {
    const f = await setup(mode);
    const response = await f.http.fetch(f.request);
    const result = await f.commit.mock.results[0].value;
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(f.request);
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.commit).toHaveBeenCalledOnce(); expect(f.batch).toHaveBeenCalledOnce();
    expect(f.generator.generateId).toHaveBeenCalledTimes(5);
    expect(f.verify).toHaveBeenCalledTimes(mode === "normal" ? 0 : 1);
    expect(await count("student_reservations")).toBe(1);
    expect(await count("slot_occupancies")).toBe(1);
    expect(await count("business_audit_logs")).toBe(1);
    expect(await count("notification_intents")).toBe(1);
    expect(await count("notification_outbox")).toBe(1);
    expect(await count("command_guards")).toBe(0);
    expect(await sql("SELECT student_id FROM student_reservations").first("student_id")).toBe("student");
    expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it.each([
    ["changed", 409, "RESERVATION_STATE_CHANGED", "repreview"],
    ["unavailable", 409, "RESERVATION_NOT_AVAILABLE", "reload"],
    ["started", 409, "RESERVATION_WINDOW_CLOSED", "reload"],
    ["revoked", 401, "UNAUTHENTICATED", "none"],
    ["not-applied", 503, "SERVICE_UNAVAILABLE", "later"],
  ] as const)("uses fresh Primary classification after %s without new IDs / plan / write", async (mode, status, code, retry) => {
    const f = await setup(mode);
    const response = await f.http.fetch(f.request);
    const body = await response.text();
    expect(response.status).toBe(status);
    expect(JSON.parse(body)).toMatchObject({ error: { code, retry } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(status === 401);
    expect(f.resolve).toHaveBeenCalledTimes(2); expect(f.resolve).toHaveBeenNthCalledWith(2, f.request);
    expect(f.prepare).toHaveBeenCalledTimes(mode === "revoked" ? 1 : 2);
    expect(f.primary.mock.calls.every(([constraint]) => constraint === "first-primary")).toBe(true);
    expect(f.commit).toHaveBeenCalledOnce(); expect(f.batch).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce();
    expect(f.generator.generateId).toHaveBeenCalledTimes(5);
    for (const table of ["student_reservations", "slot_occupancies", "business_audit_logs", "notification_intents", "notification_outbox", "command_guards"]) {
      expect(await count(table)).toBe(0);
    }
    for (const secret of [token, await hashToken(), "private", "sessionId", "tokenHash", "canonicalRawReadSet", "REVALIDATION_REQUIRED", "student_sessions"]) {
      expect(body).not.toContain(secret);
    }
  });
});
