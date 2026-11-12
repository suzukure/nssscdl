import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { seedTrustedStudents, checkTrustedSeedIntegrity } from "../fixtures/d1/trusted-student-seed";

// Independent file: no populated seed and no generic reset machinery.
const db = env.AUTH_DB;
const validation = { authSql: env.AUTH_INTEGRITY_SQL, reservationScans: env.RESERVATION_INTEGRITY_SCANS };
const sql = (query: string) => db.prepare(query);
const count = async () => {
  const tables = (await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA')")
    .all<{ name: string }>()).results;
  return Promise.all(tables.map(async ({ name }) => sql(`SELECT COUNT(*) AS n FROM ${name}`).first<number>("n")));
};
beforeAll(async () => { await applyD1Migrations(db, env.RESERVATION_MIGRATIONS); });

it.each(["student_session_identity_is_immutable", "ix_slots_month_start"])(
  "[#898 seed fail-closed] missing/changed schema object %s is rejected before writing", async (name) => {
    const object = await sql("SELECT type, sql FROM sqlite_master WHERE name=?").bind(name).first<{ type: string; sql: string }>();
    await sql(`DROP ${object!.type} ${name}`).run();
    try {
      // Matching name with weakened definition must also be rejected.
      await sql(object!.type === "trigger"
        ? `CREATE TRIGGER ${name} BEFORE UPDATE ON student_sessions BEGIN SELECT 1; END`
        : `CREATE INDEX ${name} ON lesson_slots(id)`).run();
      await expect(seedTrustedStudents(db, validation)).rejects.toThrow("TRUSTED_LOCAL_SEED_FAILED");
      expect((await count()).every((n) => n === 0)).toBe(true);
    } finally {
      await sql(`DROP ${object!.type} ${name}`).run();
      await sql(object!.sql).run();
    }
    await checkTrustedSeedIntegrity(db, validation);
  },
);

it("[#898 seed fail-closed] unknown table is rejected, not reset or silently ignored", async () => {
  await sql("CREATE TABLE unknown_seed_state (id TEXT)").run();
  try {
    await expect(seedTrustedStudents(db, validation)).rejects.toThrow("TRUSTED_LOCAL_SEED_FAILED");
    expect(await sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='unknown_seed_state'").first("n")).toBe(1);
    expect((await count()).every((n) => n === 0)).toBe(true);
  } finally { await sql("DROP TABLE unknown_seed_state").run(); }
});

it("[#898 seed fail-closed] absent reservation migrations cannot be mistaken for the full Production schema", async () => {
  // Existing test-only AUTH_DB API wrapper, exposing an incomplete schema read.
  const missing = { prepare(query: string) { return db.prepare(query.startsWith("SELECT type, name, tbl_name, sql")
    ? query.replace("ORDER BY name", "AND name <> 'group_lessons' ORDER BY name") : query); },
  batch: db.batch.bind(db) };
  await expect(seedTrustedStudents(missing, validation)).rejects.toThrow("TRUSTED_LOCAL_SEED_FAILED");
  expect((await count()).every((n) => n === 0)).toBe(true);
});

it("[TC-NF-914-04 partial local D1 / #898] batch rollback and safe error omit raw SQL/cause without retry", async () => {
  let calls = 0;
  const failed = { prepare: db.prepare.bind(db), batch(statements: Parameters<typeof db.batch>[0]) {
    calls++;
    // Failure after all seed inserts: real local D1 must roll the batch back.
    return db.batch([...statements, sql("INSERT INTO missing_seed_failure_relation VALUES (1)")]);
  } };
  let failure: unknown;
  try { await seedTrustedStudents(failed, validation); } catch (error) { failure = error; }
  expect(failure instanceof Error && failure.message === "TRUSTED_LOCAL_SEED_FAILED" && !("cause" in failure)).toBe(true);
  expect(calls).toBe(1);
  expect((await count()).every((n) => n === 0)).toBe(true);
  await checkTrustedSeedIntegrity(db, validation);
});

it("[#898 seed fail-closed] concurrent data arriving after preflight aborts the entire batch without reset", async () => {
  let calls = 0;
  const raced = { prepare: db.prepare.bind(db), async batch(statements: Parameters<typeof db.batch>[0]) {
    calls++;
    await sql("INSERT INTO command_guards VALUES ('seed-race',0,'test-owned',1)").run();
    return db.batch(statements);
  } };
  try {
    await expect(seedTrustedStudents(raced, validation)).rejects.toThrow("TRUSTED_LOCAL_SEED_FAILED");
    expect(calls).toBe(1);
    expect(await sql("SELECT COUNT(*) AS n FROM students").first("n")).toBe(0);
    expect(await sql("SELECT COUNT(*) AS n FROM command_guards WHERE id='seed-race'").first("n")).toBe(1);
  } finally {
    // Remove only this test's injected row; seed itself never deletes anything.
    await sql("DELETE FROM command_guards WHERE id='seed-race'").run();
  }
});
