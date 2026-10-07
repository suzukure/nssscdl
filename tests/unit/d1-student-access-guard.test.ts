import { expect, it } from "vitest";
import { StudentAccessError } from "../../src/application/student-access-guard";
import { D1StudentAccessGuard, type StudentAccessD1 } from "../../src/infrastructure/d1-student-access-guard";
import { hashToken, request, source, token } from "../integration/student-session-fixture";

it("[TC-F-003-06 partial Guard] reads only hash-bound v1 state, fresh Primary and D1 time, keeping Context internal", async () => {
  const fixture = await source();
  const guard = new D1StudentAccessGuard(fixture.database);
  const input = request();
  input.headers.set("studentId", "other");
  input.headers.set("email", "other@example.test");
  input.headers.set("role", "admin");
  expect(await guard.authorize(input)).toEqual({ status: "authenticated", studentId: "student" });
  expect(await guard.resolve(input)).toEqual({ status: "authenticated", context: {
    sessionId: "session", tokenHash: await hashToken(), studentId: "student",
  } });
  expect(fixture.withSession).toHaveBeenCalledTimes(2);
  expect(fixture.withSession.mock.calls).toEqual([["first-primary"], ["first-primary"]]);
  expect(fixture.prepare).toHaveBeenCalledTimes(2);
  expect(fixture.bind.mock.calls).toEqual([[await hashToken()], [await hashToken()]]);
  expect(fixture.all).toHaveBeenCalledTimes(2);
  const sql = fixture.prepare.mock.calls[0][0];
  expect(sql).toContain("student_session_access_v1");
  expect(sql).toContain("strftime('%s','now')");
  expect(sql).not.toContain(token);
  expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|JOIN|PRAGMA)\b/);
});

it.each([
  "", `__Host-admin_session=${token}`, `__Host-student_preauth=${token}`,
  `__Host-student_session=${token}; __Host-student_session=${token}`,
  "__Host-student_session", "__Host-student_session=", `__Host-student_session=${token}=`,
  `__Host-student_session="${token}"`, `__Host-student_session=${"A".repeat(42)}B`,
  `__Host-student_session=${"A".repeat(42)}%`, `__Host-student_session=${"A".repeat(44)}`,
])("[#842 Cookie] rejects missing, duplicate, wrong-purpose or noncanonical Cookie: %s", async (cookie) => {
  const fixture = await source();
  const input = request(cookie);
  input.headers.set("authorization", `Bearer ${token}`);
  input.headers.set("studentId", "student");
  expect(await new D1StudentAccessGuard(fixture.database).authorize(input)).toEqual({ status: "unauthenticated" });
  expect(fixture.withSession).not.toHaveBeenCalled();
});

it("[#842 Cookie] accepts canonical base64url and unrelated Cookies without decoding aliases", async () => {
  const fixture = await source();
  const urlToken = btoa(String.fromCharCode(...Array<number>(32).fill(255))).replace(/\//g, "_").replace(/=+$/, "");
  fixture.row.token_hash = await hashToken(urlToken);
  const guard = new D1StudentAccessGuard(fixture.database);
  expect(await guard.authorize(request(`other=1; __Host-student_session=${urlToken}; __Host-admin_session=ignored`)))
    .toEqual({ status: "authenticated", studentId: "student" });
});

it.each([[99, "unauthenticated"], [100, "authenticated"], [2592099, "authenticated"],
  [2592100, "unauthenticated"], [2592101, "unauthenticated"]] as const)(
  "[TC-F-207-02 partial Guard] evaluates D1 time %s as %s without sliding expiry", async (now, status) => {
    const fixture = await source();
    fixture.row.evaluated_at = now;
    expect((await new D1StudentAccessGuard(fixture.database).authorize(request())).status).toBe(status);
    expect(fixture.row.expires_at).toBe(2592100);
  },
);

it("[#842 result order] unknown token and invalid Session stay 401; only valid wrong role yields 403", async () => {
  const fixture = await source();
  const guard = new D1StudentAccessGuard(fixture.database);
  fixture.all.mockResolvedValueOnce({ success: true, results: [] });
  expect(await guard.authorize(request())).toEqual({ status: "unauthenticated" });
  fixture.row.role_scope = "admin";
  expect(await guard.authorize(request())).toEqual({ status: "forbidden" });
  fixture.row.revoked_at = 120;
  Object.assign(fixture.row, { student_id: null, access_state: null });
  expect(await guard.authorize(request())).toEqual({ status: "unauthenticated" });
});

it.each([
  { student_id: null }, { session_id: "" }, { account_id: "" }, { role_scope: null },
  { lifecycle: null }, { lifecycle: "unknown" }, { access_state: null }, { access_state: "unknown" },
  { deleted_at: 120 }, { lifecycle: "deleted", deleted_at: null },
  { token_hash: "b".repeat(64) }, { evaluated_at: null }, { created_at: 100.5 },
  { expires_at: 100 }, { expires_at: 2592101 }, { revoked_at: 99 },
])("[#842 integrity] fails closed without repairing malformed persisted state %j", async (change) => {
  const fixture = await source();
  Object.assign(fixture.row, change);
  await expect(new D1StudentAccessGuard(fixture.database).authorize(request()))
    .rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
});

it("[#842 integrity] rejects ambiguous lookup without selecting a principal", async () => {
  const fixture = await source();
  fixture.all.mockResolvedValue({ success: true, results: [fixture.row, fixture.row] });
  await expect(new D1StudentAccessGuard(fixture.database).resolve(request()))
    .rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
});

it.each(["session", "prepare", "bind", "all", "unsuccessful"])(
  "[TC-NF-914-04 partial Guard] abstracts %s DB failure without retaining raw data", async (stage) => {
    const raw = new Error("private SQL Cookie token Account detail");
    const database: StudentAccessD1 = { withSession() {
      if (stage === "session") throw raw;
      return { prepare() {
        if (stage === "prepare") throw raw;
        return { bind() {
          if (stage === "bind") throw raw;
          return { async all<T>() {
            if (stage === "all") throw raw;
            return { success: false, results: [] as T[] };
          } };
        } };
      } };
    } };
    try {
      await new D1StudentAccessGuard(database).authorize(request());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StudentAccessError);
      expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain(raw.message);
    }
  },
);

it("[#842 HTTPS] fails closed without weakening Secure for local fixtures", async () => {
  const fixture = await source();
  await expect(new D1StudentAccessGuard(fixture.database).authorize(new Request("http://nssscdl.test/")))
    .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(fixture.withSession).not.toHaveBeenCalled();
});
