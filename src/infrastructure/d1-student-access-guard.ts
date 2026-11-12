import { studentSessionToken } from "./student-session-cookie";
import {
  StudentAccessError,
  type StudentAccessGuard,
  type StudentAccessResult,
  type StudentSessionResolution,
} from "../application/student-access-guard";

// Structural D1 API, with a fresh Primary session for each resolution.
// No binding, fixture configuration, Provider or default Worker activation.
export interface StudentAccessD1 {
  withSession(constraint: "first-primary"): {
    prepare(query: string): {
      bind(...values: unknown[]): {
        all<T>(): Promise<{ success: boolean; results: T[] }>;
      };
    };
  };
}

const lookupSql = `
SELECT a.*, CAST(strftime('%s','now') AS INTEGER) AS evaluated_at
FROM student_session_access_v1 AS a
WHERE a.token_hash = ?
`;

interface AccessRow {
  session_id: string;
  token_hash: string;
  account_id: string;
  role_scope: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  student_id: string | null;
  lifecycle: string | null;
  deleted_at: number | null;
  access_state: string | null;
  evaluated_at: number;
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

export class D1StudentAccessGuard implements StudentAccessGuard {
  constructor(private readonly database: StudentAccessD1) {}

  async authorize(request: Request): Promise<StudentAccessResult> {
    const result = await this.resolve(request);
    return result.status === "authenticated"
      ? { status: "authenticated", studentId: result.context.studentId }
      : result;
  }

  // Authentication resolution only. Unsafe HTTP consumers must also enforce
  // Application §10.3 CSRF/Origin before business authorization / Write.
  async resolve(request: Request): Promise<StudentSessionResolution> {
    if (new URL(request.url).protocol !== "https:") throw new StudentAccessError("SERVICE_UNAVAILABLE");
    const token = studentSessionToken(request);
    if (token === null) return { status: "unauthenticated" };

    let tokenHash: string;
    let rows: AccessRow[];
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await this.database.withSession("first-primary")
        .prepare(lookupSql).bind(tokenHash).all<AccessRow>();
      if (!result.success || !Array.isArray(result.results)) throw new StudentAccessError("SERVICE_UNAVAILABLE");
      rows = result.results;
    } catch {
      // Never keep a raw D1 error, token/hash, SQL or cause at this boundary.
      throw new StudentAccessError("SERVICE_UNAVAILABLE");
    }
    if (rows.length === 0) return { status: "unauthenticated" };
    if (rows.length !== 1) throw new StudentAccessError("INTEGRITY_STATE_UNAVAILABLE");
    const row = rows[0];
    if (!row || !integer(row.evaluated_at) || !integer(row.created_at) || !integer(row.expires_at) ||
        row.expires_at <= row.created_at || row.expires_at > row.created_at + 2592000 ||
        (row.revoked_at !== null && (!integer(row.revoked_at) || row.revoked_at < row.created_at))) {
      throw new StudentAccessError("INTEGRITY_STATE_UNAVAILABLE");
    }
    // Invalid Session precedes related-row integrity and authorization checks.
    if (row.revoked_at !== null || row.evaluated_at < row.created_at || row.evaluated_at >= row.expires_at) {
      return { status: "unauthenticated" };
    }
    if (!nonempty(row.session_id) || row.token_hash !== tokenHash || !nonempty(row.account_id) ||
        !nonempty(row.student_id) || !nonempty(row.role_scope) ||
        (row.lifecycle !== "active" && row.lifecycle !== "deleted") ||
        (row.access_state !== "active" && row.access_state !== "suspended") ||
        (row.lifecycle === "active" ? row.deleted_at !== null : !integer(row.deleted_at))) {
      throw new StudentAccessError("INTEGRITY_STATE_UNAVAILABLE");
    }
    if (row.lifecycle !== "active" || row.access_state !== "active") return { status: "unauthenticated" };
    if (row.role_scope !== "student") return { status: "forbidden" };
    return { status: "authenticated", context: {
      sessionId: row.session_id, tokenHash, studentId: row.student_id,
    } };
  }
}
