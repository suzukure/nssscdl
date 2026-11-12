// #914: trusted memory -> official Cookie jar -> browser engine fetch only.
import { domProofCheckpoint } from "./trusted-browser-dom.mjs";
import { X509Certificate } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { connect } from "node:tls";
import { check, checkError, checkSuccess } from "./trusted-https-assertions.mjs";
import { origin } from "./browser-tls-trust.mjs";

// Fixed installed runner binary; no environment-selected child authority.
export const browserBinary = "/usr/bin/google-chrome";
export const browserFailureCheckpoint = "#914 intentional failure: positive browser GETs and #922 DOM checks completed; public browser close / Worker and port stopped / proxy inspect and secret scan completed; unit terminal and owned removal unconfirmed";
export function browserEvidence(stdout, intentional = false) {
  const newline = stdout.indexOf("\n");
  const certificate = stdout.slice(0, newline);
  check(/^certificate: SHA256=(?:[0-9A-F]{2}:){31}[0-9A-F]{2}; SAN=127\.0\.0\.1; same Node\/Worker cert$/.test(certificate));
  check(stdout.slice(newline + 1) === (intentional ? browserFailureCheckpoint : browserProofCheckpoint) + "\n");
  return certificate;
}
export const browserProofCheckpoint = [
  "#914: NSS P,, / strict browser TLS positive and two negative probes / same cert and fixed-port serial handoff passed",
  "TC-F-001/002/005/207 partial: real same-origin browser fetch; self/other schedule=200 history=200 csrf=200; exact five views / owner-only history / distinct session CSRF passed",
  "TC-NF-914 partial: host-only Secure HttpOnly SameSite=Lax Path=/; isolated contexts; missing/foreign three GETs=401; no-store / no CORS / 401 clear / csrf no-referrer; secret non-exposure passed",
  "TC-F-207/211 partial: Worker stopped / port closed / self-only revocation / proxy disposed / same-cert restart; self three GETs=401 / other three GETs=200; D1 snapshot preserved passed",
  domProofCheckpoint,
  "#914: public browser close / Worker and port stopped / final read-only inspect / owned secret scan passed; unit terminal and owned removal unconfirmed; local browser read-only partial evidence only; Preview/Confirm/Gate A-D unverified",
].join("\n");

export function browserPreflight() {
  try {
    check(!process.env.DEBUG && !process.env.PWDEBUG && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0");
    const stat = lstatSync(browserBinary);
    check(stat.isFile() || stat.isSymbolicLink());
    check(JSON.parse(readFileSync("node_modules/playwright-core/package.json", "utf8")).version === "1.64.0");
  } catch { throw new Error("TRUSTED_BROWSER_PREFLIGHT_FAILED; runtime unverified"); }
}

// Preserve the existing fail-closed proxy contract across browser cleanup:
// an unknown operation/dispose cannot be followed by another proxy connection.
export async function withStoppedProxy(state, operation) {
  check(state.stopped() && !state.unknown);
  state.unknown = true;
  const result = await operation();
  state.unknown = false;
  return result;
}

export function browserCookie(cookie) {
  check(cookie.name === "__Host-student_session" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(cookie.value) &&
    cookie.path === "/" && cookie.secure === true && cookie.httpOnly === true && cookie.sameSite === "Lax" && !("domain" in cookie));
  // Playwright's url alternative derives host-only and Path=/ from the root URL;
  // domain/path must not accompany url. Verify the actual jar after injection.
  return { name: cookie.name, value: cookie.value, url: origin + "/", secure: true, httpOnly: true, sameSite: "Lax" };
}

export async function injectCookie(context, cookie) {
  check((await context.cookies()).length === 0);
  await context.addCookies([browserCookie(cookie)]);
  const jar = await context.cookies(origin);
  check(jar.length === 1 && jar[0].name === cookie.name && jar[0].value === cookie.value &&
    jar[0].domain === "127.0.0.1" && jar[0].path === "/" && jar[0].secure && jar[0].httpOnly &&
    jar[0].sameSite === "Lax" && jar[0].expires === -1);
}

export function checkCertificate(certificate) {
  const x509 = new X509Certificate(readFileSync(certificate.cert));
  check(x509.fingerprint256 === certificate.fingerprint && x509.checkIP("127.0.0.1") === "127.0.0.1" &&
    x509.subjectAltName === "IP Address:127.0.0.1");
  return x509;
}

// This strict TLS peer check verifies listener certificate identity only.
// All business proof below still comes from browser fetch, never this socket.
export async function checkWorkerCertificate(certificate) {
  const x509 = checkCertificate(certificate);
  await new Promise((done, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 8788, ca: x509.toString(), rejectUnauthorized: true });
    let verified = false;
    socket.setTimeout(5000, () => socket.destroy(new Error("TRUSTED_HTTPS_PROOF_FAILED")));
    socket.once("secureConnect", () => {
      verified = socket.authorized && socket.getPeerCertificate().fingerprint256 === certificate.fingerprint;
      socket.end();
    });
    socket.once("error", reject);
    socket.once("close", () => verified ? done() : reject(new Error("TRUSTED_HTTPS_PROOF_FAILED")));
  });
}

export function checkNonExposure(response, sessions, hashes, csrfValues) {
  check([...sessions, ...hashes, ...csrfValues].every((value) => !JSON.stringify(response.headers).includes(value)));
  check([...sessions, ...hashes].every((value) => !response.body.includes(value)));
}

export async function browserGet(page, path, signal) {
  signal.throwIfAborted();
  check(page.url().startsWith(origin + "/") && /^\/api\/(me\/(schedule-months\/\d{4}-\d{2}|reservations)|auth\/student\/csrf)$/.test(path));
  const [response, fetched] = await Promise.all([
    page.waitForResponse((r) => r.url() === origin + path && r.request().method() === "GET", { timeout: 5000 }),
    page.evaluate(async (target) => {
      const response = await fetch(target, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
      const body = await response.text();
      if (body.length > 4096) throw new Error("response limit");
      return { status: response.status, body };
    }, path),
  ]);
  check(response.status() === fetched.status && response.request().redirectedFrom() === null);
  const requestHeaders = await response.request().allHeaders();
  check(requestHeaders["sec-fetch-site"] === "same-origin"); // Observe engine metadata; never force it.
  const headers = await response.allHeaders(); // Fetch hides Set-Cookie; driver observes it in memory.
  if (headers["set-cookie"] !== undefined) headers["set-cookie"] = [headers["set-cookie"]];
  signal.throwIfAborted();
  return { ...fetched, headers };
}

export async function proveBrowserReads({ browser, context, signal, seed, secrets, hashes, start, stop, revoke, inspect, failAfterPositive = false, proveDom }) {
  check(browser);
  const self = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
  const other = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
  const missing = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
  const foreign = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
  check(new Set([context, self, other, missing, foreign]).size === 5);
  await injectCookie(self, seed.sessions.self.cookie());
  await injectCookie(other, seed.sessions.other.cookie());
  check((await missing.cookies()).length === 0);
  const raw = seed.sessions.self.cookie();
  const tampered = { ...raw, value: (raw.value[0] === "A" ? "B" : "A") + raw.value.slice(1) };
  check(tampered.value !== seed.sessions.other.cookie().value);
  secrets.push(tampered.value);
  await injectCookie(foreign, tampered);
  const contexts = { self, other, missing, foreign };
  const pages = {};
  await start();
  for (const [owner, ctx] of Object.entries(contexts)) {
    pages[owner] = await ctx.newPage();
    // An existing 503 JSON document establishes the origin. No asset route/mock.
    const response = await pages[owner].goto(origin + "/unknown", { waitUntil: "load", timeout: 5000 });
    check(response && response.url() === origin + "/unknown");
    checkError({ status: response.status(), headers: await response.allHeaders(), body: await response.text() }, 503);
    check(await pages[owner].evaluate(() => document.cookie) === "");
  }
  const paths = [`/api/me/schedule-months/${seed.month}`, "/api/me/reservations", "/api/auth/student/csrf"];
  const kinds = ["schedule", "history", "csrf"];
  const csrfValues = [];
  const getAll = async (owner, status) => {
    for (const [i, path] of paths.entries()) {
      const response = await browserGet(pages[owner], path, signal);
      checkNonExposure(response, secrets.slice(0, 3), hashes, csrfValues);
      if (status === 200) {
        const csrf = checkSuccess(response, kinds[i], seed, owner);
        if (csrf) { csrfValues.push(csrf); secrets.push(csrf); }
      } else {
        checkError(response, status, i === 2);
        check((await contexts[owner].cookies(origin)).length === 0);
      }
    }
  };
  await getAll("self", 200); await getAll("other", 200);
  check(csrfValues.length === 2 && csrfValues[0] !== csrfValues[1]);
  if (proveDom) await proveDom(pages.self, signal);
  if (failAfterPositive) throw new Error("TRUSTED_BROWSER_INTENTIONAL_FAILURE");
  await getAll("missing", 401); await getAll("foreign", 401);
  await stop();
  await inspect();
  await revoke();
  await inspect();
  await start();
  await getAll("self", 401); await getAll("other", 200);
  if (proveDom) await proveDom(pages.self, signal, true);
  // Helper performs public Browser.close before final Worker stop; outer owner verifies unit no-live.
}
