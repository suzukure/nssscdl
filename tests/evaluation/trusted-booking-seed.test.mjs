import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, linkSync, writeFileSync,
  lstatSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { migrations } from "./local-https-smoke.mjs";
import { validation } from "./trusted-evaluation-seed.mjs";
import { seedTrustedStudents } from "../fixtures/d1/trusted-student-seed.ts";
import { captureBookingBaseline, verifyBookingReadback, verifyBookingUnchanged } from "./booking-readback.ts";
import { bookingD1, checkBookingEnvironment, checkBookingResources, directoryIdentity, checkDirectoryIdentity, checkOwnedTree, origin,
  persistence, proxyOptions, useBookingSeedProxy, failure } from "./trusted-booking-seed.mjs";

const fixed = (error) => error instanceof Error && error.message === "TRUSTED_BOOKING_SEED_FAILED" && !("cause" in error);
const readFailure = (error) => error instanceof Error && error.message === "BOOKING_EVALUATION_READBACK_FAILED" && !("cause" in error);
function fixture(expectedOptions = proxyOptions) {
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
    assert.equal(options, expectedOptions);
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

// Existing VM seam, with real prepare/checkOwned/inspection bodies and private
// WeakMap. Only preflight/CLI/Proxy are finite; no production persist is created.
async function ownedFixture(baselineFault) {
  const temp = mkdtempSync(resolve(tmpdir(), "booking-owned-fixture-"));
  const home = resolve(temp, "home"), persist = resolve(temp, ".wrangler/student-booking-evaluation");
  mkdirSync(home);
  const options = Object.freeze({ configPath: "fixture-config", remoteBindings: false,
    persist: Object.freeze({ path: resolve(persist, "v3") }) });
  const f = fixture(options), events = [];
  const control = { fault: "", uid: process.getuid(), pause: undefined };
  let proxies = 0, reads = 0, disposals = 0, handle, seed;
  const source = readFileSync("tests/evaluation/trusted-booking-seed.mjs", "utf8");
  const importLine = 'const { getPlatformProxy } = await import("wrangler");';
  assert.equal(source.split(importLine).length - 1, 2);
  assert.match(source, /await getPlatformProxy\(proxyOptions\)/);
  const identities = source.slice(source.indexOf("export function directoryIdentity"), source.indexOf("// Finite static preflight"));
  const boundaries = source.slice(source.indexOf("\nfunction checkOwned(handle)"));
  const code = (identities + boundaries).replaceAll("export ", "").replaceAll(importLine, "");
  const api = runInNewContext(`${code}\n({prepareTrustedBooking, inspectTrustedBooking, inspectTrustedBookingUnchanged})`, {
    process: { env: { TMPDIR: home }, getuid: () => control.uid }, root: temp, persistence: persist, proxyOptions: options,
    owned: new WeakMap(), resolve, readdirSync, realpathSync, mkdirSync, bookingD1, failure,
    lstatSync: path => { if (path === resolve(temp, ".wrangler")) events.push("owner"); return lstatSync(path); },
    check: ok => { if (!ok) throw failure(); },
    seedTrustedStudents, verifyBookingReadback, verifyBookingUnchanged, validation, migrations,
    captureBookingBaseline: async (db, rules) => {
      const baseline = await captureBookingBaseline(db, rules);
      if (baselineFault === "unknown-baseline") return Object.freeze({});
      if (baselineFault === "spent-baseline") await verifyBookingUnchanged(db, rules, baseline);
      return baseline;
    },
    preflight: async () => {
      events.push("preflight");
      if (control.pause) await control.pause;
      if (control.fault === "preflight") throw new Error("private-canary");
    },
    exec: async () => { events.push("migration"); },
    getPlatformProxy: async (supplied) => {
      assert.equal(supplied, options);
      proxies++; events.push("proxy");
      if (proxies === 1) return f.factory(supplied);
      if (control.fault === "proxy") throw new Error("private-canary");
      const read = {
        prepare(query) {
          reads++; events.push("read");
          const rules = validation();
          assert.ok(/^(SELECT|PRAGMA)\b/.test(query) || [rules.authSql, ...rules.reservationScans].includes(query));
          if (control.fault === "read") throw new Error("private-canary");
          return { all: () => f.db.prepare(query).all() };
        },
        batch() { throw new Error("forbidden-writer"); },
        withSession(constraint) { assert.equal(constraint, "first-primary"); events.push("session"); return read; },
      };
      return { env: { ASSETS: { fetch() {} }, EVALUATION_BOOKING_DB: read }, dispose: async () => {
        disposals++; events.push("dispose");
        if (control.fault === "dispose") throw new Error("private-canary");
      } };
    },
  });
  try {
    await api.prepareTrustedBooking((value, capability) => { seed = value; handle = capability; });
    assert.equal(f.disposed(), 1);
    events.length = 0;
    return { ...f, ...api, control, events, handle, seed, home, persist, temp,
      proxies: () => proxies, reads: () => reads, disposals: () => disposals,
      close() { f.sqlite.close(); rmSync(temp, { recursive: true }); } };
  } catch (error) { f.sqlite.close(); rmSync(temp, { recursive: true }); throw error; }
}
const inspect = (f, mode, handle = f.handle) => mode === "positive" ?
  f.inspectTrustedBooking(handle, "new") : f.inspectTrustedBookingUnchanged(handle);
async function spent(f) {
  const counts = [f.proxies(), f.reads(), f.disposals()];
  for (const mode of ["positive", "unchanged"]) await assert.rejects(inspect(f, mode), fixed);
  assert.deepEqual([f.proxies(), f.reads(), f.disposals()], counts);
}

test("#1004: run-owned unchanged and positive share private one-shot; read-only session/disposal", async () => {
  for (const mode of ["unchanged", "positive"]) {
    const f = await ownedFixture();
    try {
      assert.equal(Object.isFrozen(f.handle), true);
      assert.deepEqual(Reflect.ownKeys(f.handle), []);
      assert.equal(JSON.stringify(f.handle), "{}");
      if (mode === "positive") commitFixture(f, f.seed);
      const before = snapshot(f), changes = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
      assert.equal(await inspect(f, mode), undefined);
      assert.equal(snapshot(f) === before, true);
      assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, changes);
      assert.equal(f.batches(), 1); assert.equal(f.proxies(), 2); assert.equal(f.disposals(), 1);
      assert.deepEqual(f.events.slice(0, 5), ["preflight", "owner", "proxy", "session", "session"]);
      assert.deepEqual(f.events.slice(-2), ["owner", "dispose"]);
      assert.equal(f.events.filter(e => e === "owner").length, 2);
      assert.equal(f.events.at(-1), "dispose"); assert.ok(f.reads() > 0);
      await spent(f); // Both success directions, including cross-use.
    } finally { f.close(); }
  }
});
test("#1004: foreign capabilities and concurrent cross-use never open a second proxy", async () => {
  const f = await ownedFixture();
  try {
    for (const handle of [{}, Object.freeze({}), null]) {
      for (const mode of ["positive", "unchanged"]) await assert.rejects(inspect(f, mode, handle), fixed);
    }
    await assert.rejects(f.inspectTrustedBookingUnchanged(undefined), fixed);
    await assert.rejects(f.inspectTrustedBooking(undefined, "new"), fixed);
    assert.equal(f.proxies(), 1); assert.equal(f.reads(), 0);
    // Consume at entry, before even the asynchronous preflight can complete.
    for (const mode of ["positive", "unchanged"]) {
      const other = await ownedFixture(); let release;
      try {
        if (mode === "positive") commitFixture(other, other.seed);
        other.control.pause = new Promise(done => { release = done; });
        const pending = inspect(other, mode);
        await spent(other); assert.equal(other.proxies(), 1);
        release(); await pending; await spent(other);
      } finally { release?.(); other.close(); }
    }
  } finally { f.close(); }
});
test("#1004: unknown reads/proxy/disposal and row/schema changes spend handle; no retry/writes", async () => {
  for (const fault of ["preflight", "proxy", "read", "dispose", "row", "schema", "unknown-baseline", "spent-baseline"]) {
    const f = await ownedFixture(fault);
    try {
      f.control.fault = fault;
      if (fault === "row") f.sqlite.exec("UPDATE student_sessions SET revoked_at=created_at WHERE id='seed-session-self'");
      if (fault === "schema") f.sqlite.exec("CREATE TABLE extra(id TEXT)");
      const changes = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
      await assert.rejects(inspect(f, "unchanged"), fixed);
      assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, changes);
      assert.equal(f.disposals(), ["preflight", "proxy"].includes(fault) ? 0 : 1);
      assert.equal(f.batches(), 1); await spent(f);
      assert.equal(lstatSync(f.persist).isDirectory(), true); // Failures retain files.
    } finally { f.close(); }
  }
});
test("#1004: owner directory/home/parent/uid drift fails before read; post-read drift disposes once", async () => {
  for (const drift of ["persist", "home", "parent", "uid", "symlink", "after-read"]) {
    const f = await ownedFixture();
    try {
      const replace = () => {
        const path = drift === "home" ? f.home : drift === "parent" ? resolve(f.temp, ".wrangler") : f.persist;
        renameSync(path, `${path}-old`); mkdirSync(path);
      };
      if (drift === "uid") f.control.uid++;
      else if (drift === "symlink") symlinkSync(f.home, resolve(f.persist, "foreign"));
      else if (drift === "after-read") {
        const prepare = f.db.prepare;
        let changed = false;
        f.db.prepare = (...args) => {
          const statement = prepare(...args);
          return { all: async () => { const result = await statement.all(); if (!changed) { changed = true; replace(); } return result; } };
        };
      } else replace();
      await assert.rejects(inspect(f, "unchanged"), fixed);
      assert.equal(f.reads() > 0, drift === "after-read");
      assert.equal(f.disposals(), drift === "after-read" ? 1 : 0);
      await spent(f);
    } finally { f.close(); }
  }
});

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

// Execute the real prepare boundary with finite dependencies: never invoke D1/CLI.
test("#959 seed hook runs synchronously once after empty/absent gates and before migration", async () => {
  const source = readFileSync("tests/evaluation/trusted-booking-seed.mjs", "utf8");
  const prepare = source.slice(source.indexOf("export async function prepareTrustedBooking"), source.indexOf("// Separate read-only proxy"))
    .replace("export async function", "async function");
  for (const fault of ["", "preflight", "persist", "nonempty", "hook", "async-hook", "no-hook"]) {
    const events = [], owned = new WeakMap();
    const call = runInNewContext(`${prepare}\nprepareTrustedBooking`, {
      process: { env: { TMPDIR: "fixture-tmp" } }, root: "fixture-root", persistence: "fixture-persist", owned,
      failure: () => new Error("TRUSTED_BOOKING_SEED_FAILED"),
      check: ok => { if (!ok) throw new Error("private-canary"); },
      preflight: async () => { events.push("preflight"); if (fault === "preflight") throw new Error("private-canary"); },
      present: path => { events.push("absent"); return path === "fixture-persist" && fault === "persist"; },
      readdirSync: () => { events.push("empty"); return fault === "nonempty" ? ["residue"] : []; },
      resolve: (...parts) => parts.join("/"), mkdirSync: () => events.push("mkdir"), directoryIdentity: () => ({}),
      proxyOptions: { configPath: "fixture-config" },
      exec: async () => { events.push("migration"); throw new Error("private-canary"); },
    });
    const hook = fault === "no-hook" ? undefined : () => {
      assert.deepEqual(events, ["preflight", "absent", "empty"]);
      events.push("hook");
      if (fault === "hook") throw new Error("private-canary");
      if (fault === "async-hook") return Promise.resolve();
    };
    await assert.rejects(call(() => {}, hook), error => error.message === "TRUSTED_BOOKING_SEED_FAILED");
    assert.equal(events.filter(e => e === "hook").length, ["preflight", "persist", "nonempty", "no-hook"].includes(fault) ? 0 : 1);
    assert.equal(events.includes("migration"), ["", "no-hook"].includes(fault));
  }
});
