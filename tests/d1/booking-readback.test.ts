import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedTrustedStudents } from "../fixtures/d1/trusted-student-seed";
import { createReservationStudentService } from "../fixtures/reservation-student-service";
import { captureBookingBaseline, verifyBookingReadback, verifyBookingUnchanged,
  type BookingReadPort } from "../evaluation/booking-readback";

// One file-isolated local D1: seed once, no-cookie GETs, then one actual Commit.
// Readback fault seams never write, invoke HTTP or repeat the strict seed.
it("[#1000 / #937 / TC-F-003-01 / TC-NF-914-04 partial] real D1 no-cookie unchanged and positive readback", async () => {
  try {
    const db = env.AUTH_DB;
    await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
    const validation = { authSql: env.AUTH_INTEGRITY_SQL, reservationScans: env.RESERVATION_INTEGRITY_SCANS };
    const seed = await seedTrustedStudents(db, validation);
    const read = db.withSession("first-primary");
    // Private copies support finite fault fixtures without repeating D1 scans.
    const captured = new Map<string, { success: boolean; results: unknown[] }>();
    const recordingRead: BookingReadPort = { prepare(query) { return { async all<T>() {
      const result = await read.prepare(query).all<T>();
      captured.set(query, structuredClone(result));
      return result;
    } }; } };
    const negativeBaseline = await captureBookingBaseline(recordingRead, validation);
    const origin = "https://127.0.0.1:8789";
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const service = createReservationStudentService({ database: db, applicationOrigin: origin, cursorKey: key });
    const negativeRequests: Request[] = [];
    for (const path of [`/api/me/schedule-months/${seed.month}`, "/api/me/reservations", "/api/auth/student/csrf"]) {
      const request = new Request(origin + path, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
      negativeRequests.push(request);
      const response = await service.fetch(request);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      // Exact safe wire, including deletion only, excludes identity/token reflection.
      expect(response.headers.get("set-cookie") === "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT").toBe(true);
      expect(JSON.stringify(await response.json()) === JSON.stringify({ error: {
        code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none",
      } })).toBe(true);
      if (path === "/api/auth/student/csrf") expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect(negativeRequests.length).toBe(3);
    expect(negativeRequests.every((request) => request.method === "GET" && !request.headers.has("cookie") && request.body === null)).toBe(true);
    await verifyBookingUnchanged(read, validation, negativeBaseline);
    expect(JSON.stringify(negativeBaseline)).toBe("{}");

    // Existing read Port only: mutate returned copies, never actual D1 rows.
    // Expectations derive from #1000's full comparison, clock and one-use contract.
    type SnapshotRow = Record<string, string | number>;
    const fixtureRead: BookingReadPort = { prepare(query) { return { async all<T>() {
      const result = captured.get(query);
      if (!result) throw new Error("private-query-canary");
      return structuredClone(result) as { success: boolean; results: T[] };
    } }; } };
    const seam = (alter: (row: SnapshotRow) => void): BookingReadPort => ({
      prepare(query) {
        return { async all<T>() {
          const result = await fixtureRead.prepare(query).all<T>();
          if (query.startsWith("SELECT CAST(strftime")) {
            const rows = structuredClone(result.results) as SnapshotRow[];
            alter(rows[0]);
            return { success: result.success, results: rows as T[] };
          }
          return result;
        } };
      },
    });
    let forbiddenReads = 0;
    const failingRead: BookingReadPort = { prepare() {
      forbiddenReads++;
      throw new Error("private-read-canary");
    } };
    const fixedFailure = async (operation: Promise<void>) => {
      let rejected = false;
      try { await operation; } catch (error) {
        rejected = error instanceof Error && error.message === "BOOKING_EVALUATION_READBACK_FAILED" && !("cause" in error);
      }
      expect(rejected).toBe(true);
    };
    const consumed = async (baseline: typeof negativeBaseline) => {
      const calls = forbiddenReads;
      await fixedFailure(verifyBookingUnchanged(failingRead, validation, baseline));
      await fixedFailure(verifyBookingReadback(failingRead, validation, baseline, "unused"));
      expect(forbiddenReads).toBe(calls);
    };
    await consumed(negativeBaseline);
    const tableNames = (await read.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_METADATA' ORDER BY name")
      .all<{ name: string }>()).results.map((row) => row.name);
    expect(tableNames.length).toBe(19); // Production 0001–0012 plus migration history.
    const faults: BookingReadPort[] = tableNames.map((table) => seam((row) => {
      const rows = JSON.parse(String(row[table])) as Record<string, unknown>[];
      // Even a stored timestamp-only change must fail; empty tables cannot grow.
      const timestamp = rows.length ? Object.keys(rows[0]).find((column) => column.endsWith("_at") && typeof rows[0][column] === "number") : undefined;
      if (timestamp) rows[0][timestamp] = Number(rows[0][timestamp]) + 1;
      else rows.push({ private: "row-canary" });
      row[table] = JSON.stringify(rows);
    }));
    faults.push(seam((row) => {
      const schema = JSON.parse(String(row.schema)) as Record<string, unknown>[];
      schema[0].sql = "private-schema-canary";
      row.schema = JSON.stringify(schema);
    }), seam((row) => { row.schema = "private-invalid-json"; }), failingRead,
    { prepare() { return { async all<T>() { return { success: false, results: [] as T[] }; } }; } },
    { prepare() { return { async all<T>() { return { success: true, results: [{ private: "integrity-canary" }] as T[] }; } }; } });
    for (const port of faults) {
      const baseline = await captureBookingBaseline(fixtureRead, validation);
      await fixedFailure(verifyBookingUnchanged(port, validation, baseline));
      await consumed(baseline); // Failure is terminal even when the real DB is intact.
    }
    const clock = (time: number) => seam((row) => { row.time = time; });
    for (const after of [100, 101, 99]) {
      const baseline = await captureBookingBaseline(clock(100), validation);
      const result = verifyBookingUnchanged(clock(after), validation, baseline);
      if (after < 100) await fixedFailure(result);
      else await result;
      await consumed(baseline);
    }

    // Fresh real baseline: positive semantics and its single Confirm stay unchanged.
    const baseline = await captureBookingBaseline(read, validation);
    const cookie = seed.sessions.self.cookie();
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "sec-fetch-site": "same-origin" };
    const csrfResponse = await service.fetch(new Request(`${origin}/api/auth/student/csrf`, { headers }));
    expect(csrfResponse.status).toBe(200);
    const csrf = await csrfResponse.json() as { csrfToken: string };
    const post = (path: string, body: object) => service.fetch(new Request(origin + path, { method: "POST",
      headers: { ...headers, origin, "content-type": "application/json", "x-csrf-token": csrf.csrfToken }, body: JSON.stringify(body) }));
    const preview = await post("/api/me/reservations/preview", { slotId: "seed-slot-bookable" });
    expect(preview.status).toBe(200);
    const view = await preview.json() as { expectedStateToken: string };
    const response = await post("/api/me/reservations", { slotId: "seed-slot-bookable", expectedStateToken: view.expectedStateToken });
    expect(response.status).toBe(201);
    const result = await response.json() as { reservation: { reservationId: string } };
    const id = result.reservation.reservationId;
    await verifyBookingReadback(read, validation, baseline, id);
    await consumed(baseline);
    // Existing self/other rows and all Session values are compared privately
    // by the helper; the public assertion carries only a safe boolean.
    expect(JSON.stringify(baseline)).toBe("{}");
    expect(await db.prepare("SELECT count(*) AS n FROM student_reservations").first("n")).toBe(3);
    expect(await db.prepare("SELECT count(*) AS n FROM command_guards").first("n")).toBe(0);
  } catch {
    // Even fixture setup failures must not reveal SQL, Session or raw rows.
    throw new Error("TRUSTED_BOOKING_D1_FIXTURE_FAILED");
  }
});
