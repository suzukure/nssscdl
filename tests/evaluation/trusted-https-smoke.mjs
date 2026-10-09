// Opt-in owner; the existing #906 runner owns migrations and sanitized child.
import { run } from "./trusted-seed-smoke.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--run") {
  console.error("Opt-in only: node tests/evaluation/trusted-https-smoke.mjs --run");
  process.exitCode = 1;
} else {
  try { await run(true); }
  catch {
    console.error("TRUSTED_HTTPS_PROOF_FAILED; runtime/cleanup unverified; retain any owned files for operator inspection; do not retry");
    process.exitCode = 1;
  }
}
