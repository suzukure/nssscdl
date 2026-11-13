import { StudentReadController, type Area } from "./controller.js";
import { monthDays, moveMonth, slotLabels, classificationLabels, reservationLabels, intervalLabel, dateTimeLabel, type Slot } from "./model.js";

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
  scheduleHeading.tabIndex = -1;
  const form = element("form"), monthLabel = element("label", "表示する月（YYYY-MM）"), monthInput = element("input");
  monthLabel.htmlFor = "schedule-month"; monthInput.id = "schedule-month";
  monthInput.type = "month"; monthInput.required = true; monthInput.min = "0001-01"; monthInput.max = "9999-12"; monthInput.value = month;
  monthInput.setAttribute("aria-describedby", "schedule-status");
  const submit = element("button", "この月を取得"); submit.type = "submit";
  form.append(monthLabel, monthInput, submit);
  form.addEventListener("submit", event => { event.preventDefault(); void controller.loadMonth(monthInput.value); });
  const prev = button("前の月", () => { void controller.loadMonth(moveMonth(controller.state.month, -1)); });
  const next = button("次の月", () => { void controller.loadMonth(moveMonth(controller.state.month, 1)); });
  const nav = element("div"); nav.className = "controls"; nav.append(prev, next);
  const scheduleStatus = status("schedule-status"), selectionStatus = status("selection-status");
  const content = element("div"); content.id = "schedule-content";
  schedule.append(scheduleHeading, form, nav, scheduleStatus, content);
  const daily = element("section"), dailyHeading = element("h2", "選択日の時間枠一覧");
  dailyHeading.id = "daily-heading"; dailyHeading.tabIndex = -1;
  daily.setAttribute("aria-labelledby", dailyHeading.id);
  function moveTo(node: HTMLElement): void {
    node.focus({ preventScroll: true });
    node.scrollIntoView({ behavior: "instant", block: "start" });
  }
  const back = button("別の日を選ぶ（カレンダーへ）", () => moveTo(scheduleHeading));
  back.setAttribute("aria-controls", scheduleHeading.id);
  const dailyStatus = status("daily-status"), dailyContent = element("ul");
  dailyContent.id = "daily-content";
  daily.append(dailyHeading, back, dailyStatus, dailyContent, selectionStatus);
  const operation = element("section"), operationHeading = element("h2", "予約内容の確認・確定");
  operationHeading.id = "operation-heading"; operation.setAttribute("aria-labelledby", operationHeading.id);
  const operationStatus = status("operation-status"), operationContent = element("div");
  const preview = button("選択枠の予約内容をPreview", () => { void controller.preview(); });
  const confirm = button("内容を確認して予約を確定", () => { void controller.confirm(); });
  preview.setAttribute("aria-describedby", operationStatus.id); confirm.setAttribute("aria-describedby", operationStatus.id);
  operationContent.id = "operation-content"; confirm.setAttribute("aria-controls", operationContent.id);
  operation.append(operationHeading, preview, operationStatus, operationContent, confirm);
  const history = element("section"), historyHeading = element("h2", "本人の予約履歴");
  historyHeading.id = "history-heading"; history.setAttribute("aria-labelledby", historyHeading.id);
  const refresh = button("履歴を最新から再取得", () => { void controller.loadHistory(); });
  const more = button("履歴の次ページ", () => { void controller.loadHistory(true); });
  const historyStatus = status("history-status"), historyContent = element("ol");
  history.append(historyHeading, refresh, more, historyStatus, historyContent);
  root.replaceChildren(heading, explanation, schedule, daily, operation, history);
  const slotButtons = new Map<string, HTMLButtonElement>();
  const dateButtons = new Map<string, HTMLButtonElement>();
  function slotNode(slot: Slot): HTMLElement {
    const label = `${intervalLabel(slot)}：${slotLabels[slot.view]}${slot.classification ? `／${classificationLabels[slot.classification]}` : ""}`;
    if (slot.view !== "bookable") { const node = element("p", label); node.className = `slot ${slot.view}`; return node; }
    const node = button(label, () => controller.select(slot.slotId));
    node.className = "slot bookable"; node.setAttribute("aria-pressed", String(controller.state.selectedId === slot.slotId));
    node.setAttribute("aria-describedby", selectionStatus.id); slotButtons.set(slot.slotId, node); return node;
  }
  function renderSchedule(): void {
    const state = controller.state;
    dateButtons.clear(); content.replaceChildren();
    const scroll = element("div"); scroll.className = "calendar-scroll";
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", `${state.month}のカレンダー（横にスクロールできます）`);
    const grid = element("div"); grid.className = "calendar-grid";
    for (const weekday of ["日", "月", "火", "水", "木", "金", "土"]) grid.append(element("div", weekday));
    for (const day of monthDays(state.month)) {
      const cell = element("div"); cell.className = "calendar-day";
      if (day !== null) {
        const date = `${state.month}-${String(day).padStart(2, "0")}`, selected = date === state.selectedDate;
        if (selected) cell.className += " selected-day";
        const choose = button(`${day}日${selected ? " 選択中" : ""}`, () => controller.selectDate(date));
        choose.setAttribute("aria-label", `${state.month.slice(0, 4)}年${state.month.slice(5)}月${day}日${selected ? " 選択中" : ""}`);
        choose.setAttribute("aria-pressed", String(selected)); choose.setAttribute("aria-controls", dailyHeading.id);
        dateButtons.set(date, choose); cell.append(choose);
        // Calendar summaries are read-only; only the selected day's list can select a Slot.
        for (const slot of state.slots.filter(item => item.startsAt.slice(0, 10) === date)) {
          const summary = element("p", `${intervalLabel(slot)}：${slotLabels[slot.view]}${slot.classification ? `／${classificationLabels[slot.classification]}` : ""}`);
          summary.className = `slot ${slot.view}`; cell.append(summary);
        }
      } else cell.setAttribute("aria-hidden", "true");
      grid.append(cell);
    }
    scroll.append(grid); content.append(scroll);
    slotButtons.clear(); dailyContent.replaceChildren();
    const slots = state.slots.filter(slot => slot.startsAt.slice(0, 10) === state.selectedDate)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    dailyHeading.textContent = state.selectedDate
      ? `${state.selectedDate.slice(0, 4)}年${state.selectedDate.slice(5, 7)}月${state.selectedDate.slice(8)}日の時間枠一覧（日本時間）`
      : "選択日の時間枠一覧";
    dailyStatus.textContent = !state.scheduleReady ? state.scheduleMessage : !state.selectedDate ? "カレンダーから日付を選択してください。"
      : !slots.length ? "この日の公開枠はありません。" : !slots.some(slot => slot.view === "bookable")
        ? "この日に予約可能な枠はありません。" : "予約可能枠を選択できます。";
    for (const slot of slots) { const item = element("li"); item.append(slotNode(slot)); dailyContent.append(item); }
  }
  function render(area: Area, focus: boolean): void {
    const state = controller.state;
    if (area === "schedule" || area === "day") {
      monthInput.value = state.month;
      scheduleStatus.textContent = state.scheduleMessage;
      content.setAttribute("aria-busy", String(state.scheduleLoading));
      dailyContent.setAttribute("aria-busy", String(state.scheduleLoading));
      renderSchedule();
    }
    for (const control of [monthInput, submit, prev, next]) control.disabled = state.stopped || state.operation === "confirming";
    prev.disabled ||= state.month === "0001-01"; next.disabled ||= state.month === "9999-12";
    for (const node of dateButtons.values()) node.disabled = state.stopped || state.operation === "confirming" || state.scheduleLoading || !state.scheduleReady;
    for (const node of slotButtons.values()) node.disabled = state.stopped || state.operation === "confirming" || state.scheduleLoading;
    if (area === "schedule" || area === "day" || area === "selection") {
      selectionStatus.textContent = state.selectionMessage;
      for (const [id, node] of slotButtons) node.setAttribute("aria-pressed", String(id === state.selectedId));
    }
    if (area === "operation" || area === "schedule" || area === "day" || area === "selection") {
      operationStatus.textContent = state.operationMessage;
      operationContent.setAttribute("aria-busy", String(state.operationBusy));
      preview.disabled = state.stopped || state.operationHalted || state.operationBusy || state.scheduleLoading || !state.selectedId;
      confirm.disabled = state.stopped || state.operationHalted || state.operationBusy || state.operation !== "review";
      operationContent.replaceChildren();
      const view = state.preview ?? state.confirmed;
      if (view) {
        const classification = state.preview?.previewClassification ?? state.confirmed!.reservation.classification;
        operationContent.append(element("p", intervalLabel(view.slot)), element("p", `区分：${classificationLabels[classification]}`));
        if (classification === "additional") operationContent.append(element("p", "現在は追加区分ですが、他予約のキャンセル等によりLesson開始前までは後から再分類される場合があります。"));
        operationContent.append(element("h3", "既存の本人予約への区分変更"));
        const changes = element("ul");
        for (const change of view.classificationChanges) changes.append(element("li", `${dateTimeLabel(change.startsAt)}（日本時間）：${classificationLabels[change.before]} → ${classificationLabels[change.after]}`));
        if (view.classificationChanges.length) operationContent.append(changes);
        else operationContent.append(element("p", "区分変更はありません。"));
      }
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
    if (area === "day" && focus) moveTo(dailyHeading);
    else if (focus) (area === "operation" ? operationStatus : area === "history" ? historyStatus : scheduleStatus).focus();
  }
  const controller = new StudentReadController(month, fetcher, render);
  render("schedule", false); render("history", false);
  void controller.loadInitialSchedule(); void controller.loadHistory(false, false);
  return controller;
}
