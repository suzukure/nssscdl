// #1055 diagnostic-only preflight; NEVER launches a browser session.
// Usage in a *future separately approved* one-shot: node this-file <owned-CFT-binary>
// Emits fixed enums, no stdout/stderr/path/environment reflection.
import { lstatSync, openSync, readSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { classifyBinary, classifyVersion } from "./issue-1055-cft157-admission.mjs";

function metadata(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "binary-missing";
    if (!stat.isFile()) return "binary-missing";
    let fd;
    try {
      fd = openSync(path, "r");
      const magic = Buffer.alloc(4);
      const size = readSync(fd, magic, 0, 4, 0);
      return classifyBinary({
        regular: true,
        symlink: false,
        executable: Boolean(stat.mode & 0o111),
        elf: size === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
      });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } catch { return "binary-missing"; }
}

function verify(path) {
  const initial = metadata(path);
  console.log("H9_CFT_ADMISSION stage=binary; result=" + initial);
  if (initial !== "binary-ready") return false;
  let child;
  try {
    child = spawnSync(path, ["--version"], {
      encoding: "utf8", timeout: 8_000, maxBuffer: 4_096,
      stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
  } catch {
    child = { status: null, stdout: "", error: true };
  }
  const result = classifyVersion({
    exitCode: child?.status ?? null,
    stdout: child?.stdout ?? "",
    failure: Boolean(child?.error || child?.signal),
  });
  console.log("H9_CFT_ADMISSION stage=version; result=" + result);
  return result === "version-confirmed";
}

if (process.argv.length !== 3 || !process.argv[2]?.startsWith("/")) {
  console.log("H9_CFT_ADMISSION stage=input; result=unproved");
  process.exitCode = 1;
} else if (!verify(process.argv[2])) {
  process.exitCode = 1;
}
