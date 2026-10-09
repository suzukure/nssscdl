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
    // Exclude only the literal loopback target from catch-all DNS rejection.
    // Chromium's host-resolver-rules supports explicit EXCLUDE exceptions.
    args: ["--no-proxy-server", "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1*"],
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

// #914 only: launch() creates its profile/artifacts in the calling Node TMPDIR.
// Never infer an exact profile name or remove a wildcard set of directories.
const generatedName = /^(playwright_chromiumdev_profile-|playwright-artifacts-).+/;
const ownershipReasons = new Set(["none", "unknown", "proc-list", "proc-read", "proc-environ",
  "tracked-owner", "home-mismatch", "home-profile-main", "home-profile-child", "home-crash-db",
  "home-tracked", "home-descendant", "home-descendant-unknown",
  "home-descendant-missing-type-known", "home-descendant-missing-type-absent", "home-descendant-missing-type-unknown",
  "home-descendant-different-type-known", "home-descendant-different-type-absent", "home-descendant-different-type-unknown",
  "home-descendant-ambiguous-type-known", "home-descendant-ambiguous-type-absent", "home-descendant-ambiguous-type-unknown",
  "home-unknown", "profile-argv", "profile-location", "main-count", "profile-set",
  "profile-missing", "profile-count", "directory-read", "directory-type", "directory-owner",
  "directory-mode", "directory-path", "generated-changed", "related-process-remains"]);
class OwnershipFailure extends Error {
  constructor(reason) { super(`browser ownership: ${reason}`); this.reason = reason; }
}
function requireOwnership(condition, reason) {
  if (!condition) throw new OwnershipFailure(reason);
}
// Retain only a fixed code. Never attach raw filesystem/process errors or paths.
export function ownershipReason(error) {
  return error instanceof OwnershipFailure && ownershipReasons.has(error.reason) ? error.reason : "unknown";
}
function ownershipRead(reason, operation) {
  try { return operation(); }
  catch (error) {
    if (error instanceof OwnershipFailure) throw error;
    throw new OwnershipFailure(reason);
  }
}
export function checkOwnedDirectory(path, parent) {
  const stat = ownershipRead("directory-read", () => lstatSync(path));
  requireOwnership(stat.isDirectory(), "directory-type");
  requireOwnership(stat.uid === process.getuid(), "directory-owner");
  requireOwnership((stat.mode & 0o777) === 0o700, "directory-mode");
  requireOwnership(ownershipRead("directory-read", () => realpathSync(path)) === path, "directory-path");
  if (parent) requireOwnership(dirname(path) === parent, "directory-path");
}

export function generatedBrowserFiles(temporary) {
  checkOwnedDirectory(temporary);
  return ownershipRead("directory-read", () => readdirSync(temporary)).filter((name) => generatedName.test(name)).map((name) => {
    const path = join(temporary, name);
    checkOwnedDirectory(path, temporary);
    return path;
  });
}

// Select argv before reading environ, including run-owned crashpad and descendants.
// Remember process start identity so a reparented child cannot disappear from proof.
export function workerBrowserProcesses(home, temporary, tracked = new Map()) {
  // Diagnostic precedence only: profile > crash database > tracked identity > descendant.
  // Ambiguous argv cannot establish a role; it never falls through to a weaker basis.
  const homeMismatchReason = (row, env) => {
    if (row.profileSelected) {
      const types = row.argv.filter((arg) => arg.startsWith("--type="));
      if (row.profileArgs.length !== 1 || types.length > 1 || types[0] === "--type=") return "home-unknown";
      return types.length ? "home-profile-child" : "home-profile-main";
    }
    if (row.crashSelected) {
      return row.argv.filter((arg) => arg.startsWith("--database=")).length === 1 ? "home-crash-db" : "home-unknown";
    }
    if (row.trackedSelected) return "home-tracked";
    if (!row.selected) return "home-unknown";
    // Only refine an already selected, failing descendant. These are entry/argv
    // observations, never proof of a process role or a reason to relax ownership.
    const homes = env.filter((entry) => entry.startsWith("HOME=") || entry === "HOME");
    const homeState = homes.length === 0 ? "missing" : homes.length > 1 || homes[0] === "HOME" ? "ambiguous" :
      homes[0] !== `HOME=${home}` ? "different" : "unknown";
    if (homeState === "unknown") return "home-descendant-unknown";
    const types = row.argv.filter((arg) => arg.startsWith("--type=") || arg === "--type");
    const knownTypes = ["--type=renderer", "--type=zygote", "--type=gpu-process", "--type=utility"];
    const typeState = types.length === 0 ? "absent" : types.length === 1 && knownTypes.includes(types[0]) ? "known" : "unknown";
    return `home-descendant-${homeState}-type-${typeState}`;
  };
  const rows = [];
  for (const entry of ownershipRead("proc-list", () => readdirSync("/proc"))) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (lstatSync(`/proc/${entry}`).uid !== process.getuid()) {
        requireOwnership(!tracked.has(Number(entry)), "tracked-owner");
        continue;
      }
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const profileArgs = argv.filter((arg) => arg.startsWith("--user-data-dir="));
      const profileSelected = profileArgs.some((arg) => arg.startsWith(`--user-data-dir=${temporary}/`));
      const crashSelected = argv.some((arg) => arg.startsWith(`--database=${home}/`));
      const trackedSelected = tracked.get(Number(entry)) === fields[19];
      const selected = profileSelected || crashSelected || trackedSelected;
      rows.push({ pid: Number(entry), parent: Number(fields[1]), identity: fields[19], argv, profileArgs,
        profileSelected, crashSelected, trackedSelected, selected });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw new OwnershipFailure(ownershipReason(error) === "unknown" ? "proc-read" : ownershipReason(error));
    }
  }
  let changed;
  do {
    changed = false;
    for (const row of rows) if (!row.selected && rows.some((parent) => parent.selected && parent.pid === row.parent)) {
      row.selected = true; changed = true;
    }
  } while (changed);
  const owned = [];
  for (const row of rows.filter((row) => row.selected)) {
    try {
      const env = readFileSync(`/proc/${row.pid}/environ`, "utf8").split("\0");
      if (!env.includes(`HOME=${home}`)) throw new OwnershipFailure(homeMismatchReason(row, env));
      requireOwnership(row.profileArgs.length <= 1, "profile-argv");
      const profile = row.profileArgs[0]?.slice("--user-data-dir=".length);
      if (profile) {
        requireOwnership(dirname(profile) === temporary && /^playwright_chromiumdev_profile-.+/.test(profile.slice(temporary.length + 1)), "profile-location");
      }
      tracked.set(row.pid, row.identity);
      owned.push({ pid: row.pid, profile, main: !!profile && !row.argv.some((arg) => arg.startsWith("--type=")) });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw new OwnershipFailure(ownershipReason(error) === "unknown" ? "proc-environ" : ownershipReason(error));
    }
  }
  return owned;
}

export function checkWorkerBrowserOwnership(home, temporary, tracked) {
  const owned = workerBrowserProcesses(home, temporary, tracked);
  const main = owned.filter((entry) => entry.main);
  requireOwnership(main.length === 1, "main-count");
  const profile = main[0].profile;
  requireOwnership(owned.every((entry) => !entry.profile || entry.profile === profile), "profile-set");
  const files = generatedBrowserFiles(temporary);
  requireOwnership(files.includes(profile), "profile-missing");
  requireOwnership(files.filter((path) => path.includes("/playwright_chromiumdev_profile-")).length === 1, "profile-count");
  return { profile, files };
}

export function checkGeneratedBrowserCleanup(temporary, files) {
  assert.ok(files.every((path) => !existsSync(path)), "generated browser files remain");
  assert.equal(generatedBrowserFiles(temporary).length, 0, "untracked browser files remain");
}

export async function launchTlsBrowser(chromium, home, binary, workerHandoff, temporary) {
  if (!workerHandoff) return { context: await chromium.launchPersistentContext(join(home, "browser-profile"), launchOptions(home, binary)) };
  const { ignoreHTTPSErrors, serviceWorkers, ...options } = launchOptions(home, binary);
  // Browser launch and Context options are different public Playwright APIs.
  const browser = await chromium.launch({ ...options, env: { ...options.env, TMPDIR: temporary } });
  return { browser, createContext: () => browser.newContext({ ignoreHTTPSErrors, serviceWorkers }) };
}

const primaryStages = new Set(["none", "unknown", "entry", "seed", "seed-inspect", "tls-setup",
  "tls-preflight", "tls-cert", "tls-listener", "tls-browser-launch", "tls-browser-ownership", "tls-browser-context", "tls-browser-nss", "tls-positive", "tls-san",
  "tls-untrusted", "tls-consumer", "worker-start", "browser-read"]);
const cleanupStages = new Set(["none", "unknown", "browser-close", "browser-ownership", "browser-process",
  "proof-listener", "worker-stop", "port-close", "generated-files", "owned-inspect", "owned-remove"]);
const tlsStages = { preflight: "tls-preflight", "certificate/NSS": "tls-cert", listener: "tls-listener",
  "browser launch/HOME": "tls-browser-launch", "launch-resolved ownership": "tls-browser-ownership",
  "Browser.newContext": "tls-browser-context", "NSS candidate": "tls-browser-nss", "positive trust": "tls-positive", "SAN mismatch": "tls-san",
  "unregistered certificate": "tls-untrusted", "helper callback": "tls-consumer" };

export function recordBrowserFailure(diagnostic, stage) {
  if (diagnostic.primary === "none") diagnostic.primary = primaryStages.has(stage) && stage !== "none" ? stage : "unknown";
}

export function observeTlsDiagnostic(diagnostic, line, consumerStage) {
  const failure = /^failure: stage=([^;]+); category=(?:ERR_CERT_AUTHORITY_INVALID|ERR_CERT_COMMON_NAME_INVALID|ERR_CERT_INVALID|ERR_SSL_PROTOCOL_ERROR|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|TIMEOUT|UNCLASSIFIED); TLS proof incomplete; raw cause withheld(?:; ownership=([a-z-]+))?$/.exec(line);
  if (failure) {
    const stage = failure[1] === "helper callback" && ["worker-start", "browser-read"].includes(consumerStage)
      ? consumerStage : Object.hasOwn(tlsStages, failure[1]) ? tlsStages[failure[1]] : "unknown";
    if (diagnostic.primary === "none" && failure[2]) diagnostic.ownership = ownershipReasons.has(failure[2]) ? failure[2] : "unknown";
    recordBrowserFailure(diagnostic, stage);
  }
  const cleanup = /^cleanup failure: stage=([a-z-]+); primary=(none|failed)(?:; ownership=([a-z-]+))?$/.exec(line);
  if (cleanup && diagnostic.cleanup === "none") {
    if (cleanup[3]) diagnostic.cleanupOwnership = ownershipReasons.has(cleanup[3]) ? cleanup[3] : "unknown";
    diagnostic.cleanup = cleanupStages.has(cleanup[1]) && cleanup[1] !== "none" ? cleanup[1] : "unknown";
    if (cleanup[2] === "failed") recordBrowserFailure(diagnostic, "unknown");
  }
}

export function browserDiagnostic(diagnostic) {
  const primary = primaryStages.has(diagnostic.primary) ? diagnostic.primary : "unknown";
  const cleanup = cleanupStages.has(diagnostic.cleanup) ? diagnostic.cleanup : "unknown";
  const safeReason = (value) => ownershipReasons.has(value ?? "none") ? value ?? "none" : "unknown";
  const reasons = diagnostic.ownership !== undefined || diagnostic.cleanupOwnership !== undefined
    ? `; OWNERSHIP=${safeReason(diagnostic.ownership)}; CLEANUP_OWNERSHIP=${safeReason(diagnostic.cleanupOwnership)}` : "";
  return `TRUSTED_BROWSER_STAGE=${primary}; CLEANUP=${cleanup}${reasons}`;
}

export function parseBrowserDiagnostic(stderr) {
  if (typeof stderr !== "string") return undefined;
  const match = /^TRUSTED_BROWSER_STAGE=([a-z-]+); CLEANUP=([a-z-]+)(?:; OWNERSHIP=([a-z-]+); CLEANUP_OWNERSHIP=([a-z-]+))?\r?\n?$/.exec(stderr);
  // The match must consume everything, including extra final newlines.
  if (!match || match[0] !== stderr || !primaryStages.has(match[1]) || !cleanupStages.has(match[2]) || (match[3] && (!ownershipReasons.has(match[3]) || !ownershipReasons.has(match[4])))) return undefined;
  return browserDiagnostic({ primary: match[1], cleanup: match[2], ownership: match[3], cleanupOwnership: match[4] });
}

export async function cleanupOwned({ closeBrowser, browserStopped, closeServer, portClosed, remove, onStage = () => {} }) {
  // Any uncertainty preserves all owned files. No fallback, forced reset or retry.
  onStage("browser-close");
  await closeBrowser();
  onStage("browser-process");
  assert.ok(await browserStopped(), "browser process state unknown");
  onStage("proof-listener");
  await closeServer();
  onStage("port-close");
  assert.ok(await portClosed(), "listener state unknown");
  onStage("owned-remove");
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

// #914 opt-in seam: the proven browser/trust survives a serial listener handoff.
export async function handoffListener(close, portClosed, consume, input) {
  await close();
  assert.ok(await portClosed(), "handoff port state unknown");
  await consume(input);
}

export async function withIsolatedBrowserTls(use = async () => {}, {
  failAfterPositive = false, workerHandoff = false,
  executablePath = process.env.NSSSCDL_CHROMIUM_PATH,
  stopConsumer = async () => {}, inspectOwned = async () => {},
  signal, report = console.log,
} = {}) {
  assert.equal(process.platform, "linux");
  assert.match(process.version, /^v24\./);
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  assert.ok(!process.env.DEBUG && !process.env.PWDEBUG, "driver debug logging must be unset");
  signal?.throwIfAborted();
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
  signal?.addEventListener("abort", interrupt, { once: true });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const env = launchOptions(home, binary).env;
  let context, browser, server, launchAttempted = false, stage = "preflight", requests = 0;
  const temporary = tmpdir(), tracked = new Map();
  let generated = [], generatedProfile;
  let primaryFailed = false, cleanupStage = "unknown";
  const sockets = new Set();
  // CLI is bounded and has no inherited credentials, proxy, TLS override or user config.
  const command = async (file, args, cleanup = false) => (await exec(file, args, {
    cwd: root, env, timeout: 30000, maxBuffer: 1024 * 1024,
    ...(cleanup ? {} : { signal: controller.signal }),
  })).stdout;
  const portClosed = async () => (await command("ss", ["-H", "-ltn", "sport = :8788"], true)).trim() === "";
  let consumerStopAttempted = false;
  const closeConsumer = async () => {
    if (!workerHandoff || consumerStopAttempted) return;
    consumerStopAttempted = true; // An unknown stop is never retried.
    await stopConsumer();
  };
  const closeProof = async () => {
    if (server?.listening) await bounded(new Promise((done, reject) => {
      server.close((error) => error ? reject(error) : done());
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    }), 5000);
    assert.equal(sockets.size, 0, "proof sockets still open");
  };
  try {
    if (workerHandoff) {
      assert.equal(process.env.TMPDIR, temporary);
      assert.equal(process.env.HOME, temporary); // #906 dedicated sanitized child.
      assert.equal(generatedBrowserFiles(temporary).length, 0, "preexisting generated browser files");
    }
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
    report(`checkpoint: HEAD=${head} UTC=${new Date().toISOString()} Node=${process.version} OS=linux`);
    report(`browser=${version}; binary=${binary}; certutil(libnss3-tools)=${nssVersion}; ${openssl}`);
    report(`NSS=HOME/${db.slice(home.length + 1)}; dedicated profile; origin=${origin}; no global trust write`);
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
    report(`certificate: fingerprint256=${x509.fingerprint256}; IP SAN=127.0.0.1; nickname=${nickname}; trust=P,,; exactly one cert`);
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
    const launched = await launchTlsBrowser(chromium, home, binary, workerHandoff, temporary);
    browser = launched.browser;
    if (workerHandoff) {
      stage = "launch-resolved ownership";
      const ownership = checkWorkerBrowserOwnership(home, temporary, tracked);
      generatedProfile = ownership.profile;
      generated = ownership.files;
      stage = "Browser.newContext";
      context = await launched.createContext();
    } else {
      context = launched.context;
      assert.equal(ownedProcesses(home, profile).filter((entry) => entry.main).length, 1);
    }
    if (workerHandoff) stage = "NSS candidate";
    assert.ok(!existsSync(db === modern ? legacy : modern), "unexpected second NSS candidate");
    report("browser process: exact run HOME and dedicated profile verified via /proc");
    stage = "positive trust";
    await probe(context, origin + "/trusted", undefined, controller.signal);
    assert.ok(requests > 0);
    report("positive: browser HTTPS 200 / fixed response / TLS verification enabled");
    if (failAfterPositive) throw new Error("intentional failure");
    stage = "SAN mismatch";
    let before = requests;
    await probe(context, "https://localhost:8788/san-mismatch", "ERR_CERT_COMMON_NAME_INVALID", controller.signal);
    assert.equal(requests, before);
    report("negative: trusted certificate / wrong hostname rejected (net::ERR_CERT_COMMON_NAME_INVALID)");
    stage = "unregistered certificate";
    server.setSecureContext({ key: readFileSync(alternate.key), cert: alternate.ca });
    before = requests;
    await probe(context, origin + "/untrusted", "ERR_CERT_AUTHORITY_INVALID", controller.signal);
    assert.equal(requests, before);
    report("negative: different unregistered self-signed cert rejected (net::ERR_CERT_AUTHORITY_INVALID)");
    server.setSecureContext({ key: readFileSync(certificate.key), cert: certificate.ca });
    checkTrustListing(await command(certutil, ["-L", "-d", `sql:${db}`]));
    assert.ok(!existsSync(db === modern ? legacy : modern));
    stage = "helper callback";
    controller.signal.throwIfAborted();
    if (workerHandoff) {
      await handoffListener(closeProof, portClosed, use, {
        browser, context, origin, signal: controller.signal,
        certificate: { key: certificate.key, cert: certificate.cert, fingerprint: x509.fingerprint256 },
      });
    } else await use({ context, origin });
    controller.signal.throwIfAborted();
  } catch (error) {
    primaryFailed = true;
    // Whitelisted diagnostic categories only, never raw browser/CLI errors or paths.
    const codes = ["ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_COMMON_NAME_INVALID",
      "ERR_CERT_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_RESET", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT"];
    const category = codes.find((code) => error instanceof Error && error.message.includes(`net::${code}`)) ??
      (error instanceof Error && /Timeout|deadline/.test(error.message) ? "TIMEOUT" : "UNCLASSIFIED");
    report(`failure: stage=${stage}; category=${category}; TLS proof incomplete; raw cause withheld${workerHandoff && (error instanceof OwnershipFailure || stage === "launch-resolved ownership") ? `; ownership=${ownershipReason(error)}` : ""}`);
    throw new Error(`BROWSER_TLS_TRUST_FAILED (${stage}); runtime proof incomplete`);
  } finally {
    try {
      await cleanupOwned({
        onStage: (value) => { cleanupStage = value; },
        closeBrowser: async () => {
          if (browser) {
            // Capture children created during reads before Browser.close/reparenting.
            // Even if ownership validation fails, still attempt public API shutdown.
            let unknownReason;
            try {
              const ownership = checkWorkerBrowserOwnership(home, temporary, tracked);
              requireOwnership(ownership.profile === generatedProfile &&
                JSON.stringify(ownership.files.slice().sort()) === JSON.stringify(generated.slice().sort()), "generated-changed");
            } catch (error) { unknownReason = ownershipReason(error); }
            await bounded(browser.close(), 10000);
            cleanupStage = "browser-ownership";
            if (unknownReason) throw new OwnershipFailure(unknownReason);
          }
          else if (context) await bounded(context.close(), 10000);
        },
        browserStopped: async () => {
          // Failed launch has no API-confirmed shutdown: retain files even if /proc looks empty.
          if (launchAttempted && !(workerHandoff ? browser : context)) return false;
          const processes = () => workerHandoff ? workerBrowserProcesses(home, temporary, tracked) : ownedProcesses(home, profile);
          const deadline = Date.now() + 5000;
          while (processes().length && Date.now() < deadline) await wait(100);
          const stopped = processes().length === 0;
          if (workerHandoff) requireOwnership(stopped, "related-process-remains");
          return stopped;
        },
        closeServer: async () => {
          await closeProof(); cleanupStage = "worker-stop"; await closeConsumer();
        },
        portClosed,
        remove: async () => {
          if (workerHandoff && launchAttempted) {
            cleanupStage = "generated-files";
            assert.ok(generatedProfile, "generated profile ownership unconfirmed");
            // Browser.close() owns Playwright cleanup. Residue is an unknown result;
            // preserve HOME/DB/logs rather than guessing paths or deleting by glob.
            checkGeneratedBrowserCleanup(temporary, generated);
          }
          cleanupStage = "owned-inspect";
          await inspectOwned(home);
          cleanupStage = "owned-remove";
          rmSync(home, { recursive: true });
        },
      });
      report("cleanup: browser processes stopped / HTTPS listener and port closed / owned HOME,NSS,profile,cert,key removed");
    } catch (error) {
      // Capture the first failing cleanup operation before emergency shutdown.
      report(`cleanup failure: stage=${cleanupStage}; primary=${primaryFailed ? "failed" : "none"}${workerHandoff && error instanceof OwnershipFailure ? `; ownership=${ownershipReason(error)}` : ""}`);
      // Stop the owned server even if browser state is uncertain; never delete its files.
      if (server?.listening) { server.close(); server.closeAllConnections(); }
      for (const socket of sockets) socket.destroy();
      try { await closeConsumer(); } catch { /* preserve files; fixed error below */ }
      report("cleanup: uncertain process/port state; owned files retained for operator inspection; no retry");
      throw new Error(`BROWSER_TLS_TRUST_CLEANUP_FAILED; primary=${primaryFailed ? tlsStages[stage] ?? "unknown" : "none"}; cleanup=${cleanupStage}; preserve owned files; do not retry`);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      signal?.removeEventListener("abort", interrupt);
    }
  }
  report("#915 transport partial evidence only; formal Actions / Cookie / D1 / Gate A-D / TC full Pass not established by this log");
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
