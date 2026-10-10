// #937: trusted-memory, read-only Port for the unchanged strict seed scenario.
import { checkTrustedSeedIntegrity, type SeedValidation, type TrustedSeedD1 } from "../fixtures/d1/trusted-student-seed.ts";

export interface BookingReadPort {
  prepare(query: string): { all<T>(): Promise<{ success: boolean; results: T[] }> };
}
type Row = Record<string, unknown>;
type Snapshot = { time: number; tables: Record<string, Row[]>; schema: Row[] };
const tables = ["admin_holds", "business_audit_logs", "command_guards", "d1_migrations", "group_lessons", "lesson_slots",
  "notification_intents", "notification_outbox", "reservation_absences", "reservation_classification_overrides",
  "reservation_monthly_count_overrides", "schedule_months", "slot_occupancies", "student_accounts",
  "student_monthly_lesson_configs", "student_reservations", "student_security_access", "student_sessions", "students"];
const changed = new Set(["student_reservations", "slot_occupancies", "business_audit_logs", "notification_intents", "notification_outbox"]);
const fail = () => new Error("BOOKING_EVALUATION_READBACK_FAILED");
const check = (ok: unknown) => { if (!ok) throw fail(); };
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Row, y = b as Row;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(y).every((key) => Object.hasOwn(x, key) && same(x[key], y[key]));
};

// Kept private: neither rows nor token hashes can serialize through a checkpoint.
const baselines = new WeakMap<object, Snapshot>();
const inspected = new WeakSet<object>();
export class BookingBaseline { toJSON() { return {}; } }

async function capture(db: BookingReadPort, validation: SeedValidation): Promise<Snapshot> {
  const integrity: TrustedSeedD1 = { prepare: (query) => ({
    bind() { throw fail(); }, all: () => db.prepare(query).all(),
  }), batch: async () => { throw fail(); } };
  await checkTrustedSeedIntegrity(integrity, validation);
  // Closed table inventory comes from Production 0001–0012. Column names are
  // discovered only after schema admission by seedTrustedStudents; quote them.
  const columns: Record<string, string[]> = {};
  for (const table of tables) {
    const result = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    check(result.success && result.results.length > 0);
    columns[table] = result.results.map((r) => r.name);
    check(columns[table].every((name) => /^[a-z_]+$/.test(name)));
  }
  // All row values and the D1 clock are captured in one read-only statement.
  const query = `SELECT CAST(strftime('%s','now') AS INTEGER) AS time, ${tables.map((table) => `(SELECT json_group_array(json(row)) FROM
    (SELECT json_object(${columns[table].map((column) => `'${column}',"${column}"`).join(",")}) AS row
    FROM "${table}" ORDER BY rowid)) AS "${table}"`).join(",")},
    (SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql))
     FROM (SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name)) AS schema`;
  const result = await db.prepare(query).all<Record<string, string | number>>();
  check(result.success && result.results.length === 1);
  const row = result.results[0];
  check(Number.isSafeInteger(row.time));
  const data = Object.fromEntries(tables.map((table) => [table, JSON.parse(String(row[table])) as Row[]]));
  check(tables.every((table) => Array.isArray(data[table])));
  return { time: Number(row.time), tables: data, schema: JSON.parse(String(row.schema)) as Row[] };
}

export async function captureBookingBaseline(db: BookingReadPort, validation: SeedValidation): Promise<BookingBaseline> {
  try {
    const before = await capture(db, validation);
    check(before.tables.student_reservations.length === 2 && before.tables.slot_occupancies.length === 4);
    for (const owner of ["self", "other"]) {
      const r = before.tables.student_reservations.find((r) => r.id === `seed-reservation-${owner}`);
      check(r && r.student_id === `seed-${owner}` && r.lesson_slot_id === `seed-slot-${owner}` &&
        r.status === "confirmed" && r.automatic_classification === "standard" && r.classification === "standard");
    }
    for (const table of ["business_audit_logs", "notification_intents", "notification_outbox", "command_guards"]) check(before.tables[table].length === 0);
    const baseline = Object.freeze(new BookingBaseline());
    baselines.set(baseline, before);
    return baseline;
  } catch { throw fail(); }
}

// Only the strict seed's self -> bookable reservation is admitted. Other
// scenarios fail closed; no automatic retry, repair or NOT_APPLIED inference.
export async function verifyBookingReadback(db: BookingReadPort, validation: SeedValidation,
  baseline: BookingBaseline, reservationId: string): Promise<void> {
  try {
    const before = baselines.get(baseline);
    check(before && !inspected.has(baseline));
    inspected.add(baseline);
    check(typeof reservationId === "string" && reservationId.length > 0);
    if (!before) throw fail();
    const after = await capture(db, validation);
    check(same(before.schema, after.schema));
    for (const table of tables) if (!changed.has(table)) check(same(before.tables[table], after.tables[table]));
    const delta = (table: string): Row => {
      const old = before.tables[table], current = after.tables[table];
      check(current.length === old.length + 1 && old.every((r) => current.some((s) => same(r, s))));
      const added = current.filter((r) => !old.some((s) => same(r, s)));
      check(added.length === 1); return added[0];
    };
    const r = delta("student_reservations"), t = r.created_at;
    check(!before.tables.student_reservations.some((row) => row.id === reservationId));
    check(typeof t === "number" && Number.isSafeInteger(t) && t >= before.time && t <= after.time);
    check(same(r, { id: reservationId, student_id: "seed-self", lesson_slot_id: "seed-slot-bookable", status: "confirmed",
      automatic_classification: "standard", classification: "standard", created_at: t, cancelled_at: null, updated_at: t }));
    const o = delta("slot_occupancies"), a = delta("business_audit_logs"), n = delta("notification_intents"), out = delta("notification_outbox");
    check([o.id, a.id, n.id].every((id) => typeof id === "string" && id.length > 0));
    check(same(o, { id: o.id, slot_id: "seed-slot-bookable", occupancy_type: "student_reservation", reservation_id: reservationId, created_at: t, created_by: "seed-self" }));
    check(same(a, { id: a.id, occurred_at: t, action: "reservation_confirm", actor_type: "student", actor_id: "seed-self", target_type: "student_reservation",
      target_id: reservationId, before_json: null, after_json: JSON.stringify({ version: 1, reservation: { id: reservationId, automatic_classification: "standard", classification: "standard" }, derived_changes: [] }), result: "committed" }));
    const slot = before.tables.lesson_slots.find((s) => s.id === "seed-slot-bookable");
    check(slot);
    check(same(n, { id: n.id, kind: "reservation_confirmation", recipient_student_id: "seed-self", reservation_id: reservationId, occurred_at: t,
      payload_json: JSON.stringify({ version: 1, reservation: { id: reservationId, startsAt: `${slot!.lesson_date}T10:00:00+09:00`, endsAt: `${slot!.lesson_date}T11:00:00+09:00`, classification: "standard" } }),
      obligation_state: "valid", expired_at: null, expiry_reason: null }));
    check(same(out, { intent_id: n.id, due_at: t, claim_token: null, claim_until: null }));
  } catch { throw fail(); }
}
