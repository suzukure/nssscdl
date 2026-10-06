import { describe, expect, it, vi } from "vitest";
import {
  mapSlotView,
  ScheduleQueryError,
  ScheduleQueryService,
  toTokyoDateTime,
  type Clock,
  type OccupancyReadState,
  type ReservationReadState,
  type ScheduleMonthReadState,
  type ScheduleQueryRepository,
  type SlotReadState,
} from "../../src/application/schedule-query";

const start = Date.parse("2026-11-01T10:00:00+09:00") / 1000;
const studentId = "student-me";
function reservation(overrides: Partial<ReservationReadState> = {}): ReservationReadState {
  return { reservationId: "reservation-me", slotId: "slot-1", studentId, status: "confirmed", classification: "standard", ...overrides };
}
function occupancy(type: OccupancyReadState["type"] = "student_reservation"): OccupancyReadState {
  return { slotId: "slot-1", type, reservationId: type === "student_reservation" ? "reservation-me" : null };
}
function slot(overrides: Partial<SlotReadState> = {}): SlotReadState {
  return { slotId: "slot-1", startsAt: start, endsAt: start + 90 * 60, availability: "enabled", occupancies: [], reservations: [], integrity: "consistent", ...overrides };
}
function month(slots: readonly SlotReadState[] = [slot()]): ScheduleMonthReadState {
  return { month: "2026-11", publishedAt: start - 86400, slots };
}
class FakeRepository implements ScheduleQueryRepository {
  readonly readMonth = vi.fn<ScheduleQueryRepository["readMonth"]>(async () => this.state);
  constructor(readonly state: ScheduleMonthReadState | null) {}
}
function service(state: ScheduleMonthReadState | null, clock: Clock = { now: () => start - 1 }) {
  return new ScheduleQueryService(new FakeRepository(state), clock);
}

// API/read-model partial evidence only; not System/Acceptance TC overall Pass.
describe("[TC-F-001-01 / TC-F-002-02] API/read-model partial evidence: Slot View", () => {
  it("returns exactly the public bookable fields", async () => {
    expect(await service(month()).execute("2026-11", studentId)).toEqual({
      month: "2026-11",
      slots: [{ slotId: "slot-1", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:30:00+09:00", view: "bookable" }],
    });
  });

  it.each(["standard", "additional", null] as const)("retains only the owner's reservation and classification %s", async (classification) => {
    const result = await service(month([slot({ occupancies: [occupancy()], reservations: [reservation({ classification })] })])).execute("2026-11", studentId);
    expect(result.slots[0]).toEqual({ slotId: "slot-1", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:30:00+09:00", view: "reserved_by_me", reservationId: "reservation-me", classification: classification ?? "not_applicable" });
  });

  it("does not expose another student's identifiers, PII, prices or delivery state", async () => {
    const other = { ...reservation({ reservationId: "other-reservation", studentId: "other-student" }), email: "other@example.test", name: "Other", price: 999, deliverySucceeded: true };
    const input = slot({ occupancies: [{ ...occupancy(), reservationId: other.reservationId }], reservations: [other] });
    const result = await service(month([input])).execute("2026-11", studentId);
    expect(result.slots[0]).toEqual({ slotId: "slot-1", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:30:00+09:00", view: "unavailable" });
    for (const value of [other.reservationId, other.studentId, other.email, other.name, "price", "deliverySucceeded"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it("returns disabled as unavailable", async () => {
    const result = await service(month([slot({ availability: "disabled" })])).execute("2026-11", studentId);
    expect(result.slots[0].view).toBe("unavailable");
    expect(result.slots[0]).not.toHaveProperty("reservationId");
  });

  it.each([0, 1, 90 * 60])("returns started Slots as unavailable at start + %s seconds", (offset) => {
    for (const input of [slot(), slot({ occupancies: [occupancy()], reservations: [reservation()] }), slot({ occupancies: [occupancy("group_lesson")] })]) {
      const result = mapSlotView(input, studentId, start + offset);
      expect(result.view).toBe("unavailable");
      expect(result).not.toHaveProperty("reservationId");
      expect(result).not.toHaveProperty("classification");
    }
  });

  it("does not reopen a started Slot whose historical occupancy has been released", () => {
    expect(mapSlotView(slot({ reservations: [reservation({ status: "student_cancelled", classification: null })] }), studentId, start).view).toBe("unavailable");
  });
});

describe("[TC-F-001-02] API/read-model partial evidence: management occupancy", () => {
  it.each([ ["group_lesson", "group_lesson"], ["admin_hold", "unavailable"] ] as const)("maps %s to %s without reservation fields", async (type, view) => {
    const result = await service(month([slot({ occupancies: [occupancy(type)] })])).execute("2026-11", studentId);
    expect(result.slots[0]).toEqual({ slotId: "slot-1", startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:30:00+09:00", view });
  });
});

describe("[TC-F-002-01] API/read-model partial evidence: publication", () => {
  it.each([null, { ...month(), publishedAt: null }])("rejects nonexistent/unpublished months", async (state) => {
    await expect(service(state).execute("2026-11", studentId)).rejects.toMatchObject({ code: "SCHEDULE_MONTH_NOT_AVAILABLE" });
  });
  it("returns an empty published month", async () => {
    expect(await service(month([])).execute("2026-11", studentId)).toEqual({ month: "2026-11", slots: [] });
  });
});

describe("#828 BR-067: future integrity fail-closed", () => {
  const cases: [string, Partial<SlotReadState>][] = [
    ["unverified repository invariant", { integrity: "inconsistent" }],
    ["missing reservation reference", { occupancies: [occupancy()] }],
    ["orphan confirmed reservation", { reservations: [reservation()] }],
    ["cancelled reservation reference", { occupancies: [occupancy()], reservations: [reservation({ status: "student_cancelled" })] }],
    ["reservation points to another Slot", { occupancies: [occupancy()], reservations: [reservation({ slotId: "wrong-slot" })] }],
    ["occupancy points to another Slot", { occupancies: [{ ...occupancy(), slotId: "wrong-slot" }], reservations: [reservation()] }],
    ["wrong reservation ID", { occupancies: [{ ...occupancy(), reservationId: "wrong-reservation" }], reservations: [reservation()] }],
    ["duplicate occupancy", { occupancies: [occupancy("admin_hold"), occupancy("group_lesson")] }],
    ["duplicate confirmed reservations", { occupancies: [occupancy()], reservations: [reservation(), reservation({ reservationId: "second-reservation" })] }],
    ["disabled occupied Slot", { availability: "disabled", occupancies: [occupancy("admin_hold")] }],
    ["management occupancy with reservation reference", { occupancies: [{ ...occupancy("group_lesson"), reservationId: "reservation-me" }] }],
    ["management occupancy with orphan reservation", { occupancies: [occupancy("admin_hold")], reservations: [reservation()] }],
    ["missing reservation owner", { occupancies: [occupancy()], reservations: [reservation({ studentId: "" })] }],
  ];
  it.each(cases)("rejects %s without returning a partial month", async (_name, overrides) => {
    await expect(service(month([slot(), slot(overrides)])).execute("2026-11", studentId)).rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE", message: "INTEGRITY_STATE_UNAVAILABLE" });
  });
  it("allows cancelled history with no current occupancy", () => {
    expect(mapSlotView(slot({ reservations: [reservation({ status: "student_cancelled", classification: null })] }), studentId, start - 1).view).toBe("bookable");
  });
  it("does not expose input details in errors", () => {
    try {
      mapSlotView(slot({ occupancies: [{ ...occupancy(), reservationId: "private-reference" }] }), studentId, start - 1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleQueryError);
      expect(JSON.stringify(error)).not.toContain("private-reference");
    }
  });
});

describe("#828 server Clock / ordering / datetime", () => {
  it("reads the selected month and captures one Clock value after the read", async () => {
    const repository = new FakeRepository(month([
      slot({ slotId: "b" }),
      slot({ slotId: "a", startsAt: start + 3600, endsAt: start + 9000 }),
    ]));
    const now = vi.fn(() => start - 1);
    const result = await new ScheduleQueryService(repository, { now }).execute("2026-11", studentId);
    expect(repository.readMonth).toHaveBeenCalledWith("2026-11");
    expect(now).toHaveBeenCalledTimes(1);
    expect(repository.readMonth.mock.invocationCallOrder[0]).toBeLessThan(now.mock.invocationCallOrder[0]);
    expect(result.slots.map((item) => item.slotId)).toEqual(["b", "a"]);
  });
  it("rejects a different month returned by the Repository", async () => {
    await expect(service({ ...month(), month: "2026-12" }).execute("2026-11", studentId)).rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
  });
  it.each([NaN, Infinity, start + 0.5])("rejects invalid Clock value %s", async (now) => {
    await expect(service(month(), { now: () => now }).execute("2026-11", studentId)).rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
  });
  it.each([
    ["2026-10-31T15:00:00Z", "2026-11-01T00:00:00+09:00"],
    ["2026-12-31T15:00:00Z", "2027-01-01T00:00:00+09:00"],
    ["2028-02-28T15:00:00Z", "2028-02-29T00:00:00+09:00"],
  ])("converts UTC %s to Tokyo %s", (utc, tokyo) => {
    const seconds = Date.parse(utc) / 1000;
    expect(toTokyoDateTime(seconds)).toBe(tokyo);
    expect(Date.parse(toTokyoDateTime(seconds))).toBe(seconds * 1000);
  });
  it.each([NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])("rejects unrepresentable datetime %s", (seconds) => {
    expect(() => toTokyoDateTime(seconds)).toThrow(ScheduleQueryError);
  });
});
