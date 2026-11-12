import { StudentAccessError, type StudentSessionResolver } from "../application/student-access-guard";
import { studentSessionToken } from "../infrastructure/student-session-cookie";
import { errorResponse } from "./application-error";
import { canonicalStudentOrigin, createStudentSessionCsrfToken } from "./student-session-csrf";

// Unconnected endpoint-only composition seam. Production composition must use
// D1StudentAccessGuard; preauth issuance/reuse and public activation are absent.
export class StudentSessionCsrfGetHttpAdapter {
  constructor(private readonly guard: StudentSessionResolver,
    private readonly applicationOrigin: string | undefined) {}

  async fetch(request: Request): Promise<Response> {
    const response = await this.respond(request);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }

  private async respond(request: Request): Promise<Response> {
    try {
      const origin = canonicalStudentOrigin(this.applicationOrigin);
      const url = new URL(request.url);
      if (url.protocol !== "https:" || url.origin !== origin) return errorResponse("SERVICE_UNAVAILABLE");
      if (request.method !== "GET" || url.pathname !== "/api/auth/student/csrf" ||
          url.href.includes("?") || url.hash !== "" || url.username !== "" || url.password !== "" ||
          request.body !== null || request.headers.has("transfer-encoding") ||
          (request.headers.has("content-length") && request.headers.get("content-length") !== "0")) {
        return errorResponse("INVALID_REQUEST");
      }
      const requestOrigin = request.headers.get("origin");
      const fetchSite = request.headers.get("sec-fetch-site");
      if ((fetchSite !== null && fetchSite !== "same-origin") ||
          (requestOrigin === null ? fetchSite !== "same-origin" : requestOrigin !== origin)) {
        return errorResponse("CSRF_INVALID");
      }
      const access = await this.guard.resolve(request);
      if (access.status === "unauthenticated") return errorResponse("UNAUTHENTICATED");
      if (access.status === "forbidden") return errorResponse("FORBIDDEN");
      const rawToken = studentSessionToken(request);
      if (rawToken === null) return errorResponse("UNAUTHENTICATED");
      const csrfToken = await createStudentSessionCsrfToken(rawToken);
      return Response.json({ csrfToken, scope: "session" });
    } catch (error) {
      return errorResponse(error instanceof StudentAccessError ? error.code : "SERVICE_UNAVAILABLE");
    }
  }
}
