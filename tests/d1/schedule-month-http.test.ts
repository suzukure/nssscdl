import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ScheduleQueryService } from "../../src/application/schedule-query";
import { ScheduleMonthHttpAdapter } from "../../src/http/schedule-month";
import { D1ScheduleQueryRepository } from "../../src/infrastructure/d1-schedule-query";
import { FakeStudentAccessGuard } from "../integration/student-access-guard-fixture";
import { seedManagementOccupancyFixture } from "./management-occupancy-fixture";

const start = Date.parse("2026-11-01T10:00:00+09:00") / 1000;
const repository = new D1ScheduleQueryRepository(env.TEST_DB);
function http(studentId = "student", now = start - 1) {
  return new ScheduleMonthHttpAdapter(
    new FakeStudentAccessGuard({ status: "authenticated", studentId }),
    new ScheduleQueryService(repository, { now: () => now }),
  );
}
const request = (month = "2026-11") => new Request(`https://nssscdl.test/api/me/schedule-months/${month}`);

beforeAll(async () => { await seedManagementOccupancyFixture("http-file"); });

describe("[#831 fake Guard + real D1 HTTP] API/read-model partial evidence", () => {
  it("[TC-F-001-01 / TC-F-001-02 / TC-F-002-02] returns four Views in stable order with only owner fields", async () => {
    const response = await http().fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ month: "2026-11", slots: [
      { slotId: "slot-a", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:00:00+09:00", view: "reserved_by_me", reservationId: "reservation", classification: "standard" },
      { slotId: "slot-b", startsAt: "2026-11-08T10:00:00+09:00", endsAt: "2026-11-08T11:00:00+09:00", view: "unavailable" },
      { slotId: "slot-c", startsAt: "2026-11-15T10:00:00+09:00", endsAt: "2026-11-15T11:00:00+09:00", view: "group_lesson" },
      { slotId: "slot-d", startsAt: "2026-11-22T10:00:00+09:00", endsAt: "2026-11-22T11:00:00+09:00", view: "bookable" },
    ] });
    expect(await (await http().fetch(request())).json()).toEqual(await (await http().fetch(request())).json());
    expect((await env.TEST_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("[TC-F-001-01] does not expose another student's reservation IDs, classification, PII, fees or delivery fields", async () => {
    const response = await http("different-student").fetch(request());
    expect(response.status).toBe(200);
    const result = await response.json() as { slots: Array<Record<string, unknown>> };
    expect(result.slots[0]).toEqual({ slotId: "slot-a", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:00:00+09:00", view: "unavailable" });
    expect(result.slots.every((slot) => !("reservationId" in slot) && !("classification" in slot))).toBe(true);
    for (const value of ["reservation", "student", "http-file", "occupancy", "email", "name", "price", "fee", "delivery", "notification"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it.each(["standard", "additional", null])("[TC-F-001-01] projects own classification %s", async (classification) => {
    if (classification === null) {
      await env.TEST_DB.prepare("INSERT INTO reservation_monthly_count_overrides VALUES ('reservation', 'excluded', 0, 'actor')").run();
    } else if (classification === "additional") {
      await env.TEST_DB.prepare("INSERT INTO reservation_classification_overrides VALUES ('reservation', 'additional', 0, 'actor')").run();
    }
    await env.TEST_DB.prepare("UPDATE student_reservations SET classification = ? WHERE id = 'reservation'").bind(classification).run();
    try {
      const response = await http().fetch(request());
      expect(response.status).toBe(200);
      const result = await response.json() as { slots: Array<Record<string, unknown>> };
      expect(result.slots[0]).toMatchObject({ view: "reserved_by_me", reservationId: "reservation", classification: classification ?? "not_applicable" });
    } finally {
      await env.TEST_DB.batch([
        env.TEST_DB.prepare("DELETE FROM reservation_monthly_count_overrides"),
        env.TEST_DB.prepare("DELETE FROM reservation_classification_overrides"),
        env.TEST_DB.prepare("UPDATE student_reservations SET classification = 'standard' WHERE id = 'reservation'"),
      ]);
    }
  });

  it("[TC-F-002-01] returns the same 404 envelope for unpublished and nonexistent months", async () => {
    await env.TEST_DB.prepare("UPDATE schedule_months SET published_at = NULL WHERE id = 'month'").run();
    try {
      for (const month of ["2026-11", "2026-12"]) {
        const response = await http().fetch(request(month));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE", message: "指定された月の予定は利用できません。", retry: "none" } });
      }
    } finally {
      await env.TEST_DB.prepare("UPDATE schedule_months SET published_at = 0 WHERE id = 'month'").run();
    }
  });

  it("[TC-F-002-02] abstracts a real persisted anomaly as 503 and retains started-Slot semantics", async () => {
    await env.TEST_DB.prepare("DELETE FROM group_lessons WHERE occupancy_id = 'group'").run();
    try {
      const response = await http().fetch(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "INTEGRITY_STATE_UNAVAILABLE", message: "現在予定情報を利用できません。時間をおいて再度お試しください。", retry: "later" } });
      const started = await http("student", start + 40 * 86400).fetch(request());
      expect(started.status).toBe(200);
      const result = await started.json() as { slots: Array<{ view: string }> };
      expect(result.slots.every((slot) => slot.view === "unavailable")).toBe(true);
    } finally {
      await env.TEST_DB.prepare("INSERT INTO group_lessons VALUES ('group')").run();
    }
  });

  it("abstracts an actual D1 execution error through the real Adapter", async () => {
    // Test-only source adapter uses a missing relation without altering schema.
    const broken = new D1ScheduleQueryRepository({
      prepare: (sql) => env.TEST_DB.prepare(sql.replace("FROM schedule_months AS m", "FROM missing_test_relation AS m")),
    });
    const adapter = new ScheduleMonthHttpAdapter(
      new FakeStudentAccessGuard({ status: "authenticated", studentId: "student" }),
      new ScheduleQueryService(broken, { now: () => start - 1 }),
    );
    const response = await adapter.fetch(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later" } });
  });
});
