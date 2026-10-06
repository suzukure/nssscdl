import { ScheduleQueryError, ScheduleQueryService } from "../application/schedule-query";
import type { StudentAccessGuard } from "../application/student-access-guard";

// #610 §8. Fixed public messages; never serialize an exception or its cause.
const errors = {
  INVALID_REQUEST: { status: 400, message: "入力内容を確認してください。", retry: "none" },
  UNAUTHENTICATED: { status: 401, message: "認証が必要です。", retry: "none" },
  FORBIDDEN: { status: 403, message: "この操作は利用できません。", retry: "none" },
  SCHEDULE_MONTH_NOT_AVAILABLE: { status: 404, message: "指定された月の予定は利用できません。", retry: "none" },
  SERVICE_UNAVAILABLE: { status: 503, message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later" },
  INTEGRITY_STATE_UNAVAILABLE: { status: 503, message: "現在予定情報を利用できません。時間をおいて再度お試しください。", retry: "later" },
} as const;

function errorResponse(code: keyof typeof errors): Response {
  const { status, message, retry } = errors[code];
  return Response.json({ error: { code, message, retry } }, {
    status, headers: { "cache-control": "no-store" },
  });
}

// Endpoint-only adapter. No default Worker dispatch, bindings or auth adapter.
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
      if (access.status === "unauthenticated") return errorResponse("UNAUTHENTICATED");
      if (access.status === "forbidden") return errorResponse("FORBIDDEN");
      const view = await this.service.execute(month, access.studentId);
      return Response.json(view, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof ScheduleQueryError) return errorResponse(error.code);
      // Includes the existing D1 SERVICE_UNAVAILABLE boundary and unexpected
      // internal failures. Never turn a failed Guard into an authorized request.
      return errorResponse("SERVICE_UNAVAILABLE");
    }
  }
}
