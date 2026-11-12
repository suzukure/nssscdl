import { describe, expect, it, vi } from "vitest";
import type { PreparedReservationConfirm } from "../../src/application/reservation-confirm";
import { ReservationPreviewError } from "../../src/application/reservation-preview";
import { ReservationConfirmTransactionError } from "../../src/application/reservation-commit-verification";
import { createReservationConfirmWritePlan, generateReservationConfirmIds } from "../../src/application/reservation-confirm-plan";
import { ReservationCommitOutcomeUnknownError } from "../../src/infrastructure/d1-reservation-confirm";
import { D1ReservationConfirmTransaction } from "../../src/infrastructure/d1-reservation-confirm-transaction";
import { D1ReservationCommitVerifier } from "../../src/infrastructure/d1-reservation-commit-verification";

const context = { studentId: "student", sessionId: "private-session", tokenHash: "private-hash" };
const prepared: PreparedReservationConfirm = {
  identity: { studentId: "student" }, studentId: "student", slotId: "slot", evaluatedAt: 0,
  canonicalRawReadSet: "private-read-set", slot: { slotId: "slot", startsAt: "2026-11-01T10:00:00+09:00",
    endsAt: "2026-11-01T11:00:00+09:00" }, automaticClassification: "standard", classification: "standard",
  classificationPlan: [], classificationChanges: [],
};
const privateDiagnostic = "private SQL constraint table column";
const plan = () => createReservationConfirmWritePlan(prepared, "student", generateReservationConfirmIds(prepared));
function safeError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ReservationConfirmTransactionError);
  expect(error).toMatchObject({ code, message: code });
  expect(error).not.toHaveProperty("attempt");
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("status");
  expect(JSON.stringify(error)).not.toMatch(/private|SQL|constraint|table|column|canonicalRawReadSet/);
}

describe("[TC-F-003-01 / TC-NF-914-04 partial] #874 final Transaction Port", () => {
  it.each([
    new Error(privateDiagnostic),
    { code: "RESERVATION_COMMIT_OUTCOME_UNKNOWN", attempt: { plan: plan() } },
    new ReservationPreviewError("SERVICE_UNAVAILABLE"),
    new ReservationPreviewError("INTEGRITY_STATE_UNAVAILABLE"),
  ])("does not verify any error outside the exact internal handoff", async (error) => {
    const execute = vi.fn(async () => { throw error; });
    const verify = vi.fn();
    const port = new D1ReservationConfirmTransaction({ execute }, { verify });
    const failure = await port.commit(prepared, context).catch((e: unknown) => e);
    safeError(failure, error instanceof ReservationPreviewError ? error.code : "SERVICE_UNAVAILABLE");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["COMMITTED", "NOT_APPLIED", "INCONSISTENT"] as const)("same immutable attempt and only one execution: %s", async (status) => {
    const generator = { generateId: vi.fn(() => crypto.randomUUID()) };
    let attemptPlan: ReturnType<typeof plan> | undefined;
    const execute = vi.fn(async (_prepared: PreparedReservationConfirm, writePlan: ReturnType<typeof plan>) => {
      attemptPlan = writePlan;
      expect(Object.isFrozen(writePlan)).toBe(true);
      throw new ReservationCommitOutcomeUnknownError(Object.freeze({ plan: writePlan }));
    });
    const verify = vi.fn(async () => ({ status }));
    const port = new D1ReservationConfirmTransaction({ execute }, { verify }, generator);
    if (status === "COMMITTED") expect(await port.commit(prepared, context)).toBe(attemptPlan!.committedResult);
    else safeError(await port.commit(prepared, context).catch((e: unknown) => e),
      status === "NOT_APPLIED" ? "REVALIDATION_REQUIRED" : "INTEGRITY_STATE_UNAVAILABLE");
    expect(verify).toHaveBeenCalledExactlyOnceWith(attemptPlan);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(generator.generateId).toHaveBeenCalledTimes(5);
    expect(verify.mock.calls[0]).toHaveLength(1);
  });
  it("abstracts verifier failure without retaining its diagnostics", async () => {
    const execute = vi.fn(async () => { throw new ReservationCommitOutcomeUnknownError({ plan: plan() }); });
    const verify = vi.fn(async () => { throw new Error(privateDiagnostic); });
    safeError(await new D1ReservationConfirmTransaction({ execute }, { verify }).commit(prepared, context)
      .catch((e: unknown) => e), "SERVICE_UNAVAILABLE");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it("generator failure performs no execution or verification", async () => {
    const execute = vi.fn();
    const verify = vi.fn();
    const generator = { generateId: vi.fn(() => { throw new Error(privateDiagnostic); }) };
    safeError(await new D1ReservationConfirmTransaction({ execute }, { verify }, generator).commit(prepared, context)
      .catch((e: unknown) => e), "SERVICE_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("[TC-NF-914-04 partial] #874 Primary read / decode failure", () => {
  it.each(["session", "prepare", "bind", "read"])("%s failure cannot invent a verification state", async (stage) => {
    const fail = () => { throw new Error(privateDiagnostic); };
    const statement = { bind() { if (stage === "bind") fail(); return statement; }, first: async () => fail() };
    const verifier = new D1ReservationCommitVerifier({ withSession() {
      if (stage === "session") fail();
      return { prepare() { if (stage === "prepare") fail(); return statement; } };
    } });
    safeError(await verifier.verify(plan()).catch((e: unknown) => e), "SERVICE_UNAVAILABLE");
  });
  const empty = { reservation: null, occupancy: null, audit: null, intents: "[null]", outbox: "[null]",
    reclassifications: "[]", command_guard_present: 0, audit_count: 0, new_reservation_intent_count: 0 };
  it.each([null, {}, { ...empty, intents: "invalid" }, { ...empty, outbox: "{}" },
    { ...empty, reservation: '{"id":"incomplete"}' }, { ...empty, audit: "{}" },
    { ...empty, command_guard_present: 2 }, { ...empty, audit_count: -1 },
    { ...empty, new_reservation_intent_count: "0" }, { ...empty, intents: "[{}]" },
    { ...empty, reclassifications: "[{}]" }, { ...empty, occupancy: "{}" },
  ])("decode/construction failure stays SERVICE_UNAVAILABLE", async (row) => {
    const statement = { bind: () => statement, first: async () => row };
    const verifier = new D1ReservationCommitVerifier({ withSession: () => ({ prepare: () => statement }) });
    safeError(await verifier.verify(plan()).catch((e: unknown) => e), "SERVICE_UNAVAILABLE");
  });
  it("a successfully decoded absent read is NOT_APPLIED", async () => {
    const statement = { bind: () => statement, first: async () => empty };
    const verifier = new D1ReservationCommitVerifier({ withSession: () => ({ prepare: () => statement }) });
    expect(await verifier.verify(plan())).toEqual({ status: "NOT_APPLIED" });
  });
});
