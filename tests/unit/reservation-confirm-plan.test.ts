import { describe, expect, it, vi } from "vitest";
import type { PreparedReservationConfirm } from "../../src/application/reservation-confirm";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import {
  createReservationConfirmWritePlan, generateReservationConfirmIds,
  type ReservationConfirmIds,
} from "../../src/application/reservation-confirm-plan";
import { previewReservation, type ReservationClassificationPlan } from "../../src/application/reservation-preview";

const startsAt = "2026-11-01T10:00:00+09:00";
const endsAt = "2026-11-01T11:00:00+09:00";
function prepared(): PreparedReservationConfirm {
  const classificationPlan: ReservationClassificationPlan[] = [
    { reservationId: "unchanged", startsAt, automaticBefore: "standard", automaticAfter: "standard",
      before: "standard", after: "standard" },
    { reservationId: "automatic-only", startsAt: "2026-11-08T10:00:00+09:00",
      automaticBefore: "standard", automaticAfter: "additional", before: "standard", after: "standard" },
    { reservationId: "effective-a", startsAt: "2026-11-15T10:00:00+09:00",
      automaticBefore: "standard", automaticAfter: "additional", before: "standard", after: "additional" },
    { reservationId: "effective-b", startsAt: "2026-11-15T10:00:00+09:00",
      automaticBefore: "additional", automaticAfter: "standard", before: "additional", after: "standard" },
  ];
  return {
    identity: { studentId: "student" }, studentId: "student", slotId: "slot", evaluatedAt: 0,
    canonicalRawReadSet: '{"private":"raw-read"}', slot: { slotId: "slot", startsAt, endsAt },
    automaticClassification: "standard", classification: "standard", classificationPlan,
    classificationChanges: classificationPlan.filter((item) => item.before !== item.after)
      .map(({ reservationId, startsAt, before, after }) => ({ reservationId, startsAt, before, after })),
  };
}
function ids(p = prepared()): ReservationConfirmIds {
  const values = ["command", "reservation", "occupancy", "audit", "confirmation", "change-a", "change-b"];
  return generateReservationConfirmIds(p, { generateId: () => values.shift()! });
}

describe("[TC-F-003-01 / TC-F-003-02 / TC-F-101-01 / TC-F-104-01 / TC-NF-940-01 / TC-NF-940-02] pure Confirm plan partial evidence", () => {
  it("fixes Audit and Intent JSON bytes, field order, recipient and outbox pairing", () => {
    const p = prepared();
    const generated = ids(p);
    const plan = createReservationConfirmWritePlan(p, "student", generated);
    const repeated = createReservationConfirmWritePlan(p, "student", generated);
    expect(plan).toEqual(repeated);
    expect(new TextEncoder().encode(plan.audit.afterJson))
      .toEqual(new TextEncoder().encode(repeated.audit.afterJson));
    expect(plan.audit).toEqual({ id: "audit", action: "reservation_confirm", actorType: "student",
      actorId: "student", targetType: "student_reservation", targetId: "reservation", beforeJson: null,
      afterJson: '{"version":1,"reservation":{"id":"reservation","automatic_classification":"standard","classification":"standard"},"derived_changes":[{"reservation_id":"automatic-only","before":{"automatic_classification":"standard","classification":"standard"},"after":{"automatic_classification":"additional","classification":"standard"}},{"reservation_id":"effective-a","before":{"automatic_classification":"standard","classification":"standard"},"after":{"automatic_classification":"additional","classification":"additional"}},{"reservation_id":"effective-b","before":{"automatic_classification":"additional","classification":"additional"},"after":{"automatic_classification":"standard","classification":"standard"}}]}',
      result: "committed" });
    expect(plan.notificationIntents).toEqual([
      { id: "confirmation", kind: "reservation_confirmation", recipientStudentId: "student",
        reservationId: "reservation", obligationState: "valid",
        payloadJson: '{"version":1,"reservation":{"id":"reservation","startsAt":"2026-11-01T10:00:00+09:00","endsAt":"2026-11-01T11:00:00+09:00","classification":"standard"}}' },
      { id: "change-a", kind: "classification_change", recipientStudentId: "student",
        reservationId: "effective-a", obligationState: "valid",
        payloadJson: '{"version":1,"reservation":{"id":"effective-a","startsAt":"2026-11-15T10:00:00+09:00","before":"standard","after":"additional"}}' },
      { id: "change-b", kind: "classification_change", recipientStudentId: "student",
        reservationId: "effective-b", obligationState: "valid",
        payloadJson: '{"version":1,"reservation":{"id":"effective-b","startsAt":"2026-11-15T10:00:00+09:00","before":"additional","after":"standard"}}' },
    ]);
    plan.notificationIntents.forEach((intent, index) => {
      expect(new TextEncoder().encode(intent.payloadJson))
        .toEqual(new TextEncoder().encode(repeated.notificationIntents[index].payloadJson));
    });
    expect(plan.outbox).toEqual([{ intentId: "confirmation" }, { intentId: "change-a" }, { intentId: "change-b" }]);
  });
  it("preserves every Guard target and stable tie order while omitting unchanged writes", () => {
    const p = prepared();
    const plan = createReservationConfirmWritePlan(p, "student", ids(p));
    expect(plan.classificationGuardTargets).toEqual(p.classificationPlan.map((item, index) => ({
      ...item, updateRequired: index > 0, effectiveChange: index > 1,
    })));
    expect(plan.reclassificationWrites.map((item) => item.reservationId))
      .toEqual(["automatic-only", "effective-a", "effective-b"]);
    expect(plan.committedResult).toEqual({
      reservation: { reservationId: "reservation", startsAt, endsAt, reservationState: "confirmed",
        classification: "standard" },
      slot: { slotId: "slot", startsAt, endsAt, view: "reserved_by_me" },
      classificationChanges: p.classificationChanges,
    });
    expect(plan.reservation).toEqual({ id: "reservation", studentId: "student", slotId: "slot",
      status: "confirmed", automaticClassification: "standard", classification: "standard" });
    expect(plan.occupancy).toEqual({ id: "occupancy", slotId: "slot", occupancyType: "student_reservation",
      reservationId: "reservation", createdBy: "student" });
  });
  it.each(["none", "unchanged", "automatic-only"])("always plans exactly one confirmation with %s changes", (mode) => {
    const p = { ...prepared(), classificationPlan: prepared().classificationPlan.filter((item) => item.reservationId === mode) };
    const generated = ids(p);
    expect(generated.classificationChangeIntentIds).toEqual([]);
    const plan = createReservationConfirmWritePlan(p, "student", generated);
    expect(plan.notificationIntents).toHaveLength(1);
    expect(plan.committedResult.classificationChanges).toEqual([]);
    expect(JSON.parse(plan.audit.afterJson).derived_changes).toHaveLength(mode === "automatic-only" ? 1 : 0);
    expect(plan.classificationGuardTargets).toHaveLength(mode === "none" ? 0 : 1);
  });
  it("handles an effective-only update and projects additional confirmation", () => {
    const p = { ...prepared(), automaticClassification: "additional" as const, classification: "additional" as const,
      classificationPlan: [{ ...prepared().classificationPlan[0], after: "additional" as const }] };
    const plan = createReservationConfirmWritePlan(p, "student", ids(p));
    expect(plan.reclassificationWrites[0]).toMatchObject({ updateRequired: true, effectiveChange: true,
      automaticBefore: "standard", automaticAfter: "standard" });
    expect(JSON.parse(plan.notificationIntents[0].payloadJson).reservation.classification).toBe("additional");
    expect(plan.committedResult.reservation.classification).toBe("additional");
    expect(plan.notificationIntents[1].kind).toBe("classification_change");
  });
  it.each(["other-student", ""])("rejects mismatched Guard identity %s", (studentId) => {
    expect(() => createReservationConfirmWritePlan(prepared(), studentId, ids()))
      .toThrowError("INTEGRITY_STATE_UNAVAILABLE");
  });
  it("rejects every pair of duplicate generated IDs across the whole Command", () => {
    const keys = ["commandId", "reservationId", "occupancyId", "auditId", "reservationConfirmationIntentId"] as const;
    const original = ids();
    const values = [...keys.map((key) => original[key]), ...original.classificationChangeIntentIds];
    for (let first = 0; first < values.length; first++) {
      for (let second = first + 1; second < values.length; second++) {
        const duplicate = [...values];
        duplicate[second] = duplicate[first];
        const generated = generateReservationConfirmIds(prepared(), { generateId: () => duplicate.shift()! });
        expect(() => createReservationConfirmWritePlan(prepared(), "student", generated))
          .toThrowError("INTEGRITY_STATE_UNAVAILABLE");
      }
    }
  });
  it.each([{ changeIds: [] }, { changeIds: ["only"] }, { changeIds: ["one", "two", "extra"] }])
  ("rejects incorrect change ID cardinality $changeIds", ({ changeIds }) => {
    expect(() => createReservationConfirmWritePlan(prepared(), "student", { ...ids(), classificationChangeIntentIds: changeIds }))
      .toThrowError("INTEGRITY_STATE_UNAVAILABLE");
  });
  it.each([
    { changeIds: undefined }, { changeIds: null }, { changeIds: "ab" },
    { changeIds: { length: 2 } }, { changeIds: ["change-a", undefined] },
    { changeIds: ["change-a", ""] }, { changeIds: ["change-a", 42] },
    { changeIds: new Array(2) },
  ])("rejects malformed change ID arrays $changeIds", ({ changeIds }) => {
    const generated = { ...ids(), classificationChangeIntentIds: changeIds } as unknown as ReservationConfirmIds;
    expect(() => createReservationConfirmWritePlan(prepared(), "student", generated))
      .toThrowError("INTEGRITY_STATE_UNAVAILABLE");
  });
  it.each([undefined, null, "ids", [], {}].map((generated) => ({ generated })))
  ("rejects malformed ID sets $generated", ({ generated }) => {
    expect(() => createReservationConfirmWritePlan(prepared(), "student", generated as unknown as ReservationConfirmIds))
      .toThrowError("INTEGRITY_STATE_UNAVAILABLE");
  });
  it.each(["commandId", "reservationId", "occupancyId", "auditId", "reservationConfirmationIntentId"] as const)
  ("rejects missing or malformed scalar ID %s", (key) => {
    for (const value of [undefined, null, "", 42, {}]) {
      expect(() => createReservationConfirmWritePlan(prepared(), "student", { ...ids(), [key]: value }))
        .toThrowError("INTEGRITY_STATE_UNAVAILABLE");
    }
  });
  it("rejects empty IDs and abstracts generator failure", () => {
    expect(() => createReservationConfirmWritePlan(prepared(), "student", { ...ids(), commandId: "" }))
      .toThrowError("INTEGRITY_STATE_UNAVAILABLE");
    expect(() => generateReservationConfirmIds(prepared(), { generateId: () => { throw new Error("private"); } }))
      .toThrowError("SERVICE_UNAVAILABLE");
  });
  it("uses Web UUID by default and keeps generation outside deterministic projection", () => {
    const spy = vi.spyOn(crypto, "randomUUID");
    try {
      const generated = generateReservationConfirmIds(prepared());
      expect(spy).toHaveBeenCalledTimes(7);
      createReservationConfirmWritePlan(prepared(), "student", generated);
      expect(spy).toHaveBeenCalledTimes(7);
      expect(new Set([generated.commandId, generated.reservationId, generated.occupancyId,
        generated.auditId, generated.reservationConfirmationIntentId, ...generated.classificationChangeIntentIds]).size).toBe(7);
    } finally { spy.mockRestore(); }
  });
  it("does not leak arbitrary source fields, Session data, read snapshots or persistence time", () => {
    const p = prepared();
    const extras = { name: "private-name", email: "private-email", N: 99, fee: 50,
      sessionId: "private-session", tokenHash: "private-hash", payloadJson: "client-payload" };
    Object.assign(p, extras);
    Object.assign(p.slot, extras);
    p.classificationPlan.forEach((item) => Object.assign(item, extras));
    const plan = createReservationConfirmWritePlan(p, "student", ids(p));
    const json = JSON.stringify([plan.audit, plan.notificationIntents, plan.committedResult]);
    expect(json).not.toMatch(/private-|raw-read|client-payload|sessionId|tokenHash|email|name|"N"|fee|evaluatedAt/);
    expect(JSON.stringify(plan)).not.toMatch(/dueAt|occurredAt|createdAt|updatedAt|capturedAt|sessionId|tokenHash/);
    expect(plan.canonicalRawReadSet).toBe(p.canonicalRawReadSet);
  });
  it("copies and freezes the plan without freezing caller objects", () => {
    const p = prepared();
    const generated = { ...ids(), classificationChangeIntentIds: ["change-a", "change-b"] };
    const plan = createReservationConfirmWritePlan(p, "student", generated);
    const before = JSON.stringify(plan);
    Object.assign(p.slot, { startsAt: "changed" });
    Object.assign(p.classificationPlan[0], { after: "additional" });
    generated.classificationChangeIntentIds[0] = "changed";
    expect(JSON.stringify(plan)).toBe(before);
    function checkFrozen(value: unknown): void {
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(checkFrozen);
      }
    }
    checkFrozen(plan);
    expect(Object.isFrozen(p)).toBe(false);
  });
  it("consumes real #869 preparation and never invokes its repository during planning", async () => {
    const start = Date.parse(startsAt) / 1000;
    const state = { studentId: "student", reservationOperationAllowed: true, month: "2026-11", publishedAt: 0,
      standardCountConfig: null, integrity: "consistent" as const, reservations: [],
      slot: { slotId: "slot", startsAt: start, endsAt: start + 3600, availability: "enabled" as const,
        occupancies: [], reservations: [], integrity: "consistent" as const } };
    const readConfirm = vi.fn(async () => ({ state, evaluatedAt: start - 1, canonicalRawReadSet: "{}" }));
    const token = (await previewReservation({ studentId: "student" }, state, start - 1)).expectedStateToken;
    const p = await new ReservationConfirmPreparationService({ readConfirm }).prepare("slot", token, { studentId: "student" });
    readConfirm.mockClear();
    const plan = createReservationConfirmWritePlan(p, "student", ids(p));
    expect(plan.classificationGuardTargets).toEqual([]);
    expect(plan.notificationIntents).toHaveLength(1);
    expect(readConfirm).not.toHaveBeenCalled();
  });
});
