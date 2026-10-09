// Finite #914 fixtures, not real browser/Worker/D1 evidence.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cleanupOwned, handoffListener, origin } from "./browser-tls-trust.mjs";
import { browserCookie, browserEvidence, browserFailureCheckpoint, browserGet, browserProofCheckpoint, checkCertificate, checkNonExposure, injectCookie, proveBrowserReads, withStoppedProxy } from "./trusted-browser-reads.mjs";
import { expectedHistory, expectedSchedule } from "./trusted-https-assertions.mjs";
import { createCertificate } from "./local-https-smoke.mjs";

const cookie = (value = "A".repeat(43)) => ({ name: "__Host-student_session", value,
  path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
const fixed = (error) => error.message === "TRUSTED_HTTPS_PROOF_FAILED" && !["cause", "actual", "expected"].some((key) => key in error);

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
    const input = { context: {}, origin, certificate: { key: "owned/server.key", cert: "owned/server.pem" } };
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
  const input = { context: { browser: () => browser }, seed, signal: new AbortController().signal,
    secrets: [cookie().value, seed.sessions.other.cookie().value], hashes: [],
    start: async () => { assert.ok(!live); events.push("start"); live = true; },
    stop: async () => { assert.ok(live); events.push("stop"); live = false; },
    inspect: async () => { assert.ok(!live); events.push("inspect"); },
    revoke: async () => { assert.ok(!live && !revoked); events.push("revoke"); revoked = true; } };
  return { input, events };
}

test("#914 four ephemeral contexts: browser 3 GET per owner, no Worker/proxy overlap, self-only revocation before restart", async () => {
  const { input, events } = readFixture();
  // Expectations derive independently from #898 seed views / Application §10.
  assert.deepEqual(expectedSchedule(input.seed, "self").slots.map((slot) => slot.view),
    ["bookable", "reserved_by_me", "unavailable", "group_lesson", "unavailable"]);
  await proveBrowserReads(input);
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
