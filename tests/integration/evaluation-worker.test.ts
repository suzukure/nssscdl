import { exports } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker, { createEvaluationWorker } from "../evaluation/worker";
import configText from "../evaluation/wrangler.jsonc?raw";
import workerSource from "../evaluation/worker.ts?raw";
import { source, token } from "./student-session-fixture";
import type { ReadOnlyStudentConfig } from "../fixtures/read-only-student-service";

const origin = "https://127.0.0.1:8788";
const paths = ["/api/me/schedule-months/2026-11", "/api/me/reservations", "/api/auth/student/csrf"];
function request(path: string, authenticated = false, base = origin, method = "GET") {
  return new Request(base + path, { method, headers: {
    "sec-fetch-site": "same-origin",
    ...(authenticated ? { cookie: `__Host-student_session=${token}` } : {}),
  } });
}
async function error(response: Response, status = 503, code = "SERVICE_UNAVAILABLE") {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("set-cookie")).toBe(status === 401);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toEqual({ error: {
    code, message: status === 503 ? "現在サービスを利用できません。時間をおいて再度お試しください。"
      : status === 401 ? "認証が必要です。" : "入力内容を確認してください。",
    retry: status === 503 ? "later" : "none",
  } });
}
async function fixture() {
  const access = await source();
  const historyRead = vi.fn();
  // Existing read Ports only. This source fixture is not a listener / D1 proof.
  const database: ReadOnlyStudentConfig["database"] = {
    prepare(query) { return access.database.withSession("first-primary").prepare(query); },
    withSession(constraint) {
      expect(constraint).toBe("first-primary");
      return { prepare(query) {
        if (query.includes("student_session_access_v1")) return access.database.withSession(constraint).prepare(query);
        expect(query).toContain("FROM student_reservations AS r");
        return { bind(...values: unknown[]) {
          expect(values[0]).toBe("student");
          return { async all<T>() {
            historyRead();
            // §4 history ordering / limit+1; position is internal UTC seconds.
            const rows = (values.length === 2 ? [2, 1] : [1]).map((id) => ({
              reservation_id: `r${id}`, student_id: "student", status: "confirmed", classification: "standard",
              starts_at: id * 3600, ends_at: id * 3600 + 1800, absence_id: null, absence_count: 0,
            }));
            return { success: true, results: rows as T[] };
          } };
        } };
      } };
    },
  };
  return { env: { EVALUATION_READ_DB: database }, access, historyRead };
}
afterEach(() => vi.restoreAllMocks());

it("[#902 structural isolation] dedicated loopback HTTPS config has one local placeholder D1 and no public or remote configuration", () => {
  expect(JSON.parse(configText)).toEqual({
    name: "nssscdl-local-read-only-evaluation", main: "worker.ts", compatibility_date: "2026-10-06",
    workers_dev: false, preview_urls: false,
    dev: { ip: "127.0.0.1", port: 8788, local_protocol: "https" },
    d1_databases: [{ binding: "EVALUATION_READ_DB", database_name: "nssscdl-local-read-only-evaluation",
      database_id: "00000000-0000-4000-8000-000000000902", migrations_dir: "../../migrations" }],
  });
  expect(Object.keys(worker)).toEqual(["fetch"]);
  expect(workerSource).not.toMatch(/exportKey|importKey|console\.|process\.env|\.vars|\bscheduled\s*[:(]|trusted-student-seed|reservation-preview|reservation-confirm|src\/web/);
  expect(workerSource).toContain('const applicationOrigin = "https://127.0.0.1:8788"');
});

it("[#902 default isolation] default Worker still refuses student UI and every GET/unsafe POST", async () => {
  for (const path of [...paths, "/student", "/student/student.js", "/api/me/reservations/preview"]) {
    for (const method of ["GET", "POST"]) {
      const response = await exports.default.fetch(origin + path, { method });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Application is not available.");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("set-cookie")).toBe(false);
    }
  }
});

it("[#902 HTTP Harness partial] dedicated ES-module handler reaches each real GET Adapter and preserves missing Session 401", async () => {
  const { env, access } = await fixture();
  for (const path of paths) {
    const response = await worker.fetch(request(path), env);
    await error(response, 401, "UNAUTHENTICATED");
    expect(response.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
    if (path.endsWith("csrf")) expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  expect(access.all).not.toHaveBeenCalled();
});

it("[TC-F-005-01 partial #902] concurrent requests share a non-exportable sign-only lifetime key; restart rejects an old cursor", async () => {
  const local = createEvaluationWorker();
  const { env, historyRead } = await fixture();
  const generate = vi.spyOn(crypto.subtle, "generateKey");
  const responses = await Promise.all([local.fetch(request("/api/me/reservations?limit=1", true), env),
    local.fetch(request("/api/auth/student/csrf", true), env)]);
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
  }
  expect(generate).toHaveBeenCalledExactlyOnceWith({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const key = await generate.mock.results[0].value as CryptoKey;
  expect(key.extractable).toBe(false);
  expect(key.usages).toEqual(["sign"]);
  const page = await responses[0].json() as { items: { reservationId: string }[]; nextCursor: string };
  expect(page.items.map((item) => item.reservationId)).toEqual(["r2"]);
  expect(typeof page.nextCursor).toBe("string");
  const nextRequest = () => request(`/api/me/reservations?limit=1&cursor=${page.nextCursor}`, true);
  const next = await local.fetch(nextRequest(), env);
  expect(next.status).toBe(200);
  expect((await next.json() as { items: { reservationId: string }[] }).items.map((item) => item.reservationId)).toEqual(["r1"]);
  expect(generate).toHaveBeenCalledTimes(1);
  const reads = historyRead.mock.calls.length;
  await error(await createEvaluationWorker().fetch(nextRequest(), env), 400, "INVALID_REQUEST");
  expect(generate).toHaveBeenCalledTimes(2);
  expect(historyRead).toHaveBeenCalledTimes(reads);
});

it("[TC-NF-914-04 partial #902] missing/malformed binding and failed key setup stay 503 without fallback or retry", async () => {
  const { env } = await fixture();
  const generate = vi.spyOn(crypto.subtle, "generateKey");
  for (const binding of [undefined, null, {}, [], { prepare() {} }, { withSession() {} }]) {
    for (const path of paths) await error(await createEvaluationWorker().fetch(request(path),
      { EVALUATION_READ_DB: binding } as typeof env));
  }
  expect(generate).not.toHaveBeenCalled();
  generate.mockRejectedValue(new Error("private setup failure"));
  const failed = createEvaluationWorker();
  for (const path of paths) {
    const response = await failed.fetch(request(path, true), env);
    await error(response);
    if (path.endsWith("csrf")) expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  expect(generate).toHaveBeenCalledTimes(1);
});

it("[#902 key setup] nonconforming generated key disables even no-Cookie routes", async () => {
  const { env } = await fixture();
  const invalid = [
    await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]),
    await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-384" }, false, ["sign"]),
    await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
  ];
  const generate = vi.spyOn(crypto.subtle, "generateKey");
  for (const key of invalid) {
    generate.mockResolvedValue(key);
    const local = createEvaluationWorker();
    for (const path of paths) await error(await local.fetch(request(path), env));
  }
  expect(generate).toHaveBeenCalledTimes(invalid.length);
});

it("[TC-NF-914-04 partial #902] preserves CSRF Origin refusal and safely abstracts a D1 read failure", async () => {
  const { env, access } = await fixture();
  const local = createEvaluationWorker();
  const input = request("/api/auth/student/csrf", true);
  input.headers.set("origin", "https://other.test");
  const forbidden = await local.fetch(input, env);
  expect(forbidden.status).toBe(403);
  expect(forbidden.headers.get("cache-control")).toBe("no-store");
  expect(forbidden.headers.get("referrer-policy")).toBe("no-referrer");
  expect(forbidden.headers.has("set-cookie")).toBe(false);
  expect(await forbidden.json()).toMatchObject({ error: { code: "CSRF_INVALID", retry: "reload" } });
  expect(access.all).not.toHaveBeenCalled();
  access.all.mockRejectedValue(new Error("private fixture D1 failure"));
  await error(await local.fetch(request("/api/me/reservations", true), env));
});

it("[#902 fail-closed] URL origin is fixed; headers cannot replace it, and unsupported paths/methods never reach D1", async () => {
  const { env, access, historyRead } = await fixture();
  const local = createEvaluationWorker();
  for (const path of paths) {
    for (const base of ["http://127.0.0.1:8788", "https://localhost:8788", "https://127.0.0.1:8787", "https://other.test"]) {
      const input = request(path, true, base);
      input.headers.set("host", "127.0.0.1:8788");
      input.headers.set("origin", origin);
      await error(await local.fetch(input, env));
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      await error(await local.fetch(request(path, true, origin, method), env));
    }
  }
  for (const path of ["/", "/student", "/student/student.js", "/student/student.css", "/login", "/seed", "/debug",
    "/api/auth/student/google/start", "/api/me/reservations/preview"]) {
    await error(await local.fetch(request(path, true), env));
  }
  expect(access.all).not.toHaveBeenCalled();
  expect(historyRead).not.toHaveBeenCalled();
});
