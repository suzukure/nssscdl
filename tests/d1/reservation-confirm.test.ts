import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import { ReservationPreviewService } from "../../src/application/reservation-preview";
import { D1ReservationPreviewRepository, reservationCaptureSql } from "../../src/infrastructure/d1-reservation-preview";
import { db, identity, now, repository, seedPreviewFixture, sql } from "./reservation-preview-fixture";

beforeAll(async () => { await seedPreviewFixture("confirm-file"); });
beforeEach(async () => {
  await db.batch([
    sql("DELETE FROM reservation_absences"), sql("DELETE FROM reservation_monthly_count_overrides"),
    sql("DELETE FROM reservation_classification_overrides"), sql("DELETE FROM student_monthly_lesson_configs"),
    sql("DELETE FROM admin_holds WHERE occupancy_id = 'target-o'"),
    sql("DELETE FROM slot_occupancies WHERE id NOT IN ('past-o', 'later-o', 'admin-o', 'group-o')"),
    sql("DELETE FROM student_reservations WHERE id NOT IN ('past-r', 'later-r')"),
    sql("UPDATE student_reservations SET status = 'confirmed', cancelled_at = NULL, automatic_classification = 'standard', classification = 'standard'"),
    sql("INSERT INTO slot_occupancies SELECT 'later-o', 'later', 'student_reservation', 'later-r', 0, 'confirm-file' WHERE NOT EXISTS (SELECT 1 FROM slot_occupancies WHERE id = 'later-o')"),
    sql("UPDATE schedule_months SET published_at = 0"),
    sql("UPDATE lesson_slots SET availability_status = 'enabled'"),
    sql("UPDATE student_security_access SET access_state = 'active'"),
  ]);
});

const preview = (repo = repository()) => new ReservationPreviewService(repo).execute("target", identity);
const prepare = (token: string, repo = repository()) =>
  new ReservationConfirmPreparationService(repo).prepare("target", token, identity);

// All preparation SELECTs are executed using a read-only interface. Captured
// table bytes before/after distinguish fixture writes from preparation effects.
async function persisted() {
  const tables = ["command_guards", "student_reservations", "slot_occupancies",
    "business_audit_logs", "notification_intents", "notification_outbox"];
  const existing = (await sql("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results;
  return Promise.all(tables.map(async (table) => existing.some((row) => row.name === table)
    ? (await sql(`SELECT * FROM ${table} ORDER BY rowid`).all()).results : null));
}

describe("[TC-F-003-01 / TC-F-003-02] isolated D1/Confirm preparation partial evidence", () => {
  it("accepts the Preview-issued token via shared capture, with immutable server-only state and no writes", async () => {
    const token = (await preview()).expectedStateToken;
    const before = await persisted();
    const prepared = await prepare(token);
    expect(prepared).toMatchObject({ studentId: "student", slotId: "target", evaluatedAt: now,
      automaticClassification: "standard", classification: "standard", classificationChanges: [],
      classificationPlan: [{ reservationId: "later-r", automaticBefore: "standard", automaticAfter: "standard" }] });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(await persisted()).toEqual(before);
    expect(Object.keys(await repository().readPreview(identity, "target"))).toEqual(["state", "evaluatedAt"]);
    expect(Object.keys(await preview())).toEqual(["slot", "previewClassification", "classificationChanges", "expectedStateToken"]);
    expect(prepared).not.toHaveProperty("canonicalSnapshot");
  });
  it("pins raw JSON field order, null/missing distinction, stable reservations and boundary-only time", async () => {
    await sql("INSERT INTO student_reservations VALUES ('z-history', 'student', 'later', 'school_cancelled', 'standard', NULL, 0, 1, 1), ('a-history', 'student', 'later', 'student_cancelled', 'standard', NULL, 0, 1, 1)").run();
    const missing = await repository().readConfirm(identity, "target");
    const raw = JSON.parse(missing.canonicalRawReadSet);
    expect(Object.keys(raw)).toEqual(["studentId", "access", "target", "standardCountConfig", "reservations", "occupancies", "foreignOccupied", "badFuture"]);
    expect(raw.standardCountConfig).toEqual([]);
    expect(raw.reservations.map((row: { reservationId: string }) => row.reservationId))
      .toEqual(["past-r", "a-history", "later-r", "z-history"]);
    expect(raw.reservations[1]).toMatchObject({ classification: null, countPresent: 0, overridePresent: 0, beforeStart: 1 });
    expect(raw.target.beforeStart).toBe(1);
    expect(raw.reservations[0].beforeStart).toBe(0);
    expect((await repository(now + 1).readConfirm(identity, "target")).canonicalRawReadSet).toBe(missing.canonicalRawReadSet);
    expect((await repository().readConfirm(identity, "target")).canonicalRawReadSet).toBe(missing.canonicalRawReadSet);
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 3, 0, 'actor')").run();
    const explicit = await repository().readConfirm(identity, "target");
    expect(explicit.canonicalRawReadSet).not.toBe(missing.canonicalRawReadSet);
    expect(JSON.parse(explicit.canonicalRawReadSet).standardCountConfig).toEqual([{ standardCount: 3, updatedAt: 0 }]);
    const changedBoundary = await repository(explicit.state.slot.startsAt).readConfirm(identity, "target");
    expect(JSON.parse(changedBoundary.canonicalRawReadSet).target.beforeStart).toBe(0);
    expect(changedBoundary.canonicalRawReadSet).not.toBe(explicit.canonicalRawReadSet);
    const ownBoundary = await repository(explicit.state.reservations[2].startsAt).readConfirm(identity, "target");
    expect(JSON.parse(ownBoundary.canonicalRawReadSet).reservations[2].beforeStart).toBe(0);
  });
  it("reuses the same SQL template and bind order when server-owned T replaces D1 now", async () => {
    const captured = await repository().readConfirm(identity, "target");
    const guardTimeTemplate = reservationCaptureSql(String(now));
    expect(guardTimeTemplate).toBe(reservationCaptureSql().replace("CAST(strftime('%s','now') AS INTEGER)", String(now)));
    expect(await sql(`SELECT canonical_raw_read_set FROM (${guardTimeTemplate})`).bind("student", "target")
      .first<string>("canonical_raw_read_set")).toBe(captured.canonicalRawReadSet);
  });
  it("retains an automatic-only Override change while Preview wire changes remain empty", async () => {
    await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 2, 0, 'actor')").run();
    await sql("INSERT INTO reservation_classification_overrides VALUES ('later-r', 'standard', 0, 'actor')").run();
    const view = await preview();
    expect(view.classificationChanges).toEqual([]);
    expect((await prepare(view.expectedStateToken)).classificationPlan).toEqual([{
      reservationId: "later-r", startsAt: "2026-11-22T10:00:00+09:00",
      automaticBefore: "standard", automaticAfter: "additional", before: "standard", after: "standard",
    }]);
  });
  it.each([
    ["publication", ["UPDATE schedule_months SET published_at = 1 WHERE id = 'month'"], "RESERVATION_STATE_CHANGED"],
    ["unpublished", ["UPDATE schedule_months SET published_at = NULL WHERE id = 'month'"], "RESERVATION_NOT_AVAILABLE"],
    ["availability", ["UPDATE lesson_slots SET availability_status = 'disabled' WHERE id = 'target'"], "RESERVATION_NOT_AVAILABLE"],
    ["operation", ["UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"], "RESERVATION_NOT_AVAILABLE"],
    ["occupancy", ["INSERT INTO slot_occupancies VALUES ('target-o', 'target', 'admin_hold', NULL, 0, 'actor')", "INSERT INTO admin_holds VALUES ('target-o')"], "RESERVATION_NOT_AVAILABLE"],
    ["N", ["INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 0, 0, 'actor')"], "RESERVATION_STATE_CHANGED"],
    ["absence", [`INSERT INTO reservation_absences VALUES ('past-r', ${now}, 'actor')`, "UPDATE student_reservations SET classification = NULL WHERE id = 'past-r'"], "RESERVATION_STATE_CHANGED"],
    ["count override", ["INSERT INTO reservation_monthly_count_overrides VALUES ('later-r', 'excluded', 0, 'actor')", "UPDATE student_reservations SET classification = NULL WHERE id = 'later-r'"], "RESERVATION_STATE_CHANGED"],
    ["classification override", ["INSERT INTO reservation_classification_overrides VALUES ('later-r', 'additional', 0, 'actor')", "UPDATE student_reservations SET classification = 'additional' WHERE id = 'later-r'"], "RESERVATION_STATE_CHANGED"],
    ["added reservation", ["INSERT INTO student_reservations VALUES ('new-r', 'student', 'last', 'confirmed', 'additional', 'additional', 0, NULL, 0)", "INSERT INTO slot_occupancies VALUES ('new-o', 'last', 'student_reservation', 'new-r', 0, 'actor')"], "RESERVATION_STATE_CHANGED"],
    ["cancelled reservation", ["DELETE FROM slot_occupancies WHERE id = 'later-o'", "UPDATE student_reservations SET status = 'student_cancelled', cancelled_at = 1, classification = NULL WHERE id = 'later-r'"], "RESERVATION_STATE_CHANGED"],
    ["classification", ["UPDATE student_reservations SET automatic_classification = 'additional', classification = 'additional' WHERE id = 'later-r'"], "RESERVATION_STATE_CHANGED"],
    ["integrity", ["UPDATE student_reservations SET classification = NULL WHERE id = 'later-r'"], "INTEGRITY_STATE_UNAVAILABLE"],
  ] as const)("rejects latest %s safely without writes", async (_mode, changes, code) => {
    const token = (await preview()).expectedStateToken;
    await db.batch(changes.map(sql));
    const before = await persisted();
    await expect(prepare(token)).rejects.toMatchObject({ code, message: code });
    expect(await persisted()).toEqual(before);
  });
  it("does not write on malformed or fingerprint mismatch", async () => {
    const before = await persisted();
    await expect(prepare("v2.invalid")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(prepare("v1." + "A".repeat(43))).rejects.toMatchObject({ code: "RESERVATION_STATE_CHANGED" });
    expect(await persisted()).toEqual(before);
  });
  it("rejects the target start boundary and D1 failure without writes or diagnostic exposure", async () => {
    const token = (await preview()).expectedStateToken;
    const start = (await repository().readPreview(identity, "target")).state.slot.startsAt;
    const before = await persisted();
    await expect(prepare(token, repository(start))).rejects.toMatchObject({ code: "RESERVATION_WINDOW_CLOSED" });
    await expect(prepare(token, repository(now, (query) => query.replace("student_session_access_v1", "missing_source"))))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
    expect(await persisted()).toEqual(before);
  });
  it("captures real Primary D1 T0 for preparation independently of Worker clock", async () => {
    const real = new D1ReservationPreviewRepository(db);
    const token = (await preview(real)).expectedStateToken;
    const before = await sql("SELECT CAST(strftime('%s','now') AS INTEGER) AS t").first<number>("t");
    const spy = vi.spyOn(Date, "now").mockReturnValue(0);
    let prepared;
    try { prepared = await prepare(token, real); } finally { spy.mockRestore(); }
    const after = await sql("SELECT CAST(strftime('%s','now') AS INTEGER) AS t").first<number>("t");
    expect(prepared.evaluatedAt).toBeGreaterThanOrEqual(before!);
    expect(prepared.evaluatedAt).toBeLessThanOrEqual(after!);
  });
});
