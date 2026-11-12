// #610 §2–4, §8 / #611 §4. No HTTP, authentication or storage adapter.
export type Classification = "standard" | "additional";
export type ReservationState =
  | "confirmed"
  | "student_cancelled"
  | "school_cancelled"
  | "system_cancelled";

export interface ReservationReadState {
  readonly reservationId: string;
  readonly slotId: string;
  readonly studentId: string;
  readonly status: ReservationState;
  readonly classification: Classification | null;
}

export interface OccupancyReadState {
  readonly slotId: string;
  readonly type: "student_reservation" | "admin_hold" | "group_lesson";
  readonly reservationId: string | null;
}

export interface SlotReadState {
  readonly slotId: string;
  // UTC Unix seconds, independent of SQL row types.
  readonly startsAt: number;
  readonly endsAt: number;
  readonly availability: "enabled" | "disabled";
  readonly occupancies: readonly OccupancyReadState[];
  // All confirmed reservations for this Slot, plus any occupancy reference
  // (including a cancelled reference). Omitting orphan confirmed rows is unsafe.
  readonly reservations: readonly ReservationReadState[];
  // Repository verifies invariants not projected here, e.g. detail records,
  // classification/count consistency and local date/month consistency.
  // Unknown/unverified integrity must be reported as inconsistent.
  readonly integrity: "consistent" | "inconsistent";
}

export interface ScheduleMonthReadState {
  readonly month: string;
  readonly publishedAt: number | null;
  // Repository supplies startsAt ascending, stable internal ID tie-break order.
  readonly slots: readonly SlotReadState[];
}

export interface ScheduleQueryRepository {
  // One coherent committed read state; no wire models or physical DB types.
  readMonth(month: string): Promise<ScheduleMonthReadState | null>;
}

export interface Clock {
  // Trusted server time in UTC Unix seconds. Never a request/client value.
  now(): number;
}

interface SlotViewBase {
  readonly slotId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export type SlotView = SlotViewBase & (
  | { readonly view: "bookable" | "group_lesson" | "unavailable" }
  | {
      readonly view: "reserved_by_me";
      readonly reservationId: string;
      readonly classification: Classification | "not_applicable";
    }
);

export interface ScheduleMonthView {
  readonly month: string;
  readonly slots: readonly SlotView[];
}

export type ScheduleQueryErrorCode =
  | "SCHEDULE_MONTH_NOT_AVAILABLE"
  | "INTEGRITY_STATE_UNAVAILABLE";

export class ScheduleQueryError extends Error {
  constructor(readonly code: ScheduleQueryErrorCode) {
    // No repository data or internal diagnostics in the application error.
    super(code);
    this.name = "ScheduleQueryError";
  }
}

function integrityFailure(): never {
  throw new ScheduleQueryError("INTEGRITY_STATE_UNAVAILABLE");
}

/** Minimal #610 datetime conversion; source values use #611 integer seconds. */
export function toTokyoDateTime(unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds)) integrityFailure();
  const date = new Date((unixSeconds + 9 * 60 * 60) * 1000);
  if (!Number.isFinite(date.getTime())) integrityFailure();
  const iso = date.toISOString();
  if (!/^\d{4}-/.test(iso)) integrityFailure();
  return `${iso.slice(0, 19)}+09:00`;
}

function assertFutureIntegrity(slot: SlotReadState): void {
  if (slot.integrity !== "consistent" || slot.occupancies.length > 1) integrityFailure();
  const occupancy = slot.occupancies[0];
  const confirmed = slot.reservations.filter((reservation) => reservation.status === "confirmed");
  if (slot.reservations.some((reservation) => reservation.slotId !== slot.slotId)) integrityFailure();
  if (!occupancy) {
    if (confirmed.length !== 0) integrityFailure();
    return;
  }
  if (occupancy.slotId !== slot.slotId) integrityFailure();
  if (occupancy.type === "student_reservation") {
    const references = slot.reservations.filter((reservation) => reservation.reservationId === occupancy.reservationId);
    const reservation = references[0];
    if (!occupancy.reservationId || references.length !== 1 || confirmed.length !== 1 ||
        !reservation || reservation.status !== "confirmed" || !reservation.studentId ||
        (reservation.classification !== null && reservation.classification !== "standard" &&
         reservation.classification !== "additional")) integrityFailure();
  } else if ((occupancy.type !== "admin_hold" && occupancy.type !== "group_lesson") ||
             occupancy.reservationId !== null || confirmed.length !== 0) {
    integrityFailure();
  }
}

/** Input identity has already been resolved and authorized by the Guard. */
export function mapSlotView(slot: SlotReadState, studentId: string, now: number): SlotView {
  if (!Number.isSafeInteger(now) || !studentId || !slot.slotId ||
      slot.startsAt >= slot.endsAt ||
      (slot.availability !== "enabled" && slot.availability !== "disabled")) integrityFailure();
  const base: SlotViewBase = {
    slotId: slot.slotId,
    startsAt: toTokyoDateTime(slot.startsAt),
    endsAt: toTokyoDateTime(slot.endsAt),
  };
  // Started Slots stay unavailable, even with historical/released occupancy.
  if (now >= slot.startsAt) return { ...base, view: "unavailable" };
  assertFutureIntegrity(slot);
  if (slot.availability === "disabled") return { ...base, view: "unavailable" };
  const occupancy = slot.occupancies[0];
  if (!occupancy) return { ...base, view: "bookable" };
  if (occupancy.type === "group_lesson") return { ...base, view: "group_lesson" };
  if (occupancy.type === "student_reservation") {
    const reservation = slot.reservations.find((item) => item.reservationId === occupancy.reservationId)!;
    if (reservation.studentId === studentId) {
      return {
        ...base,
        view: "reserved_by_me",
        reservationId: reservation.reservationId,
        classification: reservation.classification ?? "not_applicable",
      };
    }
  }
  return { ...base, view: "unavailable" };
}

export class ScheduleQueryService {
  constructor(private readonly repository: ScheduleQueryRepository, private readonly clock: Clock) {}

  async execute(month: string, studentId: string): Promise<ScheduleMonthView> {
    const state = await this.repository.readMonth(month);
    if (!state || state.publishedAt === null) {
      throw new ScheduleQueryError("SCHEDULE_MONTH_NOT_AVAILABLE");
    }
    if (state.month !== month) integrityFailure();
    // Capture once after read, so all Slots share one server time boundary.
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || !studentId) integrityFailure();
    return { month: state.month, slots: state.slots.map((slot) => mapSlotView(slot, studentId, now)) };
  }
}
