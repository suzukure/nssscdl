import { describe, expect, it, vi } from "vitest";
import { StudentReadController } from "../../src/web/controller";
import { monthDays, moveMonth, validDateTime, parseSchedule, parseHistory, intervalLabel, parsePreview, parseConfirm, parseCsrf } from "../../src/web/model";
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
const csrf = "A".repeat(43), expectedToken = "v1.synthetic-token-canary";
function previewBody(classification = "standard", classificationChanges: unknown[] = []) {
  const { slotId, startsAt, endsAt } = slot();
  return { slot: { slotId, startsAt, endsAt }, previewClassification: classification, classificationChanges, expectedStateToken: expectedToken };
}
function confirmBody(classification = "standard", classificationChanges: unknown[] = []) {
  const { slotId, startsAt, endsAt } = slot();
  return { slot: { slotId, startsAt, endsAt, view: "reserved_by_me" },
    reservation: { reservationId: "new-reservation", startsAt, endsAt, reservationState: "confirmed", classification }, classificationChanges };
}
async function selectedHarness() {
  const h = harness(), read = h.controller.loadMonth("2026-12");
  h.calls[0].request.resolve(response({ month: "2026-12", slots: [slot(), { ...slot("bookable", "other-slot"),
    startsAt: "2026-12-31T19:00:00+09:00", endsAt: "2026-12-31T20:30:00+09:00" }] }));
  await read; h.controller.select("slot"); return h;
}
async function reviewedHarness() {
  const h = await selectedHarness(), read = h.controller.preview();
  h.calls[1].request.resolve(response({ scope: "session", csrfToken: csrf }));
  await vi.waitFor(() => expect(h.calls).toHaveLength(3));
  h.calls[2].request.resolve(response(previewBody())); await read; return h;
}

describe("TC-F-003-01 / TC-F-003-02 / TC-F-003-05 / TC-F-003-08〜09 / TC-F-005-01 / TC-NF-914-03〜04 [#926 synthetic wire partial evidence]", () => {
  it("requires explicit Preview then Confirm, exact wire and one Command; success refresh is GET only", async () => {
    const h = await selectedHarness(), { controller, calls } = h;
    await controller.confirm(); expect(calls).toHaveLength(1);
    const read = controller.preview(); await controller.preview(); await controller.confirm();
    expect(calls).toHaveLength(2); expect(calls[1].path).toBe("/api/auth/student/csrf");
    expect(calls[1].init).toEqual(calls[0].init);
    calls[1].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2].request.resolve(response({ ...previewBody("additional"), email: "private-canary", snapshot: "private-canary", monthlyN: 3 })); await read;
    expect(controller.state.preview?.previewClassification).toBe("additional");
    expect(JSON.stringify(controller.state)).not.toContain(expectedToken);
    expect(JSON.stringify(controller.state)).not.toContain(csrf);
    expect(JSON.stringify(controller.state)).not.toContain("private-canary");
    const confirm = controller.confirm(); await controller.confirm(); await controller.preview();
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
    [409, "RESERVATION_STATE_CHANGED", "repreview", "再Preview"],
    [409, "RESERVATION_NOT_AVAILABLE", "reload", "予約可能枠"],
    [409, "RESERVATION_WINDOW_CLOSED", "reload", "予約可能枠"],
    [403, "CSRF_INVALID", "reload", "CSRFを再取得"],
  ])("discards review on %s %s and requires fresh Schedule and explicit Preview", async (status, code, retry, guidance) => {
    const { controller, calls } = await reviewedHarness(); const command = controller.confirm();
    calls[3].request.resolve(response({ error: { code, retry, message: "private-canary" } }, status)); await command;
    expect(controller.state.preview).toBeNull(); expect(controller.state.confirmed).toBeNull();
    expect(controller.state.operationMessage).toContain(guidance); expect(calls).toHaveLength(5);
    await controller.confirm(); await controller.preview(); expect(calls).toHaveLength(5);
    calls[4].request.resolve(response({ month: "2026-12", slots: [slot()] }));
    await vi.waitFor(() => expect(controller.state.scheduleLoading).toBe(false)); controller.select("slot");
    const again = controller.preview(); expect(calls[5].path).toBe("/api/auth/student/csrf");
    calls[5].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(7)); calls[6].request.resolve(response(previewBody())); await again;
    expect(controller.state.operation).toBe("review");
    expect(calls.filter(call => call.init?.method === "POST" && call.path === "/api/me/reservations")).toHaveLength(1);
  });
  it("FORBIDDEN halts operations without stopping read-only or inferring Cookie removal", async () => {
    const { controller, calls } = await reviewedHarness(); const command = controller.confirm();
    calls[3].request.resolve(response({ error: { code: "FORBIDDEN", retry: "none", message: "private-canary" } }, 403)); await command;
    expect(controller.state.operationMessage).toBe("この操作は利用できません。"); expect(controller.state.stopped).toBe(false);
    await controller.preview(); await controller.confirm(); expect(calls).toHaveLength(4);
    const read = controller.loadMonth("2026-12"); calls[4].request.resolve(response({ month: "2026-12", slots: [slot()] })); await read;
    controller.select("slot"); await controller.preview(); expect(calls).toHaveLength(5);
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
      controller.select("slot"); await controller.preview(); await controller.confirm(); expect(calls).toHaveLength(5);
      const history = controller.loadHistory(); calls[5].request.resolve(response({ items: [item()], nextCursor: null })); await history;
      expect(controller.state.operation).toBe("halted"); expect(controller.state.confirmed).toBeNull();
    });
  it.each(["csrf", "preview", "confirm", "history"])("401 from %s clears all personal state and invalidates other reads/operations", async stage => {
    const { controller, calls } = await (stage === "confirm" || stage === "history" ? reviewedHarness() : selectedHarness());
    const start = calls.length;
    const operation = stage === "confirm" || stage === "history" ? controller.confirm() : controller.preview();
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
    await controller.preview(); await controller.confirm(); await controller.loadHistory(); await controller.loadMonth("2027-01");
    expect(calls).toHaveLength(count); expect(controller.state.confirmed).toBeNull();
    expect(JSON.stringify(controller.state)).not.toContain(expectedToken); expect(JSON.stringify(controller.state)).not.toContain(csrf);
  });
  it.each(["csrf", "preview", "confirm"])("slot/month change invalidates old %s responses and never overlaps Command", async stage => {
    const { controller, calls } = await (stage === "confirm" ? reviewedHarness() : selectedHarness());
    const start = calls.length, operation = stage === "confirm" ? controller.confirm() : controller.preview();
    if (stage === "preview") {
      calls[start].request.resolve(response({ scope: "session", csrfToken: csrf })); await vi.waitFor(() => expect(calls).toHaveLength(start + 2));
    }
    controller.select("other-slot"); expect(controller.state.preview).toBeNull();
    await controller.preview(); await controller.confirm();
    const readIndex = calls.length, month = controller.loadMonth("2027-01");
    calls[readIndex].request.resolve(response({ month: "2027-01", slots: [] })); await month;
    calls[start + (stage === "preview" ? 1 : 0)].request.resolve(response(stage === "csrf" ? { scope: "session", csrfToken: csrf } : stage === "preview" ? previewBody() : confirmBody(), stage === "confirm" ? 201 : 200));
    await operation; expect(controller.state.month).toBe("2027-01"); expect(controller.state.preview).toBeNull(); expect(controller.state.confirmed).toBeNull();
    expect(controller.state.operation).toBe("idle"); expect(calls).toHaveLength(readIndex + 1);
  });
  it("an obsolete failed Command still stops future writes without adopting its Slot", async () => {
    const { controller, calls } = await reviewedHarness(); const command = controller.confirm(); controller.select("other-slot");
    calls[3].request.reject(new Error("private-canary")); await command;
    expect(controller.state.selectedId).toBe("other-slot"); expect(controller.state.operationHalted).toBe(true);
    expect(controller.state.confirmed).toBeNull(); await controller.preview(); expect(calls).toHaveLength(4);
  });
  it("rePreview requires fresh Schedule and reselection, discards the old token and caches CSRF only in memory", async () => {
    const { controller, calls } = await reviewedHarness(); const again = controller.preview();
    expect(controller.state.preview).toBeNull(); await controller.confirm(); expect(calls).toHaveLength(4);
    expect(calls[3].path).toBe("/api/me/schedule-months/2026-12");
    calls[3].request.resolve(response({ month: "2026-12", slots: [slot()] })); await again;
    await vi.waitFor(() => expect(controller.state.scheduleLoading).toBe(false)); controller.select("slot");
    const fresh = controller.preview(); expect(calls[4].path).toBe("/api/me/reservations/preview");
    calls[4].request.resolve(response({ ...previewBody(), expectedStateToken: "v1.new-token" })); await fresh;
    const command = controller.confirm(); expect(JSON.parse(calls[5].init!.body as string).expectedStateToken).toBe("v1.new-token");
    calls[5].request.resolve(response(confirmBody(), 201)); await command;
  });
  it("changing a reviewed Slot requires fresh Schedule before a new explicit Preview", async () => {
    const { controller, calls } = await reviewedHarness(); controller.select("other-slot");
    await controller.confirm(); await controller.preview(); expect(calls).toHaveLength(4);
    expect(calls[3].init?.method).toBe("GET"); expect(controller.state.selectedId).toBeNull(); expect(controller.state.preview).toBeNull();
    calls[3].request.resolve(response({ month: "2026-12", slots: [] }));
    await vi.waitFor(() => expect(controller.state.scheduleLoading).toBe(false)); await controller.preview(); expect(calls).toHaveLength(4);
  });
  it.each(["preauth", "bad-token", "bad-preview", "network", "503", "403", "409", "401"])
    ("Preview failure %s cannot enable Confirm or leak details", async mode => {
      const { controller, calls } = await selectedHarness(); const read = controller.preview();
      if (mode === "preauth" || mode === "bad-token") calls[1].request.resolve(response({ scope: mode === "preauth" ? "preauth" : "session", csrfToken: mode === "preauth" ? csrf : "bad" }));
      else {
        calls[1].request.resolve(response({ scope: "session", csrfToken: csrf })); await vi.waitFor(() => expect(calls).toHaveLength(3));
        if (mode === "network") calls[2].request.reject(new Error("private-canary"));
        else if (mode === "bad-preview") calls[2].request.resolve(response({ ...previewBody(), expectedStateToken: null }));
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
async function waitForInitialReads(controller: StudentReadController) {
  await vi.waitFor(() => {
    expect(controller.state.scheduleLoading).toBe(false);
    expect(controller.state.historyLoading).toBe(false);
  }, { timeout: 3000 });
}

describe("TC-F-001-01 / TC-F-001-02 / TC-F-005-01 / TC-NF-903-01 [#894 structural DOM partial evidence]", () => {
  it("renders labels, four Views, button-only selection, stable toggle focus and separate history states", async () => {
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
    const toggle = root.all().find(node => node.textContent === "一覧表示")!; toggle.activate();
    expect(doc.activeElement).toBe(toggle); expect(toggle.attributes.get("aria-pressed")).toBe("true");
    expect(root.all().filter(node => node.tag === "button" && node.className.includes("slot"))).toHaveLength(1);
    expect(root.all().find(node => node.tag === "label")?.textContent).toContain("YYYY-MM");
    const more = root.all().find(node => node.textContent === "履歴の次ページ")!; more.activate();
    expect(more.disabled).toBe(true);
    calls[2].request.resolve(response({ items: [item("system_cancelled", "none", "standard")], nextCursor: null }));
    await vi.waitFor(() => {
      expect(controller.state.historyLoading).toBe(false);
      expect(root.textContent).toContain("予約状態：システムキャンセル");
    }, { timeout: 3000 });
    expect(doc.activeElement?.id).toBe("history-status"); expect(root.textContent).toContain("予約状態：システムキャンセル");
    expect(root.textContent).toContain("欠席状態：なし"); expect(root.textContent).toContain("現在の区分：標準");
    expect(more.disabled).toBe(true); expect(calls).toHaveLength(3);
  });
  it("retains multiple Slots and a complete busy month inside a labeled scroll region and focuses error guidance", async () => {
    const { fetcher, calls } = harness(); const doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    calls[0].request.resolve(response({ month: "2026-12", slots: busyMonth() }));
    calls[1].request.resolve(response({ items: [], nextCursor: null }));
    await waitForInitialReads(controller);
    expect(root.all().filter(node => node.className === "slot bookable")).toHaveLength(97);
    const scroll = root.all().find(node => node.className === "calendar-scroll")!;
    expect(scroll.tabIndex).toBe(0); expect(scroll.attributes.get("aria-label")).toContain("2026-12");
    const read = controller.loadMonth("2027-01"); expect(root.all().filter(node => node.className === "slot bookable")).toHaveLength(0);
    calls[2].request.resolve(response({ error: { code: "SCHEDULE_MONTH_NOT_AVAILABLE", message: "private-canary" } }, 404)); await read;
    expect(doc.activeElement?.id).toBe("schedule-status"); expect(root.textContent).toContain("別の月を選択");
    expect(root.textContent).not.toContain("private-canary");
  });
});

describe("TC-F-003-01〜02 / TC-F-003-08 / TC-NF-902-02 / TC-NF-914-03〜04 [#926 structural DOM partial evidence]", () => {
  it("renders every dated classification change, keeps secrets out of DOM and focuses explicit review/result", async () => {
    const { fetcher, calls } = harness(), doc = new TestDocument(), root = doc.createElement("main");
    const controller = mountStudent(root as unknown as HTMLElement, "2026-12", fetcher);
    calls[0].request.resolve(response({ month: "2026-12", slots: [slot()] }));
    calls[1].request.resolve(response({ items: [], nextCursor: null })); await waitForInitialReads(controller);
    const preview = root.all().find(node => node.textContent === "選択枠の予約内容をPreview")!;
    const confirm = root.all().find(node => node.textContent === "内容を確認して予約を確定")!;
    expect(preview.disabled).toBe(true); expect(confirm.disabled).toBe(true);
    root.all().find(node => node.className === "slot bookable")!.activate();
    expect(calls).toHaveLength(2); expect(preview.disabled).toBe(false); expect(confirm.disabled).toBe(true);
    preview.activate(); expect(preview.disabled).toBe(true);
    calls[2].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    // Pure wire-presentation fixture: both allowed directions, not evidence of Domain calculation.
    const changes = [
      { reservationId: "r1", startsAt: "2026-12-31T19:00:00+09:00", before: "standard", after: "additional" },
      { reservationId: "r2", startsAt: "2026-12-31T21:00:00+09:00", before: "additional", after: "standard" },
    ];
    calls[3].request.resolve(response(previewBody("additional", changes)));
    await vi.waitFor(() => expect(controller.state.operation).toBe("review"));
    expect(confirm.disabled).toBe(false); expect(doc.activeElement?.id).toBe("operation-status");
    expect(root.textContent).toContain("2026年12月31日 16:00 ～ 2026年12月31日 17:30（日本時間）");
    expect(root.textContent).toContain("区分：追加"); expect(root.textContent).toContain("Lesson開始前までは後から再分類される場合があります");
    for (const label of ["2026年12月31日 19:00（日本時間）：標準 → 追加", "2026年12月31日 21:00（日本時間）：追加 → 標準"]) expect(root.textContent).toContain(label);
    const serializedDom = JSON.stringify(root.all().map(node => ({ text: node.textContent, attributes: [...node.attributes], id: node.id, value: node.value })));
    expect(serializedDom).not.toContain(expectedToken); expect(serializedDom).not.toContain(csrf);
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
    controller.select("slot"); const read = controller.preview(); calls[2].request.resolve(response({ scope: "session", csrfToken: csrf }));
    await vi.waitFor(() => expect(calls).toHaveLength(4)); calls[3].request.resolve(response(previewBody())); await read;
    const command = controller.confirm(); calls[4].request.resolve(response({ error: { code: "SERVICE_UNAVAILABLE", message: "private-canary" } }, 503)); await command;
    expect(doc.activeElement?.id).toBe("operation-status"); expect(root.textContent).toContain("結果は不明");
    expect(root.all().find(node => node.id === "operation-content")?.textContent).toBe(""); expect(root.textContent).not.toContain("private-canary");
    for (const label of ["選択枠の予約内容をPreview", "内容を確認して予約を確定"]) expect(root.all().find(node => node.textContent === label)?.disabled).toBe(true);
    const month = controller.loadMonth("2026-12"); calls[5].request.resolve(response({ month: "2026-12", slots: [slot()] })); await month; controller.select("slot");
    expect(root.textContent).toContain("結果は不明"); expect(calls).toHaveLength(6);
  });
});
