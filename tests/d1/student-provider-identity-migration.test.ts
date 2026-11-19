import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";

// #1173: DDL partial evidence only. No Provider flow, Session issuance or
// registration-mode decision is implemented by this migration.
const db = env.AUTH_DB;
const sql = (query: string) => db.prepare(query);
const schema = () => sql("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name").all();
const snapshot = async () => {
  const rows = (await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name").all<{ name: string }>()).results;
  return Promise.all(rows.map(async ({ name }) => ({
    name, rows: (await sql(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results,
  })));
};
const integrity = async () => {
  for (const query of ["PRAGMA foreign_key_check", env.AUTH_INTEGRITY_SQL, ...env.RESERVATION_INTEGRITY_SCANS]) {
    expect((await sql(query).all()).results).toEqual([]);
  }
};
const newTables = ["student_contacts", "student_google_bindings", "student_registration_settings"];

beforeAll(async () => {
  expect([...env.AUTH_MIGRATIONS, ...env.RESERVATION_MIGRATIONS, ...env.PROVIDER_MIGRATIONS].map((m: { name: string }) => m.name))
    .toHaveLength(13);
  expect(env.PROVIDER_MIGRATIONS.map((m: { name: string }) => m.name))
    .toEqual(["0013_student_provider_identity.sql"]);
  await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
  // Valid populated upgrade, including reservation history. No real identity.
  const start = Date.parse("2099-11-15T10:00:00+09:00") / 1000;
  await db.batch([
    sql("INSERT INTO students VALUES ('student','active',NULL), ('other','active',NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student','active',0), ('other','active',0)"),
    sql("INSERT INTO student_accounts VALUES ('account','student','student'), ('other-account','other','student')"),
    sql("INSERT INTO student_sessions VALUES ('session','account','student',?,1,86401,NULL)").bind("a".repeat(64)),
    sql("INSERT INTO schedule_months VALUES ('month','2099-11',0,0,0)"),
    sql("INSERT INTO lesson_slots VALUES ('slot','month','2099-11-15','10:00','11:00',?,?,'enabled')").bind(start, start + 3600),
    sql("INSERT INTO student_reservations VALUES ('reservation','student','slot','student_cancelled','standard',NULL,0,1,1)"),
  ]);
  await integrity();
  const oldObjects = (await schema()).results;
  const oldRows = await snapshot();
  const oldView = (await sql("SELECT * FROM student_session_access_v1 ORDER BY session_id").all()).results;
  expect(oldView).toHaveLength(1);
  expect(oldObjects.every((row) => !newTables.includes(String(row.name)))).toBe(true);
  await applyD1Migrations(db, env.PROVIDER_MIGRATIONS);
  const objects = (await schema()).results;
  expect(objects.filter((o) => !newTables.includes(String(o.tbl_name)))).toEqual(oldObjects);
  expect((await snapshot()).filter((o) => !newTables.includes(o.name))).toEqual(oldRows);
  expect((await sql("SELECT * FROM student_session_access_v1 ORDER BY session_id").all()).results).toEqual(oldView);
  for (const table of newTables) expect((await sql(`SELECT * FROM ${table}`).all()).results).toEqual([]);
  await integrity();
});

beforeEach(async () => {
  // Only the new tables are reset. Existing upgrade rows are unchanged.
  for (const table of newTables) await sql(`DELETE FROM ${table}`).run();
});

it("[#1173 DB partial] exact columns, primary keys, foreign keys and account index", async () => {
  const columns = async (table: string) => (await sql(`PRAGMA table_info('${table}')`)
    .all<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>()).results
    .map((r) => [r.name, r.type, r.notnull, r.pk, r.dflt_value]);
  expect(await columns("student_contacts")).toEqual([
    ["student_id", "TEXT", 1, 1, null], ["name", "TEXT", 1, 0, null],
    ["email", "TEXT", 1, 0, null], ["email_key", "TEXT", 1, 0, null],
    ["verified_at", "INTEGER", 1, 0, null],
  ]);
  expect(await columns("student_google_bindings")).toEqual([
    ["account_id", "TEXT", 1, 0, null], ["issuer", "TEXT", 1, 1, null], ["subject", "TEXT", 1, 2, null],
  ]);
  expect(await columns("student_registration_settings")).toEqual([
    ["id", "INTEGER", 0, 1, null], ["mode", "TEXT", 1, 0, null],
  ]);
  for (const [table, parent, column] of [
    ["student_contacts", "students", "student_id"],
    ["student_google_bindings", "student_accounts", "account_id"],
  ]) {
    const rows = (await sql(`PRAGMA foreign_key_list('${table}')`).all<{ table: string; from: string; to: string; on_delete: string; on_update: string }>()).results;
    expect(rows.map((r) => [r.table, r.from, r.to, r.on_delete, r.on_update]))
      .toEqual([[parent, column, "id", "NO ACTION", "NO ACTION"]]);
  }
  const index = (await sql("PRAGMA index_info('ix_google_bindings_account')").all<{ name: string }>()).results;
  expect(index.map((r) => r.name)).toEqual(["account_id"]);
  expect((await sql("PRAGMA index_list('student_google_bindings')").all()).results)
    .toContainEqual(expect.objectContaining({ name: "ix_google_bindings_account", unique: 0 }));
});

const contact = "INSERT INTO student_contacts VALUES ('student','Fixture','fixture@example.test','fixture@example.test',1)";
const binding = "INSERT INTO student_google_bindings VALUES ('account','https://issuer.example.test','subject')";

it("[TC-F-202-01 / TC-F-205-01/02 partial DB] distinct verified contacts and stable identity bindings", async () => {
  await db.batch([
    sql(contact), sql("INSERT INTO student_contacts VALUES ('other','Other','other@example.test','other@example.test',2)"),
    sql(binding),
    sql("INSERT INTO student_google_bindings VALUES ('account','https://issuer.example.test','subject-2')"),
    sql("INSERT INTO student_google_bindings VALUES ('other-account','https://other-issuer.example.test','subject')"),
  ]);
  expect((await sql("SELECT student_id,email_key FROM student_contacts ORDER BY student_id").all()).results).toEqual([
    { student_id: "other", email_key: "other@example.test" }, { student_id: "student", email_key: "fixture@example.test" },
  ]);
  expect(await sql("SELECT COUNT(*) AS n FROM student_google_bindings WHERE account_id='account'").first("n")).toBe(2);
  await integrity();
});

it.each([
  ["INSERT INTO student_contacts VALUES ('other','Other','other@example.test','fixture@example.test',2)", /UNIQUE/],
  ["INSERT INTO student_contacts VALUES ('student','Second','other@example.test','other@example.test',2)", /UNIQUE/],
  ["INSERT INTO student_contacts VALUES ('missing','Fixture','missing@example.test','missing@example.test',1)", /FOREIGN KEY/],
  ["INSERT INTO student_google_bindings VALUES ('other-account','https://issuer.example.test','subject')", /UNIQUE/],
  ["INSERT INTO student_google_bindings VALUES ('missing','https://issuer.example.test','missing-subject')", /FOREIGN KEY/],
  ["INSERT INTO student_contacts VALUES (NULL,'Name','a@example.test','a@example.test',1)", /NOT NULL/],
  ["INSERT INTO student_contacts VALUES ('other',NULL,'a@example.test','a@example.test',1)", /NOT NULL/],
  ["INSERT INTO student_contacts VALUES ('other','Name',NULL,'a@example.test',1)", /NOT NULL/],
  ["INSERT INTO student_contacts VALUES ('other','Name','a@example.test',NULL,1)", /NOT NULL/],
  ["INSERT INTO student_contacts VALUES ('other','Name','a@example.test','a@example.test',NULL)", /NOT NULL/],
  ["INSERT INTO student_google_bindings VALUES (NULL,'issuer','other-subject')", /NOT NULL/],
  ["INSERT INTO student_google_bindings VALUES ('other-account',NULL,'other-subject')", /NOT NULL/],
  ["INSERT INTO student_google_bindings VALUES ('other-account','issuer',NULL)", /NOT NULL/],
])("[TC-F-205-01/02 / TC-F-202-02 partial DB] rejects invalid identity rows: %s", async (statement, error) => {
  await db.batch([sql(contact), sql(binding)]);
  await expect(sql(statement).run()).rejects.toThrow(error);
  expect(await sql("SELECT COUNT(*) AS n FROM student_contacts").first("n")).toBe(1);
  expect(await sql("SELECT COUNT(*) AS n FROM student_google_bindings").first("n")).toBe(1);
  await integrity();
});

it.each(["open", "invitation_only"])("[TC-F-201-01 / TC-F-319-01 partial DB] explicit singleton mode %s", async (mode) => {
  await sql("INSERT INTO student_registration_settings VALUES (1,?)").bind(mode).run();
  expect(await sql("SELECT * FROM student_registration_settings").first()).toEqual({ id: 1, mode });
  await expect(sql("INSERT INTO student_registration_settings VALUES (1,'open')").run()).rejects.toThrow(/UNIQUE/);
  expect(await sql("SELECT * FROM student_registration_settings").first()).toEqual({ id: 1, mode });
  await integrity();
});

it.each([["INSERT INTO student_registration_settings VALUES (2,'open')", /CHECK/],
  ["INSERT INTO student_registration_settings VALUES (1,'unknown')", /CHECK/],
  ["INSERT INTO student_registration_settings VALUES (1,NULL)", /NOT NULL/],
])("[TC-F-201-01 partial DB] rejects invalid registration setting: %s", async (statement, error) => {
  await expect(sql(statement).run()).rejects.toThrow(error);
  expect((await sql("SELECT * FROM student_registration_settings").all()).results).toEqual([]);
});
