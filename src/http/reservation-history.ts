import { ReservationHistoryError, type ReservationHistoryService } from "../application/reservation-history";
import { StudentAccessError, type StudentAccessGuard } from "../application/student-access-guard";
import { validHistoryCursorGrammar } from "../infrastructure/reservation-history-cursor";
import { errorResponse } from "./application-error";

// Isolated GET composition; no CSRF, default dispatch or Session context input.
export class ReservationHistoryHttpAdapter {
  constructor(private readonly guard: StudentAccessGuard, private readonly service: ReservationHistoryService) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return errorResponse("SERVICE_UNAVAILABLE");
    const query = url.searchParams;
    if (request.method !== "GET" || url.pathname !== "/api/me/reservations" || request.body !== null ||
        [...query.keys()].some((key) => (key !== "limit" && key !== "cursor") || query.getAll(key).length !== 1)) {
      return errorResponse("INVALID_REQUEST");
    }
    const rawLimit = query.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = query.get("cursor") ?? undefined;
    if ((rawLimit !== null && /^[0-9]+$/.exec(rawLimit)?.[0] !== rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (cursor !== undefined && !validHistoryCursorGrammar(cursor))) return errorResponse("INVALID_REQUEST");
    try {
      const access = await this.guard.authorize(request);
      if (access.status === "unauthenticated") return errorResponse("UNAUTHENTICATED");
      if (access.status === "forbidden") return errorResponse("FORBIDDEN");
      return Response.json(await this.service.execute(access.studentId, limit, cursor), {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      if (error instanceof ReservationHistoryError || error instanceof StudentAccessError) return errorResponse(error.code);
      return errorResponse("SERVICE_UNAVAILABLE");
    }
  }
}
