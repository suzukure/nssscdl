import { afterEach, expect, it, vi } from "vitest";
import { createReservationStudentService, type ReservationStudentConfig } from "../fixtures/reservation-student-service";
import { createReadOnlyStudentService } from "../fixtures/read-only-student-service";
import * as readOnlyModule from "../fixtures/read-only-student-service";
import { D1ReservationPreviewRepository, reservationCaptureSql } from "../../src/infrastructure/d1-reservation-preview";
import { D1ReservationConfirmExecutor } from "../../src/infrastructure/d1-reservation-confirm";
import { D1ReservationCommitVerifier } from "../../src/infrastructure/d1-reservation-commit-verification";
import { D1ReservationConfirmTransaction } from "../../src/infrastructure/d1-reservation-confirm-transaction";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import { ReservationPreviewService } from "../../src/application/reservation-preview";
import { createStudentSessionCsrfToken } from "../../src/http/student-session-csrf";
import { source, token, hashToken } from "./student-session-fixture";

const origin = "https://nssscdl.test";
const previewPath = "/api/me/reservations/preview";
const confirmPath = "/api/me/reservations";
const routes = [
  ["GET", "/api/me/schedule-months/2026-11"], ["GET", confirmPath], ["GET", "/api/auth/student/csrf"],
  ["POST", previewPath], ["POST", confirmPath],
] as const;
const clearCookie = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const access = await source();
  // Fixed row projection from D1 design §3 / §5; no SQL execution or persistence.
  const target = { slotId: "target", month: "2026-11", publishedAt: 0,
    startsAt: 1794704400, endsAt: 1794708000, lessonDate: "2026-11-15", startTime: "10:00", endTime: "11:00", availability: "enabled" };
  const captured = { evaluated_at: 1794272400, student_id: "student",
    access_json: '[{"lifecycle":"active","deletedAt":null,"accessState":"active"}]',
    target_json: JSON.stringify(target), config_json: "[]", reservations_json: "[]",
    bad_future: 0, foreign_occupied: 0, occupancies_json: "[]", canonical_raw_read_set: '{"private-read-set":true}' };
  const capture = vi.fn(async () => ({ success: true, results: [captured] }));
  const first = vi.fn(async () => ({ reservation: null, occupancy: null, audit: null, intents: "[null]",
    outbox: "[null]", reclassifications: "[]", command_guard_present: 0, audit_count: 0, new_reservation_intent_count: 0 }));
  type Statement = { query: string; values: unknown[]; bind(...values: unknown[]): Statement;
    all(): Promise<unknown>; first: typeof first };
  const prepare = vi.fn((query: string): Statement => ({ query, values: [],
    bind(...values) { this.values = values; return this; },
    all: query === reservationCaptureSql() ? capture : access.all, first }));
  // Synthetic acknowledgement only; this does not establish DB atomic success.
  const batch = vi.fn(async (statements: Statement[]) => statements.map(() => ({ success: true })));
  const withSession = vi.fn<(constraint: "first-primary") => { prepare: typeof prepare; batch: typeof batch }>(() => ({ prepare, batch }));
  const database = { prepare, withSession } as unknown as ReservationStudentConfig["database"];
  const cursorKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const config = { database, cursorKey, applicationOrigin: origin };
  const service = createReservationStudentService(config);
  async function request(path = previewPath, body = '{"slotId":"target"}', headers: Record<string, string> = {}, method = "POST", base = origin) {
    return new Request(base + path, { method, body: method === "GET" || method === "HEAD" ? undefined : body,
      headers: { "content-type": "application/json", cookie: `__Host-student_session=${token}`,
        origin, "x-csrf-token": await createStudentSessionCsrfToken(token), "sec-fetch-site": "same-origin", ...headers } });
  }
  async function preview() {
    const response = await service.fetch(await request());
    expect(response.status).toBe(200);
    return await response.json() as { expectedStateToken: string };
  }
  return { ...access, captured, capture, first, prepare, batch, withSession, config, service, request, preview };
}

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBe(status === 401 ? clearCookie : null);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ error: { code } });
  for (const secret of [token, await hashToken(), "private SQL", "private-read-set", "sessionId", "tokenHash", "canonicalRawReadSet"]) {
    expect(body).not.toContain(secret);
  }
}

it("[#928 / TC-F-003-01 partial synthetic] composes real Preview/preparation/executor/transaction with one batch", async () => {
  const f = await setup();
  const previewRead = vi.spyOn(D1ReservationPreviewRepository.prototype, "readPreview");
  const executePreview = vi.spyOn(ReservationPreviewService.prototype, "execute");
  const prepare = vi.spyOn(ReservationConfirmPreparationService.prototype, "prepare");
  const commit = vi.spyOn(D1ReservationConfirmTransaction.prototype, "commit");
  const execute = vi.spyOn(D1ReservationConfirmExecutor.prototype, "execute");
  const verify = vi.spyOn(D1ReservationCommitVerifier.prototype, "verify");
  const viewResponse = await f.service.fetch(await f.request());
  const view = await viewResponse.json() as { expectedStateToken: string };
  expect(viewResponse.status).toBe(200);
  expect(viewResponse.headers.get("cache-control")).toBe("no-store");
  expect(view).toEqual({ slot: { slotId: "target", startsAt: "2026-11-15T10:00:00+09:00", endsAt: "2026-11-15T11:00:00+09:00" },
    previewClassification: "standard", classificationChanges: [], expectedStateToken: expect.stringMatching(/^v1\./) });
  expect(previewRead).toHaveBeenCalledExactlyOnceWith({ studentId: "student" }, "target");
  expect(executePreview).toHaveBeenCalledOnce();
  expect(f.batch).not.toHaveBeenCalled();
  const response = await f.service.fetch(await f.request(confirmPath,
    JSON.stringify({ slotId: "target", expectedStateToken: view.expectedStateToken }), { studentId: "untrusted-other" }));
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toEqual({
    reservation: { reservationId: expect.any(String), startsAt: "2026-11-15T10:00:00+09:00", endsAt: "2026-11-15T11:00:00+09:00", reservationState: "confirmed", classification: "standard" },
    slot: { slotId: "target", startsAt: "2026-11-15T10:00:00+09:00", endsAt: "2026-11-15T11:00:00+09:00", view: "reserved_by_me" }, classificationChanges: [],
  });
  expect(prepare).toHaveBeenCalledExactlyOnceWith("target", view.expectedStateToken, { studentId: "student" });
  expect(commit).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
  expect(commit.mock.calls[0][0]).toBe(await prepare.mock.results[0].value);
  expect(execute.mock.calls[0][2]).toBe(commit.mock.calls[0][1]);
  expect(commit.mock.calls[0][1]).toEqual({ sessionId: "session", tokenHash: await hashToken(), studentId: "student" });
  expect(f.batch).toHaveBeenCalledOnce();
  expect(f.batch.mock.calls[0][0].map((s) => s.query).join("\n")).toMatch(/INSERT INTO student_reservations/);
  expect(f.first).not.toHaveBeenCalled();
  expect(f.withSession.mock.calls.every((args) => args[0] === "first-primary")).toBe(true);
});

it("[#928 before batch] preparation of write statements fails closed without verification or retry", async () => {
  const f = await setup();
  const view = await f.preview();
  const original = f.prepare.getMockImplementation()!;
  f.prepare.mockImplementation((query) => {
    if (query.startsWith("INSERT INTO command_guards")) throw new Error("private SQL");
    return original(query);
  });
  await error(await f.service.fetch(await f.request(confirmPath,
    JSON.stringify({ slotId: "target", expectedStateToken: view.expectedStateToken }))), 503, "SERVICE_UNAVAILABLE");
  expect(f.batch).not.toHaveBeenCalled(); expect(f.first).not.toHaveBeenCalled();
});

it.each(["not-applied", "read-failure", "inconsistent"])("[#928 unknown outcome] %s uses real verifier once and never retries", async (mode) => {
  const f = await setup();
  const view = await f.preview();
  const ids = vi.spyOn(crypto, "randomUUID");
  const commit = vi.spyOn(D1ReservationConfirmTransaction.prototype, "commit");
  const verify = vi.spyOn(D1ReservationCommitVerifier.prototype, "verify");
  const prepare = vi.spyOn(ReservationConfirmPreparationService.prototype, "prepare");
  f.batch.mockRejectedValue(new Error("private SQL"));
  if (mode === "read-failure") f.first.mockRejectedValue(new Error("private SQL"));
  if (mode === "inconsistent") f.first.mockResolvedValue({ reservation: null, occupancy: null, audit: null, intents: "[null]",
    outbox: "[null]", reclassifications: "[]", command_guard_present: 1, audit_count: 0, new_reservation_intent_count: 0 });
  await error(await f.service.fetch(await f.request(confirmPath,
    JSON.stringify({ slotId: "target", expectedStateToken: view.expectedStateToken }))), 503,
    mode === "inconsistent" ? "INTEGRITY_STATE_UNAVAILABLE" : "SERVICE_UNAVAILABLE");
  expect(f.batch).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce();
  expect(f.first).toHaveBeenCalledOnce(); expect(ids).toHaveBeenCalledTimes(5);
  expect(prepare).toHaveBeenCalledTimes(mode === "not-applied" ? 2 : 1);
});

it.each(routes.filter(([method]) => method === "GET"))("[#928 delegation] %s %s preserves existing child Response", async (method, path) => {
  const f = await setup();
  const delegated = createReadOnlyStudentService(f.config);
  const fetch = vi.spyOn(delegated, "fetch");
  const factory = vi.spyOn(readOnlyModule, "createReadOnlyStudentService").mockReturnValue(delegated);
  const service = createReservationStudentService(f.config);
  const req = await f.request(path, "", { cookie: "" }, method);
  const response = await service.fetch(req);
  expect(factory).toHaveBeenCalledExactlyOnceWith(f.config);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(req);
  expect(response).toBe(await fetch.mock.results[0].value);
  await error(response, 401, "UNAUTHENTICATED");
  if (path.endsWith("csrf")) expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(f.batch).not.toHaveBeenCalled();
});

it.each(["missing", "origin", "database", "prepare", "session", "batch", "throw-session", "key", "extractable", "sha1", "verify", "aes"])(
  "[#928 invalid trusted config] %s disables all routes before database IO", async (mode) => {
    const f = await setup();
    let config: { -readonly [K in keyof ReservationStudentConfig]?: ReservationStudentConfig[K] } | undefined = { ...f.config };
    if (mode === "missing") config = undefined;
    else if (mode === "origin") config.applicationOrigin = origin + "/";
    else if (mode === "database") config.database = [] as unknown as ReservationStudentConfig["database"];
    else if (mode === "prepare") config.database = { withSession: f.withSession } as unknown as ReservationStudentConfig["database"];
    else if (mode === "session") f.withSession.mockReturnValue(null as unknown as ReturnType<typeof f.withSession>);
    else if (mode === "batch") f.withSession.mockReturnValue({ prepare: f.prepare } as ReturnType<typeof f.withSession>);
    else if (mode === "throw-session") f.withSession.mockImplementation(() => { throw new Error("private SQL"); });
    else if (mode === "key") config.cursorKey = {} as CryptoKey;
    else if (mode === "aes") config.cursorKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    else config.cursorKey = await crypto.subtle.generateKey({ name: "HMAC", hash: mode === "sha1" ? "SHA-1" : "SHA-256" },
      mode === "extractable", mode === "verify" ? ["sign", "verify"] : ["sign"]);
    const service = createReservationStudentService(config);
    for (const [method, path] of routes) await error(await service.fetch(await f.request(path, undefined, {}, method)), 503, "SERVICE_UNAVAILABLE");
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
  },
);

it.each([
  ["GET", previewPath, origin], ["PUT", confirmPath, origin], ["DELETE", confirmPath, origin],
  ["HEAD", confirmPath, origin], ["OPTIONS", previewPath, origin], ["POST", confirmPath + "/", origin],
  ["GET", "/unknown", origin], ["POST", "/api/auth/student/csrf", origin],
  ["POST", "/api/me/schedule-months/2026-11", origin], ["GET", "/api/me/schedule-months/2026-11/extra", origin],
  ["POST", previewPath, "http://nssscdl.test"], ["POST", previewPath, "https://other.test"],
  ["POST", previewPath + "#fragment", origin],
])("[#928 routing] %s %s at %s fails closed without reads or writes", async (method, path, base) => {
  const f = await setup();
  await error(await f.service.fetch(await f.request(path, undefined, { host: "nssscdl.test", forwarded: "host=nssscdl.test" }, method, base)), 503, "SERVICE_UNAVAILABLE");
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
});

it("[#928 malformed URL] returns fixed 503 even when parsing the failure route is impossible", async () => {
  const f = await setup();
  const req = await f.request(); Object.defineProperty(req, "url", { value: "malformed", configurable: true });
  await error(await f.service.fetch(req), 503, "SERVICE_UNAVAILABLE");
  await error(await createReservationStudentService().fetch(req), 503, "SERVICE_UNAVAILABLE");
  Object.defineProperty(req, "url", { value: "https://user:password@nssscdl.test" + previewPath });
  await error(await f.service.fetch(req), 503, "SERVICE_UNAVAILABLE");
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
});

it.each([previewPath, confirmPath])("[#928 validation/auth] %s retains child order, errors and no-write-on-failure", async (path) => {
  const f = await setup();
  const view = await f.preview();
  const body = path === previewPath ? '{"slotId":"target"}' : JSON.stringify({ slotId: "target", expectedStateToken: view.expectedStateToken });
  f.prepare.mockClear();
  await error(await f.service.fetch(await f.request(path, body, { "content-type": "text/plain" })), 400, "INVALID_REQUEST");
  await error(await f.service.fetch(await f.request(path, '{"slotId":"target","studentId":"other"}')), 400, "INVALID_REQUEST");
  await error(await f.service.fetch(await f.request(path + "?origin=" + origin, body)), 400, "INVALID_REQUEST");
  expect(f.prepare).not.toHaveBeenCalled();
  await error(await f.service.fetch(await f.request(path, body, { cookie: "", origin: "null" })), 401, "UNAUTHENTICATED");
  f.row.role_scope = "admin";
  await error(await f.service.fetch(await f.request(path, body, { origin: "null" })), 403, "CSRF_INVALID");
  await error(await f.service.fetch(await f.request(path, body)), 403, "FORBIDDEN");
  f.row.role_scope = "student";
  f.captured.foreign_occupied = 1;
  await error(await f.service.fetch(await f.request(path, body)), 409, "RESERVATION_NOT_AVAILABLE");
  f.captured.foreign_occupied = 0;
  f.capture.mockRejectedValue(new Error("private SQL"));
  await error(await f.service.fetch(await f.request(path, body)), 503, "SERVICE_UNAVAILABLE");
  expect(f.batch).not.toHaveBeenCalled(); expect(f.first).not.toHaveBeenCalled();
});
