import type { ReservationConfirmD1 } from "../../src/infrastructure/d1-reservation-confirm";
import { createReservationStudentService, type ReservationStudentConfig } from "../fixtures/reservation-student-service";

// Separate from the immutable #914/#922 read-only origin and binding.
const applicationOrigin = "https://127.0.0.1:8789";
interface ReservationEvaluationEnv {
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly EVALUATION_BOOKING_DB?: ReservationStudentConfig["database"];
}

export function createReservationEvaluationWorker() {
  const disabled = createReservationStudentService();
  let cursorKey: Promise<CryptoKey | undefined> | undefined;
  return {
    async fetch(request: Request, env: ReservationEvaluationEnv): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.origin !== applicationOrigin || url.username || url.password || url.hash) return disabled.fetch(request);
        const asset = url.pathname === "/student" ? "student.html"
          : /^\/(student\.(css|js)|view\.js|controller\.js|model\.js)$/.test(url.pathname) ? url.pathname.slice(1) : undefined;
        const api = request.method === "GET" && (url.pathname === "/api/auth/student/csrf" ||
          url.pathname === "/api/me/reservations" || /^\/api\/me\/schedule-months\/[^/]+$/.test(url.pathname)) ||
          request.method === "POST" && (url.pathname === "/api/me/reservations/preview" || url.pathname === "/api/me/reservations");
        if (!(asset && !url.search && request.method === "GET") && !api) return disabled.fetch(request);
        // Strict Worker binding shape; SQL, auth and business decisions belong
        // to the existing factory/Adapters. Unknown bindings never get used.
        if (!env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).sort().join(",") !== "ASSETS,EVALUATION_BOOKING_DB" ||
            !env.ASSETS || typeof env.ASSETS !== "object" || Array.isArray(env.ASSETS) || typeof env.ASSETS.fetch !== "function") return disabled.fetch(request);
        const database = env.EVALUATION_BOOKING_DB;
        if (!database || typeof database !== "object" || Array.isArray(database) ||
            typeof database.prepare !== "function" || typeof database.withSession !== "function") return disabled.fetch(request);
        // Concurrent first requests share one lifetime key; failure is sticky.
        cursorKey ??= (async () => {
          try { return await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]); }
          catch { return undefined; }
        })();
        const key = await cursorKey;
        // Assets also fail closed for a malformed write Port or lifetime key.
        if (asset) {
          const session = (database as ReservationConfirmD1).withSession("first-primary");
          if (!session || typeof session !== "object" || Array.isArray(session) || typeof session.prepare !== "function" || typeof session.batch !== "function" ||
              !(key instanceof CryptoKey) || key.type !== "secret" || key.extractable ||
              key.algorithm.name !== "HMAC" || (key.algorithm as HmacKeyAlgorithm).hash.name !== "SHA-256" ||
              key.usages.length !== 1 || key.usages[0] !== "sign") return disabled.fetch(request);
          const result = await env.ASSETS.fetch(new Request(`${applicationOrigin}/${asset}`, { method: "GET" }));
          if (result.status !== 200 && result.status !== 404) return disabled.fetch(request);
          return new Response(result.status === 404 ? "Asset not available." : result.body, {
            status: result.status, headers: {
              "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
              "content-type": result.status === 404 ? "text/plain; charset=utf-8"
                : asset.endsWith(".html") ? "text/html; charset=utf-8"
                : asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
            },
          });
        }
        return await createReservationStudentService({ database, applicationOrigin, cursorKey: key }).fetch(request);
      } catch { return disabled.fetch(request); }
    },
  };
}

export default createReservationEvaluationWorker();
