import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createReservationStudentService, type ReservationStudentConfig } from "../fixtures/reservation-student-service";
import { seedTrustedStudents, checkTrustedSeedIntegrity } from "../fixtures/d1/trusted-student-seed";
import type { PreviewView } from "../../src/application/reservation-preview";
import type { ReservationConfirmResult } from "../../src/application/reservation-confirm-plan";
import type { ReservationHistoryView } from "../../src/application/reservation-history";

// One serial scenario on this file's independently owned local D1. No persist,
// listener, remote resource, Clock substitution, Provider or pickup consumer.
// The existing Cloudflare test runtime owns disposal; never reset/retry writes.
it("[#931 / TC-F-003-01,05,06 / TC-F-005-01 / TC-NF-914-04 partial local D1] proves factory Preview → atomic Confirm → owner History", async () => {
  let stage = "migration-preflight";
  try {
    const db = env.AUTH_DB;
    const validation = { authSql: env.AUTH_INTEGRITY_SQL, reservationScans: env.RESERVATION_INTEGRITY_SCANS };
    expect([...env.AUTH_MIGRATIONS, ...env.RESERVATION_MIGRATIONS].map((m: { name: string }) => m.name.slice(0, 4)))
      .toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0")));
    stage = "apply-reservation-migrations";
    await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
    stage = "trusted-seed";
    const seed = await seedTrustedStudents(db, validation); // Unchanged strict fingerprint / empty-only seed.
    stage = "service-composition";
    const origin = "https://nssscdl.test";
    const previewPath = "/api/me/reservations/preview";
    const confirmPath = "/api/me/reservations";
    let batches = 0;
    let verificationReads = 0;
    let forbidden = false;
    let failHistory = false;
    let beforeBatch: (() => Promise<void>) | undefined;
    const constraints: string[] = [];
    // Forward actual prepared statements and batch responses. Only the existing
    // D1 Port's role/error seams are projected for otherwise unrepresentable
    // negatives (the Student schema deliberately cannot store an Admin Session).
    interface FixtureStatement {
      bind(...values: unknown[]): FixtureStatement;
      all<T>(): Promise<{ success: boolean; results: T[] }>;
      first(): Promise<unknown>;
      readonly bound: ReturnType<typeof db.prepare>;
    }
    const wrap = (bound: ReturnType<typeof db.prepare>, query: string): FixtureStatement => ({
      bind(...values) { return wrap(bound.bind(...values), query); },
      async all<T>() {
        if (failHistory && query.includes("FROM student_reservations")) throw new Error("private D1 read failure");
        const result = await bound.all<T>();
        if (forbidden && query.includes("student_session_access_v1")) {
          result.results = result.results.map((row: T) => ({ ...row, role_scope: "admin" }));
        }
        return result;
      },
      async first() {
        verificationReads++;
        return await bound.first();
      },
      bound,
    });
    const statement = (source: { prepare: typeof db.prepare }, query: string) => wrap(source.prepare(query), query);
    const database: ReservationStudentConfig["database"] = {
      prepare(query) { return statement(db, query); },
      withSession(constraint) {
        constraints.push(constraint);
        const session = db.withSession(constraint);
        return {
          prepare(query) { return statement(session, query); },
          async batch(statements) {
            batches++;
            if (beforeBatch) await beforeBatch();
            return await session.batch(statements.map((s) => (s as FixtureStatement).bound));
          },
        };
      },
    };
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const service = createReservationStudentService({ database, applicationOrigin: origin, cursorKey: key });
    const request = (path: string, owner: "self" | "other" | "missing" = "self", body?: object, override: Record<string, string> = {}) => {
      const headers = new Headers({ "sec-fetch-site": "same-origin", ...override });
      if (owner !== "missing") {
        const cookie = seed.sessions[owner].cookie();
        headers.set("cookie", `${cookie.name}=${cookie.value}`);
      }
      if (body) {
        headers.set("content-type", "application/json");
        if (!headers.has("origin")) headers.set("origin", origin);
      }
      return new Request(origin + path, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    };
    // Digest comparisons prevent Session/hash-bearing snapshots in failure logs.
    const snapshot = async () => {
      const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name")
        .all<{ name: string }>()).results;
      const rows = await Promise.all(tables.map(async ({ name }) => (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results));
      return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows))));
    };
    const unchanged = async (before: Uint8Array) => {
      const after = await snapshot();
      expect(before.length === after.length && before.every((byte, i) => byte === after[i])).toBe(true);
    };
    const response = async (res: Response, status: number) => {
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.has("set-cookie")).toBe(status === 401);
      return await res.json();
    };
    const error = async (res: Response, status: number, code: string, retry: string) => {
      const body = await response(res, status);
      expect(body).toMatchObject({ error: { code, retry } });
      const text = JSON.stringify(body);
      for (const owner of ["self", "other"] as const) {
        expect(text.includes(seed.sessions[owner].cookie().value) || text.includes(csrf[owner])).toBe(false);
      }
      expect(text).not.toMatch(/private|SQL|student_sessions|tokenHash|canonicalRawReadSet|seed-/);
    };
    const csrf = { self: "", other: "" };
    stage = "initial-snapshot";
    const initial = await snapshot();
    stage = "csrf-get";
    for (const owner of ["self", "other"] as const) {
      const csrfResponse = await service.fetch(request("/api/auth/student/csrf", owner));
      expect(csrfResponse.headers.get("referrer-policy")).toBe("no-referrer");
      const body = await response(csrfResponse, 200);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("student-csrf-v1:" + seed.sessions[owner].cookie().value));
      const expected = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(body.scope === "session" && body.csrfToken === expected).toBe(true);
      csrf[owner] = body.csrfToken;
    }
    const post = (path: string, body: object, owner: "self" | "other" | "missing" = "self", headers: Record<string, string> = {}) =>
      service.fetch(request(path, owner, body, { "x-csrf-token": csrf[owner === "missing" ? "self" : owner], ...headers }));
    const preview = async () => await response(await post(previewPath, { slotId: "seed-slot-bookable" }), 200) as PreviewView;
    stage = "preview";
    const view = await preview();
    expect(view).toMatchObject({ slot: { slotId: "seed-slot-bookable", startsAt: `${seed.date}T10:00:00+09:00`, endsAt: `${seed.date}T11:00:00+09:00` },
      previewClassification: "standard", classificationChanges: [] }); // Existing reservation + new one < default N=3.
    expect(/^v1\.[A-Za-z0-9_-]{43}$/.test(view.expectedStateToken)).toBe(true);
    await unchanged(initial);
    expect(batches).toBe(0);
    const confirm = { slotId: "seed-slot-bookable", expectedStateToken: view.expectedStateToken };
    stage = "negative-requests";
    for (const path of [previewPath, confirmPath]) {
      const body = path === previewPath ? { slotId: confirm.slotId } : confirm;
      for (const [owner, headers, status, code] of [
        ["missing", {}, 401, "UNAUTHENTICATED"],
        ["self", { "x-csrf-token": "invalid" }, 403, "CSRF_INVALID"],
        ["self", { origin: "https://other.test" }, 403, "CSRF_INVALID"],
        ["self", { "x-csrf-token": csrf.other }, 403, "CSRF_INVALID"],
      ] as const) {
        stage = `negative-${path === previewPath ? "preview" : "confirm"}-${owner}-${code}-${"origin" in headers ? "origin" : "x-csrf-token" in headers ? "csrf" : "cookie"}`;
        await error(await post(path, body, owner, headers), status, code, "none");
      }
      forbidden = true;
      stage = `negative-${path === previewPath ? "preview" : "confirm"}-role`;
      await error(await post(path, body), 403, "FORBIDDEN", "none");
      forbidden = false;
    }
    stage = "negative-token-changed";
    await error(await post(confirmPath, { ...confirm, expectedStateToken: "v1." + "A".repeat(43) }), 409, "RESERVATION_STATE_CHANGED", "repreview");
    stage = "negative-other-identity";
    await error(await post(confirmPath, confirm, "other"), 409, "RESERVATION_STATE_CHANGED", "repreview");
    stage = "negative-occupied-target";
    await error(await post(previewPath, { slotId: "seed-slot-other" }), 409, "RESERVATION_NOT_AVAILABLE", "reload");
    stage = "negative-snapshot";
    await unchanged(initial);
    expect(batches).toBe(0);

    stage = "rollback-revalidation";
    // Real Guard rollback at the existing batch boundary, not a race simulator.
    // The fixture's publication change is the only permitted persistent change.
    {
      const current = await preview();
      let changed: Uint8Array | undefined;
      beforeBatch = async () => {
        await db.prepare("UPDATE schedule_months SET published_at = published_at + 1 WHERE id='seed-month'").run();
        changed = await snapshot();
      };
      const calls = batches;
      const reads = verificationReads;
      await error(await post(confirmPath, { slotId: confirm.slotId, expectedStateToken: current.expectedStateToken }),
        409, "RESERVATION_STATE_CHANGED", "repreview");
      expect(batches - calls).toBe(1);
      expect(verificationReads - reads).toBe(1);
      expect(changed !== undefined).toBe(true);
      await unchanged(changed!);
      beforeBatch = undefined;
      // This is a new explicit Preview after verified rollback, never an automatic
      // retry of an unknown Commit.
    }

    stage = "confirmed-preview";
    const finalPreview = await preview();
    const beforeCommit = await db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER) AS t").first<number>("t");
    const calls = batches;
    const reads = verificationReads;
    stage = "atomic-confirm";
    const committed = await response(await post(confirmPath, { slotId: confirm.slotId, expectedStateToken: finalPreview.expectedStateToken }), 201) as ReservationConfirmResult;
    expect(batches - calls).toBe(1);
    expect(verificationReads).toBe(reads);
    const id = committed.reservation.reservationId;
    expect(typeof id === "string" && id.length > 0).toBe(true);
    expect(committed).toEqual({ reservation: { reservationId: id, startsAt: `${seed.date}T10:00:00+09:00`, endsAt: `${seed.date}T11:00:00+09:00`, reservationState: "confirmed", classification: "standard" },
      slot: { slotId: confirm.slotId, startsAt: `${seed.date}T10:00:00+09:00`, endsAt: `${seed.date}T11:00:00+09:00`, view: "reserved_by_me" }, classificationChanges: [] });
    const afterCommit = await db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER) AS t").first<number>("t");
    stage = "db-readback";
    const reservation = await db.prepare("SELECT * FROM student_reservations WHERE id=?").bind(id).first<{ created_at: number } & Record<string, unknown>>();
    expect(reservation).toEqual({ id, student_id: "seed-self", lesson_slot_id: confirm.slotId, status: "confirmed", automatic_classification: "standard", classification: "standard", created_at: reservation!.created_at, updated_at: reservation!.created_at, cancelled_at: null });
    const t = reservation!.created_at;
    expect(t).toBeGreaterThanOrEqual(beforeCommit!);
    expect(t).toBeLessThanOrEqual(afterCommit!);
    expect(await db.prepare("SELECT slot_id,occupancy_type,reservation_id,created_at,created_by FROM slot_occupancies WHERE reservation_id=?").bind(id).first())
      .toEqual({ slot_id: confirm.slotId, occupancy_type: "student_reservation", reservation_id: id, created_at: t, created_by: "seed-self" });
    expect((await db.prepare("SELECT occurred_at,action,actor_type,actor_id,target_type,target_id,before_json,after_json,result FROM business_audit_logs").all()).results)
      .toEqual([{ occurred_at: t, action: "reservation_confirm", actor_type: "student", actor_id: "seed-self", target_type: "student_reservation", target_id: id, before_json: null,
        after_json: JSON.stringify({ version: 1, reservation: { id, automatic_classification: "standard", classification: "standard" }, derived_changes: [] }), result: "committed" }]);
    const intents = (await db.prepare("SELECT * FROM notification_intents").all<{ id: string }>()).results;
    expect(intents).toEqual([{ id: intents[0]?.id, kind: "reservation_confirmation", recipient_student_id: "seed-self", reservation_id: id, occurred_at: t,
      payload_json: JSON.stringify({ version: 1, reservation: { id, startsAt: `${seed.date}T10:00:00+09:00`, endsAt: `${seed.date}T11:00:00+09:00`, classification: "standard" } }),
      obligation_state: "valid", expired_at: null, expiry_reason: null }]);
    expect((await db.prepare("SELECT * FROM notification_outbox").all()).results)
      .toEqual([{ intent_id: intents[0].id, due_at: t, claim_token: null, claim_until: null }]);
    expect(await db.prepare("SELECT count(*) AS n FROM student_reservations").first("n")).toBe(3);
    expect(await db.prepare("SELECT count(*) AS n FROM slot_occupancies").first("n")).toBe(5);
    expect((await db.prepare("SELECT * FROM command_guards").all()).results).toEqual([]);
    stage = "post-commit-integrity";
    await checkTrustedSeedIntegrity(db, validation);

    stage = "owner-history";
    const saved = await snapshot();
    for (const owner of ["self", "other"] as const) {
      const history = await response(await service.fetch(request(confirmPath, owner)), 200) as ReservationHistoryView;
      expect(history.items.map((item) => item.reservationId)).toEqual(owner === "self" ? ["seed-reservation-self", id] : ["seed-reservation-other"]);
      if (owner === "self") expect(history.items[1]).toEqual({ reservationId: id, reservationState: "confirmed", attendanceState: "none", classification: "standard", startsAt: `${seed.date}T10:00:00+09:00`, endsAt: `${seed.date}T11:00:00+09:00` });
      expect(history.nextCursor).toBeNull();
    }
    stage = "read-error-fail-closed";
    failHistory = true;
    await error(await service.fetch(request(confirmPath)), 503, "SERVICE_UNAVAILABLE", "later");
    await unchanged(saved);
    expect(batches - calls).toBe(1); // GET/read failures never cause another write.
    stage = "final-constraints";
    expect(constraints.every((constraint) => constraint === "first-primary")).toBe(true);
  } catch {
    // Even setup/direct DB readback failures must not expose D1 SQL/cause or
    // secret-bearing fixtures through Vitest's exception reporter.
    // Only a fixed test-phase label may reach CI; never expose the original error,
    // SQL, Session, token, or D1 rows through Vitest diagnostics.
    throw new Error(`TRUSTED_LOCAL_RESERVATION_PROOF_FAILED:${stage}`);
  }
}, 30_000);
