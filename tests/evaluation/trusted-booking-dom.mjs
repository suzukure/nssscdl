// #941: dormant, test-only, one-booking DOM consumer. No CLI/runtime wiring.
// Owner supplies a fresh strict context (ignoreHTTPSErrors:false,
// serviceWorkers:"block"), injected self Cookie, and owns all teardown.
import { unauthenticatedBookingResponseFaults } from "./trusted-unauthenticated-booking-report.mjs";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { parsePreview, parseConfirm, intervalLabel, dateTimeLabel, validMonth,
  validDateTime, classificationLabels } from "../../src/web/model.ts";
import { expectedHistory } from "./trusted-https-assertions.mjs";
import { tokyoNowMonth } from "../../src/web/model.ts";

export const bookingOrigin = "https://127.0.0.1:8789";
const timeout = 5000; // Same per-operation bound as the existing read-only DOM helper.
const spent = new WeakSet();
const assets = new Map([["/student", "text/html"], ["/student.css", "text/css"],
  ...["student", "view", "controller", "model"].map(n => [`/${n}.js`, "text/javascript"])]);
const previewPath = "/api/me/reservations/preview", confirmPath = "/api/me/reservations";
const csrfPath = "/api/auth/student/csrf";
const failure = reason => new Error(`TRUSTED_BOOKING_DOM_${reason}`);
const assertions = new WeakSet();
const check = condition => {
  if (!condition) { const error = failure("ASSERTION"); assertions.add(error); throw error; }
};

// Shared assertion seam for isolated finite fixtures, never a fetch/mock adapter.
// Compare every displayed change in order; do not export HTML or comparison data.
export async function assertBookingReviewDom(page, view, classification, run = action => action()) {
  const paragraphs = await run(() => page.locator("#operation-content > p").allTextContents());
  check(paragraphs[0] === intervalLabel(view.slot));
  check(paragraphs[1] === `区分：${classificationLabels[classification]}`);
  check(await run(() => page.locator("#operation-content h3").textContent()) === "既存の本人予約への区分変更");
  const changes = view.classificationChanges.map(c => `${dateTimeLabel(c.startsAt)}（日本時間）：${classificationLabels[c.before]} → ${classificationLabels[c.after]}`);
  check(isDeepStrictEqual(await run(() => page.locator("#operation-content li").allTextContents()), changes));
  check(changes.length > 0 || paragraphs.includes("区分変更はありません。"));
  if (classification === "additional") check(paragraphs.includes("現在は追加区分ですが、他予約のキャンセル等によりLesson開始前までは後から再分類される場合があります。"));
}

// #1002: prepared negative consumer only. The owner supplies a fresh, empty
// strict-TLS / serviceWorkers:"block" context and owns its terminal teardown.
// No Cookie injection, synthetic responses, lifecycle, D1, report, or CLI.
export async function proveUnauthenticatedBookingDom({ context, fixture, signal, onFault }) {
  const failed = () => new Error("TRUSTED_UNAUTHENTICATED_BOOKING_DOM_FAILED");
  let terminal = false, page, navigationCount = 0, explicitPath;
  // Passive bounded first-fault classification only. No headers, routes, URLs,
  // response bodies, identities or exception strings leave the DOM helper.
  let observingFault = true, faultReported = false, faultStage = "dom-setup";
  const stages = new Set(["dom-setup", "dom-net", "dom-request", "dom-response", "dom-ui", ...unauthenticatedBookingResponseFaults]);
  const reportFault = stage => {
    if (faultReported || !observingFault || !stages.has(stage)) return;
    faultReported = true;
    try { if (typeof onFault === "function") onFault(stage); }
    catch { /* A diagnostic consumer cannot change DOM behavior. */ }
  };
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = () => { if (!terminal) { terminal = true; rejectStopped(failed()); } };
  const require = condition => { if (!condition) { stop(); throw failed(); } };
  const alive = () => {
    require(!terminal && !signal.aborted);
    if (navigationCount) require(page.url() === bookingOrigin + "/student");
  };
  const step = async (action, fault) => {
    alive(); let timer;
    try {
      const result = await Promise.race([stopped,
        Promise.resolve().then(() => { alive(); return action(); }),
        new Promise((_, reject) => { timer = setTimeout(() => { if (fault) reportFault(fault); stop(); reject(failed()); }, timeout); })]);
      alive(); return result;
    } catch { if (fault) reportFault(fault); stop(); throw failed(); }
    finally { clearTimeout(timer); }
  };
  const requests = new Map(), responses = new Map(), counts = new Map(), pending = new Set();
  const initialMonth = tokyoNowMonth(); // Same initial month as src/web/student.ts.
  const monthPath = month => `/api/me/schedule-months/${month}`;
  const deletion = "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  const body = JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } });
  const guidance = "認証が必要です。認証後に画面を開き直してください。";
  // Closed non-secret response header values; no arbitrary diagnostic headers.
  const safeHeaders = (headers, path, api, demand = require) => {
    const rules = {
      "content-type": api ? /^application\/json(?:;\s*charset=utf-8)?$/i :
        new RegExp(`^${assets.get(path)}(?:;\\s*charset=utf-8)?$`, "i"),
      "cache-control": /^no-store$/,
      "content-length": /^\d{1,8}$/,
      "date": /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
      "connection": /^(keep-alive|close)$/,
      "keep-alive": /^timeout=\d{1,3}(?:, max=\d{1,6})?$/,
      "transfer-encoding": /^chunked$/,
      "content-encoding": /^(gzip|br|deflate)$/,
      "vary": /^Accept-Encoding$/i,
      "referrer-policy": /^no-referrer$/,
      ...(api ? { "set-cookie": { test: value => value === deletion } } : { "x-content-type-options": /^nosniff$/ }),
    };
    demand(Object.entries(headers).every(([name, value]) => typeof value === "string" && rules[name]?.test(value)));
    demand(rules["content-type"].test(headers["content-type"]) && headers["cache-control"] === "no-store");
    if (api) demand(headers["set-cookie"] === deletion);
    else demand(headers["x-content-type-options"] === "nosniff" && headers["referrer-policy"] === "no-referrer");
    if (path === csrfPath) demand(headers["referrer-policy"] === "no-referrer");
  };
  const emptyJar = async (demand = require, fault) => demand(isDeepStrictEqual(await step(() => context.cookies(), fault), []));
  const drain = async () => {
    await step(async () => {
      // Route completion can enqueue response validation. Drain both generations
      // under one bound; never return while an admitted response is unchecked.
      do {
        alive(); await Promise.all([...pending]); alive();
        const missing = [...requests.keys()].filter(request => !responses.has(request));
        await Promise.all(missing.map(request => page.waitForResponse(response => response.request() === request, { timeout })));
        alive();
      } while (pending.size);
    });
    alive();
    require([...requests.keys()].every(request => responses.has(request)));
  };
  const onAbort = () => stop();
  try {
    require(signal && typeof signal.addEventListener === "function" && !signal.aborted);
    require(context && typeof context === "object" && !spent.has(context));
    spent.add(context); // No reuse after success, failure, or concurrent invocation.
    require(context.browser() && context.pages().length === 0 && context.serviceWorkers().length === 0);
    require(fixture && isDeepStrictEqual(Object.keys(fixture), ["month"]) && validMonth(fixture.month));
    const targets = [monthPath(fixture.month), confirmPath, csrfPath];
    const initialPaths = new Set([monthPath(initialMonth), confirmPath]);
    signal.addEventListener("abort", onAbort, { once: true });
    await emptyJar();
    // Retained even after return/failure: late routes are denied until owner close.
    await step(() => context.route("**/*", route => {
      const task = (async () => {
        try {
          alive();
          const requestGuard = ok => { if (!ok) reportFault("dom-request"); require(ok); };
          const request = route.request(), rawUrl = request.url(), url = new URL(rawUrl), path = url.pathname;
          requestGuard(url.origin === bookingOrigin && rawUrl === bookingOrigin + path && !url.username && !url.password &&
            !url.search && !url.hash && request.method() === "GET" && request.postData() === null &&
            request.redirectedFrom() === null && request.frame() === page.mainFrame());
          requestGuard(assets.has(path) || (explicitPath ? path === explicitPath : initialPaths.has(path)));
          requestGuard(!counts.has(path)); counts.set(path, 1);
          requestGuard(request.isNavigationRequest() === (path === "/student") &&
            (path !== "/student" || navigationCount === 0));
          const headers = await step(() => request.allHeaders());
          const browserHeaders = new Set(["accept", "accept-language", "accept-encoding", "user-agent", "host",
            "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
            "sec-fetch-user", "priority", "cache-control", "pragma", "upgrade-insecure-requests", "origin", "referer", "content-length"]);
          requestGuard(Object.keys(headers).every(name => browserHeaders.has(name)));
          requestGuard(!Object.hasOwn(headers, "cookie") && !Object.hasOwn(headers, "authorization") &&
            !Object.hasOwn(headers, "x-csrf-token") && !Object.hasOwn(headers, "content-type") &&
            !Object.hasOwn(headers, "transfer-encoding") &&
            (!Object.hasOwn(headers, "content-length") || headers["content-length"] === "0"));
          requestGuard(!Object.hasOwn(headers, "origin") || headers.origin === bookingOrigin);
          requestGuard(!Object.hasOwn(headers, "host") || headers.host === "127.0.0.1:8789");
          // Missing Fetch Metadata is unobserved (#992), never fabricated.
          requestGuard(!Object.hasOwn(headers, "sec-fetch-site") || headers["sec-fetch-site"] === "same-origin" ||
            path === "/student" && headers["sec-fetch-site"] === "none");
          requestGuard(!Object.hasOwn(headers, "referer") || headers.referer === bookingOrigin + "/student");
          requestGuard(!Object.hasOwn(headers, "sec-fetch-mode") || headers["sec-fetch-mode"] ===
            (path === "/student" ? "navigate" : path === "/student.css" ? "no-cors" : "cors"));
          requestGuard(!Object.hasOwn(headers, "sec-fetch-dest") || headers["sec-fetch-dest"] ===
            (path === "/student" ? "document" : path === "/student.css" ? "style" : assets.has(path) ? "script" : "empty"));
          requestGuard(!Object.hasOwn(headers, "sec-fetch-user") || path === "/student" && headers["sec-fetch-user"] === "?1");
          if (!assets.has(path)) requestGuard(headers.accept === "application/json");
          await emptyJar(); alive();
          requests.set(request, path);
          await step(() => route.continue()); // No fetch/fulfill/header rewrite/retry.
        } catch { reportFault("dom-request"); stop(); try { await route.abort(); } catch { /* owner teardown */ } }
      })();
      pending.add(task); task.finally(() => pending.delete(task));
      return task;
    }));
    // A routed WebSocket is never connected to its server. Keep this deny route
    // alongside the HTTP guard; owner closes the context, including late sockets.
    await step(() => context.routeWebSocket("**/*", () => stop()));
    const onPage = candidate => { if (page && candidate !== page) stop(); };
    context.on("page", onPage);
    context.on("serviceworker", stop);
    page = await step(() => context.newPage());
    require(context.pages().length === 1 && context.pages()[0] === page);
    page.on("popup", stop); page.on("websocket", stop); page.on("download", stop);
    page.on("framenavigated", frame => {
      try {
        if (frame !== page.mainFrame() || ++navigationCount !== 1 || frame.url() !== bookingOrigin + "/student") stop();
      } catch { stop(); }
    });
    page.on("requestfailed", () => { reportFault("dom-request"); stop(); });
    page.on("response", response => {
      if (terminal) return;
      const task = step(async () => {
        const responseGuard = stage => ok => { if (!ok) reportFault(stage); require(ok); };
        const request = response.request(), path = requests.get(request);
        responseGuard("dom-rsp-id")(path && !responses.has(request) && response.url() === request.url() && !response.fromServiceWorker());
        responses.set(request, response);
        const api = !assets.has(path);
        responseGuard("dom-rsp-code")(response.status() === (api ? 401 : 200));
        safeHeaders(await step(() => response.allHeaders(), "dom-rsp-drv"), path, api, responseGuard("dom-rsp-hdr"));
        if (api) responseGuard("dom-rsp-body")(await step(() => response.text(), "dom-rsp-drv") === body);
        await emptyJar(responseGuard("dom-rsp-jar"), "dom-rsp-drv");
      }, "dom-rsp-drv").catch(() => { reportFault("dom-rsp-drv"); stop(); });
      pending.add(task); task.finally(() => pending.delete(task));
    });
    faultStage = "dom-net";
    const navigation = await step(() => page.goto(bookingOrigin + "/student", { waitUntil: "load", timeout }));
    require(navigation && navigation.status() === 200 && navigationCount === 1);
    await step(() => page.getByRole("heading", { name: "生徒の予定・本人履歴", exact: true }).waitFor({ timeout }));
    faultStage = "dom-ui";
    const inspectDom = async () => {
      await step(() => page.waitForFunction(() => ["#schedule-content", "section ol", "#operation-content"]
        .every(selector => document.querySelector(selector)?.getAttribute("aria-busy") === "false"), undefined, { timeout }));
      for (const selector of ["#schedule-status", "#history-status", "#operation-status"])
        require(await step(() => page.locator(selector).textContent()) === guidance);
      for (const selector of ["section ol li", ".slot", "#operation-content > *"])
        require(await step(() => page.locator(selector).count()) === 0);
      require(await step(() => page.locator("#selection-status").textContent()) === "");
      require(await step(() => page.locator("#schedule-month").isDisabled()));
      for (const name of ["この月を取得", "前の月", "次の月", "履歴を最新から再取得", "履歴の次ページ",
        "選択枠の予約内容をPreview", "内容を確認して予約を確定"])
        require(await step(() => page.getByRole("button", { name, exact: true }).isDisabled()));
      require(await step(() => page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        return document.cookie === "" && !document.querySelector('[aria-pressed="true"].slot') &&
          !/expectedStateToken|csrfToken|studentId|reservationId|token_hash|seed-self|seed-other|@/.test(html);
      })));
    };
    await inspectDom(); await drain();
    require([...assets.keys()].every(path => counts.has(path)));
    // At least one real initial API response must have caused DOM stop before
    // any explicit GET. Never substitute a synthetic API response into the UI.
    require([...responses.keys()].some(request => initialPaths.has(requests.get(request))));
    for (const path of targets) {
      if (counts.has(path)) continue; // Never retry an admitted/cancelled request.
      explicitPath = path;
      await step(() => page.evaluate(async path => {
        // Browser-native fetch; its actual Request/Response events are the proof.
        const response = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store",
          redirect: "error", headers: { Accept: "application/json" } });
        await response.arrayBuffer(); // Consume body without exporting it.
      }, path));
      await drain(); require(counts.has(path)); explicitPath = undefined;
    }
    await inspectDom(); await drain(); await emptyJar();
    require(context.pages().length === 1 && context.serviceWorkers().length === 0);
    terminal = true;
    return undefined; // No live proof/report checkpoint or booking identity.
  } catch { reportFault(faultStage); stop(); throw failed(); }
  finally {
    observingFault = false;
    try { signal?.removeEventListener?.("abort", onAbort); } catch { throw failed(); }
  }
}

export async function proveTrustedBookingDom({ browser, context, session, seed, signal, observe }) {
  let reason, terminal = false, observerClosed = false, page, phase = "initial", navigationCount = 0;
  const requests = new Map(), responses = new Map(), seenAssets = new Map();
  let previewCount = 0, confirmCount = 0, csrfCount = 0, expectedToken, writeLevel = 0;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  // Only fixed primitive pairs cross this synchronous test-only seam.
  const notify = (kind, value) => {
    if (observerClosed) return;
    try { if (observe?.(kind, value) !== undefined) throw failure("ASSERTION"); }
    catch {
      observerClosed = true;
      if (context && typeof context === "object") spent.add(context);
      stop("ASSERTION", "unknown"); throw failure(reason);
    }
  };
  const stop = (value, fault = { REQUEST: "request", RESPONSE: "response", NAVIGATION: "navigation",
    NETWORK_UNKNOWN: "network", TIMEOUT: "timeout", ABORTED: "abort", ASSERTION: "assertion" }[value]) => {
    if (reason || terminal) return;
    reason = value; terminal = true;
    try { notify("fault", fault); } catch { /* retain first failure; observer is closed */ }
    rejectStopped(failure(reason));
  };
  const entered = value => { alive(); notify("dom", value); alive(); };
  const write = value => {
    alive();
    const level = ["unobserved", "action-start", "request-seen", "route-allowed", "response-201"].indexOf(value);
    if (level <= writeLevel) return;
    writeLevel = level; notify("write", value); alive();
  };
  const alive = () => {
    if (signal?.aborted) stop("ABORTED");
    if (reason) throw failure(reason);
    check(!terminal);
    if (page && phase !== "initial" && page.url() !== bookingOrigin + "/student") {
      stop("NAVIGATION"); throw failure(reason);
    }
  };
  // Race also covers driver operations without a native Playwright timeout.
  // A pending operation cannot resume the caller after failure; the retained
  // context route blocks its late traffic until the owner closes the context.
  const step = async (action, fault = "driver") => {
    alive(); let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => { alive(); return action(); }), stopped,
        new Promise((_, reject) => { timer = setTimeout(() => { stop("TIMEOUT"); reject(failure(reason)); }, timeout); })]);
      alive(); return result;
    } catch (error) {
      stop(error?.name === "TimeoutError" ? "TIMEOUT" : "ASSERTION",
        error?.name === "TimeoutError" ? "timeout" : assertions.has(error) ? "assertion" : fault);
      throw failure(reason);
    } finally { clearTimeout(timer); }
  };
  const onAbort = () => stop("ABORTED");
  try {
    entered("cookie-jar");
    check(signal && typeof signal.addEventListener === "function");
    signal.addEventListener("abort", onAbort, { once: true }); alive();
    check(browser && context?.browser() === browser && context.pages().length === 0 && !spent.has(context));
    spent.add(context); // Spent before the first asynchronous operation, even if it fails.
    check(session === seed?.sessions?.self && validMonth(seed.month) && seed.date === `${seed.month}-15`);
    const slot = { slotId: "seed-slot-bookable", startsAt: `${seed.date}T10:00:00+09:00`, endsAt: `${seed.date}T11:00:00+09:00`, view: "bookable" };
    check(validDateTime(slot.startsAt) && Date.parse(slot.startsAt) > Date.now());
    const cookie = session.cookie(), otherCookie = seed.sessions.other.cookie();
    check(cookie.name === "__Host-student_session" && cookie.path === "/" && cookie.secure && cookie.httpOnly && cookie.sameSite === "Lax" &&
      /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(cookie.value) && cookie.value !== otherCookie.value);
    const jar = await step(() => context.cookies());
    check(jar.length === 1 && jar[0].name === cookie.name && jar[0].value === cookie.value && jar[0].domain === "127.0.0.1" &&
      jar[0].path === "/" && jar[0].secure && jar[0].httpOnly && jar[0].sameSite === "Lax" && jar[0].expires === -1);
    const secrets = [cookie.value, otherCookie.value,
      ...[cookie, otherCookie].map(c => createHash("sha256").update(c.value).digest("hex"))];
    const expectedCsrf = createHash("sha256").update("student-csrf-v1:" + cookie.value).digest("base64url");
    secrets.push(expectedCsrf);
    const safeDom = () => step(() => page.evaluate(forbidden => {
      const dom = document.documentElement.outerHTML;
      return location.href === "https://127.0.0.1:8789/student" && document.cookie === "" &&
        forbidden.every(value => !dom.includes(value));
    }, [...secrets, "seed-other", "seed-reservation-other", "expectedStateToken", "csrfToken", "token_hash", "snapshot", "料金"])).then(check);
    // Guard before connection, including redirects/popups. No synthetic response,
    // APIRequestContext, page fetch injection, or owner lifecycle mutation.
    entered("route");
    await step(() => context.route("**/*", async route => {
      const request = route.request();
      try {
        if (terminal || signal.aborted) { if (signal.aborted) stop("ABORTED"); await route.abort(); return; }
        const url = new URL(request.url()), method = request.method();
        if (url.origin === bookingOrigin && url.pathname === confirmPath && method === "POST") write("request-seen");
        check(url.origin === bookingOrigin && !url.username && !url.password && !url.search && !url.hash && request.redirectedFrom() === null);
        check(request.frame().page() === page);
        if (method === "POST") {
          if (url.pathname === previewPath) {
            check(phase === "preview" && ++previewCount === 1 && confirmCount === 0);
          } else {
            check(url.pathname === confirmPath && phase === "confirm" && previewCount === 1 && ++confirmCount === 1);
          }
          check(isDeepStrictEqual(request.postDataJSON(), url.pathname === previewPath ? { slotId: slot.slotId } :
            { slotId: slot.slotId, expectedStateToken: expectedToken }));
          const headers = await step(() => request.allHeaders());
          // Network-stack Fetch Metadata may be absent before continue; absence
          // is unobserved, not evidence of the eventual wire value (#992).
          check(headers.origin === bookingOrigin &&
            (!Object.hasOwn(headers, "sec-fetch-site") || headers["sec-fetch-site"] === "same-origin") &&
            headers["content-type"] === "application/json" && headers["x-csrf-token"] === expectedCsrf);
        } else {
          check(method === "GET" && (assets.has(url.pathname) || url.pathname === "/favicon.ico" || url.pathname === confirmPath || url.pathname === csrfPath ||
            /^\/api\/me\/schedule-months\/\d{4}-(0[1-9]|1[0-2])$/.test(url.pathname)));
          if (url.pathname === csrfPath) check(phase === "preview" && ++csrfCount === 1);
          if (request.isNavigationRequest()) check(url.pathname === "/student" && phase === "initial");
        }
        alive(); // In particular, abort during request-header observation cannot forward a write.
        requests.set(request, { path: url.pathname, method });
        if (url.pathname === confirmPath && method === "POST") write("route-allowed");
        await route.continue();
      } catch { stop("REQUEST"); try { await route.abort(); } catch { /* owner teardown */ } }
    }));
    page = await step(() => context.newPage());
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame() && (++navigationCount !== 1 || frame.url() !== bookingOrigin + "/student")) stop("NAVIGATION");
    });
    page.on("requestfailed", () => { if (!terminal) stop("NETWORK_UNKNOWN"); });
    page.on("response", response => {
      try {
        if (terminal) return;
        const request = response.request(), identity = requests.get(request);
        check(identity && response.url() === request.url() && !response.fromServiceWorker() && !responses.has(request));
        responses.set(request, response);
        if (assets.has(identity.path)) seenAssets.set(identity.path, response);
        if (identity.method === "POST") check(response.status() === (identity.path === previewPath ? 200 : 201));
        if (identity.path === confirmPath && identity.method === "POST") write("response-201");
      } catch { stop("RESPONSE"); }
    });
    const settled = selector => step(() => page.waitForFunction(selector =>
      document.querySelector(selector)?.getAttribute("aria-busy") === "false", selector, { timeout }));
    const click = name => step(() => page.getByRole("button", { name, exact: true }).click({ timeout }));
    const api = async (response, path, method, status) => {
      check(response && responses.get(response.request()) === response && requests.get(response.request())?.path === path &&
        response.request().method() === method && response.url() === bookingOrigin + path && response.status() === status);
      const headers = await step(() => response.allHeaders());
      check(headers["cache-control"] === "no-store" && /^application\/json(?:;|$)/.test(headers["content-type"]) &&
        !headers["set-cookie"] && !Object.keys(headers).some(n => n.startsWith("access-control-")) &&
        secrets.every(s => !JSON.stringify(headers).includes(s)));
      if (path === csrfPath) check(headers["referrer-policy"] === "no-referrer");
      return step(() => response.json());
    };
    const observeClick = async (name, path, method, status) => {
      // Listener is installed before the explicit accessible action.
      const [response] = await step(() => Promise.all([
        page.waitForResponse(r => r.url() === bookingOrigin + path && r.request().method() === method, { timeout }),
        Promise.resolve().then(() => {
          alive();
          if (path === confirmPath && method === "POST") write("action-start");
          return page.getByRole("button", { name, exact: true }).click({ timeout });
        }),
      ]));
      return api(response, path, method, status);
    };
    entered("navigation");
    const navigation = await step(() => page.goto(bookingOrigin + "/student", { waitUntil: "load", timeout }));
    check(navigation && navigation.status() === 200 && navigation.url() === bookingOrigin + "/student" && navigationCount === 1);
    phase = "select";
    await step(() => page.getByRole("heading", { name: "生徒の予定・本人履歴", exact: true }).waitFor({ timeout }));
    entered("assets");
    for (const [path, mime] of assets) {
      const asset = seenAssets.get(path), headers = asset && await step(() => asset.allHeaders());
      check(asset?.status() === 200 && headers["content-type"].startsWith(mime) && headers["cache-control"] === "no-store" && !headers["set-cookie"]);
    }
    entered("initial-ui");
    await settled("#schedule-content"); await settled("section ol");
    await step(() => page.locator("#schedule-month").fill(seed.month, { timeout }));
    await click("この月を取得"); await settled("#schedule-content");
    const historyText = item => [intervalLabel(item), "予約状態：予約済み", "欠席状態：なし", "現在の区分：標準"].join("");
    const initialHistory = expectedHistory(seed, "self");
    check(await step(() => page.locator("section ol li").allTextContents()).then(v => isDeepStrictEqual(v, initialHistory.items.map(historyText))));
    check(await step(() => page.getByRole("button", { name: "履歴の次ページ", exact: true }).isDisabled()));
    check(await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
    await safeDom();
    entered("selection");
    await click(`${intervalLabel(slot)}：予約可能`);
    check(await step(() => page.locator("#selection-status").textContent()).then(v => v.includes("予約は確定していません")));
    check(previewCount === 0 && confirmCount === 0 && csrfCount === 0);
    check(await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
    entered("preview");
    phase = "preview";
    const previewBody = await observeClick("選択枠の予約内容をPreview", previewPath, "POST", 200);
    const parsed = parsePreview(previewBody, slot);
    check(/^v1\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(parsed.token)); // Existing Confirm preparation format.
    check(isDeepStrictEqual(parsed.view, { slot: { slotId: slot.slotId, startsAt: slot.startsAt, endsAt: slot.endsAt }, previewClassification: "standard", classificationChanges: [] }));
    check(isDeepStrictEqual(previewBody, { ...parsed.view, expectedStateToken: parsed.token }));
    secrets.push(parsed.token);
    const csrfResponses = [...responses.values()].filter(r => r.url() === bookingOrigin + csrfPath);
    check(csrfResponses.length === 1);
    check(isDeepStrictEqual(await api(csrfResponses[0], csrfPath, "GET", 200), { csrfToken: expectedCsrf, scope: "session" }));
    await settled("#operation-content");
    entered("review");
    await step(() => assertBookingReviewDom(page, parsed.view, parsed.view.previewClassification, step), "unknown"); await safeDom();
    check(previewCount === 1 && confirmCount === 0);
    check(!await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
    expectedToken = parsed.token; // Enable the only write after all review assertions.
    entered("confirm");
    phase = "confirm";
    const confirmBody = await observeClick("内容を確認して予約を確定", confirmPath, "POST", 201);
    const confirmed = parseConfirm(confirmBody, slot), reservationId = confirmed.reservation.reservationId;
    check(reservationId !== "seed-reservation-self" && reservationId !== "seed-reservation-other" && secrets.every(s => !reservationId.includes(s)));
    check(isDeepStrictEqual(confirmBody, { reservation: { reservationId, startsAt: slot.startsAt, endsAt: slot.endsAt,
      reservationState: "confirmed", classification: "standard" }, slot: { ...parsed.view.slot, view: "reserved_by_me" }, classificationChanges: [] }));
    entered("confirm-ui");
    await settled("#operation-content"); await settled("#schedule-content");
    await step(() => assertBookingReviewDom(page, confirmed, confirmed.reservation.classification, step), "unknown");
    check(await step(() => page.locator("#operation-status").textContent()).then(v => v === "予約済みです。メールの配送完了を表すものではありません。"));
    check(await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
    check(await step(() => page.locator(".slot.reserved_by_me").allTextContents()).then(v => v.includes(`${intervalLabel(slot)}：本人予約済み／標準`)));
    entered("history");
    phase = "history";
    const history = await observeClick("履歴を最新から再取得", confirmPath, "GET", 200);
    const expectedItems = [...initialHistory.items, { ...confirmed.reservation, attendanceState: "none" }];
    check(isDeepStrictEqual(history, { items: expectedItems, nextCursor: null })); // startsAt DESC: 11:00 then 10:00.
    await settled("section ol");
    check(await step(() => page.locator("section ol li").allTextContents()).then(v => isDeepStrictEqual(v, expectedItems.map(historyText))));
    await safeDom(); alive(); check(previewCount === 1 && confirmCount === 1);
    entered("handoff");
    entered("complete");
    terminal = true; // Retain the deny guard. Owner closes context; never reuse it.
    return reservationId; // Only the actual Browser POST 201 identity; no readback claim.
  } catch (error) {
    stop(error?.name === "TimeoutError" ? "TIMEOUT" : "ASSERTION",
      assertions.has(error) ? "assertion" : "unknown");
    throw failure(reason); // No raw error, cause, URL, headers, payload, or PII.
  } finally { signal?.removeEventListener?.("abort", onAbort); }
}
