// Supplementary finite fixtures: these do not prove Wrangler runtime reachability.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { checkDatabase, checkResponse, migrations, request, stopWorker } from "./local-https-smoke.mjs";

const exec = promisify(execFile);
const names = migrations();
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of names) db.exec(readFileSync(`migrations/${name}`, "utf8"));
  // Wrangler history shape is unverified here; only its required names are modeled.
  db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  for (const name of names) db.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
  return db;
}

test("#904 local migration fixture: 12 authoritative DDLs and all existing scans; no mutation", () => {
  const db = fixture();
  try {
    const first = checkDatabase(db, names);
    assert.equal(checkDatabase(db, names), first);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM students").get().n, 0);
  } finally { db.close(); }
});

test("#904 refuses nonempty data, unknown schema, changed constraints and incomplete migration history", () => {
  for (const query of [
    "INSERT INTO students VALUES ('fixture','active',NULL)",
    "CREATE TABLE unexpected (id TEXT)",
    "DROP TABLE command_guards; CREATE TABLE command_guards (id TEXT PRIMARY KEY, captured_at INTEGER NOT NULL, expected_read_set TEXT NOT NULL, ok INTEGER NOT NULL)",
    "DELETE FROM d1_migrations WHERE name='0012_reservation_indexes.sql'",
  ]) {
    const db = fixture();
    try { db.exec(query); assert.throws(() => checkDatabase(db, names)); }
    finally { db.close(); }
  }
});

test("#904 safe wire expectations come from Application errors; secret/extra fields and issuing Cookies fail", () => {
  const response = { status: 503, headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE",
      message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later" } }) };
  checkResponse(response, 503);
  for (const changed of [
    { ...response, status: 200 },
    { ...response, headers: { ...response.headers, "cache-control": "public" } },
    { ...response, headers: { ...response.headers, "set-cookie": ["fixture=unexpected"] } },
    { ...response, headers: { ...response.headers, "access-control-allow-origin": "*" } },
    { ...response, body: JSON.stringify({ error: JSON.parse(response.body).error, diagnostic: "fixture-private" }) },
  ]) assert.throws(() => checkResponse(changed, 503));
});

test("#904 stop fixture: SIGINT ends the owned foreground process group and confirms port closed", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
  assert.equal(await stopWorker(child, async (file, args) => (await exec(file, args)).stdout), true);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
});

test("#904 stop fixture: an occupied port prevents declaring cleanup safe", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
  await assert.rejects(stopWorker(child, async () => "LISTEN fixture-port-still-open"), /listener still open/);
});

test("#904 runner is opt-in; no arguments starts no listener", async () => {
  await assert.rejects(exec(process.execPath, ["tests/evaluation/local-https-smoke.mjs"]),
    (e) => e.code === 1);
  assert.equal((await exec("ss", ["-H", "-ltn", "sport = :8788"])).stdout.trim(), "");
});

test("#904 supplementary TLS fixture: explicit trust succeeds, absent trust and wrong IP SAN fail", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-tls-fixture-"));
  let server;
  try {
    for (const ip of ["127.0.0.1", "127.0.0.2"]) {
      const key = join(temporary, `${ip}.key`), cert = join(temporary, `${ip}.pem`);
      await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
        "-subj", `/CN=${ip}`, "-addext", `subjectAltName=IP:${ip}`, "-keyout", key, "-out", cert]);
      server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_input, response) => {
        response.writeHead(503, { "cache-control": "no-store", "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE",
          message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later" } }));
      });
      await new Promise((done, reject) => { server.once("error", reject); server.listen(8788, "127.0.0.1", done); });
      if (ip === "127.0.0.1") {
        checkResponse(await request("/fixture", readFileSync(cert)), 503);
        await assert.rejects(request("/fixture", undefined), (e) => e.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
      } else await assert.rejects(request("/fixture", readFileSync(cert)), (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID");
      await new Promise((done) => server.close(done));
      server = undefined;
    }
  } finally {
    if (server) await new Promise((done) => server.close(done));
    rmSync(temporary, { recursive: true });
  }
});
