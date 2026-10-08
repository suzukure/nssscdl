import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { StudentSessionCsrfGetHttpAdapter } from "../../src/http/student-session-csrf-get";
import { StudentSessionCsrf } from "../../src/http/student-session-csrf";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { hashToken, token } from "../integration/student-session-fixture";

// Existing file-isolated AUTH_DB and unchanged Production auth migrations.
const db = env.AUTH_DB;
const origin = "https://nssscdl.test";
const sql = (query: string) => db.prepare(query);
const request = (cookie = `__Host-student_session=${token}`) => new Request(origin + "/api/auth/student/csrf", {
  headers: { cookie, "sec-fetch-site": "same-origin" },
});
const adapter = () => new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(db), origin);
const expected = "p35EDD5VELmGsajOaMrGPH6WzW74IYQLZ9g-3qTG_74";
const snapshot = async () => ({
  sessions: (await sql("SELECT * FROM student_sessions ORDER BY id").all()).results,
  students: (await sql("SELECT * FROM students ORDER BY id").all()).results,
  accounts: (await sql("SELECT * FROM student_accounts ORDER BY id").all()).results,
  access: (await sql("SELECT * FROM student_security_access ORDER BY student_id").all()).results,
});

beforeEach(async () => {
  await db.batch([
    sql("DELETE FROM student_sessions"), sql("DELETE FROM student_accounts"),
    sql("DELETE FROM student_security_access"), sql("DELETE FROM students"),
    sql("INSERT INTO students VALUES ('student', 'active', NULL)"),
    sql("INSERT INTO student_security_access VALUES ('student', 'active', 100)"),
    sql("INSERT INTO student_accounts VALUES ('account', 'student', 'student')"),
    sql(`INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?,
      CAST(strftime('%s','now') AS INTEGER) - 60,
      CAST(strftime('%s','now') AS INTEGER) + 2591900, NULL)`).bind(await hashToken()),
  ]);
});

it("[TC-F-207-02 partial local D1/HTTP / #896] resolves real Session, issues independent vector and never writes", async () => {
  const before = await snapshot();
  const http = adapter();
  for (let index = 0; index < 2; index++) {
    const response = await http.fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ csrfToken: expected, scope: "session" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  const post = new Request(origin + "/api/me/reservations/preview", { method: "POST", headers: {
    cookie: `__Host-student_session=${token}`, origin, "x-csrf-token": expected,
  } });
  expect(await new StudentSessionCsrf(origin).validate(post)).toBe(true);
  expect(await snapshot()).toEqual(before);
});

it.each(["expired", "equal-expiry", "revoked", "suspended", "deleted", "unknown", "missing", "preauth"])(
  "[TC-F-207-03 / TC-F-211-02 partial local D1/HTTP / #896] observes %s and fails closed without mutation", async (mode) => {
    const http = adapter();
    expect((await http.fetch(request())).status).toBe(200);
    if (mode === "expired" || mode === "equal-expiry") {
      await sql("DELETE FROM student_sessions").run();
      await sql(`INSERT INTO student_sessions VALUES ('session', 'account', 'student', ?,
        CAST(strftime('%s','now') AS INTEGER) - 100,
        CAST(strftime('%s','now') AS INTEGER) ${mode === "expired" ? "- 1" : ""}, NULL)`)
        .bind(await hashToken()).run();
    }
    if (mode === "revoked") await sql("UPDATE student_sessions SET revoked_at = CAST(strftime('%s','now') AS INTEGER)").run();
    if (mode === "suspended") await sql("UPDATE student_security_access SET access_state = 'suspended'").run();
    if (mode === "deleted") await sql("UPDATE students SET lifecycle = 'deleted', deleted_at = CAST(strftime('%s','now') AS INTEGER)").run();
    const cookie = mode === "missing" ? "" : mode === "preauth" ? `__Host-student_preauth=${token}`
      : mode === "unknown" ? `__Host-student_session=${"C".repeat(42)}A`
      : `__Host-student_session=${token}; __Host-student_preauth=${token}`;
    const before = await snapshot();
    const response = await http.fetch(request(cookie));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } });
    expect(response.headers.get("set-cookie")).toBe("__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await snapshot()).toEqual(before);
  },
);

it("[TC-NF-914-04 partial local D1/HTTP / #896] missing SecurityAccess maps to integrity 503, retaining Cookie", async () => {
  await sql("DELETE FROM student_security_access").run();
  const before = await snapshot();
  const response = await adapter().fetch(request());
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual({ error: {
    code: "INTEGRITY_STATE_UNAVAILABLE", message: "現在予定情報を利用できません。時間をおいて再度お試しください。", retry: "later",
  } });
  expect(await snapshot()).toEqual(before);
});

it("[TC-NF-914-04 partial local D1/HTTP / #896] abstracts actual SQL failure without Cookie clear", async () => {
  // Existing D1 interface, test-only broken source. No schema/constraint change.
  const failed = new D1StudentAccessGuard({ withSession(constraint) {
    const session = db.withSession(constraint);
    return { prepare(query) {
      return session.prepare(query.replace("student_session_access_v1", "missing_auth_source"));
    } };
  } });
  const before = await snapshot();
  const response = await new StudentSessionCsrfGetHttpAdapter(failed, origin).fetch(request());
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual({ error: {
    code: "SERVICE_UNAVAILABLE", message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later",
  } });
  expect(await snapshot()).toEqual(before);
});
