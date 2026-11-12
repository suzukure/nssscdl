import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScheduleQueryService } from "../../src/application/schedule-query";
import { D1ScheduleQueryRepository } from "../../src/infrastructure/d1-schedule-query";
import { seedManagementOccupancyFixture } from "./management-occupancy-fixture";

const start = Date.parse("2026-11-01T10:00:00+09:00") / 1000;
const repository = new D1ScheduleQueryRepository(env.TEST_DB);
const service = (now = start - 1) => new ScheduleQueryService(repository, { now: () => now });
const query = () => service().execute("2026-11", "student");
const integrityError = { code: "INTEGRITY_STATE_UNAVAILABLE", message: "INTEGRITY_STATE_UNAVAILABLE" };

beforeAll(async () => { await seedManagementOccupancyFixture("adapter-file"); });
beforeEach(async () => {
  // Restore mutations within this file; initial seed separately proves empty storage.
  const statements = [
    env.TEST_DB.prepare("DELETE FROM reservation_absences"),
    env.TEST_DB.prepare("DELETE FROM reservation_monthly_count_overrides"),
    env.TEST_DB.prepare("DELETE FROM reservation_classification_overrides"),
    env.TEST_DB.prepare("DELETE FROM admin_holds"),
    env.TEST_DB.prepare("DELETE FROM group_lessons"),
    env.TEST_DB.prepare("DELETE FROM student_reservations WHERE id = 'extra'"),
    env.TEST_DB.prepare("UPDATE schedule_months SET published_at = 0 WHERE id = 'month'"),
    env.TEST_DB.prepare("UPDATE student_reservations SET status = 'confirmed', cancelled_at = NULL, classification = 'standard', automatic_classification = 'standard' WHERE id = 'reservation'"),
    env.TEST_DB.prepare("UPDATE slot_occupancies SET reservation_id = 'reservation' WHERE id = 'occupancy'"),
    env.TEST_DB.prepare("INSERT INTO admin_holds (occupancy_id) VALUES ('admin')"),
    env.TEST_DB.prepare("INSERT INTO group_lessons (occupancy_id) VALUES ('group')"),
  ];
  for (const [id, day] of [["slot-a", "01"], ["slot-b", "08"], ["slot-c", "15"], ["slot-d", "22"]]) {
    const date = `2026-11-${day}`;
    const seconds = Date.parse(`${date}T10:00:00+09:00`) / 1000;
    statements.push(env.TEST_DB.prepare(
      "UPDATE lesson_slots SET lesson_date = ?, start_time = '10:00', end_time = '11:00', starts_at = ?, ends_at = ?, availability_status = 'enabled' WHERE id = ?",
    ).bind(date, seconds, seconds + 3600, id));
  }
  expect((await env.TEST_DB.batch(statements)).every((result) => result.success)).toBe(true);
});

describe("[TC-F-001-01 / TC-F-001-02 / TC-F-002-02] D1/API read-model partial evidence", () => {
  it("composes four Views with the existing Service and no internal fields", async () => {
    expect(await query()).toEqual({ month: "2026-11", slots: [
      { slotId: "slot-a", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:00:00+09:00", view: "reserved_by_me", reservationId: "reservation", classification: "standard" },
      { slotId: "slot-b", startsAt: "2026-11-08T10:00:00+09:00", endsAt: "2026-11-08T11:00:00+09:00", view: "unavailable" },
      { slotId: "slot-c", startsAt: "2026-11-15T10:00:00+09:00", endsAt: "2026-11-15T11:00:00+09:00", view: "group_lesson" },
      { slotId: "slot-d", startsAt: "2026-11-22T10:00:00+09:00", endsAt: "2026-11-22T11:00:00+09:00", view: "bookable" },
    ] });
  });
  it("keeps another student's reservation identifiers out of the final View", async () => {
    const result = await service().execute("2026-11", "different-student");
    expect(result.slots[0].view).toBe("unavailable");
    expect(result.slots[0]).not.toHaveProperty("reservationId");
    expect(result.slots[0]).not.toHaveProperty("classification");
    for (const value of ["reservation", "student", "adapter-file", "occupancy", "created_by", "studentId", "email", "name"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });
  it("returns disabled Slots without owner information", async () => {
    await env.TEST_DB.prepare("UPDATE lesson_slots SET availability_status = 'disabled'").run();
    expect((await query()).slots.map((slot) => slot.view)).toEqual(Array(4).fill("unavailable"));
    expect((await query()).slots.every((slot) => !("reservationId" in slot))).toBe(true);
  });
  it("retains started-Slot unavailable semantics despite detail corruption", async () => {
    await env.TEST_DB.prepare("DELETE FROM group_lessons").run();
    const result = await service(start + 40 * 86400).execute("2026-11", "student");
    expect(result.slots.every((slot) => slot.view === "unavailable")).toBe(true);
  });
  it.each(["standard", "additional", null])("returns valid owner classification %s", async (classification) => {
    if (classification === null) {
      await env.TEST_DB.prepare("INSERT INTO reservation_monthly_count_overrides VALUES ('reservation', 'excluded', 0, 'actor')").run();
    } else if (classification === "additional") {
      await env.TEST_DB.prepare("INSERT INTO reservation_classification_overrides VALUES ('reservation', 'additional', 0, 'actor')").run();
    }
    await env.TEST_DB.prepare("UPDATE student_reservations SET classification = ? WHERE id = 'reservation'").bind(classification).run();
    expect((await query()).slots[0]).toMatchObject({ view: "reserved_by_me", classification: classification ?? "not_applicable" });
  });
});

describe("[TC-F-002-01] D1/API read-model partial evidence: publication", () => {
  it("distinguishes nonexistent and unpublished months at the Port", async () => {
    expect(await repository.readMonth("2026-12")).toBeNull();
    await env.TEST_DB.prepare("UPDATE schedule_months SET published_at = NULL").run();
    expect(await repository.readMonth("2026-11")).toEqual({ month: "2026-11", publishedAt: null, slots: [] });
    for (const month of ["2026-11", "2026-12"]) {
      await expect(service().execute(month, "student")).rejects.toMatchObject({ code: "SCHEDULE_MONTH_NOT_AVAILABLE" });
    }
  });
  it("returns an empty published month", async () => {
    await env.TEST_DB.prepare("INSERT INTO schedule_months VALUES ('empty', '2026-12', 0, 0, 0)").run();
    expect(await service().execute("2026-12", "student")).toEqual({ month: "2026-12", slots: [] });
  });
});

it("[#830 D1 Adapter] uses starts_at ASC, id ASC even when persisted dates disagree", async () => {
  // Valid Slots cannot share the same date/time under the UNIQUE constraint.
  // Exercise the tie-break with an intentional multi-column integrity anomaly.
  await env.TEST_DB.prepare("UPDATE lesson_slots SET starts_at = ?, ends_at = ? WHERE id IN ('slot-c', 'slot-d')").bind(start, start + 3600).run();
  expect((await repository.readMonth("2026-11"))!.slots.map((slot) => slot.slotId))
    .toEqual(["slot-a", "slot-c", "slot-d", "slot-b"]);
  await expect(query()).rejects.toMatchObject(integrityError);
});

const details = [
  { id: "occupancy", type: "student_reservation", valid: 0 },
  { id: "admin", type: "admin_hold", valid: 1 },
  { id: "group", type: "group_lesson", valid: 2 },
].flatMap((item) => [0, 1, 2, 3].map((mask) => ({ ...item, mask })));
it.each(details)("[#830 BR-067] $type detail mask $mask fails closed unless valid", async ({ id, valid, mask }) => {
  for (const [table, bit] of [["admin_holds", 1], ["group_lessons", 2]] as const) {
    await env.TEST_DB.prepare(`DELETE FROM ${table} WHERE occupancy_id = ?`).bind(id).run();
    if (mask & bit) await env.TEST_DB.prepare(`INSERT INTO ${table} VALUES (?)`).bind(id).run();
  }
  if (mask === valid) await expect(query()).resolves.toHaveProperty("slots");
  else await expect(query()).rejects.toMatchObject(integrityError);
});

it.each(["student_cancelled", "school_cancelled", "system_cancelled"])("[#830 BR-067] rejects %s occupancy references", async (status) => {
  await env.TEST_DB.prepare("UPDATE student_reservations SET status = ?, cancelled_at = 0, classification = NULL WHERE id = 'reservation'").bind(status).run();
  await expect(query()).rejects.toMatchObject(integrityError);
});
it.each(["slot-a", "slot-b", "slot-d"])("[#830 BR-067] includes extra confirmed reservation for %s", async (slotId) => {
  await env.TEST_DB.prepare("INSERT INTO student_reservations VALUES ('extra', 'student', ?, 'confirmed', 'standard', 'standard', 0, NULL, 0)").bind(slotId).run();
  await expect(query()).rejects.toMatchObject(integrityError);
});
it.each([
  "UPDATE student_reservations SET classification = NULL WHERE id = 'reservation'",
  "UPDATE student_reservations SET classification = 'additional' WHERE id = 'reservation'",
  "INSERT INTO reservation_monthly_count_overrides VALUES ('reservation', 'excluded', 0, 'actor')",
  "INSERT INTO reservation_classification_overrides VALUES ('reservation', 'additional', 0, 'actor')",
  "INSERT INTO reservation_absences VALUES ('reservation', 0, 'actor')",
  "UPDATE lesson_slots SET lesson_date = '2026-12-01' WHERE id = 'slot-a'",
  "UPDATE lesson_slots SET start_time = '09:00' WHERE id = 'slot-a'",
  "UPDATE lesson_slots SET end_time = '12:00' WHERE id = 'slot-a'",
])("[#830 BR-067] rejects persisted classification/date anomaly: %s", async (sql) => {
  await env.TEST_DB.prepare(sql).run();
  await expect(query()).rejects.toMatchObject(integrityError);
});

it.each(["missing reference", "wrong Slot"])("[#830 corruption read fixture] fails closed on %s without disabling FK", async (anomaly) => {
  // Test-only source adapter models an existing fail-closed condition which the
  // fixture's FK prevents storing. Execute the real query in local D1 against
  // a narrowed/altered Reservation source; no production query branch.
  const source = anomaly === "missing reference"
    ? "(SELECT * FROM student_reservations WHERE id <> 'reservation')"
    : "(SELECT id, student_id, 'slot-d' AS lesson_slot_id, status, automatic_classification, classification, cancelled_at FROM student_reservations)";
  const corrupted = new D1ScheduleQueryRepository({
    prepare: (sql) => env.TEST_DB.prepare(sql.replaceAll(/(?<=FROM |JOIN )student_reservations/g, source)),
  });
  await expect(new ScheduleQueryService(corrupted, { now: () => start - 1 }).execute("2026-11", "student"))
    .rejects.toMatchObject(integrityError);
  expect((await env.TEST_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("[#830 BR-067] ignores released cancelled history when deciding an empty Slot", async () => {
  await env.TEST_DB.prepare("INSERT INTO student_reservations VALUES ('extra', 'student', 'slot-d', 'student_cancelled', 'standard', NULL, 0, 1, 1)").run();
  const state = await repository.readMonth("2026-11");
  expect(state!.slots[3].reservations).toEqual([]);
  expect((await query()).slots[3].view).toBe("bookable");
});
