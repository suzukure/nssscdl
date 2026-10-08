import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationPreviewService } from "../../src/application/reservation-preview";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import { createReservationConfirmWritePlan, generateReservationConfirmIds } from "../../src/application/reservation-confirm-plan";
import {
  D1ReservationConfirmExecutor, ReservationCommitOutcomeUnknownError,
  type ReservationConfirmD1,
} from "../../src/infrastructure/d1-reservation-confirm";
import { D1ReservationPreviewRepository } from "../../src/infrastructure/d1-reservation-preview";

const db = env.AUTH_DB;
const sql = (query: string) => db.prepare(query);
const now = Date.parse("2026-11-10T10:00:00+09:00") / 1000;
const start = (day: string) => Date.parse(`2026-11-${day}T10:00:00+09:00`) / 1000;
const context = { studentId: "student", sessionId: "session", tokenHash: "a".repeat(64) };
const nowSql = "CAST(strftime('%s','now') AS INTEGER)";
const tables = ["command_guards", "business_audit_logs", "notification_intents", "notification_outbox",
  "student_reservations", "slot_occupancies", "lesson_slots", "schedule_months", "student_sessions",
  "students", "student_security_access", "student_accounts", "admin_holds", "group_lessons",
  "reservation_classification_overrides", "reservation_absences", "reservation_monthly_count_overrides",
  "student_monthly_lesson_configs"];

beforeAll(async () => {
  // Existing file-isolated AUTH_DB, unchanged Production migrations/constraints.
  await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
});

beforeEach(async () => {
  await db.batch([
    ...["notification_outbox", "notification_intents", "business_audit_logs", "command_guards",
      "admin_holds", "group_lessons", "slot_occupancies", "reservation_absences",
      "reservation_classification_overrides", "reservation_monthly_count_overrides", "student_reservations",
      "student_monthly_lesson_configs", "lesson_slots", "schedule_months", "student_sessions",
      "student_accounts", "student_security_access", "students"].map((table) => sql(`DELETE FROM ${table}`)),
    sql("INSERT INTO students VALUES ('student', 'active', NULL), ('other', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 0), ('other', 'active', 0)"),
    sql("INSERT INTO student_accounts VALUES ('account', 'student', 'student')"),
    sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
      .bind(context.tokenHash, now - 1, now + 2591999),
    sql("INSERT INTO schedule_months VALUES ('month', '2026-11', 0, 0, 0)"),
    ...[["past", "01"], ["target", "15"], ["later", "22"], ["last", "29"]].map(([id, day]) =>
      sql("INSERT INTO lesson_slots VALUES (?, 'month', ?, '10:00', '11:00', ?, ?, 'enabled')")
        .bind(id, `2026-11-${day}`, start(day), start(day) + 3600)),
    sql("INSERT INTO student_reservations VALUES ('past-r', 'student', 'past', 'confirmed', 'standard', 'standard', 0, NULL, 0), ('later-r', 'student', 'later', 'confirmed', 'standard', 'standard', 0, NULL, 0)"),
    sql("INSERT INTO slot_occupancies VALUES ('past-o', 'past', 'student_reservation', 'past-r', 0, 'student'), ('later-o', 'later', 'student_reservation', 'later-r', 0, 'student')"),
  ]);
});

async function prepare(slotId = "target", time = now) {
  const repository = new D1ReservationPreviewRepository({ withSession(constraint) {
    const session = db.withSession(constraint);
    return { prepare(query) { return session.prepare(query.replaceAll(nowSql, String(time))); } };
  } });
  const identity = { studentId: context.studentId };
  const preview = await new ReservationPreviewService(repository).execute(slotId, identity);
  const prepared = await new ReservationConfirmPreparationService(repository)
    .prepare(slotId, preview.expectedStateToken, identity);
  const generator = { generateId: vi.fn(() => crypto.randomUUID()) };
  const plan = createReservationConfirmWritePlan(prepared, context.studentId, generateReservationConfirmIds(prepared, generator));
  return { prepared, plan, generator };
}

// Test-only time/race/response injection through the existing D1 interface.
// Every mutation still executes in a real local D1 atomic Primary batch.
function executor(options: {
  finalTime?: number; realTime?: boolean; loseResponse?: boolean; failResponse?: boolean;
  invalidResponse?: "failed" | "incomplete";
  transform?: (query: string) => string;
  injectBefore?: string; injectSql?: readonly string[];
} = {}) {
  const queries: string[] = [];
  const primary = vi.fn();
  const batch = vi.fn();
  const source: ReservationConfirmD1 = { withSession(constraint) {
    primary(constraint);
    const session = db.withSession(constraint);
    return {
      prepare(query) {
        queries.push(query);
        const time = query.startsWith("INSERT INTO command_guards") ? now : options.finalTime ?? now;
        const transformed = options.realTime ? query : query.replaceAll(nowSql, String(time));
        return session.prepare(options.transform?.(transformed) ?? transformed);
      },
      async batch(statements) {
        batch();
        const actual = statements as ReturnType<typeof sql>[];
        if (options.injectBefore) {
          const index = queries.findIndex((query) => query.includes(options.injectBefore!));
          expect(index).toBeGreaterThanOrEqual(0);
          actual.splice(index, 0, ...(options.injectSql ?? []).map((query) => session.prepare(query)));
        }
        if (options.failResponse) throw new Error("private DB diagnostic");
        const result = await session.batch(actual);
        if (options.loseResponse) throw new Error("private response diagnostic");
        if (options.invalidResponse === "failed") return result.map(() => ({ success: false }));
        if (options.invalidResponse === "incomplete") return [];
        return result;
      },
    };
  } };
  return { service: new D1ReservationConfirmExecutor(source), queries, primary, batch };
}

async function persisted() {
  return Promise.all(tables.map(async (table) => (await sql(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
}

async function rollback(options: Parameters<typeof executor>[0] = {}, input?: Awaited<ReturnType<typeof prepare>>) {
  const { prepared, plan, generator } = input ?? await prepare();
  const before = await persisted();
  const count = generator.generateId.mock.calls.length;
  const run = executor(options);
  let failure: unknown;
  try { await run.service.execute(prepared, plan, context); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ReservationCommitOutcomeUnknownError);
  const error = failure as ReservationCommitOutcomeUnknownError;
  expect(error.code).toBe("RESERVATION_COMMIT_OUTCOME_UNKNOWN");
  expect(error.message).toBe(error.code);
  expect(error.attempt.plan).toBe(plan);
  expect(Object.isFrozen(error.attempt)).toBe(true);
  expect(Object.keys(error.attempt)).toEqual(["plan"]);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("status");
  expect(JSON.stringify(error)).not.toContain(plan.canonicalRawReadSet);
  expect(JSON.stringify(error)).not.toContain(context.tokenHash);
  expect(JSON.stringify(error)).not.toContain(context.sessionId);
  expect(generator.generateId.mock.calls.length).toBe(count);
  expect(run.batch).toHaveBeenCalledTimes(1);
  expect(run.primary).toHaveBeenCalledExactlyOnceWith("first-primary");
  expect(await persisted()).toEqual(before);
  expect((await sql("SELECT * FROM command_guards").all()).results).toEqual([]);
  expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
  return run;
}

describe("[TC-F-003-01 / TC-F-003-04 / TC-F-003-05 / TC-NF-911-01 partial D1] #873 atomic Confirm", () => {
  it.each(["none", "effective", "automatic-only"])("[TC-F-101-01 / TC-F-104-01 / TC-NF-940-01 / TC-NF-940-02 partial] commits %s changes with exact projections and common T", async (mode) => {
    if (mode !== "none") await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
    if (mode === "automatic-only") await sql("INSERT INTO reservation_classification_overrides VALUES ('later-r', 'standard', 0, 'actor')").run();
    const { prepared, plan } = await prepare();
    const beforeOverride = (await sql("SELECT * FROM reservation_classification_overrides").all()).results;
    const run = executor({ finalTime: now + 1 });
    expect(await run.service.execute(prepared, plan, context)).toBe(plan.committedResult);
    expect(run.batch).toHaveBeenCalledTimes(1);
    expect(run.primary).toHaveBeenCalledExactlyOnceWith("first-primary");
    expect(run.queries.join("\n")).not.toMatch(/\b(BEGIN|COMMIT|UPSERT|REPLACE)\b/);
    expect((await sql("SELECT * FROM student_reservations WHERE id = ?").bind(plan.reservation.id).first()))
      .toEqual({ id: plan.reservation.id, student_id: "student", lesson_slot_id: "target", status: "confirmed",
        automatic_classification: "standard", classification: "standard", created_at: now, updated_at: now, cancelled_at: null });
    expect(await sql("SELECT * FROM slot_occupancies WHERE id = ?").bind(plan.occupancy.id).first())
      .toEqual({ id: plan.occupancy.id, slot_id: "target", occupancy_type: "student_reservation",
        reservation_id: plan.reservation.id, created_at: now, created_by: "student" });
    expect(await sql("SELECT * FROM business_audit_logs").first()).toEqual({
      id: plan.audit.id, occurred_at: now, action: "reservation_confirm", actor_type: "student", actor_id: "student",
      target_type: "student_reservation", target_id: plan.reservation.id, before_json: null,
      after_json: plan.audit.afterJson, result: "committed",
    });
    expect((await sql("SELECT * FROM notification_intents ORDER BY id").all()).results)
      .toEqual(plan.notificationIntents.map((item) => ({ id: item.id, kind: item.kind,
        recipient_student_id: item.recipientStudentId, reservation_id: item.reservationId,
        occurred_at: now, payload_json: item.payloadJson, obligation_state: "valid", expired_at: null, expiry_reason: null }))
        .sort((a, b) => a.id.localeCompare(b.id)));
    expect((await sql("SELECT * FROM notification_outbox ORDER BY intent_id").all()).results)
      .toEqual(plan.outbox.map((item) => ({ intent_id: item.intentId, due_at: now, claim_token: null, claim_until: null }))
        .sort((a, b) => a.intent_id.localeCompare(b.intent_id)));
    expect(await sql("SELECT automatic_classification, classification, updated_at FROM student_reservations WHERE id = 'later-r'").first())
      .toEqual({ automatic_classification: mode === "none" ? "standard" : "additional",
        classification: mode === "effective" ? "additional" : "standard", updated_at: mode === "none" ? 0 : now });
    expect(plan.classificationGuardTargets).toHaveLength(1);
    expect(plan.reclassificationWrites).toHaveLength(mode === "none" ? 0 : 1);
    expect(run.queries.filter((query) => query.startsWith("UPDATE student_reservations")))
      .toHaveLength(mode === "none" ? 0 : 1);
    expect(plan.notificationIntents).toHaveLength(mode === "effective" ? 2 : 1);
    expect((await sql("SELECT * FROM reservation_classification_overrides").all()).results).toEqual(beforeOverride);
    expect((await sql("SELECT * FROM command_guards").all()).results).toEqual([]);
    expect(JSON.stringify(plan.committedResult)).not.toContain(context.tokenHash);
    expect(JSON.stringify(plan.committedResult)).not.toContain("canonicalRawReadSet");
  });

  it.each([
    ["raw mismatch", "UPDATE schedule_months SET updated_at = updated_at"],
    ["monthly N", "INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 1, 0, 'actor')"],
    ["publication", "UPDATE schedule_months SET published_at = 1"],
    ["unpublished", "UPDATE schedule_months SET published_at = NULL"],
    ["disabled", "UPDATE lesson_slots SET availability_status = 'disabled' WHERE id = 'target'"],
    ["classification before", "UPDATE student_reservations SET automatic_classification = 'additional', classification = 'additional' WHERE id = 'later-r'"],
    ["session revoke", `UPDATE student_sessions SET revoked_at = ${now} WHERE id = 'session'`],
    ["security suspension", "UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"],
    ["deletion", `UPDATE students SET lifecycle = 'deleted', deleted_at = ${now} WHERE id = 'student'`],
    ["future invariant", "DELETE FROM slot_occupancies WHERE id = 'later-o'"],
  ])("rolls back after preparation: %s", async (mode, change) => {
    const input = await prepare();
    await sql(change).run();
    await rollback(mode === "raw mismatch" ? {
      transform: (query) => query.replace("canonical_raw_read_set FROM", "canonical_raw_read_set || 'mismatch' FROM"),
    } : {}, input);
  });

  it("[TC-F-207-02 partial] rejects session expiry at initial T without changing immutable Session attributes", async () => {
    // Recreate the fixture Session with a short immutable lifetime, then prepare
    // while valid. Advancing actual Guard T to expiry isolates Session rejection
    // while Slot/raw read-set boundaries remain unchanged.
    await sql("DELETE FROM student_sessions").run();
    await sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
      .bind(context.tokenHash, now - 1, now + 1).run();
    const input = await prepare();
    await rollback({ transform: (query) => query.startsWith("INSERT INTO command_guards")
      ? query.replace(String(now), String(now + 1)) : query }, input);
  });

  it("preserves a prior normal competitor Commit", async () => {
    const input = await prepare();
    await db.batch([
      sql("INSERT INTO student_reservations VALUES ('winner-r', 'other', 'target', 'confirmed', 'standard', 'standard', 0, NULL, 0)"),
      sql("INSERT INTO slot_occupancies VALUES ('winner-o', 'target', 'student_reservation', 'winner-r', 0, 'other')"),
    ]);
    await rollback({}, input);
    expect(await sql("SELECT reservation_id FROM slot_occupancies WHERE slot_id = 'target'").first("reservation_id")).toBe("winner-r");
  });

  it("rolls back on slot UNIQUE conflict even after initial guard passed", async () => {
    await rollback({ injectBefore: "INSERT INTO slot_occupancies", injectSql: [
      "INSERT INTO slot_occupancies VALUES ('race-o', 'target', 'admin_hold', NULL, 0, 'actor')",
      "INSERT INTO admin_holds VALUES ('race-o')",
    ] });
  });

  it.each(["before changed", "missing", "ignored update"])("CHECK-aborts insufficient reclassification: %s", async (mode) => {
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
    const input = await prepare();
    const injectSql = mode === "missing" ? ["DELETE FROM slot_occupancies WHERE id = 'later-o'", "DELETE FROM student_reservations WHERE id = 'later-r'"]
      : mode === "before changed" ? ["UPDATE student_reservations SET automatic_classification = 'additional', classification = 'additional' WHERE id = 'later-r'"] : [];
    await rollback({ injectBefore: "UPDATE student_reservations", injectSql,
      transform: mode === "ignored update" ? (query) => query.startsWith("UPDATE student_reservations")
        ? query.replace("WHERE id = ?", "WHERE 0 AND id = ?") : query : undefined }, input);
  });

  it.each(["target", "changed classification", "unchanged classification", "automatic-only classification"])
    ("final start boundary rolls back %s; full Guard set differs from write set", async (mode) => {
      if (mode === "changed classification" || mode === "automatic-only classification") {
        await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
        await sql("UPDATE student_reservations SET automatic_classification = 'additional', classification = 'additional' WHERE id = 'later-r'").run();
      }
      if (mode === "automatic-only classification") await sql("INSERT INTO reservation_classification_overrides VALUES ('later-r', 'additional', 0, 'actor')").run();
      // For existing-target boundary, the new Slot must start LATER than the
      // unchanged/changed Reservation. Otherwise target guard masks this proof.
      const input = await prepare(mode === "target" ? "target" : "last");
      if (mode === "unchanged classification") expect(input.plan.reclassificationWrites).toHaveLength(0);
      if (mode === "changed classification" || mode === "automatic-only classification") expect(input.plan.reclassificationWrites).toHaveLength(1);
      await rollback({ finalTime: mode === "target" ? start("15") : start("22") }, input);
    });

  it.each(["business_audit_logs", "notification_intents", "notification_outbox"])
    ("rolls back Reservation/Occupancy/reclassification on %s INSERT failure", async (table) => {
      await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
      // Test-only abort Trigger enforces a real SQL failure in the batch.
      await sql(`CREATE TRIGGER test_insert_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`).run();
      try { await rollback(); } finally { await sql("DROP TRIGGER test_insert_failure").run(); }
    });

  it.each(["expiry", "revoke", "suspension", "deletion"])("[TC-F-207-02 / TC-F-207-03 / TC-F-211-02 / TC-F-311-02 partial] final Student Write predicate failure: %s", async (mode) => {
    const injectSql = mode === "revoke" ? [`UPDATE student_sessions SET revoked_at = ${now} WHERE id = 'session'`]
      : mode === "suspension" ? ["UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"]
        : mode === "deletion" ? [`UPDATE students SET lifecycle = 'deleted', deleted_at = ${now} WHERE id = 'student'`] : [];
    await rollback({ injectBefore: "json_each", injectSql,
      // Preserve start time; move only final Session time to expiry via source.
      transform: mode === "expiry" ? (query) => query.includes("json_each")
        ? query.replace(`a.expires_at > ${now}`, `a.expires_at > ${now + 2591999}`) : query : undefined });
  });

  it.each([
    "UPDATE business_audit_logs SET after_json = '{}'",
    "INSERT INTO business_audit_logs SELECT 'extra-audit', occurred_at, action, actor_type, actor_id, target_type, target_id, before_json, after_json, result FROM business_audit_logs",
    "UPDATE notification_intents SET payload_json = '{}' WHERE kind = 'reservation_confirmation'",
    "UPDATE notification_intents SET payload_json = '{}' WHERE kind = 'classification_change'",
    "DELETE FROM notification_outbox",
    "UPDATE notification_outbox SET due_at = due_at + 1",
    "UPDATE student_reservations SET classification = NULL WHERE id = 'later-r'",
    "UPDATE student_reservations SET updated_at = updated_at + 1 WHERE lesson_slot_id = 'target'",
    "UPDATE slot_occupancies SET created_by = 'other' WHERE slot_id = 'target'",
    "INSERT INTO notification_intents SELECT 'extra-intent', 'classification_change', recipient_student_id, reservation_id, occurred_at, payload_json, obligation_state, expired_at, expiry_reason FROM notification_intents WHERE kind = 'reservation_confirmation'",
  ])("final exact projection/count guard aborts anomaly %s", async (change) => {
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
    await rollback({ injectBefore: "json_each", injectSql: [change] });
  });

  it("final count guard rejects a missing classification Intent/Outbox pair", async () => {
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
    await rollback({ injectBefore: "json_each", injectSql: [
      "DELETE FROM notification_outbox WHERE intent_id IN (SELECT id FROM notification_intents WHERE kind = 'classification_change')",
      "DELETE FROM notification_intents WHERE kind = 'classification_change'",
    ] });
  });

  it.each(["lost", "failed", "incomplete"] as const)("%s successful response: exact immutable attempt, no new IDs/rewrite, durable full Commit", async (mode) => {
    const { prepared, plan, generator } = await prepare();
    const count = generator.generateId.mock.calls.length;
    const run = executor({ loseResponse: mode === "lost", invalidResponse: mode === "lost" ? undefined : mode });
    let failure: unknown;
    try { await run.service.execute(prepared, plan, context); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ReservationCommitOutcomeUnknownError);
    expect((failure as ReservationCommitOutcomeUnknownError).code).toBe("RESERVATION_COMMIT_OUTCOME_UNKNOWN");
    expect((failure as ReservationCommitOutcomeUnknownError).attempt.plan).toBe(plan);
    expect(generator.generateId.mock.calls.length).toBe(count);
    expect(run.batch).toHaveBeenCalledTimes(1);
    expect(await sql("SELECT COUNT(*) AS n FROM student_reservations WHERE id = ?").bind(plan.reservation.id).first("n")).toBe(1);
    expect(await sql("SELECT COUNT(*) AS n FROM notification_outbox").first("n")).toBe(1);
    expect((await sql("SELECT * FROM command_guards").all()).results).toEqual([]);
  });

  it("does not expose DB diagnostics or retry a failed batch response", async () => {
    await rollback({ failResponse: true });
  });

  it("[TC-F-003-06 partial] rejects a different student's Context before any batch", async () => {
    const { prepared, plan } = await prepare();
    const run = executor();
    await expect(run.service.execute(prepared, plan, { ...context, studentId: "other" }))
      .rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
    expect(run.batch).not.toHaveBeenCalled();
  });

  it("uses actual D1 Command now and ignores Worker clock", async () => {
    const realNow = await sql(`SELECT ${nowSql} AS t`).first<number>("t");
    await sql("DELETE FROM student_sessions").run();
    await sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
      .bind(context.tokenHash, realNow! - 1, realNow! + 2591999).run();
    // Future fixture Slots remain future at the repository's current run date.
    const input = await prepare("target", realNow!);
    const run = executor({ realTime: true });
    const spy = vi.spyOn(Date, "now").mockReturnValue(0);
    try { await run.service.execute(input.prepared, input.plan, context); } finally { spy.mockRestore(); }
    const after = await sql(`SELECT ${nowSql} AS t`).first<number>("t");
    const saved = await sql("SELECT created_at FROM student_reservations WHERE id = ?").bind(input.plan.reservation.id).first<number>("created_at");
    expect(saved).toBeGreaterThanOrEqual(realNow!);
    expect(saved).toBeLessThanOrEqual(after!);
    expect(await sql("SELECT occurred_at FROM business_audit_logs").first("occurred_at")).toBe(saved);
  });
});
