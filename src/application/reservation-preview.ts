// #860: #610 §5/5.1/8 and #611 §4; no HTTP, SQL, writes or route activation.
import {
  mapSlotView,
  toTokyoDateTime,
  type Classification,
  type ReservationState,
  type SlotReadState,
} from "./schedule-query";
import type { StudentAccessResult } from "./student-access-guard";

// Server-only value obtained from a successful same-request Guard resolution.
export type PreviewIdentity = Pick<Extract<StudentAccessResult, { status: "authenticated" }>, "studentId">;

export interface MonthlyReservationReadState {
  readonly reservationId: string;
  readonly studentId: string;
  readonly slotId: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly status: ReservationState;
  readonly automaticClassification: Classification;
  readonly classification: Classification | null;
  readonly absent: boolean;
  readonly monthlyCountOverride: "excluded" | null;
  readonly classificationOverride: Classification | null;
}

export interface PreviewReadState {
  // One coherent committed read, all reservations for this student and month.
  readonly studentId: string;
  readonly reservationOperationAllowed: boolean;
  readonly month: string;
  readonly publishedAt: number | null;
  readonly slot: SlotReadState;
  // Missing row is distinct from an explicitly configured default value.
  readonly standardCountConfig: { readonly standardCount: number } | null;
  readonly reservations: readonly MonthlyReservationReadState[];
  // Repository verifies omitted persistence invariants (details, cancellation
  // timestamps, complete read set, future occupancy, local date/month, etc.).
  // Unknown/unverified integrity must be inconsistent, never guessed.
  readonly integrity: "consistent" | "inconsistent";
}

export interface ClassificationChange {
  readonly reservationId: string;
  readonly startsAt: string;
  readonly before: Classification;
  readonly after: Classification;
}

export interface PreviewView {
  readonly slot: { readonly slotId: string; readonly startsAt: string; readonly endsAt: string };
  readonly previewClassification: Classification;
  readonly classificationChanges: readonly ClassificationChange[];
  readonly expectedStateToken: string;
}

export type PreviewErrorCode = "RESERVATION_WINDOW_CLOSED" | "RESERVATION_NOT_AVAILABLE" |
  "INTEGRITY_STATE_UNAVAILABLE" | "SERVICE_UNAVAILABLE";

export class ReservationPreviewError extends Error {
  constructor(readonly code: PreviewErrorCode) {
    super(code);
    this.name = "ReservationPreviewError";
  }
}

function fail(code: PreviewErrorCode = "INTEGRITY_STATE_UNAVAILABLE"): never {
  throw new ReservationPreviewError(code);
}

function isClassification(value: unknown): value is Classification {
  return value === "standard" || value === "additional";
}

function counted(reservation: MonthlyReservationReadState): boolean {
  return reservation.status === "confirmed" && !reservation.absent && reservation.monthlyCountOverride === null;
}

function compareReservations(a: MonthlyReservationReadState, b: MonthlyReservationReadState): number {
  return a.startsAt - b.startsAt || (a.reservationId < b.reservationId ? -1 : a.reservationId > b.reservationId ? 1 : 0);
}

function datetime(seconds: number): string {
  try {
    return toTokyoDateTime(seconds);
  } catch {
    return fail();
  }
}

function validateReservation(reservation: MonthlyReservationReadState, state: PreviewReadState, now: number): void {
  if (!reservation.reservationId || !reservation.slotId || reservation.studentId !== state.studentId ||
      !["confirmed", "student_cancelled", "school_cancelled", "system_cancelled"].includes(reservation.status) ||
      !isClassification(reservation.automaticClassification) ||
      (reservation.classificationOverride !== null && !isClassification(reservation.classificationOverride)) ||
      (reservation.monthlyCountOverride !== null && reservation.monthlyCountOverride !== "excluded") ||
      typeof reservation.absent !== "boolean" || reservation.startsAt >= reservation.endsAt ||
      datetime(reservation.startsAt).slice(0, 7) !== state.month) fail();
  datetime(reservation.endsAt);
  if (reservation.absent && (reservation.status !== "confirmed" || now < reservation.endsAt)) fail();
  const effective = counted(reservation) ? reservation.classificationOverride ?? reservation.automaticClassification : null;
  if (reservation.classification !== effective) fail();
  if (reservation.slotId === state.slot.slotId &&
      (reservation.startsAt !== state.slot.startsAt || reservation.endsAt !== state.slot.endsAt)) fail();
}

/** Internal v1 snapshot; explicit projection fixes field order/types and never
 * serializes arbitrary read objects. Time is represented only by boundaries.
 * The returned string is UTF-8 encoded before hashing; never return it on wire.
 */
export interface PreviewPlan {
  readonly slot: PreviewView["slot"];
  readonly previewClassification: Classification;
  readonly classificationChanges: readonly ClassificationChange[];
  readonly canonicalSnapshot: string;
}

/** Shared deterministic computation for Preview and later Confirm re-read.
 * now is captured server time, in integer UTC seconds, not a client input.
 */
export function createPreviewPlan(identity: PreviewIdentity, state: PreviewReadState, now: number): PreviewPlan {
  if (!identity.studentId || identity.studentId !== state.studentId || !Number.isSafeInteger(now) ||
      state.integrity !== "consistent" || typeof state.reservationOperationAllowed !== "boolean" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(state.month) || !Array.isArray(state.reservations) ||
      (state.standardCountConfig !== null &&
       (typeof state.standardCountConfig !== "object" || !state.standardCountConfig))) fail();
  const startsAt = datetime(state.slot.startsAt);
  const endsAt = datetime(state.slot.endsAt);
  if (startsAt.slice(0, 7) !== state.month) fail();
  if (state.publishedAt !== null) datetime(state.publishedAt);
  const standardCount = state.standardCountConfig === null ? 3 : state.standardCountConfig.standardCount;
  if (!Number.isSafeInteger(standardCount) || standardCount < 0) fail();

  // Reuse BR-067 target occupancy validation. Started targets remain rejected,
  // never reopened because historical occupancy has been released.
  let targetView;
  try {
    targetView = mapSlotView(state.slot, identity.studentId, now);
  } catch {
    return fail();
  }
  if (now >= state.slot.startsAt) fail("RESERVATION_WINDOW_CLOSED");
  if (!state.reservationOperationAllowed || state.publishedAt === null || targetView.view !== "bookable") {
    fail("RESERVATION_NOT_AVAILABLE");
  }

  const reservations = [...state.reservations].sort(compareReservations);
  const ids = new Set<string>();
  const confirmedSlots = new Set<string>();
  for (const reservation of reservations) {
    validateReservation(reservation, state, now);
    if (ids.has(reservation.reservationId)) fail();
    ids.add(reservation.reservationId);
    if (reservation.status === "confirmed") {
      if (confirmedSlots.has(reservation.slotId) || reservation.slotId === state.slot.slotId) fail();
      confirmedSlots.add(reservation.slotId);
    }
  }

  const consumed = reservations.filter((item) => item.startsAt <= now && counted(item) && item.automaticClassification === "standard").length;
  const remaining = Math.max(standardCount - consumed, 0);
  const future = reservations.filter((item) => item.startsAt > now && counted(item));
  // Existing equal-start items retain reservationId order; new candidate is
  // inserted after them, without manufacturing a future Reservation ID.
  const candidateIndex = future.filter((item) => item.startsAt <= state.slot.startsAt).length;
  const previewClassification: Classification = candidateIndex < remaining ? "standard" : "additional";
  const affected = future.map((item, index) => {
    const rank = index + (index >= candidateIndex ? 1 : 0);
    const automaticAfter: Classification = rank < remaining ? "standard" : "additional";
    return {
      reservationId: item.reservationId,
      startsAt: datetime(item.startsAt),
      before: item.classification!,
      after: item.classificationOverride ?? automaticAfter,
      automaticBefore: item.automaticClassification,
      automaticAfter,
    };
  });
  const classificationChanges = affected.filter((item) => item.before !== item.after).map((item) => ({
    reservationId: item.reservationId, startsAt: item.startsAt, before: item.before, after: item.after,
  }));
  const slot = { slotId: state.slot.slotId, startsAt, endsAt };
  const canonicalSnapshot = JSON.stringify({
    version: "v1",
    studentId: identity.studentId,
    reservationOperationAllowed: state.reservationOperationAllowed,
    slot: { ...slot, month: state.month, availability: state.slot.availability,
      occupancies: state.slot.occupancies.map((item) => ({ type: item.type, reservationId: item.reservationId })),
      beforeStart: now < state.slot.startsAt },
    publishedAt: state.publishedAt === null ? null : datetime(state.publishedAt),
    standardCountConfig: state.standardCountConfig === null ? null : { standardCount },
    standardCount,
    reservations: reservations.map((item) => ({
      reservationId: item.reservationId, slotId: item.slotId,
      startsAt: datetime(item.startsAt), endsAt: datetime(item.endsAt), status: item.status,
      automaticClassification: item.automaticClassification, classification: item.classification,
      absent: item.absent, monthlyCountOverride: item.monthlyCountOverride,
      classificationOverride: item.classificationOverride, beforeStart: now < item.startsAt,
    })),
    previewClassification,
    affectedReservations: affected,
    classificationChanges,
  });
  return { slot, previewClassification, classificationChanges, canonicalSnapshot };
}

/** Web-standard SHA-256; the token is a comparison value, not authorization. */
export async function expectedStateToken(canonicalSnapshot: string): Promise<string> {
  try {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalSnapshot));
    const binary = String.fromCharCode(...new Uint8Array(bytes));
    return `v1.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  } catch {
    return fail("SERVICE_UNAVAILABLE");
  }
}

export async function previewReservation(identity: PreviewIdentity, state: PreviewReadState, now: number): Promise<PreviewView> {
  const plan = createPreviewPlan(identity, state, now);
  return {
    slot: plan.slot,
    previewClassification: plan.previewClassification,
    classificationChanges: plan.classificationChanges,
    expectedStateToken: await expectedStateToken(plan.canonicalSnapshot),
  };
}
