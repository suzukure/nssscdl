// #874: one read-only Primary statement, with no Session credentials or writes.
import {
  classifyReservationCommit, ReservationConfirmTransactionError,
  type ReservationCommitReadModel, type ReservationCommitVerifier,
  type VerificationReservation, type VerificationOccupancy, type VerificationAudit,
  type VerificationIntent, type VerificationOutbox,
} from "../application/reservation-commit-verification";
import type { ReservationConfirmWritePlan } from "../application/reservation-confirm-plan";

export interface ReservationVerificationStatement {
  bind(...values: unknown[]): ReservationVerificationStatement;
  first(): Promise<unknown>;
}
export interface ReservationVerificationD1 {
  withSession(constraint: "first-primary"): { prepare(query: string): ReservationVerificationStatement };
}

const reservationJson = `json_object('id', r.id, 'studentId', r.student_id, 'slotId', r.lesson_slot_id,
  'status', r.status, 'automaticClassification', r.automatic_classification, 'classification', r.classification,
  'createdAt', r.created_at, 'updatedAt', r.updated_at, 'cancelledAt', r.cancelled_at)`;
const verificationSql = `WITH input AS (SELECT ? AS reservation_id, ? AS occupancy_id, ? AS audit_id, ? AS command_id),
  expected_intents AS (SELECT key AS position, value AS id FROM json_each(?)),
  expected_outbox AS (SELECT key AS position, value AS id FROM json_each(?)),
  expected_changes AS (SELECT value FROM json_each(?))
SELECT
  (SELECT ${reservationJson} FROM student_reservations r, input WHERE r.id = input.reservation_id) AS reservation,
  (SELECT json_object('id', o.id, 'slotId', o.slot_id, 'occupancyType', o.occupancy_type,
    'reservationId', o.reservation_id, 'createdBy', o.created_by, 'createdAt', o.created_at)
    FROM slot_occupancies o, input WHERE o.id = input.occupancy_id) AS occupancy,
  (SELECT json_object('id', a.id, 'action', a.action, 'actorType', a.actor_type, 'actorId', a.actor_id,
    'targetType', a.target_type, 'targetId', a.target_id, 'beforeJson', a.before_json,
    'afterJson', a.after_json, 'result', a.result, 'occurredAt', a.occurred_at)
    FROM business_audit_logs a, input WHERE a.id = input.audit_id) AS audit,
  (SELECT json_group_array(json(item)) FROM (
    SELECT CASE WHEN n.id IS NULL THEN 'null' ELSE json_object('id', n.id, 'kind', n.kind,
      'recipientStudentId', n.recipient_student_id, 'reservationId', n.reservation_id,
      'payloadJson', n.payload_json, 'obligationState', n.obligation_state, 'occurredAt', n.occurred_at,
      'expiredAt', n.expired_at, 'expiryReason', n.expiry_reason) END AS item
    FROM expected_intents e LEFT JOIN notification_intents n ON n.id = e.id ORDER BY e.position)) AS intents,
  (SELECT json_group_array(json(item)) FROM (
    SELECT CASE WHEN o.intent_id IS NULL THEN 'null' ELSE json_object('intentId', o.intent_id,
      'dueAt', o.due_at, 'claimToken', o.claim_token, 'claimUntil', o.claim_until) END AS item
    FROM expected_outbox e LEFT JOIN notification_outbox o ON o.intent_id = e.id ORDER BY e.position)) AS outbox,
  (SELECT json_group_array(json(item)) FROM (
    SELECT CASE WHEN r.id IS NULL THEN 'null' ELSE ${reservationJson} END AS item
    FROM expected_changes e LEFT JOIN student_reservations r ON r.id = json_extract(e.value, '$.reservationId')
    ORDER BY json_extract(e.value, '$.startsAt'), json_extract(e.value, '$.reservationId'))) AS reclassifications,
  EXISTS(SELECT 1 FROM command_guards g, input WHERE g.id = input.command_id) AS command_guard_present,
  (SELECT count(*) FROM business_audit_logs a, input WHERE a.action = 'reservation_confirm'
    AND a.target_type = 'student_reservation' AND a.target_id = input.reservation_id) AS audit_count,
  (SELECT count(*) FROM notification_intents n, input WHERE n.reservation_id = input.reservation_id) AS new_reservation_intent_count`;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error();
  return value;
}
const nullableString = (value: unknown) => value === null ? null : string(value);
const nullableInteger = (value: unknown) => value === null ? null : integer(value);
function reservation(value: unknown): VerificationReservation {
  const r = object(value);
  return Object.freeze({ id: string(r.id), studentId: string(r.studentId), slotId: string(r.slotId),
    status: string(r.status), automaticClassification: string(r.automaticClassification),
    classification: nullableString(r.classification), createdAt: integer(r.createdAt),
    updatedAt: integer(r.updatedAt), cancelledAt: nullableInteger(r.cancelledAt) });
}
function occupancy(value: unknown): VerificationOccupancy {
  const o = object(value);
  return Object.freeze({ id: string(o.id), slotId: string(o.slotId), occupancyType: string(o.occupancyType),
    reservationId: nullableString(o.reservationId), createdBy: string(o.createdBy), createdAt: integer(o.createdAt) });
}
function audit(value: unknown): VerificationAudit {
  const a = object(value);
  return Object.freeze({ id: string(a.id), action: string(a.action), actorType: string(a.actorType),
    actorId: string(a.actorId), targetType: string(a.targetType), targetId: string(a.targetId),
    beforeJson: nullableString(a.beforeJson), afterJson: nullableString(a.afterJson),
    result: string(a.result), occurredAt: integer(a.occurredAt) });
}
function intent(value: unknown): VerificationIntent {
  const n = object(value);
  return Object.freeze({ id: string(n.id), kind: string(n.kind), recipientStudentId: string(n.recipientStudentId),
    reservationId: string(n.reservationId), payloadJson: string(n.payloadJson), obligationState: string(n.obligationState),
    occurredAt: integer(n.occurredAt), expiredAt: nullableInteger(n.expiredAt), expiryReason: nullableString(n.expiryReason) });
}
function outbox(value: unknown): VerificationOutbox {
  const o = object(value);
  return Object.freeze({ intentId: string(o.intentId), dueAt: integer(o.dueAt),
    claimToken: nullableString(o.claimToken), claimUntil: nullableInteger(o.claimUntil) });
}
const optional = <T>(value: unknown, decode: (value: unknown) => T): T | null => value === null ? null : decode(value);
const parse = (value: unknown): unknown => JSON.parse(string(value));
function collection<T>(value: unknown, decode: (value: unknown) => T): readonly (T | null)[] {
  const array = parse(value);
  if (!Array.isArray(array)) throw new Error();
  return Object.freeze(array.map((item: unknown) => optional(item, decode)));
}
function decodeRead(value: unknown): ReservationCommitReadModel {
  const row = object(value);
  const guard = integer(row.command_guard_present);
  const auditCount = integer(row.audit_count);
  const newReservationIntentCount = integer(row.new_reservation_intent_count);
  if ((guard !== 0 && guard !== 1) || auditCount < 0 || newReservationIntentCount < 0) throw new Error();
  return Object.freeze({
    reservation: optional(row.reservation, (v) => reservation(parse(v))),
    occupancy: optional(row.occupancy, (v) => occupancy(parse(v))),
    audit: optional(row.audit, (v) => audit(parse(v))),
    intents: collection(row.intents, intent), outbox: collection(row.outbox, outbox),
    reclassifications: collection(row.reclassifications, reservation), commandGuardPresent: guard === 1,
    auditCount, newReservationIntentCount,
  });
}

export class D1ReservationCommitVerifier implements ReservationCommitVerifier {
  constructor(private readonly database: ReservationVerificationD1) {}

  async read(plan: ReservationConfirmWritePlan): Promise<ReservationCommitReadModel> {
    try {
      const row = await this.database.withSession("first-primary").prepare(verificationSql).bind(
        plan.reservation.id, plan.occupancy.id, plan.audit.id, plan.commandId,
        JSON.stringify(plan.notificationIntents.map((item) => item.id)),
        JSON.stringify(plan.outbox.map((item) => item.intentId)), JSON.stringify(plan.reclassificationWrites),
      ).first();
      return decodeRead(row);
    } catch {
      throw new ReservationConfirmTransactionError("SERVICE_UNAVAILABLE");
    }
  }

  async verify(plan: ReservationConfirmWritePlan) {
    return classifyReservationCommit(plan, await this.read(plan));
  }
}
