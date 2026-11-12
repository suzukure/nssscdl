import { ReservationHistoryError, assertHistoryRows, type ReservationHistoryPosition,
  type ReservationHistoryRepository, type ReservationHistoryRow } from "../application/reservation-history";
import type { ScheduleQueryD1 } from "./d1-schedule-query";

export interface ReservationHistoryD1 {
  withSession(constraint: "first-primary"): ScheduleQueryD1;
}
export function reservationHistorySql(hasCursor: boolean): string {
  return `SELECT r.id AS reservation_id, r.student_id, r.status, r.classification,
    s.starts_at, s.ends_at, a.reservation_id AS absence_id,
    (SELECT COUNT(*) FROM reservation_absences WHERE reservation_id = r.id) AS absence_count
  FROM student_reservations AS r
  LEFT JOIN lesson_slots AS s ON s.id = r.lesson_slot_id
  LEFT JOIN reservation_absences AS a ON a.reservation_id = r.id
  WHERE r.student_id = ?
    ${hasCursor ? "AND (s.starts_at < ? OR (s.starts_at = ? AND r.id < ?))" : ""}
  ORDER BY s.starts_at DESC, r.id DESC LIMIT ?`;
}
export class D1ReservationHistoryRepository implements ReservationHistoryRepository {
  constructor(private readonly database: ReservationHistoryD1) {}
  async readPage(studentId: string, limit: number, after: ReservationHistoryPosition | null): Promise<readonly ReservationHistoryRow[]> {
    let result: unknown;
    try {
      const values = after ? [studentId, after.startsAt, after.startsAt, after.reservationId, limit + 1] : [studentId, limit + 1];
      result = await this.database.withSession("first-primary").prepare(reservationHistorySql(after !== null))
        .bind(...values).all();
    } catch { throw new ReservationHistoryError("SERVICE_UNAVAILABLE"); }
    const fail = () => { throw new ReservationHistoryError("INTEGRITY_STATE_UNAVAILABLE"); };
    if (!result || typeof result !== "object" || !("success" in result) || typeof result.success !== "boolean") fail();
    const response = result as { success: boolean; results: unknown };
    if (!response.success) throw new ReservationHistoryError("SERVICE_UNAVAILABLE");
    if (!Array.isArray(response.results) || response.results.length > limit + 1) fail();
    const rows = (response.results as unknown[]).map((raw) => {
      if (!raw || typeof raw !== "object") fail();
      const row = raw as Record<string, unknown>;
      if (row.student_id !== studentId ||
          (row.absence_count !== 0 && row.absence_count !== 1) ||
          (row.absence_count === 0 ? row.absence_id !== null : row.absence_id !== row.reservation_id)) fail();
      return {
        reservationId: row.reservation_id, startsAt: row.starts_at, endsAt: row.ends_at,
        reservationState: row.status, attendanceState: row.absence_count === 1 ? "absent" : "none",
        classification: row.classification,
      } as ReservationHistoryRow;
    });
    assertHistoryRows(rows, limit, after);
    return rows;
  }
}
