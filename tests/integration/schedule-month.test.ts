import { describe, expect, it, vi } from "vitest";
import { ScheduleQueryService, type ScheduleMonthReadState, type ScheduleQueryRepository } from "../../src/application/schedule-query";
import { ScheduleMonthHttpAdapter } from "../../src/http/schedule-month";
import { ScheduleQueryDatabaseError } from "../../src/infrastructure/d1-schedule-query";
import { FakeStudentAccessGuard } from "./student-access-guard-fixture";

const start = Date.parse("2026-11-01T10:00:00+09:00") / 1000;
const state: ScheduleMonthReadState = {
  month: "2026-11", publishedAt: 0, slots: [{
    slotId: "slot", startsAt: start, endsAt: start + 3600, availability: "enabled",
    occupancies: [{ slotId: "slot", type: "student_reservation", reservationId: "own-reservation" }],
    reservations: [{ reservationId: "own-reservation", slotId: "slot", studentId: "guard-student", status: "confirmed", classification: "additional" }],
    integrity: "consistent",
  }],
};
const request = (suffix = "2026-11", method = "GET") => new Request(`https://nssscdl.test/api/me/schedule-months/${suffix}`, { method });
const self = () => new FakeStudentAccessGuard({ status: "authenticated", studentId: "guard-student" });
function adapter(repository: ScheduleQueryRepository, guard = self()) {
  return new ScheduleMonthHttpAdapter(guard, new ScheduleQueryService(repository, { now: () => start - 1 }));
}
async function expectError(response: Response, status: number, code: string, message: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: { code, message, retry: status === 503 ? "later" : "none" } });
}

describe("[#831 HTTP / Guard integration] API/read-model partial evidence", () => {
  it("[TC-F-001-01] validates, authorizes and then queries with only the Guard identity", async () => {
    const events: string[] = [];
    const guard = new FakeStudentAccessGuard({ status: "authenticated", studentId: "guard-student" }, () => { events.push("guard"); });
    const repository = { readMonth: vi.fn(async () => { events.push("read"); return state; }) };
    const input = request();
    // Untrusted identity headers do not choose the owner; the fixture ignores them.
    input.headers.set("studentId", "other-student");
    input.headers.set("email", "other@example.test");
    input.headers.set("role", "admin");
    const response = await adapter(repository, guard).fetch(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ month: "2026-11", slots: [{
      slotId: "slot", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:00:00+09:00",
      view: "reserved_by_me", reservationId: "own-reservation", classification: "additional",
    }] });
    expect(events).toEqual(["guard", "read"]);
    expect(guard.requests).toEqual([input]);
    expect(repository.readMonth).toHaveBeenCalledExactlyOnceWith("2026-11");
    await adapter(repository, guard).fetch(request());
    expect(guard.requests).toHaveLength(2);
  });

  it.each(["2026-00", "2026-13", "2026-1", "26-11", "2026-11-01", "abcd-11", "２０２６-１１", "2026-11/extra", "", "%ZZ", "2026-11%0A", "2026-11?studentId=other", "2026-11?email=other", "2026-11?role=admin", "2026-11?unknown=1"])("rejects invalid month/path/query %s before Guard / read", async (suffix) => {
    const repository = { readMonth: vi.fn(async () => state) };
    const guard = self();
    await expectError(await adapter(repository, guard).fetch(request(suffix)), 400, "INVALID_REQUEST", "入力内容を確認してください。");
    expect(guard.requests).toEqual([]);
    expect(repository.readMonth).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])("rejects unsupported method %s", async (method) => {
    const repository = { readMonth: vi.fn(async () => state) };
    const guard = self();
    await expectError(await adapter(repository, guard).fetch(request("2026-11", method)), 400, "INVALID_REQUEST", "入力内容を確認してください。");
    expect(guard.requests).toEqual([]);
    expect(repository.readMonth).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401, "UNAUTHENTICATED", "認証が必要です。"],
    ["forbidden", 403, "FORBIDDEN", "この操作は利用できません。"],
  ] as const)("maps %s without invoking the Repository", async (status, http, code, message) => {
    const repository = { readMonth: vi.fn(async () => state) };
    await expectError(await adapter(repository, new FakeStudentAccessGuard({ status })).fetch(request()), http, code, message);
    expect(repository.readMonth).not.toHaveBeenCalled();
  });

  it.each([null, { ...state, publishedAt: null }])("[TC-F-002-01] abstracts nonexistent / unpublished months identically", async (readState) => {
    await expectError(await adapter({ readMonth: async () => readState }).fetch(request()), 404, "SCHEDULE_MONTH_NOT_AVAILABLE", "指定された月の予定は利用できません。");
  });

  it("[TC-F-002-02] fails closed on future persisted integrity anomalies", async () => {
    const corrupted = { ...state, slots: [{ ...state.slots[0], integrity: "inconsistent" as const }] };
    await expectError(await adapter({ readMonth: async () => corrupted }).fetch(request()), 503, "INTEGRITY_STATE_UNAVAILABLE", "現在予定情報を利用できません。時間をおいて再度お試しください。");
  });

  it.each([new ScheduleQueryDatabaseError(), new Error("SQL table column internal exception")])("abstracts database/internal failures", async (failure) => {
    await expectError(await adapter({ readMonth: async () => { throw failure; } }).fetch(request()), 503, "SERVICE_UNAVAILABLE", "現在サービスを利用できません。時間をおいて再度お試しください。");
  });

  it("does not query or disclose internal reasons if the Guard throws", async () => {
    const repository = { readMonth: vi.fn(async () => state) };
    const guard = { authorize: async () => { throw new URIError("internal session/access reason"); } };
    const http = new ScheduleMonthHttpAdapter(guard, new ScheduleQueryService(repository, { now: () => start - 1 }));
    await expectError(await http.fetch(request()), 503, "SERVICE_UNAVAILABLE", "現在サービスを利用できません。時間をおいて再度お試しください。");
    expect(repository.readMonth).not.toHaveBeenCalled();
  });
});
