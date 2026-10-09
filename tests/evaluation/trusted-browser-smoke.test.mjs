// Finite #914 fixtures, not real browser/Worker/D1 evidence.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { browserDiagnostic, checkGeneratedBrowserCleanup, checkOwnedDirectory, checkWorkerBrowserOwnership, cleanupOwned, generatedBrowserFiles, handoffListener, launchTlsBrowser, observeTlsDiagnostic, origin, parseBrowserDiagnostic, recordBrowserFailure, workerBrowserProcesses } from "./browser-tls-trust.mjs";
import { browserCookie, browserEvidence, browserFailureCheckpoint, browserGet, browserProofCheckpoint, checkCertificate, checkNonExposure, injectCookie, proveBrowserReads, withStoppedProxy } from "./trusted-browser-reads.mjs";
import { expectedHistory, expectedSchedule } from "./trusted-https-assertions.mjs";
import { createCertificate } from "./local-https-smoke.mjs";

const cookie = (value = "A".repeat(43)) => ({ name: "__Host-student_session", value,
  path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
const fixed = (error) => error.message === "TRUSTED_HTTPS_PROOF_FAILED" && !["cause", "actual", "expected"].some((key) => key in error);

test("#914 first processing failure survives callback generalization and later cleanup failures", () => {
  for (const [helper, consumer, expected] of [
    ["browser launch/HOME", "tls-setup", "tls-browser-launch"],
    ["positive trust", "tls-setup", "tls-positive"],
    ["helper callback", "worker-start", "worker-start"],
    ["helper callback", "browser-read", "browser-read"],
    ["helper callback", "tls-setup", "tls-consumer"],
    ["unrecognized", "tls-setup", "unknown"],
  ]) {
    const diagnostic = { primary: "none", cleanup: "none" };
    observeTlsDiagnostic(diagnostic, `failure: stage=${helper}; category=UNCLASSIFIED; TLS proof incomplete; raw cause withheld`, consumer);
    observeTlsDiagnostic(diagnostic, "cleanup failure: stage=browser-close; primary=failed", consumer);
    // Emergency Worker stop failure cannot replace the first cleanup failure.
    observeTlsDiagnostic(diagnostic, "cleanup failure: stage=worker-stop; primary=failed", consumer);
    recordBrowserFailure(diagnostic, "tls-consumer");
    const output = `TRUSTED_BROWSER_STAGE=${expected}; CLEANUP=browser-close`;
    assert.equal(browserDiagnostic(diagnostic), output);
    assert.equal(parseBrowserDiagnostic(output + "\n"), output);
  }
});

test("#914 cleanup-only and unconfirmed primary are distinct; unknown values never leak", () => {
  const diagnostic = { primary: "none", cleanup: "none" };
  observeTlsDiagnostic(diagnostic, "cleanup failure: stage=owned-inspect; primary=none", "browser-read");
  assert.equal(browserDiagnostic(diagnostic), "TRUSTED_BROWSER_STAGE=none; CLEANUP=owned-inspect");
  recordBrowserFailure(diagnostic, "private-canary");
  assert.equal(browserDiagnostic(diagnostic), "TRUSTED_BROWSER_STAGE=unknown; CLEANUP=owned-inspect");
  assert.equal(browserDiagnostic({ primary: "private-canary", cleanup: "private-canary" }),
    "TRUSTED_BROWSER_STAGE=unknown; CLEANUP=unknown");
  const unobserved = { primary: "none", cleanup: "none" };
  observeTlsDiagnostic(unobserved, "cleanup failure: stage=browser-process; primary=failed", "browser-read");
  assert.equal(browserDiagnostic(unobserved), "TRUSTED_BROWSER_STAGE=unknown; CLEANUP=browser-process");
});

test("#914 actual child final reporting keeps normal/intentional failure diagnostics until final stop", async () => {
  // Execute the unchanged reporting block with isolated fake lifecycle objects;
  // no browser, Worker, seed or runtime proof is launched by this fixture.
  const source = readFileSync("tests/evaluation/trusted-https-process.mjs", "utf8");
  const tail = source.slice(source.indexOf("} catch {\n  process.exitCode = 1; // No raw cause"));
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction("fixture", `
    const { process, console, stop, diagnostic, intentionalObserved, browserCleanupConfirmed,
      browserCertificate, browserFailureCheckpoint, browserProofCheckpoint, browserDiagnostic,
      recordBrowserFailure } = fixture;
    const browserMode = true, browserStage = "browser-read", deadline = undefined, interrupt = () => {};
    try { if (fixture.failed) throw new Error("private-canary");
    ${tail}
  `);
  for (const intentional of [false, true]) {
    for (const cleanup of ["none", "browser-close"]) {
      const output = [], errors = [], fakeProcess = { removeListener() {} };
      await run({ process: fakeProcess, console: { log: (value) => output.push(value), error: (value) => errors.push(value) },
        stop: async () => {}, diagnostic: { primary: "browser-read", cleanup }, failed: true,
        intentionalObserved: intentional, browserCleanupConfirmed: cleanup === "none",
        browserCertificate: "certificate-fixture", browserFailureCheckpoint, browserProofCheckpoint,
        browserDiagnostic, recordBrowserFailure });
      assert.equal(fakeProcess.exitCode, 1);
      assert.deepEqual(output, intentional && cleanup === "none" ? ["certificate-fixture", browserFailureCheckpoint] : []);
      assert.deepEqual(errors, intentional && cleanup === "none" ? [] : [`TRUSTED_BROWSER_STAGE=browser-read; CLEANUP=${cleanup}`]);
    }
  }
  const output = [], errors = [];
  await run({ process: { removeListener() {} }, console: { log: (value) => output.push(value), error: (value) => errors.push(value) },
    stop: async () => { throw new Error("private-canary"); }, diagnostic: { primary: "none", cleanup: "none" }, failed: false,
    intentionalObserved: false, browserCleanupConfirmed: true, browserCertificate: "certificate-fixture",
    browserFailureCheckpoint, browserProofCheckpoint, browserDiagnostic, recordBrowserFailure });
  assert.deepEqual(output, []);
  assert.deepEqual(errors, ["TRUSTED_BROWSER_STAGE=none; CLEANUP=worker-stop"]);
});

test("#914 cleanup operation diagnosis preserves existing fail-closed order and call counts", async () => {
  const stages = ["browser-close", "browser-process", "proof-listener", "port-close", "owned-remove"];
  for (const failed of stages) {
    const events = [], diagnostic = { primary: "worker-start", cleanup: "none" };
    let stage = "unknown", removed = 0;
    const operation = async (name, returnsBoolean = false) => {
      events.push(name);
      if (name === failed) {
        if (returnsBoolean) return false;
        throw new Error("private-canary");
      }
      return true;
    };
    try {
      await cleanupOwned({ onStage: (value) => { stage = value; },
        closeBrowser: () => operation("browser-close"), browserStopped: () => operation("browser-process", true),
        closeServer: () => operation("proof-listener"), portClosed: () => operation("port-close", true),
        remove: async () => { await operation("owned-remove"); removed++; } });
      assert.fail("cleanup uncertainty must reject");
    } catch {
      observeTlsDiagnostic(diagnostic, `cleanup failure: stage=${stage}; primary=failed`, "worker-start");
    }
    assert.deepEqual(events, stages.slice(0, stages.indexOf(failed) + 1));
    assert.equal(removed, 0);
    assert.equal(browserDiagnostic(diagnostic), `TRUSTED_BROWSER_STAGE=worker-start; CLEANUP=${failed}`);
  }
});

test("#914 owner diagnostic parser accepts only complete fixed primary/cleanup codes", () => {
  for (const cleanup of ["none", "unknown", "browser-close", "browser-ownership", "browser-process", "proof-listener",
    "worker-stop", "port-close", "generated-files", "owned-inspect", "owned-remove"]) {
    const line = `TRUSTED_BROWSER_STAGE=browser-read; CLEANUP=${cleanup}`;
    for (const ending of ["", "\n", "\r\n"]) assert.equal(parseBrowserDiagnostic(line + ending), line);
  }
  for (const value of [undefined, {}, "", "TRUSTED_BROWSER_STAGE=tls-cleanup\n",
    "TRUSTED_BROWSER_STAGE=private-canary; CLEANUP=none\n",
    "TRUSTED_BROWSER_STAGE=browser-read; CLEANUP=private-canary\n",
    "TRUSTED_BROWSER_STAGE=browser-read; CLEANUP=none\n\n",
    "TRUSTED_BROWSER_STAGE=browser-read; CLEANUP=none\nprivate-canary\n",
    "private-canary\nTRUSTED_BROWSER_STAGE=browser-read; CLEANUP=none\n"]) {
    assert.equal(parseBrowserDiagnostic(value), undefined);
  }
});

test("#914 stopped proxy: success opens next connection; live Worker or unknown operation/dispose suppresses new connection and cleanup inspect", async () => {
  for (const live of [false, true]) {
    let calls = 0;
    const state = { stopped: () => !live, unknown: false };
    const operation = () => withStoppedProxy(state, async () => { calls++; return 7; });
    if (live) { await assert.rejects(operation(), fixed); assert.equal(calls, 0); }
    else { assert.equal(await operation(), 7); assert.equal(await operation(), 7); assert.equal(calls, 2); }
  }
  const state = { stopped: () => true, unknown: false };
  let calls = 0;
  await assert.rejects(withStoppedProxy(state, async () => { calls++; throw new Error("unknown proxy/dispose"); }));
  await assert.rejects(withStoppedProxy(state, async () => { calls++; }), fixed);
  assert.equal(calls, 1); assert.equal(state.unknown, true);
});

test("#914 same cert identity / exact IP SAN; changed fingerprint or replaced cert refuses handoff", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-browser-cert-fixture-"));
  try {
    const command = async (file, args) => (await promisify(execFile)(file, args, { env: { PATH: process.env.PATH } })).stdout;
    const issued = await createCertificate(temporary, command);
    const { X509Certificate } = await import("node:crypto");
    const certificate = { key: issued.key, cert: issued.cert, fingerprint: new X509Certificate(issued.ca).fingerprint256 };
    checkCertificate(certificate);
    assert.throws(() => checkCertificate({ ...certificate, fingerprint: "different" }), fixed);
    writeFileSync(certificate.cert, "invalid cert");
    assert.throws(() => checkCertificate(certificate));
  } finally { rmSync(temporary, { recursive: true }); }
});

test("#914 owner accepts only exact non-secret certificate and complete normal/intentional checkpoint", () => {
  const line = `certificate: SHA256=${Array(32).fill("AB").join(":")}; SAN=127.0.0.1; same Node/Worker cert`;
  assert.equal(browserEvidence(line + "\n" + browserProofCheckpoint + "\n"), line);
  assert.equal(browserEvidence(line + "\n" + browserFailureCheckpoint + "\n", true), line);
  for (const stdout of ["", line + "\n", line + "\n" + browserFailureCheckpoint + "\n",
    line + "\n" + browserProofCheckpoint + "\nprivate-canary\n", "private-canary\n" + browserProofCheckpoint + "\n"]) {
    assert.throws(() => browserEvidence(stdout), fixed);
  }
});

test("#914 serial handoff: close and closed-port proof precede same-context/cert consumer; uncertainty never calls consumer", async () => {
  for (const failure of [null, "close", "port", "consumer"]) {
    const events = [];
    const input = { browser: {}, context: {}, origin, certificate: { key: "owned/server.key", cert: "owned/server.pem" } };
    const operation = handoffListener(async () => {
      events.push("close"); if (failure === "close") throw new Error("fixture");
    }, async () => { events.push("port"); return failure !== "port"; }, async (actual) => {
      events.push("consumer"); assert.equal(actual, input);
      if (failure === "consumer") throw new Error("fixture");
    }, input);
    if (failure) await assert.rejects(operation); else await operation;
    assert.deepEqual(events, failure === "close" ? ["close"] : failure === "port" ? ["close", "port"] : ["close", "port", "consumer"]);
  }
});

test("#914 canonical Cookie url alternative and actual jar enforce host-only, root, Secure, HttpOnly, Lax, no persistence", async () => {
  const converted = browserCookie(cookie());
  assert.equal(converted.url, origin + "/");
  assert.ok(!("domain" in converted) && !("path" in converted));
  for (const change of [{ domain: "127.0.0.1" }, { path: "/api" }, { secure: false }, { httpOnly: false },
    { sameSite: "None" }, { name: "student_session" }, { value: "private-canary" }]) {
    assert.throws(() => browserCookie({ ...cookie(), ...change }), fixed);
  }
  for (const change of [null, { domain: ".127.0.0.1" }, { path: "/api" }, { secure: false },
    { httpOnly: false }, { sameSite: "None" }, { expires: 123 }]) {
    let calls = 0;
    const context = { cookies: async (url) => url ? [{ ...cookie(), domain: "127.0.0.1", expires: -1, ...change }] : [],
      addCookies: async (cookies) => { calls++; assert.deepEqual(cookies, [converted]); } };
    if (change) await assert.rejects(injectCookie(context, cookie()), fixed);
    else await injectCookie(context, cookie());
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(injectCookie({ cookies: async () => [cookie()], addCookies: async () => { calls++; } }, cookie()), fixed);
  assert.equal(calls, 0);
});

test("#914 response secrets reject safely, without assertion diffs", () => {
  checkNonExposure({ headers: {}, body: '{"csrfToken":"csrf-canary"}' }, ["session-canary"], ["hash-canary"], ["csrf-canary"]);
  for (const response of [
    { headers: { leak: "session-canary" }, body: "{}" }, { headers: { leak: "csrf-canary" }, body: "{}" },
    { headers: {}, body: "hash-canary" }, { headers: {}, body: "session-canary" },
  ]) assert.throws(() => checkNonExposure(response, ["session-canary"], ["hash-canary"], ["csrf-canary"]), fixed);
});

function readFixture() {
  const events = [];
  const seed = { date: "2026-11-15", month: "2026-11", sessions: {
    self: { cookie: () => cookie() }, other: { cookie: () => cookie("B".repeat(42) + "A") },
  } };
  let live = false, revoked = false, created = 0;
  const clear = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  const wire = (owner, path) => {
    const csrf = path.endsWith("csrf");
    const status = owner === "missing" || owner === "foreign" || (owner === "self" && revoked) ? 401 : 200;
    const body = status === 401 ? { error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } } :
      csrf ? { scope: "session", csrfToken: createHash("sha256").update("student-csrf-v1:" + seed.sessions[owner].cookie().value).digest("base64url") } :
        path.endsWith("reservations") ? expectedHistory(seed, owner) : expectedSchedule(seed, owner);
    return { status, body: JSON.stringify(body), headers: { "cache-control": "no-store", "content-type": "application/json",
      ...(csrf ? { "referrer-policy": "no-referrer" } : {}), ...(status === 401 ? { "set-cookie": clear } : {}) } };
  };
  const browser = { newContext: async (options) => {
    assert.deepEqual(options, { ignoreHTTPSErrors: false, serviceWorkers: "block" });
    const owner = ["self", "other", "missing", "foreign"][created++];
    let jar = [];
    return { cookies: async () => jar, addCookies: async ([value]) => {
      events.push(`cookie:${owner}`); jar = [{ ...value, domain: "127.0.0.1", path: "/", expires: -1 }];
    }, newPage: async () => {
      const page = { url: () => origin + "/unknown",
        goto: async (url) => ({ url: () => url, status: () => 503,
          allHeaders: async () => ({ "cache-control": "no-store", "content-type": "application/json" }),
          text: async () => JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later" } }) }),
        evaluate: async (_fn, path) => {
          if (!path) return "";
          assert.ok(live); events.push(`get:${owner}`);
          const result = wire(owner, path); if (result.status === 401) jar = [];
          return { status: result.status, body: result.body };
        }, waitForResponse: async (predicate) => {
          // Predicate captures only one of the three approved paths.
          for (const path of [`/api/me/schedule-months/${seed.month}`, "/api/me/reservations", "/api/auth/student/csrf"]) {
            const response = { url: () => origin + path, request: () => ({ method: () => "GET", redirectedFrom: () => null,
              allHeaders: async () => ({ "sec-fetch-site": "same-origin" }) }),
              status: () => wire(owner, path).status, allHeaders: async () => wire(owner, path).headers };
            if (predicate(response)) return response;
          }
          throw new Error("fixture path mismatch");
        } };
      return page;
    } };
  } };
  const input = { browser, context: { browser: () => { throw new Error("Context.browser must not supply the handle"); } }, seed, signal: new AbortController().signal,
    secrets: [cookie().value, seed.sessions.other.cookie().value], hashes: [],
    start: async () => { assert.ok(!live); events.push("start"); live = true; },
    stop: async () => { assert.ok(live); events.push("stop"); live = false; },
    inspect: async () => { assert.ok(!live); events.push("inspect"); },
    revoke: async () => { assert.ok(!live && !revoked); events.push("revoke"); revoked = true; } };
  return { input, events, count: () => created };
}

test("#914 four ephemeral contexts: browser 3 GET per owner, no Worker/proxy overlap, self-only revocation before restart", async () => {
  const { input, events, count } = readFixture();
  // Expectations derive independently from #898 seed views / Application §10.
  assert.deepEqual(expectedSchedule(input.seed, "self").slots.map((slot) => slot.view),
    ["bookable", "reserved_by_me", "unavailable", "group_lesson", "unavailable"]);
  await proveBrowserReads(input);
  assert.equal(count(), 4);
  assert.deepEqual(events, ["cookie:self", "cookie:other", "cookie:foreign", "start",
    ...["self", "other", "missing", "foreign"].flatMap((owner) => Array(3).fill(`get:${owner}`)),
    "stop", "inspect", "revoke", "inspect", "start", ...Array(3).fill("get:self"), ...Array(3).fill("get:other")]);
});

test("#914 intentional failure after positives still closes browser, then Worker, then inspects before removing files", async () => {
  const { input, events } = readFixture();
  await assert.rejects((async () => {
    try { await proveBrowserReads({ ...input, failAfterPositive: true }); }
    finally { await cleanupOwned({ closeBrowser: async () => { events.push("browser-close"); }, browserStopped: async () => true,
      closeServer: input.stop, portClosed: async () => true,
      remove: async () => { await input.inspect(); events.push("remove"); } }); }
  })(), /TRUSTED_BROWSER_INTENTIONAL_FAILURE/);
  assert.deepEqual(events.slice(-4), ["browser-close", "stop", "inspect", "remove"]);
  assert.ok(!events.includes("revoke"));
});

test("#914 metadata observation rejects cross-site and aborted requests without sending", async () => {
  let calls = 0;
  const page = { url: () => origin + "/unknown", evaluate: async () => { calls++; return { status: 200, body: "{}" }; },
    waitForResponse: async () => ({ status: () => 200, request: () => ({ redirectedFrom: () => null,
      allHeaders: async () => ({ "sec-fetch-site": "cross-site" }) }) }) };
  await assert.rejects(browserGet(page, "/api/me/reservations", new AbortController().signal), fixed);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(browserGet(page, "/api/me/reservations", controller.signal));
  assert.equal(calls, 1);
});

test("#914 no opt-in / unavailable driver: fixed diagnostics; no migration, listener or inherited debug canary", async () => {
  const before = existsSync(".wrangler/student-read-only-evaluation");
  for (const args of [[], ["--run", "unexpected"], ["--run"]]) {
    await assert.rejects(promisify(execFile)(process.execPath, ["tests/evaluation/trusted-browser-smoke.mjs", ...args], {
      env: { PATH: process.env.PATH, DEBUG: "private-canary" },
    }), (error) => error.code === 1 && error.stdout === "" && !error.stderr.includes("private-canary"));
    assert.equal(existsSync(".wrangler/student-read-only-evaluation"), before);
  }
});

test("#914 child env allowlist and default evaluation/production entry isolation remain closed", () => {
  const setup = readFileSync("tests/evaluation/trusted-evaluation-seed.mjs", "utf8");
  assert.ok(!setup.includes("NSSSCDL_CHROMIUM_PATH"));
  for (const path of ["src/index.ts", "wrangler.jsonc", "tests/evaluation/worker.ts"]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /trusted-browser|browser-tls-trust|playwright|trusted-evaluation-seed/);
  }
});

test("#914 explicit public Browser launch; #915 persistent Context.browser() remains null", async () => {
  const events = [], proof = { browser: () => null };
  const browser = { newContext: async (options) => {
    events.push("context");
    assert.deepEqual(options, { ignoreHTTPSErrors: false, serviceWorkers: "block" });
    return proof;
  } };
  const chromium = {
    launchPersistentContext: async (profile, options) => {
      events.push("persistent"); assert.equal(profile, "/fixture-home/browser-profile");
      assert.equal(options.env.TMPDIR, "/fixture-home"); return proof;
    },
    launch: async (options) => {
      events.push("launch"); assert.equal(options.env.HOME, "/fixture-home");
      assert.equal(options.env.TMPDIR, "/fixture-run");
      assert.equal(options.chromiumSandbox, true);
      assert.ok(!("ignoreHTTPSErrors" in options) && !("serviceWorkers" in options));
      return browser;
    },
  };
  const standalone = await launchTlsBrowser(chromium, "/fixture-home", "/fixture-browser", false);
  assert.equal(standalone.context.browser(), null);
  assert.equal(standalone.browser, undefined);
  const handoff = await launchTlsBrowser(chromium, "/fixture-home", "/fixture-browser", true, "/fixture-run");
  assert.equal(handoff.browser, browser);
  assert.equal(await handoff.createContext(), proof);
  assert.deepEqual(events, ["persistent", "launch", "context"]);
  const { input } = readFixture();
  await assert.rejects(proveBrowserReads({ ...input, browser: undefined }), fixed);
});

test("#914 generated directories: actual private direct-child paths only; symlink / public mode / other run refused", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-generated-fixture-"));
  const other = mkdtempSync(join(tmpdir(), "nssscdl-other-run-fixture-"));
  try {
    const profile = mkdtempSync(join(temporary, "playwright_chromiumdev_profile-"));
    const artifacts = mkdtempSync(join(temporary, "playwright-artifacts-"));
    const files = generatedBrowserFiles(temporary);
    assert.deepEqual(new Set(files), new Set([profile, artifacts]));
    assert.throws(() => checkOwnedDirectory(other, temporary));
    assert.throws(() => checkGeneratedBrowserCleanup(temporary, files), /remain/);
    chmodSync(profile, 0o755);
    assert.throws(() => generatedBrowserFiles(temporary));
    chmodSync(profile, 0o700);
    const link = join(temporary, "playwright_chromiumdev_profile-link");
    symlinkSync(other, link);
    assert.throws(() => generatedBrowserFiles(temporary));
    rmSync(link); rmSync(profile, { recursive: true }); rmSync(artifacts, { recursive: true });
    checkGeneratedBrowserCleanup(temporary, files);
    assert.ok(existsSync(other)); // No wildcard removal of another run.
  } finally { rmSync(temporary, { recursive: true }); rmSync(other, { recursive: true }); }
});

test("#914 actual /proc profile and HOME, unique main, related process shutdown; unknown state preserves files", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-owned-process-fixture-"));
  const home = mkdtempSync(join(temporary, "tls-home-"));
  const profile = mkdtempSync(join(temporary, "playwright_chromiumdev_profile-"));
  const children = [];
  const launch = async (actualHome, args = []) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`, ...args], {
      env: { PATH: process.env.PATH, HOME: actualHome }, stdio: "ignore",
    });
    const closed = new Promise((done) => child.once("close", done));
    children.push({ child, closed });
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    return child;
  };
  const stopAll = async () => { for (const { child } of children) child.kill("SIGTERM"); await Promise.all(children.map(({ closed }) => closed)); };
  try {
    const main = await launch(home);
    const renderer = await launch(home, ["--type=renderer"]);
    const tracked = new Map();
    assert.equal(checkWorkerBrowserOwnership(home, temporary, tracked).profile, profile);
    assert.ok(tracked.has(main.pid) && tracked.has(renderer.pid));
    let removed = 0;
    await assert.rejects(cleanupOwned({ closeBrowser: async () => {},
      browserStopped: async () => workerBrowserProcesses(home, temporary, tracked).length === 0,
      closeServer: async () => {}, portClosed: async () => true, remove: async () => { removed++; } }));
    assert.equal(removed, 0); assert.ok(existsSync(home) && existsSync(profile));
    await launch(home);
    assert.throws(() => checkWorkerBrowserOwnership(home, temporary, tracked), /unique/);
    await launch("/fixture-wrong-home", ["--type=renderer"]);
    assert.throws(() => workerBrowserProcesses(home, temporary, tracked), /HOME mismatch/);
    await stopAll();
    assert.deepEqual(workerBrowserProcesses(home, temporary, tracked), []);
    await assert.rejects(cleanupOwned({ closeBrowser: async () => {}, browserStopped: async () => true,
      closeServer: async () => {}, portClosed: async () => true,
      remove: async () => { checkGeneratedBrowserCleanup(temporary, [profile]); removed++; } }), /remain/);
    assert.equal(removed, 0); assert.ok(existsSync(home));
  } finally { await stopAll(); rmSync(temporary, { recursive: true }); }
});
