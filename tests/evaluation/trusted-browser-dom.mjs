// #922: existing strict Browser / Session context; no new runner or identity path.
import { check, expectedSchedule } from "./trusted-https-assertions.mjs";
import { origin } from "./browser-tls-trust.mjs";

export const domProofCheckpoint = "#922 partial: real /student same-origin assets and owner-only read-only DOM; separate synthetic errors/paging/stale-month/Tokyo-year-boundary; keyboard/focus/320px checks passed; Preview/Confirm/Gate A-D unverified";
const timeout = 5000;
async function settled(page, area = "schedule") {
  await page.waitForFunction((area) => document.querySelector(area === "schedule" ? "#schedule-content" : "section ol")?.getAttribute("aria-busy") === "false", area, { timeout });
}
async function choose(page, month) {
  await page.locator("#schedule-month").fill(month, { timeout });
  await page.getByRole("button", { name: "この月を取得", exact: true }).click({ timeout });
  await settled(page);
}
async function safeDom(page, forbidden) {
  const text = await page.evaluate(() => document.documentElement.outerHTML + location.href);
  check(forbidden.every(value => !text.includes(value)));
  check(await page.evaluate(() => document.cookie === "" && location.search === "" && location.hash === ""));
}

export async function proveStudentDom(page, signal, seed, secrets, revoked = false) {
  signal.throwIfAborted();
  const seen = new Map();
  const observe = response => {
    if (["/student", "/student.css", "/student.js", "/view.js", "/controller.js", "/model.js"].includes(new URL(response.url()).pathname)) seen.set(new URL(response.url()).pathname, response);
  };
  page.on("response", observe);
  try {
    const response = await page.goto(origin + "/student", { waitUntil: "load", timeout });
    check(response?.status() === 200 && response.url() === origin + "/student");
    await page.getByRole("heading", { name: "生徒の予定・本人履歴", exact: true }).waitFor({ timeout });
    for (const [path, mime] of [["/student", "text/html"], ["/student.css", "text/css"], ["/student.js", "text/javascript"],
      ["/view.js", "text/javascript"], ["/controller.js", "text/javascript"], ["/model.js", "text/javascript"]]) {
      const asset = seen.get(path), headers = asset && await asset.allHeaders();
      check(asset?.status() === 200 && headers["content-type"].startsWith(mime) && headers["cache-control"] === "no-store" && !headers["set-cookie"]);
    }
    await settled(page); await settled(page, "history");
    if (revoked) {
      check((await page.locator("#schedule-status").textContent()).includes("認証が必要です"));
      check(await page.locator("#schedule-month").isDisabled());
      check(await page.locator(".slot").count() === 0 && await page.locator("section ol li").count() === 0);
      await safeDom(page, secrets); return;
    }
    await choose(page, seed.month);
    check(await page.locator(".slot").count() === 5);
    const slots = expectedSchedule(seed, "self").slots;
    const labels = { bookable: "予約可能", reserved_by_me: "本人予約済み", group_lesson: "グループレッスン（予約不可）", unavailable: "予約不可" };
    for (const [i, slot] of slots.entries()) {
      const node = page.locator(".slot").nth(i);
      check((await node.textContent()).includes(labels[slot.view]));
      check((await node.evaluate(node => node.tagName === "BUTTON")) === (slot.view === "bookable"));
    }
    await page.setViewportSize({ width: 320, height: 640 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 320 &&
      document.querySelector(".calendar-scroll").scrollWidth > document.querySelector(".calendar-scroll").clientWidth));
    check(await page.locator("section ol li").count() === 1);
    check((await page.locator("section ol").textContent()).includes("11:00") && !(await page.locator("section ol").textContent()).includes("12:00 ～"));
    await page.getByRole("button", { name: "一覧表示", exact: true }).focus();
    await page.keyboard.press("Enter");
    check(await page.locator("#schedule-content ul .slot").count() === 5);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 320));
    check(await page.evaluate(() => document.activeElement?.textContent === "一覧表示"));
    await page.locator("button.slot").focus(); await page.keyboard.press("Space");
    check((await page.locator("#selection-status").textContent()).includes("予約は確定していません"));
    await page.getByRole("button", { name: "履歴を最新から再取得", exact: true }).click({ timeout });
    await settled(page, "history");
    check(await page.evaluate(() => document.activeElement?.id === "history-status"));
    check(await page.getByRole("button", { name: "履歴の次ページ", exact: true }).isDisabled());
    await safeDom(page, [...secrets, "seed-other", "seed-reservation-other", "料金", "token_hash", "snapshot"]);
    await proveSyntheticDom(page, signal);
  } finally { page.off("response", observe); }
  signal.throwIfAborted();
}

// Driver-only isolated fixture: never an HTTP route/Guard bypass. Reuses the
// built mountStudent and fixed API wires; its results are synthetic evidence.
export async function proveSyntheticDom(page, signal) {
  signal.throwIfAborted();
  await page.evaluate(async () => {
    const { mountStudent } = await import("/view.js");
    const pending = [];
    const root = document.getElementById("student");
    const controller = mountStudent(root, "2026-12", (path, init) => {
      if (init.method !== "GET" || init.credentials !== "same-origin") throw new Error("fixture request");
      return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
    });
    const respond = (index, value, status = 200) => pending[index].resolve(Response.json(value, { status }));
    const history = { reservationId: "fixture-self", reservationState: "confirmed", attendanceState: "none", classification: "standard",
      startsAt: "2026-12-31T23:30:00+09:00", endsAt: "2027-01-01T01:00:00+09:00" };
    respond(0, { month: "2026-12", slots: [] }); respond(1, { items: [history], nextCursor: "fixture-next" });
    // Store only secretless fixture control on this test page, never Session/CSRF.
    globalThis.__studentFixture = { controller, pending, respond, history };
  });
  await settled(page); await settled(page, "history");
  check((await page.locator("section ol").textContent()).includes("2027年01月01日 01:00（日本時間）"));
  await page.getByRole("button", { name: "履歴の次ページ", exact: true }).click({ timeout });
  await page.evaluate(() => {
    const f = globalThis.__studentFixture;
    if (f.pending[2].path !== "/api/me/reservations?cursor=fixture-next") throw new Error("fixture cursor");
    f.respond(2, { items: [{ ...f.history, reservationState: "school_cancelled", attendanceState: "absent", classification: "additional" }], nextCursor: null });
  });
  await settled(page, "history");
  check(await page.locator("section ol li").count() === 1);
  const historyText = await page.locator("section ol").textContent();
  check(["スクール都合キャンセル", "欠席", "追加"].every(value => historyText.includes(value)));
  // A newer month wins even when the old response arrives last; year crossing.
  await page.evaluate(async () => {
    const f = globalThis.__studentFixture;
    const old = f.controller.loadMonth("2026-12"), current = f.controller.loadMonth("2027-01");
    f.respond(4, { month: "2027-01", slots: [] }); await current;
    f.respond(3, { month: "2026-12", slots: [] }); await old;
  });
  check(await page.locator("#schedule-month").inputValue() === "2027-01");
  for (const [status, code, text] of [[403, "FORBIDDEN", "この操作は利用できません"],
    [404, "SCHEDULE_MONTH_NOT_AVAILABLE", "別の月を選択"], [503, "SERVICE_UNAVAILABLE", "現在の状態を確認できません"],
    [0, "", "現在の状態を確認できません"], [401, "UNAUTHENTICATED", "認証が必要です"]]) {
    await page.evaluate(async ({ status, code }) => {
      const f = globalThis.__studentFixture, index = f.pending.length;
      const reading = f.controller.loadMonth("2027-01");
      if (status === 0) f.pending[index].reject(new Error("private-canary"));
      else f.respond(index, { error: { code, message: "private-canary" } }, status);
      await reading;
    }, { status, code });
    check((await page.locator("#schedule-status").textContent()).includes(text));
    check(await page.evaluate(() => document.activeElement?.id === "schedule-status"));
    await safeDom(page, ["private-canary"]);
  }
  check(await page.locator("#schedule-month").isDisabled());
  await page.setViewportSize({ width: 320, height: 640 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 320 &&
    document.querySelector(".calendar-scroll").scrollWidth > document.querySelector(".calendar-scroll").clientWidth));
  // List must also fit; fixed fixture is independent of device timezone.
  await page.getByRole("button", { name: "一覧表示", exact: true }).click({ timeout });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 320));
  await page.evaluate(() => { delete globalThis.__studentFixture; });
  signal.throwIfAborted();
}
