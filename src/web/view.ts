import { StudentReadController, type Area } from "./controller.js";
import { monthDays, moveMonth, slotLabels, classificationLabels, reservationLabels, intervalLabel, type Slot } from "./model.js";

export function mountStudent(root: HTMLElement, month: string, fetcher: typeof fetch): StudentReadController {
  const doc = root.ownerDocument;
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag); node.textContent = text; return node;
  }
  function button(text: string, action: () => void): HTMLButtonElement {
    const node = element("button", text); node.type = "button";
    node.addEventListener("click", action); return node;
  }
  function status(id: string): HTMLParagraphElement {
    const node = element("p"); node.id = id; node.tabIndex = -1;
    node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite"); return node;
  }
  const heading = element("h1", "生徒の予定・本人履歴");
  const explanation = element("p", "日時は日本時間です。予約可能枠を選択できます。選択だけでは予約は確定しません。");
  const schedule = element("section"), scheduleHeading = element("h2", "月間予定");
  schedule.setAttribute("aria-labelledby", "schedule-heading"); scheduleHeading.id = "schedule-heading";
  const form = element("form"), monthLabel = element("label", "表示する月（YYYY-MM）"), monthInput = element("input");
  monthLabel.htmlFor = "schedule-month"; monthInput.id = "schedule-month";
  monthInput.type = "month"; monthInput.required = true; monthInput.min = "0001-01"; monthInput.max = "9999-12"; monthInput.value = month;
  monthInput.setAttribute("aria-describedby", "schedule-status");
  const submit = element("button", "この月を取得"); submit.type = "submit";
  form.append(monthLabel, monthInput, submit);
  form.addEventListener("submit", event => { event.preventDefault(); void controller.loadMonth(monthInput.value); });
  const prev = button("前の月", () => { void controller.loadMonth(moveMonth(controller.state.month, -1)); });
  const next = button("次の月", () => { void controller.loadMonth(moveMonth(controller.state.month, 1)); });
  const calendar = button("カレンダー表示", () => controller.setView("calendar"));
  const list = button("一覧表示", () => controller.setView("list"));
  const nav = element("div"); nav.className = "controls"; nav.append(prev, next, calendar, list);
  const scheduleStatus = status("schedule-status"), selectionStatus = status("selection-status");
  const content = element("div"); content.id = "schedule-content";
  calendar.setAttribute("aria-controls", content.id); list.setAttribute("aria-controls", content.id);
  schedule.append(scheduleHeading, form, nav, scheduleStatus, content, selectionStatus);
  const history = element("section"), historyHeading = element("h2", "本人の予約履歴");
  historyHeading.id = "history-heading"; history.setAttribute("aria-labelledby", historyHeading.id);
  const refresh = button("履歴を最新から再取得", () => { void controller.loadHistory(); });
  const more = button("履歴の次ページ", () => { void controller.loadHistory(true); });
  const historyStatus = status("history-status"), historyContent = element("ol");
  history.append(historyHeading, refresh, more, historyStatus, historyContent);
  root.replaceChildren(heading, explanation, schedule, history);
  const slotButtons = new Map<string, HTMLButtonElement>();
  function slotNode(slot: Slot): HTMLElement {
    const label = `${intervalLabel(slot)}：${slotLabels[slot.view]}${slot.classification ? `／${classificationLabels[slot.classification]}` : ""}`;
    if (slot.view !== "bookable") { const node = element("p", label); node.className = `slot ${slot.view}`; return node; }
    const node = button(label, () => controller.select(slot.slotId));
    node.className = "slot bookable"; node.setAttribute("aria-pressed", String(controller.state.selectedId === slot.slotId));
    node.setAttribute("aria-describedby", selectionStatus.id); slotButtons.set(slot.slotId, node); return node;
  }
  function renderSchedule(): void {
    const state = controller.state;
    slotButtons.clear(); content.replaceChildren();
    if (state.view === "list") {
      const items = element("ul");
      for (const slot of state.slots) { const item = element("li"); item.append(slotNode(slot)); items.append(item); }
      content.append(items); return;
    }
    const scroll = element("div"); scroll.className = "calendar-scroll";
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", `${state.month}のカレンダー（横にスクロールできます）`);
    const grid = element("div"); grid.className = "calendar-grid";
    for (const weekday of ["日", "月", "火", "水", "木", "金", "土"]) grid.append(element("div", weekday));
    for (const day of monthDays(state.month)) {
      const cell = element("div"); cell.className = "calendar-day";
      if (day !== null) {
        cell.append(element("h3", `${day}日`));
        for (const slot of state.slots.filter(item => Number(item.startsAt.slice(8, 10)) === day)) cell.append(slotNode(slot));
      } else cell.setAttribute("aria-hidden", "true");
      grid.append(cell);
    }
    scroll.append(grid); content.append(scroll);
  }
  function render(area: Area, focus: boolean): void {
    const state = controller.state;
    if (area === "schedule" || area === "view") {
      monthInput.value = state.month;
      for (const control of [monthInput, submit, prev, next]) control.disabled = state.stopped;
      prev.disabled ||= state.month === "0001-01"; next.disabled ||= state.month === "9999-12";
      calendar.setAttribute("aria-pressed", String(state.view === "calendar"));
      list.setAttribute("aria-pressed", String(state.view === "list"));
      scheduleStatus.textContent = state.scheduleMessage;
      content.setAttribute("aria-busy", String(state.scheduleLoading));
      renderSchedule();
    }
    if (area === "schedule" || area === "selection") {
      selectionStatus.textContent = state.selectionMessage;
      for (const [id, node] of slotButtons) node.setAttribute("aria-pressed", String(id === state.selectedId));
    }
    if (area === "history") {
      historyStatus.textContent = state.historyMessage;
      historyContent.setAttribute("aria-busy", String(state.historyLoading));
      more.disabled = state.stopped || state.historyLoading || state.history.nextCursor === null;
      refresh.disabled = state.stopped;
      historyContent.replaceChildren();
      for (const item of state.history.items) {
        const node = element("li");
        node.append(element("p", intervalLabel(item)), element("p", `予約状態：${reservationLabels[item.reservationState]}`),
          element("p", `欠席状態：${item.attendanceState === "absent" ? "欠席" : "なし"}`), element("p", `現在の区分：${classificationLabels[item.classification]}`));
        historyContent.append(node);
      }
    }
    if (focus) (area === "history" ? historyStatus : scheduleStatus).focus();
  }
  const controller = new StudentReadController(month, fetcher, render);
  render("schedule", false); render("history", false);
  void controller.loadMonth(month, false); void controller.loadHistory(false, false);
  return controller;
}
