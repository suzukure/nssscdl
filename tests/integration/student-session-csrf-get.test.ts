import { expect, it, vi } from "vitest";
import { StudentSessionCsrfGetHttpAdapter } from "../../src/http/student-session-csrf-get";
import { StudentSessionCsrf } from "../../src/http/student-session-csrf";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { source, token } from "./student-session-fixture";

const origin = "https://nssscdl.test";
const path = "/api/auth/student/csrf";
// Independent #865 SHA-256 vector, kept literal rather than derived by issuance.
const expected = "p35EDD5VELmGsajOaMrGPH6WzW74IYQLZ9g-3qTG_74";
const clear = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
const input = () => new Request(origin + path, { headers: { origin, cookie: `__Host-student_session=${token}` } });

function protectedResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect([...response.headers.keys()].filter((key) => key.startsWith("access-control-"))).toEqual([]);
  expect(response.headers.get("set-cookie")).toBe(response.status === 401 ? clear : null);
}

it.each(["origin", "origin+metadata", "metadata"])(
  "[TC-F-207-02 partial HTTP / #896] issues exact session JSON with %s, without renewing Cookie", async (mode) => {
    const fixture = await source();
    const http = new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), origin);
    const request = input();
    if (mode === "metadata") request.headers.delete("origin");
    if (mode !== "origin") request.headers.set("sec-fetch-site", "same-origin");
    const response = await http.fetch(request);
    expect(response.status).toBe(200);
    protectedResponse(response);
    expect(await response.text()).toBe(JSON.stringify({ csrfToken: expected, scope: "session" }));
    expect(fixture.withSession).toHaveBeenCalledExactlyOnceWith("first-primary");
    expect(fixture.all).toHaveBeenCalledTimes(1);
    request.headers.set("origin", origin);
    request.headers.set("x-csrf-token", expected);
    expect(await new StudentSessionCsrf(origin).validate(request)).toBe(true);
  },
);

it.each([
  [null, null], [null, "cross-site"], [null, "same-site"], [null, "none"], [null, "null"],
  ["null", "same-origin"], ["https://evil.test", "same-origin"], [origin + "/", "same-origin"],
  [origin + ".evil.test", "same-origin"], [origin, "same-site"], [origin, "cross-site"],
  [origin, "none"], [origin, "null"], [origin, "same-origin, cross-site"], [origin + ", " + origin, "same-origin"],
])("[#896 Origin boundary] rejects Origin=%s / metadata=%s before resolution", async (header, metadata) => {
  const fixture = await source();
  const request = input();
  if (header === null) request.headers.delete("origin"); else request.headers.set("origin", header);
  if (metadata !== null) request.headers.set("sec-fetch-site", metadata);
  const response = await new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), origin).fetch(request);
  expect(response.status).toBe(403);
  protectedResponse(response);
  expect(await response.json()).toEqual({ error: {
    code: "CSRF_INVALID", message: "操作を確認できませんでした。画面を再読み込みしてください。", retry: "reload",
  } });
  expect(fixture.withSession).not.toHaveBeenCalled();
});

it.each([undefined, "", "http://nssscdl.test", origin + "/", origin + "/path", origin + "?x=1",
  "https://user@nssscdl.test", "https://NSSSCDL.test", origin + ":443", "invalid"])(
  "[TC-NF-914-04 partial HTTP / #896] safely rejects noncanonical configuration %s", async (config) => {
    const fixture = await source();
    const response = await new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), config).fetch(input());
    expect(response.status).toBe(503);
    protectedResponse(response);
    expect(await response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE", retry: "later" } });
    expect(fixture.withSession).not.toHaveBeenCalled();
  },
);

it.each([
  ["http://nssscdl.test" + path, "GET", 503], ["https://evil.test" + path, "GET", 503],
  [origin + path, "POST", 400], [origin + path, "HEAD", 400], [origin + path, "OPTIONS", 400],
  [origin + path + "/", "GET", 400], [origin + "/api/auth/student/other", "GET", 400],
  [origin + path + "?x=1", "GET", 400], [origin + path + "?", "GET", 400],
])("[#896 exact wire] rejects %s %s without token", async (url, method, status) => {
  const fixture = await source();
  const response = await new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), origin)
    .fetch(new Request(url, { method, headers: input().headers }));
  expect(response.status).toBe(status);
  protectedResponse(response);
  const body = await response.text();
  expect(body).not.toContain(expected);
  expect(body).not.toContain(token);
  expect(fixture.withSession).not.toHaveBeenCalled();
});

it.each(["body", "length", "transfer"])("[#896 no body] rejects %s without reading or resolution", async (mode) => {
  const fixture = await source();
  const request = input();
  // Fetch disallows constructing GET bodies. Test-only wire fixture exercises
  // the Adapter's fail-closed body check without changing runtime semantics.
  if (mode === "body") Object.defineProperty(request, "body", { value: new ReadableStream() });
  if (mode === "length") request.headers.set("content-length", "1");
  if (mode === "transfer") request.headers.set("transfer-encoding", "chunked");
  const response = await new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), origin).fetch(request);
  expect(response.status).toBe(400);
  protectedResponse(response);
  expect(fixture.withSession).not.toHaveBeenCalled();
});

it.each(["missing", "preauth", "admin", "duplicate", "malformed", "unknown", "expired", "revoked", "suspended", "deleted"])(
  "[TC-F-207-03 / TC-F-211-02 partial HTTP / #896] denies %s with 401, never falls back to preauth", async (mode) => {
    const fixture = await source();
    const request = input();
    request.headers.set("cookie", `__Host-student_session=${token}; __Host-student_preauth=${token}`);
    if (mode === "missing") request.headers.delete("cookie");
    if (mode === "preauth") request.headers.set("cookie", `__Host-student_preauth=${token}`);
    if (mode === "admin") request.headers.set("cookie", `__Host-admin_session=${token}`);
    if (mode === "duplicate") request.headers.set("cookie", `__Host-student_session=${token}; __Host-student_session=${token}`);
    if (mode === "malformed") request.headers.set("cookie", `__Host-student_session=${"A".repeat(42)}B; __Host-student_preauth=${token}`);
    if (mode === "unknown") fixture.all.mockResolvedValue({ success: true, results: [] });
    if (mode === "expired") fixture.row.evaluated_at = fixture.row.expires_at;
    if (mode === "revoked") fixture.row.revoked_at = 120;
    if (mode === "suspended") fixture.row.access_state = "suspended";
    if (mode === "deleted") Object.assign(fixture.row, { lifecycle: "deleted", deleted_at: 120 });
    const response = await new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), origin).fetch(request);
    expect(response.status).toBe(401);
    protectedResponse(response);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } });
    expect(fixture.all).toHaveBeenCalledTimes(["missing", "preauth", "admin", "duplicate", "malformed"].includes(mode) ? 0 : 1);
  },
);

it.each(["role", "integrity", "duplicate-row", "database", "guard-crypto", "issuance-crypto"])(
  "[TC-NF-914-03 / TC-NF-914-04 partial HTTP / #896] maps %s safely without issuing or clearing Cookie", async (mode) => {
    const fixture = await source();
    if (mode === "role") fixture.row.role_scope = "admin";
    if (mode === "integrity") Object.assign(fixture.row, { access_state: null });
    if (mode === "duplicate-row") fixture.all.mockResolvedValue({ success: true, results: [fixture.row, fixture.row] });
    if (mode === "database") fixture.all.mockRejectedValue(new Error("private SQL credential canary"));
    const digest = vi.spyOn(crypto.subtle, "digest");
    if (mode === "guard-crypto") digest.mockRejectedValueOnce(new Error("private crypto canary"));
    if (mode === "issuance-crypto") fixture.all.mockImplementationOnce(async () => {
      digest.mockRejectedValueOnce(new Error("private crypto canary"));
      return { success: true, results: [fixture.row] };
    });
    try {
      const response = await new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), origin).fetch(input());
      expect(response.status).toBe(mode === "role" ? 403 : 503);
      protectedResponse(response);
      const code = mode === "role" ? "FORBIDDEN" : ["integrity", "duplicate-row"].includes(mode)
        ? "INTEGRITY_STATE_UNAVAILABLE" : "SERVICE_UNAVAILABLE";
      const message = mode === "role" ? "この操作は利用できません。" : code === "INTEGRITY_STATE_UNAVAILABLE"
        ? "現在予定情報を利用できません。時間をおいて再度お試しください。" : "現在サービスを利用できません。時間をおいて再度お試しください。";
      expect(await response.json()).toEqual({ error: { code, message, retry: mode === "role" ? "none" : "later" } });
      expect(digest).toHaveBeenCalledTimes(mode === "issuance-crypto" ? 2 : 1);
    } finally { digest.mockRestore(); }
  },
);

it("[TC-F-211-03 partial HTTP / #896] rereads every request and does not revive revoked Session", async () => {
  const fixture = await source();
  const http = new StudentSessionCsrfGetHttpAdapter(new D1StudentAccessGuard(fixture.database), origin);
  expect((await http.fetch(input())).status).toBe(200);
  fixture.row.revoked_at = 120;
  fixture.row.access_state = "suspended";
  expect((await http.fetch(input())).status).toBe(401);
  fixture.row.access_state = "active";
  expect((await http.fetch(input())).status).toBe(401);
  expect(fixture.withSession).toHaveBeenCalledTimes(3);
});
