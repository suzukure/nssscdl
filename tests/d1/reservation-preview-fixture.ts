import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { D1ReservationPreviewRepository, type ReservationPreviewD1 } from "../../src/infrastructure/d1-reservation-preview";

export const db = env.AUTH_DB;
export const identity = { studentId: "student" };
export const now = Date.parse("2026-11-10T10:00:00+09:00") / 1000;
export const integrityError = { code: "INTEGRITY_STATE_UNAVAILABLE", message: "INTEGRITY_STATE_UNAVAILABLE" };
export const sql = (query: string) => db.prepare(query);

// Reuse auth migrations/View unchanged and reservation read-slice migrations.
// This composition exists only in these isolated test files, never a binding,
// Production migration, shared environment, or auth/Confirm proof.
export async function seedPreviewFixture(actor: string): Promise<void> {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((migration: { name: string }) =>
    Number(migration.name.slice(0, 4)) >= 3));
  for (const table of ["students", "schedule_months", "lesson_slots", "student_reservations", "student_monthly_lesson_configs"]) {
    expect((await sql(`SELECT * FROM ${table}`).all()).results).toEqual([]);
  }
  const statements = [
    sql("INSERT INTO students VALUES ('student', 'active', NULL), ('private-other', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 0), ('private-other', 'active', 0)"),
    sql("INSERT INTO student_accounts VALUES ('account', 'student', 'student'), ('other-account', 'private-other', 'student')"),
    sql("INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?, ?, ?, NULL)")
      .bind("a".repeat(64), now - 86400, now + 86400),
    sql("INSERT INTO student_sessions VALUES ('other-session', 'other-account', 'student', ?, ?, ?, NULL)")
      .bind("b".repeat(64), now - 86400, now + 86400),
    sql("INSERT INTO schedule_months VALUES ('month', '2026-11', 0, 0, 0), ('other-month', '2026-12', 0, 0, 0)"),
  ];
  for (const [id, day] of [["past", "01"], ["admin", "12"], ["group", "13"], ["target", "15"], ["later", "22"], ["last", "29"]]) {
    const date = `2026-11-${day}`;
    const start = Date.parse(`${date}T10:00:00+09:00`) / 1000;
    statements.push(sql("INSERT INTO lesson_slots VALUES (?, 'month', ?, '10:00', '11:00', ?, ?, 'enabled')")
      .bind(id, date, start, start + 3600));
  }
  statements.push(
    sql("INSERT INTO student_reservations VALUES ('past-r', 'student', 'past', 'confirmed', 'standard', 'standard', 0, NULL, 0), ('later-r', 'student', 'later', 'confirmed', 'standard', 'standard', 0, NULL, 0)"),
    sql("INSERT INTO slot_occupancies VALUES ('past-o', 'past', 'student_reservation', 'past-r', 0, ?), ('later-o', 'later', 'student_reservation', 'later-r', 0, ?), ('admin-o', 'admin', 'admin_hold', NULL, 0, ?), ('group-o', 'group', 'group_lesson', NULL, 0, ?)")
      .bind(actor, actor, actor, actor),
    sql("INSERT INTO admin_holds VALUES ('admin-o')"), sql("INSERT INTO group_lessons VALUES ('group-o')"),
  );
  expect((await db.batch(statements)).every((result) => result.success)).toBe(true);
  expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
}

// Synthetic time/anomaly injection at the existing D1 interface, test-only.
// Actual SQL still executes as one coherent read; real T0 has a separate test.
export function repository(time = now, transform = (query: string) => query) {
  const source: ReservationPreviewD1 = { withSession(constraint) {
    const session = db.withSession(constraint);
    return { prepare(query) {
      return session.prepare(transform(query.replace("CAST(strftime('%s','now') AS INTEGER)", String(time))));
    } };
  } };
  return new D1ReservationPreviewRepository(source);
}
