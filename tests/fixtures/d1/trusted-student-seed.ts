// #898: operator/test-owned, dedicated local DB only. Never import from src.
// Caller applies unchanged Production 0001–0012 once and supplies the existing
// validation SQL. No migration, reset, remote selection, logging or retry here.
interface SeedStatement {
  bind(...values: unknown[]): SeedStatement;
  all<T>(): Promise<{ success: boolean; results: T[] }>;
}
export interface TrustedSeedD1 {
  prepare(query: string): SeedStatement;
  batch(statements: SeedStatement[]): Promise<{ success: boolean }[]>;
}
export interface SeedValidation {
  readonly authSql: string;
  readonly reservationScans: readonly string[];
}
export class TrustedSeedSession {
  #rawToken: string;
  constructor(rawToken: string) { this.#rawToken = rawToken; }
  // Dedicated secret-bearing return value for a trusted process. Browser URL /
  // context ownership belongs to the later composition, not this helper.
  cookie() {
    return { name: "__Host-student_session", value: this.#rawToken, path: "/",
      secure: true, httpOnly: true, sameSite: "Lax" as const };
  }
}
const tables = [
  "admin_holds", "business_audit_logs", "command_guards", "group_lessons", "lesson_slots",
  "notification_intents", "notification_outbox", "reservation_absences",
  "reservation_classification_overrides", "reservation_monthly_count_overrides", "schedule_months",
  "slot_occupancies", "student_accounts", "student_monthly_lesson_configs", "student_reservations",
  "student_security_access", "student_sessions", "students",
];
const now = "CAST(strftime('%s','now') AS INTEGER)";
// Fingerprint of type/name/table/SQL (sorted by name), from Production 0001–0012.
// Whitespace outside SQL string literals is ignored; CHECK/FK/Index/Trigger/View
// definitions and unknown objects must match, not merely the table names.
const schemaFingerprint = "2d2c32ce918d47444e3c344eaf6180fd62532e6f9b7bb686b3d4f0ded1f5dd5a";
const normalize = (sql: string) => sql.replace(/'[^']*(?:''[^']*)*'|\s+/g,
  (part) => part.startsWith("'") ? part : "").replace(/;$/, "");
const hexHash = async (value: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function checkTrustedSeedIntegrity(db: TrustedSeedD1, validation: SeedValidation): Promise<void> {
  try {
    if (!validation.authSql.trim() || validation.reservationScans.length !== 12) throw new Error();
    for (const query of ["PRAGMA foreign_key_check", validation.authSql, ...validation.reservationScans]) {
      const result = await db.prepare(query).all();
      if (!result.success || result.results.length !== 0) throw new Error();
    }
  } catch {
    throw new Error("TRUSTED_LOCAL_SEED_FAILED");
  }
}

export async function seedTrustedStudents(db: TrustedSeedD1, validation: SeedValidation) {
  try {
    const objects = await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '_cf_METADATA') ORDER BY name`)
      .all<{ type: string; name: string; tbl_name: string; sql: string }>();
    if (!objects.success || await hexHash(JSON.stringify(objects.results.map((row) =>
      [row.type, row.name, row.tbl_name, normalize(row.sql)]))) !== schemaFingerprint) throw new Error();
    const empty = tables.map((table) => `NOT EXISTS (SELECT 1 FROM ${table})`).join(" AND ");
    const preflight = await db.prepare(`SELECT (${empty}) AS empty, ${now} AS t`).all<{ empty: number; t: number }>();
    const clock = preflight.results[0];
    if (!preflight.success || preflight.results.length !== 1 || clock.empty !== 1 || !Number.isSafeInteger(clock.t)) throw new Error();
    await checkTrustedSeedIntegrity(db, validation);
    // Always next Tokyo month, day 15. Never host TZ or a fixed historical date.
    const tokyo = new Date((clock.t + 9 * 3600) * 1000);
    const date = new Date(Date.UTC(tokyo.getUTCFullYear(), tokyo.getUTCMonth() + 1, 15)).toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    const start = Date.parse(`${date}T10:00:00+09:00`) / 1000;
    const tokens = Array.from({ length: 2 }, () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    const hashes = await Promise.all(tokens.map(hexHash));
    const q = (query: string, ...values: unknown[]) => db.prepare(query).bind(...values);
    // Recheck empty inside the atomic batch. A concurrent/repeated setup aborts
    // through the existing lifecycle CHECK; no DELETE or UPSERT is performed.
    const statements = [q(`INSERT INTO students
      SELECT 'seed-self', CASE WHEN ${empty} THEN 'active' ELSE 'invalid' END, NULL
      UNION ALL SELECT 'seed-other', 'active', NULL`),
    q(`INSERT INTO student_security_access VALUES ('seed-self','active',${now}), ('seed-other','active',${now})`),
    q("INSERT INTO student_accounts VALUES ('seed-account-self','seed-self','student'), ('seed-account-other','seed-other','student')"),
    q(`WITH clock AS (SELECT ${now} AS t) INSERT INTO student_sessions
      SELECT 'seed-session-self','seed-account-self','student',?,t,t+86400,NULL FROM clock
      UNION ALL SELECT 'seed-session-other','seed-account-other','student',?,t,t+86400,NULL FROM clock`, ...hashes),
    q(`INSERT INTO schedule_months VALUES ('seed-month',?,${now},${now},${now})`, month)];
    for (const [index, id] of ["bookable", "self", "other", "group", "admin"].entries()) {
      const hour = 10 + index;
      statements.push(q("INSERT INTO lesson_slots VALUES (?, 'seed-month', ?, ?, ?, ?, ?, 'enabled')",
        `seed-slot-${id}`, date, `${hour}:00`, `${hour + 1}:00`, start + index * 3600, start + (index + 1) * 3600));
    }
    for (const owner of ["self", "other"]) {
      statements.push(q(`INSERT INTO student_reservations VALUES (?, ?, ?, 'confirmed','standard','standard',${now},NULL,${now})`,
        `seed-reservation-${owner}`, `seed-${owner}`, `seed-slot-${owner}`));
      statements.push(q(`INSERT INTO slot_occupancies VALUES (?, ?, 'student_reservation', ?, ${now}, ?)`,
        `seed-occupancy-${owner}`, `seed-slot-${owner}`, `seed-reservation-${owner}`, `seed-${owner}`));
    }
    statements.push(q(`INSERT INTO slot_occupancies VALUES ('seed-occupancy-group','seed-slot-group','group_lesson',NULL,${now},'seed-operator'),
      ('seed-occupancy-admin','seed-slot-admin','admin_hold',NULL,${now},'seed-operator')`),
    q("INSERT INTO group_lessons VALUES ('seed-occupancy-group')"), q("INSERT INTO admin_holds VALUES ('seed-occupancy-admin')"));
    const result = await db.batch(statements);
    if (result.length !== statements.length || result.some((row) => !row.success)) throw new Error();
    await checkTrustedSeedIntegrity(db, validation);
    return { month, date, sessions: { self: new TrustedSeedSession(tokens[0]), other: new TrustedSeedSession(tokens[1]) } };
  } catch {
    // No DB error/cause, raw token, hash or PII escapes, even on unknown outcome.
    // Do not retry: inspect/discard this dedicated local DB through trusted setup.
    throw new Error("TRUSTED_LOCAL_SEED_FAILED");
  }
}
