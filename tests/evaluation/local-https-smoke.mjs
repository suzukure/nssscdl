// #904: operator-owned, opt-in, local-only proof. No seed or Cookie input.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = "tests/evaluation/wrangler.jsonc";
const persist = ".wrangler/student-read-only-evaluation";
const database = "nssscdl-local-read-only-evaluation";
const origin = "https://127.0.0.1:8788";
const wrangler = join(root, "node_modules/.bin/wrangler");
const paths = ["/api/me/schedule-months/2026-11", "/api/me/reservations", "/api/auth/student/csrf"];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const present = (path) => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
const normalize = (sql) => sql.replace(/'[^']*(?:''[^']*)*'|\s+/g, (s) => s.startsWith("'") ? s : "").replace(/;$/, "");
const schemaQuery = `SELECT type, name, tbl_name, sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name`;

export function migrations() {
  const names = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(names.map((name) => name.slice(0, 4)), Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0")));
  return names;
}

// Independent expected schema from the authoritative migrations, not runtime output.
export function checkDatabase(db, names, requireHistory = true) {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec("PRAGMA foreign_keys=ON");
    for (const name of names) expected.exec(readFileSync(join(root, "migrations", name), "utf8"));
    const objects = (input) => input.prepare(schemaQuery).all().map((r) => [r.type, r.name, r.tbl_name, normalize(r.sql)]);
    assert.deepEqual(objects(db), objects(expected));
    if (requireHistory) assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((r) => r.name), names);
    const tables = expected.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    for (const { name } of tables) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, 0);
    const scans = readFileSync(join(root, "migrations/validation/reservation.sql"), "utf8")
      .replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
    assert.equal(scans.length, 12);
    for (const sql of ["PRAGMA foreign_key_check", readFileSync(join(root, "migrations/validation/student_auth.sql"), "utf8"), ...scans]) {
      assert.equal(db.prepare(sql).all().length, 0);
    }
    // All business rows remain empty; include schema/history to detect changes.
    return JSON.stringify([objects(db), requireHistory ? db.prepare("SELECT * FROM d1_migrations ORDER BY name").all() : []]);
  } finally { expected.close(); }
}

function sqliteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink());
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sqliteFiles(path) : entry.name.endsWith(".sqlite") ? [path] : [];
  });
}

export function request(path, ca, headers = {}, method = "GET", plain = false) {
  return new Promise((done, reject) => {
    const input = (plain ? httpRequest : httpsRequest)({
      hostname: "127.0.0.1", port: 8788, path, method, headers,
      ...(plain ? {} : { ca, rejectUnauthorized: true }), agent: false,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (part) => { body += part; if (body.length > 4096) response.destroy(new Error("response limit")); });
      response.on("error", reject);
      response.on("end", () => done({ status: response.statusCode, headers: response.headers, body }));
    });
    input.setTimeout(5000, () => input.destroy(new Error("request timeout")));
    input.on("error", reject);
    input.end();
  });
}

export function checkResponse(response, status) {
  const errors = {
    401: ["UNAUTHENTICATED", "認証が必要です。", "none"],
    403: ["CSRF_INVALID", "操作を確認できませんでした。画面を再読み込みしてください。", "reload"],
    503: ["SERVICE_UNAVAILABLE", "現在サービスを利用できません。時間をおいて再度お試しください。", "later"],
  };
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.match(response.headers["content-type"], /^application\/json/);
  const [code, message, retry] = errors[status];
  assert.deepEqual(JSON.parse(response.body), { error: { code, message, retry } });
  assert.deepEqual(response.headers["set-cookie"], status === 401 ? [
    "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ] : undefined);
}

async function stopGroup(child) {
  const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
  if (alive()) process.kill(-child.pid, "SIGINT");
  const deadline = Date.now() + 10000;
  while (alive() && Date.now() < deadline) await wait(100);
  const graceful = !alive();
  if (!graceful) {
    process.kill(-child.pid, "SIGKILL");
    const killDeadline = Date.now() + 5000;
    while (alive() && Date.now() < killDeadline) await wait(100);
  }
  assert.ok(!alive(), "worker process group still alive");
  return graceful;
}

export async function stopWorker(child, command) {
  const graceful = await stopGroup(child);
  assert.equal((await command("ss", ["-H", "-ltn", "sport = :8788"])).trim(), "", "listener still open");
  return graceful;
}

export async function run() {
  assert.equal(process.platform, "linux", "Linux with ss/ps is required");
  assert.match(process.version, /^v24\./);
  if (!existsSync(wrangler)) throw new Error("LOCAL_HTTPS_SMOKE_UNAVAILABLE (locked Wrangler 4.146.0 missing); runtime unverified");
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  if (present(join(root, ".wrangler"))) assert.ok(lstatSync(join(root, ".wrangler")).isDirectory());
  // Refuse leftovers: never reset, reuse or delete data owned by another run.
  assert.ok(!present(join(root, persist)), "Dedicated persistence already exists");
  for (const dir of [root, join(root, "tests"), join(root, "tests/evaluation")]) {
    assert.ok(!readdirSync(dir).some((n) => /^(\.env|\.dev\.vars)(\.|$)/.test(n) && n !== ".env.example"), "Local env file present");
  }
  const cfg = JSON.parse(readFileSync(join(root, config), "utf8"));
  assert.deepEqual(cfg, {
    name: database, main: "worker.ts", compatibility_date: "2026-10-06", workers_dev: false, preview_urls: false,
    dev: { ip: "127.0.0.1", port: 8788, local_protocol: "https" },
    d1_databases: [{ binding: "EVALUATION_READ_DB", database_name: database,
      database_id: "00000000-0000-4000-8000-000000000902", migrations_dir: "../../migrations" }],
  });
  const names = migrations();
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-https-"));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  // No inherited Cloudflare credentials, proxy, trust override or user config.
  const env = { PATH: process.env.PATH, HOME: temporary, XDG_CONFIG_HOME: temporary,
    TMPDIR: temporary, WRANGLER_SEND_METRICS: "false", CI: "true",
    WRANGLER_LOG_PATH: join(temporary, "wrangler.log") };
  let child, ownedPersist = false, stage = "preflight", safeToRemove = true;
  const command = async (file, args, cleanup = false) => {
    const pending = exec(file, args, {
      cwd: root, env, detached: true, timeout: 30000, maxBuffer: 1024 * 1024,
      ...(cleanup ? {} : { signal: controller.signal }),
    });
    try { return (await pending).stdout; }
    finally {
      // CLI timeout/cancellation must not leave a migration workerd behind.
      if (pending.child.pid) {
        let graceful;
        try { graceful = await stopGroup(pending.child); }
        catch { safeToRemove = false; throw new Error("command process state unknown"); }
        assert.ok(graceful, "command process group required forced termination");
      }
    }
  };
  try {
    assert.equal((await command("ss", ["-H", "-ltn", "sport = :8788"])).trim(), "");
    const version = await command(wrangler, ["--version"]);
    assert.match(version, /\b4\.146\.0\b/);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.wrangler, "4.146.0");
    const help = await command(wrangler, ["dev", "--help"]);
    for (const flag of ["--https-key-path", "--https-cert-path"]) assert.ok(help.includes(flag));
    console.log(`checkpoint: ${await command("git", ["rev-parse", "HEAD"])}date=${new Date().toISOString()} Node=${process.version} Wrangler=4.146.0 OS=linux`);
    const openssl = (await command("openssl", ["version"])).trim();
    assert.match(openssl, /^OpenSSL [\d.]+/);
    console.log(`TLS tool=${openssl.split(" ").slice(0, 2).join(" ")}; config=${config}; binding=EVALUATION_READ_DB; local-only placeholder; migrations=0001..0012`);
    stage = "certificate";
    const key = join(temporary, "server.key"), cert = join(temporary, "server.pem");
    await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert]);
    const ca = readFileSync(cert);
    assert.equal(new X509Certificate(ca).checkIP("127.0.0.1"), "127.0.0.1");
    await command("openssl", ["verify", "-CAfile", cert, "-verify_ip", "127.0.0.1", cert]);
    console.log("certificate: IP SAN 127.0.0.1 / explicit trust / hostname verification passed");
    stage = "migrations";
    mkdirSync(join(root, ".wrangler"), { recursive: true });
    mkdirSync(join(root, persist)); ownedPersist = true;
    console.log(`command: wrangler d1 migrations apply ${database} --config ${config} --local --persist-to ${persist}`);
    stage = "migration-cli";
    await command(wrangler, ["d1", "migrations", "apply", database, "--config", config, "--local", "--persist-to", persist]);
    stage = "migration-files";
    const files = sqliteFiles(join(root, persist));
    // Wrangler's local store may contain internal SQLite databases. Identify
    // the target exclusively by its D1 migration ledger, not path or order.
    const candidates = files.filter((file) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try { return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get().n === 1; }
      finally { db.close(); }
    });
    console.log(`D1 file discovery: total_sqlite=${files.length}, migrated_db_candidates=${candidates.length} (names withheld)`);
    assert.equal(candidates.length, 1, "D1 target must be the unique local database with a migration ledger");
    const inspect = () => {
      const db = new DatabaseSync(candidates[0], { readOnly: true });
      try { return checkDatabase(db, names); } finally { db.close(); }
    };
    stage = "migration-schema";
    const before = inspect();
    console.log("D1: 12 applied migrations / exact schema / empty business tables / FK+auth+12 reservation scans passed");
    stage = "listener";
    console.log(`command: wrangler dev --config ${config} --ip 127.0.0.1 --port 8788 --local-protocol https --persist-to ${persist} --https-key-path <temporary>/server.key --https-cert-path <temporary>/server.pem`);
    controller.signal.throwIfAborted();
    child = spawn(wrangler, ["dev", "--config", config, "--ip", "127.0.0.1", "--port", "8788",
      "--local-protocol", "https", "--persist-to", persist, "--https-key-path", key, "--https-cert-path", cert],
    { cwd: root, env, detached: true, stdio: "ignore" });
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 30000;
    let listeners = "";
    while (!listeners && Date.now() < deadline) {
      controller.signal.throwIfAborted();
      assert.ok(!spawnError && child.exitCode === null && child.signalCode === null);
      listeners = (await command("ss", ["-H", "-ltnp", "sport = :8788"])).trim();
      if (!listeners) await wait(100);
    }
    const lines = listeners.split("\n");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].split(/\s+/)[3], "127.0.0.1:8788");
    const pids = [...listeners.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
    assert.ok(pids.length > 0);
    for (const pid of pids) assert.equal((await command("ps", ["-o", "pgid=", "-p", pid])).trim(), String(child.pid));
    // Include inspector/internal listeners owned by this group, not just 8788.
    const allListeners = (await command("ss", ["-H", "-ltnp"])).trim().split("\n");
    for (const line of allListeners) {
      for (const match of line.matchAll(/pid=(\d+)/g)) {
        const group = (await command("ps", ["-o", "pgid=", "-p", match[1]])).trim();
        if (group === String(child.pid)) assert.match(line.split(/\s+/)[3], /^127\.0\.0\.1:\d+$/);
      }
    }
    console.log("listener: only 127.0.0.1:8788 / owned live process group verified");
    stage = "requests";
    const check = async (path, status, headers = {}, method = "GET") => {
      controller.signal.throwIfAborted();
      assert.ok(child.exitCode === null && child.signalCode === null);
      const response = await request(path, ca, headers, method);
      if (response.status !== status) console.log(`HTTP safe-status mismatch: ${method} ${path}; expected=${status}; actual=${response.status} (body withheld)`);
      checkResponse(response, status);
      if (path.endsWith("csrf")) assert.equal(response.headers["referrer-policy"], "no-referrer");
      console.log(`HTTPS ${method} ${path}: ${status} / no-store / fixed safe response (Cookie not sent)`);
    };
    for (const path of paths) await check(path, 401, { "sec-fetch-site": "same-origin" });
    await check(paths[2], 401, { origin });
    for (const headers of [{}, { origin: "https://other.test" }, { origin, "sec-fetch-site": "cross-site" }]) await check(paths[2], 403, headers);
    await check("/unknown", 503);
    for (const path of paths) await check(path, 503, {}, "POST");
    // Overriding Host can also change the client's TLS SNI/hostname check.
    // Both TLS SAN rejection and an application-level 503 are fail-closed.
    try { await check(paths[1], 503, { host: "localhost:8788" }); }
    catch (e) {
      if (e.code !== "ERR_TLS_CERT_ALTNAME_INVALID") throw e;
      console.log("Host override: rejected by strict TLS certificate hostname validation");
    }
    // HTTP on the TLS port must fail transport or be refused without a redirect.
    let plain;
    try { plain = await request(paths[1], undefined, {}, "GET", true); }
    catch (e) { assert.ok(["ECONNRESET", "EPIPE"].includes(e.code)); }
    if (plain) assert.ok(plain.status >= 400 && plain.headers.location === undefined);
    console.log("HTTP on HTTPS listener: rejected; no TLS bypass used");
    assert.equal(inspect(), before);
    console.log("D1: unchanged schema/history / all business tables still empty; no seed");
    controller.signal.throwIfAborted();
  } catch {
    throw new Error(`LOCAL_HTTPS_SMOKE_FAILED (${stage}); remaining runtime proof unverified`);
  } finally {
    let graceful = true;
    if (child?.pid) {
      try { graceful = await stopWorker(child, (file, args) => command(file, args, true)); }
      catch { safeToRemove = false; }
    }
    if (safeToRemove) {
      if (ownedPersist) rmSync(join(root, persist), { recursive: true });
      rmSync(temporary, { recursive: true });
      console.log(`cleanup: ${child?.pid ? "owned process stopped / port closed" : "no Worker started"} / owned persistence and temporary certificate removed; no bundle created`);
    } else console.log("cleanup: process/port state unknown; dedicated files retained for operator inspection (no retry)");
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    assert.ok(safeToRemove && graceful, "LOCAL_HTTPS_SMOKE_CLEANUP_FAILED; do not retry");
  }
  console.log("#904 local runtime partial proof passed; default isolation requires the existing integration tests; Browser/Session 200/Gate A-D unverified");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--run") {
    console.error("Opt-in only: node tests/evaluation/local-https-smoke.mjs --run");
    process.exitCode = 1;
  } else {
    try { await run(); } catch (e) {
      // Never reflect child output, database contents, paths, certs or environment.
      console.error(e.message.startsWith("LOCAL_HTTPS_SMOKE_") ? e.message : "LOCAL_HTTPS_SMOKE_PREFLIGHT_FAILED; runtime unverified");
      process.exitCode = 1;
    }
  }
}
