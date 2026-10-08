import { isCanonicalToken, studentSessionToken } from "../infrastructure/student-session-cookie";
import { StudentAccessError } from "../application/student-access-guard";

// Fixed-length comparison: all 43 characters are examined, with no mismatch exit.
function constantTimeEqual(actual: string, expected: string): boolean {
  let difference = 0;
  for (let index = 0; index < 43; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export class StudentSessionCsrf {
  constructor(private readonly applicationOrigin: string | undefined) {}

  // Called only after successful Session resolution, including forbidden.
  async validate(request: Request): Promise<boolean> {
    let origin: URL;
    try {
      origin = new URL(this.applicationOrigin ?? "");
      if (origin.protocol !== "https:" || origin.origin !== this.applicationOrigin) throw new Error();
    } catch {
      throw new StudentAccessError("SERVICE_UNAVAILABLE");
    }
    const fetchSite = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== origin.origin ||
        (fetchSite !== null && fetchSite !== "same-origin")) return false;
    const actual = request.headers.get("x-csrf-token");
    const rawToken = studentSessionToken(request);
    if (actual === null || !isCanonicalToken(actual) || rawToken === null) return false;
    try {
      const digest = await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode("student-csrf-v1:" + rawToken));
      const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return constantTimeEqual(actual, expected);
    } catch {
      throw new StudentAccessError("SERVICE_UNAVAILABLE");
    }
  }
}
