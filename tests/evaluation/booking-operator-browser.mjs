// Passive human-operation observer: never clicks, fills, fetches, or replays.
import { createHash } from "node:crypto";
import { parsePreview, parseConfirm, parseHistory, parseCsrf, intervalLabel, moveMonth } from "../../src/web/model.ts";
import { origin } from "./trusted-booking-seed.mjs";
import { demand, bounded, fail } from "./booking-operator-unit.mjs";
const preview = "/api/me/reservations/preview", confirm = "/api/me/reservations", csrf = "/api/auth/student/csrf";
const assets = new Set(["/student", "/student.css", "/student.js", "/view.js", "/controller.js", "/model.js", "/favicon.ico"]);
const schedulePath = /^\/api\/me\/schedule-months\/\d{4}-(0[1-9]|1[0-2])$/;
export function humanBookingObservation(month, expectedCsrf) {
  let open = true, unknown = false, previews = 0, confirms = 0, token, reservation, history = false;
  let scheduleRequested = false, initialUnavailableObserved = false;
  const initialMonthPath = `/api/me/schedule-months/${moveMonth(month, -1)}`;
  const slot = { slotId: "seed-slot-bookable", startsAt: `${month}-15T10:00:00+09:00`, endsAt: `${month}-15T11:00:00+09:00` };
  return Object.freeze({
    request(path, method, body, headers) {
      try {
        demand(open && !unknown);
        if (method === "GET") {
          const schedule = schedulePath.test(path);
          demand(body === null && (assets.has(path) || path === confirm || path === csrf || schedule));
          if (!schedule) return false;
          const initial = !scheduleRequested && previews === 0 && path === initialMonthPath;
          scheduleRequested = true;
          return initial;
        }
        demand(method === "POST" && headers.origin === origin && headers["content-type"] === "application/json" &&
          headers["x-csrf-token"] === expectedCsrf && (!Object.hasOwn(headers, "sec-fetch-site") || headers["sec-fetch-site"] === "same-origin"));
        if (path === preview) {
          demand(++previews === 1 && confirms === 0 && JSON.stringify(body) === JSON.stringify({ slotId: slot.slotId }));
        } else {
          demand(path === confirm && previews === 1 && token && ++confirms === 1 &&
            JSON.stringify(body) === JSON.stringify({ slotId: slot.slotId, expectedStateToken: token }));
        }
      } catch { unknown = true; open = false; throw fail(); }
    },
    response(path, method, status, body, afterConfirm = reservation !== undefined, initialSchedule = false) {
      try {
        demand(!unknown);
        if (method === "POST" && path === preview) {
          demand(previews === 1 && confirms === 0 && status === 200 && !token);
          const parsed = parsePreview(body, slot); demand(parsed.view.previewClassification === "standard" && parsed.view.classificationChanges.length === 0);
          token = parsed.token;
        } else if (method === "POST") {
          demand(path === confirm && confirms === 1 && status === 201 && !reservation);
          const parsed = parseConfirm(body, slot); demand(parsed.reservation.classification === "standard" && parsed.classificationChanges.length === 0);
          reservation = parsed.reservation;
        } else if (path === csrf) {
          demand(method === "GET" && status === 200 && parseCsrf(body) === expectedCsrf);
        } else if (path === confirm && status === 200) {
          const parsed = parseHistory(body);
          if (afterConfirm) {
            demand(reservation);
            history = parsed.items.filter(r => r.reservationId === reservation.reservationId &&
              r.startsAt === slot.startsAt && r.endsAt === slot.endsAt && r.reservationState === "confirmed" && r.classification === "standard").length === 1;
          }
        } else if (status === 404) {
          const error = body?.error;
          demand(initialSchedule && !initialUnavailableObserved && method === "GET" && path === initialMonthPath &&
            error?.code === "SCHEDULE_MONTH_NOT_AVAILABLE" && error.retry === "none" &&
            typeof error.message === "string" && error.message.length > 0);
          initialUnavailableObserved = true;
        } else demand(status === 200 || path === "/favicon.ico" && status === 503);
      } catch { unknown = true; open = false; throw fail(); }
    },
    close() { open = false; },
    invalidate() { unknown = true; open = false; },
    result() { demand(!open && !unknown && previews === 1 && confirms === 1 && reservation && history); return reservation.reservationId; },
    slot, token: () => token,
  });
}
export async function observeHumanBrowser(context, session, month, onFailure) {
  const cookie = session.cookie(), expectedCsrf = createHash("sha256").update("student-csrf-v1:" + cookie.value).digest("base64url");
  demand(cookie.name === "__Host-student_session" && cookie.secure && cookie.httpOnly && cookie.sameSite === "Lax" && cookie.path === "/" && !Object.hasOwn(cookie, "domain"));
  demand((await context.cookies()).length === 0 && context.pages().length === 0);
  await context.addCookies([{ name: cookie.name, value: cookie.value, url: origin + "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const jar = await context.cookies(origin);
  demand(jar.length === 1 && jar[0].value === cookie.value && jar[0].name === cookie.name && jar[0].domain === "127.0.0.1" &&
    jar[0].path === "/" && jar[0].httpOnly && jar[0].secure && jar[0].sameSite === "Lax" && jar[0].expires === -1);
  const observation = humanBookingObservation(month, expectedCsrf), requests = new Map(), pending = new Set();
  let page, confirmObservation, navigation = 0, closed = false;
  const completed = new Set();
  const bad = () => { observation.invalidate(); onFailure(); };
  await context.route("**/*", async route => {
    const request = route.request();
    try {
      demand(!closed);
      const raw = request.url(), url = new URL(raw);
      demand(raw === origin + url.pathname && url.origin === origin && request.redirectedFrom() === null && request.frame() === page.mainFrame());
      demand(!request.isNavigationRequest() || url.pathname === "/student" && navigation === 0);
      const method = request.method(), headers = await request.allHeaders();
      demand(!closed && !headers.authorization);
      const initialSchedule = observation.request(url.pathname, method, method === "POST" ? request.postDataJSON() : request.postData(), headers);
      const priorConfirm = method === "GET" && url.pathname === confirm ? confirmObservation : undefined;
      requests.set(request, { path: url.pathname, method, priorConfirm, initialSchedule }); await route.continue();
    } catch { bad(); try { await route.abort(); } catch { /* one teardown owns closure */ } }
  });
  await context.routeWebSocket("**/*", socket => { socket.close(); bad(); });
  context.on("page", candidate => { if (page && candidate !== page) bad(); }); context.on("serviceworker", bad);
  page = await context.newPage();
  await page.addInitScript(() => {
    let confirms = 0;
    Object.defineProperty(window, "__nssscdlOperatorHumanConfirms", { get: () => confirms, configurable: false });
    document.addEventListener("click", event => {
      if (event.isTrusted && event.target instanceof Element &&
        event.target.closest("button")?.textContent === "予約する") confirms++;
    }, true);
  });
  page.on("popup", bad); page.on("download", bad); page.on("websocket", bad);
  page.on("requestfailed", () => { if (!closed) bad(); });
  page.on("framenavigated", frame => { if (frame !== page.mainFrame() || ++navigation !== 1 || frame.url() !== origin + "/student") bad(); });
  page.on("response", response => {
    if (closed) return;
    const identity = requests.get(response.request());
    const task = bounded(async () => {
      demand(identity && !completed.has(response.request()) && !response.fromServiceWorker() && response.url() === response.request().url());
      const headers = await response.allHeaders();
      demand(headers["cache-control"] === "no-store" && !headers["set-cookie"] && !Object.keys(headers).some(k => k.startsWith("access-control-")));
      const api = identity.path.startsWith("/api/");
      const body = api ? await response.json() : undefined;
      if (api) demand(/^application\/json(?:;|$)/.test(headers["content-type"]));
      // The page can finish parsing 201 and load History before the observer parses 201.
      if (identity.priorConfirm) await identity.priorConfirm;
      observation.response(identity.path, identity.method, response.status(), body, identity.priorConfirm !== undefined, identity.initialSchedule);
      completed.add(response.request());
    }, 5000).catch(bad);
    if (identity?.path === confirm && identity.method === "POST") confirmObservation = task;
    pending.add(task); task.finally(() => pending.delete(task));
  });
  await bounded(async () => { const response = await page.goto(origin + "/student", { waitUntil: "load", timeout: 5000 }); demand(response?.status() === 200); }, 10000);
  return Object.freeze({
    closeAdmission() { closed = true; observation.close(); },
    async finish() {
      demand(closed); await bounded(() => Promise.all([...pending]), 10000);
      const id = observation.result();
      demand(completed.size === requests.size);
      const secrets = [cookie.value, expectedCsrf, observation.token(), createHash("sha256").update(cookie.value).digest("hex")];
      demand(await page.evaluate(values => document.cookie === "" && window.__nssscdlOperatorHumanConfirms === 1 &&
        values.every(secret => !document.documentElement.outerHTML.includes(secret)), secrets));
      demand((await page.locator("#operation-status").textContent()) === "予約済みです。メールの配送完了を表すものではありません。");
      const label = `${intervalLabel(observation.slot)}予約状態：予約済み欠席状態：なし現在の区分：標準`;
      demand((await page.locator("#history-content li").allTextContents()).includes(label));
      return id;
    },
  });
}
