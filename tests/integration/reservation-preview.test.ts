import { describe, expect, it, vi } from "vitest";
import { ReservationPreviewError, ReservationPreviewService, previewReservation, type PreviewReadState } from "../../src/application/reservation-preview";
import { ReservationPreviewHttpAdapter } from "../../src/http/reservation-preview";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { hashToken, source, token } from "./student-session-fixture";

const origin = "https://nssscdl.test";
const path = "/api/me/reservations/preview";
const clearCookie = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
const start = Date.parse("2026-11-15T10:00:00+09:00") / 1000;
const time = start - 86400;
const state = (): PreviewReadState => ({
  studentId: "student", reservationOperationAllowed: true, month: "2026-11", publishedAt: 0,
  standardCountConfig: null, reservations: [], integrity: "consistent",
  slot: { slotId: "target", startsAt: start, endsAt: start + 3600, availability: "enabled",
    occupancies: [], reservations: [], integrity: "consistent" },
});

async function csrf(raw = token, domain = "student-csrf-v1:") {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain + raw));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function setup(applicationOrigin: string | undefined = origin) {
  const fixture = await source();
  const input = state();
  const readPreview = vi.fn(async () => ({ state: input, evaluatedAt: time }));
  const guard = new D1StudentAccessGuard(fixture.database);
  const resolve = vi.spyOn(guard, "resolve");
  const http = new ReservationPreviewHttpAdapter(guard, new ReservationPreviewService({ readPreview }), applicationOrigin);
  return { ...fixture, input, readPreview, resolve, http };
}

async function request(body: BodyInit = '{"slotId":"target"}', headers: Record<string, string> = {}, url = origin + path, method = "POST") {
  return new Request(url, { method, body: method === "GET" ? undefined : body, headers: {
    "content-type": "application/json", cookie: `__Host-student_session=${token}`,
    origin, "x-csrf-token": await csrf(), ...headers,
  } });
}

async function error(response: Response, status: number, code: string, retry: string, message?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBe(status === 401 ? clearCookie : null);
  const body = await response.json() as { error: { code: string; message: string; retry: string } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error)).toEqual(["code", "message", "retry"]);
  expect(body.error).toMatchObject({ code, retry, ...(message ? { message } : {}) });
  for (const secret of [token, await hashToken(), "private-other", "private SQL", "canonicalSnapshot", "sessionId", "tokenHash"]) {
    expect(JSON.stringify(body)).not.toContain(secret);
  }
}

describe("[TC-F-003-01 / TC-F-003-02 partial HTTP] Preview composition", () => {
  it("returns the exact existing core View using only Guard identity and D1 captured time", async () => {
    const fixture = await setup();
    const req = await request();
    req.headers.set("studentId", "private-other");
    req.headers.set("role", "admin");
    req.headers.set("email", "private@example.test");
    const response = await fixture.http.fetch(req);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual(await previewReservation({ studentId: "student" }, fixture.input, time));
    expect(fixture.readPreview).toHaveBeenCalledExactlyOnceWith({ studentId: "student" }, "target");
    expect(fixture.withSession).toHaveBeenCalledExactlyOnceWith("first-primary");
    expect(Object.keys((await fixture.resolve.mock.results[0].value).context)).toEqual(["sessionId", "tokenHash", "studentId"]);
  });
  it("returns additional and classification changes from the existing core without writes", async () => {
    const fixture = await setup();
    Object.assign(fixture.input, { standardCountConfig: { standardCount: 1 }, reservations: [{
      reservationId: "own-later", studentId: "student", slotId: "later", startsAt: start + 86400,
      endsAt: start + 90000, status: "confirmed", automaticClassification: "standard", classification: "standard",
      absent: false, monthlyCountOverride: null, classificationOverride: null,
    }] });
    const first = await fixture.http.fetch(await request());
    expect(await first.json()).toEqual(await previewReservation({ studentId: "student" }, fixture.input, time));
    Object.assign(fixture.input, { standardCountConfig: { standardCount: 0 } });
    const second = await fixture.http.fetch(await request());
    expect(await second.json()).toMatchObject({ previewClassification: "additional",
      classificationChanges: [{ reservationId: "own-later", before: "standard", after: "additional" }] });
  });
});

it.each([
  "", `__Host-student_session=${token}; __Host-student_session=${token}`,
  "__Host-student_session=bad", `__Host-student_session=${"A".repeat(42)}B`,
  `__Host-student_session=${token}=`, `__Host-student_session="${token}"`,
  `__Host-admin_session=${token}`,
])("[#865 Session parse] rejects missing/duplicate/invalid Cookie before CSRF and read", async (cookie) => {
  const fixture = await setup("invalid-origin");
  await error(await fixture.http.fetch(await request(undefined, { cookie, origin: "null" })), 401, "UNAUTHENTICATED", "none");
  expect(fixture.withSession).not.toHaveBeenCalled();
  expect(fixture.readPreview).not.toHaveBeenCalled();
});

it.each(["missing", "expired", "revoked", "suspended", "deleted"])(
  "[TC-F-207-03 partial HTTP] resolves %s to 401 before CSRF", async (mode) => {
    const fixture = await setup("invalid-origin");
    if (mode === "missing") fixture.all.mockResolvedValue({ success: true, results: [] });
    if (mode === "expired") fixture.row.evaluated_at = fixture.row.expires_at;
    if (mode === "revoked") fixture.row.revoked_at = 150;
    if (mode === "suspended") fixture.row.access_state = "suspended";
    if (mode === "deleted") Object.assign(fixture.row, { lifecycle: "deleted", deleted_at: 150 });
    await error(await fixture.http.fetch(await request()), 401, "UNAUTHENTICATED", "none");
    expect(fixture.readPreview).not.toHaveBeenCalled();
  },
);

it("[#865 evaluation order] validates CSRF before forbidden and never reads business state", async () => {
  const fixture = await setup();
  fixture.row.role_scope = "admin";
  await error(await fixture.http.fetch(await request(undefined, { origin: "null" })), 403, "CSRF_INVALID", "reload");
  await error(await fixture.http.fetch(await request()), 403, "FORBIDDEN", "none");
  expect(fixture.readPreview).not.toHaveBeenCalled();
  const brokenConfig = await setup("http://nssscdl.test");
  brokenConfig.row.role_scope = "admin";
  await error(await brokenConfig.http.fetch(await request()), 503, "SERVICE_UNAVAILABLE", "later");
});

it.each([
  { origin: "" }, { origin: "null" }, { origin: "https://other.test" },
  { origin: "https://nssscdl.test.evil.test" }, { origin: origin + "/" },
  { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" },
  { "x-csrf-token": "" }, { "x-csrf-token": "malformed" }, { "x-csrf-token": token },
  { "x-csrf-token": "A".repeat(42) + "B" }, { "x-csrf-token": token + "=" },
])("[#865 CSRF] rejects invalid Origin / Fetch metadata / token", async (headers) => {
  const fixture = await setup();
  await error(await fixture.http.fetch(await request(undefined, headers)), 403, "CSRF_INVALID", "reload",
    "操作を確認できませんでした。画面を再読み込みしてください。");
  expect(fixture.readPreview).not.toHaveBeenCalled();
});

it("[#865 CSRF domain] rejects missing headers, pre-auth domain and another Session token", async () => {
  const fixture = await setup();
  for (const name of ["origin", "x-csrf-token"]) {
    const req = await request();
    req.headers.delete(name);
    req.headers.set("referer", origin + "/student");
    req.headers.set("x-forwarded-host", "nssscdl.test");
    await error(await fixture.http.fetch(req), 403, "CSRF_INVALID", "reload");
  }
  for (const value of [await csrf(token, "student-preauth-csrf-v1:"), await csrf("B".repeat(42) + "A")]) {
    await error(await fixture.http.fetch(await request(undefined, { "x-csrf-token": value })), 403, "CSRF_INVALID", "reload");
  }
  expect(fixture.readPreview).not.toHaveBeenCalled();
  expect((await fixture.http.fetch(await request(undefined, { "sec-fetch-site": "same-origin" }))).status).toBe(200);
});

it.each(["", "bad", "http://nssscdl.test", origin + "/", origin + "/path", origin + "?query", "https://user@nssscdl.test", "HTTPS://NSSSCDL.TEST", origin + ":443"])(
  "[#865 config] fails closed on noncanonical/missing/non-HTTPS Application origin", async (value) => {
    const fixture = await setup(value);
    await error(await fixture.http.fetch(await request()), 503, "SERVICE_UNAVAILABLE", "later");
    expect(fixture.readPreview).not.toHaveBeenCalled();
  },
);

it.each([
  "{}", "null", "[]", '{"slotId":null}', '{"slotId":0}', '{"slotId":true}', '{"slotId":""}',
  '{"slotId":{}}', '{"slotId":["target"]}', '{"slotId":"target",}',
  '{"slotId":"target","slotId":"target"}', '{"slotId":"target","slot\\u0049d":"target"}',
  '{"slotId":"target","studentId":"private-other"}',
  ...["role", "email", "classification", "N", "now"].map((key) => `{"slotId":"target","${key}":"untrusted"}`),
  '{"unknown":"target"}', '{"slotId":"bad\\escape"}', '{"slotId":"target"} trailing',
  '{"slotId":"line\nbreak"}', '\uFEFF{"slotId":"target"}',
])("[#865 request shape] rejects invalid JSON / duplicate / unknown / missing / null fields before Guard", async (body) => {
  const fixture = await setup();
  await error(await fixture.http.fetch(await request(body)), 400, "INVALID_REQUEST", "none", "入力内容を確認してください。");
  expect(fixture.resolve).not.toHaveBeenCalled();
  expect(fixture.readPreview).not.toHaveBeenCalled();
});

it.each([
  [origin + path, "POST", "text/plain"], [origin + path, "POST", "application/json; charset=utf-8"],
  [origin + path + "?a=1", "POST", "application/json"], [origin + path + "?a=1&a=2", "POST", "application/json"],
  [origin + path + "/", "POST", "application/json"], [origin + path, "GET", "application/json"],
  [origin + path, "PUT", "application/json"],
])("[#865 protocol shape] rejects path / method / Query / Content-Type before Guard", async (url, method, contentType) => {
  const fixture = await setup();
  await error(await fixture.http.fetch(await request(undefined, { "content-type": contentType }, url, method)), 400, "INVALID_REQUEST", "none");
  expect(fixture.resolve).not.toHaveBeenCalled();
});

it("[#865 UTF-8 boundary] enforces streamed byte limit, malformed encoding and exact object grammar", async () => {
  const fixture = await setup();
  const minimal = '{"slotId":"target"}';
  expect((await fixture.http.fetch(await request(minimal + " ".repeat(8192 - minimal.length)))).status).toBe(200);
  for (const body of [minimal + " ".repeat(8193 - minimal.length), JSON.stringify({ slotId: "あ".repeat(2800) }),
    new Uint8Array([123, 34, 0xff, 34, 125]), new Uint8Array([0xe3, 0x81])]) {
    await error(await fixture.http.fetch(await request(body)), 400, "INVALID_REQUEST", "none");
  }
  const escaped = await fixture.http.fetch(await request(' \r\n{ "slot\\u0049d" : "tar\\u0067et" }\t'));
  expect(escaped.status).toBe(200);
  const req = await request();
  req.headers.delete("content-type");
  await error(await fixture.http.fetch(req), 400, "INVALID_REQUEST", "none");
  await error(await fixture.http.fetch(await request(undefined, {}, "http://nssscdl.test" + path)), 503, "SERVICE_UNAVAILABLE", "later");
});

it("[#865 streaming body] decodes split UTF-8 and cancels an oversized stream before Guard", async () => {
  const fixture = await setup();
  const bytes = new TextEncoder().encode('{"slotId":"対象"}');
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  expect((await fixture.http.fetch(await request(stream))).status).toBe(200);
  expect(fixture.readPreview).toHaveBeenLastCalledWith({ studentId: "student" }, "対象");
  fixture.resolve.mockClear();
  const cancel = vi.fn();
  const oversized = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(8193));
  }, cancel });
  await error(await fixture.http.fetch(await request(oversized)), 400, "INVALID_REQUEST", "none");
  expect(cancel).toHaveBeenCalledOnce();
  expect(fixture.resolve).not.toHaveBeenCalled();
});

it.each([
  ["unavailable", 409, "RESERVATION_NOT_AVAILABLE", "reload", "この枠は現在予約できません。予定を再読み込みしてください。"],
  ["started", 409, "RESERVATION_WINDOW_CLOSED", "reload", "この枠の予約受付は終了しました。予定を再読み込みしてください。"],
  ["integrity", 503, "INTEGRITY_STATE_UNAVAILABLE", "later", "現在予定情報を利用できません。時間をおいて再度お試しください。"],
  ["read-failure", 503, "SERVICE_UNAVAILABLE", "later", "現在サービスを利用できません。時間をおいて再度お試しください。"],
] as const)("[TC-NF-914-04 partial HTTP] safely maps %s without Cookie removal", async (mode, status, code, retry, message) => {
  const fixture = await setup();
  if (mode === "unavailable") Object.assign(fixture.input, { publishedAt: null });
  if (mode === "started") fixture.readPreview.mockResolvedValue({ state: fixture.input, evaluatedAt: start });
  if (mode === "integrity") fixture.readPreview.mockRejectedValue(new ReservationPreviewError(code));
  if (mode === "read-failure") fixture.readPreview.mockRejectedValue(new Error("private SQL token private-other"));
  await error(await fixture.http.fetch(await request()), status, code, retry, message);
});

it.each(["database", "integrity", "session-digest", "csrf-digest", "preview-digest"])(
  "[#865 failure order] fails closed on %s, retaining Cookie", async (mode) => {
    const fixture = await setup("invalid-origin");
    const req = await request();
    if (mode === "database") fixture.all.mockRejectedValue(new Error("private SQL"));
    if (mode === "integrity") Object.assign(fixture.row, { access_state: null });
    let digest;
    if (mode.endsWith("digest")) {
      const valid = await setup();
      Object.assign(fixture, valid);
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let calls = 0;
      const failureCall = mode === "session-digest" ? 1 : mode === "csrf-digest" ? 2 : 3;
      digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
        if (++calls === failureCall) throw new Error("private SQL token");
        return original(...args);
      });
    }
    let response: Response;
    try { response = await fixture.http.fetch(req); } finally { digest?.mockRestore(); }
    await error(response, 503, mode === "integrity" ? "INTEGRITY_STATE_UNAVAILABLE" : "SERVICE_UNAVAILABLE", "later");
    expect(fixture.readPreview).toHaveBeenCalledTimes(mode === "preview-digest" ? 1 : 0);
  },
);
