import { toTokyoDateTime, type Classification, type ReservationState } from "./schedule-query";

export class ReservationHistoryError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "SERVICE_UNAVAILABLE" | "INTEGRITY_STATE_UNAVAILABLE") {
    super(code);
    this.name = "ReservationHistoryError";
  }
}
export interface ReservationHistoryPosition {
  readonly startsAt: number;
  readonly reservationId: string;
}
export interface ReservationHistoryRow extends ReservationHistoryPosition {
  readonly endsAt: number;
  readonly reservationState: ReservationState;
  readonly attendanceState: "none" | "absent";
  readonly classification: Classification | null;
}
export interface ReservationHistoryRepository {
  readPage(studentId: string, limit: number, after: ReservationHistoryPosition | null): Promise<readonly ReservationHistoryRow[]>;
}
export interface ReservationHistoryCursorCodec {
  encode(studentId: string, position: ReservationHistoryPosition): Promise<string>;
  decode(studentId: string, cursor: string): Promise<ReservationHistoryPosition>;
}
export interface ReservationHistoryView {
  readonly items: readonly {
    readonly reservationId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly reservationState: ReservationState;
    readonly attendanceState: "none" | "absent";
    readonly classification: Classification | "not_applicable";
  }[];
  readonly nextCursor: string | null;
}
export function validHistoryPosition(value: ReservationHistoryPosition): boolean {
  try {
    return typeof value.reservationId === "string" && value.reservationId.length > 0 &&
      typeof toTokyoDateTime(value.startsAt) === "string";
  } catch { return false; }
}
// Match SQLite's default BINARY TEXT ordering, including non-ASCII opaque IDs.
function compareIds(left: string, right: string): number {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function historyPositionBefore(row: ReservationHistoryPosition, previous: ReservationHistoryPosition): boolean {
  return row.startsAt < previous.startsAt ||
    (row.startsAt === previous.startsAt && compareIds(row.reservationId, previous.reservationId) < 0);
}
export function assertHistoryRows(rows: readonly ReservationHistoryRow[], limit: number,
  after: ReservationHistoryPosition | null): void {
  const fail = () => { throw new ReservationHistoryError("INTEGRITY_STATE_UNAVAILABLE"); };
  if (!Array.isArray(rows) || rows.length > limit + 1) fail();
  const seen = new Set<string>();
  let previous = after;
  for (const row of rows) {
    if (!row || !validHistoryPosition(row) || seen.has(row.reservationId) ||
        !["confirmed", "student_cancelled", "school_cancelled", "system_cancelled"].includes(row.reservationState) ||
        !["none", "absent"].includes(row.attendanceState) ||
        (row.classification !== null && row.classification !== "standard" && row.classification !== "additional") ||
        row.startsAt >= row.endsAt || (previous && !historyPositionBefore(row, previous))) fail();
    try { toTokyoDateTime(row.endsAt); } catch { fail(); }
    seen.add(row.reservationId);
    previous = row;
  }
}
export class ReservationHistoryService {
  constructor(private readonly repository: ReservationHistoryRepository,
    private readonly codec: ReservationHistoryCursorCodec) {}

  async execute(studentId: string, limit = 50, cursor?: string): Promise<ReservationHistoryView> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ReservationHistoryError("INVALID_REQUEST");
    if (typeof studentId !== "string" || !studentId) throw new ReservationHistoryError("INTEGRITY_STATE_UNAVAILABLE");
    const after = cursor === undefined ? null : await this.codec.decode(studentId, cursor);
    if (after !== null && !validHistoryPosition(after)) throw new ReservationHistoryError("INVALID_REQUEST");
    const rows = await this.repository.readPage(studentId, limit, after);
    assertHistoryRows(rows, limit, after);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        reservationId: row.reservationId, startsAt: toTokyoDateTime(row.startsAt), endsAt: toTokyoDateTime(row.endsAt),
        reservationState: row.reservationState, attendanceState: row.attendanceState,
        classification: row.classification ?? "not_applicable",
      })),
      nextCursor: rows.length > limit ? await this.codec.encode(studentId, last) : null,
    };
  }
}
