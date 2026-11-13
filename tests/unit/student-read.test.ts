import { describe, expect, it, vi } from "vitest";
import { StudentReadController } from "../../src/web/controller";
import { monthDays, moveMonth, tokyoNowMonth, validDateTime, parseSchedule, parseHistory, intervalLabel, parsePreview, parseConfirm, parseCsrf } from "../../src/web/model";
import { mountStudent } from "../../src/web/view";

const slot = (view = "bookable", slotId = "slot") => ({ slotId, view,
  startsAt: "2026-12-31T16:00:00+09:00", endsAt: "2026-12-31T17:30:00+09:00" });
const otherSlot = () => ({ ...slot("bookable", "other-slot"),
  startsAt: "2026-12-31T19:00:00+09:00", endsAt: "2026-12-31T20:30:00+09:00" });
const item = (reservationState = "confirmed", attendanceState = "none", classification = "standard") => ({
  reservationId: "reservation", startsAt: "2026-12-31T16:00:00+09:00", endsAt: "2026-12-31T17:30:00+09:00",
  reservationState, attendanceState, classification,
});
// BR-003 / BR-011 / BR-012 and ScheduleModel §3.3: 90 minutes, fixed starts, unique Slots.
function fourSlots() {
  return ["bookable", "reserved_by_me", "group_lesson", "unavailable"].map((view, i) => ({
    ...slot(view, ["slot", "mine", "group", "busy"][i]),
    startsAt: `2026-12-26T${["10:30", "13:30", "15:30", "17:30"][i]}:00+09:00`,
    endsAt: `2026-12-26T${["12:00", "15:00", "17:00", "19:00"][i]}:00+09:00`,
  }));
}
function busyMonth() {
  const slots = [];
  for (let day = 1; day <= 31; day++) {
    const weekday = new Date(Date.UTC(2026, 11, day)).getUTCDay();
    if (weekday === 1) continue;
    const times = weekday === 0 || weekday === 6
      ? [["10:30", "12:00"], ["13:30", "15:00"], ["15:30", "17:00"], ["17:30", "19:00"], ["19:00", "20:30"]]
      : [["16:00", "17:30"], ["19:00", "20:30"], ["21:00", "22:30"]];
    for (const [start, end] of times) slots.push({ ...slot("bookable", `slot-${day}-${start}`),
      startsAt: `2026-12-${String(day).padStart(2, "0")}T${start}:00+09:00`,
      endsAt: `2026-12-${String(day).padStart(2, "0")}T${end}:00+09:00` });
  }
  return slots;
}
function response(value: unknown, status = 200): Response { return Response.json(value, { status }); }
function pending() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const calls: { path: string; init?: RequestInit; request: ReturnType<typeof pending> }[] = [];
  const events: { area: string; focus: boolean }[] = [];
  const fetcher = ((path: string, init?: RequestInit) => {
    const request = pending(); calls.push({ path, init, request }); return request.promise;
  }) as typeof fetch;
  const controller = new StudentReadController("2026-12", fetcher, (area, focus) => events.push({ area, focus }));
  return { calls, events, controller, fetcher };
}
const csrf = "A".repeat(43), expectedToken = "v1.synthetic-token-canary";
function previewBody(classification = "standard", classificationChanges: unknown[] = [], selected = slot()) {
  const { slotId, startsAt, endsAt } = selected;
  return { slot: { slotId, startsAt, endsAt }, previewClassification: classification, classificationChanges, expectedStateToken: expectedToken };
}
function confirmBody(classification = "standard", classificationChanges: unknown[] = []) {
  const { slotId, startsAt, endsAt } = slot();
  return { slot: { slotId, startsAt, endsAt, view: "reserved_by_me" },
    reservation: { reservationId: "new-reservation", startsAt, endsAt, reservationState: "confirmed", classification }, classificationChanges };
}
async function scheduleHarness() {
  const h = harness(), read = h.controller.loadMonth("2026-12");
  h.calls[0].request.resolve(response({ month: "2026-12", slots: [slot(), otherSlot(), slot("bookable", "same-time")] }));
  await read; return h;
}
async function reviewedHarness() {
  const h = await scheduleHarness(), read = h.controller.select("slot");
  h.calls[1].request.resolve(response({ scope: "session", csrfToken: csrf }));
  await vi.waitFor(() => expect(h.calls).toHaveLength(3));
  h.calls[2].request.resolve(response(previewBody())); await read; return h;
}

describe("TC-F-001-03 [#1148 initial Schedule search]", () => {
  const december = "2026-12", january = "2027-01";
  const januarySlot = { ...slot(), startsAt: "2027-01-05T16:00:00+09:00", endsAt: "2027-01-05T17:30:00+09:00" };
  const monthPath = (month: string) => `/api/me/schedule-months/${month}`;
  const empty = (month: string) => response({ month, slots: [] });
  const unpublished = () => response({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE", message: "private-canary" } }, 404);

  it("starts from the JST month even before UTC midnight", () => {
    try {
      vi.setSystemTime(new Date("2026-12-31T14:59:59Z"));
      expect(tokyoNowMonth()).toBe(december);
      vi.setSystemTime(new Date("2026-12-31T15:00:00Z"));
      expect(tokyoNowMonth()).toBe(january);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["empty", () => empty(december)],
    ["unavailable", () => response({ month: december, slots: [slot("unavailable")] })],
    ["reserved by me", () => response({ month: december, slots: [{ ...slot("reserved_by_me"), classification: "standard" }] })],
    ["unpublished", unpublished],
  ] as const)("checks January once after a December result with no bookable day (%s)", async (_label, firstResponse) => {
    const { controller, calls, events } = harness(), initial = controller.loadInitialSchedule();
    expect(calls.map(call => call.path)).toEqual([monthPath(december)]);
    calls[0].request.resolve(firstResponse());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(controller.state).toMatchObject({ month: january, scheduleLoading: true, selectedDate: null });
    const later = { ...januarySlot, slotId: "later", startsAt: "2027-01-06T16:00:00+09:00", endsAt: "2027-01-06T17:30:00+09:00" };
    calls[1].request.resolve(response({ month: january, slots: [later, januarySlot] })); await initial;
    await controller.loadInitialSchedule();
    expect(controller.state).toMatchObject({ month: january, scheduleReady: true, scheduleLoading: false,
      selectedDate: "2027-01-05", selectedId: null, preview: null, operation: "idle" });
    expect(calls.map(call => [call.init?.method, call.path])).toEqual([["GET", monthPath(december)], ["GET", monthPath(january)]]);
    expect(events.every(event => event.area === "schedule" && !event.focus)).toBe(true);
  });

  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])("shows month navigation guidance after two months (unpublished: %s / %s)", async (firstUnpublished, secondUnpublished) => {
    const { controller, calls } = harness(), initial = controller.loadInitialSchedule();
    calls[0].request.resolve(firstUnpublished ? unpublished() : empty(december));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].request.resolve(secondUnpublished ? unpublished() : empty(january)); await initial;
    expect(controller.state).toMatchObject({ month: january, selectedDate: null, scheduleReady: !secondUnpublished, scheduleLoading: false });
    expect(controller.state.scheduleMessage).toContain("別の月を選択");
    expect(controller.state.scheduleMessage).toContain(secondUnpublished ? "予定は利用できません" : "この月の枠はありません");
    expect(controller.state.scheduleMessage).not.toContain("private-canary");
    expect(calls).toHaveLength(2);
  });

  const errors = [
    { status: 401, code: "UNAUTHORIZED", message: "認証が必要です" },
    { status: 403, code: "FORBIDDEN", message: "この操作は利用できません" },
    { status: 503, code: "SERVICE_UNAVAILABLE", message: "現在の状態を確認できません" },
    { status: 404, code: "UNEXPECTED", message: "現在の状態を確認できません" },
    { status: 200, code: "INVALID_BODY", message: "現在の状態を確認できません" },
    { status: 0, code: "NETWORK_ERROR", message: "現在の状態を確認できません" },
  ];
  it.each([december, january].flatMap(month => errors.map(error => ({ month, ...error }))))
    ("stops at $month on $code", async ({ month, status, code, message }) => {
      const { controller, calls } = harness(), initial = controller.loadInitialSchedule();
      const index = month === december ? 0 : 1;
      if (index === 1) {
        calls[0].request.resolve(empty(december));
        await vi.waitFor(() => expect(calls).toHaveLength(2));
      }
      if (status === 0) calls[index].request.reject(new Error("private-canary"));
      else calls[index].request.resolve(response({ error: { code, message: "private-canary" } }, status));
      await initial;
      expect(calls).toHaveLength(index + 1);
      expect(controller.state).toMatchObject({ month, scheduleReady: false, scheduleLoading: false, selectedDate: null, stopped: status === 401 });
      expect(controller.state.scheduleMessage).toContain(message);
      expect(controller.state.scheduleMessage).not.toContain("private-canary");
    });

  it.each([
    [december, "before", 200], [december, "after", 404], [december, "after", 401],
    [january, "before", 404], [january, "after", 200], [january, "after", 401],
  ] as const)("honors a manual month during %s with the old response %s manual completion (%i)", async (month, order, status) => {
    const { controller, calls } = harness(), initial = controller.loadInitialSchedule();
    if (month === january) {
      calls[0].request.resolve(empty(december));
      await vi.waitFor(() => expect(calls).toHaveLength(2));
    }
    const old = calls.at(-1)!.request;
    const march = "2027-03", manual = controller.loadMonth(march);
    expect(calls.map(call => call.path)).toEqual([monthPath(december), ...(month === january ? [monthPath(january)] : []), monthPath(march)]);
    const oldResponse = status === 200
      ? month === december ? empty(month) : response({ month, slots: [januarySlot] })
      : status === 404 ? unpublished() : response({}, 401);
    const current = calls.at(-1)!.request;
    const slots = order === "after" ? [{ ...januarySlot, startsAt: "2027-03-05T16:00:00+09:00", endsAt: "2027-03-05T17:30:00+09:00" }] : [];
    if (order === "before") {
      old.resolve(oldResponse); await initial;
      expect(controller.state).toMatchObject({ month: march, scheduleLoading: true, selectedDate: null });
    }
    current.resolve(response({ month: march, slots })); await manual;
    if (order === "after") { old.resolve(oldResponse); await initial; }
    expect(controller.state).toMatchObject({ month: march, scheduleLoading: false, stopped: status === 401,
      selectedDate: status !== 401 && slots.length ? "2027-03-05" : null, scheduleReady: status !== 401 });
    expect(controller.state.scheduleMessage).toContain(status === 401 ? "認証が必要です" : slots.length ? "予定を取得しました" : "この月の枠はありません");
    expect(calls).toHaveLength(month === january ? 3 : 2);
  });
});

describe("TC-F-001-03 / TC-F-002-03〜04 / AC-003-022 [#1138 staged controller evidence]", () => {
  it("selects the earliest bookable day, never a Slot, with one GET and no automatic navigation", async () => {
    const { controller, calls, events } = harness(), read = controller.loadInitialSchedule();
    calls[0].request.resolve(response({ month: "2026-12", slots: [slot("bookable", "later"), ...fourSlots()] })); await read;
    expect(controller.state.selectedDate).toBe("2026-12-26"); expect(controller.state.selectedId).toBeNull();
    expect(events.every(event => !event.focus)).toBe(true);
    controller.selectDate("2026-12-26");
    controller.selectDate("2026-12-27");
    expect(controller.state.selectedDate).toBe("2026-12-27"); expect(controller.state.selectedId).toBeNull();
    controller.selectDate("2027-01-01"); controller.selectDate("2026-12-32");
    expect(controller.state.selectedDate).toBe("2026-12-27"); expect(calls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ area: "day", focus: true });
  });
  it.each([[], [slot("reserved_by_me")], [slot("unavailable")], [slot("group_lesson")]].map(slots => ({ slots })))
    ("does not invent a selected day when the published month has no bookable Slots %#", async ({ slots }) => {
      const { controller, calls } = harness(), read = controller.loadMonth("2026-12", false);
      calls[0].request.resolve(response({ month: "2026-12", slots })); await read;
      expect(controller.state.scheduleReady).toBe(true); expect(controller.state.selectedDate).toBeNull();
      controller.selectDate("2026-12-31"); expect(controller.state.selectedDate).toBe("2026-12-31");
      controller.select("slot"); expect(controller.state.selectedId).toBeNull(); expect(calls).toHaveLength(1);
    });
  it("clears reviewed Slot and token immediately on date/month changes without any date request", async () => {
    const { controller, calls } = await reviewedHarness();
    controller.selectDate("2026-12-30");
    expect(controller.state.preview).toBeNull(); expect(controller.state.selectedId).toBeNull();
    await controller.confirm(); expect(calls).toHaveLength(3);
    controller.select("slot"); expect(controller.state.selectedId).toBeNull();
    const month = controller.loadMonth("2027-01", false);
    expect(controller.state.selectedDate).toBeNull(); expect(controller.state.slots).toEqual([]);
    calls[3].request.resolve(response({ month: "2027-01", slots: [{ ...slot(), startsAt: "2027-01-05T16:00:00+09:00", endsAt: "2027-01-05T17:30:00+09:00" }] }));
    await month; expect(controller.state.selectedDate).toBe("2027-01-05"); expect(calls).toHaveLength(4);
  });
  it.each(["csrf", "preview"].flatMap(stage => ["previewing", "confirming", "failed"].map(operation => ({ stage, operation }))))
    ("old $stage response/finally cannot alter the newer operation when $operation", async ({ stage, operation }) => {
    const { controller, calls } = await scheduleHarness(), old = controller.select("slot");
    let oldIndex = 1;
    if (stage === "preview") {
      calls[1].request.resolve(response({ scope: "session", csrfToken: csrf }));
      await vi.waitFor(() => expect(calls).toHaveLength(3)); oldIndex = 2;
    }
    controller.selectDate("2026-12-30"); controller.selectDate("2026-12-31");
    const fresh = controller.select("slot");
    const readIndex = calls.length - 1;
    expect(calls[readIndex].path).toBe("/api/me/schedule-months/2026-12");
    calls[readIndex].request.resolve(response({ month: "2026-12", slots: [slot()] }));
    const start = readIndex + 1;
    await vi.waitFor(() => expect(calls).toHaveLength(start + 1));
    if (operation === "previewing" || operation === "failed") {
      if (operation === "failed") calls[oldIndex].request.reject(new Error("old-private-error"));
      else calls[oldIndex].request.resolve(response(stage === "csrf" ? { scope: "session", csrfToken: csrf } : previewBody()));
      await old;
      expect(controller.state.operationBusy).toBe(true); expect(controller.state.operation).toBe("previewing");
      expect(controller.state.preview).toBeNull();
    }
    if (stage === "csrf") {
      calls[start].request.resolve(response({ scope: "session", csrfToken: csrf }));
      await vi.waitFor(() => expect(calls).toHaveLength(start + 2));
    }
    calls.at(-1)!.request.resolve(response(previewBody())); await fresh;
    expect(controller.state.operation).toBe("review"); expect(controller.state.operationBusy).toBe(false);
    expect(controller.state.selectedDate).toBe("2026-12-31");
    if (operation === "confirming") {
      const command = controller.confirm();
      calls[oldIndex].request.resolve(response(stage === "csrf" ? { scope: "session", csrfToken: csrf } : previewBody())); await old;
      expect(controller.state.operationBusy).toBe(true); expect(controller.state.operation).toBe("confirming");
      await controller.confirm(); expect(calls.filter(call => call.path === "/api/me/reservations")).toHaveLength(1);
      calls.at(-1)!.request.resolve(response(confirmBody(), 201)); await command;
    } else expect(calls.filter(call => call.path === "/api/me/reservations")).toHaveLength(0);
  });
  it.each(["csrf", "preview"])("obsolete %s 401 still clears the new month and all personal state", async stage => {
    const { controller, calls } = await scheduleHarness(), old = controller.select("slot");
    if (stage === "preview") {
      calls[1].request.resolve(response({ scope: "session", csrfToken: csrf }));
      await vi.waitFor(() => expect(calls).toHaveLength(3));
    }
    const index = calls.length, latest = controller.loadMonth("2027-01", false);
    calls[index].request.resolve(response({ month: "2027-01", slots: [] })); await latest;
    calls[index - 1].request.resolve(new Response("private-canary", { status: 401 })); await old;
    expect(controller.state.stopped).toBe(true); expect(controller.state.selectedDate).toBeNull();
    expect(controller.state.operationBusy).toBe(false); expect(controller.state.scheduleReady).toBe(false);
    await controller.confirm(); expect(calls).toHaveLength(index + 1);
  });
  it("keeps the latest same-day selection when its Schedule and Preview complete before older reads", async () => {
    const { controller, calls } = await scheduleHarness();
    const original = controller.select("slot");
    const replaced = controller.select("same-time");
    const latest = controller.select("other-slot");
    expect(calls.map(call => call.path)).toEqual([
      "/api/me/schedule-months/2026-12", "/api/auth/student/csrf",
      "/api/me/schedule-months/2026-12", "/api/me/schedule-months/2026-12",
    ]);
    calls[3].request.resolve(response({ month: "2026-12", slots: [otherSlot()] }));
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    calls[4].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    calls[5].request.resolve(response(previewBody("standard", [], otherSlot()))); await latest;
    calls[2].request.resolve(response({ month: "2026-12", slots: [slot("bookable", "same-time")] }));
    calls[1].request.resolve(response({ scope: "session", csrfToken: "B".repeat(42) + "A" }));
    await Promise.all([original, replaced]);
    expect(controller.state.selectedId).toBe("other-slot");
    expect(controller.state.slots.map(item => item.slotId)).toEqual(["other-slot"]);
    expect(controller.state.preview?.slot.slotId).toBe("other-slot");
    expect(calls).toHaveLength(6);
    const command = controller.confirm();
    expect(calls[6].init).toMatchObject({ headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify({ slotId: "other-slot", expectedStateToken: expectedToken }) });
    calls[6].request.resolve(response({ error: { code: "FORBIDDEN" } }, 403)); await command;
  });
  it.each(["success", "404", "network"])("guards month/day/Slot changes during Confirm and preserves date/result on readback %s", async mode => {
    const { controller, calls } = await reviewedHarness(), command = controller.confirm();
    controller.selectDate("2026-12-30"); controller.select("other-slot"); await controller.loadMonth("2027-01");
    await controller.confirm(); await controller.select("slot");
    expect(controller.state.selectedDate).toBe("2026-12-31"); expect(controller.state.selectedId).toBe("slot");
    expect(controller.state.month).toBe("2026-12"); expect(calls).toHaveLength(4);
    calls[3].request.resolve(response(confirmBody(), 201)); await command;
    expect(controller.state.selectedDate).toBe("2026-12-31"); expect(calls).toHaveLength(5);
    if (mode === "network") calls[4].request.reject(new Error("private-canary"));
    else if (mode === "404") calls[4].request.resolve(response({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE" } }, 404));
    else calls[4].request.resolve(response({ month: "2026-12", slots: [...fourSlots().map(value => ({ ...value, slotId: `earlier-${value.slotId}` })), slot("reserved_by_me")] }));
    await vi.waitFor(() => expect(controller.state.scheduleLoading).toBe(false));
    expect(controller.state.selectedDate).toBe("2026-12-31"); expect(controller.state.operation).toBe("confirmed");
    expect(controller.state.confirmed?.reservation.reservationId).toBe("new-reservation");
    expect(controller.state.operationMessage).toContain("予約済みです");
    await controller.confirm(); expect(calls).toHaveLength(5);
  });
  it("a pre-existing Schedule GET cannot replace a 201 or its same-date readback", async () => {
    const { controller, calls } = harness(), old = controller.loadMonth("2027-01"), latest = controller.loadMonth("2026-12");
    calls[1].request.resolve(response({ month: "2026-12", slots: [slot()] })); await latest;
    const preview = controller.select("slot");
    calls[2].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(4)); calls[3].request.resolve(response(previewBody())); await preview;
    const command = controller.confirm(); calls[4].request.resolve(response(confirmBody(), 201)); await command;
    calls[5].request.resolve(response({ month: "2026-12", slots: [slot("reserved_by_me")] }));
    await vi.waitFor(() => expect(controller.state.scheduleLoading).toBe(false));
    calls[0].request.resolve(response({ month: "2027-01", slots: [] })); await old;
    expect(controller.state.month).toBe("2026-12"); expect(controller.state.selectedDate).toBe("2026-12-31");
    expect(controller.state.slots[0].view).toBe("reserved_by_me"); expect(controller.state.operation).toBe("confirmed");
    expect(controller.state.confirmed).not.toBeNull(); expect(calls).toHaveLength(6);
  });
});

describe("TC-F-003-01 / TC-F-003-02 / TC-F-003-05 / TC-F-003-08〜10 / TC-F-005-01 / TC-NF-914-03〜04 [#1152 synthetic wire partial evidence]", () => {
  it("automatically Previews on Slot selection, then requires explicit Confirm with exact wire and one Command", async () => {
    const { controller, calls } = await scheduleHarness();
    await controller.confirm(); expect(calls).toHaveLength(1);
    const read = controller.select("slot"); await controller.confirm();
    expect(calls).toHaveLength(2); expect(calls[1].path).toBe("/api/auth/student/csrf");
    expect(calls[1].init).toEqual(calls[0].init);
    calls[1].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2].request.resolve(response({ ...previewBody("additional"), email: "private-canary", snapshot: "private-canary", monthlyN: 3 })); await read;
    expect(controller.state.preview?.previewClassification).toBe("additional");
    expect(JSON.stringify(controller.state)).not.toContain(expectedToken);
    expect(JSON.stringify(controller.state)).not.toContain(csrf);
    expect(JSON.stringify(controller.state)).not.toContain("private-canary");
    const confirm = controller.confirm(); await controller.confirm(); await controller.select("slot");
    expect(calls).toHaveLength(4);
    expect(calls[2]).toMatchObject({ path: "/api/me/reservations/preview", init: { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: '{"slotId":"slot"}' } });
    expect(calls[3].path).toBe("/api/me/reservations");
    expect(calls[3].init).toEqual({ ...calls[2].init, body: JSON.stringify({ slotId: "slot", expectedStateToken: expectedToken }) });
    calls[3].request.resolve(response(confirmBody("additional"), 201)); await confirm;
    expect(controller.state.operation).toBe("confirmed");
    expect(controller.state.operationMessage).toContain("メールの配送完了を表すものではありません");
    expect(controller.state.confirmed?.reservation).toMatchObject({ reservationState: "confirmed", classification: "additional" });
    await controller.confirm(); expect(calls).toHaveLength(5); expect(calls[4].init?.method).toBe("GET");
    calls[4].request.resolve(response({ month: "2026-12", slots: [slot("reserved_by_me")] }));
    await vi.waitFor(() => expect(controller.state.scheduleLoading).toBe(false));
    const history = controller.loadHistory(); calls[5].request.resolve(response({ items: [item()], nextCursor: null })); await history;
    expect(controller.state.operation).toBe("confirmed"); expect(controller.state.history.items).toHaveLength(1);
  });
  it.each([
    [409, "RESERVATION_STATE_CHANGED", "repreview", "状態が変わりました"],
    [409, "RESERVATION_NOT_AVAILABLE", "reload", "予約可能枠"],
    [409, "RESERVATION_WINDOW_CLOSED", "reload", "予約可能枠"],
    [403, "CSRF_INVALID", "reload", "操作を確認できませんでした"],
  ])("discards review on %s %s and requires fresh Schedule and a new Slot selection", async (status, code, retry, guidance) => {
    const { controller, calls } = await reviewedHarness(); const command = controller.confirm();
    calls[3].request.resolve(response({ error: { code, retry, message: "private-canary" } }, status)); await command;
    expect(controller.state.preview).toBeNull(); expect(controller.state.confirmed).toBeNull();
    expect(controller.state.operationMessage).toContain(guidance); expect(calls).toHaveLength(5);
    await controller.confirm(); await controller.select("slot"); expect(calls).toHaveLength(5);
    calls[4].request.resolve(response({ month: "2026-12", slots: [slot()] }));
    await vi.waitFor(() => expect(controller.state.scheduleLoading).toBe(false));
    expect(calls).toHaveLength(5);
    const again = controller.select("slot"); expect(calls[5].path).toBe("/api/auth/student/csrf");
    calls[5].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(7)); calls[6].request.resolve(response(previewBody())); await again;
    expect(controller.state.operation).toBe("review");
    expect(calls.filter(call => call.init?.method === "POST" && call.path === "/api/me/reservations")).toHaveLength(1);
  });
  it("FORBIDDEN halts operations without stopping read-only or inferring Cookie removal", async () => {
    const { controller, calls } = await reviewedHarness(); const command = controller.confirm();
    calls[3].request.resolve(response({ error: { code: "FORBIDDEN", retry: "none", message: "private-canary" } }, 403)); await command;
    expect(controller.state.operationMessage).toBe("この操作は利用できません。"); expect(controller.state.stopped).toBe(false);
    await controller.select("slot"); await controller.confirm(); expect(calls).toHaveLength(4);
    const read = controller.loadMonth("2026-12"); calls[4].request.resolve(response({ month: "2026-12", slots: [slot()] })); await read;
    await controller.select("slot"); expect(calls).toHaveLength(5);
  });
  it.each(["network", "503", "html", "malformed", "200", "unknown-code", "wrong-retry"])
    ("unknown Confirm outcome %s never enables a write retry, including after read-only refresh", async mode => {
      const { controller, calls } = await reviewedHarness(); const command = controller.confirm();
      if (mode === "network") calls[3].request.reject(new Error("private-canary"));
      else if (mode === "html") calls[3].request.resolve(new Response("private-canary", { status: 503 }));
      else if (mode === "503") calls[3].request.resolve(response({ error: { code: "SERVICE_UNAVAILABLE", retry: "later" } }, 503));
      else if (mode === "malformed") calls[3].request.resolve(response({ ...confirmBody(), slot: slot("bookable") }, 201));
      else if (mode === "200") calls[3].request.resolve(response(confirmBody()));
      else calls[3].request.resolve(response({ error: { code: mode === "unknown-code" ? "UNKNOWN" : "RESERVATION_STATE_CHANGED", retry: "none", message: "private-canary" } }, 409));
      await command; expect(controller.state.operation).toBe("halted"); expect(controller.state.operationMessage).toContain("結果は不明");
      expect(controller.state.confirmed).toBeNull(); expect(controller.state.preview).toBeNull();
      expect(JSON.stringify(controller.state)).not.toContain("private-canary");
      const read = controller.loadMonth("2026-12"); calls[4].request.resolve(response({ month: "2026-12", slots: [slot()] })); await read;
      await controller.select("slot"); await controller.confirm(); expect(calls).toHaveLength(5);
      const history = controller.loadHistory(); calls[5].request.resolve(response({ items: [item()], nextCursor: null })); await history;
      expect(controller.state.operation).toBe("halted"); expect(controller.state.confirmed).toBeNull();
    });
  it.each(["csrf", "preview", "confirm", "history"])("401 from %s clears all personal state and invalidates other reads/operations", async stage => {
    const { controller, calls } = await (stage === "confirm" || stage === "history" ? reviewedHarness() : scheduleHarness());
    const start = calls.length;
    const operation = stage === "confirm" || stage === "history" ? controller.confirm() : controller.select("slot");
    let failingIndex = start;
    if (stage === "preview") {
      calls[start].request.resolve(response({ scope: "session", csrfToken: csrf }));
      await vi.waitFor(() => expect(calls).toHaveLength(start + 2)); failingIndex++;
    }
    const historyIndex = calls.length, history = controller.loadHistory();
    if (stage === "history") failingIndex = historyIndex;
    calls[failingIndex].request.resolve(new Response("private-canary", { status: 401 }));
    await (stage === "history" ? history : operation);
    expect(controller.state.stopped).toBe(true); expect(controller.state.slots).toEqual([]); expect(controller.state.preview).toBeNull();
    expect(controller.state.confirmed).toBeNull(); expect(controller.state.history.items).toEqual([]);
    if (stage === "history") calls[start].request.resolve(response(confirmBody(), 201));
    else calls[historyIndex].request.resolve(response({ items: [item()], nextCursor: null }));
    await Promise.all([history, operation]); const count = calls.length;
    await controller.select("slot"); await controller.confirm(); await controller.loadHistory(); await controller.loadMonth("2027-01");
    expect(calls).toHaveLength(count); expect(controller.state.confirmed).toBeNull();
    expect(JSON.stringify(controller.state)).not.toContain(expectedToken); expect(JSON.stringify(controller.state)).not.toContain(csrf);
  });
  it.each(["csrf", "preview"])("slot/month change invalidates old %s responses", async stage => {
    const { controller, calls } = await scheduleHarness();
    const start = calls.length, operation = controller.select("slot");
    if (stage === "preview") {
      calls[start].request.resolve(response({ scope: "session", csrfToken: csrf })); await vi.waitFor(() => expect(calls).toHaveLength(start + 2));
    }
    const superseded = controller.select("other-slot");
    const recheckIndex = calls.length - 1;
    expect(calls[recheckIndex].path).toBe("/api/me/schedule-months/2026-12");
    expect(controller.state.preview).toBeNull();
    await controller.confirm();
    const readIndex = calls.length, month = controller.loadMonth("2027-01");
    calls[readIndex].request.resolve(response({ month: "2027-01", slots: [] })); await month;
    calls[start + (stage === "preview" ? 1 : 0)].request.resolve(response(stage === "csrf" ? { scope: "session", csrfToken: csrf } : previewBody()));
    calls[recheckIndex].request.resolve(response({ month: "2026-12", slots: [otherSlot()] }));
    await Promise.all([operation, superseded]);
    expect(controller.state.month).toBe("2027-01"); expect(controller.state.preview).toBeNull(); expect(controller.state.confirmed).toBeNull();
    expect(controller.state.operation).toBe("idle"); expect(calls).toHaveLength(readIndex + 1);
  });
  it("a failed Command blocks selection changes and stops future writes", async () => {
    const { controller, calls } = await reviewedHarness(); const command = controller.confirm(); controller.select("other-slot");
    calls[3].request.reject(new Error("private-canary")); await command;
    expect(controller.state.selectedId).toBe("slot"); expect(controller.state.operationHalted).toBe(true);
    expect(controller.state.confirmed).toBeNull(); await controller.select("other-slot"); expect(calls).toHaveLength(4);
  });
  it.each(["slot", "other-slot", "same-time"])("reselection of %s rechecks Schedule, replaces the old token and reuses session CSRF", async id => {
    const { controller, calls } = await reviewedHarness(); const again = controller.select(id);
    expect(controller.state.preview).toBeNull(); await controller.confirm(); expect(calls).toHaveLength(4);
    expect(calls[3].path).toBe("/api/me/schedule-months/2026-12");
    const latest = id === "other-slot" ? otherSlot() : slot("bookable", id);
    calls[3].request.resolve(response({ month: "2026-12", slots: [latest] }));
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(calls[4]).toMatchObject({ path: "/api/me/reservations/preview", init: { body: JSON.stringify({ slotId: id }) } });
    calls[4].request.resolve(response({ ...previewBody("standard", [], latest), expectedStateToken: "v1.new-token" })); await again;
    expect(controller.state.preview?.slot.slotId).toBe(id);
    const command = controller.confirm();
    expect(JSON.parse(calls[5].init!.body as string)).toEqual({ slotId: id, expectedStateToken: "v1.new-token" });
    calls[5].request.resolve(response({ ...confirmBody(), slot: { ...latest, view: "reserved_by_me" },
      reservation: { ...confirmBody().reservation, startsAt: latest.startsAt, endsAt: latest.endsAt } }, 201)); await command;
  });
  it.each(["missing", "unavailable", "changed-end", "network", "404", "401"])("fresh Schedule %s requires a new selection or authentication", async mode => {
    const { controller, calls } = await reviewedHarness(); const recheck = controller.select("other-slot");
    await controller.confirm(); expect(calls).toHaveLength(4);
    expect(calls[3].init?.method).toBe("GET"); expect(controller.state.preview).toBeNull();
    if (mode === "network") calls[3].request.reject(new Error("private-canary"));
    else if (mode === "404" || mode === "401") calls[3].request.resolve(response({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE" } }, Number(mode)));
    else {
      const latest = mode === "unavailable" ? { ...otherSlot(), view: "unavailable" } :
        { ...otherSlot(), endsAt: "2026-12-31T21:00:00+09:00" };
      calls[3].request.resolve(response({ month: "2026-12", slots: mode === "missing" ? [slot("bookable", "same-time")] : [latest] }));
    }
    await recheck; await controller.confirm(); expect(calls).toHaveLength(4);
    expect(controller.state.selectedId).toBeNull(); expect(controller.state.operationBusy).toBe(false);
    if (mode === "401") expect(controller.state.stopped).toBe(true);
    else expect(controller.state.operationMessage).toContain("選び直し");
    if (mode === "network" || mode === "404") expect(controller.state.slots).toEqual([]);
  });
  it.each(["preauth", "bad-token", "bad-preview", "bad-id", "bad-dates", "network", "503", "403", "409", "401"])
    ("Preview failure %s cannot enable Confirm or leak details", async mode => {
      const { controller, calls } = await scheduleHarness(); const read = controller.select("slot");
      if (mode === "preauth" || mode === "bad-token") calls[1].request.resolve(response({ scope: mode === "preauth" ? "preauth" : "session", csrfToken: mode === "preauth" ? csrf : "bad" }));
      else {
        calls[1].request.resolve(response({ scope: "session", csrfToken: csrf })); await vi.waitFor(() => expect(calls).toHaveLength(3));
        if (mode === "network") calls[2].request.reject(new Error("private-canary"));
        else if (mode === "bad-preview") calls[2].request.resolve(response({ ...previewBody(), expectedStateToken: null }));
        else if (mode === "bad-id") calls[2].request.resolve(response(previewBody("standard", [], slot("bookable", "same-time"))));
        else if (mode === "bad-dates") calls[2].request.resolve(response(previewBody("standard", [], { ...otherSlot(), slotId: "slot" })));
        else calls[2].request.resolve(response({ error: { code: mode === "403" ? "FORBIDDEN" : mode === "409" ? "RESERVATION_STATE_CHANGED" : mode === "401" ? "UNAUTHENTICATED" : "SERVICE_UNAVAILABLE", retry: mode === "409" ? "repreview" : "none", message: "private-canary" } }, Number(mode)));
      }
      await read; expect(controller.state.preview).toBeNull(); const count = calls.length; await controller.confirm(); expect(calls).toHaveLength(count);
      expect(JSON.stringify(controller.state)).not.toContain("private-canary");
    });
});

describe("TC-F-003-01 / TC-F-003-08 / TC-NF-914-04 [#926 strict projection partial evidence]", () => {
  const selected = { ...slot(), view: "bookable" as const };
  it.each([
    { slot: { ...slot(), slotId: "wrong" } }, { slot: { ...slot(), startsAt: "2026-12-31T16:00:00Z" } },
    { previewClassification: "unknown" }, { expectedStateToken: "" }, { classificationChanges: null },
    { classificationChanges: [{ reservationId: "r", startsAt: slot().startsAt, before: "standard", after: "standard" }] },
    { classificationChanges: [{ reservationId: "r", startsAt: "bad", before: "standard", after: "additional" }] },
  ])("rejects malformed Preview fields %#", override => { expect(() => parsePreview({ ...previewBody(), ...override }, selected)).toThrow(); });
  it.each([
    { reservation: { ...confirmBody().reservation, reservationState: "student_cancelled" } },
    { reservation: { ...confirmBody().reservation, classification: "not_applicable" } },
    { reservation: { ...confirmBody().reservation, endsAt: "2026-12-31T19:00:00+09:00" } },
    { slot: { ...confirmBody().slot, slotId: "wrong" } }, { classificationChanges: [{}] },
  ])("rejects malformed Confirm fields %#", override => { expect(() => parseConfirm({ ...confirmBody(), ...override }, selected)).toThrow(); });
  it("rejects noncanonical CSRF and duplicate changes, drops all unknown fields", () => {
    expect(() => parseCsrf({ scope: "session", csrfToken: "B".repeat(43) })).toThrow();
    const change = { reservationId: "r", startsAt: slot().startsAt, before: "standard", after: "additional", email: "private-canary" };
    expect(() => parsePreview(previewBody("standard", [change, change]), selected)).toThrow();
    expect(JSON.stringify(parsePreview(previewBody("standard", [change]), selected).view)).not.toContain("private-canary");
    expect(JSON.stringify(parseConfirm({ ...confirmBody(), notification: "private-canary" }, selected))).not.toContain("private-canary");
  });
});

describe("TC-NF-907-01 / TC-F-002-01 [#894 calendar/model partial evidence]", () => {
  it("places weekdays, leap days and month/year boundaries by the Gregorian calendar", () => {
    // 2026-11-01 is Sunday; 2026-12-01 is Tuesday; leap February 2028 has 29 days.
    expect(monthDays("2026-11")[0]).toBe(1);
    expect(monthDays("2026-12").slice(0, 3)).toEqual([null, null, 1]);
    expect(monthDays("2028-02").filter(day => day !== null)).toHaveLength(29);
    expect(monthDays("2027-02").filter(day => day !== null)).toHaveLength(28);
    expect(monthDays("0001-01")[0]).toBeNull(); // Monday; avoid Date.UTC's 1900 adjustment.
    expect(moveMonth("2026-12", 1)).toBe("2027-01");
    expect(moveMonth("2027-01", -1)).toBe("2026-12");
    expect(moveMonth("0001-01", -1)).toBe("0001-01");
    expect(moveMonth("9999-12", 1)).toBe("9999-12");
    expect(() => monthDays("2026-13")).toThrow();
  });
  it("projects authoritative +09:00 dates across midnight, month and year without device TZ", () => {
    expect(intervalLabel({ startsAt: "2026-12-31T23:30:00+09:00", endsAt: "2027-01-01T00:30:00+09:00" })).toBe("2026年12月31日 23:30 ～ 2027年01月01日 00:30（日本時間）");
    expect(intervalLabel({ startsAt: "2028-02-29T23:00:00+09:00", endsAt: "2028-03-01T00:00:00+09:00" }))
      .toBe("2028年02月29日 23:00 ～ 2028年03月01日 00:00（日本時間）");
  });
  it.each(["2026-02-29T10:00:00+09:00", "2026-12-31T24:00:00+09:00", "2026-12-31T10:00:00Z", "2026-12-31T10:00:00-08:00", "0000-12-31T10:00:00+09:00"])
    ("rejects non-authoritative/normalized datetime %s", value => { expect(validDateTime(value)).toBe(false); });
  it("projects only public fields and never turns an unknown/duplicate Slot into bookable", () => {
    const value = { month: "2026-12", slots: [{ ...slot(), email: "private-canary", snapshot: "private-canary" }] };
    expect(JSON.stringify(parseSchedule(value, "2026-12"))).not.toContain("private-canary");
    expect(() => parseSchedule({ ...value, month: "2027-01" }, "2026-12")).toThrow();
    expect(() => parseSchedule({ ...value, slots: [slot("unknown")] }, "2026-12")).toThrow();
    expect(() => parseSchedule({ ...value, slots: [slot(), slot()] }, "2026-12")).toThrow();
    expect(() => parseHistory({ items: [item("unknown")], nextCursor: null })).toThrow();
  });
});

describe("TC-F-001-01 / TC-F-002-01 / TC-F-002-02 / TC-F-005-01 / TC-NF-914-03 / TC-NF-914-04 [#894 read controller partial evidence]", () => {
  it("uses a same-origin Schedule GET and starts Preview only for a bookable selection", async () => {
    const { controller, calls } = harness();
    const read = controller.loadMonth("2026-12");
    calls[0].request.resolve(response({ month: "2026-12", slots: fourSlots() }));
    await read;
    expect(calls[0].path).toBe("/api/me/schedule-months/2026-12");
    expect(calls[0].init).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json" } });
    for (const id of ["mine", "group", "busy", "missing"]) controller.select(id);
    expect(controller.state.selectedId).toBeNull();
    expect(calls).toHaveLength(1);
    controller.select("slot"); expect(controller.state.selectedId).toBe("slot");
    expect(controller.state.selectionMessage).toContain("予約は確定していません");
    controller.selectDate("2026-12-26"); expect(controller.state.slots).toHaveLength(4);
    expect(calls.map(call => call.path)).toEqual(["/api/me/schedule-months/2026-12", "/api/auth/student/csrf"]);
  });
  it("clears prior month/selection before GET and ignores older successful and failed responses", async () => {
    const { controller, calls } = harness();
    const initial = controller.loadMonth("2026-12");
    calls[0].request.resolve(response({ month: "2026-12", slots: [slot()] })); await initial;
    const selection = controller.select("slot");
    const old = controller.loadMonth("2027-01"), latest = controller.loadMonth("2027-02");
    expect(controller.state.slots).toEqual([]); expect(controller.state.selectedId).toBeNull();
    calls[3].request.resolve(response({ month: "2027-02", slots: [] })); await latest;
    calls[2].request.resolve(response({ month: "2027-01", slots: [] })); await old;
    calls[1].request.resolve(response({ scope: "session", csrfToken: csrf })); await selection;
    expect(controller.state.month).toBe("2027-02"); expect(controller.state.scheduleMessage).toBe("この月の枠はありません。");
    const failed = controller.loadMonth("2027-03"), current = controller.loadMonth("2027-04");
    calls[5].request.resolve(response({ month: "2027-04", slots: [] })); await current;
    calls[4].request.reject(new Error("private-canary")); await failed;
    expect(controller.state.month).toBe("2027-04"); expect(controller.state.scheduleMessage).toBe("この月の枠はありません。");
  });
  it.each([
    [401, "UNAUTHENTICATED", "認証が必要です。認証後に画面を開き直してください。"],
    [403, "FORBIDDEN", "この操作は利用できません。"],
    [404, "SCHEDULE_MONTH_NOT_AVAILABLE", "指定された月の予定は利用できません。別の月を選択してください。"],
    [503, "SERVICE_UNAVAILABLE", "現在の状態を確認できません。時間をおいて再取得してください。"],
    [503, "INTEGRITY_STATE_UNAVAILABLE", "現在の状態を確認できません。時間をおいて再取得してください。"],
  ])("renders safe guidance for %s %s without response details", async (status, code, expected) => {
    const { controller, calls, events } = harness(); const read = controller.loadMonth("2026-12");
    calls[0].request.resolve(response({ error: { code, message: "private-canary", latestSlot: slot() } }, status)); await read;
    expect(controller.state.scheduleMessage).toBe(expected); expect(controller.state.slots).toEqual([]);
    expect(controller.state.selectedDate).toBeNull(); expect(controller.state.scheduleReady).toBe(false);
    expect(JSON.stringify(controller.state)).not.toContain("private-canary");
    expect(events.at(-1)?.focus || events.at(-2)?.focus).toBe(true);
  });
  it("treats network, non-JSON, unknown code and malformed success as unknown without retries", async () => {
    for (const result of [new Error("private-canary"), new Response("private-canary", { status: 503 }), response({ month: "wrong", slots: [slot()] }), response({ error: { code: "UNKNOWN", message: "private-canary" } }, 404)]) {
      const { controller, calls } = harness(); const read = controller.loadMonth("2026-12");
      if (result instanceof Error) calls[0].request.reject(result); else calls[0].request.resolve(result);
      await read; expect(controller.state.scheduleMessage).toContain("現在の状態を確認できません");
      expect(controller.state.slots).toEqual([]); expect(calls).toHaveLength(1);
      expect(JSON.stringify(controller.state)).not.toContain("private-canary");
    }
  });
  it("uses opaque nextCursor unchanged and refreshes without cursor; histories stay separate", async () => {
    const { controller, calls } = harness();
    const first = controller.loadHistory();
    const cursor = "opaque+/=&?日本語";
    calls[0].request.resolve(response({ items: [item("student_cancelled", "absent", "not_applicable")], nextCursor: cursor })); await first;
    expect(controller.state.history.items[0]).toMatchObject({ reservationState: "student_cancelled", attendanceState: "absent", classification: "not_applicable" });
    const next = controller.loadHistory(true); await controller.loadHistory(true);
    expect(calls).toHaveLength(2); expect(new URL(calls[1].path, "https://example.test").searchParams.get("cursor")).toBe(cursor);
    const refresh = controller.loadHistory();
    expect(calls[2].path).toBe("/api/me/reservations");
    calls[2].request.resolve(response({ items: [], nextCursor: null })); await refresh;
    calls[1].request.resolve(response({ items: [item()], nextCursor: cursor })); await next;
    expect(controller.state.history).toEqual({ items: [], nextCursor: null });
    await controller.loadHistory(true); expect(calls).toHaveLength(3);
  });
  it("401 discards loaded history and invalidates outstanding reads in both directions", async () => {
    for (const failing of ["schedule", "history"] as const) {
      const { controller, calls } = harness();
      const first = controller.loadHistory(); calls[0].request.resolve(response({ items: [item()], nextCursor: "cursor" })); await first;
      const schedule = controller.loadMonth("2026-12"), history = controller.loadHistory();
      const index = failing === "schedule" ? 1 : 2;
      calls[index].request.resolve(response({ error: { code: "UNAUTHENTICATED" } }, 401));
      await (failing === "schedule" ? schedule : history);
      calls[index === 1 ? 2 : 1].request.resolve(response(index === 1 ? { items: [item()], nextCursor: "cursor" } : { month: "2026-12", slots: [slot()] }));
      await Promise.all([schedule, history]);
      expect(controller.state.stopped).toBe(true); expect(controller.state.slots).toEqual([]);
      expect(controller.state.history.items).toEqual([]); expect(controller.state.historyLoading).toBe(false);
      await controller.loadMonth("2027-01"); await controller.loadHistory(); expect(calls).toHaveLength(3);
    }
  });
  it("prioritizes authentication stop even for an older read with a non-JSON 401", async () => {
    const { controller, calls } = harness();
    const old = controller.loadMonth("2026-12"), latest = controller.loadMonth("2027-01");
    calls[1].request.resolve(response({ month: "2027-01", slots: [] })); await latest;
    calls[0].request.resolve(new Response("private-canary", { status: 401 })); await old;
    expect(controller.state.stopped).toBe(true); expect(controller.state.slots).toEqual([]);
    expect(controller.state.scheduleMessage).toContain("認証が必要です");
    expect(JSON.stringify(controller.state)).not.toContain("private-canary");
  });
  it("clears failed history and permits explicit latest retry; invalid month makes no request", async () => {
    const { controller, calls } = harness(); await controller.loadMonth("2026-13"); expect(calls).toHaveLength(0);
    const read = controller.loadHistory(); calls[0].request.reject(new Error("private-canary")); await read;
    expect(controller.state.history).toEqual({ items: [], nextCursor: null });
    expect(controller.state.historyMessage).toContain("現在の状態を確認できません");
    const retry = controller.loadHistory(); calls[1].request.resolve(response({ items: [], nextCursor: null })); await retry;
    expect(calls[1].path).toBe("/api/me/reservations");
  });
});

// Test-only structural DOM adapter: element/event/focus evidence, not a browser/layout engine.
class TestDocument {
  activeElement: TestElement | null = null;
  createElement(tag: string) { return new TestElement(tag, this); }
}
class TestElement {
  children: TestElement[] = []; private text = ""; attributes = new Map<string, string>();
  events = new Map<string, (event: { preventDefault(): void }) => void>();
  id = ""; type = ""; value = ""; className = ""; tabIndex = 0; disabled = false;
  constructor(readonly tag: string, readonly ownerDocument: TestDocument) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(" "); }
  append(...nodes: TestElement[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: TestElement[]) { this.text = ""; this.children = nodes; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(type: string, action: (event: { preventDefault(): void }) => void) { this.events.set(type, action); }
  focusOptions?: FocusOptions;
  focus(options?: FocusOptions) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
  scrolls: ScrollIntoViewOptions[] = [];
  scrollIntoView(options: ScrollIntoViewOptions) { this.scrolls.push(options); }
  activate() { if (!this.disabled) { this.focus(); this.events.get("click")?.({ preventDefault() {} }); } }
  all(): TestElement[] { return [this, ...this.children.flatMap(node => node.all())]; }
}
async function waitForInitialReads(controller: StudentReadController) {
  await vi.waitFor(() => {
    expect(controller.state.scheduleLoading).toBe(false);
    expect(controller.state.historyLoading).toBe(false);
  }, { timeout: 3000 });
}

it("TC-F-001-03 [#1148] mounts the next available day without moving focus or delaying history", async () => {
  const { fetcher, calls } = harness(), doc = new TestDocument(), root = doc.createElement("main");
  const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
  calls[1].request.resolve(response({ items: [item()], nextCursor: null }));
  await vi.waitFor(() => expect(controller.state.historyLoading).toBe(false));
  expect(controller.state.scheduleLoading).toBe(true);
  expect(root.textContent).toContain("予約状態：予約済み");
  calls[0].request.resolve(response({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE" } }, 404));
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  const find = (id: string) => root.all().find(node => node.id === id)!;
  expect(find("schedule-month").value).toBe("2027-01");
  expect(find("schedule-content").attributes.get("aria-busy")).toBe("true");
  expect(find("daily-content").attributes.get("aria-busy")).toBe("true");
  calls[2].request.resolve(response({ month: "2027-01", slots: [{
    ...slot(), startsAt: "2027-01-05T16:00:00+09:00", endsAt: "2027-01-05T17:30:00+09:00",
  }] }));
  await waitForInitialReads(controller);
  expect(find("daily-heading").textContent).toContain("2027年01月05日");
  expect(find("daily-heading").scrolls).toEqual([]);
  expect(doc.activeElement).toBeNull();
  expect(find("daily-content").attributes.get("aria-busy")).toBe("false");
  expect(controller.state.selectedId).toBeNull();
  expect(calls.map(call => [call.init?.method, call.path])).toEqual([
    ["GET", "/api/me/schedule-months/2026-12"], ["GET", "/api/me/reservations"], ["GET", "/api/me/schedule-months/2027-01"],
  ]);
});

describe("TC-F-002-03〜04 / TC-F-006-01 / TC-NF-903-01 [calendar structural DOM]", () => {
  it("keeps one daily list, all same-day Views in stable time order, explicit instant navigation and empty/unbookable guidance", async () => {
    const { fetcher, calls } = harness(), doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    const values = fourSlots().map(value => value.view === "reserved_by_me" ? { ...value, classification: "standard" } : value);
    const tied = { ...values[1], slotId: "tie", classification: "additional" };
    const earlyGroup = { ...values[1], view: "group_lesson", slotId: "early-group", name: "private-group-canary" };
    const otherDay = { ...slot("unavailable", "other-day"), reason: "private-reason-canary" };
    calls[0].request.resolve(response({ month: "2026-12", slots: [otherDay, values[3], values[1], earlyGroup, tied, values[0], values[2]] }));
    calls[1].request.resolve(response({ items: [], nextCursor: null })); await waitForInitialReads(controller);
    const find = (id: string) => root.all().find(node => node.id === id)!;
    expect(root.all().filter(node => node.id === "daily-content")).toHaveLength(1);
    expect(find("daily-heading").scrolls).toEqual([]); expect(doc.activeElement).toBeNull();
    expect(find("daily-heading").textContent).toContain("2026年12月26日");
    expect(find("daily-content").children.map(li => li.children[0].className)).toEqual([
      "slot bookable", "slot reserved_by_me", "slot group_lesson", "slot reserved_by_me", "slot group_lesson", "slot unavailable",
    ]);
    expect(find("daily-content").textContent).not.toContain("31日");
    expect(find("daily-content").children[1].textContent).toContain("／標準");
    expect(find("daily-content").children[3].textContent).toContain("／追加");
    expect(find("daily-content").all().filter(node => node.tag === "button")).toHaveLength(1);
    expect(find("calendar-legend").textContent).toBe("左から開始時刻が早い順。○ 予約可能、× その他の予約不可、済 本人予約済み、グ グループレッスン（予約不可）");
    expect(find("schedule-content").all().filter(node => node.tag === "button")).toHaveLength(31);
    const selected = root.all().find(node => node.className === "calendar-day selected-day")!;
    expect(selected.children[0].textContent).toBe("26日 選択中");
    expect(selected.children[0].attributes.get("aria-pressed")).toBe("true");
    expect(selected.children[0].attributes.get("aria-label")).toBe("2026年12月26日 選択中");
    const [, summary, ...details] = selected.children;
    expect(summary.className).toBe("calendar-symbols");
    expect(summary.children.map(li => li.children[0].textContent).join("")).toBe("○済グ済グ×");
    expect(summary.children.map(li => li.children[1].textContent)).toEqual([
      "予約可能", "本人予約済み", "グループレッスン（予約不可）", "本人予約済み", "グループレッスン（予約不可）", "予約不可",
    ]);
    expect(details.map(node => node.textContent)).toEqual(["13:30～15:00 グループレッスン", "15:30～17:00 グループレッスン"]);
    expect(root.textContent).not.toContain("private-");
    const oldSlot = find("daily-content").all().find(node => node.tag === "button")!;
    root.all().find(node => node.tag === "button" && node.attributes.get("aria-label") === "2026年12月27日")!.activate();
    expect(controller.state.selectedId).toBeNull(); expect(find("daily-content").children).toHaveLength(0);
    expect(find("daily-status").textContent).toBe("この日の公開枠はありません。");
    expect(root.all().find(node => node.className === "calendar-day selected-day")!.children).toHaveLength(1);
    expect(doc.activeElement).toBe(find("daily-heading")); expect(find("daily-heading").tabIndex).toBe(-1);
    expect(find("daily-heading").focusOptions).toEqual({ preventScroll: true });
    expect(find("daily-heading").scrolls).toEqual([{ behavior: "instant", block: "start" }]);
    oldSlot.activate(); expect(controller.state.selectedId).toBeNull(); // Even a detached obsolete control cannot select another day.
    root.all().find(node => node.tag === "button" && node.attributes.get("aria-label") === "2026年12月31日")!.activate();
    expect(find("daily-status").textContent).toBe("この日に予約可能な枠はありません。");
    expect(find("daily-content").children).toHaveLength(1);
    expect(find("daily-content").all().filter(node => node.tag === "button")).toHaveLength(0);
    expect(root.all().find(node => node.className === "calendar-day selected-day")!.children[1].children[0].children[0].textContent).toBe("×");
    root.all().find(node => node.textContent === "別の日を選ぶ（カレンダーへ）")!.activate();
    expect(doc.activeElement).toBe(find("schedule-heading")); expect(controller.state.selectedDate).toBe("2026-12-31");
    expect(find("schedule-heading").scrolls).toEqual([{ behavior: "instant", block: "start" }]);
    expect(calls).toHaveLength(2);
    const month = controller.loadMonth("2027-01", false);
    calls[2].request.resolve(response({ month: "2027-01", slots: [{
      ...slot("reserved_by_me"), startsAt: "2027-01-05T16:00:00+09:00", endsAt: "2027-01-05T17:30:00+09:00",
    }] })); await month;
    expect(find("daily-heading").scrolls).toHaveLength(2); // Only the two explicit dates scrolled.
    expect(controller.state.selectedDate).toBeNull(); expect(find("daily-status").textContent).toContain("日付を選択");
    const summaries = find("schedule-content").all().filter(node => node.className === "calendar-symbols");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].children[0].children[0].textContent).toBe("済");
  });
  it("returning and re-entering the selected day preserve valid review; Confirm disables every month/day/Slot control", async () => {
    const { fetcher, calls } = harness(), doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    calls[0].request.resolve(response({ month: "2026-12", slots: [slot()] })); calls[1].request.resolve(response({ items: [], nextCursor: null }));
    await waitForInitialReads(controller); const preview = controller.select("slot");
    calls[2].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(4)); calls[3].request.resolve(response(previewBody())); await preview;
    const view = controller.state.preview;
    root.all().find(node => node.textContent === "別の日を選ぶ（カレンダーへ）")!.activate();
    expect(controller.state.preview).toBe(view); expect(controller.state.selectedId).toBe("slot");
    root.all().find(node => node.tag === "button" && node.attributes.get("aria-pressed") === "true" && !node.className)!.activate();
    expect(controller.state.preview).toBe(view); expect(calls).toHaveLength(4);
    const command = controller.confirm();
    for (const node of root.all().filter(node => node.tag === "input" || node.type === "submit" || node.attributes.has("aria-pressed") || ["前の月", "次の月"].includes(node.textContent))) expect(node.disabled).toBe(true);
    calls[4].request.resolve(response(confirmBody(), 201)); await command;
    expect(controller.state.selectedDate).toBe("2026-12-31");
    calls[5].request.resolve(response({ month: "2026-12", slots: [slot("reserved_by_me")] })); await waitForInitialReads(controller);
    expect(root.all().find(node => node.id === "daily-heading")!.textContent).toContain("31日");
    expect(calls.filter(call => call.path === "/api/me/reservations" && call.init?.method === "POST")).toHaveLength(1);
  });
});

describe("TC-F-001-01 / TC-F-001-02 / TC-F-005-01 / TC-NF-903-01 [#894 structural DOM partial evidence]", () => {
  it("renders labels, four Views, day-only Slot selection, round-trip focus and separate history states", async () => {
    const { fetcher, calls } = harness(); const doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    const slots = fourSlots().map(value => value.view === "reserved_by_me" ? { ...value, classification: "additional" } : value);
    calls[0].request.resolve(response({ month: "2026-12", slots: slots.map(value => ({ ...value, name: "private-canary" })) }));
    calls[1].request.resolve(response({ items: [item("school_cancelled", "absent", "not_applicable")], nextCursor: "cursor" }));
    await waitForInitialReads(controller);
    expect(root.textContent).not.toContain("private-canary");
    for (const label of ["予約可能", "本人予約済み", "グループレッスン（予約不可）", "予約不可", "予約状態：スクール都合キャンセル", "欠席状態：欠席", "現在の区分：対象外"]) expect(root.textContent).toContain(label);
    const slotButtons = root.all().filter(node => node.tag === "button" && node.className.includes("slot"));
    expect(slotButtons).toHaveLength(1); slotButtons[0].activate();
    expect(controller.state.selectedId).toBe("slot"); expect(doc.activeElement).toBe(slotButtons[0]);
    expect(slotButtons[0].attributes.get("aria-pressed")).toBe("true");
    const back = root.all().find(node => node.textContent === "別の日を選ぶ（カレンダーへ）")!; back.activate();
    expect(doc.activeElement?.id).toBe("schedule-heading"); expect(controller.state.selectedId).toBe("slot");
    expect(root.all().filter(node => node.tag === "button" && node.className.includes("slot"))).toHaveLength(1);
    expect(root.all().find(node => node.tag === "label")?.textContent).toContain("YYYY-MM");
    const more = root.all().find(node => node.textContent === "履歴の次ページ")!; more.activate();
    expect(more.disabled).toBe(true);
    calls[3].request.resolve(response({ items: [item("system_cancelled", "none", "standard")], nextCursor: null }));
    await vi.waitFor(() => {
      expect(controller.state.historyLoading).toBe(false);
      expect(root.textContent).toContain("予約状態：システムキャンセル");
    }, { timeout: 3000 });
    expect(doc.activeElement?.id).toBe("history-status"); expect(root.textContent).toContain("予約状態：システムキャンセル");
    expect(root.textContent).toContain("欠席状態：なし"); expect(root.textContent).toContain("現在の区分：標準");
    expect(more.disabled).toBe(true); expect(calls).toHaveLength(4);
  });
  it("retains multiple Slots and a complete busy month inside a labeled scroll region and focuses error guidance", async () => {
    const { fetcher, calls } = harness(); const doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    calls[0].request.resolve(response({ month: "2026-12", slots: busyMonth() }));
    calls[1].request.resolve(response({ items: [], nextCursor: null }));
    await waitForInitialReads(controller);
    const calendarContent = root.all().find(node => node.id === "schedule-content")!;
    const symbols = calendarContent.all().filter(node => node.attributes.get("aria-hidden") === "true" && node.tag === "span");
    expect(symbols).toHaveLength(97);
    expect(symbols.every(node => node.textContent === "○")).toBe(true);
    expect(calendarContent.all().filter(node => node.tag === "button" && node.className.includes("slot"))).toHaveLength(0);
    expect(root.all().filter(node => node.tag === "button" && node.className === "slot bookable")).toHaveLength(3);
    const scroll = root.all().find(node => node.className === "calendar-scroll")!;
    expect(scroll.tabIndex).toBe(0); expect(scroll.attributes.get("aria-label")).toContain("2026-12");
    expect(scroll.attributes.get("aria-describedby")).toBe("calendar-legend");
    const read = controller.loadMonth("2027-01"); expect(root.all().filter(node => node.className === "slot bookable")).toHaveLength(0);
    calls[2].request.resolve(response({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE", message: "private-canary" } }, 404)); await read;
    expect(doc.activeElement?.id).toBe("schedule-status"); expect(root.textContent).toContain("別の月を選択");
    expect(calendarContent.all().some(node => node.className === "calendar-symbols")).toBe(false);
    expect(root.textContent).not.toContain("private-canary");
  });
});

describe("TC-F-003-01〜02 / TC-F-003-08 / TC-NF-902-02 / TC-NF-914-03〜04 [#926 structural DOM partial evidence]", () => {
  it("renders every dated classification change, keeps secrets out of DOM and focuses explicit review/result", async () => {
    const { fetcher, calls } = harness(), doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    calls[0].request.resolve(response({ month: "2026-12", slots: [slot()] }));
    calls[1].request.resolve(response({ items: [], nextCursor: null })); await waitForInitialReads(controller);
    const confirm = root.all().find(node => node.textContent === "予約する")!;
    expect(root.all().some(node => node.tag === "button" && node.textContent.includes("Preview"))).toBe(false);
    expect(confirm.disabled).toBe(true); expect(calls).toHaveLength(2);
    root.all().find(node => node.tag === "button" && node.className === "slot bookable")!.activate();
    expect(calls).toHaveLength(3); expect(confirm.disabled).toBe(true);
    expect(root.textContent).toContain("予約内容を確認しています");
    calls[2].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(confirm.disabled).toBe(true);
    // Pure wire-presentation fixture: both allowed directions, not evidence of Domain calculation.
    const changes = [
      { reservationId: "r1", startsAt: "2026-12-31T19:00:00+09:00", before: "standard", after: "additional" },
      { reservationId: "r2", startsAt: "2026-12-31T21:00:00+09:00", before: "additional", after: "standard" },
    ];
    calls[3].request.resolve(response({ ...previewBody("additional", changes), price: "price-canary", email: "private-canary" }));
    await vi.waitFor(() => expect(controller.state.operation).toBe("review"));
    expect(confirm.disabled).toBe(false); expect(doc.activeElement?.id).toBe("operation-status");
    expect(root.textContent).toContain("2026年12月31日 16:00 ～ 2026年12月31日 17:30（日本時間）");
    expect(root.textContent).toContain("区分：追加"); expect(root.textContent).toContain("Lesson開始前までは後から再分類される場合があります");
    for (const label of ["2026年12月31日 19:00（日本時間）：標準 → 追加", "2026年12月31日 21:00（日本時間）：追加 → 標準"]) expect(root.textContent).toContain(label);
    const serializedDom = JSON.stringify(root.all().map(node => ({ text: node.textContent, attributes: [...node.attributes], id: node.id, value: node.value })));
    expect(serializedDom).not.toContain(expectedToken); expect(serializedDom).not.toContain(csrf);
    expect(serializedDom).not.toContain("price-canary"); expect(serializedDom).not.toContain("private-canary");
    expect(root.all().find(node => node.id === "operation-status")?.attributes.get("aria-live")).toBe("polite");
    confirm.activate(); confirm.activate(); expect(confirm.disabled).toBe(true); expect(calls).toHaveLength(5);
    calls[4].request.resolve(response(confirmBody("additional", changes), 201));
    await vi.waitFor(() => expect(controller.state.operation).toBe("confirmed"));
    expect(root.textContent).toContain("予約済みです"); expect(doc.activeElement?.id).toBe("operation-status");
    expect(root.textContent).toContain("メールの配送完了を表すものではありません");
    expect(confirm.disabled).toBe(true); expect(calls[5].init?.method).toBe("GET");
    calls[5].request.resolve(response({ month: "2026-12", slots: [slot("reserved_by_me")] })); await waitForInitialReads(controller);
  });
  it("focuses unknown outcome, removes review and disables both actions across month refresh", async () => {
    const { fetcher, calls } = harness(), doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    calls[0].request.resolve(response({ month: "2026-12", slots: [slot()] })); calls[1].request.resolve(response({ items: [], nextCursor: null })); await waitForInitialReads(controller);
    const read = controller.select("slot"); calls[2].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(4)); calls[3].request.resolve(response(previewBody())); await read;
    const command = controller.confirm(); calls[4].request.resolve(response({ error: { code: "SERVICE_UNAVAILABLE", message: "private-canary" } }, 503)); await command;
    expect(doc.activeElement?.id).toBe("operation-status"); expect(root.textContent).toContain("結果は不明");
    expect(root.all().find(node => node.id === "operation-content")?.textContent).toBe(""); expect(root.textContent).not.toContain("private-canary");
    expect(root.all().find(node => node.textContent === "予約する")?.disabled).toBe(true);
    expect(root.all().find(node => node.className === "slot bookable")?.disabled).toBe(true);
    const month = controller.loadMonth("2026-12"); calls[5].request.resolve(response({ month: "2026-12", slots: [slot()] })); await month; controller.select("slot");
    expect(root.textContent).toContain("結果は不明"); expect(calls).toHaveLength(6);
  });
});
