import { expect, it, vi } from "vitest";
import { ReservationPreviewError } from "../../src/application/reservation-preview";
import { D1ReservationPreviewRepository, reservationCaptureSql, type ReservationPreviewD1 } from "../../src/infrastructure/d1-reservation-preview";

const identity = { studentId: "student" };
const target = { slotId: "target", month: "2026-11", publishedAt: 0,
  startsAt: 1794704400, endsAt: 1794708000, lessonDate: "2026-11-15", startTime: "10:00", endTime: "11:00", availability: "enabled" };
function source() {
  const row = { evaluated_at: 1794272400, student_id: "student",
    access_json: JSON.stringify([{ lifecycle: "active", deletedAt: null, accessState: "active" }]),
    target_json: JSON.stringify(target), config_json: "[]", reservations_json: "[]",
    bad_future: 0, foreign_occupied: 0, occupancies_json: "[]", canonical_raw_read_set: "{}" };
  const all = vi.fn(async () => ({ success: true, results: [row] }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn<(query: string) => { bind: typeof bind }>(() => ({ bind }));
  const withSession = vi.fn(() => ({ prepare }));
  return { row, all, bind, prepare, withSession, database: { withSession } as ReservationPreviewD1 };
}

it("[#863 coherent read] uses one Primary SELECT with bound identity/Slot and in-query D1 T0", async () => {
  const fake = source();
  await new D1ReservationPreviewRepository(fake.database).readPreview(identity, "target");
  expect(fake.withSession).toHaveBeenCalledExactlyOnceWith("first-primary");
  expect(fake.prepare).toHaveBeenCalledTimes(1);
  expect(fake.bind).toHaveBeenCalledExactlyOnceWith("student", "target");
  expect(fake.all).toHaveBeenCalledTimes(1);
  const query = fake.prepare.mock.calls[0][0];
  expect(query.match(/CAST\(strftime\('%s','now'\) AS INTEGER\)/g)).toHaveLength(1);
  expect(query).toContain("FROM student_session_access_v1");
  expect(query).toContain("ORDER BY starts_at, id");
  expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|PRAGMA)\b/);
});
it("[#869 shared capture] Preview and Confirm share one query/mapping and only Confirm exposes raw read set", async () => {
  const fake = source();
  const repo = new D1ReservationPreviewRepository(fake.database);
  const preview = await repo.readPreview(identity, "target");
  const confirm = await repo.readConfirm(identity, "target");
  expect(confirm).toEqual({ ...preview, canonicalRawReadSet: "{}" });
  expect(preview).not.toHaveProperty("canonicalRawReadSet");
  expect(fake.prepare.mock.calls.map(([query]) => query)).toEqual([reservationCaptureSql(), reservationCaptureSql()]);
  expect(fake.bind.mock.calls).toEqual([["student", "target"], ["student", "target"]]);
  expect(fake.all).toHaveBeenCalledTimes(2);
});
it("[#863 bind boundary] does not interpolate client-shaped values into SQL", async () => {
  const fake = source();
  const studentId = "private-student' OR 1=1 --";
  const slotId = "private-slot' OR 1=1 --";
  await expect(new D1ReservationPreviewRepository(fake.database).readPreview({ studentId }, slotId))
    .rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
  expect(fake.bind).toHaveBeenCalledExactlyOnceWith(studentId, slotId);
  expect(fake.prepare.mock.calls[0][0]).not.toContain(studentId);
  expect(fake.prepare.mock.calls[0][0]).not.toContain(slotId);
});
it.each(["withSession", "prepare", "bind", "all", "unsuccessful"])("[#863 DB error] abstracts %s without leaking cause/SQL/owners", async (stage) => {
  const raw = new Error("SELECT private-owner FROM secret_table");
  const fake = source();
  if (stage === "withSession") fake.withSession.mockImplementationOnce(() => { throw raw; });
  if (stage === "prepare") fake.prepare.mockImplementationOnce(() => { throw raw; });
  if (stage === "bind") fake.bind.mockImplementationOnce(() => { throw raw; });
  if (stage === "all") fake.all.mockRejectedValueOnce(raw);
  if (stage === "unsuccessful") fake.all.mockResolvedValueOnce({ success: false, results: [] });
  try {
    await new D1ReservationPreviewRepository(fake.database).readPreview(identity, "target");
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ReservationPreviewError);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain(raw.message);
    expect(JSON.stringify(error)).not.toMatch(/private|secret|SELECT/);
  }
});
it.each([
  ["evaluated_at", "1794272400"], ["evaluated_at", 1.5], ["student_id", null],
  ["access_json", "[]"], ["access_json", '[{"lifecycle":"active","deletedAt":null,"accessState":null}]'],
  ["target_json", "{}"], ["target_json", "malformed"], ["config_json", '[{"standardCount":0.5,"updatedAt":0}]'],
  ["config_json", '[{"standardCount":3,"updatedAt":0},{"standardCount":3,"updatedAt":0}]'],
  ["reservations_json", "null"], ["bad_future", null], ["bad_future", 1], ["foreign_occupied", 2],
  ["canonical_raw_read_set", null], ["canonical_raw_read_set", "malformed"], ["canonical_raw_read_set", "[]"],
  ["occupancies_json", '[{"slotId":"target","type":"unknown","reservationId":null}]'],
])("[#863 mapping integrity] rejects malformed %s = %s", async (key, value) => {
  const fake = source();
  Object.assign(fake.row, { [String(key)]: value });
  await expect(new D1ReservationPreviewRepository(fake.database).readPreview(identity, "target"))
    .rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE", message: "INTEGRITY_STATE_UNAVAILABLE" });
});
