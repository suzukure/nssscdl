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
import { browserBinary, browserFailureCheckpoint, browserPreflight, browserProofCheckpoint } from "./trusted-browser-reads.mjs";
import { generatedBrowserFiles } from "./browser-tls-trust.mjs";
import { BrowserUnit, browserUnitPreflight, finishBrowserUnit, ownedIdentity, readBrowserReport, verifyOwned } from "./trusted-browser-unit.mjs";

const exec = promisify(execFile);
const present = (path) => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw failure(); } };

export async function run(httpsProof = false, browserProof = false, failAfterPositive = false) {
  if ([httpsProof, browserProof, failAfterPositive].some((value) => typeof value !== "boolean") ||
    (browserProof && !httpsProof) || (failAfterPositive && !browserProof)) throw failure();
  if (process.platform !== "linux" || !/^v24\./.test(process.version)) throw failure();
  if (!existsSync(join(root, "node_modules/.bin/wrangler"))) throw new Error("TRUSTED_EVALUATION_SEED_UNAVAILABLE");
  const ownerDeadline = Date.now() + 180000;
  if (browserProof) browserPreflight();
  if (present(persistence) || (present(join(root, ".wrangler")) && !lstatSync(join(root, ".wrangler")).isDirectory())) throw failure();
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-seed-"));
  const env = { PATH: process.env.PATH, HOME: temporary, XDG_CONFIG_HOME: temporary,
    TMPDIR: temporary, WRANGLER_SEND_METRICS: "false", CI: "true", WRANGLER_LOG_PATH: join(temporary, "wrangler.log") };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  let owned = false, safe = true, managedRemoved = false, intentionalConfirmed = false, unit;
  let temporaryIdentity, persistenceIdentity, homeIdentity;
  const unitOptions = { env, cwd: root, signal: controller.signal, deadline: ownerDeadline };
  const remaining = (reserve = 10000) => {
    const ms = ownerDeadline - Date.now() - reserve;
    if (ms <= 0 || controller.signal.aborted) throw failure();
    return ms;
  };
  const command = async (file, args, proof = false) => {
    const pending = exec(file, args, { cwd: root, env, detached: true, timeout: browserProof ? remaining(30000) : httpsProof ? 120000 : 60000,
      maxBuffer: 1024 * 1024, signal: controller.signal });
    try {
      const result = await pending;
      if (proof) {
        if (result.stderr !== "" || result.stdout !== httpsProofCheckpoint + "\n") throw failure();
        console.log(httpsProofCheckpoint);
      }
    } catch {
      if (httpsProof) safe = false; // Unknown proxy/Worker state: retain files.
      throw failure();
    }
    finally {
      if (pending.child.pid) {
        try {
          if (!await stopWorker(pending.child, async (f, a) => (await exec(f, a, { env, timeout: browserProof ? Math.min(5000, remaining(0)) : 5000 })).stdout)) throw failure();
        } catch { safe = false; throw failure(); }
      }
    }
  };
  try {
    if (browserProof) {
      safe = false;
      await browserUnitPreflight(unitOptions); // Before any persist/migration write.
      safe = true;
      temporaryIdentity = ownedIdentity(temporary);
      mkdirSync(join(temporary, "browser-home"), { mode: 0o700 });
      homeIdentity = ownedIdentity(join(temporary, "browser-home"));
    }
    if ((await exec("ss", ["-H", "-ltn", "sport = :8788"], { env, timeout: browserProof ? Math.min(5000, remaining()) : 5000 })).stdout.trim()) throw failure();
    if (browserProof) {
      const version = (await exec(browserBinary, ["--version"], { env, timeout: Math.min(30000, remaining()), signal: controller.signal })).stdout.trim();
      if (!/^Google Chrome \d+\.\d+\.\d+\.\d+$/.test(version)) throw failure();
      console.log(`browser=${version}; installed fixed binary; strict run-owned NSS trust; origin=https://127.0.0.1:8788`);
    }
    // Check config/credential isolation BEFORE migration writes. v3 is created
    // by the CLI, so this preflight only validates static inputs.
    await command(process.execPath, ["--input-type=module", "-e",
      "import { checkStaticSetup } from './tests/evaluation/trusted-evaluation-seed.mjs'; try { checkStaticSetup(); } catch { process.exitCode = 1; }"]);
    mkdirSync(join(root, ".wrangler"), { recursive: true });
    mkdirSync(persistence, browserProof ? { mode: 0o700 } : undefined); owned = true;
    if (browserProof) persistenceIdentity = ownedIdentity(persistence);
    await command(join(root, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", "nssscdl-local-read-only-evaluation",
      "--config", "tests/evaluation/wrangler.jsonc", "--local", "--persist-to", ".wrangler/student-read-only-evaluation"]);
    if (httpsProof) {
      console.log(`checkpoint: head=${(await exec("git", ["rev-parse", "HEAD"], { env, timeout: browserProof ? Math.min(5000, remaining()) : 5000 })).stdout.trim()}; UTC=${new Date().toISOString()}; Node=${process.version}; Wrangler=4.146.0; config=tests/evaluation/wrangler.jsonc; EVALUATION_READ_DB; local-only; migrations=0001..0012`);
    }
    if (browserProof) {
      unit = new BrowserUnit(unitOptions);
      safe = false; // Manager start/outcome unknown always retains files.
      await unit.start(process.execPath, ["--disable-warning=ExperimentalWarning", "tests/evaluation/trusted-https-process.mjs",
        "--browser", ...(failAfterPositive ? ["--fail-after-positive"] : [])]);
      const certificate = await finishBrowserUnit(unit, {
        intentional: failAfterPositive,
        report: () => readBrowserReport(temporary, failAfterPositive),
        finalCheck: async () => {
          if ((await exec("ss", ["-H", "-ltn", "sport = :8788"], { env, timeout: Math.min(5000, remaining()), signal: controller.signal })).stdout.trim() ||
            generatedBrowserFiles(temporary).length) throw failure();
        },
        remove: async () => {
          remaining(0);
          // Check ALL roots before any deletion; never glob another run.
          for (const identity of [temporaryIdentity, homeIdentity, persistenceIdentity]) verifyOwned(identity);
          rmSync(persistence, { recursive: true }); owned = false;
          rmSync(temporary, { recursive: true }); managedRemoved = true;
        },
      });
      intentionalConfirmed = failAfterPositive;
      console.log(certificate);
      console.log(failAfterPositive ? browserFailureCheckpoint : browserProofCheckpoint);
    } else {
      await command(process.execPath, [...(httpsProof ? ["--disable-warning=ExperimentalWarning"] : []),
        httpsProof ? "tests/evaluation/trusted-https-process.mjs" : "tests/evaluation/trusted-seed-process.mjs"], httpsProof);
    }
    controller.signal.throwIfAborted();
  } catch (error) {
    if (browserProof) safe = false;
    if (browserProof && unit) {
      unit.latch("UNKNOWN");
      try { await unit.dispose(); } catch { /* owned files preserved; no retry */ }
      unit.close();
      let diagnostic;
      try { diagnostic = readBrowserReport(temporary, failAfterPositive).diagnostic; } catch { /* fixed unknown */ }
      console.log(diagnostic ?? "TRUSTED_BROWSER_STAGE=unknown; CLEANUP=unknown");
    }
    if (error.message === "TRUSTED_BROWSER_UNIT_UNAVAILABLE") console.log("TRUSTED_BROWSER_UNIT_UNAVAILABLE");
    throw failure();
  }
  finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (safe) {
      if (owned) rmSync(persistence, { recursive: true });
      rmSync(temporary, { recursive: true });
    }
    if (!safe && !managedRemoved) throw new Error("TRUSTED_EVALUATION_SEED_CLEANUP_FAILED; owned persistence retained; do not retry");
  }
  console.log(browserProof ? "#914: same invocation unit no-live verified before release / port closed / run-owned HOME,NSS,cert,key,persist,temporary removed; formal Actions / full TC / Gate A-D remain separate" : httpsProof ? "#908: owned process groups stopped / port closed / owned persist and temporary cert/log removed; local HTTPS partial evidence only; Browser/Gate A-D unverified" : "#906: Node 24 / Wrangler 4.146.0 / EVALUATION_READ_DB / CLI persist-to vs proxy v3 / 12 migrations / actual persistent seed and separate-proxy reads / hash only / repeat refusal / disposal and owned cleanup passed; local setup partial evidence only");
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
