import { exports } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { createReservationEvaluationWorker } from "../evaluation/reservation-worker";
import configText from "../evaluation/wrangler.reservation.jsonc?raw";
import workerSource from "../evaluation/reservation-worker.ts?raw";
import { verifyReservationConfig } from "../evaluation/reservation-config";
import type { ReservationStudentConfig } from "../fixtures/reservation-student-service";
import { reservationCaptureSql } from "../../src/infrastructure/d1-reservation-preview";
import { createStudentSessionCsrfToken } from "../../src/http/student-session-csrf";
import { source, token, hashToken } from "./student-session-fixture";

const origin = "https://127.0.0.1:8789";
const previewPath = "/api/me/reservations/preview";
const confirmPath = "/api/me/reservations";
const routes = [["GET", "/api/me/schedule-months/2026-11"], ["GET", confirmPath],
  ["GET", "/api/auth/student/csrf"], ["POST", previewPath], ["POST", confirmPath]] as const;
const assets = ["/student", "/student.css", "/student.js", "/view.js", "/controller.js", "/model.js"];
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
    all: query === reservationCaptureSql() ? capture
      : query.includes("FROM schedule_months AS m") ? async () => ({ success: true, results: [{ month_key: "2026-11", published_at: 0, slot_id: null }] })
      : query.includes("FROM student_reservations AS r") ? async () => ({ success: true, results: [] }) : access.all, first }));
  // Synthetic acknowledgement only; this does not establish DB atomic success.
  const batch = vi.fn(async (statements: Statement[]) => statements.map(() => ({ success: true })));
  const withSession = vi.fn<(constraint: "first-primary") => { prepare: typeof prepare; batch: typeof batch }>(() => ({ prepare, batch }));
  const database = { prepare, withSession } as unknown as ReservationStudentConfig["database"];
  const fetchAsset = vi.fn(async (request: Request) => {
    expect(request.headers.has("cookie")).toBe(false);
    expect(request.headers.has("x-csrf-token")).toBe(false);
    expect(request.method).toBe("GET");
    return new Response("built fixture", { headers: { "set-cookie": "private-canary" } });
  });
  const env = { ASSETS: { fetch: fetchAsset }, EVALUATION_BOOKING_DB: database };
  const worker = createReservationEvaluationWorker();
  async function request(path = previewPath, body = '{"slotId":"target"}', headers: Record<string, string> = {}, method = "POST", base = origin) {
    return new Request(base + path, { method, body: method === "GET" || method === "HEAD" ? undefined : body,
      headers: { "content-type": "application/json", cookie: `__Host-student_session=${token}`,
        origin, "x-csrf-token": await createStudentSessionCsrfToken(token), "sec-fetch-site": "same-origin", ...headers } });
  }
  const fetch = async (path = previewPath, body?: string, headers?: Record<string, string>, method = "POST", base = origin) =>
    worker.fetch(await request(path, body, headers, method, base), env);
  return { ...access, captured, capture, prepare, batch, first, env, fetchAsset, worker, request, fetch };
}

async function error(response: Response, status = 503, code = "SERVICE_UNAVAILABLE", retry = "later") {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.has("location")).toBe(false);
  expect(response.headers.has("set-cookie")).toBe(status === 401);
  if (status === 401) expect(response.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ error: { code, retry } });
  for (const secret of [token, await hashToken(), "private SQL", "private-read-set", "private-canary", "tokenHash"]) expect(body).not.toContain(secret);
}

it("[#929 static isolation] closed local config rejects public, remote, port, binding and override mutations", () => {
  const config = JSON.parse(configText);
  expect(() => verifyReservationConfig(config)).not.toThrow();
  const mutations = [
    { workers_dev: true }, { preview_urls: true }, { routes: ["example.test/*"] }, { route: "example.test/*" },
    { dev: { ...config.dev, ip: "0.0.0.0" } }, { dev: { ...config.dev, port: 8788 } },
    { dev: { ...config.dev, local_protocol: "http" } }, { vars: { identity: "other" } }, { env: { production: {} } },
    { r2_buckets: [{ binding: "REMOTE" }] }, { services: [{ binding: "REMOTE" }] },
    { d1_databases: [...config.d1_databases, config.d1_databases[0]] },
    { d1_databases: [{ ...config.d1_databases[0], remote: true }] },
    { d1_databases: [{ ...config.d1_databases[0], binding: "EVALUATION_READ_DB" }] },
    { assets: { ...config.assets, run_worker_first: false } }, { main: "../../src/index.ts" },
  ];
  for (const mutation of mutations) expect(() => verifyReservationConfig({ ...config, ...mutation })).toThrow("BOOKING_EVALUATION_CONFIG_INVALID");
  expect(workerSource).not.toMatch(/exportKey|importKey|console\.|process\.env|\.vars|\bscheduled\s*[:(]|trusted-student-seed|src\/web/);
});

it("[#929 HTTP synthetic partial] real CSRF GET and Preview/Confirm Adapters reach one synthetic batch", async () => {
  const f = await setup();
  const csrf = await f.fetch("/api/auth/student/csrf", undefined, {}, "GET");
  expect(csrf.status).toBe(200);
  expect(csrf.headers.get("cache-control")).toBe("no-store");
  expect(csrf.headers.get("referrer-policy")).toBe("no-referrer");
  expect(csrf.headers.has("set-cookie")).toBe(false);
  expect(await csrf.json()).toEqual({ scope: "session", csrfToken: await createStudentSessionCsrfToken(token) });
  const preview = await f.fetch();
  expect(preview.status).toBe(200);
  expect(preview.headers.get("cache-control")).toBe("no-store");
  expect(preview.headers.has("set-cookie")).toBe(false);
  const view = await preview.json() as { expectedStateToken: string };
  expect(f.batch).not.toHaveBeenCalled();
  const response = await f.fetch(confirmPath, JSON.stringify({ slotId: "target", expectedStateToken: view.expectedStateToken }));
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(await response.json()).toMatchObject({ reservation: { reservationState: "confirmed", classification: "standard" } });
  expect(f.batch).toHaveBeenCalledOnce();
  expect(f.first).not.toHaveBeenCalled();
});

it("[#929 read delegation] published empty month and own empty History keep read-only wire", async () => {
  const f = await setup();
  for (const [path, expected] of [["/api/me/schedule-months/2026-11", { month: "2026-11", slots: [] }],
    [confirmPath, { items: [], nextCursor: null }]] as const) {
    const response = await f.fetch(path, undefined, {}, "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.json()).toEqual(expected);
  }
  expect(f.batch).not.toHaveBeenCalled();
});

it("[#929 CSRF GET negatives] Origin/metadata and query rejection retain no-referrer and no writes", async () => {
  const f = await setup();
  for (const headers of [{ origin: "https://other.test" }, { "sec-fetch-site": "cross-site" }]) {
    const response = await f.fetch("/api/auth/student/csrf", undefined, headers, "GET");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    await error(response, 403, "CSRF_INVALID", "reload");
  }
  await error(await f.fetch("/api/auth/student/csrf?identity=other", undefined, {}, "GET"), 400, "INVALID_REQUEST", "none");
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
});

it.each(routes)("[#929 route/auth] %s %s retains missing Session 401", async (method, path) => {
  const f = await setup();
  const body = method === "POST" && path === confirmPath ? '{"slotId":"target","expectedStateToken":"v1.invalid"}' : undefined;
  await error(await f.fetch(path, body, { cookie: "" }, method), 401, "UNAUTHENTICATED", "none");
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
});

it.each([previewPath, confirmPath])("[#929 Adapter negatives] %s preserves JSON, Origin, CSRF, role, conflict and failure classification", async (path) => {
  const f = await setup();
  const view = await (await f.fetch()).json() as { expectedStateToken: string };
  const body = path === previewPath ? '{"slotId":"target"}' : JSON.stringify({ slotId: "target", expectedStateToken: view.expectedStateToken });
  f.prepare.mockClear();
  for (const invalid of ["{", '{"slotId":"target","slotId":"target"}', '{"slotId":"target","studentId":"other"}']) {
    await error(await f.fetch(path, invalid), 400, "INVALID_REQUEST", "none");
  }
  await error(await f.fetch(path, body, { "content-type": "text/plain" }), 400, "INVALID_REQUEST", "none");
  await error(await f.fetch(path + "?identity=other", body), 400, "INVALID_REQUEST", "none");
  expect(f.prepare).not.toHaveBeenCalled();
  for (const headers of [{ origin: "" }, { origin: "https://other.test" }, { "x-csrf-token": "" },
    { "x-csrf-token": "B".repeat(43) }, { "sec-fetch-site": "cross-site" }]) {
    await error(await f.fetch(path, body, headers), 403, "CSRF_INVALID", "reload");
  }
  f.row.role_scope = "admin";
  await error(await f.fetch(path, body), 403, "FORBIDDEN", "none");
  f.row.role_scope = "student";
  f.captured.foreign_occupied = 1;
  await error(await f.fetch(path, body), 409, "RESERVATION_NOT_AVAILABLE", "reload");
  f.captured.foreign_occupied = 0;
  f.capture.mockRejectedValue(new Error("private SQL"));
  await error(await f.fetch(path, body));
  expect(f.batch).not.toHaveBeenCalled(); expect(f.first).not.toHaveBeenCalled();
});

it("[#929 closed routing] origin, credentials, fragments, path and method cannot be overridden by headers", async () => {
  const f = await setup();
  for (const [method, path] of routes) {
    for (const base of ["http://127.0.0.1:8789", "https://localhost:8789", "https://127.0.0.1:8788", "https://other.test", "https://user:password@127.0.0.1:8789"]) {
      await error(await f.fetch(path, undefined, { host: "127.0.0.1:8789", forwarded: "host=127.0.0.1:8789", referer: origin }, method, base));
    }
  }
  for (const path of ["/", "/student.html", "/student/", "/student?identity=other", "/debug", "/seed", "/login", previewPath + "/", previewPath + "#fragment"]) {
    await error(await f.fetch(path));
  }
  for (const method of ["HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"]) {
    for (const path of [...assets, ...routes.map(([, path]) => path)]) await error(await f.fetch(path, undefined, {}, method));
  }
  await error(await f.fetch(previewPath, undefined, {}, "GET"));
  await error(await f.fetch("/api/auth/student/csrf"));
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled(); expect(f.fetchAsset).not.toHaveBeenCalled();
});

it("[#929 static assets] six GET assets have fixed MIME/no-store and never forward cookies or redirects", async () => {
  const f = await setup();
  for (const path of assets) {
    const response = await f.fetch(path, undefined, {}, "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe((path === "/student" ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript") + "; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("set-cookie")).toBe(false);
  }
  expect(f.prepare).not.toHaveBeenCalled();
  f.fetchAsset.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.test" } }));
  await error(await f.fetch("/student", undefined, {}, "GET"));
  f.fetchAsset.mockRejectedValue(new Error("private-canary"));
  await error(await f.fetch("/student", undefined, {}, "GET"));
});

it("[#929 binding/key] missing, malformed and extra bindings fail closed; lifetime key failure is sticky", async () => {
  const f = await setup();
  const generate = vi.spyOn(crypto.subtle, "generateKey");
  for (const binding of [undefined, null, {}, [], { prepare() {} }, { withSession() {} }]) {
    const env = { ...f.env, EVALUATION_BOOKING_DB: binding } as typeof f.env;
    for (const [method, path] of routes) await error(await createReservationEvaluationWorker().fetch(await f.request(path, undefined, {}, method), env));
  }
  for (const env of [{ EVALUATION_BOOKING_DB: f.env.EVALUATION_BOOKING_DB }, { ...f.env, REMOTE: {} }, { ...f.env, ASSETS: {} }]) {
    await error(await createReservationEvaluationWorker().fetch(await f.request(), env as typeof f.env));
  }
  expect(generate).not.toHaveBeenCalled();
  generate.mockRejectedValue(new Error("private-canary"));
  const failed = createReservationEvaluationWorker();
  for (const [method, path] of routes) await error(await failed.fetch(await f.request(path, undefined, {}, method), f.env));
  await error(await failed.fetch(await f.request("/student", undefined, {}, "GET"), f.env));
  expect(generate).toHaveBeenCalledTimes(1);
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
});

it("[#929 lifetime] concurrent API requests generate one non-extractable sign-only key", async () => {
  const f = await setup();
  const generate = vi.spyOn(crypto.subtle, "generateKey");
  const responses = await Promise.all([f.fetch(), f.fetch("/api/auth/student/csrf", undefined, {}, "GET")]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(generate).toHaveBeenCalledExactlyOnceWith({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const key = await generate.mock.results[0].value as CryptoKey;
  expect(key.extractable).toBe(false); expect(key.usages).toEqual(["sign"]);
});

it("[#929 Production isolation] ordinary Worker still refuses every allowed asset/API method", async () => {
  for (const path of [...assets, ...routes.map(([, path]) => path)]) {
    for (const method of ["GET", "POST"]) {
      const response = await exports.default.fetch(origin + path, { method });
      expect(response.status).toBe(503); expect(await response.text()).toBe("Application is not available.");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("set-cookie")).toBe(false);
    }
  }
});

it("[#929 malformed write Port/key] disables API and static routes without SQL", async () => {
  const f = await setup();
  for (const session of [null, [], {}, { prepare: f.prepare }, { prepare: f.prepare, batch: null }]) {
    const env = { ...f.env, EVALUATION_BOOKING_DB: { prepare: f.prepare, withSession: () => session } } as unknown as typeof f.env;
    const worker = createReservationEvaluationWorker();
    for (const path of [previewPath, "/student"]) await error(await worker.fetch(await f.request(path, undefined, {}, path === "/student" ? "GET" : "POST"), env));
  }
  const keys = [
    await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]),
    await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-384" }, false, ["sign"]),
    await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
  ];
  const generate = vi.spyOn(crypto.subtle, "generateKey");
  for (const key of keys) {
    generate.mockResolvedValue(key);
    const worker = createReservationEvaluationWorker();
    for (const [method, path] of routes) await error(await worker.fetch(await f.request(path, undefined, {}, method), f.env));
    await error(await worker.fetch(await f.request("/student", undefined, {}, "GET"), f.env));
  }
  expect(generate).toHaveBeenCalledTimes(keys.length);
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
});
