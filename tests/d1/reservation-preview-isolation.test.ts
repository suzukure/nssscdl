import { beforeAll, expect, it } from "vitest";
import { identity, repository, seedPreviewFixture, sql } from "./reservation-preview-fixture";

beforeAll(async () => { await seedPreviewFixture("isolation-file"); });
it("[#863 isolated fixture] reuses identical auth/Reservation IDs without sharing storage", async () => {
  await sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 3, 0, 'isolation-file')").run();
  expect((await repository().readPreview(identity, "target")).state.standardCountConfig).toEqual({ standardCount: 3 });
  expect(await sql("SELECT created_by FROM slot_occupancies WHERE id = 'later-o'").first("created_by")).toBe("isolation-file");
  await expect(sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'month', 4, 0, 'actor')").run()).rejects.toThrow(/UNIQUE/);
  await expect(sql("INSERT INTO student_monthly_lesson_configs VALUES ('missing', 'month', 3, 0, 'actor')").run()).rejects.toThrow(/FOREIGN KEY/);
  await expect(sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'missing', 3, 0, 'actor')").run()).rejects.toThrow(/FOREIGN KEY/);
  await expect(sql("INSERT INTO student_monthly_lesson_configs VALUES ('student', 'other-month', -1, 0, 'actor')").run()).rejects.toThrow(/CHECK/);
  expect((await sql("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
