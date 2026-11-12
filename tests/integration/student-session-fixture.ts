import { vi } from "vitest";
import type { StudentAccessD1 } from "../../src/infrastructure/d1-student-access-guard";

// Isolated source adapter, never imported by src or configured by HTTP/env.
export const token = "A".repeat(43);
export const request = (cookie = `__Host-student_session=${token}`) =>
  new Request("https://nssscdl.test/api/me/schedule-months/2026-11", { headers: { cookie } });

export async function hashToken(value = token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function source() {
  const row = {
    session_id: "session", token_hash: await hashToken(), account_id: "account", role_scope: "student",
    created_at: 100, expires_at: 100 + 2592000, revoked_at: null as number | null,
    student_id: "student", lifecycle: "active", deleted_at: null as number | null,
    access_state: "active", evaluated_at: 150,
  };
  const all = vi.fn(async () => ({ success: true, results: [row] }));
  const bind = vi.fn<(...values: unknown[]) => { all: typeof all }>(() => ({ all }));
  const prepare = vi.fn<(query: string) => { bind: typeof bind }>(() => ({ bind }));
  const withSession = vi.fn<(constraint: "first-primary") => { prepare: typeof prepare }>(() => ({ prepare }));
  // Structural fake is confined to tests; malformed rows exercise fail-closed.
  const database = { withSession } as StudentAccessD1;
  return { row, all, bind, prepare, withSession, database };
}
