// #872: server-only pure write plan; #611 §2/5. No DB, HTTP or Session capability.
import type { PreparedReservationConfirm } from "./reservation-confirm";
import { ReservationPreviewError, type ClassificationChange, type ReservationClassificationPlan } from "./reservation-preview";
import type { Classification } from "./schedule-query";

export interface ReservationConfirmIdGenerator {
  generateId(): string;
}

// Only server composition supplies this set. Never decode it from a Request.
export interface ReservationConfirmIds {
  readonly commandId: string;
  readonly reservationId: string;
  readonly occupancyId: string;
  readonly auditId: string;
  readonly reservationConfirmationIntentId: string;
  // One ID per effective change, in the prepared classificationPlan order.
  readonly classificationChangeIntentIds: readonly string[];
}

export interface ClassificationGuardTarget extends ReservationClassificationPlan {
  readonly updateRequired: boolean;
  readonly effectiveChange: boolean;
}

export interface ReservationConfirmIntentPlan {
  readonly id: string;
  readonly kind: "reservation_confirmation" | "classification_change";
  readonly recipientStudentId: string;
  readonly reservationId: string;
  readonly payloadJson: string;
  readonly obligationState: "valid";
}

export interface ReservationConfirmResult {
  readonly reservation: {
    readonly reservationId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly reservationState: "confirmed";
    readonly classification: Classification;
  };
  readonly slot: {
    readonly slotId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly view: "reserved_by_me";
  };
  readonly classificationChanges: readonly ClassificationChange[];
}

export interface ReservationConfirmWritePlan {
  readonly commandId: string;
  readonly canonicalRawReadSet: string;
  readonly reservation: {
    readonly id: string;
    readonly studentId: string;
    readonly slotId: string;
    readonly status: "confirmed";
    readonly automaticClassification: Classification;
    readonly classification: Classification;
  };
  readonly occupancy: {
    readonly id: string;
    readonly slotId: string;
    readonly occupancyType: "student_reservation";
    readonly reservationId: string;
    readonly createdBy: string;
  };
  readonly classificationGuardTargets: readonly ClassificationGuardTarget[];
  readonly reclassificationWrites: readonly ClassificationGuardTarget[];
  readonly audit: {
    readonly id: string;
    readonly action: "reservation_confirm";
    readonly actorType: "student";
    readonly actorId: string;
    readonly targetType: "student_reservation";
    readonly targetId: string;
    readonly beforeJson: null;
    readonly afterJson: string;
    readonly result: "committed";
  };
  readonly notificationIntents: readonly ReservationConfirmIntentPlan[];
  readonly outbox: readonly { readonly intentId: string }[];
  // A projection for use ONLY after the later atomic batch is known committed.
  readonly committedResult: ReservationConfirmResult;
}

function fail(): never {
  throw new ReservationPreviewError("INTEGRITY_STATE_UNAVAILABLE");
}

export function generateReservationConfirmIds(
  prepared: PreparedReservationConfirm,
  generator: ReservationConfirmIdGenerator = { generateId: () => crypto.randomUUID() },
): ReservationConfirmIds {
  try {
    return Object.freeze({
      commandId: generator.generateId(), reservationId: generator.generateId(),
      occupancyId: generator.generateId(), auditId: generator.generateId(),
      reservationConfirmationIntentId: generator.generateId(),
      classificationChangeIntentIds: Object.freeze(prepared.classificationPlan
        .filter((item) => item.before !== item.after).map(() => generator.generateId())),
    });
  } catch {
    throw new ReservationPreviewError("SERVICE_UNAVAILABLE");
  }
}

/** Deterministic projection of trusted prepared values and server-generated IDs.
 * All persistence timestamps (including outbox dueAt) belong to batch Command T.
 * A plan and its result projection are neither a Commit nor authorization.
 */
export function createReservationConfirmWritePlan(
  prepared: PreparedReservationConfirm, studentId: string, ids: ReservationConfirmIds,
): ReservationConfirmWritePlan {
  if (!studentId || prepared.studentId !== studentId) fail();
  const classificationGuardTargets = Object.freeze(prepared.classificationPlan.map((item) => {
    const effectiveChange = item.before !== item.after;
    return Object.freeze({
      reservationId: item.reservationId, startsAt: item.startsAt,
      automaticBefore: item.automaticBefore, automaticAfter: item.automaticAfter,
      before: item.before, after: item.after,
      updateRequired: item.automaticBefore !== item.automaticAfter || effectiveChange, effectiveChange,
    });
  }));
  const reclassificationWrites = Object.freeze(classificationGuardTargets.filter((item) => item.updateRequired));
  const effectiveChanges = classificationGuardTargets.filter((item) => item.effectiveChange);
  if (ids === null || typeof ids !== "object" || Array.isArray(ids) ||
      !Array.isArray(ids.classificationChangeIntentIds)) fail();
  if (ids.classificationChangeIntentIds.length !== effectiveChanges.length) fail();
  const allIds = [ids.commandId, ids.reservationId, ids.occupancyId, ids.auditId,
    ids.reservationConfirmationIntentId, ...ids.classificationChangeIntentIds];
  if (allIds.some((id) => typeof id !== "string" || !id) || new Set(allIds).size !== allIds.length) fail();

  const afterJson = JSON.stringify({
    version: 1,
    reservation: { id: ids.reservationId, automatic_classification: prepared.automaticClassification,
      classification: prepared.classification },
    derived_changes: reclassificationWrites.map((item) => ({
      reservation_id: item.reservationId,
      before: { automatic_classification: item.automaticBefore, classification: item.before },
      after: { automatic_classification: item.automaticAfter, classification: item.after },
    })),
  });
  const notificationIntents: readonly ReservationConfirmIntentPlan[] = Object.freeze([
    Object.freeze({
      id: ids.reservationConfirmationIntentId, kind: "reservation_confirmation" as const,
      recipientStudentId: prepared.studentId, reservationId: ids.reservationId,
      payloadJson: JSON.stringify({ version: 1, reservation: {
        id: ids.reservationId, startsAt: prepared.slot.startsAt, endsAt: prepared.slot.endsAt,
        classification: prepared.classification,
      } }), obligationState: "valid" as const,
    }),
    ...effectiveChanges.map((item, index) => Object.freeze({
      id: ids.classificationChangeIntentIds[index], kind: "classification_change" as const,
      recipientStudentId: prepared.studentId, reservationId: item.reservationId,
      payloadJson: JSON.stringify({ version: 1, reservation: {
        id: item.reservationId, startsAt: item.startsAt, before: item.before, after: item.after,
      } }), obligationState: "valid" as const,
    })),
  ]);
  return Object.freeze({
    commandId: ids.commandId, canonicalRawReadSet: prepared.canonicalRawReadSet,
    reservation: Object.freeze({ id: ids.reservationId, studentId, slotId: prepared.slotId,
      status: "confirmed" as const, automaticClassification: prepared.automaticClassification,
      classification: prepared.classification }),
    occupancy: Object.freeze({ id: ids.occupancyId, slotId: prepared.slotId,
      occupancyType: "student_reservation" as const, reservationId: ids.reservationId, createdBy: studentId }),
    classificationGuardTargets, reclassificationWrites,
    audit: Object.freeze({ id: ids.auditId, action: "reservation_confirm" as const,
      actorType: "student" as const, actorId: studentId, targetType: "student_reservation" as const,
      targetId: ids.reservationId, beforeJson: null, afterJson, result: "committed" as const }),
    notificationIntents,
    outbox: Object.freeze(notificationIntents.map((item) => Object.freeze({ intentId: item.id }))),
    committedResult: Object.freeze({
      reservation: Object.freeze({ reservationId: ids.reservationId, startsAt: prepared.slot.startsAt,
        endsAt: prepared.slot.endsAt, reservationState: "confirmed" as const, classification: prepared.classification }),
      slot: Object.freeze({ slotId: prepared.slotId, startsAt: prepared.slot.startsAt,
        endsAt: prepared.slot.endsAt, view: "reserved_by_me" as const }),
      classificationChanges: Object.freeze(effectiveChanges.map((item) => Object.freeze({
        reservationId: item.reservationId, startsAt: item.startsAt, before: item.before, after: item.after,
      }))),
    }),
  });
}
