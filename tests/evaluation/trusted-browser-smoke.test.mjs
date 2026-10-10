// Finite #914 fixtures, not real browser/Worker/D1 evidence.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { browserDiagnostic, checkGeneratedBrowserCleanup, checkOwnedDirectory, checkWorkerBrowserOwnership, cleanupOwned, generatedBrowserFiles, handoffListener, launchTlsBrowser, observeTlsDiagnostic, origin, ownershipReason, parseBrowserDiagnostic, recordBrowserFailure, } from "./browser-tls-trust.mjs";
import { browserCookie, browserEvidence, browserFailureCheckpoint, browserGet, browserProofCheckpoint, checkCertificate, checkNonExposure, injectCookie, proveBrowserReads, withStoppedProxy } from "./trusted-browser-reads.mjs";
import { expectedHistory, expectedSchedule } from "./trusted-https-assertions.mjs";
import { BrowserUnit, finishBrowserUnit, ownedIdentity, readBrowserReport, verifyOwned, writeBrowserReport } from "./trusted-browser-unit.mjs";
import { verifyStudentAssets } from "./verify-student-assets.mjs";
import { evaluationD1 } from "./trusted-evaluation-seed.mjs";
import { mkdirSync } from "node:fs";
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

test("#914 actual child final report separates expected failure and cancellation; no stdout", async () => {
  const source = readFileSync("tests/evaluation/trusted-https-process.mjs", "utf8");
  const tail = source.slice(source.indexOf("// Fixed report is atomic"));
  const run = new Function("fixture", `
    const { process, writeBrowserReport, diagnostic, cancelled, intentionalObserved,
      browserCleanupConfirmed, browserCertificate, browserFailureCheckpoint, browserProofCheckpoint,
      browserDiagnostic, recordBrowserFailure, controller } = fixture;
    const browserMode = true, browserStage = 'browser-read';
    ${tail}
  `);
  for (const intentional of [false, true]) for (const cancelled of [false, true]) for (const cleanup of ["none", "browser-close"]) {
    const reports = [], fakeProcess = { env: { TMPDIR: 'fixture' }, exitCode: intentional ? 1 : undefined };
    run({ process: fakeProcess, writeBrowserReport: (_path, value) => reports.push(value),
      diagnostic: { primary: intentional ? "browser-read" : "none", cleanup }, cancelled,
      controller: { signal: { aborted: cancelled } }, intentionalObserved: intentional,
      browserCleanupConfirmed: cleanup === "none", browserCertificate: "certificate-fixture",
      browserFailureCheckpoint, browserProofCheckpoint, browserDiagnostic, recordBrowserFailure });
    const complete = !cancelled && cleanup === "none";
    assert.equal(fakeProcess.exitCode, complete ? 0 : 1);
    assert.equal(reports.length, 1);
    assert.equal(reports[0], complete ? `certificate-fixture\n${intentional ? browserFailureCheckpoint : browserProofCheckpoint}\n` :
      `TRUSTED_BROWSER_STAGE=${intentional ? "browser-read" : cancelled ? "unknown" : "browser-read"}; CLEANUP=${cleanup}\n`);
  }
  const reports = [], process = { env: { TMPDIR: 'fixture' }, exitCode: 1 };
  run({ process, writeBrowserReport: (_path, value) => reports.push(value), diagnostic: { primary: "tls-positive", cleanup: "none" },
    cancelled: false, controller: { signal: { aborted: false } }, intentionalObserved: false,
    browserCleanupConfirmed: true, browserCertificate: 'fixture', browserFailureCheckpoint, browserProofCheckpoint,
    browserDiagnostic, recordBrowserFailure });
  assert.equal(process.exitCode, 1); assert.deepEqual(reports, ["TRUSTED_BROWSER_STAGE=tls-positive; CLEANUP=none\n"]);
});

test("#914 managed cleanup diagnosis preserves API stop order and call counts without child terminal claims", async () => {
  const stages = ["browser-close", "proof-listener", "port-close", "owned-remove"];
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
      await cleanupOwned({ managed: true, onStage: (value) => { stage = value; },
        closeBrowser: () => operation("browser-close"), browserStopped: () => assert.fail("unit terminal belongs to outer"),
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
    assert.deepEqual(options, { ignoreHTTPSErrors: false, serviceWorkers: "block", ...(created === 0 ? { timezoneId: "America/Los_Angeles" } : {}) });
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

test("#914 intentional failure closes browser, then Worker and inspects; deletion belongs to outer", async () => {
  const { input, events } = readFixture();
  await assert.rejects((async () => {
    try { await proveBrowserReads({ ...input, failAfterPositive: true }); }
    finally { await cleanupOwned({ managed: true, closeBrowser: async () => { events.push("browser-close"); }, browserStopped: async () => assert.fail("managed no-live is outer"),
      closeServer: input.stop, portClosed: async () => true,
      remove: async () => { await input.inspect(); events.push("report-ready"); } }); }
  })(), /TRUSTED_BROWSER_INTENTIONAL_FAILURE/);
  assert.deepEqual(events.slice(-4), ["browser-close", "stop", "inspect", "report-ready"]);
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
      await assert.rejects(cleanupOwned({ managed: true, closeBrowser: operation.close, browserStopped: async () => { postChecks++; return true; },
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

// Oracle: Issue #914's current systemd contract and supplied formal probe results.
function rootFixture() {
  const profile = "/fixture-run/playwright_chromiumdev_profile-fixture";
  const unit = "0::/system.slice/nssscdl-browser-" + "a".repeat(32) + ".service\n";
  const main = { pid: 42, uid: 7, identity: "420", argv: [`--user-data-dir=${profile}`], home: "HOME=/fixture-home\0",
    unit, status: "NoNewPrivs:\t1\n", state: "S", terminated: true };
  // An ordinary setsid child has mutable title/environment and another group;
  // no per-child HOME/PGRP/SID reads are required by the adopted unit contract.
  const child = { ...main, pid: 43, argv: ["mutable title"], home: "", identity: "430" };
  let rows = [main, child], files = [profile], mutate = () => {};
  const tracked = new Map(); let reads = 0;
  const io = { uid: 7, pid: 1, files: () => files, list: () => rows.map((row) => String(row.pid)),
    stat: (path) => ({ uid: rows.find((row) => row.pid === Number(path.split('/')[2])).uid }),
    read: (path) => {
      if (path === "/proc/self/cgroup") return unit;
      const row = rows.find((row) => row.pid === Number(path.split('/')[2]));
      const kind = path.split('/').at(-1);
      if (kind === 'cmdline') return row.argv.join('\0') + (row.terminated ? '\0' : '');
      assert.equal(row.pid, main.pid); // Never read the child's mutable environ/stat.
      if (kind === 'environ') return row.home;
      if (kind === 'cgroup') return row.unit;
      if (kind === 'status') return row.status;
      const sample = { ...row }; mutate(sample, ++reads);
      const fields = Array(20).fill('0'); fields[0] = sample.state; fields[19] = sample.identity;
      return `${row.pid} (mutable title) ${fields.join(' ')}`;
    } };
  return { main, child, profile, tracked, io, setRows: (value) => { rows = value; }, setFiles: (value) => { files = value; },
    mutate: (value) => { mutate = value; }, run: () => { reads = 0; return checkWorkerBrowserOwnership('/fixture-home', '/fixture-run', tracked, io); } };
}

test("#914 exact root HOME/profile/UID/starttime/NoNewPrivs/unit; whole-child tracking removed", () => {
  const good = rootFixture(); assert.equal(good.run().profile, good.profile);
  good.mutate((row) => { row.state = 'R'; }); good.run(); // live scheduler change.
  for (const [change, reason] of [
    [(f) => f.setRows([f.child]), 'main-count'],
    [(f) => f.setRows([f.main, { ...f.main, pid: 44 }]), 'main-count'],
    [(f) => { f.main.argv.push(f.main.argv[0]); }, 'profile-argv'],
    [(f) => { f.main.terminated = false; }, 'profile-argv'],
    [(f) => { f.main.argv = [`title ${f.main.argv[0]}`]; }, 'main-count'],
    [(f) => { f.main.uid = 8; }, 'main-count'],
    [(f) => f.setFiles([]), 'profile-missing'],
    [(f) => f.setFiles([f.profile, '/fixture-run/playwright_chromiumdev_profile-extra']), 'profile-count'],
    ...['', 'HOME=/other\0', 'HOME=/fixture-home\0HOME=/fixture-home\0'].map((home) =>
      [(f) => { f.main.home = home; }, 'home-profile-main']),
    [(f) => { f.main.unit = '0::/other-unit\n'; }, 'root-unverified'],
    [(f) => { f.main.status = 'NoNewPrivs:\t0\n'; }, 'root-unverified'],
    [(f) => { f.main.status += 'NoNewPrivs:\t1\n'; }, 'root-unverified'],
    [(f) => { f.main.argv.push('--no-sandbox'); }, 'root-unverified'],
    [(f) => f.mutate((row, n) => { if (n === 2) row.identity = '999'; }), 'root-unverified'],
    [(f) => f.mutate((row, n) => { if (n === 2) row.state = 'Z'; }), 'root-unverified'],
    [(f) => { f.io.read = () => { throw new Error('private-canary'); }; }, 'proc-read'],
  ]) {
    const f = rootFixture(); change(f);
    assert.throws(f.run, (e) => ownershipReason(e) === reason && !e.message.includes('private-canary'));
    assert.equal(f.tracked.root, undefined);
  }
  const reused = rootFixture(); reused.run(); reused.main.identity = '999';
  assert.throws(reused.run, (e) => ownershipReason(e) === 'tracked-drift');
});

const certificateLine = `certificate: SHA256=${Array(32).fill('AB').join(':')}; SAN=127.0.0.1; same Node/Worker cert`;
const reportText = (intentional = false) => certificateLine + '\n' + (intentional ? browserFailureCheckpoint : browserProofCheckpoint) + '\n';

test("#914 private atomic report refuses stale/malformed/oversized/symlink/wrong-mode and cross-mode results", () => {
  for (const intentional of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'nssscdl-report-fixture-'));
    try {
      writeBrowserReport(dir, reportText(intentional));
      assert.deepEqual(readBrowserReport(dir, intentional), { certificate: certificateLine });
      assert.throws(() => readBrowserReport(dir, !intentional));
      assert.throws(() => writeBrowserReport(dir, reportText(intentional))); // one-shot path.
      const path = join(dir, 'browser-report');
      chmodSync(path, 0o644); assert.throws(() => readBrowserReport(dir, intentional)); chmodSync(path, 0o600);
      for (const value of [reportText(intentional) + 'private-canary\n', 'x'.repeat(8193), '',
        '#914: owned HOME removed\n', 'TRUSTED_BROWSER_STAGE=none; CLEANUP=none\n']) {
        writeFileSync(path, value); assert.throws(() => readBrowserReport(dir, intentional));
      }
      writeFileSync(path, 'TRUSTED_BROWSER_STAGE=browser-read; CLEANUP=browser-close\n');
      assert.deepEqual(readBrowserReport(dir, intentional), { diagnostic: 'TRUSTED_BROWSER_STAGE=browser-read; CLEANUP=browser-close' });
      rmSync(path); symlinkSync(join(dir, 'nonexistent'), path); assert.throws(() => readBrowserReport(dir, intentional));
      rmSync(path); assert.throws(() => readBrowserReport(dir, intentional));
    } finally { rmSync(dir, { recursive: true }); }
  }
});

function unitFixture() {
  let time = 0, observations = 0, stopped = false, mutate = () => {};
  const controller = new AbortController(), events = [], options = [];
  const unit = new BrowserUnit({ env: { PATH: '/usr/bin', HOME: '/fixture', TMPDIR: '/fixture' }, cwd: '/fixture',
    uid: 7, gid: 7, signal: controller.signal, deadline: 180000, now: () => time,
    sleep: async (ms) => { time += ms; }, command: async (file, args, config) => {
      assert.equal(file, 'sudo'); assert.equal(args[0], '-n');
      assert.ok(config.timeout > 0 && config.timeout <= 5000); options.push(config);
      if (args[1] === 'systemd-run') { events.push('start'); assert.ok(args.includes('/usr/bin/env') && args.includes('-i')); return ''; }
      if (args[2] === 'stop') { events.push('stop'); stopped = true; return ''; }
      events.push('show');
      const state = stopped ? { LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead', InvocationID: '' } : {
        Type: 'exec', ExitType: 'cgroup', RemainAfterExit: 'yes', Restart: 'no', NRestarts: '0', OOMPolicy: 'stop',
        Delegate: 'no', NoNewPrivileges: 'yes', ProtectControlGroups: 'yes', KillMode: 'control-group',
        StandardOutput: 'null', StandardError: 'null', User: '7', Group: '7', RuntimeMaxUSec: '2min', TimeoutStopUSec: '2s',
        LoadState: 'loaded', ActiveState: 'active', SubState: 'exited', Result: 'success', ExecMainCode: '1', ExecMainStatus: '0',
        InvocationID: 'b'.repeat(32), ControlGroup: '/system.slice/' + unit.name };
      mutate(state, ++observations, args);
      return Object.entries(state).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    } });
  return { unit, controller, events, options, mutate: (fn) => { mutate = fn; }, time: (n) => { time = n; } };
}

async function finishFixture(f, overrides = {}) {
  await f.unit.start('/fixture-node', ['--browser']);
  return finishBrowserUnit(f.unit, { intentional: false, report: async () => { f.events.push('report'); return { certificate: certificateLine }; },
    finalCheck: async () => { f.events.push('port/generated'); }, remove: async () => { f.events.push('delete'); }, ...overrides });
}

test("#914 report + two same-invocation terminal reads + port/generated check precede empty release and owned delete", async () => {
  for (const intentional of [false, true]) {
    const f = unitFixture();
    await finishFixture(f, { intentional, report: async (mode) => { assert.equal(mode, intentional); f.events.push('report'); return { certificate: browserEvidence(reportText(mode), mode) }; } });
    assert.deepEqual(f.events, ['start', 'show', 'show', 'show', 'report', 'port/generated', 'stop', 'show', 'delete']);
    assert.equal(f.unit.failure, undefined);
  }
  const retained = unitFixture(); let running = true;
  retained.mutate((s, n) => { if (n <= 3 && running) { s.SubState = 'running'; s.ExecMainCode = '1'; s.ExecMainStatus = '0'; }
    if (n === 3) { assert.ok(!retained.events.includes('delete')); running = false; } });
  await finishFixture(retained); // Parent exit0 cannot end the unit while a setsid child lives.
  assert.equal(retained.events.filter((x) => x === 'show').length, 6);
});

test("#914 mismatch/unknown/manager failure/timeout/cancel/stop are irreversible; no deletion or stop retry", async () => {
  for (const [key, value] of [['InvocationID', 'c'.repeat(32)], ['ExitType', 'main'], ['NoNewPrivileges', 'no'],
    ['User', '0'], ['Group', '0'], ['KillMode', 'process'], ['StandardOutput', 'journal'], ['RuntimeMaxUSec', '3min'],
    ['ExecMainCode', '2'], ['ExecMainStatus', '1'], ['NRestarts', '1'], ['Result', 'timeout'],
    ['Result', 'oom-kill'], ['LoadState', 'not-found'], ['ActiveState', 'failed'], ['SubState', 'dead']]) {
    const f = unitFixture(); f.mutate((s, n) => { if (n === 3) s[key] = value; });
    await assert.rejects(finishFixture(f)); assert.ok(!f.events.includes('delete'));
    assert.ok(f.unit.failure); assert.equal(f.events.filter((v) => v === 'stop').length, 1);
  }
  for (const action of ['unknown', 'timeout', 'cancel', 'stop']) {
    const f = unitFixture();
    f.mutate((s, n) => {
      if (n === 2) {
        if (action === 'unknown') throw new Error('private-canary');
        if (action === 'timeout') f.time(170000);
        if (action === 'cancel') f.controller.abort();
        if (action === 'stop') f.unit.latch('STOP');
      }
    });
    await assert.rejects(finishFixture(f)); const original = f.unit.failure;
    f.unit.latch('UNKNOWN'); assert.equal(f.unit.failure, original);
    assert.ok(!f.events.includes('delete')); assert.equal(f.events.filter((v) => v === 'stop').length, 1);
  }
  for (const failAt of ['report', 'port', 'generated', 'release', 'delete-ownership']) {
    const f = unitFixture();
    if (failAt === 'release') f.mutate((s, _n, args) => { if (args.some((a) => a === '--property=InvocationID') && s.LoadState === 'not-found') s.ActiveState = 'active'; });
    await assert.rejects(finishFixture(f, {
      report: async () => { if (failAt === 'report') return { diagnostic: 'TRUSTED_BROWSER_STAGE=unknown; CLEANUP=unknown' }; return { certificate: certificateLine }; },
      finalCheck: async () => { if (['port', 'generated'].includes(failAt)) throw new Error('residue'); },
      remove: async () => { if (failAt === 'delete-ownership') throw new Error('non-owned'); f.events.push('delete'); },
    }));
    assert.ok(!f.events.includes('delete')); assert.equal(f.events.filter((v) => v === 'stop').length, 1);
  }
});

test("#914 malformed state, failed stop and late cancellation preserve files within the shared budget", async () => {
  for (const kind of ['duplicate', 'missing', 'raw-error', 'stop-failed', 'cancel-after-report']) {
    const f = unitFixture(), command = f.unit.command;
    f.unit.command = async (file, args, options) => {
      if (kind === 'stop-failed' && args[2] === 'stop') {
        f.events.push('stop'); throw new Error('private-canary');
      }
      const output = await command(file, args, options);
      if (f.events.filter((x) => x === 'show').length === 3) {
        if (kind === 'duplicate') return output + 'Result=success\n';
        if (kind === 'missing') return output.replace('InvocationID=' + 'b'.repeat(32) + '\n', '');
        if (kind === 'raw-error') throw new Error('private-canary');
      }
      return output;
    };
    await assert.rejects(finishFixture(f, { finalCheck: async () => {
      if (kind === 'cancel-after-report') f.controller.abort();
    } }), (e) => /^TRUSTED_BROWSER_UNIT_[A-Z]+$/.test(e.message));
    assert.ok(!f.events.includes('delete'));
    assert.equal(f.events.filter((x) => x === 'stop').length, 1);
    const calls = f.options.length; await f.unit.dispose(); assert.equal(f.options.length, calls);
  }
  const timeout = unitFixture(); timeout.time(170000);
  await assert.rejects(timeout.unit.start('/fixture-node', []));
  assert.deepEqual(timeout.events, []); assert.equal(timeout.unit.failure, 'TIMEOUT'); timeout.unit.close();
});

test("#914 owner verifies creation identity and realpath before deleting; non-owned/symlink directories preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), 'nssscdl-identity-fixture-'));
  const other = mkdtempSync(join(tmpdir(), 'nssscdl-nonowned-fixture-'));
  try {
    const identity = ownedIdentity(dir); verifyOwned(identity);
    assert.throws(() => verifyOwned({ ...identity, ino: -1 }));
    const link = join(dir, 'link'); symlinkSync(other, link); assert.throws(() => ownedIdentity(link));
    assert.ok(existsSync(other)); chmodSync(dir, 0o755); assert.throws(() => verifyOwned(identity));
  } finally { rmSync(dir, { recursive: true }); rmSync(other, { recursive: true }); }
});


test("#922 DOM consumer follows real positive reads and runs after self revocation; failure prevents downstream revocation", async () => {
  const normal = readFixture();
  await proveBrowserReads({ ...normal.input, proveDom: async (_page, signal, revoked = false) => {
    signal.throwIfAborted(); normal.events.push(revoked ? "dom:revoked" : "dom:positive");
  } });
  assert.ok(normal.events.indexOf("dom:positive") > normal.events.indexOf("get:other"));
  assert.ok(normal.events.indexOf("dom:positive") < normal.events.indexOf("revoke"));
  assert.equal(normal.events.at(-1), "dom:revoked");
  const failed = readFixture();
  await assert.rejects(proveBrowserReads({ ...failed.input, proveDom: async () => { throw new Error("fixture failure"); } }));
  assert.ok(!failed.events.includes("revoke") && !failed.events.includes("stop")); // existing outer owner handles cleanup
});

test("#922 build preflight rejects missing, extra, empty or symlink assets and production activation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-assets-fixture-"));
  const files = ["student.html", "student.css", "student.js", "view.js", "controller.js", "model.js"];
  const asset = name => join(temporary, "dist/student", name);
  try {
    mkdirSync(join(temporary, "tests/evaluation"), { recursive: true });
    mkdirSync(join(temporary, "dist/student"), { recursive: true });
    writeFileSync(join(temporary, "tests/evaluation/wrangler.jsonc"), readFileSync("tests/evaluation/wrangler.jsonc"));
    writeFileSync(join(temporary, "wrangler.jsonc"), readFileSync("wrangler.jsonc"));
    assert.throws(() => verifyStudentAssets(temporary));
    for (const name of files) writeFileSync(asset(name), "secretless build fixture");
    verifyStudentAssets(temporary);
    writeFileSync(asset("unexpected.js"), "extra"); assert.throws(() => verifyStudentAssets(temporary)); rmSync(asset("unexpected.js"));
    writeFileSync(asset("model.js"), ""); assert.throws(() => verifyStudentAssets(temporary)); rmSync(asset("model.js"));
    symlinkSync(asset("view.js"), asset("model.js")); assert.throws(() => verifyStudentAssets(temporary)); rmSync(asset("model.js"));
    writeFileSync(asset("model.js"), "fixture");
    writeFileSync(join(temporary, "wrangler.jsonc"), JSON.stringify({ assets: {} }));
    assert.throws(() => verifyStudentAssets(temporary));
  } finally { rmSync(temporary, { recursive: true }); }
});


test("#922 evaluation proxy has exactly D1 + ASSETS, but seed/inspect/revoke consume only D1", () => {
  const db = { prepare() {}, withSession() {} };
  const assets = { fetch() {} };
  const required = { EVALUATION_READ_DB: db, ASSETS: assets };
  assert.equal(evaluationD1(required), db);
  assert.equal(evaluationD1({ ASSETS: assets, EVALUATION_READ_DB: db }), db);
  for (const env of [undefined, null, [], {}, { EVALUATION_READ_DB: db },
    { ASSETS: assets }, { ...required, REMOTE_DB: db }, { ...required, AUTH_DB: db },
    { ...required, ASSETS: undefined }, { ...required, ASSETS: {} },
    { ...required, ASSETS: { fetch: "not a function" } },
    { ...required, EVALUATION_READ_DB: undefined },
    { ...required, EVALUATION_READ_DB: { prepare() {} } },
    { ...required, EVALUATION_READ_DB: { withSession() {} } },
    { ...required, EVALUATION_READ_DB: { ...db, prepare: null } }]) {
    assert.throws(() => evaluationD1(env), (error) =>
      error.message === "TRUSTED_EVALUATION_SEED_FAILED" && !("cause" in error));
  }
});
