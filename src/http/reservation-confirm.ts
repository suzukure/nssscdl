import { ReservationConfirmPreparationError, type ReservationConfirmPreparationService } from "../application/reservation-confirm";
import { ReservationConfirmTransactionError, type ReservationConfirmTransactionPort } from "../application/reservation-commit-verification";
import { ReservationPreviewError } from "../application/reservation-preview";
import { StudentAccessError, type StudentSessionResolver } from "../application/student-access-guard";
import { errorResponse } from "./application-error";
import { jsonString, readReservationJson } from "./reservation-json";
import { StudentSessionCsrf } from "./student-session-csrf";

// Exactly two string-valued fields. Decode keys before checking uniqueness;
// escaped aliases cannot bypass the exact field set. Field order is immaterial.
const ws = "[\\x20\\t\\r\\n]*";
const confirmObject = new RegExp(`^${ws}\\{${ws}(${jsonString})${ws}:${ws}(${jsonString})${ws},${ws}(${jsonString})${ws}:${ws}(${jsonString})${ws}\\}${ws}$`);

async function readConfirm(request: Request): Promise<{ slotId: string; expectedStateToken: string } | null> {
  const text = await readReservationJson(request);
  if (text === null) return null;
  const match = confirmObject.exec(text);
  if (!match) return null;
  const first: string = JSON.parse(match[1]);
  const second: string = JSON.parse(match[3]);
  if (!((first === "slotId" && second === "expectedStateToken") ||
        (first === "expectedStateToken" && second === "slotId"))) return null;
  const slotId: string = JSON.parse(match[first === "slotId" ? 2 : 4]);
  const expectedStateToken: string = JSON.parse(match[first === "expectedStateToken" ? 2 : 4]);
  return slotId.length > 0 && expectedStateToken.length > 0 ? { slotId, expectedStateToken } : null;
}

// Isolated server-only endpoint composition; default Worker dispatch stays closed.
export class ReservationConfirmHttpAdapter {
  private readonly csrf: StudentSessionCsrf;

  constructor(private readonly guard: StudentSessionResolver,
    private readonly preparation: Pick<ReservationConfirmPreparationService, "prepare">,
    private readonly transaction: ReservationConfirmTransactionPort, applicationOrigin: string | undefined) {
    this.csrf = new StudentSessionCsrf(applicationOrigin);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return errorResponse("SERVICE_UNAVAILABLE");
    if (request.method !== "POST" || url.pathname !== "/api/me/reservations" ||
        url.search !== "" || request.headers.get("content-type") !== "application/json") {
      return errorResponse("INVALID_REQUEST");
    }
    const input = await readConfirm(request);
    if (input === null) return errorResponse("INVALID_REQUEST");
    const { slotId, expectedStateToken } = input;
    try {
      const access = await this.guard.resolve(request);
      if (access.status === "unauthenticated") return errorResponse("UNAUTHENTICATED");
      if (!await this.csrf.validate(request)) return errorResponse("CSRF_INVALID");
      if (access.status === "forbidden") return errorResponse("FORBIDDEN");
      const prepared = await this.preparation.prepare(slotId, expectedStateToken, { studentId: access.context.studentId });
      try {
        const result = await this.transaction.commit(prepared, access.context);
        return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
      } catch (error) {
        if (!(error instanceof ReservationConfirmTransactionError) || error.code !== "REVALIDATION_REQUIRED") throw error;
      }
      // Only a proven NOT_APPLIED handoff reaches this read-only classification.
      // No CSRF recheck, ID generation, new plan or second commit is performed.
      const fresh = await this.guard.resolve(request);
      if (fresh.status === "unauthenticated") return errorResponse("UNAUTHENTICATED");
      if (fresh.status === "forbidden") return errorResponse("FORBIDDEN");
      try {
        await this.preparation.prepare(slotId, expectedStateToken, { studentId: fresh.context.studentId });
      } catch (error) {
        if (error instanceof ReservationPreviewError ||
            (error instanceof ReservationConfirmPreparationError && error.code === "RESERVATION_STATE_CHANGED")) {
          return errorResponse(error.code);
        }
        return errorResponse("SERVICE_UNAVAILABLE");
      }
      // A still-valid snapshot cannot establish a safe business conflict reason.
      return errorResponse("SERVICE_UNAVAILABLE");
    } catch (error) {
      if (error instanceof StudentAccessError || error instanceof ReservationPreviewError ||
          error instanceof ReservationConfirmPreparationError) return errorResponse(error.code);
      if (error instanceof ReservationConfirmTransactionError && error.code !== "REVALIDATION_REQUIRED") {
        return errorResponse(error.code);
      }
      return errorResponse("SERVICE_UNAVAILABLE");
    }
  }
}
