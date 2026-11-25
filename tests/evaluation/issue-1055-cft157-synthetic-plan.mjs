// #1055 synthetic investigation ONLY. Not a trusted #930 booking/Worker/D1 proof.
// Chrome is launched only via a separately approved one-shot temporary Draft PR.
// No cookies, POSTs, credentials, production service, raw diagnostic exceptions or URLs.
// Import Playwright only after Node parent TMPDIR is owned; chromium.ts caches an artifact path at import time.
import { execFileSync, spawnSync } from "node:child_process";
import { classifyVersion } from "./issue-1055-cft157-admission.mjs";
import { classifyThreeArm, createTerminalObserver, boundedSettlement } from "./issue-1055-cft157-lifecycle.mjs";
import { STAGE3_HANDOFF, classifyStage3Owner } from "./issue-1066-stage3-handoff.mjs";
import { createServer } from "node:https";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env[STAGE3_HANDOFF.requiredEnv[2]] || "/bin/false";
const path = "/api/me/schedule-months/2026-12";
const fixedBody = JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } });
const timeout = 5000;
const delay = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));
const run = (name, args) => execFileSync(name, args, { encoding: "utf8", timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] });
let version = null;
let stage = "binary";
const previousTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
let temporary, server, browser, clean = true, state = "setup-unavailable";
const records = [];
let count = 0, wrong = 0;
let parentTmpOwned = false, childTmpOwned = false, profileGone = false;
try {
  if (process.platform !== "linux" || !/^v24\./.test(process.version)) throw Error("setup");
  // Version subprocess failure is inside try/finally; never prints its raw output.
  stage = "version";
  let attempt;
  try {
    attempt = spawnSync(binary, ["--version"], {
      timeout: 8000, maxBuffer: 4096, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
  } catch { attempt = { status: null, stdout: "", error: true }; }
  if (classifyVersion({
    exitCode: attempt?.status ?? null, stdout: attempt?.stdout ?? "",
    failure: Boolean(attempt?.error || attempt?.signal),
  }) !== "version-confirmed") throw Error("setup");
  version = [null, "157", "0", "8092", "0"];
  // Only create a child of the job's private, explicitly owned runner root.
  const parent = process.env[STAGE3_HANDOFF.requiredEnv[1]];
  const runner = process.env[STAGE3_HANDOFF.requiredEnv[0]];
  let admitted = false;
  try {
    const info = parent && lstatSync(parent);
    admitted = classifyStage3Owner({
      runnerTemp: runner, ownedRoot: parent, chromeExecutable: binary,
      rootCanonical: Boolean(parent && realpathSync(parent) === parent),
      rootDirectory: Boolean(info && info.isDirectory() && !info.isSymbolicLink()),
      rootOwned: Boolean(info && info.uid === process.getuid()),
      rootPrivate: Boolean(info && (info.mode & 0o077) === 0),
    }) === "owner-admitted";
  } catch { admitted = false; }
  if (!admitted) throw Error("owner");
  temporary = mkdtempSync(join(parent, "synthetic-owned-"));
  // Playwright's profile/artifact mkdtemp runs in the PARENT Node process.
  // The child's env.TMPDIR alone is insufficient to own these resources.
  process.env.TMPDIR = temporary;
  process.env.TMP = temporary;
  process.env.TEMP = temporary;
  parentTmpOwned = process.env.TMPDIR === temporary && tmpdir() === temporary;
  const home = join(temporary, "home");
  mkdirSync(home, { mode: 0o700 });
  const key = join(temporary, "key.pem");
  const cert = join(temporary, "cert.pem");
  stage = "tls-setup";
  run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  const nss = join(home, Number(version[1]) >= 146 ? ".local/share/pki/nssdb" : ".pki/nssdb");
  mkdirSync(nss, { recursive: true, mode: 0o700 });
  run("/usr/bin/certutil", ["-N", "--empty-password", "-d", "sql:" + nss]);
  run("/usr/bin/certutil", ["-A", "-d", "sql:" + nss, "-t", "P,,",
    "-n", "nssscdl-1055-synthetic", "-i", cert]);

  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" });
      res.end("<!doctype html><html><head><link rel=\"icon\" href=\"data:,\"></head><body>synthetic-401-test</body></html>");
      return;
    }
    if (req.method !== "GET" || req.url !== path || req.headers.cookie !== undefined ||
        req.headers.authorization !== undefined) {
      wrong++;
      res.writeHead(405, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    count++;
    const first = fixedBody.slice(0, 18), rest = fixedBody.slice(18);
    res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(fixedBody),
      "Set-Cookie": "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT" });
    res.write(first);
    setTimeout(() => res.end(rest), 25);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("setup");
  const origin = "https://127.0.0.1:" + address.port;
  stage = "browser-launch";
  const { chromium } = await import("playwright-core");
  childTmpOwned = temporary.length > 0 && parentTmpOwned;
  browser = await chromium.launch({
    executablePath: binary, headless: true, chromiumSandbox: true, timeout: 30000,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: temporary,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share") },
    args: ["--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]
  });

  stage = "network";
  async function compare(arm) {
    const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
    const terminals = createTerminalObserver({ timeoutMs: 1500 });
    let responseCount = 0;
    try {
      const page = await context.newPage();
      const target = origin + path;
      const matches = request => request.method() === "GET" && request.url() === target;
      page.on("requestfinished", request => {
        if (matches(request)) terminals.record(request, "finished");
      });
      page.on("requestfailed", request => {
        if (matches(request)) terminals.record(request, "failed");
      });
      await page.goto(origin + "/", { waitUntil: "load", timeout });
      const waitResponse = page.waitForResponse(response => matches(response.request()), { timeout });
      const requestPage = page.evaluate(async input => {
        window.__h9DrainState = "not-applicable";
        const response = await fetch(input.path, {
          method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error",
          headers: { Accept: "application/json" }
        });
        if (response.status !== 401) return "other-status";
        // Status is acted on immediately; no body read can delay this stop.
        window.__h9Stopped = true;
        if (input.arm === "native") {
          window.__h9DrainState = "running";
          // Like manual drain, native parsing must not delay status/auth stop.
          void response.json().then(
            body => { window.__h9DrainState = body?.error?.code === "UNAUTHENTICATED" ? "eof" : "unavailable"; },
            () => { window.__h9DrainState = "unavailable"; }
          );
        }
        if (input.arm === "treatment") {
          window.__h9DrainState = "running";
          const readBody = async () => {
            if (!response.body) return "absent";
            let reader;
            try { reader = response.body.getReader(); }
            catch { return "unavailable"; }
            let completed = false, size = 0, timer;
            const deadline = new Promise(resolve => { timer = setTimeout(() => resolve("deadline"), 4000); });
            try {
              while (true) {
                const part = await Promise.race([reader.read(), deadline]);
                if (part === "deadline") return "deadline";
                if (part.done) { completed = true; return "eof"; }
                size += part.value.byteLength;
                if (size > 4096) return "limit";
              }
            } catch { return "unavailable"; }
            finally {
              clearTimeout(timer);
              if (!completed) void reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          };
          void readBody().then(v => { window.__h9DrainState = v; },
            () => { window.__h9DrainState = "unavailable"; });
        }
        return "stopped";
      }, { path, arm });
      const response = await waitResponse;
      responseCount++;
      const pageState = await Promise.race([requestPage.catch(() => "page-error"), delay(timeout, "page-timeout")]);
      const hostBody = await Promise.race([
        response.text().then(text => text === fixedBody ? "matched" : "mismatch", () => "error"),
        delay(timeout, "timeout")
      ]);
      const terminal = await terminals.waitFor(response.request());
      // Observe async drains to a bounded terminal state; never equate "running" with EOF.
      if (arm !== "baseline") {
        await Promise.race([
          page.waitForFunction(() => window.__h9DrainState !== "running", undefined,
            { timeout: 4500 }).catch(() => null),
          delay(4700, null),
        ]);
      }
      const candidate = await Promise.race([
        page.evaluate(() => ({ stopped: window.__h9Stopped === true, drain: window.__h9DrainState }))
          .then(value => value, () => ({ stopped: false, drain: "unknown" })),
        delay(1000, { stopped: false, drain: "unknown" })
      ]);
      const afterJar = await Promise.race([
        context.cookies().then(value => value.length === 0 ? "empty" : "nonempty", () => "unknown"),
        delay(1000, "unknown")
      ]);
      const allowedDrain = ["not-applicable", "running", "eof", "deadline", "limit", "absent", "unavailable"];
      return { arm, page: pageState === "stopped" && candidate.stopped ? "stopped" : "unproved",
        request: ["finished", "failed", "ambiguous", "unobserved"].includes(terminal) ? terminal : "ambiguous",
        body: ["matched", "mismatch", "error", "timeout"].includes(hostBody) ? hostBody : "error",
        drain: allowedDrain.includes(candidate.drain) ? candidate.drain : "unknown",
        response: response.status() === 401 && responseCount === 1 ? "401" : "unknown",
        jar: afterJar };
    } finally {
      terminals.dispose();
      if (await boundedSettlement(() => context.close(), 1500) !== "settled") clean = false;
    }
  }
  records.push(await compare("baseline"));
  records.push(await compare("treatment"));
  records.push(await compare("native"));
  if (count !== 3 || wrong !== 0 || records.some(r => r.jar !== "empty" || r.response !== "401"))
    state = "unproved";
  else state = "observed";
} catch {
  state = "setup-unavailable";
} finally {
  // Keep parent Node's TMPDIR owned until Playwright's close/disposal completes.
  if (browser) {
    if (await boundedSettlement(() => browser.close(), 2000) !== "settled") clean = false;
  }
  if (server) {
    try {
      server.closeAllConnections();
      if (server.listening && await boundedSettlement(() =>
        new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())), 1500
      ) !== "settled") clean = false;
      if (server.listening) clean = false;
    } catch { clean = false; }
  }
  if (temporary) {
    try {
      if (realpathSync(temporary) !== temporary || lstatSync(temporary).uid !== process.getuid()) clean = false;
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const cmdline = readFileSync("/proc/" + name + "/cmdline", "utf8");
          if (cmdline.includes("--user-data-dir=" + temporary + "/")) clean = false;
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ESRCH" && error.code !== "EACCES") clean = false;
        }
      }
      profileGone = !readdirSync(temporary).some(entry => entry.startsWith("playwright_") ||
          entry.startsWith("playwright-artifacts-"));
      if (!profileGone || !parentTmpOwned || (browser && !childTmpOwned)) clean = false;
      if (clean) rmSync(temporary, { recursive: true, force: false });
    } catch { clean = false; }
  }
  // Restore the caller's Node environment AFTER managed browser resources close.
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    if (previousTmp[key] === undefined) delete process.env[key];
    else process.env[key] = previousTmp[key];
  }
  for (const r of records) {
    console.log("H9_SYNTHETIC arm=" + r.arm + "; response=" + r.response +
      "; page=" + r.page + "; request=" + r.request + "; host_body=" + r.body +
      "; drain=" + r.drain + "; cookie_jar=" + r.jar);
  }
  console.log("H9_SYNTHETIC_STAGE result=" + ([
    "binary", "version", "tls-setup", "browser-launch", "network"
  ].includes(stage) ? stage : "unknown"));
  console.log("H9_SYNTHETIC_TERMINAL state=" + state + "; expected_get=" + (count === 3 ? "yes" : "no") +
    "; unexpected_request=" + (wrong === 0 ? "absent" : "present") + "; cleanup=" + (clean ? "confirmed" : "unknown") +
    "; chrome=" + (version ? version.slice(1).join(".") : "unknown") + "; formal_proof=unproved");
  const verdict = classifyThreeArm({
    records, getCount: count, wrongCount: wrong,
    ownedClean: clean && parentTmpOwned && childTmpOwned && profileGone,
  });
  console.log("H9_SYNTHETIC_VERDICT result=" + verdict +
    "; cause=unproved; protocol=chrome157; formal_proof=unproved");
  if (state !== "observed" || !clean || verdict === "unproved" ||
      verdict === "mixed-inconclusive" || verdict === "all-unproved") process.exitCode = 1;
}
