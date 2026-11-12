import { env } from "cloudflare:workers";
import { expect } from "vitest";

// #829 schema evidence only: no Repository Adapter, auth, or Slot View mapping.
export async function seedSlotViewFixture(actor: string): Promise<void> {
  // Both test files use identical IDs. Never DELETE to simulate isolation.
  for (const table of ["students", "schedule_months", "lesson_slots", "student_reservations", "slot_occupancies"]) {
    const initial = await env.TEST_DB.prepare(`SELECT id FROM ${table}`).all();
    expect(initial.results).toEqual([]);
  }
  const createdAt = Date.parse("2026-10-01T00:00:00Z") / 1000;
  const statements = [
    env.TEST_DB.prepare("INSERT INTO students (id) VALUES ('student')"),
    env.TEST_DB.prepare(
      "INSERT INTO schedule_months (id, month_key, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("month", "2026-11", createdAt, createdAt, createdAt),
  ];
  for (const [id, day] of [["slot-a", "01"], ["slot-b", "08"], ["slot-c", "15"], ["slot-d", "22"]]) {
    const date = `2026-11-${day}`;
    const startsAt = Date.parse(`${date}T10:00:00+09:00`) / 1000;
    statements.push(env.TEST_DB.prepare(
      `INSERT INTO lesson_slots
       (id, schedule_month_id, lesson_date, start_time, end_time, starts_at, ends_at, availability_status)
       VALUES (?, 'month', ?, '10:00', '11:00', ?, ?, 'enabled')`,
    ).bind(id, date, startsAt, startsAt + 3600));
  }
  statements.push(
    env.TEST_DB.prepare(
      `INSERT INTO student_reservations
       (id, student_id, lesson_slot_id, status, automatic_classification, classification, created_at, updated_at)
       VALUES ('reservation', 'student', 'slot-a', 'confirmed', 'standard', 'standard', ?, ?)`,
    ).bind(createdAt, createdAt),
    env.TEST_DB.prepare(
      `INSERT INTO slot_occupancies (id, slot_id, occupancy_type, reservation_id, created_at, created_by)
       VALUES ('occupancy', 'slot-a', 'student_reservation', 'reservation', ?, ?)`,
    ).bind(createdAt, actor),
  );
  const results = await env.TEST_DB.batch(statements);
  expect(results.every((result) => result.success)).toBe(true);
  expect(await env.TEST_DB.prepare("SELECT created_by FROM slot_occupancies WHERE id = 'occupancy'").first())
    .toEqual({ created_by: actor });
  expect((await env.TEST_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}
