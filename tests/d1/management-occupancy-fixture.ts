import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { seedSlotViewFixture } from "./slot-view-fixture";

// #611 §2.1 Integrity Query/Test contract. Test-only, not the #830 Adapter.
export const managementOccupancyIntegrityQuery = `
SELECT o.slot_id, o.id AS occupancy_id
FROM slot_occupancies AS o
LEFT JOIN student_reservations AS r ON r.id = o.reservation_id
LEFT JOIN admin_holds AS ah ON ah.occupancy_id = o.id
LEFT JOIN group_lessons AS gl ON gl.occupancy_id = o.id
WHERE (o.occupancy_type = 'student_reservation' AND
       (r.id IS NULL OR r.status <> 'confirmed' OR r.lesson_slot_id <> o.slot_id OR
        ah.occupancy_id IS NOT NULL OR gl.occupancy_id IS NOT NULL))
   OR (o.occupancy_type = 'admin_hold' AND
       (o.reservation_id IS NOT NULL OR ah.occupancy_id IS NULL OR gl.occupancy_id IS NOT NULL))
   OR (o.occupancy_type = 'group_lesson' AND
       (o.reservation_id IS NOT NULL OR gl.occupancy_id IS NULL OR ah.occupancy_id IS NOT NULL))
ORDER BY o.slot_id, o.id;
`;

export async function seedManagementOccupancyFixture(actor: string): Promise<void> {
  await seedSlotViewFixture(actor);
  // Identical IDs across files prove storage isolation; no cleanup DELETE.
  for (const table of ["admin_holds", "group_lessons"]) {
    expect((await env.TEST_DB.prepare(`SELECT occupancy_id FROM ${table}`).all()).results).toEqual([]);
  }
  const results = await env.TEST_DB.batch([
    env.TEST_DB.prepare(
      `INSERT INTO slot_occupancies (id, slot_id, occupancy_type, reservation_id, created_at, created_by)
       VALUES ('admin', 'slot-b', 'admin_hold', NULL, 0, ?)`,
    ).bind(actor),
    env.TEST_DB.prepare(
      `INSERT INTO slot_occupancies (id, slot_id, occupancy_type, reservation_id, created_at, created_by)
       VALUES ('group', 'slot-c', 'group_lesson', NULL, 0, ?)`,
    ).bind(actor),
    env.TEST_DB.prepare("INSERT INTO admin_holds (occupancy_id) VALUES ('admin')"),
    env.TEST_DB.prepare("INSERT INTO group_lessons (occupancy_id) VALUES ('group')"),
  ]);
  expect(results.every((result) => result.success)).toBe(true);
  expect((await env.TEST_DB.prepare(managementOccupancyIntegrityQuery).all()).results).toEqual([]);
  expect((await env.TEST_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}
