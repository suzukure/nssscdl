// #874: final server-only Transaction Port; no HTTP mapping or automatic retry.
import type { PreparedReservationConfirm } from "../application/reservation-confirm";
import {
  createReservationConfirmWritePlan, generateReservationConfirmIds,
  type ReservationConfirmIdGenerator,
} from "../application/reservation-confirm-plan";
import {
  ReservationConfirmTransactionError, type ReservationConfirmTransactionPort, type ReservationCommitVerifier,
} from "../application/reservation-commit-verification";
import { ReservationPreviewError } from "../application/reservation-preview";
import type { StudentSessionContext } from "../application/student-access-guard";
import { D1ReservationConfirmExecutor, ReservationCommitOutcomeUnknownError } from "./d1-reservation-confirm";

export class D1ReservationConfirmTransaction implements ReservationConfirmTransactionPort {
  constructor(
    private readonly executor: Pick<D1ReservationConfirmExecutor, "execute">,
    private readonly verifier: ReservationCommitVerifier,
    private readonly generator?: ReservationConfirmIdGenerator,
  ) {}

  async commit(prepared: PreparedReservationConfirm, context: StudentSessionContext) {
    try {
      const ids = generateReservationConfirmIds(prepared, this.generator);
      const plan = createReservationConfirmWritePlan(prepared, context.studentId, ids);
      try {
        await this.executor.execute(prepared, plan, context);
        return plan.committedResult;
      } catch (error) {
        if (!(error instanceof ReservationCommitOutcomeUnknownError) ||
            error.code !== "RESERVATION_COMMIT_OUTCOME_UNKNOWN") throw error;
        const attemptPlan = error.attempt.plan;
        const result = await this.verifier.verify(attemptPlan);
        switch (result.status) {
          case "COMMITTED": return attemptPlan.committedResult;
          case "NOT_APPLIED": throw new ReservationConfirmTransactionError("REVALIDATION_REQUIRED");
          case "INCONSISTENT": throw new ReservationConfirmTransactionError("INTEGRITY_STATE_UNAVAILABLE");
          default: throw new ReservationConfirmTransactionError("SERVICE_UNAVAILABLE");
        }
      }
    } catch (error) {
      // Keep only the final code. Never retain a cause, attempt, Context or read set.
      if (error instanceof ReservationConfirmTransactionError) throw new ReservationConfirmTransactionError(error.code);
      if (error instanceof ReservationPreviewError && error.code === "INTEGRITY_STATE_UNAVAILABLE") {
        throw new ReservationConfirmTransactionError("INTEGRITY_STATE_UNAVAILABLE");
      }
      throw new ReservationConfirmTransactionError("SERVICE_UNAVAILABLE");
    }
  }
}
