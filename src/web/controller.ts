import { parseHistory, parseSchedule, validMonth, intervalLabel, type Slot, type HistoryPage } from "./model.js";
export type Area = "schedule" | "history" | "selection" | "view";
export interface ReadState {
  month: string; view: "calendar" | "list"; slots: Slot[]; history: HistoryPage;
  scheduleMessage: string; historyMessage: string; selectionMessage: string;
  scheduleLoading: boolean; historyLoading: boolean; selectedId: string | null; stopped: boolean;
}
const unknownMessage = "現在の状態を確認できません。時間をおいて再取得してください。";
class ReadError extends Error {
  constructor(readonly status: number, readonly code: string = "") { super("Read unavailable"); }
}
function message(error: unknown): string {
  if (error instanceof ReadError) {
    if (error.status === 401) return "認証が必要です。認証後に画面を開き直してください。";
    if (error.status === 403 && error.code === "FORBIDDEN") return "この操作は利用できません。";
    if (error.status === 404 && error.code === "SCHEDULE_MONTH_NOT_AVAILABLE") return "指定された月の予定は利用できません。別の月を選択してください。";
    if (error.status === 400 && error.code === "INVALID_REQUEST") return "入力内容を確認し、月を選択するか履歴を最新から再取得してください。";
  }
  return unknownMessage;
}
export class StudentReadController {
  readonly state: ReadState;
  private scheduleRevision = 0;
  private historyRevision = 0;
  constructor(month: string, private readonly fetcher: typeof fetch,
    private readonly changed: (area: Area, focus: boolean) => void) {
    if (!validMonth(month)) throw new Error("Invalid month");
    this.state = { month, view: "calendar", slots: [], history: { items: [], nextCursor: null },
      scheduleMessage: "", historyMessage: "", selectionMessage: "枠の選択だけでは予約は確定しません。",
      scheduleLoading: false, historyLoading: false, selectedId: null, stopped: false };
  }
  private async get(path: string): Promise<unknown> {
    const response = await this.fetcher(path, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json" } });
    if (!response.ok) {
      let code = "";
      try {
        const body = await response.json() as { error?: { code?: unknown } };
        if (typeof body?.error?.code === "string") code = body.error.code;
      } catch { /* An unavailable default Worker need not return JSON. */ }
      throw new ReadError(response.status, code);
    }
    return response.json();
  }
  private fail(error: unknown, area: "schedule" | "history", focus: boolean): void {
    if (error instanceof ReadError && error.status === 401) {
      // Invalidate both outstanding reads and discard all prior personal state.
      this.scheduleRevision++; this.historyRevision++;
      Object.assign(this.state, { stopped: true, slots: [], history: { items: [], nextCursor: null },
        selectedId: null, selectionMessage: "", scheduleLoading: false, historyLoading: false,
        scheduleMessage: message(error), historyMessage: message(error) });
      this.changed("schedule", area === "schedule" && focus);
      this.changed("history", area === "history" && focus);
      return;
    }
    if (area === "schedule") this.state.scheduleMessage = message(error);
    else this.state.historyMessage = message(error);
    this.changed(area, focus);
  }
  async loadMonth(month: string, focus = true): Promise<void> {
    if (this.state.stopped) return;
    const revision = ++this.scheduleRevision;
    Object.assign(this.state, { slots: [], selectedId: null, selectionMessage: "枠の選択だけでは予約は確定しません。", scheduleLoading: false });
    if (!validMonth(month)) {
      this.state.scheduleMessage = "月をYYYY-MM形式で選択してください。";
      this.changed("schedule", focus); return;
    }
    Object.assign(this.state, { month, scheduleLoading: true, scheduleMessage: "予定を読み込んでいます。" });
    this.changed("schedule", false);
    try {
      const slots = parseSchedule(await this.get(`/api/me/schedule-months/${month}`), month);
      if (revision !== this.scheduleRevision || this.state.stopped) return;
      Object.assign(this.state, { slots, scheduleLoading: false, scheduleMessage: slots.length ? "予定を取得しました。" : "この月の枠はありません。" });
      this.changed("schedule", focus);
    } catch (error) {
      if (error instanceof ReadError && error.status === 401) { this.fail(error, "schedule", focus); return; }
      if (revision !== this.scheduleRevision || this.state.stopped) return;
      this.state.scheduleLoading = false;
      this.fail(error, "schedule", focus);
    }
  }
  async loadHistory(next = false, focus = true): Promise<void> {
    if (this.state.stopped || next && (this.state.historyLoading || !this.state.history.nextCursor)) return;
    const cursor = next ? this.state.history.nextCursor : null;
    const revision = ++this.historyRevision;
    Object.assign(this.state, { history: { items: [], nextCursor: null }, historyLoading: true, historyMessage: "履歴を読み込んでいます。" });
    this.changed("history", false);
    try {
      const page = parseHistory(await this.get(`/api/me/reservations${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`));
      if (revision !== this.historyRevision || this.state.stopped) return;
      Object.assign(this.state, { history: page, historyLoading: false, historyMessage: page.items.length ? "本人履歴を取得しました。" : "履歴はありません。" });
      this.changed("history", focus);
    } catch (error) {
      if (error instanceof ReadError && error.status === 401) { this.fail(error, "history", focus); return; }
      if (revision !== this.historyRevision || this.state.stopped) return;
      this.state.historyLoading = false;
      this.fail(error, "history", focus);
    }
  }
  setView(view: "calendar" | "list"): void { this.state.view = view; this.changed("view", false); }
  select(slotId: string): void {
    const slot = this.state.slots.find(item => item.slotId === slotId);
    if (this.state.stopped || this.state.scheduleLoading || slot?.view !== "bookable") return;
    this.state.selectedId = slotId;
    this.state.selectionMessage = `${intervalLabel(slot)}を選択しました。予約は確定していません。`;
    this.changed("selection", false);
  }
}
