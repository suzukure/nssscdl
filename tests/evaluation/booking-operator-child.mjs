// Private user-unit endpoint. No startup on import; no HTTP identity endpoint.
import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { X509Certificate, constants } from "node:crypto";
import { readFileSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { root } from "./trusted-evaluation-seed.mjs";
import { createCertificate } from "./local-https-smoke.mjs";
import { launchOptions, nssPath, checkTrustListing, checkTlsFailure, ownedProcesses,
  generatedBrowserFiles, checkGeneratedBrowserCleanup } from "./browser-tls-trust.mjs";
import { checkOwnedDirectory } from "./browser-tls-trust.mjs";
import { directoryIdentity, checkBookingEnvironment, proxyOptions } from "./trusted-booking-seed.mjs";
import { createOperatorWorker } from "./booking-operator-worker.mjs";
import { observeHumanBrowser } from "./booking-operator-browser.mjs";
import { budget, demand, bounded, fail, userGroup, procIdentity, sameProcess, guiEnvironment } from "./booking-operator-unit.mjs";
const exec = promisify(execFile), tlsOrigin = "https://127.0.0.1:8788";
const body = "nssscdl browser TLS proof\n";

export async function runOperatorChild(name, gui) {
  process.umask(0o077);
  const home = join(process.env.TMPDIR, "browser-home"), temporary = process.env.TMPDIR;
  const group = userGroup(process.getuid(), name);
  demand(readFileSync("/proc/self/cgroup", "utf8") === `0::${group}\n`);
  checkBookingEnvironment(process.env, JSON.parse(readFileSync(proxyOptions.configPath, "utf8")), []);
  checkOwnedDirectory(home, temporary); const homeIdentity = directoryIdentity(home);
  gui = guiEnvironment(gui);
  const own = procIdentity(process.pid, group);
  process.stdout.write(JSON.stringify({ status: "started", pid: own.pid, start: own.start }) + "\n");
  const command = async (file, args) => (await exec(file, args, { cwd: root, env: process.env, timeout: 30000, maxBuffer: 1048576 })).stdout;
  const closed = async () => { for (const port of [8788, 8789]) demand((await command("ss", ["-H", "-ltn", `sport = :${port}`])).trim() === ""); };
  let browser, server, worker, observer, workerStarted = false, workerStop = false, browserClose = false, proofClose = false;
  let failed = false, stopReason, resolveStop, packet;
  const stop = reason => { stopReason ??= reason; resolveStop?.(); };
  const controllerStop = new Promise(done => { resolveStop = done; });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let receive;
  const initial = new Promise(done => { receive = done; });
  lines.on("line", line => {
    try {
      demand(line.length <= 1024);
      if (!packet) {
        const value = JSON.parse(line);
        demand(Object.keys(value).sort().join(",") === "cookie,month" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) &&
          /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.cookie));
        packet = value; receive();
      } else { demand(line === "操作終了"); stop("explicit"); }
    } catch { failed = true; stop("unknown"); receive(); }
  });
  lines.on("close", () => stop("parent-lost"));
  const interrupt = () => stop("abort"); process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const preparation = setTimeout(() => { failed = true; stop("prepare-timeout"); }, budget.prepare);
  let interactionTimer, terminal;
  const browserOwnership = () => {
    const files = generatedBrowserFiles(temporary), profiles = files.filter(p => /\/playwright_chromiumdev_profile-/.test(p));
    demand(profiles.length === 1);
    const mains = ownedProcesses(home, profiles[0]).filter(p => p.main); demand(mains.length === 1);
    const identity = procIdentity(mains[0].pid, group);
    const status = readFileSync(`/proc/${identity.pid}/status`, "utf8"), argv = readFileSync(`/proc/${identity.pid}/cmdline`, "utf8");
    demand(/^NoNewPrivs:\s*1$/m.test(status) && !/(--no-sandbox|--disable-setuid-sandbox|--ignore-certificate-errors)(=|\x00)/.test(argv));
    return { identity, files };
  };
  let attested;
  const closeBrowser = async () => {
    if (!browser || browserClose) return;
    browserClose = true;
    const current = browserOwnership(); sameProcess(attested.identity, current.identity);
    demand(JSON.stringify(attested.files) === JSON.stringify(current.files));
    await bounded(() => browser.close(), 10000); checkGeneratedBrowserCleanup(temporary, attested.files);
    browser = undefined; attested = undefined;
  };
  const closeProof = async () => {
    if (!server || proofClose) return;
    proofClose = true;
    await bounded(() => new Promise((done, reject) => { server.close(e => e ? reject(fail()) : done()); server.closeAllConnections(); }), 5000);
    demand((await command("ss", ["-H", "-ltn", "sport = :8788"])).trim() === "");
  };
  const stopWorker = async () => {
    if (!workerStarted || workerStop) return;
    workerStop = true; const result = await worker.stop(); demand(result.stopped && result.portClosed);
  };
  try {
    await bounded(() => initial, 30000); demand(packet && !failed && !stopReason); await closed();
    const certificate = await createCertificate(home, command), alternateHome = join(home, "untrusted"); mkdirSync(alternateHome, { mode: 0o700 });
    const alternate = await createCertificate(alternateHome, command), binary = realpathSync("/usr/bin/google-chrome");
    const version = (await command(binary, ["--version"])).trim(), db = nssPath(home, version);
    mkdirSync(db, { recursive: true, mode: 0o700 });
    await command("/usr/bin/certutil", ["-N", "--empty-password", "-d", `sql:${db}`]);
    await command("/usr/bin/certutil", ["-A", "-d", `sql:${db}`, "-n", "nssscdl-run-server", "-t", "P,,", "-i", certificate.cert]);
    checkTrustListing(await command("/usr/bin/certutil", ["-L", "-d", `sql:${db}`]));
    const exported = await command("/usr/bin/certutil", ["-L", "-d", `sql:${db}`, "-n", "nssscdl-run-server", "-a"]);
    demand(new X509Certificate(exported).fingerprint256 === new X509Certificate(certificate.ca).fingerprint256);
    let requests = 0;
    server = createServer({ key: readFileSync(certificate.key), cert: certificate.ca, secureOptions: constants.SSL_OP_NO_TICKET }, (_req, res) => {
      requests++; res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", connection: "close" }); res.end(body);
    });
    server.on("tlsClientError", () => {});
    await bounded(() => new Promise((done, reject) => { server.once("error", reject); server.listen(8788, "127.0.0.1", done); }), 5000);
    const { chromium } = await import("playwright-core");
    const { ignoreHTTPSErrors, serviceWorkers, ...options } = launchOptions(home, binary);
    browser = await chromium.launch(options); attested = browserOwnership();
    const context = await browser.newContext({ ignoreHTTPSErrors, serviceWorkers });
    const probe = async (url, code) => {
      const page = await context.newPage(); let response, error;
      try { response = await page.goto(url, { timeout: 5000, waitUntil: "load" }); } catch (e) { error = e; }
      if (code) checkTlsFailure(error, code); else demand(!error && response?.status() === 200 && await response.text() === body);
      await bounded(() => page.close(), 5000);
    };
    await probe(tlsOrigin + "/trusted"); demand(requests > 0);
    let before = requests; await probe("https://localhost:8788/san-mismatch", "ERR_CERT_COMMON_NAME_INVALID"); demand(requests === before);
    server.setSecureContext({ key: readFileSync(alternate.key), cert: alternate.ca });
    before = requests; await probe(tlsOrigin + "/untrusted", "ERR_CERT_AUTHORITY_INVALID"); demand(requests === before);
    await closeBrowser(); await closeProof(); demand(!stopReason);
    worker = createOperatorWorker({ certificate, certificateParent: home, certificateParentIdentity: homeIdentity }, name);
    workerStarted = true; await worker.start(); demand(worker.isReady());
    browserClose = false;
    browser = await chromium.launch({ ...options, headless: false, env: { ...options.env, ...gui } }); attested = browserOwnership();
    const human = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
    observer = await observeHumanBrowser(human, { cookie: () => ({ name: "__Host-student_session", value: packet.cookie,
      path: "/", secure: true, httpOnly: true, sameSite: "Lax" }) }, packet.month, () => { failed = true; stop("unknown"); });
    demand(!stopReason && !failed); clearTimeout(preparation);
    process.stdout.write(JSON.stringify({ status: "ready" }) + "\n");
    interactionTimer = setTimeout(() => stop("timeout"), budget.interaction);
    await controllerStop; clearTimeout(interactionTimer);
    observer.closeAdmission(); // Close new Browser traffic before stopping its listener.
    await stopWorker();
    demand(stopReason === "explicit" && !failed);
    const reservationId = await observer.finish();
    await closeBrowser(); await closed();
    terminal = { status: "complete", reservationId };
  } catch { failed = true; observer?.closeAdmission(); }
  finally {
    clearTimeout(preparation); clearTimeout(interactionTimer);
    // At most one attempt per owned asset; uncertainty retains everything.
    try { await stopWorker(); } catch { failed = true; }
    try { await closeBrowser(); } catch { failed = true; }
    try { await closeProof(); } catch { failed = true; }
    lines.close(); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
  demand(!failed && terminal); process.stdout.write(JSON.stringify(terminal) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    demand(process.argv.length === 5 && process.argv[2] === "--unit-child" && process.platform === "linux" && /^v24\./.test(process.version));
    const [name, gui] = JSON.parse(process.argv[4]); demand(name === process.argv[3]); await runOperatorChild(name, gui);
  } catch { process.stderr.write("BOOKING_OPERATOR_CHILD_UNKNOWN; resources retained\n"); process.exitCode = 1; }
}
