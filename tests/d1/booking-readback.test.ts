import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedTrustedStudents } from "../fixtures/d1/trusted-student-seed";
import { createReservationStudentService } from "../fixtures/reservation-student-service";
import { captureBookingBaseline, verifyBookingReadback } from "../evaluation/booking-readback";

// One file-isolated local D1 scenario: strict empty-only seed and one actual
// factory Commit. The separate Node/SQLite suite covers negative readback cases.
it("[#937 / TC-F-003-01 / TC-NF-914-04 partial] independent real D1 positive readback", async () => {
  try {
    const db = env.AUTH_DB;
    await applyD1Migrations(db, env.RESERVATION_MIGRATIONS);
    const validation = { authSql: env.AUTH_INTEGRITY_SQL, reservationScans: env.RESERVATION_INTEGRITY_SCANS };
    const seed = await seedTrustedStudents(db, validation);
    const read = db.withSession("first-primary");
    const baseline = await captureBookingBaseline(read, validation);
    const origin = "https://127.0.0.1:8789";
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const service = createReservationStudentService({ database: db, applicationOrigin: origin, cursorKey: key });
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
