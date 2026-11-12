// Supplementary finite Port fixtures; actual proxy proof remains opt-in.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { migrations } from "./local-https-smoke.mjs";
import { persistence, proxyOptions, useSeedProxy } from "./trusted-evaluation-seed.mjs";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations()) sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
  let batches = 0, disposed = 0;
  const prepare = (query, values = []) => ({
    bind: (...bound) => prepare(query, bound),
    all: async () => ({ success: true, results: sqlite.prepare(query).all(...values) }),
    run: () => sqlite.prepare(query).run(...values),
  });
  const db = { prepare, async batch(statements) {
    batches++; sqlite.exec("BEGIN");
    try {
      for (const statement of statements) statement.run();
      sqlite.exec("COMMIT"); return statements.map(() => ({ success: true }));
    } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  const factory = async (options) => {
    assert.equal(options, proxyOptions);
    return { env: { EVALUATION_READ_DB: db }, dispose: async () => { disposed++; } };
  };
  return { sqlite, db, factory, batches: () => batches, disposed: () => disposed };
}
const fixed = (e) => e instanceof Error && e.message === "TRUSTED_EVALUATION_SEED_FAILED" && !("cause" in e);

test("#906 / TC-F-207-02 partial: real seed, dispose before in-memory callback; no return transport", async () => {
  const f = fixture();
  try {
    let called = 0;
    const result = await useSeedProxy(f.factory, async (seed) => {
      called++; assert.equal(f.disposed(), 1);
      assert.equal(seed.sessions.self.cookie().value !== seed.sessions.other.cookie().value, true);
      return seed.sessions.self.cookie(); // Composition discards even a secret result.
    });
    assert.equal(result === undefined, true); assert.equal(called, 1); assert.equal(f.batches(), 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM student_sessions").get().n, 2);
    const before = JSON.stringify(f.sqlite.prepare("SELECT * FROM student_sessions ORDER BY id").all());
    await assert.rejects(useSeedProxy(f.factory, () => { called++; }), fixed);
    assert.equal(called, 1); assert.equal(f.batches(), 1); assert.equal(f.disposed(), 2);
    assert.equal(before === JSON.stringify(f.sqlite.prepare("SELECT * FROM student_sessions ORDER BY id").all()), true);
  } finally { f.sqlite.close(); }
});

test("#906 / TC-NF-914-04 partial: callback secret cause is replaced after confirmed dispose", async () => {
  const f = fixture();
  try {
    const rejectedSafely = await useSeedProxy(f.factory, async (seed) => {
      throw new Error(seed.sessions.self.cookie().value, { cause: seed.sessions.other.cookie() });
    }).then(() => false, (e) => fixed(e));
    // Even a regression must not feed the secret-bearing exception to a diff.
    assert.equal(rejectedSafely, true);
    assert.equal(f.batches(), 1); assert.equal(f.disposed(), 1);
  } finally { f.sqlite.close(); }
});

test("#906: batch rollback/unknown outcome never retry, never invoke callback, always dispose", async () => {
  for (const unknownOutcome of [false, true]) {
    const f = fixture(); let called = 0, calls = 0;
    const original = f.db.batch;
    f.db.batch = async (statements) => {
      calls++;
      if (unknownOutcome) await original(statements);
      else await original([...statements, { run: () => { throw new Error("fixture-private-sql"); } }]);
      throw new Error("fixture-private-outcome");
    };
    try {
      await assert.rejects(useSeedProxy(f.factory, () => { called++; }), fixed);
      assert.equal(calls, 1); assert.equal(called, 0); assert.equal(f.disposed(), 1);
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM students").get().n, unknownOutcome ? 2 : 0);
    } finally { f.sqlite.close(); }
  }
});

test("#906: schema/nonempty/wrong binding failures stop before batch and still dispose", async () => {
  for (const kind of ["unknown", "changed", "nonempty", "binding"]) {
    const f = fixture(); let called = 0;
    if (kind === "unknown") f.sqlite.exec("CREATE TABLE unexpected(id TEXT)");
    if (kind === "changed") f.sqlite.exec("DROP INDEX ix_slots_month_start");
    if (kind === "nonempty") f.sqlite.exec("INSERT INTO students VALUES ('fixture','active',NULL)");
    const factory = async (options) => {
      const proxy = await f.factory(options);
      if (kind === "binding") proxy.env = { AUTH_DB: f.db };
      return proxy;
    };
    try {
      await assert.rejects(useSeedProxy(factory, () => { called++; }), fixed);
      assert.equal(called, 0); assert.equal(f.batches(), 0); assert.equal(f.disposed(), 1);
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM students").get().n, kind === "nonempty" ? 1 : 0);
    } finally { f.sqlite.close(); }
  }
});

test("#906: failed dispose suppresses callback without retrying seed or dispose", async () => {
  const f = fixture(); let closes = 0, called = 0;
  try {
    await assert.rejects(useSeedProxy(async () => ({ env: { EVALUATION_READ_DB: f.db },
      dispose: async () => { closes++; throw new Error("fixture-private-close"); } }), () => { called++; }), fixed);
    assert.equal(closes, 1); assert.equal(called, 0); assert.equal(f.batches(), 1);
  } finally { f.sqlite.close(); }
});

test("#906: actual proxy options are fixed local config / explicit remote refusal / absolute v3 path", () => {
  assert.equal(proxyOptions.remoteBindings, false);
  assert.equal(proxyOptions.configPath.endsWith("/tests/evaluation/wrangler.jsonc"), true);
  assert.equal(proxyOptions.persist.path.endsWith("/.wrangler/student-read-only-evaluation/v3"), true);
  assert.equal(Object.isFrozen(proxyOptions) && Object.isFrozen(proxyOptions.persist), true);
});

test("#906: no opt-in starts no seed, listener or migration", async () => {
  const before = existsSync(persistence);
  await assert.rejects(promisify(execFile)(process.execPath, ["tests/evaluation/trusted-seed-smoke.mjs"]),
    (e) => e.code === 1 && e.stdout === "");
  assert.equal(existsSync(persistence), before);
});
