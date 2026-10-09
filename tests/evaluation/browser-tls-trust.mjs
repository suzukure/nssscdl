// #915: opt-in transport proof only. No Cookie, Worker, D1 or product imports.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate, constants } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCertificate } from "./local-https-smoke.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const origin = "https://127.0.0.1:8788";
const body = "nssscdl browser TLS proof\n";
const nickname = "nssscdl-run-server";
const certutil = "/usr/bin/certutil";
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export function nssPath(home, version) {
  // Chromium's supplied official Linux Cert Management rule: legacy wins if present.
  assert.ok(isAbsolute(home));
  const match = /^(?:Chromium|Google Chrome) (\d+)\.\d+\.\d+\.\d+$/.exec(version);
  assert.ok(match, "ambiguous browser version");
  return join(home, Number(match[1]) >= 146 ? ".local/share/pki/nssdb" : ".pki/nssdb");
}

export function launchOptions(home, executablePath) {
  return {
    executablePath, headless: true, timeout: 30000, chromiumSandbox: true,
    ignoreHTTPSErrors: false, serviceWorkers: "block",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share") },
    args: ["--no-proxy-server", "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND"],
  };
}

export function checkTrustListing(listing) {
  const rows = listing.split("\n").filter((line) => /\S+\s+\S*,\S*,\S*\s*$/.test(line));
  assert.equal(rows.length, 1, "NSS must contain exactly one certificate");
  assert.match(rows[0], /^nssscdl-run-server\s+P,,\s*$/);
}

export function checkTlsFailure(error, code) {
  // Never log raw Playwright errors (they include call logs and paths).
  assert.ok(error instanceof Error && new RegExp(`net::${code}(?:\\s|$)`).test(error.message), "expected browser TLS rejection absent");
}

async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation deadline")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Read only /proc for this user; no environment contents are logged or returned.
// A process belongs to this run by exact HOME or profile argv.
export function ownedProcesses(home, profile) {
  const owned = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let argv, env;
    try {
      if (lstatSync(`/proc/${entry}`).uid !== process.getuid()) continue;
      // First select this run's exact browser profile using process argv.
      // Unrelated same-UID CI processes can deny /proc/<pid>/environ reads.
      argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (!argv.includes(`--user-data-dir=${profile}`)) continue;
      // Once a process matches our profile, HOME must be readable and exact.
      // Do not skip EACCES for an owned browser process.
      env = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") continue;
      throw error; // Unreadable owned process is unknown, never proof of shutdown.
    }
    const profileArg = argv.includes(`--user-data-dir=${profile}`);
    assert.ok(env.includes(`HOME=${home}`), "browser process HOME mismatch");
    owned.push({ pid: Number(entry), main: argv.includes(`--user-data-dir=${profile}`) && !argv.some((arg) => arg.startsWith("--type=")) });
  }
  return owned;
}

export async function cleanupOwned({ closeBrowser, browserStopped, closeServer, portClosed, remove }) {
  // Any uncertainty preserves all owned files. No fallback, forced reset or retry.
  await closeBrowser();
  assert.ok(await browserStopped(), "browser process state unknown");
  await closeServer();
  assert.ok(await portClosed(), "listener state unknown");
  await remove();
}

async function probe(context, url, expectedCode, signal) {
  signal.throwIfAborted();
  const page = await context.newPage();
  try {
    let response, failure;
    try { response = await page.goto(url, { waitUntil: "load", timeout: 5000 }); }
    catch (error) { failure = error; }
    if (expectedCode) checkTlsFailure(failure, expectedCode);
    else {
      assert.equal(failure, undefined);
      assert.equal(response?.status(), 200);
      assert.equal(response.url(), url);
      assert.equal(await response.text(), body);
    }
    signal.throwIfAborted();
  } finally { await bounded(page.close(), 5000); }
}

// Minimal future helper: callback lifetime is inside the proven owned context.
// The #914 consumer is deliberately not connected here.
export async function withIsolatedBrowserTls(use = async () => {}, { failAfterPositive = false } = {}) {
  assert.equal(process.platform, "linux");
  assert.match(process.version, /^v24\./);
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  assert.ok(!process.env.DEBUG && !process.env.PWDEBUG, "driver debug logging must be unset");
  const executablePath = process.env.NSSSCDL_CHROMIUM_PATH;
  assert.ok(executablePath && isAbsolute(executablePath), "explicit browser binary required");
  assert.ok(lstatSync(executablePath).isFile() || lstatSync(executablePath).isSymbolicLink());
  const binary = realpathSync(executablePath);
  const driverPackage = JSON.parse(readFileSync(join(root, "node_modules/playwright-core/package.json"), "utf8"));
  assert.equal(driverPackage.version, "1.64.0");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["playwright-core"], "1.64.0");
  const { chromium } = await import("playwright-core");
  const home = mkdtempSync(join(tmpdir(), "nssscdl-browser-tls-"));
  assert.equal(lstatSync(home).uid, process.getuid());
  assert.equal(lstatSync(home).mode & 0o777, 0o700);
  const profile = join(home, "browser-profile");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const env = launchOptions(home, binary).env;
  let context, server, launchAttempted = false, stage = "preflight", requests = 0;
  const sockets = new Set();
  // CLI is bounded and has no inherited credentials, proxy, TLS override or user config.
  const command = async (file, args, cleanup = false) => (await exec(file, args, {
    cwd: root, env, timeout: 30000, maxBuffer: 1024 * 1024,
    ...(cleanup ? {} : { signal: controller.signal }),
  })).stdout;
  const portClosed = async () => (await command("ss", ["-H", "-ltn", "sport = :8788"], true)).trim() === "";
  try {
    assert.ok(await portClosed(), "port already occupied; stop without retry");
    const version = (await command(binary, ["--version"])).trim();
    const db = nssPath(home, version);
    const legacy = join(home, ".pki/nssdb"), modern = join(home, ".local/share/pki/nssdb");
    assert.ok(!existsSync(legacy) && !existsSync(modern));
    // Debian/Ubuntu runner: record the package version for the actual NSS tool.
    assert.match(await command("dpkg-query", ["-S", certutil]), /^libnss3-tools:/);
    const nssVersion = (await command("dpkg-query", ["-W", "-f=${Version}", "libnss3-tools"])).trim();
    assert.match(nssVersion, /^[\w.+:~\-]+$/);
    const openssl = (await command("openssl", ["version"])).trim().split(" ").slice(0, 2).join(" ");
    assert.match(openssl, /^OpenSSL [\d.]+/);
    const head = (await command("git", ["rev-parse", "HEAD"])).trim();
    assert.match(head, /^[a-f0-9]{40}$/);
    console.log(`checkpoint: HEAD=${head} UTC=${new Date().toISOString()} Node=${process.version} OS=linux`);
    console.log(`browser=${version}; binary=${binary}; certutil(libnss3-tools)=${nssVersion}; ${openssl}`);
    console.log(`NSS=HOME/${db.slice(home.length + 1)}; dedicated profile; origin=${origin}; no global trust write`);
    stage = "certificate/NSS";
    const certificate = await createCertificate(home, command);
    const alternateDirectory = join(home, "untrusted");
    mkdirSync(alternateDirectory);
    const alternate = await createCertificate(alternateDirectory, command);
    const x509 = new X509Certificate(certificate.ca);
    assert.notEqual(x509.fingerprint256, new X509Certificate(alternate.ca).fingerprint256);
    assert.equal(x509.checkHost("localhost"), undefined);
    mkdirSync(db, { recursive: true });
    assert.ok(realpathSync(db).startsWith(realpathSync(home) + "/"));
    await command(certutil, ["-N", "--empty-password", "-d", `sql:${db}`]);
    await command(certutil, ["-A", "-d", `sql:${db}`, "-n", nickname, "-t", "P,,", "-i", certificate.cert]);
    checkTrustListing(await command(certutil, ["-L", "-d", `sql:${db}`]));
    const exported = await command(certutil, ["-L", "-d", `sql:${db}`, "-n", nickname, "-a"]);
    assert.equal(new X509Certificate(exported).fingerprint256, x509.fingerprint256);
    console.log(`certificate: fingerprint256=${x509.fingerprint256}; IP SAN=127.0.0.1; nickname=${nickname}; trust=P,,; exactly one cert`);
    stage = "listener";
    server = createServer({ key: readFileSync(certificate.key), cert: certificate.ca,
      secureOptions: constants.SSL_OP_NO_TICKET }, (_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", connection: "close" });
      response.end(body);
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.on("tlsClientError", () => {}); // Expected negative probes; never reflect raw TLS output.
    await bounded(new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(8788, "127.0.0.1", done);
    }), 5000);
    assert.equal(server.address().address, "127.0.0.1");
    assert.equal(server.address().port, 8788);
    const listeners = (await command("ss", ["-H", "-ltnp", "sport = :8788"])).trim().split("\n");
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].split(/\s+/)[3], "127.0.0.1:8788");
    assert.ok(listeners[0].includes(`pid=${process.pid},`));
    stage = "browser launch/HOME";
    launchAttempted = true;
    context = await chromium.launchPersistentContext(profile, launchOptions(home, binary));
    assert.equal(ownedProcesses(home, profile).filter((entry) => entry.main).length, 1);
    assert.ok(!existsSync(db === modern ? legacy : modern), "unexpected second NSS candidate");
    console.log("browser process: exact run HOME and dedicated profile verified via /proc");
    stage = "positive trust";
    await probe(context, origin + "/trusted", undefined, controller.signal);
    assert.ok(requests > 0);
    console.log("positive: browser HTTPS 200 / fixed response / TLS verification enabled");
    if (failAfterPositive) throw new Error("intentional failure");
    stage = "SAN mismatch";
    let before = requests;
    await probe(context, "https://localhost:8788/san-mismatch", "ERR_CERT_COMMON_NAME_INVALID", controller.signal);
    assert.equal(requests, before);
    console.log("negative: trusted certificate / wrong hostname rejected (net::ERR_CERT_COMMON_NAME_INVALID)");
    stage = "unregistered certificate";
    server.setSecureContext({ key: readFileSync(alternate.key), cert: alternate.ca });
    before = requests;
    await probe(context, origin + "/untrusted", "ERR_CERT_AUTHORITY_INVALID", controller.signal);
    assert.equal(requests, before);
    console.log("negative: different unregistered self-signed cert rejected (net::ERR_CERT_AUTHORITY_INVALID)");
    server.setSecureContext({ key: readFileSync(certificate.key), cert: certificate.ca });
    checkTrustListing(await command(certutil, ["-L", "-d", `sql:${db}`]));
    assert.ok(!existsSync(db === modern ? legacy : modern));
    stage = "helper callback";
    controller.signal.throwIfAborted();
    await use({ context, origin });
    controller.signal.throwIfAborted();
  } catch (error) {
    // Whitelisted diagnostic categories only, never raw browser/CLI errors or paths.
    const codes = ["ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_COMMON_NAME_INVALID",
      "ERR_CERT_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_RESET", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT"];
    const category = codes.find((code) => error instanceof Error && error.message.includes(`net::${code}`)) ??
      (error instanceof Error && /Timeout|deadline/.test(error.message) ? "TIMEOUT" : "UNCLASSIFIED");
    console.log(`failure: stage=${stage}; category=${category}; TLS proof incomplete; raw cause withheld`);
    throw new Error(`BROWSER_TLS_TRUST_FAILED (${stage}); runtime proof incomplete`);
  } finally {
    try {
      await cleanupOwned({
        closeBrowser: async () => { if (context) await bounded(context.close(), 10000); },
        browserStopped: async () => {
          // Failed launch has no API-confirmed shutdown: retain files even if /proc looks empty.
          if (launchAttempted && !context) return false;
          const deadline = Date.now() + 5000;
          while (ownedProcesses(home, profile).length && Date.now() < deadline) await wait(100);
          return ownedProcesses(home, profile).length === 0;
        },
        closeServer: async () => {
          if (server?.listening) await bounded(new Promise((done, reject) => {
            server.close((error) => error ? reject(error) : done());
            server.closeAllConnections();
            for (const socket of sockets) socket.destroy();
          }), 5000);
        },
        portClosed,
        remove: async () => { rmSync(home, { recursive: true }); },
      });
      console.log("cleanup: browser processes stopped / HTTPS listener and port closed / owned HOME,NSS,profile,cert,key removed");
    } catch {
      // Stop the owned server even if browser state is uncertain; never delete its files.
      if (server?.listening) { server.close(); server.closeAllConnections(); }
      for (const socket of sockets) socket.destroy();
      console.log("cleanup: uncertain process/port state; owned files retained for operator inspection; no retry");
      throw new Error("BROWSER_TLS_TRUST_CLEANUP_FAILED; preserve owned files; do not retry");
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
  console.log("#915 transport partial evidence only; formal Actions / Cookie / D1 / Gate A-D / TC full Pass not established by this log");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!(args.length === 1 && args[0] === "--run") &&
      !(args.length === 2 && args[0] === "--run" && args[1] === "--fail-after-positive")) {
    console.error("Opt-in only: NSSSCDL_CHROMIUM_PATH=<installed binary> node tests/evaluation/browser-tls-trust.mjs --run [--fail-after-positive]");
    process.exitCode = 1;
  } else {
    try { await withIsolatedBrowserTls(undefined, { failAfterPositive: args.length === 2 }); }
    catch (error) {
      console.error(error.message.startsWith("BROWSER_TLS_TRUST_") ? error.message : "BROWSER_TLS_TRUST_PREFLIGHT_FAILED; runtime unverified");
      process.exitCode = 1;
    }
  }
}
