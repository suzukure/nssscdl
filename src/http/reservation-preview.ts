import { ReservationPreviewError, ReservationPreviewService } from "../application/reservation-preview";
import { StudentAccessError, type StudentSessionResolver } from "../application/student-access-guard";
import { errorResponse } from "./application-error";
import { StudentSessionCsrf } from "./student-session-csrf";

// Only this exact object grammar is accepted. JSON.parse decodes escaped keys
// and strings after syntax matching; no duplicate key can pass this grammar.
const jsonString = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
const slotObject = new RegExp(`^[\\x20\\t\\r\\n]*\\{[\\x20\\t\\r\\n]*(${jsonString})[\\x20\\t\\r\\n]*:[\\x20\\t\\r\\n]*(${jsonString})[\\x20\\t\\r\\n]*\\}[\\x20\\t\\r\\n]*$`);

async function readSlotId(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        // Cancellation cannot delay the bounded rejection.
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const match = slotObject.exec(text);
    if (!match || JSON.parse(match[1]) !== "slotId") return null;
    const slotId: string = JSON.parse(match[2]);
    return slotId.length > 0 ? slotId : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

// Endpoint-only composition. No entrypoint dispatch, binding or write.
export class ReservationPreviewHttpAdapter {
  private readonly csrf: StudentSessionCsrf;

  constructor(private readonly guard: StudentSessionResolver,
    private readonly service: ReservationPreviewService, applicationOrigin: string | undefined) {
    this.csrf = new StudentSessionCsrf(applicationOrigin);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return errorResponse("SERVICE_UNAVAILABLE");
    if (request.method !== "POST" || url.pathname !== "/api/me/reservations/preview" ||
        url.search !== "" || request.headers.get("content-type") !== "application/json") {
      return errorResponse("INVALID_REQUEST");
    }
    const slotId = await readSlotId(request);
    if (slotId === null) return errorResponse("INVALID_REQUEST");
    try {
      const access = await this.guard.resolve(request);
      if (access.status === "unauthenticated") return errorResponse("UNAUTHENTICATED");
      if (!await this.csrf.validate(request)) return errorResponse("CSRF_INVALID");
      if (access.status === "forbidden") return errorResponse("FORBIDDEN");
      const view = await this.service.execute(slotId, { studentId: access.context.studentId });
      return Response.json(view, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof StudentAccessError || error instanceof ReservationPreviewError) {
        return errorResponse(error.code);
      }
      return errorResponse("SERVICE_UNAVAILABLE");
    }
  }
}
