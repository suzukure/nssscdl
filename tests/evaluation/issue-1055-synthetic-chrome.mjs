// #1055 synthetic investigation ONLY. Not a trusted #930 booking/Worker/D1 proof.
// Chrome is launched only via a separately approved one-shot temporary Draft PR.
// No cookies, POSTs, credentials, production service, raw diagnostic exceptions or URLs.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = "/usr/bin/google-chrome";
const path = "/api/me/schedule-months/2026-12";
const fixedBody = JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } });
const timeout = 5000;
const delay = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));
const run = (name, args) => execFileSync(name, args, { encoding: "utf8", timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] });
const version = /^Google Chrome (\d+)\.(\d+)\.(\d+)\.(\d+)\s*$/.exec(run(binary, ["--version"]));
let temporary, server, browser, clean = true, state = "setup-unavailable";
const records = [];
try {
  if (!version || process.platform !== "linux" || !/^v24\./.test(process.version)) throw Error("setup");
  temporary = mkdtempSync(join(tmpdir(), "nssscdl-1055-owned-"));
  const home = join(temporary, "home");
  mkdirSync(home, { mode: 0o700 });
  const key = join(temporary, "key.pem");
  const cert = join(temporary, "cert.pem");
  run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  const nss = join(home, Number(version[1]) >= 146 ? ".local/share/pki/nssdb" : ".pki/nssdb");
  mkdirSync(nss, { recursive: true, mode: 0o700 });
  run("/usr/bin/certutil", ["-N", "--empty-password", "-d", "sql:" + nss]);
  run("/usr/bin/certutil", ["-A", "-d", "sql:" + nss, "-t", "P,,",
    "-n", "nssscdl-1055-synthetic", "-i", cert]);

  let count = 0, wrong = 0;
  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" });
      res.end("<!doctype html><html><body>synthetic-401-test</body></html>");
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
  browser = await chromium.launch({
    executablePath: binary, headless: true, chromiumSandbox: true, timeout: 30000,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: temporary,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share") },
    args: ["--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]
  });

  async function compare(arm) {
    const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
    let terminal = "unobserved", responseCount = 0;
    try {
      const page = await context.newPage();
      const target = origin + path;
      const matches = request => request.method() === "GET" && request.url() === target;
      page.on("requestfinished", request => {
        if (matches(request)) terminal = terminal === "unobserved" ? "finished" : "ambiguous";
      });
      page.on("requestfailed", request => {
        if (matches(request)) terminal = terminal === "unobserved" ? "failed" : "ambiguous";
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
      await delay(100);
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
      try { await context.close(); } catch { clean = false; }
    }
  }
  records.push(await compare("baseline"));
  records.push(await compare("treatment"));
  if (count !== 2 || wrong !== 0 || records.some(r => r.jar !== "empty" || r.response !== "401"))
    state = "unproved";
  else state = "observed";
} catch {
  state = "setup-unavailable";
} finally {
  if (browser) {
    try { await browser.close(); } catch { clean = false; }
  }
  if (server) {
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
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
      if (clean) rmSync(temporary, { recursive: true, force: false });
    } catch { clean = false; }
  }
  for (const r of records) {
    console.log("H9_SYNTHETIC arm=" + r.arm + "; response=" + r.response +
      "; page=" + r.page + "; request=" + r.request + "; host_body=" + r.body +
      "; drain=" + r.drain + "; cookie_jar=" + r.jar);
  }
  console.log("H9_SYNTHETIC_TERMINAL state=" + state + "; cleanup=" + (clean ? "confirmed" : "unknown") +
    "; chrome=" + (version ? version.slice(1).join(".") : "unknown") + "; formal_proof=unproved");
  if (!clean || state !== "observed") process.exitCode = 1;
}
