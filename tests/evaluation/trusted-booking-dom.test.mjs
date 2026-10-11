// Finite driver/DOM doubles: assertion/control flow evidence, never Chrome/TLS/D1 proof.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { useTrustedBookingProcess } from "./trusted-booking-process.mjs";
import { encodeBookingDiagnostic, parseBookingDiagnostic } from "./trusted-booking-report.mjs";
import { proveTrustedBookingDom, assertBookingReviewDom, bookingOrigin } from "./trusted-booking-dom.mjs";

const previewName = "選択枠の予約内容をPreview", confirmName = "内容を確認して予約を確定";
const previewPath = "/api/me/reservations/preview", confirmPath = "/api/me/reservations";
const csrfPath = "/api/auth/student/csrf";
const canary = "private-canary";
function fixture(fault = "") {
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
    const request = { url: () => url, method: () => method, redirectedFrom: () => fault === "redirect" && path === previewPath ? {} : null,
      frame: () => frame, isNavigationRequest: () => navigation,
      postDataJSON: () => fault === "identity-body" ? { slotId: slot.slotId, studentId: "seed-other" } :
        path === previewPath ? { slotId: slot.slotId } : { slotId: slot.slotId, expectedStateToken: fault === "wrong-confirm-token" ? canary : token },
      allHeaders: async () => {
        if ((fault === "abort-headers" || fault === "abort-confirm-headers" && path === confirmPath) && method === "POST") controller.abort(canary);
        return { origin: fault === "wrong-request-origin" ? "https://invalid.test" : bookingOrigin, "sec-fetch-site": "same-origin",
          "content-type": "application/json", "x-csrf-token": fault === "wrong-request-csrf" ? canary : csrf };
      } };
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
    await routeHandler({ request: () => request, abort: async () => { denied.push(path); }, continue: async () => {
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
    assert.doesNotMatch(readFileSync(file, "utf8"), /trusted-booking-dom|proveTrustedBookingDom|assertBookingReviewDom/, file);
  }
  const source = readFileSync("tests/evaluation/trusted-booking-dom.mjs", "utf8");
  assert.doesNotMatch(source, /route\.fulfill|\.reload\(|\.addCookies\(|browser\.newContext|\.launch\(|\.close\(|child_process|wrangler|systemd/);
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
  for (const [fault, stage, first, write] of [
    ["", "complete", "none", "response-201"], ["missing-asset", "assets", "assertion", "unobserved"],
    ["wrong-dom-classification", "review", "assertion", "unobserved"],
    ["click-confirm", "confirm", "driver", "action-start"], ["wrong-confirm-token", "confirm", "request", "request-seen"],
    ["network-unknown", "confirm", "network", "route-allowed"], ["confirm-409", "confirm", "response", "route-allowed"],
    ["stale-history", "history", "assertion", "response-201"], ["abort-confirm-headers", "confirm", "abort", "request-seen"],
  ]) {
    const f = fixture(fault), snapshots = [], lifecycle = [];
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
