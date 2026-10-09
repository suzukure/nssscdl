// #906: trusted Node memory only; never imported by a Worker or Browser.
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedTrustedStudents } from "../fixtures/d1/trusted-student-seed.ts";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const persistence = resolve(root, ".wrangler/student-read-only-evaluation");
export const proxyOptions = Object.freeze({
  configPath: resolve(root, "tests/evaluation/wrangler.jsonc"),
  remoteBindings: false,
  persist: Object.freeze({ path: resolve(persistence, "v3") }),
});
export const failure = () => new Error("TRUSTED_EVALUATION_SEED_FAILED");

export function validation() {
  return {
    authSql: readFileSync(resolve(root, "migrations/validation/student_auth.sql"), "utf8"),
    reservationScans: readFileSync(resolve(root, "migrations/validation/reservation.sql"), "utf8")
      .replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean),
  };
}

export function checkStaticSetup() {
  try {
    if (!/^v24\./.test(process.version)) throw failure();
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
    if (pkg.devDependencies.wrangler !== "4.146.0" ||
        lock.packages["node_modules/wrangler"].version !== "4.146.0" ||
        JSON.parse(readFileSync(resolve(root, "node_modules/wrangler/package.json"), "utf8")).version !== "4.146.0") throw failure();
    const cfg = JSON.parse(readFileSync(proxyOptions.configPath, "utf8"));
    const expected = {
      name: "nssscdl-local-read-only-evaluation", main: "worker.ts", compatibility_date: "2026-10-06",
      workers_dev: false, preview_urls: false,
      dev: { ip: "127.0.0.1", port: 8788, local_protocol: "https" },
      d1_databases: [{ binding: "EVALUATION_READ_DB", database_name: "nssscdl-local-read-only-evaluation",
        database_id: "00000000-0000-4000-8000-000000000902", migrations_dir: "../../migrations" }],
    };
    // Closed config: no provider/environment-selected binding, path or remote flag.
    if (JSON.stringify(cfg) !== JSON.stringify(expected)) throw failure();
    for (const dir of [root, resolve(root, "tests"), resolve(root, "tests/evaluation")]) {
      if (readdirSync(dir).some((n) => /^(\.env|\.dev\.vars)(\.|$)/.test(n) && n !== ".env.example")) throw failure();
    }
    const allowed = new Set(["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR", "WRANGLER_SEND_METRICS", "CI", "WRANGLER_LOG_PATH"]);
    if (Object.keys(process.env).some((key) => !allowed.has(key)) || process.env.WRANGLER_SEND_METRICS !== "false") throw failure();
    const temporary = process.env.TMPDIR;
    if (!temporary || process.env.HOME !== temporary || process.env.XDG_CONFIG_HOME !== temporary ||
        process.env.WRANGLER_LOG_PATH !== resolve(temporary, "wrangler.log") ||
        !lstatSync(temporary).isDirectory() || realpathSync(temporary) !== temporary) throw failure();
  } catch { throw failure(); }
}

export function checkSetup() {
  checkStaticSetup();
  try {
    if (execFileSync("ss", ["-H", "-ltn", "sport = :8788"], { encoding: "utf8", timeout: 5000 }).trim()) throw failure();
    for (const path of [resolve(root, ".wrangler"), persistence, proxyOptions.persist.path]) {
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw failure();
    }
  } catch { throw failure(); }
}

// Test-only factory seam exercises lifecycle with the existing D1 Port. The
// public composition below supplies ONLY locked Wrangler's actual factory.
export async function useSeedProxy(createProxy, consume) {
  let proxy;
  try {
    if (typeof consume !== "function") throw failure();
    proxy = await createProxy(proxyOptions);
    if (Object.keys(proxy.env).length !== 1 || !proxy.env.EVALUATION_READ_DB) throw failure();
    const seed = await seedTrustedStudents(proxy.env.EVALUATION_READ_DB, validation());
    // No simultaneous DB connection: callback may open its own read-only proxy
    // or later start the local Worker only AFTER disposal is confirmed.
    const closing = proxy;
    proxy = undefined;
    await closing.dispose();
    await consume(seed); // Ignore callback result: no secret-bearing return path.
  } catch { throw failure(); }
  finally {
    if (proxy) {
      try { await proxy.dispose(); } catch { throw failure(); }
    }
  }
}

export async function withTrustedEvaluationSeed(consume) {
  try {
    checkSetup();
    const { getPlatformProxy } = await import("wrangler");
    await useSeedProxy(getPlatformProxy, consume);
  } catch { throw failure(); }
}
