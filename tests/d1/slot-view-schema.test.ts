import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedSlotViewFixture } from "./slot-view-fixture";

beforeAll(async () => { await seedSlotViewFixture("schema-file"); });
afterAll(async () => {
  expect((await env.TEST_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

function monthInsert(key: string) {
  return env.TEST_DB.prepare(
    "INSERT INTO schedule_months (id, month_key, created_at, updated_at) VALUES ('new-month', ?, 0, 0)",
  ).bind(key).run();
}

function slotInsert(month = "month", starts = 10, ends = 20, availability = "enabled", day = "2026-11-29") {
  return env.TEST_DB.prepare(
    `INSERT INTO lesson_slots
     (id, schedule_month_id, lesson_date, start_time, end_time, starts_at, ends_at, availability_status)
     VALUES ('new-slot', ?, ?, '10:00', '11:00', ?, ?, ?)`,
  ).bind(month, day, starts, ends, availability).run();
}

function reservationInsert(
  student = "student", slot = "slot-d", status = "confirmed",
  automatic = "standard", classification: string | null = "standard", cancelledAt: number | null = null,
) {
  return env.TEST_DB.prepare(
    `INSERT INTO student_reservations
     (id, student_id, lesson_slot_id, status, automatic_classification, classification, created_at, cancelled_at, updated_at)
     VALUES ('new-reservation', ?, ?, ?, ?, ?, 0, ?, 0)`,
  ).bind(student, slot, status, automatic, classification, cancelledAt).run();
}

function occupancyInsert(type = "admin_hold", reservation: string | null = null, slot = "slot-d") {
  return env.TEST_DB.prepare(
    `INSERT INTO slot_occupancies (id, slot_id, occupancy_type, reservation_id, created_at, created_by)
     VALUES ('new-occupancy', ?, ?, ?, 0, 'fixture-actor')`,
  ).bind(slot, type, reservation).run();
}

it("[#829 D1 fixture] applies the read schema and stores a published month / confirmed reservation / occupancy", async () => {
  expect(await env.TEST_DB.prepare("SELECT month_key, published_at FROM schedule_months WHERE id = 'month'").first())
    .toEqual({ month_key: "2026-11", published_at: Date.parse("2026-10-01T00:00:00Z") / 1000 });
  expect(await env.TEST_DB.prepare("SELECT student_id, lesson_slot_id, status, classification FROM student_reservations").first())
    .toEqual({ student_id: "student", lesson_slot_id: "slot-a", status: "confirmed", classification: "standard" });
  expect(await env.TEST_DB.prepare("SELECT slot_id, occupancy_type, reservation_id FROM slot_occupancies").first())
    .toEqual({ slot_id: "slot-a", occupancy_type: "student_reservation", reservation_id: "reservation" });
});

it.each([
  ["ix_slots_month_start", ["schedule_month_id", "starts_at", "id"]],
  ["ix_reservations_student_slot", ["student_id", "lesson_slot_id"]],
  ["ix_reservations_slot", ["lesson_slot_id"]],
])("[#829 D1 fixture] retains index %s", async (name, columns) => {
  const index = await env.TEST_DB.prepare(`PRAGMA index_info('${name}')`).all<{ name: string }>();
  expect(index.results.map((column) => column.name)).toEqual(columns);
});

it.each(["2026-00", "2026-13", "2026-1", "26-11", "2026/11", "2026-11x", "abcd-11"])(
  "[#829 D1 fixture] rejects malformed month %s", async (key) => {
    await expect(monthInsert(key)).rejects.toThrow(/CHECK constraint failed/);
  },
);
it("[#829 D1 fixture] rejects a duplicate month", async () => {
  await expect(monthInsert("2026-11")).rejects.toThrow(/UNIQUE constraint failed/);
});
it("[#829 D1 fixture] rejects an unknown Slot month", async () => {
  await expect(slotInsert("missing-month")).rejects.toThrow(/FOREIGN KEY constraint failed/);
});
it.each([[10, 10], [20, 10]])("[#829 D1 fixture] rejects invalid Slot interval %s..%s", async (starts, ends) => {
  await expect(slotInsert("month", starts, ends)).rejects.toThrow(/CHECK constraint failed/);
});
it("[#829 D1 fixture] rejects unknown availability", async () => {
  await expect(slotInsert("month", 10, 20, "unknown")).rejects.toThrow(/CHECK constraint failed/);
});
it("[#829 D1 fixture] rejects a duplicate local Slot start", async () => {
  await expect(slotInsert("month", 10, 20, "enabled", "2026-11-01")).rejects.toThrow(/UNIQUE constraint failed/);
});

it.each([["missing-student", "slot-d"], ["student", "missing-slot"]])(
  "[#829 D1 fixture] rejects Reservation FK %s / %s", async (student, slot) => {
    await expect(reservationInsert(student, slot)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  },
);
it("[#829 D1 fixture] rejects unknown Reservation status", async () => {
  await expect(reservationInsert("student", "slot-d", "unknown")).rejects.toThrow(/CHECK constraint failed/);
});
it.each([["unknown", "standard"], ["standard", "not_applicable"]])(
  "[#829 D1 fixture] rejects classification %s / %s", async (automatic, classification) => {
    await expect(reservationInsert("student", "slot-d", "confirmed", automatic, classification))
      .rejects.toThrow(/CHECK constraint failed/);
  },
);
it.each(["student_cancelled", "school_cancelled", "system_cancelled"])(
  "[#829 D1 fixture] requires cancelled_at for %s", async (status) => {
    await expect(reservationInsert("student", "slot-d", status)).rejects.toThrow(/CHECK constraint failed/);
  },
);
it("[#829 D1 fixture] forbids cancelled_at on confirmed", async () => {
  await expect(reservationInsert("student", "slot-d", "confirmed", "standard", "standard", 1))
    .rejects.toThrow(/CHECK constraint failed/);
});

it("[#829 D1 fixture] rejects a second current occupancy on the same Slot", async () => {
  await expect(occupancyInsert("admin_hold", null, "slot-a")).rejects.toThrow(/UNIQUE constraint failed/);
});
it.each([
  ["unknown", null], ["student_reservation", null],
  ["admin_hold", "reservation"], ["group_lesson", "reservation"],
])("[#829 D1 fixture] rejects occupancy shape %s / %s", async (type, reservation) => {
  await expect(occupancyInsert(type, reservation)).rejects.toThrow(/CHECK constraint failed/);
});
it.each([
  ["admin_hold", null, "missing-slot"],
  ["student_reservation", "missing-reservation", "slot-d"],
])("[#829 D1 fixture] rejects occupancy FK %s / %s / %s", async (type, reservation, slot) => {
  await expect(occupancyInsert(type, reservation, slot)).rejects.toThrow(/FOREIGN KEY constraint failed/);
});
it("[#829 D1 fixture] rejects a Reservation pointing to a different Slot via the composite FK", async () => {
  // Both parents exist; the reference has no occupancy, so UNIQUE cannot mask the FK failure.
  expect((await reservationInsert()).success).toBe(true);
  await expect(occupancyInsert("student_reservation", "new-reservation", "slot-b"))
    .rejects.toThrow(/FOREIGN KEY constraint failed/);
});

it("[#829 D1 fixture] allows unpublished months, disabled Slots, cancellation history and NULL classification", async () => {
  expect((await monthInsert("2026-12")).success).toBe(true);
  expect(await env.TEST_DB.prepare("SELECT published_at FROM schedule_months WHERE id = 'new-month'").first())
    .toEqual({ published_at: null });
  expect((await slotInsert("new-month", 10, 20, "disabled", "2026-12-01")).success).toBe(true);
  for (const status of ["student_cancelled", "school_cancelled", "system_cancelled"]) {
    const result = await env.TEST_DB.prepare(
      `INSERT INTO student_reservations
       (id, student_id, lesson_slot_id, status, automatic_classification, classification, created_at, cancelled_at, updated_at)
       VALUES (?, 'student', 'slot-a', ?, 'additional', NULL, 0, 1, 1)`,
    ).bind(status, status).run();
    expect(result.success).toBe(true);
  }
});
it("[#829 D1 fixture] accepts non-reservation occupancy shapes at the DB constraint level", async () => {
  // Shape evidence only; AdminHold / GroupLesson detail invariants are outside this read fixture.
  for (const [type, slot] of [["admin_hold", "slot-b"], ["group_lesson", "slot-c"]]) {
    const result = await env.TEST_DB.prepare(
      `INSERT INTO slot_occupancies (id, slot_id, occupancy_type, reservation_id, created_at, created_by)
       VALUES (?, ?, ?, NULL, 0, 'fixture-actor')`,
    ).bind(type, slot, type).run();
    expect(result.success).toBe(true);
  }
});
