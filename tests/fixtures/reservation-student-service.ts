import { ReservationPreviewService } from "../../src/application/reservation-preview";
import { ReservationConfirmPreparationService } from "../../src/application/reservation-confirm";
import { D1StudentAccessGuard } from "../../src/infrastructure/d1-student-access-guard";
import { D1ReservationPreviewRepository, type ReservationPreviewD1 } from "../../src/infrastructure/d1-reservation-preview";
import { D1ReservationConfirmExecutor, type ReservationConfirmD1 } from "../../src/infrastructure/d1-reservation-confirm";
import { D1ReservationCommitVerifier, type ReservationVerificationD1 } from "../../src/infrastructure/d1-reservation-commit-verification";
import { D1ReservationConfirmTransaction } from "../../src/infrastructure/d1-reservation-confirm-transaction";
import { ReservationPreviewHttpAdapter } from "../../src/http/reservation-preview";
import { ReservationConfirmHttpAdapter } from "../../src/http/reservation-confirm";
import { canonicalStudentOrigin } from "../../src/http/student-session-csrf";
import { errorResponse } from "../../src/http/application-error";
import { createReadOnlyStudentService, type ReadOnlyStudentConfig, type ReadOnlyStudentService } from "./read-only-student-service";

export interface ReservationStudentConfig extends ReadOnlyStudentConfig {
  readonly database: ReadOnlyStudentConfig["database"] & ReservationPreviewD1 & ReservationConfirmD1 & ReservationVerificationD1;
}

function unavailable(request: Request): Response {
  const response = errorResponse("SERVICE_UNAVAILABLE");
  try {
    if (new URL(request.url).pathname === "/api/auth/student/csrf") {
      response.headers.set("referrer-policy", "no-referrer");
    }
  } catch { /* Malformed URL must also receive the fixed safe error. */ }
  return response;
}

// #928: test-only, non-runnable composition. No listener, binding lookup, seed,
// provider, auth bypass or caller-selected identity. Real D1 proof belongs to #931.
export function createReservationStudentService(config?: Partial<ReservationStudentConfig>): ReadOnlyStudentService {
  try {
    const origin = canonicalStudentOrigin(config?.applicationOrigin);
    const database = config?.database;
    const key = config?.cursorKey;
    if (!database || typeof database !== "object" || Array.isArray(database) ||
        typeof database.prepare !== "function" || typeof database.withSession !== "function" ||
        !(key instanceof CryptoKey) || key.type !== "secret" || key.extractable ||
        key.algorithm.name !== "HMAC" || (key.algorithm as HmacKeyAlgorithm).hash.name !== "SHA-256" ||
        key.usages.length !== 1 || key.usages[0] !== "sign") throw new Error();
    // Structural check only: create a Primary session without preparing SQL or
    // performing a read/write. A missing write Port disables read routes too.
    const session = (database as ReservationConfirmD1).withSession("first-primary");
    if (!session || typeof session !== "object" || Array.isArray(session) ||
        typeof session.prepare !== "function" || typeof session.batch !== "function") throw new Error();
    const readOnly = createReadOnlyStudentService({ database, applicationOrigin: origin, cursorKey: key });
    const guard = new D1StudentAccessGuard(database);
    const repository = new D1ReservationPreviewRepository(database);
    const preview = new ReservationPreviewHttpAdapter(guard, new ReservationPreviewService(repository), origin);
    const transaction = new D1ReservationConfirmTransaction(
      new D1ReservationConfirmExecutor(database), new D1ReservationCommitVerifier(database));
    const confirm = new ReservationConfirmHttpAdapter(guard,
      new ReservationConfirmPreparationService(repository), transaction, origin);
    return {
      async fetch(request) {
        try {
          const url = new URL(request.url);
          if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) {
            return unavailable(request);
          }
          if (request.method === "GET" && (url.pathname === "/api/auth/student/csrf" ||
              url.pathname === "/api/me/reservations" || /^\/api\/me\/schedule-months\/[^/]+$/.test(url.pathname))) {
            return await readOnly.fetch(request);
          }
          if (request.method === "POST" && url.pathname === "/api/me/reservations/preview") return await preview.fetch(request);
          if (request.method === "POST" && url.pathname === "/api/me/reservations") return await confirm.fetch(request);
          return unavailable(request);
        } catch { return unavailable(request); }
      },
    };
  } catch {
    return { async fetch(request) { return unavailable(request); } };
  }
}
