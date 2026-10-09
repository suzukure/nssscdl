// #902: Only local CLI introspection; no dev listener, deploy, tunnel or remote D1.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expected = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).devDependencies.wrangler;
const wrangler = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
function readHelp(...args) {
  return execFileSync(wrangler, args, {
    cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
}
const version = readHelp("--version");
assert.ok(version.includes(expected), "Locked Wrangler version differs from executable");
const commands = [
  { args: ["dev", "--help"], flags: ["--config", "--ip", "--port", "--local-protocol", "--persist-to"] },
  { args: ["deploy", "--help"], flags: ["--config", "--dry-run", "--outdir"] },
  { args: ["d1", "migrations", "apply", "--help"], flags: ["--config", "--local", "--persist-to"] },
];
for (const { args, flags } of commands) {
  const help = readHelp(...args);
  for (const flag of flags) assert.ok(help.includes(flag), `Locked Wrangler ${args.join(" ")} lacks ${flag}`);
}
// --infer-origin-from-routes is absent from Wrangler 4.146.0's dev --help;
 // do not suggest the --no- form. Route-free loopback origin is proved in #904.
console.log(`Locked Wrangler ${expected}: advertised dev/deploy/D1 local CLI flags verified (help only); infer-origin override is not asserted.`);
