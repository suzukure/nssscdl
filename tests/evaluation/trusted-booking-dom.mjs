// #941: dormant, test-only, one-booking DOM consumer. No CLI/runtime wiring.
// Owner supplies a fresh strict context (ignoreHTTPSErrors:false,
// serviceWorkers:"block"), injected self Cookie, and owns all teardown.
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { parsePreview, parseConfirm, intervalLabel, dateTimeLabel, validMonth,
  validDateTime, classificationLabels } from "../../src/web/model.ts";
import { expectedHistory } from "./trusted-https-assertions.mjs";

export const bookingOrigin = "https://127.0.0.1:8789";
const timeout = 5000; // Same per-operation bound as the existing read-only DOM helper.
const spent = new WeakSet();
const assets = new Map([["/student", "text/html"], ["/student.css", "text/css"],
  ...["student", "view", "controller", "model"].map(n => [`/${n}.js`, "text/javascript"])]);
const previewPath = "/api/me/reservations/preview", confirmPath = "/api/me/reservations";
const csrfPath = "/api/auth/student/csrf";
const failure = reason => new Error(`TRUSTED_BOOKING_DOM_${reason}`);
const check = condition => { if (!condition) throw failure("ASSERTION"); };

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

export async function proveTrustedBookingDom({ browser, context, session, seed, signal }) {
  let reason, terminal = false, page, phase = "initial", navigationCount = 0;
  const requests = new Map(), responses = new Map(), seenAssets = new Map();
  let previewCount = 0, confirmCount = 0, csrfCount = 0, expectedToken;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = value => {
    if (!reason) { reason = value; terminal = true; rejectStopped(failure(reason)); }
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
  const step = async action => {
    alive(); let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => { alive(); return action(); }), stopped,
        new Promise((_, reject) => { timer = setTimeout(() => { stop("TIMEOUT"); reject(failure(reason)); }, timeout); })]);
      alive(); return result;
    } finally { clearTimeout(timer); }
  };
  const onAbort = () => stop("ABORTED");
  try {
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
    await step(() => context.route("**/*", async route => {
      const request = route.request();
      try {
        if (terminal || signal.aborted) { if (signal.aborted) stop("ABORTED"); await route.abort(); return; }
        const url = new URL(request.url()), method = request.method();
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
          check(headers.origin === bookingOrigin && headers["sec-fetch-site"] === "same-origin" &&
            headers["content-type"] === "application/json" && headers["x-csrf-token"] === expectedCsrf);
        } else {
          check(method === "GET" && (assets.has(url.pathname) || url.pathname === "/favicon.ico" || url.pathname === confirmPath || url.pathname === csrfPath ||
            /^\/api\/me\/schedule-months\/\d{4}-(0[1-9]|1[0-2])$/.test(url.pathname)));
          if (url.pathname === csrfPath) check(phase === "preview" && ++csrfCount === 1);
          if (request.isNavigationRequest()) check(url.pathname === "/student" && phase === "initial");
        }
        alive(); // In particular, abort during request-header observation cannot forward a write.
        requests.set(request, { path: url.pathname, method });
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
        page.getByRole("button", { name, exact: true }).click({ timeout }),
      ]));
      return api(response, path, method, status);
    };
    const navigation = await step(() => page.goto(bookingOrigin + "/student", { waitUntil: "load", timeout }));
    check(navigation && navigation.status() === 200 && navigation.url() === bookingOrigin + "/student" && navigationCount === 1);
    phase = "select";
    await step(() => page.getByRole("heading", { name: "生徒の予定・本人履歴", exact: true }).waitFor({ timeout }));
    for (const [path, mime] of assets) {
      const asset = seenAssets.get(path), headers = asset && await step(() => asset.allHeaders());
      check(asset?.status() === 200 && headers["content-type"].startsWith(mime) && headers["cache-control"] === "no-store" && !headers["set-cookie"]);
    }
    await settled("#schedule-content"); await settled("section ol");
    await step(() => page.locator("#schedule-month").fill(seed.month, { timeout }));
    await click("この月を取得"); await settled("#schedule-content");
    const historyText = item => [intervalLabel(item), "予約状態：予約済み", "欠席状態：なし", "現在の区分：標準"].join("");
    const initialHistory = expectedHistory(seed, "self");
    check(await step(() => page.locator("section ol li").allTextContents()).then(v => isDeepStrictEqual(v, initialHistory.items.map(historyText))));
    check(await step(() => page.getByRole("button", { name: "履歴の次ページ", exact: true }).isDisabled()));
    check(await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
    await safeDom();
    await click(`${intervalLabel(slot)}：予約可能`);
    check(await step(() => page.locator("#selection-status").textContent()).then(v => v.includes("予約は確定していません")));
    check(previewCount === 0 && confirmCount === 0 && csrfCount === 0);
    check(await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
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
    await step(() => assertBookingReviewDom(page, parsed.view, parsed.view.previewClassification, step)); await safeDom();
    check(previewCount === 1 && confirmCount === 0);
    check(!await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
    expectedToken = parsed.token; // Enable the only write after all review assertions.
    phase = "confirm";
    const confirmBody = await observeClick("内容を確認して予約を確定", confirmPath, "POST", 201);
    const confirmed = parseConfirm(confirmBody, slot), reservationId = confirmed.reservation.reservationId;
    check(reservationId !== "seed-reservation-self" && reservationId !== "seed-reservation-other" && secrets.every(s => !reservationId.includes(s)));
    check(isDeepStrictEqual(confirmBody, { reservation: { reservationId, startsAt: slot.startsAt, endsAt: slot.endsAt,
      reservationState: "confirmed", classification: "standard" }, slot: { ...parsed.view.slot, view: "reserved_by_me" }, classificationChanges: [] }));
    await settled("#operation-content"); await settled("#schedule-content");
    await step(() => assertBookingReviewDom(page, confirmed, confirmed.reservation.classification, step));
    check(await step(() => page.locator("#operation-status").textContent()).then(v => v === "予約済みです。メールの配送完了を表すものではありません。"));
    check(await step(() => page.getByRole("button", { name: "内容を確認して予約を確定", exact: true }).isDisabled()));
    check(await step(() => page.locator(".slot.reserved_by_me").allTextContents()).then(v => v.includes(`${intervalLabel(slot)}：本人予約済み／標準`)));
    phase = "history";
    const history = await observeClick("履歴を最新から再取得", confirmPath, "GET", 200);
    const expectedItems = [...initialHistory.items, { ...confirmed.reservation, attendanceState: "none" }];
    check(isDeepStrictEqual(history, { items: expectedItems, nextCursor: null })); // startsAt DESC: 11:00 then 10:00.
    await settled("section ol");
    check(await step(() => page.locator("section ol li").allTextContents()).then(v => isDeepStrictEqual(v, expectedItems.map(historyText))));
    await safeDom(); alive(); check(previewCount === 1 && confirmCount === 1);
    terminal = true; // Retain the deny guard. Owner closes context; never reuse it.
    return reservationId; // Only the actual Browser POST 201 identity; no readback claim.
  } catch (error) {
    stop(error?.name === "TimeoutError" ? "TIMEOUT" : "ASSERTION");
    throw failure(reason); // No raw error, cause, URL, headers, payload, or PII.
  } finally { signal?.removeEventListener?.("abort", onAbort); }
}
