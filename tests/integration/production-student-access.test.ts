import { expect, it, vi } from "vitest";
import { ScheduleQueryService } from "../../src/application/schedule-query";
import { ScheduleMonthHttpAdapter } from "../../src/http/schedule-month";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { request, source } from "./student-session-fixture";

const clearCookie = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";

it("[TC-F-207-03 partial HTTP] composes the Production Guard, rereads access and clears only 401 Cookie", async () => {
  const fixture = await source();
  const readMonth = vi.fn(async () => ({ month: "2026-11", publishedAt: 0, slots: [] }));
  const http = new ScheduleMonthHttpAdapter(new D1StudentAccessGuard(fixture.database),
    new ScheduleQueryService({ readMonth }, { now: () => 150 }));
  const response = await http.fetch(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toEqual({ month: "2026-11", slots: [] });
  fixture.row.access_state = "suspended";
  const rejected = await http.fetch(request());
  expect(rejected.status).toBe(401);
  expect(rejected.headers.get("set-cookie")).toBe(clearCookie);
  expect(await rejected.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } });
  expect(readMonth).toHaveBeenCalledTimes(1);
  expect(fixture.withSession).toHaveBeenCalledTimes(2);
});

it.each([
  ["role", 403, "FORBIDDEN", "この操作は利用できません。", "none"],
  ["integrity", 503, "INTEGRITY_STATE_UNAVAILABLE", "現在予定情報を利用できません。時間をおいて再度お試しください。", "later"],
  ["database", 503, "SERVICE_UNAVAILABLE", "現在サービスを利用できません。時間をおいて再度お試しください。", "later"],
] as const)("[TC-NF-914-04 partial HTTP] safely maps %s and preserves Cookie", async (mode, status, code, message, retry) => {
  const fixture = await source();
  if (mode === "role") fixture.row.role_scope = "admin";
  if (mode === "integrity") Object.assign(fixture.row, { access_state: null });
  if (mode === "database") fixture.all.mockRejectedValue(new Error("D1_ERROR private SQL token"));
  const readMonth = vi.fn(async () => null);
  const http = new ScheduleMonthHttpAdapter(new D1StudentAccessGuard(fixture.database),
    new ScheduleQueryService({ readMonth }, { now: () => 150 }));
  const response = await http.fetch(request());
  expect(response.status).toBe(status);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: { code, message, retry } });
  expect(readMonth).not.toHaveBeenCalled();
});
