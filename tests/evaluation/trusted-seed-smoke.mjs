// #906: opt-in owner creates a fresh dedicated persist; no seed HTTP listener.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stopWorker } from "./local-https-smoke.mjs";
import { failure, persistence, root } from "./trusted-evaluation-seed.mjs";
import { httpsProofCheckpoint } from "./trusted-https-assertions.mjs";
import { browserBinary, browserEvidence, browserFailureCheckpoint, browserPreflight, browserProofCheckpoint } from "./trusted-browser-reads.mjs";
import { parseBrowserDiagnostic } from "./browser-tls-trust.mjs";

const exec = promisify(execFile);
const present = (path) => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw failure(); } };

export async function run(httpsProof = false, browserProof = false, failAfterPositive = false) {
  if ([httpsProof, browserProof, failAfterPositive].some((value) => typeof value !== "boolean") ||
    (browserProof && !httpsProof) || (failAfterPositive && !browserProof)) throw failure();
  if (process.platform !== "linux" || !/^v24\./.test(process.version)) throw failure();
  if (!existsSync(join(root, "node_modules/.bin/wrangler"))) throw new Error("TRUSTED_EVALUATION_SEED_UNAVAILABLE");
  if (browserProof) browserPreflight();
  if (present(persistence) || (present(join(root, ".wrangler")) && !lstatSync(join(root, ".wrangler")).isDirectory())) throw failure();
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-seed-"));
  const env = { PATH: process.env.PATH, HOME: temporary, XDG_CONFIG_HOME: temporary,
    TMPDIR: temporary, WRANGLER_SEND_METRICS: "false", CI: "true", WRANGLER_LOG_PATH: join(temporary, "wrangler.log") };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  let owned = false, safe = true, intentionalConfirmed = false;
  const command = async (file, args, proof = false) => {
    const pending = exec(file, args, { cwd: root, env, detached: true, timeout: browserProof ? 180000 : httpsProof ? 120000 : 60000,
      maxBuffer: 1024 * 1024, signal: controller.signal });
    try {
      const result = await pending;
      if (proof) {
        if (browserProof && failAfterPositive) throw failure(); // Intentional proof requires exit 1, never normal success.
        const checkpoint = browserProof ? browserProofCheckpoint : httpsProofCheckpoint;
        if (result.stderr !== "") throw failure();
        if (browserProof) console.log(browserEvidence(result.stdout));
        else if (result.stdout !== checkpoint + "\n") throw failure();
        // Print the allowlisted literal, never child output or secret causes.
        console.log(checkpoint);
      }
    } catch (error) {
      if (proof && browserProof && failAfterPositive && error.code === 1 && error.stderr === "") {
        try {
          const certificate = browserEvidence(error.stdout, true);
          intentionalConfirmed = true;
          console.log(certificate);
          console.log(browserFailureCheckpoint);
          return;
        } catch { /* unrecognized child output: preserve files below */ }
      }
      // Normal and intentional runs share the same strict, non-secret parser.
      if (proof && browserProof) {
        const diagnostic = parseBrowserDiagnostic(error.stderr);
        console.log(diagnostic ?? "TRUSTED_BROWSER_STAGE=unknown; CLEANUP=unknown");
      }
      if (httpsProof) safe = false; // Unknown proxy/Worker state: retain files.
      throw failure();
    }
    finally {
      if (pending.child.pid) {
        try {
          if (!await stopWorker(pending.child, async (f, a) => (await exec(f, a, { env, timeout: 5000 })).stdout)) throw failure();
        } catch { safe = false; throw failure(); }
      }
    }
  };
  try {
    if ((await exec("ss", ["-H", "-ltn", "sport = :8788"], { env, timeout: 5000 })).stdout.trim()) throw failure();
    if (browserProof) {
      const version = (await exec(browserBinary, ["--version"], { env, timeout: 30000 })).stdout.trim();
      if (!/^Google Chrome \d+\.\d+\.\d+\.\d+$/.test(version)) throw failure();
      console.log(`browser=${version}; installed fixed binary; strict run-owned NSS trust; origin=https://127.0.0.1:8788`);
    }
    // Check config/credential isolation BEFORE migration writes. v3 is created
    // by the CLI, so this preflight only validates static inputs.
    await command(process.execPath, ["--input-type=module", "-e",
      "import { checkStaticSetup } from './tests/evaluation/trusted-evaluation-seed.mjs'; try { checkStaticSetup(); } catch { process.exitCode = 1; }"]);
    mkdirSync(join(root, ".wrangler"), { recursive: true });
    mkdirSync(persistence); owned = true;
    await command(join(root, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", "nssscdl-local-read-only-evaluation",
      "--config", "tests/evaluation/wrangler.jsonc", "--local", "--persist-to", ".wrangler/student-read-only-evaluation"]);
    if (httpsProof) {
      console.log(`checkpoint: head=${(await exec("git", ["rev-parse", "HEAD"], { env, timeout: 5000 })).stdout.trim()}; UTC=${new Date().toISOString()}; Node=${process.version}; Wrangler=4.146.0; config=tests/evaluation/wrangler.jsonc; EVALUATION_READ_DB; local-only; migrations=0001..0012`);
    }
    await command(process.execPath, [...(httpsProof ? ["--disable-warning=ExperimentalWarning"] : []),
      httpsProof ? "tests/evaluation/trusted-https-process.mjs" : "tests/evaluation/trusted-seed-process.mjs",
      ...(browserProof ? ["--browser", ...(failAfterPositive ? ["--fail-after-positive"] : [])] : [])], httpsProof);
    controller.signal.throwIfAborted();
  } catch { throw failure(); }
  finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (safe) {
      if (owned) rmSync(persistence, { recursive: true });
      rmSync(temporary, { recursive: true });
    }
    if (!safe) throw new Error("TRUSTED_EVALUATION_SEED_CLEANUP_FAILED; owned persistence retained; do not retry");
  }
  console.log(browserProof ? "#914: owned process groups stopped / port closed / owned persist and temporary files removed; formal Actions / full TC / Gate A-D remain separate" : httpsProof ? "#908: owned process groups stopped / port closed / owned persist and temporary cert/log removed; local HTTPS partial evidence only; Browser/Gate A-D unverified" : "#906: Node 24 / Wrangler 4.146.0 / EVALUATION_READ_DB / CLI persist-to vs proxy v3 / 12 migrations / actual persistent seed and separate-proxy reads / hash only / repeat refusal / disposal and owned cleanup passed; local setup partial evidence only");
  if (failAfterPositive && !intentionalConfirmed) throw failure();
  return !intentionalConfirmed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--run") {
    console.error("Opt-in only: node tests/evaluation/trusted-seed-smoke.mjs --run"); process.exitCode = 1;
  } else {
    try { await run(); }
    catch (e) {
      console.error(e.message === "TRUSTED_EVALUATION_SEED_UNAVAILABLE" ? e.message :
        e.message.startsWith("TRUSTED_EVALUATION_SEED_CLEANUP_FAILED;") ? e.message : "TRUSTED_EVALUATION_SEED_FAILED; runtime unverified");
      process.exitCode = 1;
    }
  }
}
