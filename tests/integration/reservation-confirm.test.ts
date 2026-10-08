import { describe, expect, it, vi } from "vitest";
import { ReservationConfirmPreparationError, ReservationConfirmPreparationService, type PreparedReservationConfirm } from "../../src/application/reservation-confirm";
import { ReservationConfirmTransactionError } from "../../src/application/reservation-commit-verification";
import { createReservationConfirmWritePlan } from "../../src/application/reservation-confirm-plan";
import { previewReservation, type PreviewReadState } from "../../src/application/reservation-preview";
import { ReservationConfirmHttpAdapter } from "../../src/http/reservation-confirm";
import { StudentSessionCsrf } from "../../src/http/student-session-csrf";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import type { StudentSessionContext } from "../../src/application/student-access-guard";
import { hashToken, source, token } from "./student-session-fixture";

const origin = "https://nssscdl.test";
const path = "/api/me/reservations";
const start = Date.parse("2026-11-15T10:00:00+09:00") / 1000;
const clearCookie = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
const messages = {
  INVALID_REQUEST: [400, "入力内容を確認してください。", "none"],
  UNAUTHENTICATED: [401, "認証が必要です。", "none"],
  FORBIDDEN: [403, "この操作は利用できません。", "none"],
  CSRF_INVALID: [403, "操作を確認できませんでした。画面を再読み込みしてください。", "reload"],
  RESERVATION_STATE_CHANGED: [409, "表示後に状態が変更されました。内容を再確認してください。", "repreview"],
  RESERVATION_NOT_AVAILABLE: [409, "この枠は現在予約できません。予定を再読み込みしてください。", "reload"],
  RESERVATION_WINDOW_CLOSED: [409, "この枠の予約受付は終了しました。予定を再読み込みしてください。", "reload"],
  INTEGRITY_STATE_UNAVAILABLE: [503, "現在予定情報を利用できません。時間をおいて再度お試しください。", "later"],
  SERVICE_UNAVAILABLE: [503, "現在サービスを利用できません。時間をおいて再度お試しください。", "later"],
} as const;

async function setup(applicationOrigin: string | undefined = origin) {
  const fixture = await source();
  const state: PreviewReadState = {
    studentId: "student", reservationOperationAllowed: true, month: "2026-11", publishedAt: 0,
    standardCountConfig: null, reservations: [], integrity: "consistent",
    slot: { slotId: "target", startsAt: start, endsAt: start + 3600, availability: "enabled",
      occupancies: [], reservations: [], integrity: "consistent" },
  };
  let time = start - 86400;
  const readConfirm = vi.fn(async () => ({ state, evaluatedAt: time, canonicalRawReadSet: "private-read-set" }));
  const service = new ReservationConfirmPreparationService({ readConfirm });
  const prepare = vi.spyOn(service, "prepare");
  const guard = new D1StudentAccessGuard(fixture.database);
  const resolve = vi.spyOn(guard, "resolve");
  const expectedStateToken = (await previewReservation({ studentId: "student" }, state, time)).expectedStateToken;
  const committed = {
    reservation: { reservationId: "generated-reservation", startsAt: "2026-11-15T10:00:00+09:00",
      endsAt: "2026-11-15T11:00:00+09:00", reservationState: "confirmed", classification: "standard" },
    slot: { slotId: "target", startsAt: "2026-11-15T10:00:00+09:00", endsAt: "2026-11-15T11:00:00+09:00", view: "reserved_by_me" },
    classificationChanges: [],
  } as const;
  const commit = vi.fn(async (_prepared: PreparedReservationConfirm, _context: StudentSessionContext) => committed);
  const http = new ReservationConfirmHttpAdapter(guard, service, { commit }, applicationOrigin);
  const body = JSON.stringify({ slotId: "target", expectedStateToken });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("student-csrf-v1:" + token));
  const csrf = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function request(input: BodyInit = body, headers: Record<string, string> = {}, url = origin + path, method = "POST") {
    return new Request(url, { method, body: method === "GET" || method === "HEAD" ? undefined : input,
      headers: { "content-type": "application/json", cookie: `__Host-student_session=${token}`,
        origin, "x-csrf-token": csrf, "sec-fetch-site": "same-origin", ...headers } });
  }
  return { ...fixture, guard, service, state, readConfirm, prepare, resolve, commit, committed, expectedStateToken, body, request, http,
    setTime(value: number) { time = value; } };
}

async function error(response: Response, code: keyof typeof messages) {
  const [status, message, retry] = messages[code];
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBe(status === 401 ? clearCookie : null);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ error: { code, message, retry } });
  for (const secret of [token, await hashToken(), "sessionId", "tokenHash", "canonicalRawReadSet", "private-read-set",
    "private SQL", "private-other", "generated-reservation", "REVALIDATION_REQUIRED", "student_sessions", "token_hash"]) {
    expect(body).not.toContain(secret);
  }
}

function needsRevalidation(fixture: Awaited<ReturnType<typeof setup>>) {
  fixture.commit.mockRejectedValue(new ReservationConfirmTransactionError("REVALIDATION_REQUIRED"));
}

describe("[TC-F-003-01 / TC-F-003-06 partial Application / HTTP] #880 Confirm", () => {
  it.each([false, true])("composes resolve → CSRF → preparation → one commit, accepting reversed keys=%s", async (reverse) => {
    const f = await setup();
    const order: string[] = [];
    f.all.mockImplementation(async () => { order.push("resolve"); return { success: true, results: [f.row] }; });
    f.readConfirm.mockImplementation(async () => {
      order.push("prepare"); return { state: f.state, evaluatedAt: start - 86400, canonicalRawReadSet: "private-read-set" };
    });
    f.commit.mockImplementation(async () => { order.push("commit"); return f.committed; });
    const original = StudentSessionCsrf.prototype.validate;
    const validate = vi.spyOn(StudentSessionCsrf.prototype, "validate").mockImplementation(async function (request) {
      order.push("csrf"); return original.call(this, request);
    });
    const req = f.request(reverse ? JSON.stringify({ expectedStateToken: f.expectedStateToken, slotId: "target" }) : undefined);
    req.headers.set("studentId", "private-other");
    let response: Response;
    try { response = await f.http.fetch(req); } finally { validate.mockRestore(); }
    expect(order).toEqual(["resolve", "csrf", "prepare", "commit"]);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual(f.committed);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(req);
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith("target", f.expectedStateToken, { studentId: "student" });
    const prepared = await f.prepare.mock.results[0].value;
    const access = await f.resolve.mock.results[0].value;
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(prepared, access.context);
    expect(f.commit.mock.calls[0][0]).toBe(prepared);
    expect(f.commit.mock.calls[0][1]).toBe(access.context);
  });
  it("returns the final Port result including classification changes without delivery fields", async () => {
    const f = await setup();
    Object.assign(f.state, { standardCountConfig: { standardCount: 1 } });
    Object.assign(f.state, { reservations: [{ reservationId: "later-r", studentId: "student", slotId: "later",
      startsAt: start + 86400, endsAt: start + 90000, status: "confirmed", automaticClassification: "standard",
      classification: "standard", absent: false, monthlyCountOverride: null, classificationOverride: null }] });
    const view = await previewReservation({ studentId: "student" }, f.state, start - 86400);
    const commit = vi.fn(async (prepared: PreparedReservationConfirm, context: StudentSessionContext) => createReservationConfirmWritePlan(prepared, context.studentId,
      { commandId: "command", reservationId: "reservation", occupancyId: "occupancy", auditId: "audit",
        reservationConfirmationIntentId: "confirmation", classificationChangeIntentIds: ["change"] }).committedResult);
    const http = new ReservationConfirmHttpAdapter(f.guard, f.service, { commit }, origin);
    const response = await http.fetch(f.request(JSON.stringify({ slotId: "target", expectedStateToken: view.expectedStateToken })));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ...f.committed, reservation: { ...f.committed.reservation, reservationId: "reservation" },
      classificationChanges: [{ reservationId: "later-r", startsAt: "2026-11-16T10:00:00+09:00", before: "standard", after: "additional" }] });
    expect(commit).toHaveBeenCalledOnce();
  });
});

it.each([
  "", "{}", "null", "[]", "1", "true", '{"slotId":"target"}', '{"expectedStateToken":"v1.opaque"}',
  ...["slotId", "expectedStateToken"].flatMap((key) => [null, [], {}, 1, false, ""].map((value) =>
    JSON.stringify({ slotId: "target", expectedStateToken: "v1.opaque", [key]: value }))),
  '{"slotId":"a","slotId":"b"}', '{"slotId":"a","slot\\u0049d":"b"}',
  '{"expectedStateToken":"a","expectedState\\u0054oken":"b"}',
  '{"slotId":"a","expectedStateToken":"b","expectedStateToken":"c"}',
  ...["studentId", "sessionId", "tokenHash", "classification", "N", "now", "reservationId"].map((key) =>
    JSON.stringify({ slotId: "target", expectedStateToken: "v1.opaque", [key]: "untrusted" })),
  '{"unknown":"target","expectedStateToken":"v1.opaque"}',
  '{"slotId":"bad\\escape","expectedStateToken":"v1.opaque"}',
  '{"slotId":"target","expectedStateToken":"v1.opaque",}',
  '{"slotId":"target","expectedStateToken":"v1.opaque"} trailing',
  '{"slotId":"line\nbreak","expectedStateToken":"v1.opaque"}',
  '\uFEFF{"slotId":"target","expectedStateToken":"v1.opaque"}',
])("[#880 strict shape] rejects invalid fields / JSON before Session resolution", async (body) => {
  const f = await setup();
  await error(await f.http.fetch(f.request(body)), "INVALID_REQUEST");
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
});

it.each([
  [path, "GET", "application/json"], [path, "PUT", "application/json"], [path, "DELETE", "application/json"],
  [path + "/", "POST", "application/json"], [path + "/preview", "POST", "application/json"],
  [path + "?a=1", "POST", "application/json"], [path + "?a=1&a=2", "POST", "application/json"],
  [path, "POST", "text/plain"], [path, "POST", "application/json; charset=utf-8"],
])("[#880 protocol shape] rejects method / path / query / content-type before Guard", async (url, method, contentType) => {
  const f = await setup();
  await error(await f.http.fetch(f.request(undefined, { "content-type": contentType }, origin + url, method)), "INVALID_REQUEST");
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
});

it("[#880 bounded UTF-8] handles the byte boundary, split UTF-8, escapes and stream cancellation", async () => {
  const f = await setup();
  expect((await f.http.fetch(f.request(f.body + " ".repeat(8192 - f.body.length)))).status).toBe(201);
  f.resolve.mockClear();
  for (const body of [f.body + " ".repeat(8193 - f.body.length),
    JSON.stringify({ slotId: "あ".repeat(2800), expectedStateToken: f.expectedStateToken }),
    new Uint8Array([0xff]), new Uint8Array([0xe3, 0x81])]) {
    await error(await f.http.fetch(f.request(body)), "INVALID_REQUEST");
  }
  expect(f.resolve).not.toHaveBeenCalled();
  const req = f.request(); req.headers.delete("content-type");
  await error(await f.http.fetch(req), "INVALID_REQUEST");
  await error(await f.http.fetch(new Request(origin + path, { method: "POST", headers: { "content-type": "application/json" } })), "INVALID_REQUEST");
  const cancel = vi.fn();
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel });
  await error(await f.http.fetch(f.request(oversized)), "INVALID_REQUEST");
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.resolve).not.toHaveBeenCalled();
  const escaped = ` \r\n{"expectedState\\u0054oken":"${f.expectedStateToken}","slot\\u0049d":"tar\\u0067et"}\t`;
  expect((await f.http.fetch(f.request(escaped))).status).toBe(201);
  const bytes = new TextEncoder().encode(JSON.stringify({ slotId: "対象", expectedStateToken: f.expectedStateToken }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close();
  } });
  // Identity/slot mismatch is a real core error after successful UTF-8 parsing.
  await f.http.fetch(f.request(stream));
  expect(f.prepare).toHaveBeenLastCalledWith("対象", f.expectedStateToken, { studentId: "student" });
});

it("[#880 HTTPS] rejects HTTP without resolving Session", async () => {
  const f = await setup();
  await error(await f.http.fetch(f.request(undefined, {}, "http://nssscdl.test" + path)), "SERVICE_UNAVAILABLE");
  expect(f.resolve).not.toHaveBeenCalled();
});

it("[TC-F-207-03 partial HTTP] resolves unauthenticated before CSRF and clears only the Session cookie", async () => {
  const f = await setup("invalid-origin"); f.row.revoked_at = 150;
  await error(await f.http.fetch(f.request()), "UNAUTHENTICATED");
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
});

it.each([{ origin: "null" }, { origin: "https://other.test" }, { origin: origin + "/" },
  { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" },
  { "x-csrf-token": "" }, { "x-csrf-token": token }])("[#880 CSRF] rejects before preparation and commit", async (headers) => {
  const f = await setup();
  await error(await f.http.fetch(f.request(undefined, headers)), "CSRF_INVALID");
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
});

it("[#880 authorization order] checks CSRF on forbidden Sessions and missing headers/config", async () => {
  const f = await setup(); f.row.role_scope = "admin";
  await error(await f.http.fetch(f.request(undefined, { origin: "null" })), "CSRF_INVALID");
  await error(await f.http.fetch(f.request()), "FORBIDDEN");
  for (const header of ["origin", "x-csrf-token"]) {
    const req = f.request(); req.headers.delete(header);
    await error(await f.http.fetch(req), "CSRF_INVALID");
  }
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  const bad = await setup("invalid-origin");
  await error(await bad.http.fetch(bad.request()), "SERVICE_UNAVAILABLE");
  expect(bad.prepare).not.toHaveBeenCalled(); expect(bad.commit).not.toHaveBeenCalled();
});

it.each(["INVALID_REQUEST", "RESERVATION_STATE_CHANGED", "RESERVATION_NOT_AVAILABLE", "RESERVATION_WINDOW_CLOSED",
  "INTEGRITY_STATE_UNAVAILABLE", "SERVICE_UNAVAILABLE"] as const)("[TC-NF-914-04 partial HTTP] maps preparation %s exactly", async (code) => {
  const f = await setup();
  if (code === "INVALID_REQUEST") f.body = JSON.stringify({ slotId: "target", expectedStateToken: "v2.opaque" });
  if (code === "RESERVATION_STATE_CHANGED") Object.assign(f.state, { standardCountConfig: { standardCount: 0 } });
  if (code === "RESERVATION_NOT_AVAILABLE") { Object.assign(f.state, { publishedAt: null }); Object.assign(f.state, { standardCountConfig: { standardCount: 0 } }); }
  if (code === "RESERVATION_WINDOW_CLOSED") { f.setTime(start); Object.assign(f.state, { standardCountConfig: { standardCount: 0 } }); }
  if (code === "INTEGRITY_STATE_UNAVAILABLE") Object.assign(f.state, { integrity: "inconsistent" });
  if (code === "SERVICE_UNAVAILABLE") f.readConfirm.mockRejectedValue(new Error("private SQL student_sessions.token_hash private-other"));
  await error(await f.http.fetch(f.request(f.body)), code);
  expect(f.commit).not.toHaveBeenCalled(); expect(f.resolve).toHaveBeenCalledOnce();
  if (code === "INVALID_REQUEST") expect(f.readConfirm).not.toHaveBeenCalled();
});

it.each(["INTEGRITY_STATE_UNAVAILABLE", "SERVICE_UNAVAILABLE", "unknown", "lookalike"] as const)(
  "[#880 transaction errors] %s never triggers fresh revalidation", async (mode) => {
    const f = await setup();
    const failure = mode === "unknown" ? new Error("private SQL") : mode === "lookalike" ? { code: "REVALIDATION_REQUIRED" } :
      new ReservationConfirmTransactionError(mode);
    f.commit.mockRejectedValue(failure);
    await error(await f.http.fetch(f.request()), mode === "INTEGRITY_STATE_UNAVAILABLE" ? mode : "SERVICE_UNAVAILABLE");
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.commit).toHaveBeenCalledOnce();
  },
);

it.each(["revoked", "forbidden", "database", "integrity"])("[#880 fresh Session] safely classifies %s before business read", async (mode) => {
  const f = await setup(); needsRevalidation(f);
  f.commit.mockImplementation(async () => {
    if (mode === "revoked") f.row.revoked_at = 150;
    if (mode === "forbidden") f.row.role_scope = "admin";
    if (mode === "database") f.all.mockRejectedValue(new Error("private SQL"));
    if (mode === "integrity") f.row.access_state = "invalid";
    throw new ReservationConfirmTransactionError("REVALIDATION_REQUIRED");
  });
  const req = f.request();
  await error(await f.http.fetch(req), mode === "revoked" ? "UNAUTHENTICATED" : mode === "forbidden" ? "FORBIDDEN" :
    mode === "integrity" ? "INTEGRITY_STATE_UNAVAILABLE" : "SERVICE_UNAVAILABLE");
  expect(f.resolve).toHaveBeenCalledTimes(2); expect(f.resolve).toHaveBeenNthCalledWith(2, req);
  expect(f.withSession).toHaveBeenCalledTimes(2); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.commit).toHaveBeenCalledOnce();
});

it.each(["RESERVATION_STATE_CHANGED", "RESERVATION_NOT_AVAILABLE", "RESERVATION_WINDOW_CLOSED",
  "INTEGRITY_STATE_UNAVAILABLE", "SERVICE_UNAVAILABLE", "still-valid"] as const)("[#880 fresh preparation] classifies %s with no second write", async (mode) => {
  const f = await setup();
  f.commit.mockImplementation(async () => {
    if (mode === "RESERVATION_STATE_CHANGED") Object.assign(f.state, { standardCountConfig: { standardCount: 0 } });
    if (mode === "RESERVATION_NOT_AVAILABLE") { Object.assign(f.state, { publishedAt: null }); Object.assign(f.state, { standardCountConfig: { standardCount: 0 } }); }
    if (mode === "RESERVATION_WINDOW_CLOSED") { f.setTime(start); Object.assign(f.state, { standardCountConfig: { standardCount: 0 } }); }
    if (mode === "INTEGRITY_STATE_UNAVAILABLE") Object.assign(f.state, { integrity: "inconsistent" });
    if (mode === "SERVICE_UNAVAILABLE") f.readConfirm.mockRejectedValue(new Error("private SQL"));
    throw new ReservationConfirmTransactionError("REVALIDATION_REQUIRED");
  });
  const validate = vi.spyOn(StudentSessionCsrf.prototype, "validate");
  try {
    await error(await f.http.fetch(f.request()), mode === "still-valid" ? "SERVICE_UNAVAILABLE" : mode);
    expect(validate).toHaveBeenCalledOnce();
  } finally { validate.mockRestore(); }
  expect(f.resolve).toHaveBeenCalledTimes(2); expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.prepare).toHaveBeenNthCalledWith(2, "target", f.expectedStateToken, { studentId: "student" });
  expect(f.commit).toHaveBeenCalledOnce();
});

it("[#880 fresh identity] uses the freshly resolved Student only for read-only classification", async () => {
  const f = await setup();
  f.commit.mockImplementation(async () => { f.row.student_id = "fresh-student";
    throw new ReservationConfirmTransactionError("REVALIDATION_REQUIRED"); });
  f.prepare.mockResolvedValueOnce(await new ReservationConfirmPreparationService({ readConfirm: f.readConfirm })
    .prepare("target", f.expectedStateToken, { studentId: "student" }));
  f.prepare.mockRejectedValueOnce(new ReservationConfirmPreparationError("RESERVATION_STATE_CHANGED"));
  await error(await f.http.fetch(f.request()), "RESERVATION_STATE_CHANGED");
  expect(f.prepare).toHaveBeenNthCalledWith(2, "target", f.expectedStateToken, { studentId: "fresh-student" });
  expect(f.commit).toHaveBeenCalledOnce();
});

it.each(["database", "integrity", "unexpected-preparation", "unexpected-fresh-preparation"])(
  "[TC-NF-914-04 partial HTTP] fails closed on %s without reflecting internal cause", async (mode) => {
    const f = await setup();
    if (mode === "database") f.all.mockRejectedValue(new Error("private SQL"));
    if (mode === "integrity") f.row.access_state = "invalid";
    if (mode === "unexpected-preparation") f.prepare.mockRejectedValue(new Error("private SQL"));
    if (mode === "unexpected-fresh-preparation") {
      needsRevalidation(f);
      f.prepare.mockResolvedValueOnce(await new ReservationConfirmPreparationService({ readConfirm: f.readConfirm })
        .prepare("target", f.expectedStateToken, { studentId: "student" }));
      f.prepare.mockRejectedValueOnce(new ReservationConfirmPreparationError("INVALID_REQUEST"));
    }
    await error(await f.http.fetch(f.request()), mode === "integrity" ? "INTEGRITY_STATE_UNAVAILABLE" : "SERVICE_UNAVAILABLE");
    expect(f.commit).toHaveBeenCalledTimes(mode === "unexpected-fresh-preparation" ? 1 : 0);
    expect(f.prepare).toHaveBeenCalledTimes(mode === "database" || mode === "integrity" ? 0 : mode === "unexpected-preparation" ? 1 : 2);
  },
);
