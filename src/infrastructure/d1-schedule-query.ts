import {
  ScheduleQueryError,
  toTokyoDateTime,
  type Classification,
  type OccupancyReadState,
  type ReservationState,
  type ScheduleMonthReadState,
  type ScheduleQueryRepository,
  type SlotReadState,
} from "../application/schedule-query";

// Structural subset of the existing D1 API; no binding or runtime activation.
export interface ScheduleQueryD1 {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ success: boolean; results: T[] }>;
    };
  };
}

export class ScheduleQueryDatabaseError extends Error {
  readonly code = "SERVICE_UNAVAILABLE";
  constructor() {
    super("SERVICE_UNAVAILABLE");
    this.name = "ScheduleQueryDatabaseError";
  }
}

// A single SELECT supplies one committed read state, including empty/unpublished
// months. Do not independently read month, occupancy and reservation snapshots.
const readMonthSql = `
SELECT m.month_key, m.published_at,
       s.id AS slot_id, s.lesson_date, s.start_time, s.end_time,
       s.starts_at, s.ends_at, s.availability_status,
       o.id AS occupancy_id, o.occupancy_type, o.reservation_id AS occupancy_reservation_id,
       r.id AS reservation_id, r.lesson_slot_id AS reservation_slot_id,
       r.student_id, r.status, r.classification,
       CASE
         WHEN o.id IS NULL THEN 1
         WHEN o.occupancy_type = 'student_reservation' THEN
           o.reservation_id IS NOT NULL AND
           EXISTS (SELECT 1 FROM student_reservations AS ref
                   WHERE ref.id = o.reservation_id AND ref.lesson_slot_id = s.id AND ref.status = 'confirmed') AND
           ah.occupancy_id IS NULL AND gl.occupancy_id IS NULL
         WHEN o.occupancy_type = 'admin_hold' THEN
           o.reservation_id IS NULL AND ah.occupancy_id IS NOT NULL AND gl.occupancy_id IS NULL
         WHEN o.occupancy_type = 'group_lesson' THEN
           o.reservation_id IS NULL AND gl.occupancy_id IS NOT NULL AND ah.occupancy_id IS NULL
         ELSE 0
       END AS occupancy_consistent,
       CASE WHEN r.id IS NULL THEN 1 ELSE
         (r.classification IS CASE
           WHEN r.status <> 'confirmed' OR a.reservation_id IS NOT NULL OR c.reservation_id IS NOT NULL THEN NULL
           ELSE COALESCE(co.classification, r.automatic_classification)
         END) AND
         ((r.status = 'confirmed' AND r.cancelled_at IS NULL) OR
          (r.status <> 'confirmed' AND r.cancelled_at IS NOT NULL))
       END AS classification_consistent
FROM schedule_months AS m
LEFT JOIN lesson_slots AS s ON s.schedule_month_id = m.id AND m.published_at IS NOT NULL
LEFT JOIN slot_occupancies AS o ON o.slot_id = s.id
LEFT JOIN admin_holds AS ah ON ah.occupancy_id = o.id
LEFT JOIN group_lessons AS gl ON gl.occupancy_id = o.id
-- Include all confirmed rows, even orphan/duplicate confirmed reservations.
-- Cancelled history is read only when an occupancy references it.
LEFT JOIN student_reservations AS r ON
  (r.lesson_slot_id = s.id AND r.status = 'confirmed') OR
  (o.occupancy_type = 'student_reservation' AND r.id = o.reservation_id)
LEFT JOIN reservation_absences AS a ON a.reservation_id = r.id
LEFT JOIN reservation_monthly_count_overrides AS c ON c.reservation_id = r.id
LEFT JOIN reservation_classification_overrides AS co ON co.reservation_id = r.id
WHERE m.month_key = ?
ORDER BY s.starts_at ASC, s.id ASC, r.id ASC
`;

interface ReadRow {
  month_key: string;
  published_at: number | null;
  slot_id: string | null;
  lesson_date: string;
  start_time: string;
  end_time: string;
  starts_at: number;
  ends_at: number;
  availability_status: SlotReadState["availability"];
  occupancy_id: string | null;
  occupancy_type: OccupancyReadState["type"];
  occupancy_reservation_id: string | null;
  reservation_id: string | null;
  reservation_slot_id: string;
  student_id: string;
  status: ReservationState;
  classification: Classification | null;
  occupancy_consistent: number;
  classification_consistent: number;
}

type MutableSlot = {
  -readonly [K in keyof SlotReadState]: K extends "reservations"
    ? Array<SlotReadState["reservations"][number]>
    : SlotReadState[K];
};

function datesConsistent(row: ReadRow): boolean {
  try {
    const start = toTokyoDateTime(row.starts_at);
    const end = toTokyoDateTime(row.ends_at);
    return start.slice(0, 7) === row.month_key &&
      start.slice(0, 10) === row.lesson_date && end.slice(0, 10) === row.lesson_date &&
      start.slice(11, 16) === row.start_time && end.slice(11, 16) === row.end_time &&
      start.slice(17, 19) === "00" && end.slice(17, 19) === "00" &&
      row.start_time < row.end_time && row.starts_at < row.ends_at;
  } catch {
    return false;
  }
}

export class D1ScheduleQueryRepository implements ScheduleQueryRepository {
  constructor(private readonly database: ScheduleQueryD1) {}

  async readMonth(month: string): Promise<ScheduleMonthReadState | null> {
    let rows: ReadRow[];
    try {
      const result = await this.database.prepare(readMonthSql).bind(month).all<ReadRow>();
      if (!result.success) throw new ScheduleQueryDatabaseError();
      rows = result.results;
    } catch {
      // Never retain or expose SQL, raw D1 errors or their cause on this boundary.
      throw new ScheduleQueryDatabaseError();
    }
    const first = rows[0];
    if (!first) return null;
    if (first.month_key !== month ||
        (first.published_at !== null && !Number.isSafeInteger(first.published_at))) {
      throw new ScheduleQueryError("INTEGRITY_STATE_UNAVAILABLE");
    }
    const slots = new Map<string, MutableSlot>();
    for (const row of rows) {
      if (row.slot_id === null) continue;
      let slot = slots.get(row.slot_id);
      if (!slot) {
        slot = {
          slotId: row.slot_id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          availability: row.availability_status,
          occupancies: row.occupancy_id === null ? [] : [{
            slotId: row.slot_id,
            type: row.occupancy_type,
            reservationId: row.occupancy_reservation_id,
          }],
          reservations: [],
          integrity: datesConsistent(row) && row.occupancy_consistent === 1 ? "consistent" : "inconsistent",
        };
        slots.set(row.slot_id, slot);
      }
      if (row.classification_consistent !== 1) slot.integrity = "inconsistent";
      if (row.reservation_id !== null) {
        slot.reservations.push({
          reservationId: row.reservation_id,
          slotId: row.reservation_slot_id,
          studentId: row.student_id,
          status: row.status,
          classification: row.classification,
        });
      }
    }
    return { month: first.month_key, publishedAt: first.published_at, slots: [...slots.values()] };
  }
}
