// #1055 Stage 2 runner preflight. No Chrome browser session or HTTP requests.
// node this-file --self-test | --probe <owned-root> <owned-browser-binary>
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, openSync, readSync, closeSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import assert from "node:assert/strict";

const EXPECTED = "157.0.8092.0";
const LABEL = /^(?:Google Chrome(?: for Testing)?|Chromium|Chrome for Testing) 157\.0\.8092\.0\s*$/;
const KEYS = ["TMPDIR", "TMP", "TEMP"];
function run(file, args, timeout = 8000) {
  try {
    const x = spawnSync(file, args, { encoding: "utf8", timeout, maxBuffer: 131072,
      stdio: ["ignore", "pipe", "pipe"], shell: false });
    return { ok: !x.error && !x.signal && x.status === 0,
      text: typeof x.stdout === "string" ? x.stdout : "" };
  } catch { return { ok: false, text: "" }; }
}
function numberFrom(path) {
  try { const s = readFileSync(path, "utf8").trim(); return /^\d+$/.test(s) ? Number(s) : null; }
  catch { return null; }
}
function binaryCheck(path) {
  try {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || !s.isFile()) return "binary-absent";
    if (!(s.mode & 0o111)) return "binary-mode";
    const b = Buffer.alloc(20), fd = openSync(path, "r");
    let count;
    try { count = readSync(fd, b, 0, 20, 0); } finally { closeSync(fd); }
    return count === 20 && b.subarray(0,4).equals(Buffer.from([127,69,76,70])) &&
      b[4] === 2 && b[5] === 1 && b.readUInt16LE(18) === 62 ?
      "binary-ready" : "binary-format";
  } catch { return "binary-absent"; }
}
function versionCheck(path, binary) {
  if (binary !== "binary-ready") return "version-skipped";
  const x = run(path, ["--version"]);
  if (!x.ok) return "binary-unlaunchable";
  if (x.text.length > 128 || x.text.includes("\0")) return "version-mismatch";
  return LABEL.test(x.text) ? "version-confirmed" : "version-mismatch";
}
function libraries(path, binary) {
  if (binary !== "binary-ready") return "libs-skipped";
  const dyn = run("/usr/bin/readelf", ["-d", path]);
  const inventory = run("/sbin/ldconfig", ["-p"]);
  if (!dyn.ok || !inventory.ok) return "libs-unknown";
  const needed = [...dyn.text.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(x => x[1]);
  if (!needed.length || needed.length > 80) return "libs-unknown";
  const missing = needed.filter(name => !/^[a-zA-Z0-9_.+\-]+$/.test(name) ||
    (!existsSync(join(dirname(path), name)) && !inventory.text.includes(name+" (")));
  return missing.length ? "libs-incomplete" : "libs-direct-listed";
}
function sandboxProbe() {
  const max = numberFrom("/proc/sys/user/max_user_namespaces");
  const enable = numberFrom("/proc/sys/kernel/unprivileged_userns_clone");
  let userns;
  if (max === 0 || enable === 0) userns = "userns-disabled";
  else userns = run("/usr/bin/unshare", ["-Ur","/usr/bin/true"], 5000).ok ?
    "userns-probe-pass" : "userns-probe-blocked";
  const apparmor = numberFrom("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
  return {userns, apparmor: apparmor === null ? "apparmor-unknown" :
    apparmor === 0 ? "apparmor-restriction-off" : "apparmor-restriction-on"};
}
function sandboxHelper(path) {
  try {
    const s = lstatSync(join(dirname(path), "chrome-sandbox"));
    return s.isFile() && !s.isSymbolicLink() && s.uid === 0 &&
      (s.mode & 0o4000) !== 0 && (s.mode & 0o111) !== 0 ?
      "helper-suid-ready" : "helper-not-suid";
  } catch { return "helper-unavailable"; }
}
function tlsCheck(root) {
  if (!existsSync("/usr/bin/openssl") || !existsSync("/usr/bin/certutil")) return "tls-tools-unknown";
  const dir = join(root, "tls-owned"), key = join(dir,"key.pem"), crt=join(dir,"cert.pem"), db=join(dir,"nssdb");
  try {
    mkdirSync(dir,{mode:0o700}); mkdirSync(db,{mode:0o700});
    if (!run("/usr/bin/openssl", ["req","-x509","-newkey","rsa:2048","-nodes",
      "-sha256","-days","1","-keyout",key,"-out",crt,"-subj","/CN=127.0.0.1",
      "-addext","subjectAltName=IP:127.0.0.1"],12000).ok) return "tls-cert-failed";
    if (!run("/usr/bin/certutil",["-N","--empty-password","-d","sql:"+db]).ok) return "tls-db-failed";
    if (!run("/usr/bin/certutil",["-A","-d","sql:"+db,"-t","P,,","-n","nssscdl-1055-preflight","-i",crt]).ok)
      return "tls-trust-failed";
    return run("/usr/bin/certutil",["-L","-d","sql:"+db,"-n","nssscdl-1055-preflight"]).ok ?
      "tls-material-ready" : "tls-verify-failed";
  } catch { return "tls-unknown"; }
}
function parentTmp(root) {
  const prev = Object.fromEntries(KEYS.map(key => [key,process.env[key]]));
  try {
    for (const key of KEYS) process.env[key]=root;
    if (tmpdir() !== root) return "parent-tmp-mismatch";
    const sub = mkdtempSync(join(tmpdir(),"playwright-test-owned-"));
    if (!sub.startsWith(root+"/")) return "parent-tmp-mismatch";
    rmSync(sub,{recursive:true});
    return "parent-tmp-observed";
  } catch { return "parent-tmp-unknown"; }
  finally { for (const key of KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key]=prev[key];
  } }
}
function safeRoot(root) {
  try {
    const s=lstatSync(root);
    return isAbsolute(root) && resolve(root)===root && s.isDirectory() && !s.isSymbolicLink() &&
      s.uid===process.getuid() && (s.mode & 0o077)===0 &&
      root.startsWith(resolve(process.env.RUNNER_TEMP ?? "/nonexistent")+"/nssscdl-1055-");
  } catch { return false; }
}
function survey(root,path) {
  if (!safeRoot(root) || !isAbsolute(path) ||
      !path.startsWith(root+"/owned-extract/chrome-linux64/")) {
    console.log("H9_STAGE2 stage=input; result=owner-root-invalid");
    return 1;
  }
  const binary=binaryCheck(path), version=versionCheck(path,binary), libs=libraries(path,binary);
  const sandbox=sandboxProbe(), helper=sandboxHelper(path), tls=tlsCheck(root), owner=parentTmp(root);
  const observations={binary,version,libs,userns:sandbox.userns,
    apparmor:sandbox.apparmor,helper,tls,owner};
  for (const [stage,result] of Object.entries(observations))
    console.log("H9_STAGE2 stage="+stage+"; result="+result);
  const ready=binary==="binary-ready" && version==="version-confirmed" &&
    libs==="libs-direct-listed" && tls==="tls-material-ready" && owner==="parent-tmp-observed";
  console.log("H9_STAGE2 stage=summary; result="+(ready?"measured-eligible-candidate":"needs-decision")+
    "; sandbox=unproved; browser_started=no; formal_proof=unproved");
  return 0;
}
function selftest() {
  assert.equal(binaryCheck("/nonexistent"),"binary-absent");
  assert.equal(versionCheck("/nonexistent","binary-absent"),"version-skipped");
  assert.equal(libraries("/nonexistent","binary-absent"),"libs-skipped");
  assert.equal(EXPECTED,"157.0.8092.0");
  assert.equal(LABEL.test("Google Chrome for Testing 157.0.8092.0\n"),true);
  assert.equal(LABEL.test("Google Chrome for Testing 154.0.8037.97\n"),false);
  assert.equal(safeRoot("/notowned"),false);
  console.log("H9_STAGE2 stage=self-test; result=pass; checks=7");
  return 0;
}
if (process.argv[2]==="--self-test" && process.argv.length===3) process.exitCode=selftest();
else if (process.argv[2]==="--probe" && process.argv.length===5)
  process.exitCode=survey(process.argv[3],process.argv[4]);
else {console.log("H9_STAGE2 stage=input; result=invalid");process.exitCode=1;}
