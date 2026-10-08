import { ScheduleQueryService } from "../../src/application/schedule-query";
import { ReservationHistoryService } from "../../src/application/reservation-history";
import { D1StudentAccessGuard, type StudentAccessD1 } from "../../src/infrastructure/d1-student-access-guard";
import { D1ScheduleQueryRepository, type ScheduleQueryD1 } from "../../src/infrastructure/d1-schedule-query";
import { D1ReservationHistoryRepository } from "../../src/infrastructure/d1-reservation-history";
import { HmacReservationHistoryCursorCodec } from "../../src/infrastructure/reservation-history-cursor";
import { ScheduleMonthHttpAdapter } from "../../src/http/schedule-month";
import { ReservationHistoryHttpAdapter } from "../../src/http/reservation-history";
import { StudentSessionCsrfGetHttpAdapter } from "../../src/http/student-session-csrf-get";
import { canonicalStudentOrigin } from "../../src/http/student-session-csrf";
import { errorResponse } from "../../src/http/application-error";

export interface ReadOnlyStudentConfig {
  // Dedicated runtime owns isolation. One binding, never selected by Request.
  readonly database: StudentAccessD1 & ScheduleQueryD1;
  readonly applicationOrigin: string;
  readonly cursorKey: CryptoKey;
}
export interface ReadOnlyStudentService {
  fetch(request: Request): Promise<Response>;
}

function unavailable(request: Request): Response {
  const response = errorResponse("SERVICE_UNAVAILABLE");
  if (new URL(request.url).pathname === "/api/auth/student/csrf") {
    response.headers.set("referrer-policy", "no-referrer");
  }
  return response;
}

// Non-public Request service only: no listener, env lookup, seed, key generation,
// assets, provider, scheduled handler, runnable main or Production import.
export function createReadOnlyStudentService(config?: Partial<ReadOnlyStudentConfig>): ReadOnlyStudentService {
  try {
    const origin = canonicalStudentOrigin(config?.applicationOrigin);
    const database = config?.database;
    const key = config?.cursorKey;
    if (!database || typeof database !== "object" || Array.isArray(database) ||
        typeof database.prepare !== "function" || typeof database.withSession !== "function" ||
        !(key instanceof CryptoKey) || key.type !== "secret" || key.extractable ||
        key.algorithm.name !== "HMAC" || (key.algorithm as HmacKeyAlgorithm).hash.name !== "SHA-256" ||
        key.usages.length !== 1 || key.usages[0] !== "sign") throw new Error();
    const guard = new D1StudentAccessGuard(database);
    const schedule = new ScheduleMonthHttpAdapter(guard, new ScheduleQueryService(
      new D1ScheduleQueryRepository(database), { now: () => Math.floor(Date.now() / 1000) }));
    const history = new ReservationHistoryHttpAdapter(guard, new ReservationHistoryService(
      new D1ReservationHistoryRepository(database), new HmacReservationHistoryCursorCodec(key)));
    const csrf = new StudentSessionCsrfGetHttpAdapter(guard, origin);
    return {
      async fetch(request) {
        try {
          const url = new URL(request.url);
          if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash ||
              request.method !== "GET") return unavailable(request);
          // Child adapters retain their existing input, authentication and wire contracts.
          if (url.pathname === "/api/auth/student/csrf") return await csrf.fetch(request);
          if (url.pathname === "/api/me/reservations") return await history.fetch(request);
          if (/^\/api\/me\/schedule-months\/[^/]+$/.test(url.pathname)) return await schedule.fetch(request);
          return unavailable(request);
        } catch { return unavailable(request); }
      },
    };
  } catch {
    // Missing/malformed trusted inputs disable every route, including no-Cookie requests.
    return { async fetch(request) { return unavailable(request); } };
  }
}
