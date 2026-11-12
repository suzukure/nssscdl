// #873: internal single-batch executor. No HTTP, recovery read or write retry.
import type { PreparedReservationConfirm } from "../application/reservation-confirm";
import type { ReservationConfirmResult, ReservationConfirmWritePlan } from "../application/reservation-confirm-plan";
import { ReservationPreviewError } from "../application/reservation-preview";
import type { StudentSessionContext } from "../application/student-access-guard";
import { reservationCaptureSql } from "./d1-reservation-preview";

export interface ReservationCommitAttempt {
  readonly plan: ReservationConfirmWritePlan;
}

export class ReservationCommitOutcomeUnknownError extends Error {
  readonly code = "RESERVATION_COMMIT_OUTCOME_UNKNOWN";
  readonly attempt: ReservationCommitAttempt;

  constructor(attempt: ReservationCommitAttempt) {
    super("RESERVATION_COMMIT_OUTCOME_UNKNOWN");
    this.name = "ReservationCommitOutcomeUnknownError";
    // Internal handoff only; accidental JSON serialization must not disclose
    // the plan's raw read set. Neither Session context nor DB cause is retained.
    this.attempt = attempt;
    Object.defineProperty(this, "attempt", { value: attempt, enumerable: false, writable: false, configurable: false });
  }
}

export interface ReservationConfirmStatement {
  bind(...values: unknown[]): ReservationConfirmStatement;
}

export interface ReservationConfirmD1 {
  withSession(constraint: "first-primary"): {
    prepare(query: string): ReservationConfirmStatement;
    batch(statements: ReservationConfirmStatement[]): Promise<{ success: boolean }[]>;
  };
}

const nowSql = "CAST(strftime('%s','now') AS INTEGER)";

// Exact #611 §8.3 shared View predicate; only its time argument changes.
function studentWritePredicate(timeSql: string): string {
  return `EXISTS (
    SELECT 1 FROM student_session_access_v1 AS a
    WHERE a.session_id = ? AND a.token_hash = ? AND a.student_id = ?
      AND a.role_scope = 'student' AND a.revoked_at IS NULL
      AND a.created_at <= ${timeSql} AND a.expires_at > ${timeSql}
      AND a.lifecycle = 'active' AND a.deleted_at IS NULL AND a.access_state = 'active'
  )`;
}

export class D1ReservationConfirmExecutor {
  constructor(private readonly database: ReservationConfirmD1) {}

  async execute(
    prepared: PreparedReservationConfirm, plan: ReservationConfirmWritePlan,
    context: StudentSessionContext,
  ): Promise<ReservationConfirmResult> {
    if (!context.studentId || !context.sessionId || !context.tokenHash ||
        prepared.studentId !== context.studentId || plan.reservation.studentId !== context.studentId ||
        prepared.slotId !== plan.reservation.slotId || prepared.canonicalRawReadSet !== plan.canonicalRawReadSet) {
      throw new ReservationPreviewError("INTEGRITY_STATE_UNAVAILABLE");
    }
    // #872 already recursively freezes the generated plan. Do not copy it,
    // generate IDs, retain Context in the attempt, or regenerate after failure.
    const attempt: ReservationCommitAttempt = Object.freeze({ plan });
    let session: ReturnType<ReservationConfirmD1["withSession"]>;
    const statements: ReservationConfirmStatement[] = [];
    try {
      session = this.database.withSession("first-primary");
      const statement = (query: string, ...values: unknown[]) => session.prepare(query).bind(...values);
      const append = (query: string, ...values: unknown[]) => statements.push(statement(query, ...values));
      const actor = [context.sessionId, context.tokenHash, context.studentId];
      const reservation = plan.reservation;
      const occupancy = plan.occupancy;
      const audit = plan.audit;

      append(`INSERT INTO command_guards(id, captured_at, expected_read_set, ok)
        VALUES (?, ${nowSql}, ?, 1)`, plan.commandId, plan.canonicalRawReadSet);
      append(`UPDATE command_guards AS g SET ok = CASE WHEN
        (SELECT canonical_raw_read_set FROM (${reservationCaptureSql("g.captured_at")})) = g.expected_read_set
        AND ${studentWritePredicate("g.captured_at")}
        AND EXISTS (SELECT 1 FROM lesson_slots AS s
          JOIN schedule_months AS m ON m.id = s.schedule_month_id
          WHERE s.id = ? AND m.published_at IS NOT NULL AND s.availability_status = 'enabled'
            AND g.captured_at < s.starts_at)
        AND NOT EXISTS (SELECT 1 FROM slot_occupancies WHERE slot_id = ?)
        THEN 1 ELSE 0 END WHERE g.id = ?`,
      context.studentId, reservation.slotId, ...actor, reservation.slotId, reservation.slotId, plan.commandId);

      append(`INSERT INTO student_reservations
        (id, student_id, lesson_slot_id, status, automatic_classification, classification,
         created_at, updated_at, cancelled_at)
        SELECT ?, ?, ?, ?, ?, ?, captured_at, captured_at, NULL FROM command_guards WHERE id = ?`,
      reservation.id, reservation.studentId, reservation.slotId, reservation.status,
      reservation.automaticClassification, reservation.classification, plan.commandId);
      append(`INSERT INTO slot_occupancies
        (id, slot_id, occupancy_type, reservation_id, created_at, created_by)
        SELECT ?, ?, ?, ?, captured_at, ? FROM command_guards WHERE id = ?`,
      occupancy.id, occupancy.slotId, occupancy.occupancyType, occupancy.reservationId,
      occupancy.createdBy, plan.commandId);

      for (const item of plan.reclassificationWrites) {
        append(`UPDATE student_reservations SET automatic_classification = ?, classification = ?,
          updated_at = (SELECT captured_at FROM command_guards WHERE id = ?)
          WHERE id = ? AND student_id = ? AND status = 'confirmed'
            AND automatic_classification = ? AND classification IS ?
            AND (SELECT starts_at FROM lesson_slots WHERE id = lesson_slot_id)
              > (SELECT captured_at FROM command_guards WHERE id = ?)`,
        item.automaticAfter, item.after, plan.commandId, item.reservationId, context.studentId,
        item.automaticBefore, item.before, plan.commandId);
        // Even a no-op/missing-row update must abort before subsequent writes.
        append(`UPDATE command_guards SET ok = CASE WHEN changes() = 1 THEN 1 ELSE 0 END WHERE id = ?`,
          plan.commandId);
      }
      append(`INSERT INTO business_audit_logs
        (id, occurred_at, action, actor_type, actor_id, target_type, target_id, before_json, after_json, result)
        SELECT ?, captured_at, ?, ?, ?, ?, ?, ?, ?, ? FROM command_guards WHERE id = ?`,
      audit.id, audit.action, audit.actorType, audit.actorId, audit.targetType, audit.targetId,
      audit.beforeJson, audit.afterJson, audit.result, plan.commandId);
      for (const intent of plan.notificationIntents) {
        append(`INSERT INTO notification_intents
          (id, kind, recipient_student_id, reservation_id, occurred_at, payload_json,
           obligation_state, expired_at, expiry_reason)
          SELECT ?, ?, ?, ?, captured_at, ?, ?, NULL, NULL FROM command_guards WHERE id = ?`,
        intent.id, intent.kind, intent.recipientStudentId, intent.reservationId,
        intent.payloadJson, intent.obligationState, plan.commandId);
      }
      for (const outbox of plan.outbox) {
        append(`INSERT INTO notification_outbox(intent_id, due_at, claim_token, claim_until)
          SELECT ?, captured_at, NULL, NULL FROM command_guards WHERE id = ?`, outbox.intentId, plan.commandId);
      }

      // JSON table parameters keep all full Guard targets separate from UPDATE
      // targets, without interpolating IDs/values into SQL or hashing raw state.
      append(`WITH expected_intents AS (SELECT value FROM json_each(?)),
        expected_outbox AS (SELECT value FROM json_each(?))
        UPDATE command_guards AS g SET ok = CASE WHEN
        ${studentWritePredicate(nowSql)}
        AND EXISTS (SELECT 1 FROM student_reservations AS r JOIN lesson_slots AS s ON s.id = r.lesson_slot_id
          WHERE r.id = ? AND r.student_id = ? AND r.lesson_slot_id = ? AND r.status = ?
            AND r.automatic_classification = ? AND r.classification IS ? AND r.cancelled_at IS NULL
            AND r.created_at = g.captured_at AND r.updated_at = g.captured_at AND ${nowSql} < s.starts_at)
        AND EXISTS (SELECT 1 FROM slot_occupancies AS o
          WHERE o.id = ? AND o.slot_id = ? AND o.occupancy_type = ? AND o.reservation_id = ?
            AND o.created_by = ? AND o.created_at = g.captured_at)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS item WHERE NOT EXISTS (
            SELECT 1 FROM student_reservations AS r JOIN lesson_slots AS s ON s.id = r.lesson_slot_id
            WHERE r.id = json_extract(item.value, '$.reservationId') AND r.student_id = ?
              AND r.status = 'confirmed' AND r.cancelled_at IS NULL
              AND r.automatic_classification = json_extract(item.value, '$.automaticAfter')
              AND r.classification IS json_extract(item.value, '$.after')
              AND (json_extract(item.value, '$.updateRequired') = 0 OR r.updated_at = g.captured_at)
              AND ${nowSql} < s.starts_at))
        AND (SELECT COUNT(*) FROM business_audit_logs WHERE action = ? AND target_type = ? AND target_id = ?) = 1
        AND EXISTS (SELECT 1 FROM business_audit_logs
          WHERE id = ? AND occurred_at = g.captured_at AND action = ? AND actor_type = ? AND actor_id = ?
            AND target_type = ? AND target_id = ? AND before_json IS ? AND after_json = ? AND result = ?)
        AND (SELECT COUNT(*) FROM notification_intents WHERE reservation_id = ?) = 1
        AND (SELECT COUNT(*) FROM notification_intents
          WHERE id IN (SELECT json_extract(value, '$.id') FROM expected_intents))
          = (SELECT COUNT(*) FROM expected_intents)
        AND (SELECT COUNT(*) FROM notification_outbox
          WHERE intent_id IN (SELECT json_extract(value, '$.intentId') FROM expected_outbox))
          = (SELECT COUNT(*) FROM expected_outbox)
        AND NOT EXISTS (
          SELECT 1 FROM expected_intents AS item WHERE NOT EXISTS (
            SELECT 1 FROM notification_intents AS n JOIN notification_outbox AS o ON o.intent_id = n.id
            WHERE n.id = json_extract(item.value, '$.id') AND n.kind = json_extract(item.value, '$.kind')
              AND n.recipient_student_id = json_extract(item.value, '$.recipientStudentId')
              AND n.reservation_id = json_extract(item.value, '$.reservationId')
              AND n.payload_json = json_extract(item.value, '$.payloadJson') AND n.occurred_at = g.captured_at
              AND n.obligation_state = 'valid' AND n.expired_at IS NULL AND n.expiry_reason IS NULL
              AND o.due_at = g.captured_at AND o.claim_token IS NULL AND o.claim_until IS NULL))
        THEN 1 ELSE 0 END WHERE g.id = ?`,
      JSON.stringify(plan.notificationIntents), JSON.stringify(plan.outbox),
      ...actor, reservation.id, reservation.studentId, reservation.slotId, reservation.status,
      reservation.automaticClassification, reservation.classification,
      occupancy.id, occupancy.slotId, occupancy.occupancyType, occupancy.reservationId, occupancy.createdBy,
      JSON.stringify(plan.classificationGuardTargets), context.studentId,
      audit.action, audit.targetType, audit.targetId,
      audit.id, audit.action, audit.actorType, audit.actorId, audit.targetType, audit.targetId,
      audit.beforeJson, audit.afterJson, audit.result, reservation.id, plan.commandId);
      append("DELETE FROM command_guards WHERE id = ?", plan.commandId);
    } catch {
      // No batch invocation means no write attempt or ambiguous Commit.
      throw new ReservationPreviewError("SERVICE_UNAVAILABLE");
    }

    try {
      const results = await session.batch(statements);
      if (!Array.isArray(results) || results.length !== statements.length || results.some((result) => !result.success)) {
        throw new Error();
      }
      return plan.committedResult;
    } catch {
      // A failed response is not evidence of NOT_APPLIED. #874 owns Primary
      // verification. No raw cause, diagnostic SQL, public reason or retry.
      throw new ReservationCommitOutcomeUnknownError(attempt);
    }
  }
}
