import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";

// #867: DB/migration partial evidence; no Confirm, HTTP, real D1 or TC-wide Pass.
// AUTH_DB uses existing per-file isolation; never load reservation fixture DDL.
const db = env.AUTH_DB;
const sql = (query: string) => db.prepare(query);
const tablesByVersion = [
  ["schedule_months", "lesson_slots"],
  ["student_monthly_lesson_configs", "student_reservations", "reservation_absences",
    "reservation_monthly_count_overrides", "reservation_classification_overrides"],
  ["slot_occupancies"], ["admin_holds", "group_lessons"],
  ["business_audit_logs", "notification_intents", "notification_outbox"],
];
const indexes: Record<string, string[]> = {
  ix_slots_month_start: ["schedule_month_id", "starts_at", "id"],
  ix_reservations_student_slot: ["student_id", "lesson_slot_id"],
  ix_reservations_slot: ["lesson_slot_id"], ix_audit_retention: ["occurred_at"],
  ix_outbox_due: ["due_at", "intent_id"],
  ix_intents_student: ["recipient_student_id", "occurred_at"],
  ux_single_confirmation: ["reservation_id"],
};
const schema = () => sql("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name")
  .all<{ type: string; name: string; tbl_name: string; sql: string }>();

beforeAll(async () => {
  expect(env.AUTH_MIGRATIONS.map((m: { name: string }) => m.name.slice(0, 4)))
    .toEqual(["0001", "0002", "0003", "0004", "0005", "0006"]);
  expect(env.RESERVATION_MIGRATIONS.map((m: { name: string }) => m.name.slice(0, 4)))
    .toEqual(["0007", "0008", "0009", "0010", "0011", "0012"]);
  const authSchema = (await schema()).results;
  await sql("INSERT INTO command_guards VALUES ('existing', 1, 'unchanged', 1)").run();
  for (const [index, migration] of env.RESERVATION_MIGRATIONS.entries()) {
    await applyD1Migrations(db, [migration]);
    const objects = (await schema()).results;
    for (const table of tablesByVersion.slice(0, index + 1).flat()) {
      expect(objects.some((o) => o.type === "table" && o.name === table)).toBe(true);
    }
    for (const table of tablesByVersion.slice(index + 1).flat()) {
      expect(objects.some((o) => o.name === table)).toBe(false);
    }
    for (const name of Object.keys(indexes)) {
      expect(objects.some((o) => o.name === name)).toBe(index === 5);
    }
    for (const object of authSchema) expect(objects).toContainEqual(object);
  }
  expect(await sql("SELECT * FROM command_guards").first())
    .toEqual({ id: "existing", captured_at: 1, expected_read_set: "unchanged", ok: 1 });
  await sql("DELETE FROM command_guards WHERE id = 'existing'").run();
});

beforeEach(async () => {
  // Reset only this file's data, in FK order; migrations run once, above.
  for (const table of [...tablesByVersion.flat()].reverse()) await sql(`DELETE FROM ${table}`).run();
  await db.batch([
    sql("DELETE FROM student_security_access"), sql("DELETE FROM students"),
    sql("INSERT INTO students VALUES ('student', 'active', NULL), ('other', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 0), ('other', 'active', 0)"),
    sql("INSERT INTO schedule_months VALUES ('month', '2099-11', 0, 0, 0), ('past-month', '2000-11', 0, 0, 0)"),
  ]);
  for (const [id, date, month] of [
    ["slot", "2099-11-15", "month"], ["other-slot", "2099-11-16", "month"],
    ["admin", "2099-11-17", "month"], ["group", "2099-11-18", "month"],
    ["past", "2000-11-15", "past-month"],
  ]) {
    const start = Date.parse(`${date}T10:00:00+09:00`) / 1000;
    await sql("INSERT INTO lesson_slots VALUES (?, ?, ?, '10:00', '11:00', ?, ?, 'enabled')")
      .bind(id, month, date, start, start + 3600).run();
  }
  await db.batch([
    sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 3, 0, 'admin-actor')"),
    sql("INSERT INTO student_reservations VALUES ('reservation', 'student', 'slot', 'confirmed', 'standard', 'standard', 0, NULL, 0), ('past-r', 'student', 'past', 'confirmed', 'additional', NULL, 0, NULL, 0), ('cancelled', 'student', 'slot', 'student_cancelled', 'standard', NULL, 0, 1, 1)"),
    sql("INSERT INTO reservation_absences VALUES ('past-r', 1, 'admin-actor')"),
    sql("INSERT INTO slot_occupancies VALUES ('occupancy', 'slot', 'student_reservation', 'reservation', 0, 'student'), ('admin-o', 'admin', 'admin_hold', NULL, 0, 'admin-actor'), ('group-o', 'group', 'group_lesson', NULL, 0, 'admin-actor')"),
    sql("INSERT INTO admin_holds VALUES ('admin-o')"), sql("INSERT INTO group_lessons VALUES ('group-o')"),
    sql("INSERT INTO business_audit_logs VALUES ('audit', 0, 'confirm', 'student', 'student', 'student_reservation', 'reservation', NULL, '{}', 'committed')"),
    sql("INSERT INTO notification_intents VALUES ('intent', 'reservation_confirmation', 'student', 'reservation', 0, '{}', 'valid', NULL, NULL), ('change', 'classification_change', 'student', 'reservation', 0, '{}', 'expired', 1, 'student_deleted')"),
    sql("INSERT INTO notification_outbox VALUES ('intent', 0, NULL, NULL)"),
  ]);
});

async function integrity() {
  expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect((await sql(env.AUTH_INTEGRITY_SQL).all()).results).toEqual([]);
  return (await sql(env.RESERVATION_INTEGRITY_SQL).all()).results;
}

it("[#867 DB/migration partial evidence] preserves Production schema, indexes and healthy zero-row scans", async () => {
  for (const [name, columns] of Object.entries(indexes)) {
    expect((await sql(`PRAGMA index_info('${name}')`).all<{ name: string }>()).results.map((r) => r.name))
      .toEqual(columns);
  }
  expect(await sql("SELECT sql FROM sqlite_master WHERE name = 'ux_single_confirmation'").first("sql"))
    .toContain("WHERE kind = 'reservation_confirmation'");
  expect(await sql("SELECT json_valid('{}') AS valid").first("valid")).toBe(1);
  expect(await integrity()).toEqual([]);
  // Already picked up valid Intent: absent Outbox does not imply corruption.
  await sql("DELETE FROM notification_outbox").run();
  expect(await integrity()).toEqual([]);
});

it("[#867 DB/migration partial evidence] leaves expired pending work to the existing pickup validity Guard", async () => {
  await sql("UPDATE notification_intents SET obligation_state = 'expired', expired_at = 1, expiry_reason = 'student_deleted' WHERE id = 'intent'").run();
  expect(await integrity()).toEqual([]);
  expect(await sql("SELECT COUNT(*) AS n FROM notification_outbox").first("n")).toBe(1);
});

it.each([
  ["UPDATE schedule_months SET month_key = '2099-00' WHERE id = 'month'", "CHECK"],
  ["UPDATE schedule_months SET month_key = '2099-13' WHERE id = 'month'", "CHECK"],
  ["UPDATE schedule_months SET month_key = '2099-1' WHERE id = 'month'", "CHECK"],
  ["UPDATE schedule_months SET month_key = '2099-11x' WHERE id = 'month'", "CHECK"],
  ["UPDATE schedule_months SET month_key = 'xxxx-11' WHERE id = 'month'", "CHECK"],
  ["UPDATE lesson_slots SET ends_at = starts_at WHERE id = 'slot'", "CHECK"],
  ["UPDATE lesson_slots SET ends_at = starts_at - 1 WHERE id = 'slot'", "CHECK"],
  ["UPDATE lesson_slots SET availability_status = 'unknown'", "CHECK"],
  ["UPDATE lesson_slots SET schedule_month_id = 'missing' WHERE id = 'slot'", "FOREIGN KEY"],
  ["UPDATE lesson_slots SET lesson_date = '2099-11-15' WHERE id = 'other-slot'", "UNIQUE"],
  ["UPDATE student_monthly_lesson_configs SET standard_count = -1", "CHECK"],
  ["UPDATE student_monthly_lesson_configs SET student_id = 'missing'", "FOREIGN KEY"],
  ["UPDATE student_monthly_lesson_configs SET schedule_month_id = 'missing'", "FOREIGN KEY"],
  ["INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 0, 0, 'admin-actor')", "UNIQUE"],
  ["UPDATE student_reservations SET student_id = 'missing'", "FOREIGN KEY"],
  ["UPDATE student_reservations SET lesson_slot_id = 'missing' WHERE id = 'cancelled'", "FOREIGN KEY"],
  ["UPDATE student_reservations SET status = 'completed'", "CHECK"],
  ["UPDATE student_reservations SET automatic_classification = 'unknown'", "CHECK"],
  ["UPDATE student_reservations SET classification = 'not_applicable'", "CHECK"],
  ["UPDATE student_reservations SET cancelled_at = 1 WHERE id = 'reservation'", "CHECK"],
  ["UPDATE student_reservations SET cancelled_at = NULL WHERE id = 'cancelled'", "CHECK"],
  ["INSERT INTO reservation_absences VALUES ('missing', 0, 'admin-actor')", "FOREIGN KEY"],
  ["INSERT INTO reservation_absences VALUES ('past-r', 0, 'admin-actor')", "UNIQUE"],
  ["INSERT INTO reservation_monthly_count_overrides VALUES ('missing', 'excluded', 0, 'admin-actor')", "FOREIGN KEY"],
  ["INSERT INTO reservation_monthly_count_overrides VALUES ('reservation', 'included', 0, 'admin-actor')", "CHECK"],
  ["INSERT INTO reservation_classification_overrides VALUES ('missing', 'standard', 0, 'admin-actor')", "FOREIGN KEY"],
  ["INSERT INTO reservation_classification_overrides VALUES ('reservation', 'unknown', 0, 'admin-actor')", "CHECK"],
  ["INSERT INTO slot_occupancies VALUES ('duplicate', 'slot', 'admin_hold', NULL, 0, 'admin-actor')", "UNIQUE"],
  ["INSERT INTO slot_occupancies VALUES ('wrong-slot', 'other-slot', 'student_reservation', 'reservation', 0, 'student')", "UNIQUE"],
  ["UPDATE slot_occupancies SET slot_id = 'other-slot' WHERE id = 'occupancy'", "FOREIGN KEY"],
  ["UPDATE slot_occupancies SET reservation_id = NULL WHERE id = 'occupancy'", "CHECK"],
  ["UPDATE slot_occupancies SET reservation_id = 'reservation' WHERE id = 'admin-o'", "CHECK"],
  ["UPDATE slot_occupancies SET occupancy_type = 'unknown'", "CHECK"],
  ["INSERT INTO admin_holds VALUES ('missing')", "FOREIGN KEY"],
  ["INSERT INTO group_lessons VALUES ('missing')", "FOREIGN KEY"],
  ["INSERT INTO admin_holds VALUES ('admin-o')", "UNIQUE"],
  ["INSERT INTO group_lessons VALUES ('group-o')", "UNIQUE"],
  ["UPDATE business_audit_logs SET result = 'failed'", "CHECK"],
  ["UPDATE notification_intents SET kind = 'reminder'", "CHECK"],
  ["UPDATE notification_intents SET recipient_student_id = 'missing'", "FOREIGN KEY"],
  ["UPDATE notification_intents SET reservation_id = 'missing'", "FOREIGN KEY"],
  ["UPDATE notification_intents SET payload_json = '{'", "CHECK"],
  ["UPDATE notification_intents SET obligation_state = 'unknown'", "CHECK"],
  ["UPDATE notification_intents SET expired_at = 1 WHERE id = 'intent'", "CHECK"],
  ["UPDATE notification_intents SET expiry_reason = 'reason' WHERE id = 'intent'", "CHECK"],
  ["UPDATE notification_intents SET expired_at = NULL WHERE id = 'change'", "CHECK"],
  ["UPDATE notification_intents SET expiry_reason = NULL WHERE id = 'change'", "CHECK"],
  ["UPDATE notification_outbox SET intent_id = 'missing'", "FOREIGN KEY"],
  ["INSERT INTO notification_outbox VALUES ('intent', 0, NULL, NULL)", "UNIQUE"],
  ["UPDATE notification_outbox SET claim_token = 'claim'", "CHECK"],
  ["UPDATE notification_outbox SET claim_until = 1", "CHECK"],
  ["INSERT INTO notification_intents VALUES ('second', 'reservation_confirmation', 'student', 'reservation', 0, '{}', 'valid', NULL, NULL)", "UNIQUE"],
  ["INSERT INTO command_guards VALUES ('bad', 0, '', 0)", "CHECK"],
])("[#867 DB/migration partial evidence] rejects %s", async (query, error) => {
  await expect(sql(query).run()).rejects.toThrow(new RegExp(error));
  expect(await integrity()).toEqual([]);
});

it("[#867 DB/migration partial evidence] accepts zero N, cancelled history, overrides and paired leases", async () => {
  await db.batch([
    sql("UPDATE student_monthly_lesson_configs SET standard_count = 0"),
    sql("INSERT INTO student_reservations VALUES ('history', 'student', 'slot', 'school_cancelled', 'additional', NULL, 0, 1, 1), ('history2', 'student', 'slot', 'system_cancelled', 'standard', NULL, 0, 1, 1)"),
    sql("INSERT INTO reservation_monthly_count_overrides VALUES ('cancelled', 'excluded', 0, 'admin-actor')"),
    sql("INSERT INTO reservation_classification_overrides VALUES ('cancelled', 'additional', 0, 'admin-actor'), ('reservation', 'additional', 0, 'admin-actor')"),
    sql("UPDATE student_reservations SET classification = 'additional' WHERE id = 'reservation'"),
    sql("UPDATE notification_outbox SET claim_token = 'claim', claim_until = 1"),
    sql("INSERT INTO notification_intents VALUES ('change2', 'classification_change', 'student', 'reservation', 0, '{}', 'valid', NULL, NULL)"),
  ]);
  expect(await integrity()).toEqual([]);
  for (const table of ["reservation_monthly_count_overrides", "reservation_classification_overrides"]) {
    const extra = table === "reservation_monthly_count_overrides" ? "'excluded'" : "'additional'";
    await expect(sql(`INSERT INTO ${table} VALUES ('cancelled', ${extra}, 0, 'admin-actor')`).run())
      .rejects.toThrow(/UNIQUE/);
  }
});

it.each([
  ["UPDATE lesson_slots SET lesson_date = '2099-12-15' WHERE id = 'slot'", "slot_datetime", "slot"],
  ["UPDATE lesson_slots SET start_time = '09:00' WHERE id = 'slot'", "slot_datetime", "slot"],
  ["UPDATE lesson_slots SET ends_at = ends_at + 1 WHERE id = 'slot'", "slot_datetime", "slot"],
  ["DELETE FROM slot_occupancies WHERE id = 'occupancy'", "future_confirmed_occupancy", "reservation"],
  ["UPDATE slot_occupancies SET occupancy_type = 'admin_hold', reservation_id = NULL WHERE id = 'occupancy'", "future_confirmed_occupancy", "reservation"],
  ["DELETE FROM admin_holds", "occupancy_reference_or_detail", "admin-o"],
  ["DELETE FROM group_lessons", "occupancy_reference_or_detail", "group-o"],
  ["INSERT INTO admin_holds VALUES ('occupancy')", "occupancy_reference_or_detail", "occupancy"],
  ["INSERT INTO group_lessons VALUES ('occupancy')", "occupancy_reference_or_detail", "occupancy"],
  ["INSERT INTO group_lessons VALUES ('admin-o')", "occupancy_reference_or_detail", "admin-o"],
  ["INSERT INTO admin_holds VALUES ('group-o')", "occupancy_reference_or_detail", "group-o"],
  ["UPDATE slot_occupancies SET occupancy_type = 'group_lesson' WHERE id = 'admin-o'", "occupancy_reference_or_detail", "admin-o"],
  ["UPDATE slot_occupancies SET occupancy_type = 'admin_hold' WHERE id = 'group-o'", "occupancy_reference_or_detail", "group-o"],
  ["UPDATE slot_occupancies SET reservation_id = 'cancelled' WHERE id = 'occupancy'", "occupancy_reference_or_detail", "occupancy"],
  ["UPDATE student_reservations SET classification = 'standard' WHERE id = 'cancelled'", "reservation_classification_or_absence", "cancelled"],
  ["UPDATE student_reservations SET classification = NULL WHERE id = 'reservation'", "reservation_classification_or_absence", "reservation"],
  ["INSERT INTO reservation_absences VALUES ('cancelled', 0, 'admin-actor')", "reservation_classification_or_absence", "cancelled"],
  ["INSERT INTO reservation_absences VALUES ('reservation', 0, 'admin-actor')", "reservation_classification_or_absence", "reservation"],
  ["INSERT INTO reservation_monthly_count_overrides VALUES ('reservation', 'excluded', 0, 'admin-actor')", "reservation_classification_or_absence", "reservation"],
  ["INSERT INTO reservation_classification_overrides VALUES ('reservation', 'additional', 0, 'admin-actor')", "reservation_classification_or_absence", "reservation"],
  ["INSERT INTO student_reservations VALUES ('duplicate-r', 'other', 'slot', 'confirmed', 'standard', 'standard', 0, NULL, 0)", "duplicate_future_confirmed", "slot"],
  ["UPDATE notification_intents SET recipient_student_id = 'other' WHERE id = 'intent'", "intent_recipient", "intent"],
])("[#867 integrity partial evidence] detects without repair: %s", async (query, violation, entityId) => {
  await sql(query).run();
  const snapshot = async () => Promise.all(tablesByVersion.flat().map(async (table) =>
    (await sql(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  const before = await snapshot();
  expect(await integrity()).toContainEqual({ violation, entity_id: entityId });
  expect(await snapshot()).toEqual(before);
});

it.each([
  ["UPDATE notification_intents SET expiry_reason = 'invalid' WHERE id = 'intent'", "intent_state"],
  ["UPDATE notification_outbox SET claim_token = 'invalid'", "outbox_reference_or_claim"],
])("[#867 integrity partial evidence] detects persisted CHECK corruption without repairing: %s", async (query, violation) => {
  // Isolated corruption fixture for an existing CHECK, not an Application option.
  await sql("PRAGMA ignore_check_constraints = ON").run();
  try { await sql(query).run(); }
  finally { await sql("PRAGMA ignore_check_constraints = OFF").run(); }
  const before = await sql("SELECT * FROM notification_intents ORDER BY id").all();
  const outbox = await sql("SELECT * FROM notification_outbox").all();
  expect(await integrity()).toContainEqual({ violation, entity_id: "intent" });
  expect((await sql("SELECT * FROM notification_intents ORDER BY id").all()).results).toEqual(before.results);
  expect((await sql("SELECT * FROM notification_outbox").all()).results).toEqual(outbox.results);
});

it("[#867 integrity partial evidence] requires occupancy strictly before the start, not at/after it", async () => {
  await sql("DELETE FROM slot_occupancies WHERE id = 'occupancy'").run();
  const start = await sql("SELECT starts_at FROM lesson_slots WHERE id = 'slot'").first<number>("starts_at");
  for (const delta of [-1, 0, 1]) {
    const scan = env.RESERVATION_INTEGRITY_SQL.replace("CAST(strftime('%s','now') AS INTEGER)", String(start! + delta));
    const rows = (await sql(scan).all()).results;
    expect(rows).toEqual(delta < 0 ? [{ violation: "future_confirmed_occupancy", entity_id: "reservation" }] : []);
  }
});

it("[#867 integrity partial evidence] detects duplicate current occupancy in an isolated damaged-schema fixture", async () => {
  // Remove only UNIQUE constraints in this fixture to model persisted corruption.
  // Keep FKs enforced; never change the Production migration or Application path.
  const definition = await sql("SELECT sql FROM sqlite_master WHERE name = 'slot_occupancies'").first<string>("sql");
  await db.batch([
    sql("DROP TABLE admin_holds"), sql("DROP TABLE group_lessons"), sql("DROP TABLE slot_occupancies"),
    sql(definition!.replace("NOT NULL UNIQUE REFERENCES", "NOT NULL REFERENCES").replace("reservation_id TEXT UNIQUE", "reservation_id TEXT")),
    sql("CREATE TABLE admin_holds (occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id))"),
    sql("CREATE TABLE group_lessons (occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id))"),
    sql("INSERT INTO slot_occupancies VALUES ('one', 'slot', 'student_reservation', 'reservation', 0, 'student'), ('two', 'slot', 'student_reservation', 'reservation', 0, 'student')"),
  ]);
  const before = (await sql("SELECT * FROM slot_occupancies ORDER BY id").all()).results;
  const rows = await integrity();
  expect(rows).toContainEqual({ violation: "duplicate_current_occupancy", entity_id: "slot" });
  expect(rows).toContainEqual({ violation: "duplicate_reservation_occupancy", entity_id: "reservation" });
  expect((await sql("SELECT * FROM slot_occupancies ORDER BY id").all()).results).toEqual(before);
  // Restore the fixture schema for subsequent tests, without replaying a migration.
  await db.batch([sql("DROP TABLE admin_holds"), sql("DROP TABLE group_lessons"), sql("DROP TABLE slot_occupancies"),
    sql(definition!), sql("CREATE TABLE admin_holds (occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id))"),
    sql("CREATE TABLE group_lessons (occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id))")]);
});

it("[#867 integrity partial evidence] rejects missing or weakened shared guard schema without replacing it", async () => {
  // Deliberately corrupt only this isolated test database, never migration bytes.
  const definition = await sql("SELECT sql FROM sqlite_master WHERE name = 'command_guards'").first<string>("sql");
  await sql("DROP TABLE command_guards").run();
  expect(await integrity()).toContainEqual({ violation: "command_guards_definition", entity_id: "command_guards" });
  await sql("CREATE TABLE command_guards (id TEXT PRIMARY KEY, captured_at INTEGER NOT NULL, expected_read_set TEXT NOT NULL, ok INTEGER NOT NULL)").run();
  expect(await integrity()).toContainEqual({ violation: "command_guards_definition", entity_id: "command_guards" });
  expect(await sql("SELECT sql FROM sqlite_master WHERE name = 'command_guards'").first("sql"))
    .not.toContain("CHECK");
  await db.batch([sql("DROP TABLE command_guards"), sql(definition!)]);
});
