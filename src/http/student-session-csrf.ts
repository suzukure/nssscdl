import { isCanonicalToken, studentSessionToken } from "../infrastructure/student-session-cookie";
import { StudentAccessError } from "../application/student-access-guard";

// Single deterministic derivation for issuance and validation. No stored hash
// or Guard Context is accepted; the canonical raw Cookie stays transient.
export async function createStudentSessionCsrfToken(rawSessionToken: string): Promise<string> {
  try {
    if (!isCanonicalToken(rawSessionToken)) throw new Error();
    const digest = await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode("student-csrf-v1:" + rawSessionToken));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    throw new StudentAccessError("SERVICE_UNAVAILABLE");
  }
}

export function canonicalStudentOrigin(applicationOrigin: string | undefined): string {
  try {
    const origin = new URL(applicationOrigin ?? "");
    if (origin.protocol !== "https:" || origin.origin !== applicationOrigin) throw new Error();
    return origin.origin;
  } catch {
    throw new StudentAccessError("SERVICE_UNAVAILABLE");
  }
}

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
    const origin = canonicalStudentOrigin(this.applicationOrigin);
    const fetchSite = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== origin ||
        (fetchSite !== null && fetchSite !== "same-origin")) return false;
    const actual = request.headers.get("x-csrf-token");
    const rawToken = studentSessionToken(request);
    if (actual === null || !isCanonicalToken(actual) || rawToken === null) return false;
    try {
      const expected = await createStudentSessionCsrfToken(rawToken);
      return constantTimeEqual(actual, expected);
    } catch {
      throw new StudentAccessError("SERVICE_UNAVAILABLE");
    }
  }
}
