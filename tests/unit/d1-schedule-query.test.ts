import { expect, it, vi } from "vitest";
import { D1ScheduleQueryRepository, ScheduleQueryDatabaseError, type ScheduleQueryD1 } from "../../src/infrastructure/d1-schedule-query";

it.each(["prepare", "bind", "all", "unsuccessful"])("[#830 D1 error boundary] abstracts %s failures", async (stage) => {
  const raw = new Error("D1_ERROR: SELECT private_column FROM private_table");
  const database: ScheduleQueryD1 = {
    prepare() {
      if (stage === "prepare") throw raw;
      return { bind() {
        if (stage === "bind") throw raw;
        return { async all<T>() {
          if (stage === "all") throw raw;
          return { success: false, results: [] as T[] };
        } };
      } };
    },
  };
  try {
    await new D1ScheduleQueryRepository(database).readMonth("2026-11");
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleQueryDatabaseError);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain(raw.message);
    expect(JSON.stringify(error)).not.toMatch(/private_|SELECT|D1_ERROR/);
  }
});

it("[#830 D1 read boundary] binds the month and reads exactly one statement", async () => {
  const all = vi.fn(async () => ({ success: true, results: [] }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn<ScheduleQueryD1["prepare"]>(() => ({ bind }));
  const input = "2026-11' OR 1=1 --";
  expect(await new D1ScheduleQueryRepository({ prepare }).readMonth(input)).toBeNull();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(bind).toHaveBeenCalledExactlyOnceWith(input);
  expect(all).toHaveBeenCalledTimes(1);
  const sql = prepare.mock.calls[0][0];
  expect(sql).not.toContain(input);
  expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|PRAGMA)\b/);
});
