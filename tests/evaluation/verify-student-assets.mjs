// Local build preflight only; runtime precedence remains an opt-in proof.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function verifyStudentAssets(root = fileURLToPath(new URL("../../", import.meta.url))) {
  const directory = resolve(root, "dist/student");
  const files = ["student.html", "student.css", "student.js", "view.js", "controller.js", "model.js"];
  assert.deepEqual(readdirSync(directory).sort(), files.sort(), "Unexpected student build files");
  for (const file of files) {
    const stat = lstatSync(resolve(directory, file));
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, "Student build missing or invalid");
  }
  const config = JSON.parse(readFileSync(resolve(root, "tests/evaluation/wrangler.jsonc"), "utf8"));
  assert.deepEqual(config.assets, { directory: "../../dist/student", binding: "ASSETS",
    run_worker_first: true, html_handling: "none", not_found_handling: "none" });
  const normal = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
  assert.equal(normal.assets, undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) verifyStudentAssets();
