// Finite driver/DOM doubles: assertion/control flow evidence, never Chrome/TLS/D1 proof.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { unauthenticatedBookingResponseFaults } from "./trusted-unauthenticated-booking-report.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { useTrustedBookingProcess } from "./trusted-booking-process.mjs";
import { encodeBookingDiagnostic, parseBookingDiagnostic } from "./trusted-booking-report.mjs";
import { proveTrustedBookingDom, proveUnauthenticatedBookingDom, assertBookingReviewDom, bookingOrigin } from "./trusted-booking-dom.mjs";
import { tokyoNowMonth } from "../../src/web/model.ts";

const previewName = "選択枠の予約内容をPreview", confirmName = "内容を確認して予約を確定";
const previewPath = "/api/me/reservations/preview", confirmPath = "/api/me/reservations";
const csrfPath = "/api/auth/student/csrf";
const canary = "private-canary";
function fixture(fault = "", changePost = () => {}) {
  // Oracle: strict #898 seed (next Tokyo month, day15); BR-056 N=3,
  // Application §5/6/7/9.1 and src/web/view.ts accessible labels.
  const tokyo = new Date(Date.now() + 9 * 3600000);
  const date = new Date(Date.UTC(tokyo.getUTCFullYear(), tokyo.getUTCMonth() + 1, 15)).toISOString().slice(0, 10);
  const month = date.slice(0, 7), controller = new AbortController();
  const cookie = value => ({ name: "__Host-student_session", value, path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  const self = cookie("A".repeat(43)), other = cookie("B".repeat(42) + "A");
  const seed = { month, date, sessions: { self: { cookie: () => self }, other: { cookie: () => other } } };
  const csrf = createHash("sha256").update("student-csrf-v1:" + self.value).digest("base64url");
  const token = "v1." + "C".repeat(42) + "A", id = "fixture-created-reservation";
  const slot = { slotId: "seed-slot-bookable", startsAt: `${date}T10:00:00+09:00`, endsAt: `${date}T11:00:00+09:00` };
  const label = hour => `${date.slice(0, 4)}年${date.slice(5, 7)}月15日 ${hour}:00`;
  const interval = hour => `${label(hour)} ～ ${label(String(Number(hour) + 1))}（日本時間）`;
  const historyItem = (reservationId, hour) => ({ reservationId, startsAt: `${date}T${hour}:00:00+09:00`, endsAt: `${date}T${Number(hour) + 1}:00:00+09:00`,
    reservationState: "confirmed", attendanceState: "none", classification: "standard" });
  const initial = historyItem("seed-reservation-self", "11"), added = historyItem(id, "10");
  const preview = { slot, previewClassification: "standard", classificationChanges: [], expectedStateToken: token };
  const { attendanceState: _unused, ...reservation } = added;
  const confirm = { reservation, slot: { ...slot, view: "reserved_by_me" }, classificationChanges: [] };
  let resumeResponse, responsePendingResolve;
  const responsePending = new Promise(resolve => { responsePendingResolve = resolve; });
  let lastResponse, mode = "initial", routeHandler, currentUrl = "about:blank", pages = [], op;
  const events = [], forwarded = [], denied = [], waiters = [], page = new EventEmitter();
  const frame = { page: () => page, url: () => currentUrl };
  const emitResponse = async (path, method = "GET", body = {}, status = 200, navigation = false) => {
    const url = path.startsWith("https:") ? path : bookingOrigin + path;
    const requestHeaders = { origin: fault === "wrong-request-origin" ? "https://invalid.test" : bookingOrigin, "sec-fetch-site": "same-origin",
      "content-type": "application/json", "x-csrf-token": fault === "wrong-request-csrf" ? canary : csrf };
    const request = { url: () => url, method: () => method, redirectedFrom: () => fault === "redirect" && path === previewPath ? {} : null,
      frame: () => frame, isNavigationRequest: () => navigation,
      postDataJSON: () => fault === "identity-body" ? { slotId: slot.slotId, studentId: "seed-other" } :
        path === previewPath ? { slotId: slot.slotId } : { slotId: slot.slotId, expectedStateToken: fault === "wrong-confirm-token" ? canary : token },
      allHeaders: async () => {
        if ((fault === "abort-headers" || fault === "abort-confirm-headers" && path === confirmPath) && method === "POST") controller.abort(canary);
        return requestHeaders;
      } };
    if (method === "POST") changePost(request, requestHeaders, path);
    const asset = !path.startsWith("/api/");
    const headers = { "content-type": asset ? path === "/student" ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript" : "application/json",
      "cache-control": "no-store", ...(path === csrfPath ? { "referrer-policy": "no-referrer" } : {}) };
    if (fault === "header-secret" && path === previewPath) headers["private"] = self.value;
    if (fault === "set-cookie" && path === previewPath) headers["set-cookie"] = canary;
    const response = { request: () => fault === "response-identity" && path === confirmPath && method === "POST" ? { ...request } : request, url: () => fault === "response-origin" && path === previewPath ? "https://invalid.test/student" : url,
      status: () => status, fromServiceWorker: () => fault === "service-worker" && path === previewPath,
      allHeaders: async () => headers, json: async () => {
        if (fault === "json-unknown" && method === "POST" && path === confirmPath) throw new Error(canary);
        return structuredClone(body);
      } };
    lastResponse = response;
    let passed = false;
    await routeHandler({ request: () => request, abort: async () => { denied.push(path); }, continue: async (...args) => {
      assert.deepEqual(args, []); // No header override or request rewriting.
      if (fault === "forward-confirm" && path === confirmPath && method === "POST") throw new Error(canary);
      passed = true; forwarded.push(`${method} ${path}`);
      if (fault === "network-unknown" && method === "POST" && path === confirmPath) { page.emit("requestfailed", request); return; }
      if (fault === "pending-confirm" && method === "POST" && path === confirmPath)
        await new Promise(resolve => { resumeResponse = resolve; responsePendingResolve(); });
      page.emit("response", response);
      if (fault === "duplicate-response" && path === previewPath) page.emit("response", response);
      for (const waiter of [...waiters]) if (waiter.match(response)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(response); }
    } });
    return passed ? response : null;
  };
  const text = selector => {
    if (selector === "#selection-status") return "予約は確定していません";
    if (selector === "#operation-status") return fault === "false-success" ? "結果不明" : "予約済みです。メールの配送完了を表すものではありません。";
    if (selector === "#operation-content h3") return "既存の本人予約への区分変更";
    return "";
  };
  const texts = selector => {
    if (selector === "#operation-content > p") return [interval("10"), fault === "wrong-dom-classification" ? "区分：追加" : "区分：標準", "区分変更はありません。"];
    if (selector === "#operation-content li") return fault === "extra-dom-change" ? [canary] : [];
    if (selector === ".slot.reserved_by_me") return mode === "confirmed" || mode === "history" ? [`${interval("10")}：本人予約済み／標準`] : [];
    if (selector === "section ol li") {
      if (fault === "initial-history" && mode === "initial") return [];
      const hours = mode === "history" && fault !== "stale-history" ? ["11", "10"] : ["11"];
      return hours.map(hour => `${interval(hour)}予約状態：予約済み欠席状態：なし現在の区分：標準`);
    }
    throw new Error(canary);
  };
  const click = async name => {
    events.push(name);
    if (fault === "abort-selection" && name.endsWith("：予約可能")) controller.abort(canary);
    if (fault === "click-confirm" && name === confirmName) throw new Error(canary);
    if (name === previewName) {
      if (fault === "timeout-preview") { const e = new Error(canary); e.name = "TimeoutError"; throw e; }
      await emitResponse(csrfPath, "GET", { csrfToken: fault === "csrf-mismatch" ? canary : csrf, scope: "session" });
      if (fault === "abort-preview") controller.abort(canary);
      if (fault === "early-confirm") await emitResponse(confirmPath, "POST", confirm, 201);
      if (fault === "other-origin") await emitResponse("https://invalid.test/secret?private=canary");
      if (fault === "query") await emitResponse(previewPath + "?studentId=seed-other", "POST");
      if (fault === "navigation") { currentUrl = bookingOrigin + "/student?private=canary"; page.emit("framenavigated", frame); }
      if (fault === "extra-navigation") page.emit("framenavigated", frame);
      const data = structuredClone(preview);
      if (fault === "preview-slot") data.slot.slotId = "seed-slot-other";
      if (fault === "preview-changes") data.classificationChanges = [{ reservationId: "seed-reservation-self", startsAt: initial.startsAt, before: "standard", after: "additional" }];
      if (fault === "preview-token") delete data.expectedStateToken;
      if (fault === "preview-token-format") data.expectedStateToken = "v1." + "C".repeat(43);
      await emitResponse(previewPath, "POST", data, fault === "preview-403" ? 403 : 200);
      if (fault === "duplicate-preview") await emitResponse(previewPath, "POST", data);
      mode = "review"; op = data;
    } else if (name === confirmName) {
      const data = structuredClone(confirm);
      const badIds = { "id-empty": "", "id-null": null, "id-number": 42, "id-other": "seed-reservation-other", "id-secret": self.value, "id-token": token };
      if (Object.hasOwn(badIds, fault)) data.reservation.reservationId = badIds[fault];
      if (fault === "id-missing") delete data.reservation.reservationId;
      if (fault === "confirm-slot") data.slot.startsAt = initial.startsAt;
      if (fault === "confirm-state") data.reservation.reservationState = "student_cancelled";
      if (fault === "confirm-classification") data.reservation.classification = "additional";
      if (fault === "confirm-extra") data.private = canary;
      const status = fault === "confirm-409" ? 409 : fault === "confirm-503" ? 503 : fault === "confirm-200" ? 200 : 201;
      await emitResponse(confirmPath, "POST", data, status);
      if (fault === "duplicate-confirm") await emitResponse(confirmPath, "POST", data, 201);
      if (fault === "abort-confirm") controller.abort(canary);
      mode = "confirmed"; op = data;
    } else if (name === "履歴を最新から再取得") {
      await emitResponse(confirmPath, "GET", { items: fault === "other-history" ? [historyItem("seed-reservation-other", "12"), added] : [initial, added], nextCursor: null });
      mode = "history";
    } else if (name.endsWith("：予約可能")) {
      if (fault === "selection-write") await emitResponse(confirmPath, "POST", confirm, 201);
    }
  };
  Object.assign(page, {
    mainFrame: () => frame, url: () => currentUrl,
    goto: async url => {
      if (fault === "goto") throw new Error(canary);
      events.push("navigate"); currentUrl = url; page.emit("framenavigated", frame);
      const response = await emitResponse("/student", "GET", {}, 200, true);
      for (const path of ["/student.css", "/student.js", "/view.js", "/controller.js", "/model.js"]) {
        if (fault !== "missing-asset" || path !== "/model.js") await emitResponse(path);
      }
      await emitResponse("/favicon.ico", "GET", {}, 503); // Auxiliary request, never booking evidence.
      return fault === "null-navigation" ? null : response;
    },
    waitForFunction: async (fn, selector) => {
      checkFixtureFunction(fn, selector);
      if (fault === "abort-wait" && op) controller.abort(canary);
    },
    waitForResponse: match => fault === "null-post-response" ? Promise.resolve(null) : new Promise(resolve => waiters.push({ match, resolve })),
    evaluate: async (fn, forbidden) => {
      const exposure = fault === "secret-dom" && op ? token : fault === "other-dom" ? "seed-other" : "";
      return runInNewContext(`(${fn.toString()})(forbidden)`, { forbidden, document: { documentElement: { outerHTML: exposure }, cookie: "" }, location: { href: currentUrl } });
    },
    locator: selector => ({ fill: async value => { if (fault === "month") throw new Error(canary); events.push("month"); assert.equal(value, month); }, textContent: async () => text(selector), allTextContents: async () => texts(selector) }),
    getByRole: (_role, { name, exact }) => {
      assert.equal(exact, true);
      return { waitFor: async () => { if (fault === "heading") throw new Error(canary); }, click: () => click(name),
        isDisabled: async () => name === confirmName ? mode !== "review" : name === "履歴の次ページ" };
    },
  });
  const browser = {}, context = { browser: () => browser, pages: () => pages,
    cookies: async () => { if (fault === "cookie-jar") throw new Error(canary); return [{ ...self, domain: "127.0.0.1", expires: -1 }]; },
    route: async (pattern, handler) => { if (fault === "route") throw new Error(canary); assert.equal(pattern, "**/*"); routeHandler = handler; },
    newPage: async () => { if (fault === "page") throw new Error(canary); pages = [page]; return page; } };
  return { input: { browser, context, session: seed.sessions.self, seed, signal: controller.signal }, events, forwarded, denied, controller, id,
    responsePending, resumeResponse: () => resumeResponse(),
    lateResponse: () => page.emit("response", lastResponse),
    late: () => emitResponse(confirmPath, "POST", confirm, 201),
    stalledCookie: () => { context.cookies = () => new Promise(() => {}); },
    cookieChange: mutate => { context.cookies = async () => { const jar = [{ ...self, domain: "127.0.0.1", expires: -1 }]; mutate(jar); return jar; }; },
  };
}
function checkFixtureFunction(fn, selector) {
  assert.equal(runInNewContext(`(${fn.toString()})(selector)`, {
    selector, document: { querySelector: () => ({ getAttribute: () => "false" }) },
  }), true);
}

test("#941 finite success: navigation, explicit Preview200 then Confirm201 once, owner history +1, opaque handoff", async () => {
  const f = fixture();
  assert.equal(await proveTrustedBookingDom(f.input), f.id);
  assert.equal(f.events.filter(v => v === previewName).length, 1);
  assert.equal(f.events.filter(v => v === confirmName).length, 1);
  assert.ok(f.events.indexOf(previewName) < f.events.indexOf(confirmName));
  assert.deepEqual(f.forwarded.filter(v => v.startsWith("POST")), [`POST ${previewPath}`, `POST ${confirmPath}`]);
  await f.late(); assert.deepEqual(f.denied, [confirmPath]);
  await assert.rejects(proveTrustedBookingDom(f.input), { message: "TRUSTED_BOOKING_DOM_ASSERTION" });
});

test("#941 finite negative observations stop without retry/reload/reConfirm or secret errors", async () => {
  for (const fault of ["null-navigation", "null-post-response", "missing-asset", "selection-write", "early-confirm", "preview-403", "preview-slot", "preview-changes", "preview-token", "preview-token-format",
    "wrong-dom-classification", "extra-dom-change", "csrf-mismatch", "duplicate-preview", "duplicate-response", "other-origin", "response-origin", "redirect", "query",
    "navigation", "extra-navigation", "service-worker", "header-secret", "set-cookie", "secret-dom", "other-dom", "identity-body", "wrong-confirm-token", "wrong-request-origin", "wrong-request-csrf", "abort-headers", "id-empty", "id-null", "id-number", "id-other", "id-secret", "id-token", "id-missing",
    "confirm-slot", "confirm-state", "confirm-classification", "confirm-extra", "confirm-409", "confirm-503", "confirm-200", "duplicate-confirm", "json-unknown", "network-unknown", "false-success", "stale-history", "other-history",
    "abort-selection", "abort-preview", "abort-confirm", "abort-wait", "timeout-preview"]) {
    const f = fixture(fault), observations = [];
    f.input.observe = (kind, value) => { observations.push([kind, value]); };
    await assert.rejects(proveTrustedBookingDom(f.input), error => {
      assert.match(error.message, /^TRUSTED_BOOKING_DOM_(ASSERTION|REQUEST|RESPONSE|NAVIGATION|ABORTED|TIMEOUT|NETWORK_UNKNOWN)$/);
      assert.equal("cause" in error, false); assert.doesNotMatch(String(error), /private-canary|seed-other|v1\.|https:/);
      return true;
    });
    assert.ok(f.events.filter(v => v === confirmName).length <= 1, fault);
    assert.ok(f.events.filter(v => v === previewName).length <= 1, fault);
    assert.ok(f.forwarded.filter(v => v === `POST ${confirmPath}`).length <= 1, fault);
    if (fault.startsWith("preview-") || ["wrong-dom-classification", "extra-dom-change", "secret-dom", "csrf-mismatch"].includes(fault)) assert.ok(!f.events.includes(confirmName), fault);
    assert.equal(observations.filter(([kind]) => kind === "fault").length, 1, fault);
    const saved = structuredClone(observations);
    f.lateResponse();
    const calls = f.events.length; await f.late(); assert.deepEqual(observations, saved, fault); assert.equal(f.events.length, calls);
    assert.ok(f.denied.includes(confirmPath));
    await assert.rejects(proveTrustedBookingDom(f.input)); assert.equal(f.events.length, calls);
  }
});

test("#941 abort and real bounded timeout while a driver promise remains pending never perform subsequent actions", async () => {
  for (const kind of ["abort", "timeout"]) {
    const f = fixture(); f.stalledCookie();
    const running = proveTrustedBookingDom(f.input);
    if (kind === "abort") f.controller.abort(canary);
    await assert.rejects(running, { message: `TRUSTED_BOOKING_DOM_${kind === "abort" ? "ABORTED" : "TIMEOUT"}` });
    assert.deepEqual(f.events, []);
  }
});

test("#941 owner/browser/self Session/fresh Cookie boundaries are checked before navigation", async () => {
  for (const mutate of [f => { f.input.browser = {}; }, f => { f.input.session = f.input.seed.sessions.other; },
    f => { f.input.seed.date = `${f.input.seed.month}-16`; }, f => f.controller.abort(canary),
    ...[jar => { jar[0].httpOnly = false; }, jar => { jar[0].secure = false; }, jar => { jar[0].domain = "invalid.test"; },
      jar => { jar[0].sameSite = "None"; }, jar => jar.push({}), jar => { jar[0].value = canary; }].map(change => f => f.cookieChange(change))]) {
    const f = fixture(); mutate(f); await assert.rejects(proveTrustedBookingDom(f.input)); assert.deepEqual(f.events, []);
  }
});

test("#941 isolated review assertion checks all dates/before/after, missing/truncated/reordered differences and additional explanation", async () => {
  const view = { slot: { startsAt: "2027-01-15T10:00:00+09:00", endsAt: "2027-01-15T11:00:00+09:00" },
    classificationChanges: [
      { startsAt: "2027-01-16T11:00:00+09:00", before: "standard", after: "additional" },
      { startsAt: "2027-01-17T12:00:00+09:00", before: "additional", after: "standard" },
    ] };
  const changes = ["2027年01月16日 11:00（日本時間）：標準 → 追加", "2027年01月17日 12:00（日本時間）：追加 → 標準"];
  const paragraphs = ["2027年01月15日 10:00 ～ 2027年01月15日 11:00（日本時間）", "区分：追加",
    "現在は追加区分ですが、他予約のキャンセル等によりLesson開始前までは後から再分類される場合があります。"];
  const page = (items, ps = paragraphs) => ({ locator: selector => ({
    allTextContents: async () => selector.endsWith(" li") ? items : ps,
    textContent: async () => "既存の本人予約への区分変更",
  }) });
  await assertBookingReviewDom(page(changes), view, "additional");
  for (const items of [[], changes.slice(0, 1), changes.toReversed(), [...changes, canary], [changes[0].replace("標準 → 追加", "追加 → 標準"), changes[1]]]) {
    await assert.rejects(assertBookingReviewDom(page(items), view, "additional"), { message: "TRUSTED_BOOKING_DOM_ASSERTION" });
  }
  await assert.rejects(assertBookingReviewDom(page(changes, paragraphs.slice(0, 2)), view, "additional"));
});

test("#941 dormant helper has no production/default workflow caller or launch/cleanup capability", () => {
  const scan = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? scan(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
  for (const file of [...scan("src"), ...scan(".github/workflows")]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /trusted-booking-dom|proveTrustedBookingDom|proveUnauthenticatedBookingDom|assertBookingReviewDom/, file);
  }
  const source = readFileSync("tests/evaluation/trusted-booking-dom.mjs", "utf8");
  assert.doesNotMatch(source, /route\.(?:fetch|fulfill)|\.reload\(|\.addCookies\(|browser\.newContext|\.launch\(|\.close\(|child_process|wrangler|systemd/);
});

// #1002 oracle: Application §8 / §10.2 / §10.3 session-only branch,
// controller.ts 401 clear/stop and view.ts labels. All HTTP below is synthetic;
// executing inspector/fetch functions in a finite VM is not real Chrome proof.
function unauthenticatedFixture(options = {}) {
  const controller = new AbortController(), page = new EventEmitter(), context = new EventEmitter();
  const month = "2099-01", schedule = `/api/me/schedule-months/${month}`;
  const initialSchedule = `/api/me/schedule-months/${tokyoNowMonth()}`;
  const assets = ["/student", "/student.css", "/student.js", "/view.js", "/controller.js", "/model.js"];
  const forwarded = [], denied = [], explicit = [], waiters = [];
  const guidance = "認証が必要です。認証後に画面を開き直してください。";
  let handler, websocketHandler, currentUrl = "about:blank", pages = [], stoppedUi = false, lastResponse, resume, entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const frame = { page: () => page, url: () => currentUrl };
  const node = { getAttribute: () => "false" };
  const document = { cookie: "", documentElement: { outerHTML: "<main>認証が必要です。</main>" },
    querySelector: selector => selector.includes("aria-pressed") ? null : node };
  const controls = new Map(["この月を取得", "前の月", "次の月", "履歴を最新から再取得", "履歴の次ページ", previewName, confirmName]
    .map(name => [name, true]));
  const texts = new Map(["#schedule-status", "#history-status", "#operation-status"].map(selector => [selector, guidance]));
  texts.set("#selection-status", "");
  const lengths = new Map(["section ol li", ".slot", "#operation-content > *"].map(selector => [selector, 0]));
  const emit = async (path, method = "GET", navigation = false) => {
    const url = path.startsWith("https:") ? path : bookingOrigin + path, api = path.startsWith("/api/");
    const requestHeaders = api ? { accept: "application/json", "sec-fetch-site": "same-origin" } : {};
    // Asset oracle: reservation-worker.ts fixed response, also checked by #929 HTTP tests.
    const headers = { "content-type": api ? "application/json" : (path === "/student" ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript") + "; charset=utf-8",
      "cache-control": "no-store",
      ...(api ? { "set-cookie": "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT" } : {}),
      ...(!api ? { "x-content-type-options": "nosniff" } : {}),
      ...(!api || path === csrfPath ? { "referrer-policy": "no-referrer" } : {}) };
    const request = { url: () => url, method: () => method, postData: () => null, redirectedFrom: () => null,
      frame: () => frame, isNavigationRequest: () => navigation,
      allHeaders: async () => {
        if (options.stall === "headers" && path === csrfPath) { entered(); await new Promise(resolve => { resume = resolve; }); }
        if (options.abortHeaders && path === csrfPath) controller.abort(canary);
        return requestHeaders;
      } };
    const response = { request: () => request, url: () => url, status: () => api ? 401 : 200,
      fromServiceWorker: () => false, allHeaders: async () => headers,
      text: async () => {
        if (options.stall === "body" && path === csrfPath) { entered(); await new Promise(resolve => { resume = resolve; }); }
        return '{"error":{"code":"UNAUTHENTICATED","message":"認証が必要です。","retry":"none"}}';
      }, arrayBuffer: async () => new ArrayBuffer(0) };
    if ((options.targets ?? [options.target ?? csrfPath]).includes(path)) options.change?.({ request, response, requestHeaders, headers });
    if (options.absentSite) delete requestHeaders["sec-fetch-site"];
    let passed = false;
    await handler({ request: () => request, abort: async () => { denied.push(path); }, continue: async (...args) => {
      assert.deepEqual(args, []); passed = true; forwarded.push(`${method} ${path}`);
      if (navigation) page.emit("framenavigated", frame);
      if (options.networkFailure && path === csrfPath) { page.emit("requestfailed", request); return; }
      lastResponse = response; page.emit("response", response);
      if (path === csrfPath) options.afterCsrf?.({ document, controls, texts, lengths });
      if (options.duplicateResponse && path === csrfPath) page.emit("response", response);
      for (const waiter of [...waiters]) if (waiter.match(response)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(response); }
      if (api) stoppedUi = true; // Fixed 401 UI oracle; do not invoke the injected driver twice.
    } });
    return passed ? response : null;
  };
  Object.assign(page, {
    mainFrame: () => frame, url: () => currentUrl,
    goto: async url => {
      currentUrl = url;
      const response = await emit("/student", "GET", true);
      for (const path of assets.slice(1)) if (path !== options.missingAsset) await emit(path);
      for (const path of options.initial ?? [initialSchedule, confirmPath]) await emit(path);
      if (options.extra) await emit(...options.extra);
      return response;
    },
    waitForResponse: match => new Promise(resolve => waiters.push({ match, resolve })),
    waitForFunction: async fn => {
      if (!runInNewContext(`(${fn.toString()})()`, { document }) || !stoppedUi) {
        const error = new Error(canary); error.name = "TimeoutError"; throw error;
      }
    },
    getByRole: (role, { name, exact }) => {
      assert.equal(exact, true);
      return { waitFor: async () => { assert.equal(role, "heading"); assert.equal(name, "生徒の予定・本人履歴"); },
        isDisabled: async () => controls.get(name) };
    },
    locator: selector => ({ textContent: async () => texts.get(selector), count: async () => lengths.get(selector),
      isDisabled: async () => selector === "#schedule-month" && options.enabledMonth !== true }),
    evaluate: async (fn, argument) => runInNewContext(`(${fn.toString()})(argument)`, { document, argument,
      fetch: async (path, init) => {
        assert.deepEqual(JSON.parse(JSON.stringify(init)), { method: "GET", credentials: "same-origin", cache: "no-store",
          redirect: "error", headers: { Accept: "application/json" } });
        explicit.push(path);
        if (options.throwFetch) throw new Error(canary);
        const response = await emit(path);
        if (!response) throw new Error(canary);
        return response;
      } }),
  });
  Object.assign(context, {
    browser: () => ({}), pages: () => pages, serviceWorkers: () => [],
    cookies: async () => options.cookie ? [{ name: canary, value: canary }] : [],
    route: async (pattern, callback) => { assert.equal(pattern, "**/*"); handler = callback; },
    routeWebSocket: async (pattern, callback) => { assert.equal(pattern, "**/*"); websocketHandler = callback; },
    newPage: async () => { pages = [page]; context.emit("page", page); return page; },
  });
  options.dom?.({ document, controls, texts, lengths });
  return { input: { context, fixture: { month }, signal: controller.signal }, forwarded, denied, explicit, controller,
    page, context, schedule, initialSchedule, assets, emit, pending, resume: () => resume(),
    lateResponse: () => page.emit("response", lastResponse), socket: socket => websocketHandler(socket) };
}
const unauthenticatedError = error => {
  assert.equal(error.message, "TRUSTED_UNAUTHENTICATED_BOOKING_DOM_FAILED");
  assert.equal("cause" in error, false); assert.doesNotMatch(String(error), /private-canary|https:|SQL|Session/); return true;
};

test("#1002 finite no-cookie UI stops before explicit GETs; six assets, three target 401s, POST0", { timeout: 15000 }, async () => {
  for (const initial of [undefined, [], ["/api/me/reservations"], [`/api/me/schedule-months/${tokyoNowMonth()}`]]) {
    for (const absentSite of [false, true]) {
      const f = unauthenticatedFixture({ initial, absentSite });
      if (initial?.length === 0) {
        await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
        assert.deepEqual(f.explicit, []); continue; // Explicit fetch cannot manufacture DOM success.
      }
      assert.equal(await proveUnauthenticatedBookingDom(f.input), undefined);
      for (const path of [...f.assets, f.schedule, confirmPath, csrfPath])
        assert.equal(f.forwarded.filter(value => value === `GET ${path}`).length, 1);
      assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
      assert.ok(f.explicit.includes(csrfPath));
      assert.ok(!f.explicit.includes(confirmPath) || !initial?.includes(confirmPath));
      const saved = [...f.forwarded];
      f.socket({ connectToServer: () => assert.fail("WebSocket must never forward") });
      f.lateResponse(); await f.emit(csrfPath); await f.emit(confirmPath, "POST");
      assert.deepEqual(f.forwarded, saved);
      await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
      assert.deepEqual(f.forwarded, saved);
    }
  }
});

test("#930 finite first DOM fault only: setup/navigation/request/response/UI; never raw evidence", { timeout: 15000 }, async () => {
  const cases = [
    ["dom-setup", () => {
      const f = unauthenticatedFixture();
      f.context.route = async () => { throw new Error(canary); };
      return f;
    }],
    ["dom-net", () => {
      const f = unauthenticatedFixture();
      f.page.goto = async () => { throw new Error(canary); };
      return f;
    }],
    ["dom-request", () => unauthenticatedFixture({
      change: ({ requestHeaders }) => { requestHeaders["x-private"] = canary; },
    })],
    ["dom-rsp-hdr", () => unauthenticatedFixture({
      change: ({ headers }) => { headers["cache-control"] = canary; },
    })],
    ["dom-ui", () => unauthenticatedFixture({ enabledMonth: true })],
  ];
  for (const [expected, create] of cases) {
    const f = create(), observed = [];
    f.input.onFault = stage => {
      assert.equal(typeof stage, "string");
      observed.push(stage);
    };
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.deepEqual(observed, [expected], expected);
    assert.ok(!JSON.stringify(observed).includes(canary));
    assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
    const before = [...f.forwarded];
    if (expected !== "dom-setup") {
      f.lateResponse(); await f.emit(confirmPath, "POST");
    }
    assert.deepEqual(f.forwarded, before, expected);
    assert.deepEqual(observed, [expected], "late callbacks may not add fault reports");
  }
  const f = unauthenticatedFixture({ enabledMonth: true });
  f.input.onFault = () => { throw new Error(canary); }; // Observer rejection must be passive.
  await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
});

// #1044 oracle: closed Issue buckets and unchanged #1002 guards, not raw errors.
const responseFaultOracle = ["dom-rsp-id", "dom-rsp-code", "dom-rsp-hdr", "dom-rsp-body", "dom-rsp-jar", "dom-rsp-drv"];
test("#1044 response guard first-failure buckets, Cookie mismatch versus driver refusal; late traffic denied", async () => {
  const cases = [
    ["dom-rsp-id", { duplicateResponse: true }],
    ["dom-rsp-id", { change: ({ response }) => { response.request = () => ({}); } }],
    ["dom-rsp-id", { change: ({ response }) => { response.url = () => "https://private.invalid/" + canary; } }],
    ["dom-rsp-id", { change: ({ response }) => { response.fromServiceWorker = () => true; } }],
    ["dom-rsp-code", { change: ({ response }) => { response.status = () => 200; } }],
    ["dom-rsp-code", { target: "/student.css", change: ({ response }) => { response.status = () => 401; } }],
    ["dom-rsp-hdr", { change: ({ headers }) => { headers["x-private"] = canary; } }],
    ["dom-rsp-hdr", { change: ({ headers }) => { delete headers["set-cookie"]; } }],
    ["dom-rsp-body", { change: ({ response }) => { response.text = async () => canary; } }],
    ["dom-rsp-jar", { cookieResult: "mismatch" }],
    ["rsp-jar-err", { cookieResult: "reject" }],
    ...["request", "url", "status", "fromServiceWorker", "allHeaders", "text"].map(method =>
      [method === "allHeaders" ? "rsp-hdr-err" : method === "text" ? "rsp-body-err" : "rsp-meta-err", { change: ({ response }) => { response[method] = () => { throw new Error(canary); }; } }]),
  ];
  assert.deepEqual([...new Set(cases.map(([bucket]) => bucket))], [...responseFaultOracle.slice(0, 5), "rsp-jar-err", "rsp-meta-err", "rsp-hdr-err", "rsp-body-err"]);
  for (const [expected, options] of cases) {
    const f = unauthenticatedFixture(options), observed = [];
    if (options.cookieResult) {
      // Change the jar only from inside response validation, after request admission.
      // This isolates response-cookie mismatch from setup/request-cookie guards.
      options.change = ({ response }) => {
        const body = response.text;
        response.text = async () => {
          const value = await body();
          f.context.cookies = async () => {
            if (options.cookieResult === "reject") throw new Error(canary);
            return [{ name: canary, value: canary }];
          };
          return value;
        };
      };
    }
    f.input.onFault = stage => { observed.push(stage); throw new Error(canary); }; // Passive even on rejection.
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.deepEqual(observed, [expected]);
    assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
    const saved = [...f.forwarded], explicit = [...f.explicit];
    f.lateResponse(); await f.emit(confirmPath, "POST"); await f.emit("/unexpected");
    assert.deepEqual(f.forwarded, saved); assert.deepEqual(f.explicit, explicit);
    assert.deepEqual(observed, [expected]); assert.ok(!JSON.stringify(observed).includes(canary));
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.deepEqual(f.forwarded, saved);
  }
  const f = unauthenticatedFixture(), observed = [];
  f.input.onFault = stage => observed.push(stage);
  assert.equal(await proveUnauthenticatedBookingDom(f.input), undefined);
  assert.deepEqual(observed, []); // No classification is success evidence.
});

test("#1044 response-body driver timeout notifies before stop, late completion is inert", { timeout: 15000 }, async () => {
  const f = unauthenticatedFixture({ stall: "body" }), observed = [];
  f.input.onFault = stage => observed.push(stage);
  const operation = proveUnauthenticatedBookingDom(f.input);
  await f.pending;
  await assert.rejects(operation, unauthenticatedError);
  assert.deepEqual(observed, ["rb-csrf-ot"]);
  const saved = [...f.forwarded]; f.resume(); await new Promise(resolve => setImmediate(resolve));
  f.lateResponse(); await f.emit(confirmPath, "POST");
  assert.deepEqual(observed, ["rb-csrf-ot"]); assert.deepEqual(f.forwarded, saved);
});

// Isolated finite clock/observer fixture. No production injection Port or listener.
function responseClockFixture(mode = "", reverse = false, faults = unauthenticatedBookingResponseFaults) {
  let source = readFileSync("tests/evaluation/trusted-booking-dom.mjs", "utf8");
  source = source.slice(source.indexOf("export async function proveUnauthenticatedBookingDom"),
    source.indexOf("export async function proveTrustedBookingDom")).replace("export async", "async");
  const seam = 'const responseGuard = stage =>';
  assert.equal(source.split(seam).length, 2);
  if (mode) source = source.replace(seam, (mode === "unknown" ? 'throw new Error("private-canary"); ' :
    'await new Promise(() => {}); ') + seam);
  const timers = new Map(); let next = 0, selected, now = 0;
  const prove = runInNewContext(source + "; proveUnauthenticatedBookingDom", {
    timeout: 5000, spent: new WeakSet(), bookingOrigin, confirmPath, csrfPath, tokyoNowMonth, URL,
    unauthenticatedBookingResponseFaults: faults,
    isDeepStrictEqual: (a, b) => isDeepStrictEqual(structuredClone(a), structuredClone(b)),
    validMonth: value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value),
    assets: new Map([['/student', 'text/html'], ['/student.css', 'text/css'],
      ...['student', 'view', 'controller', 'model'].map(n => [`/${n}.js`, 'text/javascript'])]),
    setTimeout: (callback, ms) => { assert.equal(ms, 5000); timers.set(++next, { callback, due: now + ms }); return next; },
    clearTimeout: id => timers.delete(id),
  });
  return { prove, elapse: ms => { now += ms; }, capture: () => (selected = [...timers].slice(-2)),
    bodyDeadline: (origin, captured = selected) => {
      assert.equal(captured.length, 2);
      const [[outerId, outer], [innerId, inner]] = captured;
      assert.ok(outerId < innerId, "real registration order: observer before body");
      assert.equal(inner.due - outer.due, 17, "header time consumes only the outer budget");
      // Normal delivery fires the earlier outer deadline. Inner-first models
      // delayed outer callback delivery, as the legacy reverse race did; it
      // does not claim equal timers naturally have an earlier inner deadline.
      now = origin === "ot" ? outer.due : inner.due;
      const [id, timer] = origin === "ot" ? [outerId, outer] : [innerId, inner];
      assert.ok(timer.due <= now); timers.delete(id); timer.callback();
    }, expire: () => {
    const entries = [...(selected ?? timers)]; if (reverse) entries.reverse();
    for (const [id, timer] of entries) if (timers.has(id)) { timers.delete(id); timer.callback(); }
  } };
}

test("#1050 admitted API class x actual timer origin; deferred body, first latch and late traffic", { timeout: 15000 }, async () => {
  for (const [kind, target] of [["month", `/api/me/schedule-months/${tokyoNowMonth()}`],
    ["hist", confirmPath], ["csrf", csrfPath]]) for (const origin of ["ot", "it"]) {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; }), observed = [];
    const clock = responseClockFixture();
    let headers = 0, bodies = 0;
    const f = unauthenticatedFixture({ target, change: ({ response }) => {
      const allHeaders = response.allHeaders, text = response.text;
      response.allHeaders = () => { headers++; clock.elapse(17); return allHeaders(); };
      response.text = () => {
        bodies++; clock.capture(); entered();
        return new Promise(resolve => { release = async () => resolve(await text()); });
      };
    } });
    f.input.onFault = value => observed.push(value);
    const rejected = assert.rejects(clock.prove(f.input), unauthenticatedError);
    await ready; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observed, [], "response headers can precede body completion");
    assert.equal(headers, 1); assert.equal(bodies, 1);
    clock.bodyDeadline(origin); await rejected;
    assert.deepEqual(observed, [`rb-${kind}-${origin}`]);
    const saved = [...f.forwarded], explicit = [...f.explicit];
    await release(); await new Promise(resolve => setImmediate(resolve));
    clock.expire(); f.lateResponse(); await f.emit(confirmPath, "POST"); await f.emit("/" + canary);
    assert.deepEqual(observed, [`rb-${kind}-${origin}`]);
    assert.deepEqual(f.forwarded, saved); assert.deepEqual(f.explicit, explicit);
    assert.ok(saved.every(value => value.startsWith("GET ")));
    assert.ok(!JSON.stringify(observed).includes(canary));
  }
});

test("#1050 all three admitted classes retain body rejection and body mismatch guards", async () => {
  for (const target of [`/api/me/schedule-months/${tokyoNowMonth()}`, confirmPath, csrfPath]) {
    for (const reject of [false, true]) {
      const f = unauthenticatedFixture({ target, change: ({ response }) => {
        response.text = async () => { if (reject) throw new Error(canary); return canary; };
      } }), observed = [];
      f.input.onFault = fault => observed.push(fault);
      await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
      assert.deepEqual(observed, [reject ? "rsp-body-err" : "dom-rsp-body"]);
    }
  }
});

test("#1050 simultaneous distinct responses latch the first delivered body timer only", { timeout: 15000 }, async () => {
  for (const winner of [0, 1]) {
    const clock = responseClockFixture(), captured = [], release = [], observed = [];
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = unauthenticatedFixture({ targets: [`/api/me/schedule-months/${tokyoNowMonth()}`, confirmPath], change: ({ response }) => {
      const headers = response.allHeaders;
      response.allHeaders = () => { clock.elapse(17); return headers(); };
      response.text = () => {
        captured.push(clock.capture());
        if (captured.length === 2) entered();
        return new Promise(resolve => release.push(() => resolve(canary)));
      };
    } });
    f.input.onFault = value => observed.push(value);
    const rejected = assert.rejects(clock.prove(f.input), unauthenticatedError);
    await ready;
    clock.bodyDeadline("ot", captured[winner]); await rejected;
    assert.deepEqual(observed, [winner === 0 ? "rb-month-ot" : "rb-hist-ot"]);
    for (const complete of release) complete();
    await new Promise(resolve => setImmediate(resolve)); clock.expire(); f.lateResponse();
    assert.equal(observed.length, 1);
  }
});

test("#1050 missing closed class enum fails before body acquisition, unknown path stays denied", async () => {
  for (const value of ["rb-csrf-ot", "rb-csrf-it"]) {
    const f = unauthenticatedFixture({ change: ({ response }) => {
      response.text = () => assert.fail("incomplete class must fail closed before body");
    } }), observed = [];
    f.input.onFault = fault => observed.push(fault);
    await assert.rejects(responseClockFixture("", false,
      unauthenticatedBookingResponseFaults.filter(fault => fault !== value)).prove(f.input), unauthenticatedError);
    assert.deepEqual(observed, ["dom-rsp-id"]);
  }
  const f = unauthenticatedFixture({ initial: ["/api/" + canary] }), observed = [];
  f.input.onFault = fault => observed.push(fault);
  await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
  assert.deepEqual(observed, ["dom-request"]);
});


test("#930 request timing finite: 3 classes x 2 timeout origins x client finished/unseen/unreadable", { timeout: 15000 }, async () => {
  for (const [kind, target] of [["month", "/api/me/schedule-months/" + tokyoNowMonth()],
    ["hist", confirmPath], ["csrf", csrfPath]]) for (const origin of ["ot", "it"])
    for (const timing of ["unseen", "finished", "unreadable"]) {
      let entered, release, timingReads = 0;
      const ready = new Promise(resolve => { entered = resolve; }), observed = [];
      const clock = responseClockFixture();
      const f = unauthenticatedFixture({ target, change: ({ request, response }) => {
        // Mirrors Playwright 1.64 client: responseEnd starts -1, _onRequestFinished
        // updates it synchronously. This fixture does not claim actual Chrome proof.
        request.timing = () => {
          timingReads++;
          if (timing === "unreadable") throw new Error(canary);
          return { responseEnd: timing === "finished" ? 42 : -1 };
        };
        const headers = response.allHeaders;
        response.allHeaders = () => { clock.elapse(17); return headers(); };
        response.text = () => {
          clock.capture(); entered();
          return new Promise(resolve => { release = () => resolve(canary); });
        };
      } });
      f.input.onFault = value => observed.push(value);
      const rejected = assert.rejects(clock.prove(f.input), unauthenticatedError);
      await ready;
      clock.bodyDeadline(origin);
      await rejected;
      const prefix = timing === "finished" ? "bf" : timing === "unseen" ? "bn" : "rb";
      assert.deepEqual(observed, [prefix + "-" + kind + "-" + origin]);
      assert.equal(timingReads, 1, "only one synchronous private timing read at first timeout");
      const forwarded = [...f.forwarded], explicit = [...f.explicit];
      release(); await new Promise(resolve => setImmediate(resolve));
      clock.expire(); f.lateResponse(); await f.emit(confirmPath, "POST");
      assert.deepEqual(observed, [prefix + "-" + kind + "-" + origin]);
      assert.deepEqual(f.forwarded, forwarded); assert.deepEqual(f.explicit, explicit);
      assert.ok(!JSON.stringify(observed).includes(canary));
    }
});

test("#930 invalid timing values fail closed and requestfailed first fault is never overwritten", async () => {
  for (const read of [
    () => null, () => ({ responseEnd: NaN }), () => ({ responseEnd: -2 }),
    () => ({ responseEnd: "42" }), () => ({ responseEnd: Infinity }),
    () => ({ get responseEnd() { throw new Error(canary); } }),
  ]) {
    const clock = responseClockFixture(), observed = [];
    let entered, release, reads = 0;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = unauthenticatedFixture({ change: ({ request, response }) => {
      request.timing = () => { reads++; return read(); };
      const headers = response.allHeaders;
      response.allHeaders = () => { clock.elapse(17); return headers(); };
      response.text = () => { clock.capture(); entered(); return new Promise(resolve => { release = () => resolve(canary); }); };
    } });
    f.input.onFault = value => observed.push(value);
    const rejected = assert.rejects(clock.prove(f.input), unauthenticatedError);
    await ready; clock.bodyDeadline("ot"); await rejected;
    assert.deepEqual(observed, ["rb-csrf-ot"]);
    assert.equal(reads, 1);
    release(); clock.expire();
  }
  const clock = responseClockFixture(), observed = [];
  let entered, request, release, reads = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = unauthenticatedFixture({ change: ({ request: candidate, response }) => {
    request = candidate;
    candidate.timing = () => { reads++; return { responseEnd: 42 }; };
    const headers = response.allHeaders;
    response.allHeaders = () => { clock.elapse(17); return headers(); };
    response.text = () => { clock.capture(); entered(); return new Promise(resolve => { release = () => resolve(canary); }); };
  } });
  f.input.onFault = value => observed.push(value);
  const rejected = assert.rejects(clock.prove(f.input), unauthenticatedError);
  await ready;
  f.page.emit("requestfailed", request);
  await rejected;
  clock.expire(); release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, ["dom-request"]);
  assert.equal(reads, 0, "first requestfailed latch must make later timing inspection inert");
});

test("#1047 acquisition reject/pending, both timer orders, abort first and late completion keep one fixed fault", async () => {
  for (const kind of ["hdr", "body", "jar"]) for (const outcome of ["reject", "timeout", "abort"]) {
    for (const reverse of [false, true]) {
      let release, entered; const ready = new Promise(resolve => { entered = resolve; });
      const calls = { hdr: 0, body: 0, jar: 0 }, observed = [];
      const options = { change: ({ response }) => {
        const headers = response.allHeaders, text = response.text;
        response.allHeaders = () => {
          calls.hdr++;
          return kind === "hdr" ? injected() : headers();
        };
        response.text = () => { calls.body++; return kind === "body" ? injected() : text(); };
        if (kind === "jar") {
          const original = response.text;
          response.text = async () => {
            const value = await original();
            f.context.cookies = () => { calls.jar++; return injected(); };
            return value;
          };
        }
      } };
      const injected = () => {
        clock.capture(); // Only the response observer and acquisition timers compete.
        entered();
        if (outcome === "reject") return Promise.reject(new Error(canary));
        return new Promise(resolve => { release = () => resolve(kind === "jar" ? [] : canary); });
      };
      const f = unauthenticatedFixture(options), clock = responseClockFixture("", reverse);
      f.input.onFault = value => observed.push(value);
      const operation = clock.prove(f.input), rejected = assert.rejects(operation, unauthenticatedError);
      await Promise.race([ready, operation.then(() => assert.fail("fixture did not inject"),
        () => assert.fail(`fixture stopped before injection: ${observed.join(",")}`))]);
      await new Promise(resolve => setImmediate(resolve));
      if (outcome === "abort") f.controller.abort(canary);
      else if (outcome === "timeout") clock.expire();
      await rejected;
      const expected = outcome === "abort" ? "dom-ui" : kind === "body" && outcome === "timeout" ?
        (reverse ? "rb-csrf-it" : "rb-csrf-ot") : `rsp-${kind}-${outcome === "reject" ? "err" : "to"}`;
      assert.deepEqual(observed, [expected], `${kind}/${outcome}/${reverse}`);
      assert.deepEqual(calls, { hdr: 1, body: kind === "hdr" ? 0 : 1, jar: kind === "jar" ? 1 : 0 });
      const saved = [...f.forwarded]; release?.();
      await new Promise(resolve => setImmediate(resolve)); clock.expire(); f.lateResponse();
      await f.emit(confirmPath, "POST"); await f.emit("/unexpected");
      assert.deepEqual(f.forwarded, saved); assert.deepEqual(observed, [expected]);
      assert.ok(!JSON.stringify(observed).includes(canary));
    }
  }
});

test("#1047 unexpected safeHeaders exception differs from demand mismatch, metadata and outer fallback", async () => {
  for (const [expected, change] of [
    ["rsp-guard-ex", ({ response }) => { response.allHeaders = async () => null; }],
    ["rsp-guard-ex", ({ headers }) => { Object.defineProperty(headers, "date", { enumerable: true, get() { throw new Error(canary); } }); }],
    ["dom-rsp-hdr", ({ headers }) => { headers["cache-control"] = canary; }],
    ["rsp-meta-err", ({ request }) => { request.url = () => { throw new Error(canary); }; }],
  ]) {
    // request.url must throw only after request admission.
    const f = unauthenticatedFixture({ change: values => {
      if (expected === "rsp-meta-err") {
        const original = values.response.request;
        values.response.request = () => { change(values); return original(); };
      } else change(values);
    } }), observed = [];
    f.input.onFault = value => observed.push(value);
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.deepEqual(observed, [expected]);
  }
  for (const mode of ["unknown", "pending"]) {
    const f = unauthenticatedFixture(), clock = responseClockFixture(mode), observed = [];
    f.input.onFault = value => observed.push(value);
    const rejected = assert.rejects(clock.prove(f.input), unauthenticatedError);
    await new Promise(resolve => setImmediate(resolve));
    if (mode === "pending") clock.expire();
    await rejected;
    assert.deepEqual(observed, [mode === "unknown" ? "dom-rsp-drv" : "rsp-outer-to"]);
    f.lateResponse(); clock.expire(); assert.equal(observed.length, 1);
  }
});

test("#1047 concurrent duplicate response wins once over pending body's late mismatch", async () => {
  const f = unauthenticatedFixture({ stall: "body", change: ({ response }) => {
    const original = response.text;
    response.text = async () => { await original(); return canary; };
  } }), observed = [];
  f.input.onFault = value => observed.push(value);
  const rejected = assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
  await f.pending; f.lateResponse(); f.lateResponse();
  await rejected;
  assert.deepEqual(observed, ["dom-rsp-id"]);
  const saved = [...f.forwarded]; f.resume();
  await new Promise(resolve => setImmediate(resolve));
  await f.emit(confirmPath, "POST");
  assert.deepEqual(observed, ["dom-rsp-id"]); assert.deepEqual(f.forwarded, saved);
});

test("#1002 asset headers match Worker contract; bad/missing/extra headers stop further traffic", { timeout: 15000 }, async () => {
  const changes = [
    ...["x-content-type-options", "referrer-policy", "cache-control", "content-type"]
      .flatMap(name => [({ headers }) => { delete headers[name]; }, ({ headers }) => { headers[name] = canary; }]),
    ...["", "NOSNIFF", "nosniff, nosniff", "nosniff\nprivate-canary", null, 42]
      .map(value => ({ headers }) => { headers["x-content-type-options"] = value; }),
    ...["x-private", "access-control-allow-origin", "location", "set-cookie"]
      .map(name => ({ headers }) => { headers[name] = canary; }),
  ];
  for (const target of ["/student", "/student.css", "/student.js", "/view.js", "/controller.js", "/model.js"]) {
    for (const change of changes) {
      const f = unauthenticatedFixture({ target, change });
      await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
      assert.deepEqual(f.explicit, []);
      assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
      const saved = [...f.forwarded];
      f.lateResponse(); await f.emit(csrfPath); await f.emit(confirmPath, "POST");
      assert.deepEqual(f.forwarded, saved);
    }
  }
  // Asset-only admission must not widen the closed API response map.
  const api = unauthenticatedFixture({ change: ({ headers }) => { headers["x-content-type-options"] = "nosniff"; } });
  await assert.rejects(proveUnauthenticatedBookingDom(api.input), unauthenticatedError);
  assert.ok(api.forwarded.every(value => value.startsWith("GET ")));
});

test("#1002 invalid route/header attempts never forward; late traffic remains denied", { timeout: 15000 }, async () => {
  const mutations = [
    ...["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(method => ({ request }) => { request.method = () => method; }),
    ...["https://invalid.test/api/auth/student/csrf", `${bookingOrigin}${csrfPath}?x=${canary}`,
      `${bookingOrigin}${csrfPath}?`, `${bookingOrigin}${csrfPath}#`, `${bookingOrigin}${csrfPath}#${canary}`,
      `https://user:${canary}@127.0.0.1:8789${csrfPath}`, `${bookingOrigin}/api/me/reservations/preview`]
      .map(url => ({ request }) => { request.url = () => url; }),
    ({ request }) => { request.redirectedFrom = () => ({}); },
    ({ request }) => { request.frame = () => ({}); },
    ({ request }) => { request.isNavigationRequest = () => true; },
    ({ request }) => { request.postData = () => canary; },
    ...["cookie", "authorization", "x-csrf-token", "content-type", "transfer-encoding", "x-student-id", "x-private"]
      .map(name => ({ requestHeaders }) => { requestHeaders[name] = canary; }),
    ({ requestHeaders }) => { requestHeaders.origin = "https://invalid.test"; },
    ({ requestHeaders }) => { requestHeaders.host = "invalid.test"; },
    ({ requestHeaders }) => { requestHeaders.referer = bookingOrigin + "/student?secret=" + canary; },
    ({ requestHeaders }) => { requestHeaders.accept = "text/plain"; },
    ...["sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"].map(name => ({ requestHeaders }) => { requestHeaders[name] = canary; }),
    ...["cross-site", "same-site", "none", "", undefined, null, 42].map(value => ({ requestHeaders }) => { requestHeaders["sec-fetch-site"] = value; }),
  ];
  for (const change of mutations) {
    const f = unauthenticatedFixture({ change });
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.ok(!f.forwarded.includes(`GET ${csrfPath}`)); assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
    const saved = [...f.forwarded]; await f.emit(confirmPath, "POST"); assert.deepEqual(f.forwarded, saved);
  }
});

test("#1002 finite wrong status/body/headers/cookies/identity fail closed without subsequent fetch", { timeout: 15000 }, async () => {
  const changes = [
    ...[200, 201, 302, 400, 403, 503].map(status => ({ response }) => { response.status = () => status; }),
    ...['{}', '{"csrfToken":"private-canary","scope":"session"}', '{"error":{"code":"UNAUTHENTICATED","message":"SQL private-canary","retry":"none"}}',
      '{"error":{"code":"UNAUTHENTICATED","message":"認証が必要です。","retry":"none"},"studentId":"private-canary"}']
      .map(body => ({ response }) => { response.text = async () => body; }),
    ({ response }) => { response.text = async () => { throw new Error(canary); }; },
    ({ response }) => { response.url = () => "https://invalid.test/"; },
    ({ response }) => { response.request = () => ({}); },
    ({ response }) => { response.fromServiceWorker = () => true; },
    ({ headers }) => { delete headers["set-cookie"]; },
    ...[canary, `__Host-student_session=${canary}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "__Host-student_preauth=; Max-Age=0", "__Host-student_session=; Max-Age=0", "\nprivate-canary"]
      .map(value => ({ headers }) => { headers["set-cookie"] = value; }),
    ...["cache-control", "content-type", "referrer-policy", "access-control-allow-origin", "location", "x-private"]
      .map(name => ({ headers }) => { headers[name] = canary; }),
  ];
  for (const change of changes) {
    const f = unauthenticatedFixture({ change, target: `/api/me/schedule-months/${tokyoNowMonth()}` });
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.deepEqual(f.explicit, []); assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
  }
  const csrf = unauthenticatedFixture({ change: ({ headers }) => { delete headers["referrer-policy"]; } });
  await assert.rejects(proveUnauthenticatedBookingDom(csrf.input), unauthenticatedError);
});

test("#1002 stale DOM, unexpected assets/resources, duplicate response/request and cookie jar stop", { timeout: 15000 }, async () => {
  const cases = [
    { cookie: true }, { enabledMonth: true }, { missingAsset: "/model.js" }, { initial: [] },
    { extra: [confirmPath, "POST"] }, { extra: [previewPath, "POST"] }, { extra: ["/favicon.ico"] },
    { extra: ["https://invalid.test/student"] }, { extra: [confirmPath] },
    { duplicateResponse: true }, { throwFetch: true }, { abortHeaders: true }, { networkFailure: true },
    ...["section ol li", ".slot", "#operation-content > *"].map(selector => ({ dom: ({ lengths }) => lengths.set(selector, 1) })),
    ...["#selection-status", "#schedule-status", "#history-status", "#operation-status"].map(selector => ({ dom: ({ texts }) => texts.set(selector, canary) })),
    ...["この月を取得", "前の月", "次の月", "履歴を最新から再取得", "履歴の次ページ", previewName, confirmName]
      .map(name => ({ dom: ({ controls }) => controls.set(name, false) })),
    ...["expectedStateToken", "csrfToken", "studentId", "reservationId", "token_hash", "seed-other", "private@example.test"]
      .map(value => ({ dom: ({ document }) => { document.documentElement.outerHTML = value; } })),
    { dom: ({ document }) => { document.cookie = canary; } },
    { dom: ({ document }) => { document.querySelector = () => ({ getAttribute: () => "true" }); } },
  ];
  for (const options of cases) {
    const f = unauthenticatedFixture(options);
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
    const saved = [...f.forwarded];
    if (!options.cookie) { f.lateResponse(); await f.emit(confirmPath, "POST"); }
    assert.deepEqual(f.forwarded, saved);
  }
});

test("#1002 abort/timeout pending driver and late response never resume/retry; concurrent context is spent", { timeout: 15000 }, async () => {
  for (const stall of ["headers", "body"]) {
    const f = unauthenticatedFixture({ stall }), operation = proveUnauthenticatedBookingDom(f.input);
    await f.pending;
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    f.controller.abort(canary);
    await assert.rejects(operation, unauthenticatedError);
    const saved = [...f.forwarded]; f.resume(); await new Promise(resolve => setImmediate(resolve));
    f.lateResponse(); await f.emit(confirmPath, "POST"); assert.deepEqual(f.forwarded, saved);
    if (stall === "headers") assert.ok(!saved.includes(`GET ${csrfPath}`));
  }
  const f = unauthenticatedFixture({ stall: "headers" });
  await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError); // Real 5s bounded race.
  const saved = [...f.forwarded]; f.resume(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.forwarded, saved); assert.ok(!saved.includes(`GET ${csrfPath}`));
  for (const event of ["popup", "websocket", "download", "framenavigated"]) {
    const f = unauthenticatedFixture({ stall: "headers" }), operation = proveUnauthenticatedBookingDom(f.input);
    await f.pending; f.page.emit(event, {});
    await assert.rejects(operation, unauthenticatedError); f.resume();
  }
  for (const event of ["page", "serviceworker"]) {
    const f = unauthenticatedFixture({ stall: "headers" }), operation = proveUnauthenticatedBookingDom(f.input);
    await f.pending; f.context.emit(event, {});
    await assert.rejects(operation, unauthenticatedError); f.resume();
  }
  const preAborted = unauthenticatedFixture(); preAborted.controller.abort(canary);
  await assert.rejects(proveUnauthenticatedBookingDom(preAborted.input), unauthenticatedError);
  assert.deepEqual(preAborted.forwarded, []);
  for (const fixture of [{ month: "2099-13" }, { month: "2099-01", secret: canary }, { month: canary }]) {
    const f = unauthenticatedFixture(); f.input.fixture = fixture;
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.deepEqual(f.forwarded, []);
  }
});

test("#1002 pending response validation blocks success; late invalid body/jar and changed final UI fail", { timeout: 15000 }, async () => {
  for (const fault of ["body", "cookie"]) {
    const options = { stall: "body", change: ({ response }) => {
      const original = response.text;
      response.text = async () => { const body = await original(); return fault === "body" ? canary : body; };
    } };
    const f = unauthenticatedFixture(options);
    let settled = false;
    const operation = proveUnauthenticatedBookingDom(f.input).finally(() => { settled = true; });
    await f.pending; await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    if (fault === "cookie") f.context.cookies = async () => [{ name: canary, value: canary }];
    f.resume(); await assert.rejects(operation, unauthenticatedError);
    assert.ok(f.forwarded.every(value => value.startsWith("GET ")));
  }
  const f = unauthenticatedFixture({ afterCsrf: ({ controls }) => controls.set(confirmName, false) });
  await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
  for (const target of ["/student", "/model.js"]) {
    const f = unauthenticatedFixture({ target, change: ({ headers }) => { headers["set-cookie"] = canary; } });
    await assert.rejects(proveUnauthenticatedBookingDom(f.input), unauthenticatedError);
    assert.deepEqual(f.explicit, []);
  }
  const socket = unauthenticatedFixture({ stall: "headers" });
  const operation = proveUnauthenticatedBookingDom(socket.input);
  await socket.pending;
  socket.socket({ connectToServer: () => assert.fail("WebSocket must never forward") });
  await assert.rejects(operation, unauthenticatedError); socket.resume();
});

// #984 oracle: Issue-entered checkpoints and fixed control positions, not driver output.
const domStages = ["cookie-jar", "route", "navigation", "assets", "initial-ui", "selection", "preview", "review",
  "confirm", "confirm-ui", "history", "handoff", "complete"];
const capture = f => {
  const observations = [];
  f.input.observe = (kind, value) => { observations.push([kind, value]); };
  return observations;
};
test("#984 complete entered stages and four distinct Confirm observations, with no secret payload", async () => {
  const f = fixture(), observations = capture(f);
  assert.equal(await proveTrustedBookingDom(f.input), f.id);
  assert.deepEqual(observations.filter(([kind]) => kind === "dom").map(([, value]) => value), domStages);
  assert.deepEqual(observations.filter(([kind]) => kind === "write").map(([, value]) => value),
    ["action-start", "request-seen", "route-allowed", "response-201"]);
  assert.deepEqual(observations.filter(([kind]) => kind === "fault"), []);
  assert.ok(observations.indexOf(observations.find(v => v[1] === "confirm")) < observations.indexOf(observations.find(v => v[1] === "action-start")));
  assert.doesNotMatch(JSON.stringify(observations), /private-canary|fixture-created|seed-|https:|v1\./);
  const saved = structuredClone(observations); f.lateResponse(); await f.late();
  assert.deepEqual(observations, saved);
});

// #992 oracle: approved Absent/Present pre-route distinction; Application §10.3
// still requires exact Origin/CSRF. These fixtures do not observe wire headers.
test("#992 absent Fetch Metadata at Preview, Confirm or both preserves one-shot success and observer pairs", async () => {
  const baseline = fixture(), expected = capture(baseline);
  await proveTrustedBookingDom(baseline.input);
  for (const paths of [[previewPath], [confirmPath], [previewPath, confirmPath]]) {
    const f = fixture("", (_request, headers, path) => {
      if (paths.includes(path)) delete headers["sec-fetch-site"];
    }), observations = capture(f);
    assert.equal(await proveTrustedBookingDom(f.input), f.id);
    assert.deepEqual(observations, expected);
    assert.deepEqual(f.forwarded, baseline.forwarded);
    assert.equal(f.events.filter(v => v === previewName).length, 1);
    assert.equal(f.events.filter(v => v === confirmName).length, 1);
    const saved = structuredClone(observations); f.lateResponse(); await f.late();
    assert.deepEqual(observations, saved);
    assert.deepEqual(f.denied, [confirmPath]);
    const calls = f.events.length;
    await assert.rejects(proveTrustedBookingDom(f.input));
    assert.equal(f.events.length, calls);
  }
});

test("#992 present invalid site and absent-site requests with invalid mandatory guards abort before forwarding", async () => {
  const cases = [
    ...["cross-site", "same-site", "none", "unknown", "", undefined, null, 42, ["same-origin"], { value: "same-origin" }, "Same-Origin", canary]
      .map(value => ["present-site", (_request, headers) => { headers["sec-fetch-site"] = value; }]),
    ["origin", (_request, headers) => { headers.origin = "https://invalid.test"; }],
    ["origin-absent", (_request, headers) => { delete headers.origin; }],
    ["csrf", (_request, headers) => { headers["x-csrf-token"] = canary; }],
    ["csrf-absent", (_request, headers) => { delete headers["x-csrf-token"]; }],
    ["content-type", (_request, headers) => { headers["content-type"] = "text/plain"; }],
    ["body-absent", request => { request.postDataJSON = () => null; }],
    ["body-missing-field", request => { request.postDataJSON = () => ({}); }],
    ["body-extra", request => { const body = request.postDataJSON(); request.postDataJSON = () => ({ ...body, studentId: canary }); }],
    ["body-token", request => { const body = request.postDataJSON(); request.postDataJSON = () => ({ ...body, expectedStateToken: canary }); }],
    ["method", request => { request.method = () => "PUT"; }],
    ["redirect", request => { request.redirectedFrom = () => ({}); }],
    ["frame", request => { request.frame = () => ({ page: () => ({}) }); }],
  ];
  for (const path of [previewPath, confirmPath]) {
    for (const [name, mutate] of cases) {
      const f = fixture("", (request, headers, currentPath) => {
        delete headers["sec-fetch-site"];
        if (currentPath === path) mutate(request, headers);
      }), observations = capture(f);
      await assert.rejects(proveTrustedBookingDom(f.input), error => {
        assert.equal(error.message, "TRUSTED_BOOKING_DOM_REQUEST");
        assert.equal("cause" in error, false);
        assert.doesNotMatch(String(error), /private-canary|seed-|v1\.|https:/);
        return true;
      });
      assert.deepEqual(f.forwarded.filter(v => v.startsWith("POST")), path === previewPath ? [] : [`POST ${previewPath}`], name);
      assert.deepEqual(f.denied, [path], name);
      assert.equal(f.events.filter(v => v === confirmName).length, path === previewPath ? 0 : 1, name);
      assert.deepEqual(observations.filter(v => v[0] === "fault"), [["fault", "request"]], name);
      assert.equal(observations.filter(v => v[0] === "dom").at(-1)[1], path === previewPath ? "preview" : "confirm", name);
      assert.equal(observations.filter(v => v[0] === "write").at(-1)?.[1] ?? "unobserved",
        path === previewPath ? "unobserved" : name === "method" ? "action-start" : "request-seen", name);
      assert.doesNotMatch(JSON.stringify(observations), /private-canary|seed-|v1\.|https:/);
      const saved = structuredClone(observations); f.lateResponse(); await f.late();
      assert.deepEqual(observations, saved, name);
      assert.ok(!f.forwarded.includes(`POST ${confirmPath}`), name);
    }
  }
});
test("#984 finite checkpoint/fault/write negatives retain only directly observed facts", async () => {
  for (const [fault, stage, first, write] of [
    ["cookie-jar", "cookie-jar", "driver", "unobserved"],
    ["route", "route", "driver", "unobserved"], ["page", "route", "driver", "unobserved"],
    ["goto", "navigation", "driver", "unobserved"], ["heading", "navigation", "driver", "unobserved"],
    ["null-navigation", "navigation", "assertion", "unobserved"], ["missing-asset", "assets", "assertion", "unobserved"],
    ["month", "initial-ui", "driver", "unobserved"], ["initial-history", "initial-ui", "assertion", "unobserved"],
    ["abort-selection", "selection", "abort", "unobserved"], ["timeout-preview", "preview", "timeout", "unobserved"],
    ["wrong-dom-classification", "review", "assertion", "unobserved"],
    ["navigation", "preview", "navigation", "unobserved"], ["preview-403", "preview", "response", "unobserved"],
    ["preview-token", "preview", "unknown", "unobserved"],
    ["click-confirm", "confirm", "driver", "action-start"], ["wrong-confirm-token", "confirm", "request", "request-seen"],
    ["abort-confirm-headers", "confirm", "abort", "request-seen"],
    ["forward-confirm", "confirm", "request", "route-allowed"], ["network-unknown", "confirm", "network", "route-allowed"],
    ["response-identity", "confirm", "response", "route-allowed"], ["confirm-409", "confirm", "response", "route-allowed"],
    ["json-unknown", "confirm", "driver", "response-201"], ["id-other", "confirm", "assertion", "response-201"],
    ["false-success", "confirm-ui", "assertion", "response-201"], ["stale-history", "history", "assertion", "response-201"],
    ["duplicate-confirm", "confirm", "request", "response-201"], ["abort-confirm", "confirm", "abort", "response-201"],
  ]) {
    const f = fixture(fault), observations = capture(f);
    await assert.rejects(proveTrustedBookingDom(f.input));
    assert.equal(observations.filter(v => v[0] === "dom").at(-1)?.[1], stage, fault);
    assert.deepEqual(observations.filter(v => v[0] === "fault"), [["fault", first]], fault);
    assert.equal(observations.filter(v => v[0] === "write").at(-1)?.[1] ?? "unobserved", write, fault);
    const saved = structuredClone(observations); f.lateResponse(); if (stage !== "cookie-jar" && fault !== "route") await f.late();
    assert.deepEqual(observations, saved, fault);
    assert.ok(f.events.filter(v => v === confirmName).length <= 1, fault);
    assert.ok(f.forwarded.filter(v => v === `POST ${confirmPath}`).length <= 1, fault);
  }
});
test("#984 observer throw/non-sync return fails closed before the next action and after the first fault", async () => {
  for (const point of ["cookie-jar", "route", "selection", "confirm", "action-start", "request-seen", "route-allowed", "response-201", "handoff", "complete", "fault"]) {
    for (const asyncReturn of [false, true]) {
      const f = fixture(point === "fault" ? "wrong-confirm-token" : ""), observations = [];
      f.input.observe = (kind, value) => {
        observations.push([kind, value]);
        if (value === point || kind === point) {
          if (asyncReturn) return Promise.resolve();
          throw new Error(canary);
        }
      };
      await assert.rejects(proveTrustedBookingDom(f.input));
      const saved = structuredClone(observations); f.lateResponse(); if (point !== "cookie-jar" && point !== "route") await f.late();
      assert.deepEqual(observations, saved);
      if (point === "action-start") assert.equal(f.events.includes(confirmName), false);
      if (["action-start", "request-seen", "route-allowed"].includes(point)) assert.ok(!f.forwarded.includes(`POST ${confirmPath}`), point);
      assert.ok(f.events.filter(v => v === confirmName).length <= 1);
      if (point === "fault") assert.deepEqual(observations.at(-1), ["fault", "request"]);
      delete f.input.observe;
      const calls = f.events.length;
      await assert.rejects(proveTrustedBookingDom(f.input));
      assert.equal(f.events.length, calls);
    }
  }
});
test("#984 abort/timeout freezes notifications despite a pending driver and subsequent completion", async () => {
  for (const kind of ["abort", "timeout"]) {
    const f = fixture(), observations = capture(f);
    let release;
    f.input.context.cookies = () => new Promise(resolve => { release = resolve; });
    const running = proveTrustedBookingDom(f.input);
    await Promise.resolve(); await Promise.resolve();
    if (kind === "abort") f.controller.abort(canary);
    await assert.rejects(running);
    assert.deepEqual(observations, [["dom", "cookie-jar"], ["fault", kind]]);
    release([]); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observations, [["dom", "cookie-jar"], ["fault", kind]]);
    assert.deepEqual(f.events, []);
  }
});

test("#984 real DOM helper → real process → strict nine-field codec, success and first failure through stop", async () => {
  let successSnapshots;
  for (const [fault, stage, first, write, changePost] of [
    ["", "complete", "none", "response-201"], ["missing-asset", "assets", "assertion", "unobserved"],
    ["", "complete", "none", "response-201", (_request, headers) => { delete headers["sec-fetch-site"]; }],
    ["wrong-dom-classification", "review", "assertion", "unobserved"],
    ["click-confirm", "confirm", "driver", "action-start"], ["wrong-confirm-token", "confirm", "request", "request-seen"],
    ["network-unknown", "confirm", "network", "route-allowed"], ["confirm-409", "confirm", "response", "route-allowed"],
    ["stale-history", "history", "assertion", "response-201"], ["abort-confirm-headers", "confirm", "abort", "request-seen"],
  ]) {
    const f = fixture(fault, changePost), snapshots = [], lifecycle = [];
    f.input.browser.newContext = async () => f.input.context;
    f.input.context.addCookies = async () => {};
    const signal = f.controller.signal;
    const ports = {
      observe(data) { snapshots.push(parseBookingDiagnostic(encodeBookingDiagnostic(data))); },
      async prepareTrustedBooking(consume, entered) { entered(); await consume(f.input.seed, {}); },
      createBrowserHome: () => ({ home: "fixture-home", identity: {} }), checkBrowserHome() {},
      async withIsolatedBrowserTls(consume, options) {
        try { await consume({ browser: f.input.browser, certificate: {}, signal }); }
        finally { lifecycle.push("browser-close"); await options.stopConsumer(); await options.inspectOwned("fixture-home"); }
      },
      createBookingWorkerPort: () => ({ start: async () => bookingOrigin, isReady: () => true,
        async stop() { lifecycle.push("worker-stop"); f.lateResponse(); await f.late(); return { stopped: true, portClosed: true }; } }),
      proveTrustedBookingDom,
      async inspectTrustedBooking(_handle, id) { assert.equal(id, f.id); lifecycle.push("readback"); },
      scanOwnedSecrets() { lifecycle.push("scan"); },
    };
    const running = useTrustedBookingProcess(ports, signal);
    if (fault) await assert.rejects(running); else await running;
    assert.deepEqual([snapshots.at(-1).dom, snapshots.at(-1).fault, snapshots.at(-1).write], [stage, first, write], fault);
    assert.ok(snapshots.filter(s => s.phase === "stop").every(s => s.dom === stage && s.fault === first && s.write === write), fault);
    assert.equal(lifecycle.filter(v => v === "worker-stop").length, 1);
    assert.equal(lifecycle.includes("readback"), !fault);
    if (!fault) {
      if (successSnapshots) assert.deepEqual(snapshots, successSnapshots); // #992: same V2 observations through stop.
      else successSnapshots = snapshots;
    }
    if (fault) assert.ok(snapshots.filter(s => s.primary !== "none").every(s => s.primary === "dom"));
    else assert.deepEqual(snapshots.filter(s => s.phase === "dom" && s.boundary === "entered").map(s => s.dom),
      ["none", "context", "cookie-check", "cookie-inject", ...domStages.slice(0, 9), "confirm", "confirm", "confirm", "confirm", ...domStages.slice(9)]);
    assert.doesNotMatch(JSON.stringify(snapshots), /private-canary|fixture-created|seed-|https:|v1\./);
  }
});

test("#984 ambiguous pre-driver exceptions stay unknown even with a TimeoutError name", async () => {
  for (const name of ["Error", "TimeoutError"]) {
    const f = fixture(), observations = capture(f);
    f.input.seed.sessions.self.cookie = () => { const error = new Error(canary); error.name = name; throw error; };
    await assert.rejects(proveTrustedBookingDom(f.input));
    assert.deepEqual(observations, [["dom", "cookie-jar"], ["fault", "unknown"]]);
    assert.deepEqual(f.events, []);
  }
});

test("#984 Confirm forwarded with pending HTTP response freezes at route-allowed on abort/timeout", async () => {
  for (const kind of ["abort", "timeout"]) {
    const f = fixture("pending-confirm"), observations = capture(f);
    const running = proveTrustedBookingDom(f.input);
    await f.responsePending;
    assert.equal(observations.filter(v => v[0] === "write").at(-1)[1], "route-allowed");
    if (kind === "abort") f.controller.abort(canary);
    await assert.rejects(running);
    assert.deepEqual(observations.filter(v => v[0] === "fault"), [["fault", kind]]);
    const saved = structuredClone(observations);
    f.resumeResponse(); await new Promise(resolve => setImmediate(resolve)); await f.late();
    assert.deepEqual(observations, saved);
    assert.equal(f.events.filter(v => v === confirmName).length, 1);
    assert.equal(f.forwarded.filter(v => v === `POST ${confirmPath}`).length, 1);
    assert.equal(f.denied.includes(confirmPath), true);
  }
});
