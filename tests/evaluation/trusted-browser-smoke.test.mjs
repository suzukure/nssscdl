// Finite #914 fixtures, not real browser/Worker/D1 evidence.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { browserDiagnostic, checkGeneratedBrowserCleanup, checkOwnedDirectory, checkWorkerBrowserOwnership, cleanupOwned, generatedBrowserFiles, handoffListener, launchTlsBrowser, observeTlsDiagnostic, origin, ownershipReason, parseBrowserDiagnostic, recordBrowserFailure, workerBrowserProcesses } from "./browser-tls-trust.mjs";
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
    assert.throws(() => generatedBrowserFiles(temporary), (error) => ownershipReason(error) === "directory-mode");
    chmodSync(profile, 0o700);
    const link = join(temporary, "playwright_chromiumdev_profile-link");
    symlinkSync(other, link);
    assert.throws(() => generatedBrowserFiles(temporary), (error) => ownershipReason(error) === "directory-type");
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
      env: { PATH: process.env.PATH, HOME: actualHome }, stdio: "ignore", detached: true,
    });
    const closed = new Promise((done) => child.once("close", done));
    children.push({ child, closed });
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    return child;
  };
  const stopAll = async () => { for (const { child } of children) child.kill("SIGTERM"); await Promise.all(children.map(({ closed }) => closed)); };
  try {
    const main = await launch(home);
    const tracked = new Map();
    assert.equal(checkWorkerBrowserOwnership(home, temporary, tracked).profile, profile);
    assert.ok(tracked.has(main.pid));
    let removed = 0;
    await assert.rejects(cleanupOwned({ closeBrowser: async () => {},
      browserStopped: async () => workerBrowserProcesses(home, temporary, tracked).length === 0,
      closeServer: async () => {}, portClosed: async () => true, remove: async () => { removed++; } }));
    assert.equal(removed, 0); assert.ok(existsSync(home) && existsSync(profile));
    await launch(home);
    assert.throws(() => checkWorkerBrowserOwnership(home, temporary, tracked), (error) => ownershipReason(error) === "main-count");
    await stopAll();
    assert.deepEqual(workerBrowserProcesses(home, temporary, tracked), []);
    await assert.rejects(cleanupOwned({ closeBrowser: async () => {}, browserStopped: async () => true,
      closeServer: async () => {}, portClosed: async () => true,
      remove: async () => { checkGeneratedBrowserCleanup(temporary, [profile]); removed++; } }), /remain/);
    assert.equal(removed, 0); assert.ok(existsSync(home));
  } finally { await stopAll(); rmSync(temporary, { recursive: true }); }
});


test("#914 ownership reasons survive independent primary/cleanup and strict owner parsing", () => {
  const diagnostic = { primary: "none", cleanup: "none" };
  observeTlsDiagnostic(diagnostic, "failure: stage=launch-resolved ownership; category=UNCLASSIFIED; TLS proof incomplete; raw cause withheld; ownership=home-mismatch", "tls-setup");
  observeTlsDiagnostic(diagnostic, "cleanup failure: stage=browser-ownership; primary=failed; ownership=main-count", "tls-setup");
  observeTlsDiagnostic(diagnostic, "cleanup failure: stage=browser-ownership; primary=failed; ownership=proc-read", "tls-setup");
  const expected = "TRUSTED_BROWSER_STAGE=tls-browser-ownership; CLEANUP=browser-ownership; OWNERSHIP=home-mismatch; CLEANUP_OWNERSHIP=main-count";
  assert.equal(browserDiagnostic(diagnostic), expected);
  for (const ending of ["", "\n", "\r\n"]) assert.equal(parseBrowserDiagnostic(expected + ending), expected);
  for (const value of [expected + "\n\n", expected + "; private-canary", expected.replace("main-count", "private-canary"),
    expected.replace("; CLEANUP_OWNERSHIP=main-count", "")]) assert.equal(parseBrowserDiagnostic(value), undefined);
  assert.equal(ownershipReason(new Error("private-canary")), "unknown");
  assert.doesNotMatch(browserDiagnostic({ ...diagnostic, ownership: "private-canary" }), /private-canary/);
  const reasons = ["root-unverified", "group-mismatch", "session-mismatch", "tracked-drift", "home-profile-main", "home-profile-child", "home-crash-db", "home-tracked", "home-descendant", "home-unknown",
    "home-descendant-unknown", ...["missing", "different", "ambiguous"].flatMap((home) =>
      ["known", "absent", "unknown"].map((type) => `home-descendant-${home}-type-${type}`))];
  for (const reason of reasons) {
    const independent = { primary: "none", cleanup: "none" };
    const cleanupReason = reasons[(reasons.indexOf(reason) + 1) % reasons.length];
    observeTlsDiagnostic(independent, `failure: stage=launch-resolved ownership; category=UNCLASSIFIED; TLS proof incomplete; raw cause withheld; ownership=${reason}`, "tls-setup");
    observeTlsDiagnostic(independent, `cleanup failure: stage=browser-ownership; primary=failed; ownership=${cleanupReason}`, "tls-setup");
    observeTlsDiagnostic(independent, "cleanup failure: stage=browser-ownership; primary=failed; ownership=proc-read", "tls-setup");
    const line = `TRUSTED_BROWSER_STAGE=tls-browser-ownership; CLEANUP=browser-ownership; OWNERSHIP=${reason}; CLEANUP_OWNERSHIP=${cleanupReason}`;
    assert.equal(browserDiagnostic(independent), line);
    for (const ending of ["", "\n", "\r\n"]) assert.equal(parseBrowserDiagnostic(line + ending), line);
    for (const invalid of [line + "\n\n", line + "; private-canary", line.replace(reason, "home-private-canary"),
      line.replace(`CLEANUP_OWNERSHIP=${cleanupReason}`, "CLEANUP_OWNERSHIP=home-private-canary")]) {
      assert.equal(parseBrowserDiagnostic(invalid), undefined);
    }
  }
});

test("#914 actual post-launch block diagnoses ownership, Context and NSS independently", async () => {
  const source = readFileSync("tests/evaluation/browser-tls-trust.mjs", "utf8");
  const block = source.slice(source.indexOf('    stage = "browser launch/HOME";'), source.indexOf('    stage = "positive trust";'));
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction("fixture", `
    const { launchTlsBrowser, checkWorkerBrowserOwnership, existsSync, ownedProcesses, assert, report } = fixture;
    const chromium = {}, home = "fixture", binary = "fixture", temporary = "fixture", tracked = new Map();
    const workerHandoff = true, db = "modern", modern = "modern", legacy = "legacy";
    let stage, launchAttempted, browser, context, generatedProfile, generated;
    try { ${block} } catch { return stage; }
    return stage;
  `);
  for (const [failed, expected] of [["launch", "browser launch/HOME"], ["ownership", "launch-resolved ownership"],
    ["context", "Browser.newContext"], ["nss", "NSS candidate"]]) {
    const diagnostic = { primary: "none", cleanup: "none" };
    const fail = (step) => { if (step === failed) throw new Error("private-canary"); };
    const stage = await run({ assert, report() {}, ownedProcesses() {},
      launchTlsBrowser: async () => { fail("launch"); return { browser: {}, createContext: async () => { fail("context"); return {}; } }; },
      checkWorkerBrowserOwnership: () => { fail("ownership"); return { profile: "fixture", files: [] }; },
      existsSync: () => failed === "nss" });
    assert.equal(stage, expected);
    observeTlsDiagnostic(diagnostic, `failure: stage=${stage}; category=UNCLASSIFIED; TLS proof incomplete; raw cause withheld`, "tls-setup");
    assert.equal(diagnostic.primary, { launch: "tls-browser-launch", ownership: "tls-browser-ownership", context: "tls-browser-context", nss: "tls-browser-nss" }[failed]);
  }
});

test("#914 profile missing/count and directory read failure remain fail-closed fixed reasons", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-profile-reason-"));
  const home = mkdtempSync(join(temporary, "tls-home-"));
  const profile = join(temporary, "playwright_chromiumdev_profile-missing");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`], {
    env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore", detached: true,
  });
  const closed = new Promise((done) => child.once("close", done));
  try {
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    assert.throws(() => checkWorkerBrowserOwnership(home, temporary, new Map()), (error) => ownershipReason(error) === "profile-missing");
    // Existing contract requires exactly one private profile, even if no process uses the extra one.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(profile, { mode: 0o700 });
    mkdtempSync(join(temporary, "playwright_chromiumdev_profile-extra-"));
    assert.throws(() => checkWorkerBrowserOwnership(home, temporary, new Map()), (error) => ownershipReason(error) === "profile-count");
    assert.throws(() => generatedBrowserFiles(join(temporary, "private-canary-missing")), (error) => {
      assert.equal(ownershipReason(error), "directory-read");
      assert.doesNotMatch(error.message, /private-canary/);
      assert.ok(!("cause" in error) && !("actual" in error)); return true;
    });
  } finally { child.kill("SIGTERM"); await closed; rmSync(temporary, { recursive: true }); }
});

test("#914 actual pre-close recheck still closes once, reports ownership only after resolve, never removes", async () => {
  const source = readFileSync("tests/evaluation/browser-tls-trust.mjs", "utf8");
  const block = source.slice(source.indexOf("        closeBrowser: async () => {"), source.indexOf("        browserStopped: async () => {"));
  const create = new Function("fixture", `
    const { browser, checkWorkerBrowserOwnership, ownershipReason, OwnershipFailure, requireOwnership, bounded } = fixture;
    const home = "fixture", temporary = "fixture", tracked = new Map(), generatedProfile = "fixture", generated = [];
    let cleanupStage = "browser-close", cleanupProcessObservation;
    const closeObservation = { preClose: "not-done", close: "not-done", postClose: "not-run" };
    const operation = { ${block} };
    return { close: operation.closeBrowser, stage: () => cleanupStage, closeObservation, observation: () => cleanupProcessObservation };
  `);
  let OwnershipFailure;
  try { checkOwnedDirectory("/fixture-private-canary-absent"); } catch (error) { OwnershipFailure = error.constructor; }
  for (const reason of ["proc-environ", "home-profile-main", "home-profile-child", "home-crash-db", "home-tracked", "home-descendant", "home-unknown", "home-descendant-unknown",
    ...["missing", "different", "ambiguous"].flatMap((home) =>
      ["known", "absent", "unknown"].map((type) => `home-descendant-${home}-type-${type}`))]) {
    for (const closeFails of [false, true]) {
      let closes = 0, removed = 0, postChecks = 0;
      const operation = create({ OwnershipFailure, ownershipReason, requireOwnership() {}, bounded: (pending) => pending,
        checkWorkerBrowserOwnership: () => { throw new OwnershipFailure(reason, "descendant,zombie,missing,unknown,stable"); },
        browser: { close: async () => { closes++; if (closeFails) throw new Error("private-canary"); } } });
      await assert.rejects(cleanupOwned({ closeBrowser: operation.close, browserStopped: async () => { postChecks++; return true; },
        closeServer: async () => {}, portClosed: async () => true, remove: async () => { removed++; } }),
        (error) => ownershipReason(error) === (closeFails ? "unknown" : reason) &&
          (closeFails || error.observation === "descendant,zombie,missing,unknown,stable"));
      assert.equal(closes, 1); assert.equal(removed, 0);
      assert.equal(postChecks, 0);
      assert.equal(operation.observation(), "descendant,zombie,missing,unknown,stable");
      assert.deepEqual(operation.closeObservation, { preClose: "fail", close: closeFails ? "reject" : "resolve", postClose: "not-run" });
      assert.equal(operation.stage(), closeFails ? "browser-close" : "browser-ownership");
    }
  }
  // A deadline while public close is still pending is not a public rejection.
  const pending = create({ OwnershipFailure, ownershipReason, requireOwnership() {},
    checkWorkerBrowserOwnership: () => ({ profile: "fixture", files: [] }),
    browser: { close: () => new Promise(() => {}) },
    bounded: async () => { throw new Error("fixture deadline"); } });
  await assert.rejects(pending.close());
  assert.deepEqual(pending.closeObservation, { preClose: "pass", close: "not-done", postClose: "not-run" });
});

test("#914 actual post-close process check reports tracked residue without cleanup or retry", async () => {
  const source = readFileSync("tests/evaluation/browser-tls-trust.mjs", "utf8");
  const block = source.slice(source.indexOf("        browserStopped: async () => {"), source.indexOf("        closeServer: async () => {"));
  const create = new Function("fixture", `
    const { workerBrowserProcesses, requireOwnership, Date } = fixture;
    const workerHandoff = true, launchAttempted = true, browser = fixture.browser === null ? undefined : {}, home = "fixture", temporary = "fixture", tracked = new Map();
    const closeObservation = fixture.closeObservation ?? { preClose: "pass", close: "resolve", postClose: "not-run" };
    tracked.root = { pid: 42, group: 42, session: 42 };
    const operation = { ${block} };
    return operation.browserStopped;
  `);
  let OwnershipFailure;
  try { checkOwnedDirectory("/fixture-private-canary-absent"); } catch (error) { OwnershipFailure = error.constructor; }
  let time = 0, reads = 0;
  const residueObservation = { preClose: "pass", close: "resolve", postClose: "not-run" };
  const stopped = create({ workerBrowserProcesses: () => { reads++; return [{ pid: 42 }]; },
    Date: { now: () => { time += 6000; return time; } },
    closeObservation: residueObservation,
    requireOwnership: (condition, reason) => { if (!condition) throw new OwnershipFailure(reason); } });
  await assert.rejects(stopped(), (error) => ownershipReason(error) === "related-process-remains");
  assert.equal(reads, 2); // One loop condition and one final confirmation; no new launch/close.
  assert.equal(residueObservation.postClose, "fail");
  for (const reason of ["proc-environ", "unknown"]) {
    let reads = 0, removed = 0, closed = 0;
    const unknown = create({ workerBrowserProcesses: () => {
      reads++; throw reason === "unknown" ? new Error("private-canary") : new OwnershipFailure(reason);
    }, Date, requireOwnership: (condition, reason) => { if (!condition) throw new OwnershipFailure(reason); } });
    await assert.rejects(cleanupOwned({ closeBrowser: async () => { closed++; }, browserStopped: unknown,
      closeServer: async () => {}, portClosed: async () => true, remove: async () => { removed++; } }));
    assert.equal(reads, 1); assert.equal(closed, 1); assert.equal(removed, 0);
  }
  const closeObservation = { preClose: "pass", close: "resolve", postClose: "not-run" };
  const gone = create({ workerBrowserProcesses: () => [], Date, requireOwnership: assert.ok, closeObservation });
  assert.equal(await gone(), true); // Absence after confirmed API close remains the existing proof.
  assert.equal(closeObservation.postClose, "pass");
  const unlaunched = { preClose: "not-done", close: "not-done", postClose: "not-run" };
  const noHandle = create({ browser: null, workerBrowserProcesses: () => assert.fail("no new post-close check"),
    Date, requireOwnership: assert.ok, closeObservation: unlaunched });
  assert.equal(await noHandle(), false);
  assert.equal(unlaunched.postClose, "not-run");
});

test("#914 observation transport keeps primary/cleanup independent and rejects unknown axes or extra output", () => {
  const diagnostic = { primary: "none", cleanup: "none" };
  const primary = "descendant,live,different,renderer,stable", cleanup = "tracked,zombie,missing,unknown,changed";
  observeTlsDiagnostic(diagnostic, `failure: stage=launch-resolved ownership; category=UNCLASSIFIED; TLS proof incomplete; raw cause withheld; ownership=home-descendant; observation=${primary}`, "tls-setup");
  observeTlsDiagnostic(diagnostic, "cleanup observation; PRE_CLOSE=fail; CLOSE=resolve; POST_CLOSE=not-run", "tls-setup");
  observeTlsDiagnostic(diagnostic, `cleanup failure: stage=browser-ownership; primary=failed; ownership=home-tracked; observation=${cleanup}`, "tls-setup");
  observeTlsDiagnostic(diagnostic, "cleanup failure: stage=browser-close; primary=failed; ownership=unknown; observation=unknown,unknown,unknown,unknown,unknown", "tls-setup");
  const expected = `TRUSTED_BROWSER_STAGE=tls-browser-ownership; CLEANUP=browser-ownership; OWNERSHIP=home-descendant; CLEANUP_OWNERSHIP=home-tracked; OBSERVATION=${primary}; CLEANUP_OBSERVATION=${cleanup}; PRE_CLOSE=fail; CLOSE=resolve; POST_CLOSE=not-run`;
  assert.equal(browserDiagnostic(diagnostic), expected);
  for (const ending of ["", "\n", "\r\n"]) assert.equal(parseBrowserDiagnostic(expected + ending), expected);
  for (const value of [expected + "\n\n", expected + "\nprivate-canary", expected.replace("live", "private-canary"),
    expected.replace("different", "missing,extra"), expected.replace("POST_CLOSE=not-run", "POST_CLOSE=unknown"),
    expected.replace("; CLEANUP_OBSERVATION=" + cleanup, ""), expected.replace("; CLOSE=resolve", ""),
    expected.replace("; OBSERVATION=", "; EXTRA=")]) assert.equal(parseBrowserDiagnostic(value), undefined);
  assert.doesNotMatch(browserDiagnostic({ ...diagnostic, observation: "private-canary", cleanupObservation: "private-canary" }), /private-canary/);
  for (let axis = 0; axis < 5; axis++) {
    const values = primary.split(","); values[axis] = "private-canary";
    assert.equal(parseBrowserDiagnostic(expected.replace(primary, values.join(","))), undefined);
  }
  for (const [preClose, close, postClose] of [["pass", "resolve", "pass"], ["fail", "reject", "not-run"], ["not-done", "not-done", "not-run"], ["pass", "resolve", "fail"]]) {
    const line = browserDiagnostic({ primary: "none", cleanup: "browser-process", closeObservation: { preClose, close, postClose } });
    assert.equal(parseBrowserDiagnostic(line), line);
  }
});

test("#914 actual helper report templates preserve fixed observations through the shared child/owner parser", () => {
  const source = readFileSync("tests/evaluation/browser-tls-trust.mjs", "utf8");
  const fixedHelpers = source.slice(source.indexOf("const observationAxes"), source.indexOf("export function recordBrowserFailure"));
  const failureReport = source.split("\n").find((line) => line.trim().startsWith("report(`failure: stage="));
  const cleanupReport = source.split("\n").find((line) => line.trim().startsWith("report(`cleanup failure: stage="));
  const run = new Function("OwnershipFailure", "ownershipReason", "error", "report", `
    ${fixedHelpers}
    const workerHandoff = true, stage = "launch-resolved ownership", category = "UNCLASSIFIED";
    const primaryFailed = true, cleanupStage = "browser-ownership", cleanupProcessObservation = undefined;
    ${failureReport}
    report('cleanup observation' + closeFields({ preClose: 'fail', close: 'resolve', postClose: 'not-run' }));
    ${cleanupReport}
  `);
  let OwnershipFailure;
  try { checkOwnedDirectory("/fixture-private-canary-absent"); } catch (error) { OwnershipFailure = error.constructor; }
  for (const observation of ["descendant,zombie,missing,unknown,stable", "private-canary"]) {
    const diagnostic = { primary: "none", cleanup: "none" };
    run(OwnershipFailure, ownershipReason, new OwnershipFailure("home-descendant", observation),
      (line) => observeTlsDiagnostic(diagnostic, line, "tls-setup"));
    const safe = observation === "private-canary" ? "unknown,unknown,unknown,unknown,unknown" : observation;
    const line = browserDiagnostic(diagnostic);
    assert.equal(line, `TRUSTED_BROWSER_STAGE=tls-browser-ownership; CLEANUP=browser-ownership; OWNERSHIP=home-descendant; CLEANUP_OWNERSHIP=home-descendant; OBSERVATION=${safe}; CLEANUP_OBSERVATION=${safe}; PRE_CLOSE=fail; CLOSE=resolve; POST_CLOSE=not-run`);
    assert.equal(parseBrowserDiagnostic(line + "\n"), line);
    assert.doesNotMatch(line, /private-canary/);
  }
});

// Issue #914's adopted process-group contract is the oracle, not browser runtime output.
function ownershipFixture() {
  const source = readFileSync("tests/evaluation/browser-tls-trust.mjs", "utf8");
  const block = source.slice(source.indexOf("export function workerBrowserProcesses"), source.indexOf("export function checkGeneratedBrowserCleanup"));
  let OwnershipFailure;
  try { checkOwnedDirectory("/fixture-absent"); } catch (error) { OwnershipFailure = error.constructor; }
  const requireOwnership = (condition, reason) => { if (!condition) throw new OwnershipFailure(reason); };
  const ownershipRead = (reason, operation) => { try { return operation(); } catch (error) {
    if (error instanceof OwnershipFailure) throw error; throw new OwnershipFailure(reason);
  } };
  const factory = new Function("readdirSync", "lstatSync", "readFileSync", "process", "OwnershipFailure", "ownershipReason",
    "requireOwnership", "ownershipRead", "dirname", "generatedBrowserFiles", block.replaceAll("export function", "function") +
    "\nreturn { processes: workerBrowserProcesses, check: checkWorkerBrowserOwnership };");
  const profile = "/fixture-run/playwright_chromiumdev_profile-fixture";
  const main = { pid: 42, parent: 1, group: 42, session: 42, identity: "420", uid: 7,
    argv: [`--user-data-dir=${profile}`], env: "HOME=/fixture-home\0", state: "S" };
  // setproctitle-style single mutable title: type is absent, HOME is missing.
  const child = { pid: 43, parent: 42, group: 42, session: 42, identity: "430", uid: 7,
    argv: ["mutable private-canary --type=renderer"], env: "\0\0", state: "R" };
  let rows = [main, child], files = [profile], mutate = () => {};
  const tracked = new Map(), reads = new Map();
  const gone = () => { const error = new Error("private-canary"); error.code = "ENOENT"; throw error; };
  const api = factory(() => rows.map((row) => String(row.pid)), (path) => {
    const row = rows.find((row) => row.pid === Number(path.split("/")[2]));
    if (!row) gone(); return { uid: row.uid };
  }, (path) => {
    const pid = Number(path.split("/")[2]), kind = path.split("/").at(-1);
    const row = rows.find((row) => row.pid === pid); if (!row) gone();
    const key = `${pid}/${kind}`, count = (reads.get(key) ?? 0) + 1; reads.set(key, count);
    const sample = { ...row, kind }; mutate(sample, count);
    if (kind === "cmdline") return sample.argv.join("\0") + (sample.terminated === false ? "" : "\0");
    if (kind === "environ") return sample.env;
    const fields = Array(20).fill("0");
    fields[0] = sample.state; fields[1] = String(sample.parent); fields[2] = String(sample.group);
    fields[3] = String(sample.session); fields[19] = sample.identity;
    return `${pid} (mutable ) private-canary) ${fields.join(" ")}`;
  }, { pid: 1, getuid: () => 7 }, OwnershipFailure, ownershipReason, requireOwnership, ownershipRead,
  (path) => path.slice(0, path.lastIndexOf("/")), () => files);
  return { main, child, tracked, profile, setRows: (value) => { rows = value; }, setFiles: (value) => { files = value; },
    mutate: (value) => { mutate = value; }, run: (check = false) => {
      reads.clear(); return api[check ? "check" : "processes"]("/fixture-home", "/fixture-run", tracked);
    } };
}
function failsOwnership(fixture, expected, check = false) {
  assert.throws(() => fixture.run(check), (error) => {
    assert.equal(ownershipReason(error), expected);
    assert.doesNotMatch(error.message + (error.observation ?? ""), /private-canary|fixture-home|fixture-run|420|430/);
    assert.ok(!("cause" in error) && !("actual" in error)); return true;
  });
}

test("#914 exact root: unique private generated profile, NUL argv, HOME and PID=PGRP=SID; no fallback", () => {
  const good = ownershipFixture(); assert.equal(good.run(true).profile, good.profile);
  assert.deepEqual([...good.tracked], [[42, "420"], [43, "430"]]);
  for (const [change, reason] of [
    [(f) => { f.setRows([f.child]); }, "main-count"],
    [(f) => { f.setRows([f.main, { ...f.main, pid: 44, identity: "440" }]); }, "main-count"],
    [(f) => { f.main.argv.push(f.main.argv[0]); }, "profile-argv"],
    [(f) => { f.main.terminated = false; }, "profile-argv"],
    [(f) => { f.main.argv = [`title ${f.main.argv[0]}`]; }, "main-count"],
    [(f) => { f.main.argv = ["--user-data-dir=/fixture-run/fake-profile"]; }, "profile-location"],
    [(f) => { f.setFiles([]); }, "profile-missing"],
    [(f) => { f.setFiles([f.profile, "/fixture-run/playwright_chromiumdev_profile-extra"]); }, "profile-count"],
    [(f) => { f.main.group = 99; }, "root-unverified"],
    [(f) => { f.main.session = 99; }, "root-unverified"],
    ...["", "HOME=/private-canary\0", "HOME=/fixture-home\0HOME=/private-canary\0", "HOME\0"].map((env) =>
      [(f) => { f.main.env = env; }, "home-profile-main"]),
    [(f) => { f.mutate((row, count) => { if (row.pid === 42 && row.kind === "stat" && count === 2) row.identity = "999"; }); }, "root-unverified"],
  ]) {
    const fixture = ownershipFixture(); change(fixture); failsOwnership(fixture, reason, true);
    assert.equal(fixture.tracked.root, undefined); // Never connect to a guessed same-UID group.
  }
});

test("#914 related group/session children allow only missing HOME; explicit different/ambiguous/unreadable remains closed", () => {
  for (const env of ["", "\0\0", "HOME=/fixture-home\0"]) {
    const fixture = ownershipFixture(); fixture.child.env = env;
    assert.deepEqual(fixture.run().map((row) => row.pid), [42, 43]);
  }
  for (const [change, reason] of [
    [(f) => { f.child.group = 99; }, "group-mismatch"],
    [(f) => { f.child.session = 99; }, "session-mismatch"],
    [(f) => { f.child.uid = 8; }, "tracked-owner"],
    [(f) => { f.child.parent = 1; }, "unknown"],
    [(f) => { f.child.identity = "410"; }, "tracked-drift"],
    ...["HOME=/private-canary\0", "HOME=\0"].map((env) => [(f) => { f.child.env = env; }, "home-descendant-different-type-absent"]),
    ...["HOME\0", "HOME=/fixture-home\0HOME=/private-canary\0"].map((env) =>
      [(f) => { f.child.env = env; }, "home-descendant-ambiguous-type-absent"]),
    [(f) => { f.mutate((row) => { if (row.pid === 43 && row.kind === "environ") throw new Error("private-canary"); }); }, "proc-environ"],
  ]) { const fixture = ownershipFixture(); change(fixture); failsOwnership(fixture, reason); }
  const foreign = ownershipFixture(); foreign.setRows([foreign.main, foreign.child,
    { ...foreign.child, pid: 44, parent: 1, group: 99, session: 99, uid: 8 }]);
  assert.equal(foreign.run().length, 2); // Different UID/group/session is unrelated.
});

test("#914 identity rereads, parent contradictions and tracked drift never transfer ownership or discard unknown residue", () => {
  for (const [target, field] of [[43, "identity"], [43, "parent"], [43, "group"], [43, "session"], [42, "identity"]]) {
    const fixture = ownershipFixture(); fixture.run();
    fixture.mutate((row, count) => { if (row.pid === target && row.kind === "stat" && count === 2) row[field] = field === "identity" ? "999" : 99; });
    failsOwnership(fixture, "tracked-drift");
    assert.equal(fixture.tracked.get(target), target === 42 ? "420" : "430");
  }
  for (const code of ["ENOENT", "ESRCH", "EACCES"]) {
    const fixture = ownershipFixture();
    fixture.mutate((row, count) => { if (row.pid === 43 && row.kind === "stat" && count === 2) {
      const error = new Error("private-canary"); error.code = code; throw error;
    } }); failsOwnership(fixture, "tracked-drift");
  }
  for (const [change, reason] of [
    [(f) => { f.child.identity = "999"; }, "tracked-drift"],
    [(f) => { f.child.group = 99; }, "group-mismatch"],
    [(f) => { f.child.session = 99; }, "session-mismatch"],
    [(f) => { f.child.uid = 8; }, "tracked-owner"],
    [(f) => { f.child.parent = 99; }, "tracked-drift"],
    [(f) => { f.child.parent = f.child.pid; }, "tracked-drift"],
    [(f) => { f.main.parent = f.child.pid; }, "tracked-drift"],
    [(f) => { f.main.identity = "990"; }, "tracked-drift"],
    [(f) => { f.main.env = ""; }, "home-profile-main"],
    [(f) => { f.setRows([f.main, f.child, { ...f.child, pid: 44, parent: 1 }]); }, "unknown"],
  ]) { const fixture = ownershipFixture(); fixture.run(); change(fixture); failsOwnership(fixture, reason); }
  const reparented = ownershipFixture(); reparented.run(); reparented.child.parent = 1; reparented.setRows([reparented.child]);
  assert.equal(reparented.run().length, 1); // Attested identity remains tracked after root exit.
  reparented.setRows([]); assert.deepEqual(reparented.run(), []);
  assert.equal(reparented.tracked.get(43), "430"); // Tombstone retained to detect PID reuse through shutdown.
  reparented.child.identity = "999"; reparented.setRows([reparented.child]); failsOwnership(reparented, "tracked-drift");
});

test("#914 stable fixed observations retain state/type axes while disappeared or malformed related reads preserve uncertainty", () => {
  for (const [state, expected] of [["R", "live"], ["S", "live"], ["Z", "zombie"], ["X", "dead"], ["x", "dead"]]) {
    const fixture = ownershipFixture(); fixture.child.state = state; fixture.child.argv = [];
    fixture.child.env = "HOME=/private-canary\0";
    assert.throws(() => fixture.run(), (error) => error.observation ===
      `descendant,${expected},different,${["Z", "X", "x"].includes(state) ? "unknown" : "absent"},stable`);
  }
  for (const [argv, type] of [
    ...["renderer", "zygote", "gpu-process", "utility"].map((value) => [[`--type=${value}`], value]),
    [["--type=private-canary"], "other"], [["--type="], "unknown"], [["--type"], "unknown"],
    [["--type=renderer", "--type=zygote"], "unknown"],
  ]) {
    const fixture = ownershipFixture(); fixture.child.argv = argv; fixture.child.env = "HOME=/private-canary\0";
    assert.throws(() => fixture.run(), (error) => error.observation === `descendant,live,different,${type},stable`);
  }
  for (const [change, reason] of [
    [(f) => { f.main.uid = 8; }, "main-count"],
    [(f) => { f.main.identity = "malformed"; }, "proc-read"],
    [(f) => { f.mutate((row) => { if (row.pid === 42 && row.kind === "environ") throw new Error("private-canary"); }); }, "proc-environ"],
    [(f) => { f.mutate((row) => { if (row.pid === 43 && row.kind === "cmdline") {
      const error = new Error("private-canary"); error.code = "ENOENT"; throw error;
    } }); }, "proc-read"],
  ]) { const fixture = ownershipFixture(); change(fixture); failsOwnership(fixture, reason); }
  const altered = ownershipFixture(); altered.run(); altered.main.argv = ["mutable title"];
  failsOwnership(altered, "root-unverified");
});
