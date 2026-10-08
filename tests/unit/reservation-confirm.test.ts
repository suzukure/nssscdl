import { describe, expect, it, vi } from "vitest";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import { previewReservation, type PreviewReadState } from "../../src/application/reservation-preview";

const identity = { studentId: "student" };
const startsAt = Date.parse("2026-11-15T10:00:00+09:00") / 1000;
const now = startsAt - 86400;
function fixture() {
  const state: PreviewReadState = {
    studentId: "student", reservationOperationAllowed: true, month: "2026-11", publishedAt: 0,
    standardCountConfig: { standardCount: 1 }, integrity: "consistent",
    slot: { slotId: "target", startsAt, endsAt: startsAt + 3600, availability: "enabled",
      occupancies: [], reservations: [], integrity: "consistent" },
    reservations: [{ reservationId: "later", studentId: "student", slotId: "later-slot",
      startsAt: startsAt + 86400, endsAt: startsAt + 90000, status: "confirmed",
      automaticClassification: "standard", classification: "standard", absent: false,
      monthlyCountOverride: null, classificationOverride: "standard" }],
  };
  const captured = { state, evaluatedAt: now, canonicalRawReadSet: '{"private":"read-set"}' };
  const readConfirm = vi.fn(async () => captured);
  return { state, captured, readConfirm, service: new ReservationConfirmPreparationService({ readConfirm }) };
}

describe("[TC-F-003-01 / TC-F-003-02] Application/Confirm preparation partial evidence", () => {
  it("accepts the Preview token, retains automatic-only changes and freezes all prepared values", async () => {
    const f = fixture();
    const preview = await previewReservation(identity, f.state, now);
    const prepared = await f.service.prepare("target", preview.expectedStateToken, identity);
    expect(f.readConfirm).toHaveBeenCalledExactlyOnceWith(identity, "target");
    expect(prepared).toMatchObject({ identity, studentId: "student", slotId: "target", evaluatedAt: now,
      canonicalRawReadSet: f.captured.canonicalRawReadSet,
      automaticClassification: "standard", classification: "standard", classificationChanges: [],
      classificationPlan: [{ reservationId: "later", startsAt: "2026-11-16T10:00:00+09:00",
        automaticBefore: "standard", automaticAfter: "additional", before: "standard", after: "standard" }] });
    for (const value of [prepared, prepared.identity, prepared.slot, prepared.classificationPlan,
      prepared.classificationPlan[0], prepared.classificationChanges]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => Object.assign(prepared.identity, { studentId: "changed" })).toThrow();
    expect(Object.isFrozen(identity)).toBe(false);
    expect(prepared).not.toHaveProperty("canonicalSnapshot");
    expect(prepared).not.toHaveProperty("expectedStateToken");
  });
  it.each([undefined, null, 1, "", "v2." + "A".repeat(43), "v1." + "A".repeat(42),
    "v1." + "A".repeat(44), "v1." + "A".repeat(43) + "=", "v1." + "/".repeat(43),
    "v1." + "+".repeat(43), "v1." + "A".repeat(42) + "B", "v1." + "A".repeat(43) + "\n"])(
    "rejects noncanonical token %s before any repository read", async (token) => {
      const f = fixture();
      await expect(f.service.prepare("target", token as string, identity))
        .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "INVALID_REQUEST" });
      expect(f.readConfirm).not.toHaveBeenCalled();
    });
  it("retains and freezes effective changes separately from the complete classification plan", async () => {
    const f = fixture();
    Object.assign(f.state.reservations[0], { classificationOverride: null });
    const view = await previewReservation(identity, f.state, now);
    const prepared = await f.service.prepare("target", view.expectedStateToken, identity);
    expect(prepared.classificationChanges).toEqual([{ reservationId: "later",
      startsAt: "2026-11-16T10:00:00+09:00", before: "standard", after: "additional" }]);
    expect(Object.isFrozen(prepared.classificationChanges[0])).toBe(true);
    expect(prepared.classificationChanges[0]).not.toHaveProperty("automaticAfter");
  });
  it("rejects a valid-format fingerprint mismatch with a safe error", async () => {
    const f = fixture();
    const error = await f.service.prepare("target", "v1." + "A".repeat(43), identity).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "RESERVATION_STATE_CHANGED", message: "RESERVATION_STATE_CHANGED" });
    expect(Object.keys(error as object)).toEqual(["code", "name"]);
    expect(JSON.stringify(error)).not.toMatch(/private|student|Snapshot|read-set/);
  });
  it.each(["started", "unpublished", "disabled", "denied", "integrity"])(
    "preserves current %s rejection ahead of mismatch", async (mode) => {
      const f = fixture();
      if (mode === "started") f.captured.evaluatedAt = startsAt;
      if (mode === "unpublished") Object.assign(f.state, { publishedAt: null });
      if (mode === "disabled") Object.assign(f.state.slot, { availability: "disabled" });
      if (mode === "denied") Object.assign(f.state, { reservationOperationAllowed: false });
      if (mode === "integrity") Object.assign(f.state, { integrity: "inconsistent" });
      await expect(f.service.prepare("target", "v1." + "A".repeat(43), identity)).rejects.toMatchObject({
        code: mode === "started" ? "RESERVATION_WINDOW_CLOSED" : mode === "integrity"
          ? "INTEGRITY_STATE_UNAVAILABLE" : "RESERVATION_NOT_AVAILABLE",
      });
    });
  it("uses captured server time and excludes started reservations from the internal plan", async () => {
    const f = fixture();
    const token = (await previewReservation(identity, f.state, now)).expectedStateToken;
    const spy = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try { expect((await f.service.prepare("target", token, identity)).evaluatedAt).toBe(now); }
    finally { spy.mockRestore(); }
    f.captured.evaluatedAt = startsAt + 86400;
    // A later target is needed to keep preparation available after the old item starts.
    Object.assign(f.state.slot, { startsAt: startsAt + 2 * 86400, endsAt: startsAt + 2 * 86400 + 3600 });
    const laterToken = (await previewReservation(identity, f.state, f.captured.evaluatedAt)).expectedStateToken;
    expect((await f.service.prepare("target", laterToken, identity)).classificationPlan).toEqual([]);
  });
  it("abstracts digest unavailability", async () => {
    const f = fixture();
    const spy = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("private-digest"));
    try {
      await expect(f.service.prepare("target", "v1." + "A".repeat(43), identity))
        .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
    } finally { spy.mockRestore(); }
  });
});
