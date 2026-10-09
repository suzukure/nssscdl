import { createReadOnlyStudentService, type ReadOnlyStudentConfig } from "../fixtures/read-only-student-service";

// Trusted server configuration, never inferred from Host, URL, headers or vars.
const applicationOrigin = "https://127.0.0.1:8788";
interface EvaluationEnv {
  readonly EVALUATION_READ_DB?: ReadOnlyStudentConfig["database"];
}

// Factory represents a new local Worker lifetime in tests. No HTTP setup API.
export function createEvaluationWorker() {
  const disabled = createReadOnlyStudentService();
  let cursorKey: Promise<CryptoKey | undefined> | undefined;
  return {
    async fetch(request: Request, env: EvaluationEnv): Promise<Response> {
      try {
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

// Dedicated config only; no assets, scheduled handler, seed or unsafe APIs.
export default createEvaluationWorker();
