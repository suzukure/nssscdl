import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { StudentReadController } from "../../src/web/controller";
import { createReservationStudentService, type ReservationStudentConfig } from "../fixtures/reservation-student-service";
import { seedTrustedStudents, checkTrustedSeedIntegrity } from "../fixtures/d1/trusted-student-seed";

// #1081: one file-isolated real local D1, not a Browser/HTTPS wire or race proof.
// The existing #931 test independently owns full atomic-commit/rollback oracles.
// Do not retry a seed, DB write, unknown Confirm, or a failed setup.
it("[#1081 / TC-F-003-01,05 / TC-F-005-01 / TC-NF-914-04 partial] joins Controller 409 re-preview to actual local D1 Confirm", async () => {
  let stage = "migration-preflight";
  try {
    const db = env.AUTH_DB;
    const validation = { authSql: env.AUTH_INTEGRITY_SQL, reservationScans: env.RESERVATION_INTEGRITY_SCANS };
    expect([...env.AUTH_MIGRATIONS, ...env.RESERVATION_MIGRATIONS].map((m: { name: string }) => m.name.slice(0, 4)))
      .toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(4, "0")));
    stage = "apply-reservation-migrations";
    await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
    stage = "trusted-seed";
    const seed = await seedTrustedStudents(db, validation);
    const origin = "https://nssscdl.test";
    const slotId = "seed-slot-bookable";
    const confirmPath = "/api/me/reservations";
    const previewPath = "/api/me/reservations/preview";
    const monthPath = "/api/me/schedule-months/" + seed.month;
    const csrfPath = "/api/auth/student/csrf";

    stage = "service-composition";
    // Forward actual Cloudflare D1 Port methods; no synthetic DB or transaction.
    const service = createReservationStudentService({
      database: db as unknown as ReservationStudentConfig["database"],
      applicationOrigin: origin,
      cursorKey: await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    });
    const trace: { method: string; path: string; status: number }[] = [];
    let bridgePhase = "not-entered";
    const allowed = new Set([confirmPath, previewPath, monthPath, csrfPath]);
    const fetcher: typeof fetch = async (input, init) => {
      if (typeof input !== "string" || !allowed.has(input)) throw new Error("unexpected_controller_path");
      const method = init?.method ?? "GET";
      if (method !== "GET" && method !== "POST") throw new Error("unexpected_controller_method");
      const headers = new Headers(init?.headers);
      // Only the environment's browser-owned headers are supplied. Controller
      // path, method, body, X-CSRF-Token, and other headers remain untouched.
      if (headers.has("cookie") || headers.has("origin") || headers.has("sec-fetch-site")) {
        throw new Error("unexpected_controller_browser_headers");
      }
      const cookie = seed.sessions.self.cookie();
      headers.set("cookie", cookie.name + "=" + cookie.value);
      headers.set("sec-fetch-site", "same-origin");
      if (method === "POST") headers.set("origin", origin);
      // Browser fetch options are observed as issued, but cache/credentials/
      // redirect are not Request-construction inputs in this Worker test port.
      // Preserve the HTTP path, method, body and every Controller-owned header.
      if (init?.credentials !== "same-origin" || init.cache !== "no-store" || init.redirect !== "error") {
        throw new Error("unexpected_controller_fetch_options");
      }
      bridgePhase = "request-construction";
      const request = new Request(origin + input, { method, headers, ...(init.body ? { body: init.body } : {}) });
      bridgePhase = "service-fetch";
      const result = await service.fetch(request);
      bridgePhase = "service-returned";
      // Only fixed whitelisted path/method/status; never persist raw requests.
      trace.push({ method, path: input, status: result.status });
      if (input === confirmPath && method === "POST" && result.status === 409) {
        const wire = await result.clone().json() as { error?: { code?: unknown; retry?: unknown } };
        if (wire.error?.code !== "RESERVATION_STATE_CHANGED" || wire.error.retry !== "repreview") {
          throw new Error("wrong_409_contract");
        }
      }
      return result;
    };
    const controller = new StudentReadController(seed.month, fetcher, () => {});

    // Digest every application table, including session-bearing tables, without
    // ever displaying the rows, SQL error, CSRF value, or session/token.
    const digest = async () => {
      const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name")
        .all<{ name: string }>()).results;
      const rows = await Promise.all(tables.map(async ({ name }) =>
        (await db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()).results));
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(JSON.stringify(rows)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const counts = async () => await Promise.all([
      "student_reservations", "slot_occupancies", "business_audit_logs",
      "notification_intents", "notification_outbox",
    ].map(async (table) => await db.prepare("SELECT count(*) AS n FROM " + table).first<number>("n")));
    const confirms = () => trace.filter((call) => call.method === "POST" && call.path === confirmPath).map((call) => call.status);
    const previews = () => trace.filter((call) => call.method === "POST" && call.path === previewPath).map((call) => call.status);

    stage = "initial-month";
    await controller.loadMonth(seed.month);
    const initialReads = trace.filter((call) => call.method === "GET" && call.path === monthPath);
    if (initialReads.length !== 1) {
      stage = "initial-month-no-service-response-" + bridgePhase;
      throw new Error("initial_month_unavailable");
    }
    if (initialReads[0].status !== 200) {
      stage = "initial-month-http-" + String(initialReads[0].status);
      throw new Error("initial_month_wrong_status");
    }
    stage = "initial-month-model";
    expect(controller.state.slots.some((slot) => slot.slotId === slotId && slot.view === "bookable")).toBe(true);
    stage = "initial-month-counts";
    expect(await counts()).toEqual([2, 4, 0, 0, 0]);
    stage = "first-preview";
    controller.select(slotId);
    await controller.preview();
    expect(controller.state.operation).toBe("review");
    expect(controller.state.preview).toEqual({
      slot: { slotId, startsAt: seed.date + "T10:00:00+09:00", endsAt: seed.date + "T11:00:00+09:00" },
      previewClassification: "standard", classificationChanges: [],
    });
    expect(previews()).toEqual([200]);
    expect(confirms()).toEqual([]);

    stage = "fixture-version-change";
    const beforeChange = await digest();
    await db.prepare("UPDATE schedule_months SET published_at = published_at + 1 WHERE id='seed-month'").run();
    const afterFixtureChange = await digest();
    expect(afterFixtureChange === beforeChange).toBe(false);
    const beforeRejectedCounts = await counts();

    stage = "rejected-confirm";
    await controller.confirm();
    expect(confirms()).toEqual([409]);
    expect(controller.state.preview).toBeNull();
    expect(controller.state.confirmed).toBeNull();
    expect(controller.state.operation).toBe("idle");
    expect(controller.state.operationMessage.includes("再Preview")).toBe(true);
    expect(await digest()).toBe(afterFixtureChange);
    expect(await counts()).toEqual(beforeRejectedCounts);
    await checkTrustedSeedIntegrity(db, validation);
    // Even an explicit second click with the consumed old token cannot send.
    await controller.confirm();
    expect(confirms()).toEqual([409]);

    stage = "fresh-month";
    await vi.waitFor(() => {
      expect(controller.state.scheduleLoading).toBe(false);
      expect(controller.state.slots.some((slot) => slot.slotId === slotId && slot.view === "bookable")).toBe(true);
    }, { timeout: 5_000, interval: 20 });
    expect(trace.filter((call) => call.method === "GET" && call.path === monthPath).length).toBe(2);
    expect(confirms()).toEqual([409]);

    stage = "second-preview";
    controller.select(slotId);
    await controller.preview();
    expect(controller.state.operation).toBe("review");
    expect(controller.state.preview?.previewClassification).toBe("standard");
    expect(previews()).toEqual([200, 200]);
    expect(trace.filter((call) => call.method === "GET" && call.path === csrfPath).length).toBe(2);
    expect(confirms()).toEqual([409]);

    stage = "explicit-confirm";
    await controller.confirm();
    expect(confirms()).toEqual([409, 201]);
    expect(controller.state.operation).toBe("confirmed");
    const id = controller.state.confirmed?.reservation.reservationId;
    if (!id) throw new Error("missing_commit_id");
    expect(controller.state.confirmed?.reservation.classification).toBe("standard");

    stage = "owner-history";
    await controller.loadHistory();
    expect(controller.state.history.items.filter((item) => item.reservationId === id)).toHaveLength(1);
    expect(controller.state.history.items.some((item) => item.reservationId === "seed-reservation-other")).toBe(false);

    stage = "d1-readback";
    expect(await db.prepare("SELECT student_id,lesson_slot_id,status,classification FROM student_reservations WHERE id=?")
      .bind(id).first()).toEqual({ student_id: "seed-self", lesson_slot_id: slotId, status: "confirmed", classification: "standard" });
    expect(await db.prepare("SELECT slot_id,reservation_id FROM slot_occupancies WHERE reservation_id=?")
      .bind(id).first()).toEqual({ slot_id: slotId, reservation_id: id });
    expect(await db.prepare("SELECT target_id,action,actor_id FROM business_audit_logs WHERE target_id=?")
      .bind(id).first()).toEqual({ target_id: id, action: "reservation_confirm", actor_id: "seed-self" });
    const intent = await db.prepare("SELECT id,reservation_id,recipient_student_id FROM notification_intents WHERE reservation_id=?")
      .bind(id).first<{ id: string; reservation_id: string; recipient_student_id: string }>();
    if (!intent) throw new Error("missing_intent");
    expect(intent.reservation_id === id && intent.recipient_student_id === "seed-self").toBe(true);
    expect(await db.prepare("SELECT intent_id,claim_token FROM notification_outbox WHERE intent_id=?")
      .bind(intent.id).first()).toEqual({ intent_id: intent.id, claim_token: null });
    expect(await counts()).toEqual([3, 5, 1, 1, 1]);
    await checkTrustedSeedIntegrity(db, validation);
    expect(confirms()).toEqual([409, 201]);
  } catch {
    // The original error might contain SQL, auth/session, CSRF or full D1 rows.
    // CI receives only a deterministic, non-secret phase.
    throw new Error("TRUSTED_CONTROLLER_D1_PROOF_FAILED:" + stage);
  }
}, 30_000);
