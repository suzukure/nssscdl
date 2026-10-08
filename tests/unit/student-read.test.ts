import { describe, expect, it } from "vitest";
import { StudentReadController } from "../../src/web/controller";
import { monthDays, moveMonth, validDateTime, parseSchedule, parseHistory, intervalLabel } from "../../src/web/model";
import { mountStudent } from "../../src/web/view";

const slot = (view = "bookable", slotId = "slot") => ({ slotId, view,
  startsAt: "2026-12-31T16:00:00+09:00", endsAt: "2026-12-31T17:30:00+09:00" });
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
  it("uses only same-origin GETs, accepts four Views and selects only bookable", async () => {
    const { controller, calls } = harness();
    const read = controller.loadMonth("2026-12");
    calls[0].request.resolve(response({ month: "2026-12", slots: fourSlots() }));
    await read;
    expect(calls[0].path).toBe("/api/me/schedule-months/2026-12");
    expect(calls[0].init).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json" } });
    for (const id of ["mine", "group", "busy", "missing"]) controller.select(id);
    expect(controller.state.selectedId).toBeNull();
    controller.select("slot"); expect(controller.state.selectedId).toBe("slot");
    expect(controller.state.selectionMessage).toContain("予約は確定していません");
    controller.setView("list"); expect(controller.state.slots).toHaveLength(4);
    expect(calls).toHaveLength(1); // No Preview, Confirm or CSRF request on selection/view change.
  });
  it("clears prior month/selection before GET and ignores older successful and failed responses", async () => {
    const { controller, calls } = harness();
    const initial = controller.loadMonth("2026-12");
    calls[0].request.resolve(response({ month: "2026-12", slots: [slot()] })); await initial;
    controller.select("slot");
    const old = controller.loadMonth("2027-01"), latest = controller.loadMonth("2027-02");
    expect(controller.state.slots).toEqual([]); expect(controller.state.selectedId).toBeNull();
    calls[2].request.resolve(response({ month: "2027-02", slots: [] })); await latest;
    calls[1].request.resolve(response({ month: "2027-01", slots: [] })); await old;
    expect(controller.state.month).toBe("2027-02"); expect(controller.state.scheduleMessage).toBe("この月の枠はありません。");
    const failed = controller.loadMonth("2027-03"), current = controller.loadMonth("2027-04");
    calls[4].request.resolve(response({ month: "2027-04", slots: [] })); await current;
    calls[3].request.reject(new Error("private-canary")); await failed;
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
  focus() { this.ownerDocument.activeElement = this; }
  activate() { if (!this.disabled) { this.focus(); this.events.get("click")?.({ preventDefault() {} }); } }
  all(): TestElement[] { return [this, ...this.children.flatMap(node => node.all())]; }
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe("TC-F-001-01 / TC-F-001-02 / TC-F-005-01 / TC-NF-903-01 [#894 structural DOM partial evidence]", () => {
  it("renders labels, four Views, button-only selection, stable toggle focus and separate history states", async () => {
    const { fetcher, calls } = harness(); const doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    const slots = fourSlots().map(value => value.view === "reserved_by_me" ? { ...value, classification: "additional" } : value);
    calls[0].request.resolve(response({ month: "2026-12", slots: slots.map(value => ({ ...value, name: "private-canary" })) }));
    calls[1].request.resolve(response({ items: [item("school_cancelled", "absent", "not_applicable")], nextCursor: "cursor" })); await settle();
    expect(root.textContent).not.toContain("private-canary");
    for (const label of ["予約可能", "本人予約済み", "グループレッスン（予約不可）", "予約不可", "予約状態：スクール都合キャンセル", "欠席状態：欠席", "現在の区分：対象外"]) expect(root.textContent).toContain(label);
    const slotButtons = root.all().filter(node => node.tag === "button" && node.className.includes("slot"));
    expect(slotButtons).toHaveLength(1); slotButtons[0].activate();
    expect(controller.state.selectedId).toBe("slot"); expect(doc.activeElement).toBe(slotButtons[0]);
    expect(slotButtons[0].attributes.get("aria-pressed")).toBe("true");
    const toggle = root.all().find(node => node.textContent === "一覧表示")!; toggle.activate();
    expect(doc.activeElement).toBe(toggle); expect(toggle.attributes.get("aria-pressed")).toBe("true");
    expect(root.all().filter(node => node.tag === "button" && node.className.includes("slot"))).toHaveLength(1);
    expect(root.all().find(node => node.tag === "label")?.textContent).toContain("YYYY-MM");
    const more = root.all().find(node => node.textContent === "履歴の次ページ")!; more.activate();
    expect(more.disabled).toBe(true);
    calls[2].request.resolve(response({ items: [item("system_cancelled", "none", "standard")], nextCursor: null })); await settle();
    expect(doc.activeElement?.id).toBe("history-status"); expect(root.textContent).toContain("予約状態：システムキャンセル");
    expect(root.textContent).toContain("欠席状態：なし"); expect(root.textContent).toContain("現在の区分：標準");
    expect(more.disabled).toBe(true); expect(calls).toHaveLength(3);
  });
  it("retains multiple Slots and a complete busy month inside a labeled scroll region and focuses error guidance", async () => {
    const { fetcher, calls } = harness(); const doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    calls[0].request.resolve(response({ month: "2026-12", slots: busyMonth() }));
    calls[1].request.resolve(response({ items: [], nextCursor: null })); await settle();
    expect(root.all().filter(node => node.className === "slot bookable")).toHaveLength(97);
    const scroll = root.all().find(node => node.className === "calendar-scroll")!;
    expect(scroll.tabIndex).toBe(0); expect(scroll.attributes.get("aria-label")).toContain("2026-12");
    const read = controller.loadMonth("2027-01"); expect(root.all().filter(node => node.className === "slot bookable")).toHaveLength(0);
    calls[2].request.resolve(response({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE", message: "private-canary" } }, 404)); await read;
    expect(doc.activeElement?.id).toBe("schedule-status"); expect(root.textContent).toContain("別の月を選択");
    expect(root.textContent).not.toContain("private-canary");
  });
});
