import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationPreviewService } from "../../src/application/reservation-preview";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import { createReservationConfirmWritePlan, generateReservationConfirmIds } from "../../src/application/reservation-confirm-plan";
import { D1ReservationPreviewRepository } from "../../src/infrastructure/d1-reservation-preview";
import { D1ReservationConfirmExecutor, ReservationCommitOutcomeUnknownError } from "../../src/infrastructure/d1-reservation-confirm";
import { D1ReservationCommitVerifier } from "../../src/infrastructure/d1-reservation-commit-verification";
import { D1ReservationConfirmTransaction } from "../../src/infrastructure/d1-reservation-confirm-transaction";

const db = env.AUTH_DB;
const sql = (query: string) => db.prepare(query);
const time = Date.parse("2026-11-10T10:00:00+09:00") / 1000;
const nowSql = "CAST(strftime('%s','now') AS INTEGER)";
const context = { studentId: "student", sessionId: "session", tokenHash: "a".repeat(64) };

beforeAll(async () => { await applyD1Migrations(db, env.RESERVATION_MIGRATIONS); });
beforeEach(async () => {
  // Only outcome-state fixture; #873 Guard/race/rollback fixtures stay unchanged.
  await db.batch([
    ...["notification_outbox", "notification_intents", "business_audit_logs", "command_guards",
      "slot_occupancies", "reservation_classification_overrides", "student_reservations", "student_monthly_lesson_configs", "lesson_slots",
      "schedule_months", "student_sessions", "student_accounts", "student_security_access", "students"]
      .map((table) => sql(`DELETE FROM ${table}`)),
    sql("INSERT INTO students VALUES ('student', 'active', NULL), ('other', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 0), ('other', 'active', 0)"),
    sql("INSERT INTO student_accounts VALUES ('account', 'student', 'student')"),
    sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
      .bind(context.tokenHash, time - 1, time + 86400),
    sql("INSERT INTO schedule_months VALUES ('month', '2026-11', 0, 0, 0)"),
    ...[["target", "15"], ["later", "22"], ["last", "29"]].map(([id, day]) => {
      const start = Date.parse(`2026-11-${day}T10:00:00+09:00`) / 1000;
      return sql("INSERT INTO lesson_slots VALUES (?, 'month', ?, '10:00', '11:00', ?, ?, 'enabled')")
        .bind(id, `2026-11-${day}`, start, start + 3600);
    }),
    sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 1, 0, 'actor')"),
    sql("INSERT INTO student_reservations VALUES ('later-r', 'student', 'later', 'confirmed', 'standard', 'standard', 0, NULL, 0), ('last-r', 'student', 'last', 'confirmed', 'standard', 'standard', 0, NULL, 0)"),
    sql("INSERT INTO slot_occupancies VALUES ('later-o', 'later', 'student_reservation', 'later-r', 0, 'student'), ('last-o', 'last', 'student_reservation', 'last-r', 0, 'student')"),
  ]);
});
async function preparation() {
  const repository = new D1ReservationPreviewRepository({ withSession(constraint) {
    const session = db.withSession(constraint);
    return { prepare(query) { return session.prepare(query.replaceAll(nowSql, String(time))); } };
  } });
  const preview = await new ReservationPreviewService(repository).execute("target", context);
  return new ReservationConfirmPreparationService(repository).prepare("target", preview.expectedStateToken, context);
}
function executor(lose = false) {
  const batch = vi.fn();
  const service = new D1ReservationConfirmExecutor({ withSession(constraint) {
    const session = db.withSession(constraint);
    return {
      prepare(query) { return session.prepare(query.replaceAll(nowSql, String(time))); },
      async batch(statements) {
        batch();
        const result = await session.batch(statements as D1PreparedStatement[]);
        if (lose) throw new Error("private lost response");
        return result;
      },
    };
  } });
  return { service, batch };
}
function verifier() {
  const primary = vi.fn();
  const queries: string[] = [];
  const binds: unknown[][] = [];
  const service = new D1ReservationCommitVerifier({ withSession(constraint) {
    primary(constraint);
    const session = db.withSession(constraint);
    return { prepare(query) {
      queries.push(query);
      return { bind(...values) { binds.push(values); return session.prepare(query).bind(...values); },
        first: () => session.prepare(query).first() };
    } };
  } });
  return { service, primary, queries, binds };
}
async function committed() {
  const prepared = await preparation();
  const plan = createReservationConfirmWritePlan(prepared, context.studentId, generateReservationConfirmIds(prepared));
  await executor().service.execute(prepared, plan, context);
  return { plan, prepared };
}

describe("[TC-F-003-01 / TC-NF-911-01 / TC-NF-914-04 partial D1] #874 ambiguous outcome", () => {
  it("recovers a full commit from a lost real batch response without new IDs, plan or writes", async () => {
    const prepared = await preparation();
    const generator = { generateId: vi.fn(() => crypto.randomUUID()) };
    const run = executor(true);
    const read = verifier();
    let handoff: ReservationCommitOutcomeUnknownError | undefined;
    const execute = vi.fn(async (...args: Parameters<typeof run.service.execute>) => {
      try { return await run.service.execute(...args); } catch (error) {
        handoff = error as ReservationCommitOutcomeUnknownError;
        throw error;
      }
    });
    const verify = vi.fn((plan: Parameters<typeof read.service.verify>[0]) => read.service.verify(plan));
    const result = await new D1ReservationConfirmTransaction({ execute }, { verify }, generator).commit(prepared, context);
    expect(result).toBe(handoff!.attempt.plan.committedResult);
    expect(verify).toHaveBeenCalledExactlyOnceWith(handoff!.attempt.plan);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.batch).toHaveBeenCalledTimes(1);
    expect(generator.generateId).toHaveBeenCalledTimes(7);
    expect(read.primary).toHaveBeenCalledExactlyOnceWith("first-primary");
    expect(read.queries).toHaveLength(1);
    expect(read.queries[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|PRAGMA)\b/i);
    expect(read.binds.flat()).not.toContain(context.sessionId);
    expect(read.binds.flat()).not.toContain(context.tokenHash);
    expect(read.binds.flat()).not.toContain(prepared.canonicalRawReadSet);
  });
  it("normal batch success skips verification", async () => {
    const verify = vi.fn();
    const run = executor();
    await new D1ReservationConfirmTransaction(run.service, { verify }).commit(await preparation(), context);
    expect(verify).not.toHaveBeenCalled();
    expect(run.batch).toHaveBeenCalledTimes(1);
  });
  it("proves complete non-application with every reclassification still before", async () => {
    const prepared = await preparation();
    const read = verifier();
    const execute = vi.fn(async (_prepared: Parameters<D1ReservationConfirmExecutor["execute"]>[0],
      plan: Parameters<D1ReservationConfirmExecutor["execute"]>[1]) => {
      expect(plan.reclassificationWrites).toHaveLength(2);
      throw new ReservationCommitOutcomeUnknownError(Object.freeze({ plan }));
    });
    await expect(new D1ReservationConfirmTransaction({ execute }, read.service).commit(prepared, context))
      .rejects.toMatchObject({ code: "REVALIDATION_REQUIRED", message: "REVALIDATION_REQUIRED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("Reservation alone is inconsistent", async () => {
    const prepared = await preparation();
    const plan = createReservationConfirmWritePlan(prepared, context.studentId, generateReservationConfirmIds(prepared));
    await sql("INSERT INTO student_reservations VALUES (?, 'student', 'target', 'confirmed', 'standard', 'standard', ?, NULL, ?)")
      .bind(plan.reservation.id, time, time).run();
    expect(await verifier().service.verify(plan)).toEqual({ status: "INCONSISTENT" });
  });
  it.each([
    "DELETE FROM business_audit_logs",
    "DELETE FROM notification_outbox",
    "DELETE FROM notification_outbox; DELETE FROM notification_intents",
    "UPDATE notification_intents SET payload_json = '{}' WHERE kind = 'reservation_confirmation'",
    "UPDATE notification_intents SET payload_json = '{}' WHERE kind = 'classification_change'",
    "UPDATE business_audit_logs SET after_json = '{}'",
    "UPDATE business_audit_logs SET actor_id = 'other'",
    "UPDATE student_reservations SET student_id = 'other' WHERE lesson_slot_id = 'target'",
    "UPDATE slot_occupancies SET created_by = 'other' WHERE slot_id = 'target'",
    "UPDATE student_reservations SET classification = 'standard', automatic_classification = 'standard' WHERE id = 'last-r'",
    "UPDATE student_reservations SET updated_at = updated_at + 1 WHERE lesson_slot_id = 'target'",
    "UPDATE slot_occupancies SET created_at = created_at + 1 WHERE slot_id = 'target'",
    "UPDATE business_audit_logs SET occurred_at = occurred_at + 1",
    "UPDATE notification_outbox SET due_at = due_at + 1",
    "UPDATE notification_intents SET obligation_state = 'expired', expired_at = 1, expiry_reason = 'fixture'",
    "INSERT INTO business_audit_logs SELECT 'extra', occurred_at, action, actor_type, actor_id, target_type, target_id, before_json, after_json, result FROM business_audit_logs",
  ])("read success with anomaly maps to integrity: %s", async (mutation) => {
    const { plan, prepared } = await committed();
    for (const query of mutation.split(";")) await sql(query).run();
    const read = verifier();
    expect(await read.service.verify(plan)).toEqual({ status: "INCONSISTENT" });
    const execute = vi.fn(async () => { throw new ReservationCommitOutcomeUnknownError({ plan }); });
    await expect(new D1ReservationConfirmTransaction({ execute }, read.service).commit(prepared, context))
      .rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(["unchanged", "automatic-only", "additional-to-standard"])("exact verification supports %s classification", async (mode) => {
    if (mode === "automatic-only") {
      await sql("INSERT INTO reservation_classification_overrides VALUES ('later-r', 'standard', 0, 'actor'), ('last-r', 'standard', 0, 'actor')").run();
    } else {
      await sql("UPDATE student_monthly_lesson_configs SET standard_count = 3").run();
      if (mode === "additional-to-standard") {
        await sql("UPDATE student_reservations SET automatic_classification = 'additional', classification = 'additional'").run();
      }
    }
    const prepared = await preparation();
    const plan = createReservationConfirmWritePlan(prepared, context.studentId, generateReservationConfirmIds(prepared));
    expect(await verifier().service.verify(plan)).toEqual({ status: "NOT_APPLIED" });
    await executor().service.execute(prepared, plan, context);
    expect(await verifier().service.verify(plan)).toEqual({ status: "COMMITTED" });
    expect(plan.notificationIntents).toHaveLength(mode === "additional-to-standard" ? 3 : 1);
  });
  it("command guard remaining prevents both committed and not-applied proofs", async () => {
    const prepared = await preparation();
    const plan = createReservationConfirmWritePlan(prepared, context.studentId, generateReservationConfirmIds(prepared));
    await sql("INSERT INTO command_guards VALUES (?, 0, '', 1)").bind(plan.commandId).run();
    expect(await verifier().service.verify(plan)).toEqual({ status: "INCONSISTENT" });
    await sql("DELETE FROM command_guards").run();
    await executor().service.execute(prepared, plan, context);
    await sql("INSERT INTO command_guards VALUES (?, 0, '', 1)").bind(plan.commandId).run();
    expect(await verifier().service.verify(plan)).toEqual({ status: "INCONSISTENT" });
  });
  it("same state yields the same frozen closed projection in deterministic collection order", async () => {
    const { plan } = await committed();
    const read = verifier();
    const first = await read.service.read(plan);
    expect(first).toEqual(await read.service.read(plan));
    expect(first.reclassifications.map((item) => item!.id)).toEqual(["later-r", "last-r"]);
    expect(first.intents.map((item) => item!.id)).toEqual(plan.notificationIntents.map((item) => item.id));
    expect(first.outbox.map((item) => item!.intentId)).toEqual(plan.outbox.map((item) => item.intentId));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.intents)).toBe(true);
    expect(Object.isFrozen(first.intents[0])).toBe(true);
  });
});

