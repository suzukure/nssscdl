import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it } from "vitest";
import { managementOccupancyIntegrityQuery, seedManagementOccupancyFixture } from "./management-occupancy-fixture";

beforeAll(async () => { await seedManagementOccupancyFixture("management-schema-file"); });
afterEach(async () => {
  expect((await env.TEST_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("[#834 D1 fixture] reads valid AdminHold / GroupLesson details through occupancy_id", async () => {
  expect((await env.TEST_DB.prepare("SELECT occupancy_id FROM admin_holds").all()).results)
    .toEqual([{ occupancy_id: "admin" }]);
  expect((await env.TEST_DB.prepare("SELECT occupancy_id FROM group_lessons").all()).results)
    .toEqual([{ occupancy_id: "group" }]);
  expect((await env.TEST_DB.prepare(managementOccupancyIntegrityQuery).all()).results).toEqual([]);
});

it.each(["admin_holds", "group_lessons"])("[#834 D1 fixture] rejects orphan %s detail by FK", async (table) => {
  await expect(env.TEST_DB.prepare(`INSERT INTO ${table} (occupancy_id) VALUES ('missing-occupancy')`).run())
    .rejects.toThrow(/FOREIGN KEY constraint failed/);
});
it.each([["admin_holds", "admin"], ["group_lessons", "group"]])(
  "[#834 D1 fixture] rejects duplicate same-type %s detail", async (table, id) => {
    await expect(env.TEST_DB.prepare(`INSERT INTO ${table} (occupancy_id) VALUES (?)`).bind(id).run())
      .rejects.toThrow(/UNIQUE constraint failed/);
  },
);

// All four detail combinations for each type: valid, missing, wrong and both.
const detailCases = [
  { type: "student_reservation", id: "occupancy", slot: "slot-a", requiredMask: 0 },
  { type: "admin_hold", id: "admin", slot: "slot-b", requiredMask: 1 },
  { type: "group_lesson", id: "group", slot: "slot-c", requiredMask: 2 },
].flatMap((occupancy) => [0, 1, 2, 3].map((mask) => ({ ...occupancy, mask })));

it.each(detailCases)("[#834 D1 fixture] detects $type detail combination $mask", async ({ id, slot, mask, requiredMask }) => {
  // Deliberate corruption fixture, not storage-isolation cleanup.
  for (const [table, bit] of [["admin_holds", 1], ["group_lessons", 2]] as const) {
    await env.TEST_DB.prepare(`DELETE FROM ${table} WHERE occupancy_id = ?`).bind(id).run();
    if (mask & bit) {
      expect((await env.TEST_DB.prepare(`INSERT INTO ${table} (occupancy_id) VALUES (?)`).bind(id).run()).success)
        .toBe(true);
    }
  }
  // DDL permits these cross-table anomalies; the query must identify exactly the affected occupancy.
  expect((await env.TEST_DB.prepare(managementOccupancyIntegrityQuery).all()).results)
    .toEqual(mask === requiredMask ? [] : [{ slot_id: slot, occupancy_id: id }]);
});

it("[#834 D1 fixture] retains the confirmed Reservation integrity condition", async () => {
  await env.TEST_DB.prepare(
    "UPDATE student_reservations SET status = 'student_cancelled', cancelled_at = 1 WHERE id = 'reservation'",
  ).run();
  expect((await env.TEST_DB.prepare(managementOccupancyIntegrityQuery).all()).results)
    .toEqual([{ slot_id: "slot-a", occupancy_id: "occupancy" }]);
});
