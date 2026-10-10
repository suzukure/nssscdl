import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrations } from "./local-https-smoke.mjs";
import { validation } from "./trusted-evaluation-seed.mjs";
import { captureBookingBaseline, verifyBookingReadback } from "./booking-readback.ts";
import { bookingD1, checkBookingEnvironment, checkBookingResources, directoryIdentity, checkDirectoryIdentity, checkOwnedTree, origin,
  persistence, proxyOptions, useBookingSeedProxy } from "./trusted-booking-seed.mjs";

const fixed = (error) => error instanceof Error && error.message === "TRUSTED_BOOKING_SEED_FAILED" && !("cause" in error);
const readFailure = (error) => error instanceof Error && error.message === "BOOKING_EVALUATION_READBACK_FAILED" && !("cause" in error);
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations()) sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
  sqlite.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)");
  for (const [i, name] of migrations().entries()) sqlite.prepare("INSERT INTO d1_migrations VALUES (?,?,?)").run(i + 1, name, "fixture");
  let batches = 0, disposed = 0;
  const prepare = (query, args = []) => ({ bind: (...bound) => prepare(query, bound),
    all: async () => ({ success: true, results: sqlite.prepare(query).all(...args) }),
    run: () => sqlite.prepare(query).run(...args),
  });
  const db = { prepare, withSession: (constraint) => { assert.equal(constraint, "first-primary"); return db; },
    async batch(statements) {
      batches++; sqlite.exec("BEGIN");
      try { for (const s of statements) s.run(); sqlite.exec("COMMIT"); return statements.map(() => ({ success: true })); }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    } };
  const factory = async (options) => {
    assert.equal(options, proxyOptions);
    return { env: { ASSETS: { fetch() {} }, EVALUATION_BOOKING_DB: db }, dispose: async () => { disposed++; } };
  };
  return { sqlite, db, factory, batches: () => batches, disposed: () => disposed };
}
// Expected fixture rows follow D1 design §2 / §5 and the unchanged #931 case:
// one existing self + one new self reservation remain below default N=3.
function commitFixture(f, seed) {
  const t = f.sqlite.prepare("SELECT CAST(strftime('%s','now') AS INTEGER) AS t").get().t;
  f.sqlite.exec("BEGIN");
  f.sqlite.prepare("INSERT INTO student_reservations VALUES ('new','seed-self','seed-slot-bookable','confirmed','standard','standard',?,NULL,?)").run(t, t);
  f.sqlite.prepare("INSERT INTO slot_occupancies VALUES ('new-occupancy','seed-slot-bookable','student_reservation','new',?,'seed-self')").run(t);
  f.sqlite.prepare("INSERT INTO business_audit_logs VALUES ('new-audit',?,'reservation_confirm','student','seed-self','student_reservation','new',NULL,?,'committed')")
    .run(t, JSON.stringify({ version: 1, reservation: { id: "new", automatic_classification: "standard", classification: "standard" }, derived_changes: [] }));
  f.sqlite.prepare("INSERT INTO notification_intents VALUES ('new-intent','reservation_confirmation','seed-self','new',?,?, 'valid',NULL,NULL)")
    .run(t, JSON.stringify({ version: 1, reservation: { id: "new", startsAt: `${seed.date}T10:00:00+09:00`, endsAt: `${seed.date}T11:00:00+09:00`, classification: "standard" } }));
  f.sqlite.prepare("INSERT INTO notification_outbox VALUES ('new-intent',?,NULL,NULL)").run(t);
  f.sqlite.exec("COMMIT");
}
const snapshot = (f) => JSON.stringify(f.sqlite.prepare("SELECT * FROM student_sessions ORDER BY id").all());

test("#937: fixed local identity is independent of the sealed read-only config", () => {
  assert.equal(origin, "https://127.0.0.1:8789");
  assert.equal(persistence.endsWith("/.wrangler/student-booking-evaluation"), true);
  assert.equal(proxyOptions.persist.path.endsWith("/student-booking-evaluation/v3"), true);
  assert.equal(proxyOptions.configPath.endsWith("/wrangler.reservation.jsonc"), true);
  assert.equal(proxyOptions.remoteBindings, false);
  assert.equal(Object.isFrozen(proxyOptions) && Object.isFrozen(proxyOptions.persist), true);
  checkBookingResources(false, false, false);
  for (const observation of [[true, false, false], [false, true, false], [false, false, true], [false, false, undefined]])
    assert.throws(() => checkBookingResources(...observation), fixed);
});
test("#937: closed config / credential isolation reject all override classes", () => {
  const config = JSON.parse(readFileSync("tests/evaluation/wrangler.reservation.jsonc", "utf8"));
  const environment = { PATH: "/fixture", HOME: "/fixture/home", XDG_CONFIG_HOME: "/fixture/home", TMPDIR: "/fixture/home",
    WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: "/fixture/home/wrangler.log" };
  checkBookingEnvironment(environment, config, [".env.example"]);
  for (const mutate of [
    (c) => { c.dev.port = 8788; }, (c) => { c.workers_dev = true; }, (c) => { c.preview_urls = true; },
    (c) => { c.d1_databases[0].binding = "EVALUATION_READ_DB"; }, (c) => { c.d1_databases[0].database_id = "other"; },
    (c) => { c.d1_databases[0].remote = true; }, (c) => { c.d1_databases.push(c.d1_databases[0]); },
    (c) => { delete c.assets; }, (c) => { c.env = {}; }, (c) => { c.vars = { private: "canary" }; },
  ]) {
    const changed = structuredClone(config); mutate(changed);
    assert.throws(() => checkBookingEnvironment(environment, changed, []), fixed);
  }
  for (const change of [{ TOKEN: "canary" }, { WRANGLER_SEND_METRICS: "true" }, { HOME: "/other" }])
    assert.throws(() => checkBookingEnvironment({ ...environment, ...change }, config, []), fixed);
  for (const name of [".env", ".env.local", ".dev.vars", ".dev.vars.local"])
    assert.throws(() => checkBookingEnvironment(environment, config, [name]), fixed);
});
test("#937: directory replacement / symlink cannot claim same-run ownership", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "booking-fixture-"));
  try {
    const a = resolve(temp, "a"), b = resolve(temp, "b"); mkdirSync(a); mkdirSync(b);
    const identity = directoryIdentity(a); checkDirectoryIdentity(a, identity);
    assert.throws(() => checkDirectoryIdentity(b, identity), fixed);
    symlinkSync(b, resolve(temp, "link"));
    assert.throws(() => directoryIdentity(resolve(temp, "link")), fixed);
    writeFileSync(resolve(a, "db"), "fixture"); checkOwnedTree(a);
    linkSync(resolve(a, "db"), resolve(b, "db"));
    assert.throws(() => checkOwnedTree(a), fixed);
  } finally { rmSync(temp, { recursive: true }); } // Synthetic fixture only, no run-owned persist.
});
test("#937: exact two bindings required; capabilities never fall back to old DB", () => {
  const f = fixture();
  try {
    const valid = { ASSETS: { fetch() {} }, EVALUATION_BOOKING_DB: f.db };
    assert.equal(bookingD1(valid) === f.db, true);
    for (const env of [{}, { EVALUATION_BOOKING_DB: f.db }, { ASSETS: valid.ASSETS },
      { ...valid, EVALUATION_READ_DB: f.db }, { ...valid, ASSETS: {} }, { ...valid, EVALUATION_BOOKING_DB: { prepare() {} } }])
      assert.throws(() => bookingD1(env), fixed);
  } finally { f.sqlite.close(); }
});
test("#937: dispose precedes handoff; repeated seed never batches or transports secrets", async () => {
  const f = fixture(); let called = 0;
  try {
    const result = await useBookingSeedProxy(f.factory, (seed, baseline) => {
      called++; assert.equal(f.disposed(), 1);
      assert.equal(JSON.stringify(baseline), "{}");
      assert.equal(JSON.stringify(seed).includes(seed.sessions.self.cookie().value), false);
      return seed.sessions.self.cookie();
    });
    assert.equal(result, undefined); assert.equal(called, 1); assert.equal(f.batches(), 1);
    const before = snapshot(f);
    await assert.rejects(useBookingSeedProxy(f.factory, () => { called++; }), fixed);
    assert.equal(snapshot(f) === before, true); assert.equal(f.batches(), 1); assert.equal(called, 1);
  } finally { f.sqlite.close(); }
});
test("#937: missing schema / history / changed schema stop before seed write", async () => {
  for (const sql of ["DROP TABLE d1_migrations", "DELETE FROM d1_migrations WHERE id=12", "DROP INDEX ix_slots_month_start", "CREATE TABLE extra(id TEXT)"]) {
    const f = fixture(); let called = 0;
    try {
      f.sqlite.exec(sql);
      await assert.rejects(useBookingSeedProxy(f.factory, () => { called++; }), fixed);
      assert.equal(f.batches(), 0); assert.equal(called, 0); assert.equal(f.disposed(), 1);
    } finally { f.sqlite.close(); }
  }
});
test("#937: loss of ownership before / after seed suppresses handoff and always disposes", async () => {
  for (const loseAt of [1, 2]) {
    const f = fixture(); let checks = 0, called = 0;
    try {
      await assert.rejects(useBookingSeedProxy(f.factory, () => { called++; }, () => {
        checks++; if (checks === loseAt) throw new Error("private-ownership");
      }), fixed);
      assert.equal(f.batches(), loseAt === 1 ? 0 : 1);
      assert.equal(called, 0); assert.equal(f.disposed(), 1);
    } finally { f.sqlite.close(); }
  }
});
test("#937: unknown batch / disposal / callback failures sanitize and never retry", async () => {
  for (const kind of ["batch", "rollback", "dispose", "callback"]) {
    const f = fixture(); let called = 0, closes = 0;
    try {
      const original = f.db.batch;
      if (kind === "batch") f.db.batch = async (statements) => { await original(statements); throw new Error("private-canary"); };
      if (kind === "rollback") f.db.batch = async (statements) => await original([...statements, { run() { throw new Error("private-canary"); } }]);
      const factory = async (options) => {
        const proxy = await f.factory(options);
        return { ...proxy, dispose: async () => { closes++; if (kind === "dispose") throw new Error("private-canary"); await proxy.dispose(); } };
      };
      await assert.rejects(useBookingSeedProxy(factory, (seed) => { called++; throw new Error(seed.sessions.self.cookie().value); }), fixed);
      assert.equal(f.batches(), 1); assert.equal(closes, 1); assert.equal(called, kind === "callback" ? 1 : 0);
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM students").get().n, kind === "rollback" ? 0 : 2);
    } finally { f.sqlite.close(); }
  }
});
test("#937: positive readback preserves old rows and exposes no baseline values", async () => {
  const f = fixture();
  try {
    await useBookingSeedProxy(f.factory, async (seed, baseline) => {
      const before = snapshot(f); commitFixture(f, seed);
      const changes = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
      await verifyBookingReadback(f.db, validation(), baseline, "new");
      assert.equal(snapshot(f) === before, true); assert.equal(f.batches(), 1);
      assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, changes);
    });
  } finally { f.sqlite.close(); }
});
test("#937: partial / foreign-owner / tampered results fail closed without readback writes", async () => {
  for (const change of [
    "DELETE FROM notification_outbox", "DELETE FROM notification_outbox; DELETE FROM notification_intents", "DELETE FROM business_audit_logs",
    "DELETE FROM slot_occupancies WHERE reservation_id='new'", "UPDATE student_reservations SET student_id='seed-other' WHERE id='new'",
    "UPDATE business_audit_logs SET actor_id='seed-other'", "UPDATE notification_intents SET recipient_student_id='seed-other'",
    "UPDATE notification_intents SET payload_json='{}'", "UPDATE notification_outbox SET due_at=due_at+1",
    "UPDATE student_reservations SET classification='additional' WHERE id='seed-reservation-other'",
    "UPDATE student_reservations SET classification='additional' WHERE id='seed-reservation-self'",
    "UPDATE student_sessions SET revoked_at=created_at WHERE id='seed-session-other'",
    "INSERT INTO command_guards VALUES ('remaining',1,'{}',1)", "DROP INDEX ix_slots_month_start",
    "UPDATE slot_occupancies SET created_by='seed-other' WHERE id='new-occupancy'",
  ]) {
    const f = fixture();
    try {
      await useBookingSeedProxy(f.factory, async (seed, baseline) => {
        commitFixture(f, seed); f.sqlite.exec(change);
        const changes = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
        await assert.rejects(verifyBookingReadback(f.db, validation(), baseline, "new"), readFailure);
        assert.equal(f.batches(), 1);
        assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, changes);
      });
    } finally { f.sqlite.close(); }
  }
});
test("#937: unknown / old ID / unknown baseline / read error never assert committed", async () => {
  for (const id of ["no-write", "seed-reservation-other", "seed-reservation-self", "unknown", "", "new"]) {
    const f = fixture();
    try {
      await useBookingSeedProxy(f.factory, async (seed, baseline) => {
        if (id !== "no-write") commitFixture(f, seed);
        if (id === "new") {
          const failing = { prepare() { throw new Error(seed.sessions.self.cookie().value); } };
          await assert.rejects(verifyBookingReadback(failing, validation(), baseline, id), readFailure);
        } else {
          await assert.rejects(verifyBookingReadback(f.db, validation(), baseline, id), readFailure);
        }
        // Unknown inspection is terminal even if all rows subsequently appear.
        await assert.rejects(verifyBookingReadback(f.db, validation(), baseline, id), readFailure);
        await assert.rejects(verifyBookingReadback(f.db, validation(), {}, "new"), readFailure);
        await assert.rejects(captureBookingBaseline({ prepare() { throw new Error(seed.sessions.self.cookie().value); } }, validation()), readFailure);
      });
    } finally { f.sqlite.close(); }
  }
});
