import { errorResponse } from "./application-error";
import { ScheduleQueryError, ScheduleQueryService } from "../application/schedule-query";
import { StudentAccessError, type StudentAccessGuard } from "../application/student-access-guard";

// Endpoint-only adapter. Guard composition is explicit; no default dispatch.
export class ScheduleMonthHttpAdapter {
  constructor(private readonly guard: StudentAccessGuard, private readonly service: ScheduleQueryService) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = /^\/api\/me\/schedule-months\/([^/]+)$/.exec(url.pathname);
    let month: string;
    try {
      month = path ? decodeURIComponent(path[1]) : "";
    } catch {
      return errorResponse("INVALID_REQUEST");
    }
    if (request.method !== "GET" || month.length !== 7 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
        url.searchParams.size !== 0) {
      return errorResponse("INVALID_REQUEST");
    }
    try {
      const access = await this.guard.authorize(request);
      if (access.status === "unauthenticated") {
        return errorResponse("UNAUTHENTICATED");
      }
      if (access.status === "forbidden") return errorResponse("FORBIDDEN");
      const view = await this.service.execute(month, access.studentId);
      return Response.json(view, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof ScheduleQueryError || error instanceof StudentAccessError) return errorResponse(error.code);
      // Includes the existing D1 SERVICE_UNAVAILABLE boundary and unexpected
      // internal failures. Never turn a failed Guard into an authorized request.
      return errorResponse("SERVICE_UNAVAILABLE");
    }
  }
}
