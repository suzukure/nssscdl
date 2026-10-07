import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";

// #841: Production migration bytes, isolated local D1; no HTTP/Provider Adapter.
const db = env.AUTH_DB;
const hash = "a".repeat(64);
const statement = (sql: string) => db.prepare(sql);

beforeEach(async () => {
  await db.batch([
    statement("DELETE FROM student_sessions"),
    statement("DELETE FROM student_accounts"),
    statement("DELETE FROM student_security_access"),
    statement("DELETE FROM students"),
    statement("DELETE FROM command_guards"),
    statement("INSERT INTO students VALUES ('student', 'active', NULL), ('other', 'active', NULL)"),
    statement("INSERT INTO student_security_access VALUES ('student', 'active', 100), ('other', 'active', 100)"),
    statement("INSERT INTO student_accounts VALUES ('account', 'student', 'student'), ('other-account', 'other', 'student')"),
  ]);
});

function session(
  id = "session", tokenHash = hash, account = "account", role = "student",
  created = 100, expires = 100 + 2592000, revoked: number | null = null,
) {
  return statement("INSERT INTO student_sessions VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, account, role, tokenHash, created, expires, revoked);
}

// §8.3 stable predicate, using the captured D1 guard time (no Worker clock).
const writePredicate = `EXISTS (
  SELECT 1 FROM student_session_access_v1 AS a
  WHERE a.session_id = ? AND a.token_hash = ?
    AND a.student_id = ? AND a.role_scope = 'student'
    AND a.revoked_at IS NULL
    AND a.created_at <= (SELECT captured_at FROM command_guards WHERE id = ?)
    AND a.expires_at > (SELECT captured_at FROM command_guards WHERE id = ?)
    AND a.lifecycle = 'active' AND a.deleted_at IS NULL
    AND a.access_state = 'active'
)`;

const issuancePredicate = `EXISTS (
  SELECT 1 FROM student_accounts AS a
  JOIN students AS s ON s.id = a.student_id
  JOIN student_security_access AS sa ON sa.student_id = s.id
  WHERE a.id = ? AND a.role_scope = 'student'
    AND s.lifecycle = 'active' AND s.deleted_at IS NULL
    AND sa.access_state = 'active'
)`;

async function allowed(t: number, student = "student", id = "session", tokenHash = hash) {
  await statement("INSERT INTO command_guards VALUES ('clock', ?, '', 1) ON CONFLICT(id) DO UPDATE SET captured_at = excluded.captured_at")
    .bind(t).run();
  return statement(`SELECT ${writePredicate} AS allowed`)
    .bind(id, tokenHash, student, "clock", "clock").first<number>("allowed");
}

async function integrity() {
  expect((await statement("PRAGMA foreign_key_check").all()).results).toEqual([]);
  return (await statement(env.AUTH_INTEGRITY_SQL).all()).results;
}

it("[#841 migration] applies only the auth foundation, indexes, shared guards and exact v1 projection", async () => {
  await session().run();
  expect(await statement("SELECT * FROM student_session_access_v1 WHERE token_hash = ?").bind(hash).first())
    .toEqual({
      session_id: "session", token_hash: hash, account_id: "account", role_scope: "student",
      created_at: 100, expires_at: 2592100, revoked_at: null,
      student_id: "student", lifecycle: "active", deleted_at: null, access_state: "active",
    });
  for (const [name, column] of [
    ["ix_student_sessions_account", "account_id"], ["ix_student_sessions_expiry", "expires_at"],
  ]) {
    const result = await statement(`PRAGMA index_info('${name}')`).all<{ name: string }>();
    expect(result.results.map((row) => row.name)).toEqual([column]);
  }
  const tables = await statement("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('command_guards', 'student_accounts', 'student_security_access', 'student_sessions', 'students', 'bootstrap_probe', 'schedule_months')")
    .all<{ name: string }>();
  expect(tables.results.map((row) => row.name).sort()).toEqual([
    "command_guards", "student_accounts", "student_security_access", "student_sessions", "students",
  ]);
  expect(await integrity()).toEqual([]);
});

it.each([
  ["invalid", null], ["active", 100], ["deleted", null],
])("[#841 migration] rejects lifecycle/deleted_at %s / %s", async (lifecycle, deletedAt) => {
  await expect(statement("INSERT INTO students VALUES ('new', ?, ?)").bind(lifecycle, deletedAt).run())
    .rejects.toThrow(/CHECK constraint failed/);
});

it.each([
  ["INSERT INTO students VALUES (NULL, 'active', NULL)", /NOT NULL/],
  ["INSERT INTO students VALUES ('student', 'active', NULL)", /UNIQUE/],
  ["INSERT INTO student_security_access VALUES ('missing', 'active', 100)", /FOREIGN KEY/],
  ["INSERT INTO student_security_access VALUES ('student', 'active', 100)", /UNIQUE/],
  ["UPDATE student_security_access SET access_state = 'unknown'", /CHECK/],
  ["INSERT INTO student_accounts VALUES ('new', 'missing', 'student')", /FOREIGN KEY/],
  ["INSERT INTO student_accounts VALUES ('new', 'student', 'student')", /UNIQUE/],
  ["INSERT INTO student_accounts VALUES ('new', 'student', 'admin')", /CHECK/],
])("[#841 migration] rejects invalid parent/access/account: %s", async (sql, error) => {
  await expect(statement(sql).run()).rejects.toThrow(error);
});

it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "0".repeat(63) + "-"])(
  "[#841 migration] rejects noncanonical hash %s", async (tokenHash) => {
    await expect(session("session", tokenHash).run()).rejects.toThrow(/CHECK/);
  },
);

it("[#841 migration] rejects duplicate hash and Session ID without replacing the original", async () => {
  await session().run();
  await expect(session("new").run()).rejects.toThrow(/UNIQUE/);
  await expect(session("session", "b".repeat(64)).run()).rejects.toThrow(/UNIQUE/);
  expect(await statement("SELECT token_hash FROM student_sessions").first("token_hash")).toBe(hash);
});

it.each([["missing", "student", /FOREIGN KEY/], ["account", "admin", /CHECK/]])(
  "[#841 migration] rejects Session account/role %s / %s", async (account, role, error) => {
    await expect(session("session", hash, account, role).run()).rejects.toThrow(error);
  },
);

it.each([[100, 100, null], [100, 99, null], [100, 2592101, null], [100, 200, 99]])(
  "[TC-F-207-02 / TC-F-207-03 partial DB] rejects invalid timestamps %s / %s / %s",
  async (created, expires, revoked) => {
    await expect(session("session", hash, "account", "student", created, expires, revoked).run())
      .rejects.toThrow(/CHECK/);
  },
);

it.each([
  "id = 'changed'", "account_id = 'other-account'", "role_scope = 'admin'",
  "token_hash = '" + "b".repeat(64) + "'", "created_at = 101", "expires_at = 200",
])("[TC-F-207-02 partial DB] preserves issued Session fields: %s", async (change) => {
  await session().run();
  await expect(statement(`UPDATE student_sessions SET ${change}`).run())
    .rejects.toThrow(/student_session_identity_is_immutable/);
});

it.each(["id = 'changed'", "student_id = 'other'", "role_scope = 'admin'"])(
  "[#841 migration] preserves Account binding: %s", async (change) => {
    await expect(statement(`UPDATE student_accounts SET ${change} WHERE id = 'account'`).run())
      .rejects.toThrow(/student_account_binding_is_immutable/);
  },
);

it("[TC-F-207-02 / TC-F-003-06 partial DB] enforces exact expiry, future creation and self-scope", async () => {
  await session().run();
  expect(await allowed(99)).toBe(0);
  expect(await allowed(100)).toBe(1);
  expect(await allowed(2592099)).toBe(1);
  expect(await allowed(2592100)).toBe(0);
  expect(await allowed(2592101)).toBe(0);
  expect(await allowed(100, "other")).toBe(0);
  expect(await allowed(100, "student", "unknown")).toBe(0);
  expect(await allowed(100, "student", "session", "b".repeat(64))).toBe(0);
});

it("[TC-F-207-03 partial DB] Logout revokes only the selected Session and cannot be undone or retimed", async () => {
  await db.batch([session(), session("other-session", "b".repeat(64))]);
  await statement("UPDATE student_sessions SET revoked_at = 150 WHERE id = ? AND token_hash = ? AND revoked_at IS NULL")
    .bind("session", hash).run();
  expect(await allowed(150)).toBe(0);
  expect(await allowed(150, "student", "other-session", "b".repeat(64))).toBe(1);
  for (const revoked of [null, 151]) {
    await expect(statement("UPDATE student_sessions SET revoked_at = ? WHERE id = 'session'").bind(revoked).run())
      .rejects.toThrow(/student_session_revocation_is_final/);
  }
  expect(await integrity()).toEqual([]);
});

it("[TC-F-211-02 / TC-F-211-03 partial DB] suspension revokes all Sessions, including expired ones; release requires a new Session", async () => {
  await db.batch([session(), session("expired", "b".repeat(64), "account", "student", 100, 110),
    session("unrelated", "c".repeat(64), "other-account")]);
  await db.withSession("first-primary").batch([
    statement("UPDATE student_security_access SET access_state = 'suspended', updated_at = 150 WHERE student_id = 'student' AND access_state = 'active'"),
    statement("INSERT INTO command_guards VALUES ('suspend', 150, '', CASE WHEN changes() = 1 THEN 1 ELSE 0 END)"),
    statement("UPDATE student_sessions SET revoked_at = 150 WHERE revoked_at IS NULL AND account_id IN (SELECT id FROM student_accounts WHERE student_id = 'student')"),
    statement("DELETE FROM command_guards WHERE id = 'suspend'"),
  ]);
  expect(await statement(`SELECT ${issuancePredicate} AS allowed`).bind("account").first("allowed")).toBe(0);
  expect(await allowed(150)).toBe(0);
  expect((await statement("SELECT revoked_at FROM student_sessions WHERE account_id = 'account'").all()).results)
    .toEqual([{ revoked_at: 150 }, { revoked_at: 150 }]);
  expect(await allowed(150, "other", "unrelated", "c".repeat(64))).toBe(1);
  await statement("UPDATE student_security_access SET access_state = 'active', updated_at = 160 WHERE student_id = 'student'").run();
  expect(await allowed(160)).toBe(0);
  await session("new", "d".repeat(64), "account", "student", 160, 2592160).run();
  expect(await allowed(160, "student", "new", "d".repeat(64))).toBe(1);
  expect(await integrity()).toEqual([]);
});

it("[TC-F-311-02 partial DB] deletion is final, disables issuance/write and keeps the Student FK anchor", async () => {
  await session().run();
  await db.withSession("first-primary").batch([
    statement("UPDATE students SET lifecycle = 'deleted', deleted_at = 150 WHERE id = 'student'"),
    statement("UPDATE student_sessions SET revoked_at = 150 WHERE account_id = 'account' AND revoked_at IS NULL"),
  ]);
  expect(await allowed(150)).toBe(0);
  expect(await statement(`SELECT ${issuancePredicate} AS allowed`).bind("account").first("allowed")).toBe(0);
  await expect(statement("UPDATE students SET lifecycle = 'active', deleted_at = NULL WHERE id = 'student'").run())
    .rejects.toThrow(/student_deletion_is_final/);
  await expect(statement("DELETE FROM students WHERE id = 'student'").run()).rejects.toThrow(/FOREIGN KEY/);
  expect(await integrity()).toEqual([]);
});

it("[#841 integrity] detects missing SecurityAccess without backfill, keeps the invalid Session lookup and denies predicates", async () => {
  await session().run();
  await statement("DELETE FROM student_security_access WHERE student_id = 'student'").run();
  expect(await statement("SELECT session_id, access_state FROM student_session_access_v1").first())
    .toEqual({ session_id: "session", access_state: null });
  expect(await allowed(150)).toBe(0);
  expect(await statement(`SELECT ${issuancePredicate} AS allowed`).bind("account").first("allowed")).toBe(0);
  expect(await integrity()).toContainEqual({ violation: "student_access", entity_id: "student" });
  expect(await statement("SELECT COUNT(*) AS n FROM student_security_access WHERE student_id = 'student'").first("n")).toBe(0);
});

it.each(["suspension", "deletion"])(
  "[#841 integrity] detects incomplete %s with an unrevoked Session", async (mode) => {
    await session().run();
    await statement(mode === "suspension"
      ? "UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"
      : "UPDATE students SET lifecycle = 'deleted', deleted_at = 150 WHERE id = 'student'").run();
    expect(await integrity()).toContainEqual({ violation: "unrevoked_inactive_session", entity_id: "session" });
  },
);

it("[#841 local D1] CHECK failure rolls back all prior writes in a Primary batch", async () => {
  await expect(db.withSession("first-primary").batch([
    statement("INSERT INTO command_guards VALUES ('failed', CAST(strftime('%s','now') AS INTEGER), '', 1)"),
    session(),
    statement("UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"),
    statement("UPDATE command_guards SET ok = 0 WHERE id = 'failed'"),
  ])).rejects.toThrow(/CHECK/);
  expect(await statement("SELECT COUNT(*) AS n FROM student_sessions").first("n")).toBe(0);
  expect(await statement("SELECT COUNT(*) AS n FROM command_guards").first("n")).toBe(0);
  expect(await statement("SELECT access_state FROM student_security_access WHERE student_id = 'student'").first("access_state"))
    .toBe("active");
  expect(await integrity()).toEqual([]);
});

it.each(["suspension", "deletion", "missing-access"])(
  "[TC-F-211-02 / TC-F-311-02 partial DB] issuance CHECK rejects %s without committing a Session",
  async (mode) => {
    await statement(mode === "suspension"
      ? "UPDATE student_security_access SET access_state = 'suspended' WHERE student_id = 'student'"
      : mode === "deletion"
        ? "UPDATE students SET lifecycle = 'deleted', deleted_at = 150 WHERE id = 'student'"
        : "DELETE FROM student_security_access WHERE student_id = 'student'").run();
    await expect(db.withSession("first-primary").batch([
      statement("INSERT INTO command_guards VALUES ('issue', 150, '', 1)"),
      statement(`UPDATE command_guards SET ok = CASE WHEN ${issuancePredicate} THEN 1 ELSE 0 END WHERE id = 'issue'`)
        .bind("account"),
      session(),
      statement("DELETE FROM command_guards WHERE id = 'issue'"),
    ])).rejects.toThrow(/CHECK/);
    expect(await statement("SELECT COUNT(*) AS n FROM student_sessions").first("n")).toBe(0);
    expect(await statement("SELECT COUNT(*) AS n FROM command_guards").first("n")).toBe(0);
  },
);

it("[TC-F-207-02 partial DB] final expiry CHECK rolls back an earlier write", async () => {
  await session().run();
  await expect(db.withSession("first-primary").batch([
    statement("INSERT INTO command_guards VALUES ('write', 2592099, '', 1)"),
    statement(`UPDATE command_guards SET ok = CASE WHEN ${writePredicate} THEN 1 ELSE 0 END WHERE id = 'write'`)
      .bind("session", hash, "student", "write", "write"),
    // Deterministic final-time boundary fixture; not a production clock override.
    statement("UPDATE command_guards SET captured_at = 2592100 WHERE id = 'write'"),
    session("new", "b".repeat(64)),
    statement(`UPDATE command_guards SET ok = CASE WHEN ${writePredicate} THEN 1 ELSE 0 END WHERE id = 'write'`)
      .bind("session", hash, "student", "write", "write"),
  ])).rejects.toThrow(/CHECK/);
  expect(await statement("SELECT revoked_at FROM student_sessions WHERE id = 'session'").first("revoked_at")).toBeNull();
  expect(await statement("SELECT COUNT(*) AS n FROM student_sessions WHERE id = 'new'").first("n")).toBe(0);
  expect(await statement("SELECT COUNT(*) AS n FROM command_guards").first("n")).toBe(0);
});

it("[#841 local D1] a revocation Trigger failure rolls back preceding writes in the same batch", async () => {
  await session("session", hash, "account", "student", 100, 200, 150).run();
  await expect(db.withSession("first-primary").batch([
    session("new", "b".repeat(64)),
    statement("UPDATE student_sessions SET revoked_at = NULL WHERE id = 'session'"),
  ])).rejects.toThrow(/student_session_revocation_is_final/);
  expect(await statement("SELECT id, revoked_at FROM student_sessions").all().then((result) => result.results))
    .toEqual([{ id: "session", revoked_at: 150 }]);
});
