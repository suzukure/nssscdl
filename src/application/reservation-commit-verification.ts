// #874: closed server-only read model and pure ambiguous-outcome classification.
import type { PreparedReservationConfirm } from "./reservation-confirm";
import type { ReservationConfirmResult, ReservationConfirmWritePlan } from "./reservation-confirm-plan";
import type { StudentSessionContext } from "./student-access-guard";

export class ReservationConfirmTransactionError extends Error {
  constructor(readonly code: "REVALIDATION_REQUIRED" | "INTEGRITY_STATE_UNAVAILABLE" | "SERVICE_UNAVAILABLE") {
    super(code);
    this.name = "ReservationConfirmTransactionError";
  }
}

export interface ReservationConfirmTransactionPort {
  commit(prepared: PreparedReservationConfirm, context: StudentSessionContext): Promise<ReservationConfirmResult>;
}

export interface VerificationReservation {
  readonly id: string; readonly studentId: string; readonly slotId: string; readonly status: string;
  readonly automaticClassification: string; readonly classification: string | null;
  readonly createdAt: number; readonly updatedAt: number; readonly cancelledAt: number | null;
}
export interface VerificationOccupancy {
  readonly id: string; readonly slotId: string; readonly occupancyType: string;
  readonly reservationId: string | null; readonly createdBy: string; readonly createdAt: number;
}
export interface VerificationAudit {
  readonly id: string; readonly action: string; readonly actorType: string; readonly actorId: string;
  readonly targetType: string; readonly targetId: string; readonly beforeJson: string | null;
  readonly afterJson: string | null; readonly result: string; readonly occurredAt: number;
}
export interface VerificationIntent {
  readonly id: string; readonly kind: string; readonly recipientStudentId: string; readonly reservationId: string;
  readonly payloadJson: string; readonly obligationState: string; readonly occurredAt: number;
  readonly expiredAt: number | null; readonly expiryReason: string | null;
}
export interface VerificationOutbox {
  readonly intentId: string; readonly dueAt: number; readonly claimToken: string | null; readonly claimUntil: number | null;
}
export interface ReservationCommitReadModel {
  readonly reservation: VerificationReservation | null;
  readonly occupancy: VerificationOccupancy | null;
  readonly audit: VerificationAudit | null;
  readonly intents: readonly (VerificationIntent | null)[];
  readonly outbox: readonly (VerificationOutbox | null)[];
  // In startsAt / reservationId order, including null for a missing target.
  readonly reclassifications: readonly (VerificationReservation | null)[];
  readonly commandGuardPresent: boolean;
  readonly auditCount: number;
  readonly newReservationIntentCount: number;
}
export type ReservationCommitVerification =
  | { readonly status: "COMMITTED" }
  | { readonly status: "NOT_APPLIED" }
  | { readonly status: "INCONSISTENT" };

export interface ReservationCommitVerifier {
  verify(plan: ReservationConfirmWritePlan): Promise<ReservationCommitVerification>;
}

// Compare only explicitly specified fields; read models cannot carry DB rows/capabilities.
function matches(actual: object | null, expected: object): boolean {
  return actual !== null && Object.entries(expected).every(([key, value]) =>
    (actual as Record<string, unknown>)[key] === value);
}

export function classifyReservationCommit(
  plan: ReservationConfirmWritePlan, read: ReservationCommitReadModel,
): ReservationCommitVerification {
  const writes = [...plan.reclassificationWrites].sort((a, b) =>
    a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 :
      a.reservationId < b.reservationId ? -1 : a.reservationId > b.reservationId ? 1 : 0);
  const lengthsMatch = read.intents.length === plan.notificationIntents.length &&
    read.outbox.length === plan.outbox.length && read.reclassifications.length === writes.length;
  if (!read.commandGuardPresent && lengthsMatch) {
    const time = read.reservation?.createdAt;
    if (time !== undefined &&
        matches(read.reservation, { ...plan.reservation, updatedAt: time, cancelledAt: null }) &&
        matches(read.occupancy, { ...plan.occupancy, createdAt: time }) &&
        matches(read.audit, { ...plan.audit, occurredAt: time }) && read.auditCount === 1 &&
        read.newReservationIntentCount === 1 &&
        writes.every((item, index) => matches(read.reclassifications[index], {
          id: item.reservationId, studentId: plan.reservation.studentId, status: "confirmed", cancelledAt: null,
          automaticClassification: item.automaticAfter, classification: item.after, updatedAt: time,
        })) &&
        plan.notificationIntents.every((item, index) => matches(read.intents[index], {
          ...item, occurredAt: time, expiredAt: null, expiryReason: null,
        })) &&
        plan.outbox.every((item, index) => matches(read.outbox[index], {
          ...item, dueAt: time, claimToken: null, claimUntil: null,
        }))) return { status: "COMMITTED" };
    if (read.reservation === null && read.occupancy === null && read.audit === null &&
        read.intents.every((item) => item === null) && read.outbox.every((item) => item === null) &&
        writes.every((item, index) => matches(read.reclassifications[index], {
          id: item.reservationId, automaticClassification: item.automaticBefore, classification: item.before,
        }))) return { status: "NOT_APPLIED" };
  }
  return { status: "INCONSISTENT" };
}
