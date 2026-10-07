import { describe, expect, it, vi } from "vitest";
import {
  createPreviewPlan,
  expectedStateToken,
  previewReservation,
  ReservationPreviewError,
  type MonthlyReservationReadState,
  type PreviewReadState,
} from "../../src/application/reservation-preview";

const start = Date.parse("2026-11-10T10:00:00+09:00") / 1000;
const day = 86400;
const identity = { studentId: "student-me" };
const now = start - day;
function reservation(id: string, startsAt: number, overrides: Partial<MonthlyReservationReadState> = {}): MonthlyReservationReadState {
  return {
    reservationId: id, studentId: identity.studentId, slotId: `slot-${id}`,
    startsAt, endsAt: startsAt + 5400, status: "confirmed",
    automaticClassification: "standard", classification: "standard",
    absent: false, monthlyCountOverride: null, classificationOverride: null, ...overrides,
  };
}
function state(overrides: Partial<PreviewReadState> = {}): PreviewReadState {
  return {
    studentId: identity.studentId, reservationOperationAllowed: true, month: "2026-11",
    publishedAt: start - 10 * day, standardCountConfig: null, reservations: [], integrity: "consistent",
    slot: { slotId: "target", startsAt: start, endsAt: start + 5400,
      availability: "enabled", occupancies: [], reservations: [], integrity: "consistent" },
    ...overrides,
  };
}
function plan(input = state(), time = now) { return createPreviewPlan(identity, input, time); }
function preview(input = state(), time = now) { return previewReservation(identity, input, time); }
function additional(id: string, startsAt: number): MonthlyReservationReadState {
  return reservation(id, startsAt, { automaticClassification: "additional", classification: "additional" });
}

// Application/Preview partial evidence only. No Browser, HTTP or Confirm
// Commit: these tests do not establish System/Acceptance TC overall Pass.
describe("[TC-F-003-01 / TC-F-003-02] Application/Preview partial evidence", () => {
  it("returns standard final-confirmation fields and explicit empty changes", async () => {
    expect(await preview()).toEqual({
      slot: { slotId: "target", startsAt: "2026-11-10T10:00:00+09:00", endsAt: "2026-11-10T11:30:00+09:00" },
      previewClassification: "standard", classificationChanges: [],
      expectedStateToken: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/),
    });
  });
  it("permits additional Preview after all automatic standard places are consumed", async () => {
    const input = state({ reservations: [1, 2, 3].map((i) => reservation(`past-${i}`, start - (i + 1) * day)) });
    expect(await preview(input)).toMatchObject({ previewClassification: "additional", classificationChanges: [] });
  });
  it("permits additional with N=0, with no quota error", async () => {
    expect(await preview(state({ standardCountConfig: { standardCount: 0 } }))).toMatchObject({ previewClassification: "additional" });
  });
  it("returns standard → additional for a later reservation displaced by the new reservation", () => {
    const result = plan(state({ standardCountConfig: { standardCount: 1 }, reservations: [reservation("later", start + day)] }));
    expect(result.previewClassification).toBe("standard");
    expect(result.classificationChanges).toEqual([
      { reservationId: "later", startsAt: "2026-11-11T10:00:00+09:00", before: "standard", after: "additional" },
    ]);
  });
  it("recalculates additional → standard using latest N and preserves started classifications", () => {
    // Latest N may differ from the persisted automatic classifications; the
    // plan uses current inputs, not a fabricated cancel/write operation.
    const started = additional("started", now);
    const input = state({ standardCountConfig: { standardCount: 2 }, reservations: [
      additional("later", start + day), started,
    ] });
    const result = plan(input);
    expect(result.classificationChanges).toEqual([
      { reservationId: "later", startsAt: "2026-11-11T10:00:00+09:00", before: "additional", after: "standard" },
    ]);
    expect(input.reservations[1]).toEqual(started);
  });
  it("sorts both directions by startsAt then reservationId without mutating input", () => {
    const input = state({ standardCountConfig: { standardCount: 2 }, reservations: [
      reservation("z", start + 2 * day), reservation("b", start + day), additional("a", start + day),
    ] });
    const before = JSON.stringify(input);
    const result = plan(input);
    expect(result.classificationChanges.map((item) => [item.reservationId, item.before, item.after])).toEqual([
      ["a", "additional", "standard"], ["b", "standard", "additional"], ["z", "standard", "additional"],
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("counts started automatic standard even when overridden to additional", () => {
    const past = reservation("past", now, { classification: "additional", classificationOverride: "additional" });
    expect(plan(state({ standardCountConfig: { standardCount: 1 }, reservations: [past] })).previewClassification).toBe("additional");
  });
  it("does not consume a place for started automatic additional overridden to standard", () => {
    const past = additional("past", now);
    expect(plan(state({ standardCountConfig: { standardCount: 1 }, reservations: [
      { ...past, classification: "standard", classificationOverride: "standard" },
    ] })).previewClassification).toBe("standard");
  });
  it("preserves future overrides even when automatic classification changes", () => {
    const input = state({ standardCountConfig: { standardCount: 1 }, reservations: [
      reservation("later", start + day, { classificationOverride: "standard" }),
    ] });
    const result = plan(input);
    expect(result.classificationChanges).toEqual([]);
    expect(JSON.parse(result.canonicalSnapshot).affectedReservations[0]).toMatchObject({
      automaticBefore: "standard", automaticAfter: "additional", before: "standard", after: "standard",
    });
  });
  it.each(["student_cancelled", "school_cancelled", "system_cancelled", "absent", "excluded"] as const)("does not count %s or include it in displayed changes", (mode) => {
    const past = reservation("past", start - 2 * day, {
      classification: null,
      status: mode.endsWith("cancelled") ? mode as MonthlyReservationReadState["status"] : "confirmed",
      absent: mode === "absent", monthlyCountOverride: mode === "excluded" ? "excluded" : null,
    });
    const result = plan(state({ standardCountConfig: { standardCount: 1 }, reservations: [past] }));
    expect(result.previewClassification).toBe("standard");
    expect(result.classificationChanges).toEqual([]);
  });
  it("ignores effective standard count beyond N and clamps remaining places at zero", () => {
    const input = state({ standardCountConfig: { standardCount: 0 }, reservations: [reservation("past", now)] });
    expect(plan(input).previewClassification).toBe("additional");
  });
  it("does not leak amounts, N, identity, raw read state or snapshots into the wire view", async () => {
    const input = { ...state(), price: 999, otherStudent: "private-other", snapshot: "private-snapshot" };
    const result = await preview(input);
    expect(Object.keys(result)).toEqual(["slot", "previewClassification", "classificationChanges", "expectedStateToken"]);
    for (const value of ["price", "999", "standardCount", identity.studentId, "private-other", "private-snapshot", "canonicalSnapshot", "reservations", "reservationOperationAllowed"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });
});

describe("#610 §5.1 / #611 §4: canonical v1 and SHA-256", () => {
  it("pins empty canonical bytes, field order, types and normalized Tokyo datetimes", () => {
    expect(plan().canonicalSnapshot).toBe('{"version":"v1","studentId":"student-me","reservationOperationAllowed":true,"slot":{"slotId":"target","startsAt":"2026-11-10T10:00:00+09:00","endsAt":"2026-11-10T11:30:00+09:00","month":"2026-11","availability":"enabled","occupancies":[],"beforeStart":true},"publishedAt":"2026-10-31T10:00:00+09:00","standardCountConfig":null,"standardCount":3,"reservations":[],"previewClassification":"standard","affectedReservations":[],"classificationChanges":[]}');
  });
  it("uses the known SHA-256 of UTF-8 abc with base64url and no padding", async () => {
    expect(await expectedStateToken("abc")).toBe("v1.ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
  it("normalizes input property and collection order and ignores non-contract metadata", async () => {
    const reservations = [reservation("b", start + day), reservation("a", start + day)];
    const input = state({ reservations });
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as PreviewReadState;
    const other = { ...reordered, reservations: reservations.toReversed().map((item) =>
      Object.fromEntries(Object.entries(item).reverse()) as unknown as MonthlyReservationReadState), extra: "ignored" };
    expect(plan(other).canonicalSnapshot).toBe(plan(input).canonicalSnapshot);
    expect(await preview(other)).toEqual(await preview(input));
  });
  it("does not hash server time while all target and reservation boundaries remain identical", async () => {
    expect(await preview(state(), now + 1)).toEqual(await preview(state(), now));
  });
  it("hashes all monthly reservations even with no displayed changes", async () => {
    const empty = await preview();
    const withPast = await preview(state({ reservations: [additional("past", start - 2 * day)] }));
    expect(withPast.classificationChanges).toEqual([]);
    expect(withPast.expectedStateToken).not.toBe(empty.expectedStateToken);
  });
  const baseline = state({ reservations: [reservation("future", start + day)] });
  const variants: [string, PreviewReadState][] = [
    ["N", { ...baseline, standardCountConfig: { standardCount: 4 } }],
    ["explicit default vs missing", { ...baseline, standardCountConfig: { standardCount: 3 } }],
    ["publication time", { ...baseline, publishedAt: baseline.publishedAt! + 1 }],
    ["slot ID", { ...baseline, slot: { ...baseline.slot, slotId: "other-target" } }],
    ["slot start", { ...baseline, slot: { ...baseline.slot, startsAt: start + 1 } }],
    ["slot end", { ...baseline, slot: { ...baseline.slot, endsAt: start + 5401 } }],
    ["reservation ID", { ...baseline, reservations: [reservation("other", start + day)] }],
    ["reservation time", { ...baseline, reservations: [reservation("future", start + 2 * day)] }],
    ["exclusion", { ...baseline, reservations: [reservation("future", start + day, { monthlyCountOverride: "excluded", classification: null })] }],
    ["override", { ...baseline, reservations: [reservation("future", start + day, { classificationOverride: "standard" })] }],
    ["cancellation", { ...baseline, reservations: [reservation("future", start + day, { status: "student_cancelled", classification: null })] }],
    ["automatic and effective classification", { ...baseline, reservations: [additional("future", start + day)] }],
  ];
  it.each(variants)("changes token when %s changes", async (_name, input) => {
    expect((await preview(input)).expectedStateToken).not.toBe((await preview(baseline)).expectedStateToken);
  });
  it("binds token to server-resolved identity", async () => {
    const other = { studentId: "another-student" };
    expect((await previewReservation(other, state({ studentId: other.studentId }), now)).expectedStateToken)
      .not.toBe((await preview()).expectedStateToken);
  });
  it("hashes absence and per-reservation start boundary even if displayed changes stay empty", async () => {
    const past = additional("past", now - 5400);
    const withAbsence = { ...past, absent: true, classification: null };
    expect((await preview(state({ reservations: [past] }))).expectedStateToken)
      .not.toBe((await preview(state({ reservations: [withAbsence] }))).expectedStateToken);
    const crossing = reservation("crossing", now + 1);
    const input = state({ reservations: [crossing] });
    expect((await preview(input, now)).expectedStateToken).not.toBe((await preview(input, now + 1)).expectedStateToken);
  });
  it("classifies digest failure without exposing technical details", async () => {
    const spy = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("private-provider-error"));
    try {
      await expect(preview()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
    } finally { spy.mockRestore(); }
  });
});

describe("#610 §8 / BR-067: initial rejection and invariant fail-closed", () => {
  it.each([0, 1, 5400])("rejects at start + %s seconds", async (offset) => {
    await expect(preview(state(), start + offset)).rejects.toMatchObject({ code: "RESERVATION_WINDOW_CLOSED" });
  });
  it("accepts one second before the target start", async () => {
    await expect(preview(state(), start - 1)).resolves.toHaveProperty("previewClassification");
  });
  it.each([
    state({ publishedAt: null }), state({ reservationOperationAllowed: false }),
    state({ slot: { ...state().slot, availability: "disabled" } }),
    ...(["admin_hold", "group_lesson"] as const).map((type) => state({ slot: { ...state().slot,
      occupancies: [{ slotId: "target", type, reservationId: null }] } })),
    ...[identity.studentId, "private-other"].map((studentId) => state({ slot: { ...state().slot,
      occupancies: [{ slotId: "target", type: "student_reservation" as const, reservationId: "occupied" }],
      reservations: [{ reservationId: "occupied", slotId: "target", studentId, status: "confirmed" as const, classification: "standard" as const }],
    } })),
  ])("rejects unavailable inputs without a success token", async (input) => {
    await expect(preview(input)).rejects.toMatchObject({ code: "RESERVATION_NOT_AVAILABLE" });
  });
  const badReservation = (patch: Partial<MonthlyReservationReadState>) => state({ reservations: [reservation("bad", start + day, patch)] });
  const bad: [string, PreviewReadState][] = [
    ["unverified read", state({ integrity: "inconsistent" })],
    ["owner mismatch", state({ studentId: "private-other" })],
    ["wrong month", state({ month: "2026-12" })],
    ["invalid month", state({ month: "2026-13" })],
    ["invalid publication", state({ publishedAt: NaN })],
    ["invalid N", state({ standardCountConfig: { standardCount: -1 } })],
    ["fractional N", state({ standardCountConfig: { standardCount: 0.5 } })],
    ["missing config field", state({ standardCountConfig: undefined })],
    ["missing target integrity", state({ slot: { ...state().slot, integrity: "inconsistent" } })],
    ["orphan target reservation", state({ slot: { ...state().slot, reservations: [
      { reservationId: "orphan", slotId: "target", studentId: identity.studentId, status: "confirmed", classification: "standard" },
    ] } })],
    ["dangling occupancy", state({ slot: { ...state().slot, occupancies: [
      { slotId: "target", type: "student_reservation", reservationId: "private-reference" },
    ] } })],
    ["monthly confirmed target missing occupancy", badReservation({ slotId: "target", startsAt: start, endsAt: start + 5400 })],
    ["duplicate reservation", state({ reservations: [reservation("dup", start + day), reservation("dup", start + day)] })],
    ["duplicate confirmed slot", state({ reservations: [reservation("a", start + day, { slotId: "dup" }), reservation("b", start + day, { slotId: "dup" })] })],
    ["other student's monthly reservation", badReservation({ studentId: "private-other" })],
    ["wrong monthly datetime", badReservation({ startsAt: start + 31 * day, endsAt: start + 31 * day + 5400 })],
    ["fractional datetime", badReservation({ startsAt: start + 0.5 })],
    ["invalid duration", badReservation({ endsAt: start })],
    ["missing effective classification", badReservation({ classification: null })],
    ["cancelled with classification", badReservation({ status: "student_cancelled" })],
    ["absent before end", badReservation({ absent: true, classification: null })],
    ["exclusion with classification", badReservation({ monthlyCountOverride: "excluded" })],
    ["override mismatch", badReservation({ classificationOverride: "additional" })],
    ["missing exclusion field", badReservation({ monthlyCountOverride: undefined })],
    ["missing override field", badReservation({ classificationOverride: undefined })],
  ];
  it.each(bad)("rejects %s with a safe Application error", async (_name, input) => {
    await expect(preview(input)).rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE", message: "INTEGRITY_STATE_UNAVAILABLE" });
  });
  it.each([NaN, Infinity, now + 0.5])("rejects invalid server time %s", async (time) => {
    await expect(preview(state(), time)).rejects.toBeInstanceOf(ReservationPreviewError);
  });
});
