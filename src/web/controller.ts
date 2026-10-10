import { parseHistory, parseSchedule, parsePreview, parseConfirm, parseCsrf, validMonth, intervalLabel,
  type Slot, type HistoryPage, type PreviewView, type ConfirmView } from "./model.js";
export type Area = "schedule" | "history" | "selection" | "view" | "operation";
export interface ReadState {
  month: string; view: "calendar" | "list"; slots: Slot[]; history: HistoryPage;
  scheduleMessage: string; historyMessage: string; selectionMessage: string;
  scheduleLoading: boolean; historyLoading: boolean; selectedId: string | null; stopped: boolean;
  operation: "idle" | "previewing" | "review" | "confirming" | "confirmed" | "halted";
  operationMessage: string; operationBusy: boolean; operationHalted: boolean;
  preview: PreviewView | null; confirmed: ConfirmView | null;
}
const unknownMessage = "現在の状態を確認できません。時間をおいて再取得してください。";
class ReadError extends Error {
  constructor(readonly status: number, readonly code: string = "", readonly retry: string = "") { super("Request unavailable"); }
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
  private operationRevision = 0;
  #csrf: string | null = null;
  #token: string | null = null;
  private needsFreshSchedule = false;
  constructor(month: string, private readonly fetcher: typeof fetch,
    private readonly changed: (area: Area, focus: boolean) => void) {
    if (!validMonth(month)) throw new Error("Invalid month");
    this.state = { month, view: "calendar", slots: [], history: { items: [], nextCursor: null },
      scheduleMessage: "", historyMessage: "", selectionMessage: "枠の選択だけでは予約は確定しません。",
      scheduleLoading: false, historyLoading: false, selectedId: null, stopped: false,
      operation: "idle", operationMessage: "", operationBusy: false, operationHalted: false, preview: null, confirmed: null };
  }
  private async get(path: string): Promise<unknown> {
    return this.request(path, "GET", 200);
  }
  private async request(path: string, method: "GET" | "POST", status: number, body?: object): Promise<unknown> {
    const response = await this.fetcher(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: method === "GET" ? { Accept: "application/json" } :
        { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": this.#csrf! },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) throw new ReadError(401);
    if (!response.ok) {
      let code = "", retry = "";
      try {
        const body = await response.json() as { error?: { code?: unknown; retry?: unknown } };
        if (typeof body?.error?.code === "string") code = body.error.code;
        if (typeof body?.error?.retry === "string") retry = body.error.retry;
      } catch { /* An unavailable default Worker need not return JSON. */ }
      throw new ReadError(response.status, code, retry);
    }
    if (response.status !== status) throw new Error("Invalid response");
    return response.json();
  }
  private fail(error: unknown, area: "schedule" | "history", focus: boolean): void {
    if (error instanceof ReadError && error.status === 401) {
      // Invalidate both outstanding reads and discard all prior personal state.
      this.scheduleRevision++; this.historyRevision++; this.clearConfirmation(); this.#csrf = null;
      Object.assign(this.state, { stopped: true, slots: [], history: { items: [], nextCursor: null },
        selectedId: null, selectionMessage: "", scheduleLoading: false, historyLoading: false,
        scheduleMessage: message(error), historyMessage: message(error), operationMessage: message(error), operationHalted: true, operation: "halted" });
      this.changed("operation", false);
      this.changed("schedule", area === "schedule" && focus);
      this.changed("history", area === "history" && focus);
      return;
    }
    if (area === "schedule") this.state.scheduleMessage = message(error);
    else this.state.historyMessage = message(error);
    this.changed(area, focus);
  }
  async loadMonth(month: string, focus = true, preserveResult = false): Promise<void> {
    if (this.state.stopped) return;
    if (!preserveResult) this.clearConfirmation();
    this.needsFreshSchedule = false;
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
    this.clearConfirmation();
    this.state.selectedId = slotId;
    this.state.selectionMessage = `${intervalLabel(slot)}を選択しました。予約は確定していません。`;
    this.changed("selection", false);
  }
  private clearConfirmation(): void {
    this.needsFreshSchedule ||= this.state.preview !== null || this.state.operation === "previewing" || this.state.operation === "confirming";
    this.operationRevision++; this.#token = null;
    this.state.preview = null; this.state.confirmed = null;
    if (!this.state.operationHalted) { this.state.operation = "idle"; this.state.operationMessage = ""; }
  }
  private current(revision: number): boolean { return revision === this.operationRevision && !this.state.stopped; }
  async preview(): Promise<void> {
    const slot = this.state.slots.find(item => item.slotId === this.state.selectedId);
    if (this.state.stopped || this.state.operationHalted || this.state.operationBusy || this.state.scheduleLoading || slot?.view !== "bookable") return;
    if (this.needsFreshSchedule || this.state.preview !== null) {
      this.clearConfirmation();
      this.state.operationMessage = "最新の予定を再取得します。予約可能枠を選び直し、再Previewして内容を確認してください。";
      void this.loadMonth(this.state.month, false, true);
      this.changed("operation", true); return;
    }
    this.clearConfirmation();
    const revision = this.operationRevision;
    Object.assign(this.state, { operation: "previewing", operationBusy: true, operationMessage: "予約内容を確認しています。" });
    this.changed("operation", false);
    try {
      // Acquisition occurs only on explicit Preview; neither mount nor selection fetches CSRF.
      if (!this.#csrf) {
        const csrf = parseCsrf(await this.get("/api/auth/student/csrf"));
        if (!this.current(revision)) return;
        this.#csrf = csrf;
      }
      if (!this.current(revision)) return;
      const parsed = parsePreview(await this.request("/api/me/reservations/preview", "POST", 200, { slotId: slot.slotId }), slot);
      if (!this.current(revision)) return;
      this.#token = parsed.token;
      Object.assign(this.state, { preview: parsed.view, operation: "review", operationMessage: "日時・区分・既存予約への変更を確認してから、予約を確定してください。" });
      this.changed("operation", true);
    } catch (error) { this.operationFailure(error, revision, false); }
    finally { this.state.operationBusy = false; this.changed("operation", false); }
  }
  async confirm(): Promise<void> {
    const view = this.state.preview, token = this.#token;
    if (this.state.stopped || this.state.operationHalted || this.state.operationBusy || this.state.operation !== "review" || !view || !token || !this.#csrf) return;
    const revision = this.operationRevision;
    const slot: Slot = { ...view.slot, view: "bookable" };
    this.#token = null; // Consume before await: a confirmation can send at most one Command.
    Object.assign(this.state, { operation: "confirming", operationBusy: true, operationMessage: "予約の確定結果を確認しています。再送しないでください。" });
    this.changed("operation", false);
    try {
      const result = parseConfirm(await this.request("/api/me/reservations", "POST", 201, { slotId: slot.slotId, expectedStateToken: token }), slot);
      if (!this.current(revision)) return;
      Object.assign(this.state, { preview: null, confirmed: result, operation: "confirmed", operationMessage: "予約済みです。メールの配送完了を表すものではありません。" });
      this.changed("operation", true);
      void this.loadMonth(this.state.month, false, true);
    } catch (error) { this.operationFailure(error, revision, true); }
    finally { this.state.operationBusy = false; this.changed("operation", false); }
  }
  private operationFailure(error: unknown, revision: number, command: boolean): void {
    if (error instanceof ReadError && error.status === 401) { this.fail(error, "schedule", false); this.changed("operation", true); return; }
    // An obsolete Command with an unknown outcome still prohibits future writes.
    const known = error instanceof ReadError && (error.status === 403 &&
      (error.code === "FORBIDDEN" || error.code === "CSRF_INVALID" && error.retry === "reload") || error.status === 409 &&
      (error.code === "RESERVATION_STATE_CHANGED" && error.retry === "repreview" ||
       ["RESERVATION_NOT_AVAILABLE", "RESERVATION_WINDOW_CLOSED"].includes(error.code) && error.retry === "reload"));
    if (!this.current(revision) && !(command && !known && !this.state.stopped)) return;
    this.clearConfirmation(); this.#csrf = null;
    if (error instanceof ReadError && error.status === 403 && error.code === "FORBIDDEN") {
      Object.assign(this.state, { operation: "halted", operationHalted: true, operationMessage: "この操作は利用できません。" });
    } else if (known) {
      this.state.operationMessage = error instanceof ReadError && error.code === "CSRF_INVALID"
        ? "操作を確認できませんでした。予定を再取得し、CSRFを再取得するPreviewから内容を再確認してください。"
        : error instanceof ReadError && error.retry === "repreview"
          ? "状態が変わりました。最新の予定を取得して再Previewし、変更内容を再確認してください。"
          : "この枠は現在予約できません。最新の予定から予約可能枠を選択し、再Previewしてください。";
      void this.loadMonth(this.state.month, false, true);
    } else {
      Object.assign(this.state, { operation: "halted", operationHalted: true,
        operationMessage: command ? "予約の確定結果は不明です。Confirmは再送しません。予定・本人履歴を再取得して現在の状態を確認してください。"
          : "予約内容を確認できません。操作を停止しました。予定・本人履歴を再取得してください。" });
    }
    this.changed("operation", true);
  }
}
