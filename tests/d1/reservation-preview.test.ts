import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewPlan, previewReservation } from "../../src/application/reservation-preview";
import { D1ReservationPreviewRepository } from "../../src/infrastructure/d1-reservation-preview";
import { db, identity, integrityError, now, repository, seedPreviewFixture, sql } from "./reservation-preview-fixture";

beforeAll(async () => { await seedPreviewFixture("preview-file"); });
beforeEach(async () => {
  // Restore local mutations; the initial seed, and a second file, prove isolation.
  await db.batch([
    sql("DELETE FROM reservation_absences"), sql("DELETE FROM reservation_monthly_count_overrides"),
    sql("DELETE FROM reservation_classification_overrides"), sql("DELETE FROM student_monthly_lesson_configs"),
    sql("DELETE FROM admin_holds"), sql("DELETE FROM group_lessons"),
    sql("DELETE FROM slot_occupancies WHERE id NOT IN ('past-o', 'later-o', 'admin-o', 'group-o')"),
    sql("DELETE FROM student_reservations WHERE id NOT IN ('past-r', 'later-r')"),
    sql("UPDATE student_reservations SET status = 'confirmed', cancelled_at = NULL, automatic_classification = 'standard', classification = 'standard'"),
    sql("INSERT INTO slot_occupancies SELECT 'past-o', 'past', 'student_reservation', 'past-r', 0, 'preview-file' WHERE NOT EXISTS (SELECT 1 FROM slot_occupancies WHERE id = 'past-o')"),
    sql("INSERT INTO slot_occupancies SELECT 'later-o', 'later', 'student_reservation', 'later-r', 0, 'preview-file' WHERE NOT EXISTS (SELECT 1 FROM slot_occupancies WHERE id = 'later-o')"),
    sql("INSERT INTO admin_holds VALUES ('admin-o')"), sql("INSERT INTO group_lessons VALUES ('group-o')"),
    sql("UPDATE schedule_months SET published_at = 0"),
    sql("UPDATE student_security_access SET access_state = 'active'"),
    sql("INSERT INTO student_security_access SELECT id, 'active', 0 FROM students WHERE id NOT IN (SELECT student_id FROM student_security_access)"),
    sql("UPDATE slot_occupancies SET reservation_id = 'later-r' WHERE id = 'later-o'"),
  ]);
  for (const [id, day] of [["past", "01"], ["admin", "12"], ["group", "13"], ["target", "15"], ["later", "22"], ["last", "29"]]) {
    const date = `2026-11-${day}`;
    const start = Date.parse(`${date}T10:00:00+09:00`) / 1000;
    await sql("UPDATE lesson_slots SET lesson_date = ?, starts_at = ?, ends_at = ?, availability_status = 'enabled' WHERE id = ?")
      .bind(date, start, start + 3600, id).run();
  }
});
const read = (slot = "target") => repository().readPreview(identity, slot);
const preview = async (slot = "target") => {
  const { state, evaluatedAt } = await read(slot);
  return previewReservation(identity, state, evaluatedAt);
};

describe("[TC-F-003-01 / TC-F-003-02] D1/Preview read partial evidence", () => {
  it("maps a coherent state and reuses the pure core for classification, Snapshot and token", async () => {
    const { state, evaluatedAt } = await read();
    expect(evaluatedAt).toBe(now);
    expect(state).toMatchObject({ studentId: "student", reservationOperationAllowed: true, month: "2026-11",
      publishedAt: 0, standardCountConfig: null, integrity: "consistent",
      slot: { slotId: "target", availability: "enabled", occupancies: [], reservations: [], integrity: "consistent" } });
    expect(state.reservations.map((item) => item.reservationId)).toEqual(["past-r", "later-r"]);
    expect(state.reservations[0].startsAt).toBeLessThan(evaluatedAt);
    expect(state.reservations[1].startsAt).toBeGreaterThan(evaluatedAt);
    expect(await preview()).toMatchObject({ previewClassification: "standard", classificationChanges: [] });
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 1, 0, 'actor')").run();
    expect(await preview()).toMatchObject({ previewClassification: "additional" });
    await sql("UPDATE student_monthly_lesson_configs SET standard_count = 2").run();
    expect(await preview()).toMatchObject({ previewClassification: "standard", classificationChanges: [
      { reservationId: "later-r", before: "standard", after: "additional" },
    ] });
    expect(createPreviewPlan(identity, state, evaluatedAt).canonicalSnapshot).toContain('"standardCountConfig":null');
  });
  it("distinguishes missing N from explicit N=3 and observes the latest configuration", async () => {
    const missing = await preview();
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 3, 0, 'actor')").run();
    expect((await read()).state.standardCountConfig).toEqual({ standardCount: 3 });
    const explicit = await preview();
    expect(explicit.previewClassification).toBe(missing.previewClassification);
    expect(explicit.expectedStateToken).not.toBe(missing.expectedStateToken);
    await sql("UPDATE student_monthly_lesson_configs SET standard_count = 0").run();
    expect((await preview()).previewClassification).toBe("additional");
  });
  it("captures real D1 T0 within the same SELECT independently of host Date.now", async () => {
    const before = await sql("SELECT CAST(strftime('%s','now') AS INTEGER) AS t").first<number>("t");
    const spy = vi.spyOn(Date, "now").mockReturnValue(0);
    let result;
    try { result = await new D1ReservationPreviewRepository(db).readPreview(identity, "target"); }
    finally { spy.mockRestore(); }
    const after = await sql("SELECT CAST(strftime('%s','now') AS INTEGER) AS t").first<number>("t");
    expect(result.evaluatedAt).toBeGreaterThanOrEqual(before!);
    expect(result.evaluatedAt).toBeLessThanOrEqual(after!);
  });
  it("produces deterministic states/tokens without database mutations", async () => {
    expect(await read()).toEqual(await read());
    expect(await preview()).toEqual(await preview());
    expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("uses starts_at then reservation.id with multiple cancelled histories at one Slot", async () => {
    await sql("INSERT INTO student_reservations VALUES ('z-history', 'student', 'later', 'school_cancelled', 'additional', NULL, 0, 1, 1), ('a-history', 'student', 'later', 'system_cancelled', 'standard', NULL, 0, 1, 1)").run();
    expect((await read()).state.reservations.map((item) => item.reservationId))
      .toEqual(["past-r", "a-history", "later-r", "z-history"]);
  });
  it.each(["student_cancelled", "school_cancelled", "system_cancelled", "absent", "excluded", "override"])(
    "maps %s distinctly without rewriting automatic classification", async (mode) => {
      if (mode.endsWith("cancelled")) {
        await sql("DELETE FROM slot_occupancies WHERE id = 'past-o'").run();
        await sql("UPDATE student_reservations SET status = ?, cancelled_at = 1, classification = NULL WHERE id = 'past-r'").bind(mode).run();
      } else if (mode === "absent") {
        await sql("INSERT INTO reservation_absences VALUES ('past-r', ?, 'actor')").bind(now).run();
        await sql("UPDATE student_reservations SET classification = NULL WHERE id = 'past-r'").run();
      } else if (mode === "excluded") {
        await sql("INSERT INTO reservation_monthly_count_overrides VALUES ('past-r', 'excluded', 0, 'actor')").run();
        await sql("UPDATE student_reservations SET classification = NULL WHERE id = 'past-r'").run();
      } else {
        await sql("INSERT INTO reservation_classification_overrides VALUES ('past-r', 'additional', 0, 'actor')").run();
        await sql("UPDATE student_reservations SET classification = 'additional' WHERE id = 'past-r'").run();
      }
      const item = (await read()).state.reservations[0];
      expect(item).toMatchObject({ automaticClassification: "standard", absent: mode === "absent",
        monthlyCountOverride: mode === "excluded" ? "excluded" : null,
        classificationOverride: mode === "override" ? "additional" : null,
        status: mode.endsWith("cancelled") ? mode : "confirmed",
        classification: mode === "override" ? "additional" : null });
      await expect(preview()).resolves.toHaveProperty("expectedStateToken");
    },
  );
  it("keeps future overrides effective when the core changes automatic classification", async () => {
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
    await sql("INSERT INTO reservation_classification_overrides VALUES ('later-r', 'standard', 0, 'actor')").run();
    expect((await preview()).classificationChanges).toEqual([]);
  });
  it("reads a released started Reservation without reopening it", async () => {
    await sql("DELETE FROM slot_occupancies WHERE id = 'past-o'").run();
    expect((await read()).state.reservations[0].status).toBe("confirmed");
    await expect(preview("past")).rejects.toMatchObject({ code: "RESERVATION_WINDOW_CLOSED" });
  });
});

it("[#863 self-scope] excludes other students and other months from Application state", async () => {
  const start = Date.parse("2026-12-01T10:00:00+09:00") / 1000;
  await db.batch([
    sql("INSERT INTO lesson_slots VALUES ('dec', 'other-month', '2026-12-01', '10:00', '11:00', ?, ?, 'enabled')").bind(start, start + 3600),
    sql("INSERT INTO student_reservations VALUES ('other-month-r', 'student', 'dec', 'confirmed', 'standard', 'standard', 0, NULL, 0), ('private-reservation', 'private-other', 'last', 'confirmed', 'standard', 'standard', 0, NULL, 0)"),
    sql("INSERT INTO slot_occupancies VALUES ('private-occupancy', 'last', 'student_reservation', 'private-reservation', 0, 'private-actor')"),
  ]);
  const state = (await read()).state;
  for (const value of ["private-other", "private-reservation", "private-occupancy", "private-actor", "other-month-r", "token_hash", "session_id"]) {
    expect(JSON.stringify(state)).not.toContain(value);
  }
  await expect(read("last")).rejects.toMatchObject({ code: "RESERVATION_NOT_AVAILABLE", message: "RESERVATION_NOT_AVAILABLE" });
  // An occupied target with corrupted management details is an integrity error,
  // including when its Reservation belongs to another Student.
  await sql("INSERT INTO admin_holds VALUES ('private-occupancy')").run();
  await expect(read("last")).rejects.toMatchObject(integrityError);
});

it.each(["admin", "group"])("[#863 BR-067] maps valid %s and rejects missing/wrong/both details", async (slot) => {
  const expected = slot === "admin" ? "admin_hold" : "group_lesson";
  expect((await read(slot)).state.slot.occupancies[0]).toEqual({ slotId: slot, type: expected, reservationId: null });
  await expect(preview(slot)).rejects.toMatchObject({ code: "RESERVATION_NOT_AVAILABLE" });
  const table = slot === "admin" ? "admin_holds" : "group_lessons";
  const other = slot === "admin" ? "group_lessons" : "admin_holds";
  await sql(`DELETE FROM ${table} WHERE occupancy_id = ?`).bind(`${slot}-o`).run();
  await expect(read(slot)).rejects.toMatchObject(integrityError);
  await sql(`INSERT INTO ${other} VALUES (?)`).bind(`${slot}-o`).run();
  await expect(read(slot)).rejects.toMatchObject(integrityError);
  await sql(`INSERT INTO ${table} VALUES (?)`).bind(`${slot}-o`).run();
  await expect(read(slot)).rejects.toMatchObject(integrityError);
});

it.each([
  "DELETE FROM slot_occupancies WHERE id = 'later-o'",
  "INSERT INTO student_reservations VALUES ('extra', 'student', 'later', 'confirmed', 'standard', 'standard', 0, NULL, 0)",
  "UPDATE student_reservations SET status = 'student_cancelled', cancelled_at = 1, classification = NULL WHERE id = 'later-r'",
  "INSERT INTO group_lessons VALUES ('later-o')",
  "INSERT INTO student_reservations VALUES ('extra', 'student', 'target', 'confirmed', 'standard', 'standard', 0, NULL, 0)",
  "UPDATE student_reservations SET classification = NULL WHERE id = 'later-r'",
  "INSERT INTO reservation_absences VALUES ('later-r', 0, 'actor')",
  "UPDATE lesson_slots SET lesson_date = '2026-12-22' WHERE id = 'later'",
  "UPDATE lesson_slots SET starts_at = starts_at + 0.5 WHERE id = 'later'",
  "UPDATE student_reservations SET cancelled_at = 'invalid', status = 'school_cancelled', classification = NULL WHERE id = 'past-r'",
  "INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 0.5, 0, 'actor')",
  "DELETE FROM student_security_access WHERE student_id = 'student'",
])("[#863 persisted integrity] rejects anomaly: %s", async (query) => {
  await sql(query).run();
  await expect(read()).rejects.toMatchObject(integrityError);
});

it.each(["missing reference", "wrong Slot", "orphan own"])("[#863 corrupt read fixture] fails closed on %s with FK enabled", async (mode) => {
  const replacement = mode === "missing reference" ? "(SELECT * FROM student_reservations WHERE id <> 'later-r')"
    : mode === "wrong Slot" ? "(SELECT *, 'target' AS altered_slot FROM student_reservations)"
    : "(SELECT * FROM lesson_slots WHERE id <> 'later')";
  const transform = (query: string) => mode === "wrong Slot"
    ? query.replaceAll("r.lesson_slot_id", "r.altered_slot").replaceAll(/(?<=FROM |JOIN )student_reservations AS r/g, replacement + " AS r")
    : mode === "orphan own" ? query.replaceAll(/(?<=FROM |JOIN )lesson_slots/g, replacement)
    : query.replaceAll(/(?<=FROM |JOIN )student_reservations/g, replacement);
  await expect(repository(now, transform).readPreview(identity, mode === "missing reference" ? "later" : "target")).rejects.toMatchObject(integrityError);
  expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("[#863 read rejection] distinguishes absence, unpublished, disabled and denied current access", async () => {
  await expect(read("missing")).rejects.toMatchObject({ code: "RESERVATION_NOT_AVAILABLE" });
  await sql("UPDATE schedule_months SET published_at = NULL WHERE id = 'month'").run();
  expect((await read()).state.publishedAt).toBeNull();
  await expect(preview()).rejects.toMatchObject({ code: "RESERVATION_NOT_AVAILABLE" });
  await sql("UPDATE schedule_months SET published_at = 0 WHERE id = 'month'").run();
  await sql("UPDATE lesson_slots SET availability_status = 'disabled' WHERE id = 'target'").run();
  await expect(preview()).rejects.toMatchObject({ code: "RESERVATION_NOT_AVAILABLE" });
  await sql("UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'").run();
  expect((await read()).state.reservationOperationAllowed).toBe(false);
});

it("[#863 DB error] abstracts actual SQL failure", async () => {
  const failed = repository(now, (query) => query.replace("student_session_access_v1", "missing_source"));
  await expect(failed.readPreview(identity, "target")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
});

it("[#863 absence integrity] rejects a record timestamp before lesson end", async () => {
  await sql("INSERT INTO reservation_absences VALUES ('past-r', 0, 'actor')").run();
  await sql("UPDATE student_reservations SET classification = NULL WHERE id = 'past-r'").run();
  await expect(read()).rejects.toMatchObject(integrityError);
});
