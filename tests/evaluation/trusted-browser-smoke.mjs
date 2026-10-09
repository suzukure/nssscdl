// #914 explicit opt-in. The #906 owner still owns migrations and sanitized child.
import { run } from "./trusted-seed-smoke.mjs";

const args = process.argv.slice(2);
if (!(args.length === 1 && args[0] === "--run") &&
    !(args.length === 2 && args[0] === "--run" && args[1] === "--fail-after-positive")) {
  console.error("Opt-in only: node tests/evaluation/trusted-browser-smoke.mjs --run [--fail-after-positive]");
  process.exitCode = 1;
} else {
  try { if (!await run(true, true, args.length === 2)) process.exitCode = 1; }
  catch {
    console.error("TRUSTED_BROWSER_PROOF_FAILED; runtime/cleanup unverified; retain any owned files; do not retry");
    process.exitCode = 1;
  }
}
