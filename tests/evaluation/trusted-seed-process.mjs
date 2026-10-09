// Invoked only by the sanitized opt-in owner. No argv/env Session transport.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { checkTrustedSeedIntegrity } from "../fixtures/d1/trusted-student-seed.ts";
import { migrations } from "./local-https-smoke.mjs";
import { checkSetup, failure, persistence, proxyOptions, root, validation, withTrustedEvaluationSeed } from "./trusted-evaluation-seed.mjs";

const check = (condition) => { if (!condition) throw failure(); };
const digest = (s) => createHash("sha256").update(s).digest("hex");
const schemaQuery = `SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name`;
const normalized = (rows) => JSON.stringify(rows.map((r) => [r.type, r.name, r.tbl_name,
  r.sql.replace(/'[^']*(?:''[^']*)*'|\s+/g, (s) => s.startsWith("'") ? s : "").replace(/;$/, "")]));

// Read-only checks on a SEPARATE actual proxy after the seed proxy is disposed.
export async function inspect(seed, selfRevokedAt = null) {
  checkSetup();
  const { getPlatformProxy } = await import("wrangler");
  let proxy;
  try {
    proxy = await getPlatformProxy(proxyOptions);
    check(Object.keys(proxy.env).length === 1 && !!proxy.env.EVALUATION_READ_DB);
    const db = proxy.env.EVALUATION_READ_DB;
    const rows = async (query) => {
      const result = await db.prepare(query).all();
      check(result.success); return result.results;
    };
    const names = migrations();
    check(JSON.stringify((await rows("SELECT name FROM d1_migrations ORDER BY name")).map((r) => r.name)) === JSON.stringify(names));
    const expected = new DatabaseSync(":memory:");
    try {
      for (const name of names) expected.exec(readFileSync(resolve(root, "migrations", name), "utf8"));
      check(normalized(await rows(schemaQuery)) === normalized(expected.prepare(schemaQuery).all()));
    } finally { expected.close(); }
    await checkTrustedSeedIntegrity(db, validation());
    const date = (await rows("SELECT strftime('%Y-%m-%d','now','+9 hours','start of month','+1 month','+14 days') AS d"))[0].d;
    check(seed.date === date && seed.month === date.slice(0, 7));
    const months = await rows("SELECT * FROM schedule_months");
    check(months.length === 1 && months[0].month_key === seed.month && months[0].published_at !== null);
    const slots = await rows("SELECT *,CAST(strftime('%s','now') AS INTEGER) AS t FROM lesson_slots ORDER BY starts_at");
    check(slots.length === 5 && slots.every((s, i) => s.id === `seed-slot-${["bookable", "self", "other", "group", "admin"][i]}` &&
      s.lesson_date === date && s.availability_status === "enabled" && s.start_time === `${10 + i}:00` && s.end_time === `${11 + i}:00` &&
      s.starts_at === Date.parse(`${date}T${10 + i}:00:00+09:00`) / 1000 && s.ends_at - s.starts_at === 3600 && s.starts_at > s.t));
    const reservations = await rows("SELECT * FROM student_reservations ORDER BY id");
    check(reservations.length === 2 && reservations.every((r) => ["self", "other"].some((owner) =>
      r.id === `seed-reservation-${owner}` && r.student_id === `seed-${owner}` && r.lesson_slot_id === `seed-slot-${owner}` &&
      r.status === "confirmed" && r.automatic_classification === "standard" && r.classification === "standard")));
    const occupancies = await rows("SELECT * FROM slot_occupancies ORDER BY id");
    check(occupancies.length === 4 && occupancies.every((o) => ["self", "other", "group", "admin"].some((kind) =>
      o.id === `seed-occupancy-${kind}` && o.slot_id === `seed-slot-${kind}` &&
      o.occupancy_type === ({ self: "student_reservation", other: "student_reservation", group: "group_lesson", admin: "admin_hold" })[kind] &&
      o.reservation_id === (["self", "other"].includes(kind) ? `seed-reservation-${kind}` : null))));
    for (const [table, kind] of [["group_lessons", "group"], ["admin_holds", "admin"]]) {
      const details = await rows(`SELECT * FROM ${table}`);
      check(details.length === 1 && details[0].occupancy_id === `seed-occupancy-${kind}`);
    }
    const sessions = await rows("SELECT *,CAST(strftime('%s','now') AS INTEGER) AS t FROM student_session_access_v1 ORDER BY session_id");
    check(sessions.length === 2);
    const tokens = [seed.sessions.self.cookie().value, seed.sessions.other.cookie().value];
    check(tokens[0] !== tokens[1]);
    for (const owner of ["self", "other"]) {
      const cookie = seed.sessions[owner].cookie();
      const row = sessions.find((r) => r.session_id === `seed-session-${owner}`);
      check(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(cookie.value) && cookie.name === "__Host-student_session" &&
        cookie.path === "/" && cookie.secure && cookie.httpOnly && cookie.sameSite === "Lax" && !("domain" in cookie));
      check(row && row.token_hash === digest(cookie.value) && /^[0-9a-f]{64}$/.test(row.token_hash) &&
        row.account_id === `seed-account-${owner}` && row.student_id === `seed-${owner}` && row.role_scope === "student" &&
        row.access_state === "active" && row.lifecycle === "active" && row.revoked_at === (owner === "self" ? selfRevokedAt : null) &&
        row.created_at <= row.t && row.expires_at > row.t && row.expires_at - row.created_at === 86400);
    }
    // Secret-bearing contents are compared in memory; never assertion diffs.
    const tables = await rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY name");
    const data = [];
    for (const { name } of tables) data.push(await rows(`SELECT * FROM "${name}" ORDER BY rowid`));
    // #908 compares the complete read-only snapshot while allowing ONLY the
    // explicitly verified test-owned NULL -> revoked_at change on self.
    if (selfRevokedAt !== null) {
      check(Number.isSafeInteger(selfRevokedAt));
      const sessionRows = data[tables.findIndex((r) => r.name === "student_sessions")];
      check(sessionRows.find((r) => r.id === "seed-session-self").revoked_at === selfRevokedAt);
      sessionRows.find((r) => r.id === "seed-session-self").revoked_at = null;
    }
    const serialized = JSON.stringify(data);
    check(tokens.every((token) => !serialized.includes(token) && !JSON.stringify(seed).includes(token)));
    return digest(serialized);
  } finally { if (proxy) await proxy.dispose(); }
}

export function checkFiles(directory, tokens) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    check(!entry.isSymbolicLink());
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) checkFiles(path, tokens);
    else {
      const contents = readFileSync(path);
      check(tokens.every((token) => !entry.name.includes(token) && !contents.includes(Buffer.from(token))));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  let before;
  await withTrustedEvaluationSeed(async (seed) => {
    before = await inspect(seed);
    // A repeated attempt is preflight rejection, never a retry of a failed batch.
    let rejected = false;
    try { await withTrustedEvaluationSeed(() => { throw failure(); }); }
    catch (e) { rejected = e.message === "TRUSTED_EVALUATION_SEED_FAILED" && !("cause" in e); }
    check(rejected && before === await inspect(seed));
    const tokens = [seed.sessions.self.cookie().value, seed.sessions.other.cookie().value];
    checkFiles(persistence, tokens);
    checkFiles(process.env.TMPDIR, tokens);
    check(tokens.every((token) => !JSON.stringify(process.env).includes(token) && !JSON.stringify(process.argv).includes(token)));
  });
  check(typeof before === "string");
} catch {
  // Neither callback cause nor SQL/token/hash reaches stderr or the owner.
  process.exitCode = 1;
}
