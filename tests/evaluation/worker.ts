import { createReadOnlyStudentService, type ReadOnlyStudentConfig } from "../fixtures/read-only-student-service";

// Trusted server configuration, never inferred from Host, URL, headers or vars.
const applicationOrigin = "https://127.0.0.1:8788";
interface EvaluationEnv {
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly EVALUATION_READ_DB?: ReadOnlyStudentConfig["database"];
}

// Factory represents a new local Worker lifetime in tests. No HTTP setup API.
export function createEvaluationWorker() {
  const disabled = createReadOnlyStudentService();
  let cursorKey: Promise<CryptoKey | undefined> | undefined;
  return {
    async fetch(request: Request, env: EvaluationEnv): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.origin !== applicationOrigin) return disabled.fetch(request);
        // Worker-first for every request: assets cannot bypass fixed origin or
        // expose arbitrary build files. No identity is inferred for static UI.
        const asset = url.pathname === "/student" ? "student.html"
          : /^\/(student\.(css|js)|view\.js|controller\.js|model\.js)$/.test(url.pathname) ? url.pathname.slice(1) : undefined;
        if (asset && !url.search && request.method === "GET") {
          if (!env?.ASSETS || typeof env.ASSETS.fetch !== "function") return disabled.fetch(request);
          const input = new Request(`${applicationOrigin}/${asset}`, { method: "GET" });
          const result = await env.ASSETS.fetch(input);
          if (result.status !== 200 && result.status !== 404) return disabled.fetch(request);
          const headers = new Headers();
          headers.set("cache-control", "no-store");
          headers.set("x-content-type-options", "nosniff");
          headers.set("referrer-policy", "no-referrer");
          headers.set("content-type", result.status === 404 ? "text/plain; charset=utf-8"
            : asset.endsWith(".html") ? "text/html; charset=utf-8"
            : asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
          return new Response(result.status === 404 ? "Asset not available." : result.body, { status: result.status, headers });
        }
        const database = env?.EVALUATION_READ_DB;
        if (!database || typeof database !== "object" || Array.isArray(database) ||
            typeof database.prepare !== "function" || typeof database.withSession !== "function") {
          return disabled.fetch(request);
        }
        // Publish the promise before awaiting: concurrent first requests share
        // one non-exportable sign-only key. Failure is sticky until restart.
        cursorKey ??= (async () => {
          try {
            return await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          } catch { return undefined; }
        })();
        return await createReadOnlyStudentService({
          database, applicationOrigin, cursorKey: await cursorKey,
        }).fetch(request);
      } catch { return disabled.fetch(request); }
    },
  };
}

// Dedicated config only; no scheduled handler, seed or unsafe APIs.
export default createEvaluationWorker();
