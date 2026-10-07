import {
  ReservationPreviewError,
  type MonthlyReservationReadState,
  type PreviewIdentity,
  type PreviewReadState,
} from "../application/reservation-preview";
import { mapSlotView, toTokyoDateTime, type SlotReadState } from "../application/schedule-query";
import type { ScheduleQueryD1 } from "./d1-schedule-query";

export interface ReservationPreviewD1 {
  withSession(constraint: "first-primary"): ScheduleQueryD1;
}

// Reusable by Preview and later Confirm preparation. No writes or HTTP wiring.
export interface CapturedPreviewRead {
  readonly state: PreviewReadState;
  readonly evaluatedAt: number;
}

// One SELECT, including D1 T0, access, N, all own monthly rows and the integrity
// of their Slots. Other owners are examined only by SQL predicates, never output.
const readPreviewSql = `
WITH input AS (
  SELECT ? AS student_id, ? AS slot_id, CAST(strftime('%s','now') AS INTEGER) AS t0
), target AS (
  SELECT s.*, m.month_key, m.published_at
  FROM lesson_slots AS s LEFT JOIN schedule_months AS m ON m.id = s.schedule_month_id
  WHERE s.id = (SELECT slot_id FROM input)
), access AS (
  SELECT DISTINCT student_id, lifecycle, deleted_at, access_state
  FROM student_session_access_v1 WHERE student_id = (SELECT student_id FROM input)
), own AS (
  SELECT r.*, s.starts_at, s.ends_at, s.lesson_date, s.start_time, s.end_time,
         s.availability_status, m.month_key,
         a.reservation_id AS absence_id, a.recorded_at,
         c.reservation_id AS count_id, c.override_mode,
         co.reservation_id AS override_id, co.classification AS override_classification
  FROM student_reservations AS r
  LEFT JOIN lesson_slots AS s ON s.id = r.lesson_slot_id
  LEFT JOIN schedule_months AS m ON m.id = s.schedule_month_id
  LEFT JOIN reservation_absences AS a ON a.reservation_id = r.id
  LEFT JOIN reservation_monthly_count_overrides AS c ON c.reservation_id = r.id
  LEFT JOIN reservation_classification_overrides AS co ON co.reservation_id = r.id
  WHERE r.student_id = (SELECT student_id FROM input)
    AND (m.id = (SELECT schedule_month_id FROM target) OR m.id IS NULL)
), relevant_slots AS (
  SELECT * FROM lesson_slots WHERE id = (SELECT slot_id FROM input)
    OR id IN (SELECT lesson_slot_id FROM own)
), bad_future_slots AS (
  SELECT s.id FROM relevant_slots AS s
  LEFT JOIN slot_occupancies AS o ON o.slot_id = s.id
  LEFT JOIN admin_holds AS ah ON ah.occupancy_id = o.id
  LEFT JOIN group_lessons AS gl ON gl.occupancy_id = o.id
  WHERE s.starts_at > (SELECT t0 FROM input) AND (
    (SELECT COUNT(*) FROM slot_occupancies WHERE slot_id = s.id) > 1 OR
    CASE
      WHEN o.id IS NULL THEN EXISTS (
        SELECT 1 FROM student_reservations WHERE lesson_slot_id = s.id AND status = 'confirmed')
      WHEN o.occupancy_type = 'student_reservation' THEN
        o.reservation_id IS NULL OR ah.occupancy_id IS NOT NULL OR gl.occupancy_id IS NOT NULL OR
        (SELECT COUNT(*) FROM student_reservations WHERE lesson_slot_id = s.id AND status = 'confirmed') <> 1 OR
        NOT EXISTS (
          SELECT 1 FROM student_reservations AS r
          JOIN students AS owner ON owner.id = r.student_id
          LEFT JOIN reservation_absences AS a ON a.reservation_id = r.id
          LEFT JOIN reservation_monthly_count_overrides AS c ON c.reservation_id = r.id
          LEFT JOIN reservation_classification_overrides AS co ON co.reservation_id = r.id
          WHERE r.id = o.reservation_id AND r.lesson_slot_id = s.id AND r.status = 'confirmed'
            AND typeof(r.id) = 'text' AND length(r.id) > 0
            AND typeof(r.student_id) = 'text' AND length(r.student_id) > 0
            AND r.cancelled_at IS NULL AND a.reservation_id IS NULL
            AND r.automatic_classification IN ('standard','additional')
            AND (c.reservation_id IS NULL OR c.override_mode = 'excluded')
            AND (co.reservation_id IS NULL OR co.classification IN ('standard','additional'))
            AND r.classification IS CASE WHEN c.reservation_id IS NOT NULL THEN NULL
                ELSE COALESCE(co.classification, r.automatic_classification) END)
      WHEN o.occupancy_type = 'admin_hold' THEN
        o.reservation_id IS NOT NULL OR ah.occupancy_id IS NULL OR gl.occupancy_id IS NOT NULL OR
        EXISTS (SELECT 1 FROM student_reservations WHERE lesson_slot_id = s.id AND status = 'confirmed')
      WHEN o.occupancy_type = 'group_lesson' THEN
        o.reservation_id IS NOT NULL OR gl.occupancy_id IS NULL OR ah.occupancy_id IS NOT NULL OR
        EXISTS (SELECT 1 FROM student_reservations WHERE lesson_slot_id = s.id AND status = 'confirmed')
      ELSE 1
    END
  )
)
SELECT i.t0 AS evaluated_at,
       (SELECT id FROM students WHERE id = i.student_id) AS student_id,
       (SELECT json_group_array(json_object(
         'lifecycle', lifecycle, 'deletedAt', deleted_at, 'accessState', access_state)) FROM access) AS access_json,
       (SELECT json_object(
         'slotId', id, 'month', month_key, 'publishedAt', published_at,
         'startsAt', starts_at, 'endsAt', ends_at, 'lessonDate', lesson_date,
         'startTime', start_time, 'endTime', end_time, 'availability', availability_status)
        FROM target) AS target_json,
       (SELECT json_group_array(json_object('standardCount', standard_count, 'updatedAt', updated_at))
        FROM student_monthly_lesson_configs
        WHERE student_id = i.student_id AND schedule_month_id = (SELECT schedule_month_id FROM target)) AS config_json,
       (SELECT json_group_array(json_object(
         'reservationId', id, 'studentId', student_id, 'slotId', lesson_slot_id,
         'startsAt', starts_at, 'endsAt', ends_at, 'month', month_key,
         'lessonDate', lesson_date, 'startTime', start_time, 'endTime', end_time,
         'availability', availability_status, 'status', status, 'cancelledAt', cancelled_at,
         'automaticClassification', automatic_classification, 'classification', classification,
         'absent', absence_id IS NOT NULL, 'recordedAt', recorded_at,
         'monthlyCountOverride', override_mode, 'countPresent', count_id IS NOT NULL,
         'classificationOverride', override_classification, 'overridePresent', override_id IS NOT NULL))
        FROM (SELECT * FROM own ORDER BY starts_at, id)) AS reservations_json,
       EXISTS (SELECT 1 FROM bad_future_slots) AS bad_future,
       EXISTS (SELECT 1 FROM slot_occupancies AS o
         JOIN student_reservations AS r ON r.id = o.reservation_id
         WHERE o.slot_id = i.slot_id AND r.student_id <> i.student_id) AS foreign_occupied,
       (SELECT json_group_array(json_object(
         'slotId', o.slot_id, 'type', o.occupancy_type,
         'reservationId', CASE WHEN r.student_id = i.student_id THEN o.reservation_id ELSE NULL END))
        FROM slot_occupancies AS o LEFT JOIN student_reservations AS r ON r.id = o.reservation_id
        WHERE o.slot_id = i.slot_id) AS occupancies_json
FROM input AS i
`;

type ObjectRow = Record<string, unknown>;
function fail(): never { throw new ReservationPreviewError("INTEGRITY_STATE_UNAVAILABLE"); }
function object(value: unknown): ObjectRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as ObjectRow;
}
function array(value: unknown): ObjectRow[] {
  if (typeof value !== "string") return fail();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail(); }
  if (!Array.isArray(parsed)) return fail();
  return parsed.map(object);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fail();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value) return fail();
  return value;
}
function classification(value: unknown): "standard" | "additional" {
  if (value !== "standard" && value !== "additional") return fail();
  return value;
}
function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) return fail();
  return value === 1;
}
function dates(row: ObjectRow, month: string): void {
  const start = toTokyoDateTime(integer(row.startsAt));
  const end = toTokyoDateTime(integer(row.endsAt));
  if (row.month !== month || start.slice(0, 7) !== month ||
      start.slice(0, 10) !== row.lessonDate || end.slice(0, 10) !== row.lessonDate ||
      start.slice(11, 16) !== row.startTime || end.slice(11, 16) !== row.endTime ||
      start.slice(17, 19) !== "00" || end.slice(17, 19) !== "00" || start >= end ||
      (row.availability !== "enabled" && row.availability !== "disabled")) fail();
}
function reservation(row: ObjectRow, studentId: string, month: string, now: number): MonthlyReservationReadState {
  dates(row, month);
  if (row.studentId !== studentId || !["confirmed", "student_cancelled", "school_cancelled", "system_cancelled"].includes(String(row.status))) fail();
  if (row.status === "confirmed" ? row.cancelledAt !== null : !Number.isSafeInteger(row.cancelledAt)) fail();
  const absent = flag(row.absent);
  if (absent && (row.status !== "confirmed" || now < integer(row.endsAt))) fail();
  if (absent && integer(row.recordedAt) < integer(row.endsAt)) fail();
  const countPresent = flag(row.countPresent);
  if (countPresent ? row.monthlyCountOverride !== "excluded" : row.monthlyCountOverride !== null) fail();
  const overridePresent = flag(row.overridePresent);
  const override = overridePresent ? classification(row.classificationOverride) : null;
  if (!overridePresent && row.classificationOverride !== null) fail();
  const automatic = classification(row.automaticClassification);
  // Validate persisted effective classification; do not repair or compute a plan.
  const effective = row.status === "confirmed" && !absent && !countPresent ? override ?? automatic : null;
  if (row.classification !== effective) fail();
  return {
    reservationId: id(row.reservationId), studentId, slotId: id(row.slotId),
    startsAt: integer(row.startsAt), endsAt: integer(row.endsAt),
    status: row.status as MonthlyReservationReadState["status"],
    automaticClassification: automatic, classification: effective, absent,
    monthlyCountOverride: countPresent ? "excluded" : null, classificationOverride: override,
  };
}

export class D1ReservationPreviewRepository {
  constructor(private readonly database: ReservationPreviewD1) {}

  async readPreview(identity: PreviewIdentity, slotId: string): Promise<CapturedPreviewRead> {
    if (!identity.studentId || !slotId) fail();
    let rows: unknown[];
    try {
      const result = await this.database.withSession("first-primary")
        .prepare(readPreviewSql).bind(identity.studentId, slotId).all<unknown>();
      if (!result.success || !Array.isArray(result.results)) throw new Error();
      rows = result.results;
    } catch {
      // No SQL, raw D1 exception or cause survives this boundary.
      throw new ReservationPreviewError("SERVICE_UNAVAILABLE");
    }
    try {
      if (rows.length !== 1) fail();
      const row = object(rows[0]);
      const now = integer(row.evaluated_at);
      if (row.student_id !== identity.studentId) fail();
      const access = array(row.access_json);
      if (access.length !== 1) fail();
      const current = access[0];
      if ((current.lifecycle !== "active" && current.lifecycle !== "deleted") ||
          (current.accessState !== "active" && current.accessState !== "suspended") ||
          (current.lifecycle === "active" ? current.deletedAt !== null : !Number.isSafeInteger(current.deletedAt))) fail();
      if (row.target_json === null) throw new ReservationPreviewError("RESERVATION_NOT_AVAILABLE");
      if (typeof row.target_json !== "string") fail();
      const target = object(JSON.parse(row.target_json));
      const month = id(target.month);
      dates(target, month);
      if (target.slotId !== slotId) fail();
      if (target.publishedAt !== null) toTokyoDateTime(integer(target.publishedAt));
      if (flag(row.bad_future)) fail();
      const reservations = array(row.reservations_json).map((item) => reservation(item, identity.studentId, month, now));
      const ids = new Set<string>();
      for (const item of reservations) {
        if (ids.has(item.reservationId)) fail();
        ids.add(item.reservationId);
      }
      const configs = array(row.config_json);
      if (configs.length > 1) fail();
      const config = configs[0];
      if (config && integer(config.standardCount) < 0) fail();
      if (config) integer(config.updatedAt);
      // Reject foreign occupancy before it reaches Application read state.
      if (flag(row.foreign_occupied)) {
        throw new ReservationPreviewError(now >= integer(target.startsAt)
          ? "RESERVATION_WINDOW_CLOSED" : "RESERVATION_NOT_AVAILABLE");
      }
      const slot: SlotReadState = {
        slotId, startsAt: integer(target.startsAt), endsAt: integer(target.endsAt),
        availability: target.availability as SlotReadState["availability"],
        occupancies: array(row.occupancies_json).map((item) => {
          if (item.slotId !== slotId || !["student_reservation", "admin_hold", "group_lesson"].includes(String(item.type))) fail();
          return { slotId, type: item.type as SlotReadState["occupancies"][number]["type"],
            reservationId: item.reservationId === null ? null : id(item.reservationId) };
        }),
        reservations: reservations.filter((item) => item.slotId === slotId && item.status === "confirmed"),
        integrity: "consistent",
      };
      mapSlotView(slot, identity.studentId, now);
      return { evaluatedAt: now, state: {
        studentId: identity.studentId,
        reservationOperationAllowed: current.lifecycle === "active" && current.accessState === "active",
        month, publishedAt: target.publishedAt as number | null, slot,
        standardCountConfig: config ? { standardCount: integer(config.standardCount) } : null,
        reservations, integrity: "consistent",
      } };
    } catch (error) {
      if (error instanceof ReservationPreviewError) throw error;
      return fail();
    }
  }
}
