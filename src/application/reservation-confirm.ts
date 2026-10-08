// #869: write-before preparation only; #610 §5.1/6/8, #611 §4/5.
import {
  createPreviewPlan,
  expectedStateToken,
  type CapturedPreviewRead,
  type ClassificationChange,
  type PreviewIdentity,
  type PreviewView,
  type ReservationClassificationPlan,
} from "./reservation-preview";
import type { Classification } from "./schedule-query";

export interface CapturedConfirmRead extends CapturedPreviewRead {
  readonly canonicalRawReadSet: string;
}

// No write capability. The D1 implementation shares capture with readPreview.
export interface ReservationConfirmPreparationRepository {
  readConfirm(identity: PreviewIdentity, slotId: string): Promise<CapturedConfirmRead>;
}

export class ReservationConfirmPreparationError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "RESERVATION_STATE_CHANGED") {
    super(code);
    this.name = "ReservationConfirmPreparationError";
  }
}

export interface PreparedReservationConfirm {
  readonly identity: PreviewIdentity;
  readonly studentId: string;
  readonly slotId: string;
  readonly evaluatedAt: number;
  readonly canonicalRawReadSet: string;
  readonly slot: PreviewView["slot"];
  readonly automaticClassification: Classification;
  readonly classification: Classification;
  readonly classificationPlan: readonly ReservationClassificationPlan[];
  readonly classificationChanges: readonly ClassificationChange[];
}

function validateToken(token: unknown): void {
  // 32 bytes encode to 43 base64url characters. The last character must have
  // its two unused bits zero; alphabet/length checks alone accept aliases.
  if (typeof token !== "string" || token.length !== 46 ||
      !/^v1\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) {
    throw new ReservationConfirmPreparationError("INVALID_REQUEST");
  }
}

export class ReservationConfirmPreparationService {
  constructor(private readonly repository: ReservationConfirmPreparationRepository) {}

  async prepare(slotId: string, token: string, identity: PreviewIdentity): Promise<PreparedReservationConfirm> {
    validateToken(token);
    const { state, evaluatedAt, canonicalRawReadSet } = await this.repository.readConfirm(identity, slotId);
    const plan = createPreviewPlan(identity, state, evaluatedAt);
    if (await expectedStateToken(plan.canonicalSnapshot) !== token) {
      throw new ReservationConfirmPreparationError("RESERVATION_STATE_CHANGED");
    }
    // Explicit copies freeze only our prepared values, not caller-owned identity
    // or repository state. No raw Snapshot/token/session data crosses to wire.
    return Object.freeze({
      identity: Object.freeze({ studentId: identity.studentId }), studentId: identity.studentId, slotId,
      evaluatedAt, canonicalRawReadSet, slot: Object.freeze({ ...plan.slot }),
      automaticClassification: plan.previewClassification, classification: plan.previewClassification,
      classificationPlan: Object.freeze(plan.classificationPlan.map((item) => Object.freeze({ ...item }))),
      classificationChanges: Object.freeze(plan.classificationChanges.map((item) => Object.freeze({ ...item }))),
    });
  }
}
