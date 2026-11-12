// Browser-only projections of Application design §4 / §7; no server imports.
export const slotLabels = {
  bookable: "予約可能", reserved_by_me: "本人予約済み",
  group_lesson: "グループレッスン（予約不可）", unavailable: "予約不可",
} as const;
export const classificationLabels = { standard: "標準", additional: "追加", not_applicable: "対象外" } as const;
export const reservationLabels = {
  confirmed: "予約済み", student_cancelled: "生徒キャンセル",
  school_cancelled: "スクール都合キャンセル", system_cancelled: "システムキャンセル",
} as const;
export interface Slot {
  slotId: string; startsAt: string; endsAt: string; view: keyof typeof slotLabels;
  classification?: keyof typeof classificationLabels;
}
export interface HistoryItem {
  reservationId: string; startsAt: string; endsAt: string;
  reservationState: keyof typeof reservationLabels; attendanceState: "none" | "absent";
  classification: keyof typeof classificationLabels;
}
export interface HistoryPage { items: HistoryItem[]; nextCursor: string | null }
type BookingClassification = "standard" | "additional";
export interface ClassificationChange {
  reservationId: string; startsAt: string; before: BookingClassification; after: BookingClassification;
}
export interface PreviewView {
  slot: Pick<Slot, "slotId" | "startsAt" | "endsAt">;
  previewClassification: BookingClassification; classificationChanges: ClassificationChange[];
}
export interface ConfirmView {
  slot: Slot;
  reservation: Omit<HistoryItem, "attendanceState">;
  classificationChanges: ClassificationChange[];
}

export function validMonth(month: string): boolean {
  return /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month);
}
// UTC is used for calendar arithmetic only, never as the business timezone.
function calendarDate(month: string, day: number): Date {
  if (!validMonth(month)) throw new Error("Invalid month");
  const date = new Date(0);
  date.setUTCFullYear(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, day);
  return date;
}
export function monthDays(month: string): (number | null)[] {
  const first = calendarDate(month, 1).getUTCDay();
  const count = calendarDate(month, 32);
  count.setUTCDate(0);
  const days: (number | null)[] = Array(first).fill(null);
  for (let day = 1; day <= count.getUTCDate(); day++) days.push(day);
  while (days.length % 7) days.push(null);
  return days;
}
export function moveMonth(month: string, offset: -1 | 1): string {
  const date = calendarDate(month, 1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const next = `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return validMonth(next) ? next : month;
}
export function tokyoNowMonth(): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).formatToParts();
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}
export function validDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(value)) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  // Reject normalization (e.g. February 30 or 24:00) instead of silently changing a Slot.
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function dateTimeLabel(value: string): string {
  if (!validDateTime(value)) throw new Error("Invalid datetime");
  // Strict projection of the authoritative +09:00 wire; independent of device TZ.
  return `${value.slice(0, 4)}年${value.slice(5, 7)}月${value.slice(8, 10)}日 ${value.slice(11, 16)}`;
}
export function intervalLabel(item: { startsAt: string; endsAt: string }): string {
  return `${dateTimeLabel(item.startsAt)} ～ ${dateTimeLabel(item.endsAt)}（日本時間）`;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid response");
  return value;
}
function interval(value: Record<string, unknown>): { startsAt: string; endsAt: string } {
  if (!validDateTime(value.startsAt) || !validDateTime(value.endsAt) || value.startsAt >= value.endsAt) throw new Error("Invalid response");
  return { startsAt: value.startsAt, endsAt: value.endsAt };
}
function enumValue<T extends string>(value: unknown, labels: Record<T, string>): T {
  if (typeof value !== "string" || !Object.hasOwn(labels, value)) throw new Error("Invalid response");
  return value as T;
}
const bookingLabels = { standard: "標準", additional: "追加" } as const;
function changes(value: unknown): ClassificationChange[] {
  if (!Array.isArray(value)) throw new Error("Invalid response");
  const seen = new Set<string>();
  return value.map(raw => {
    const item = record(raw), reservationId = id(item.reservationId);
    const before = enumValue(item.before, bookingLabels), after = enumValue(item.after, bookingLabels);
    if (!validDateTime(item.startsAt) || seen.has(reservationId) || before === after) throw new Error("Invalid response");
    seen.add(reservationId);
    return { reservationId, startsAt: item.startsAt, before, after };
  });
}
function bookingSlot(value: unknown, selected: Slot): PreviewView["slot"] {
  const item = record(value), dates = interval(item), slotId = id(item.slotId);
  if (slotId !== selected.slotId || dates.startsAt !== selected.startsAt || dates.endsAt !== selected.endsAt) throw new Error("Invalid response");
  return { slotId, ...dates };
}
export function parsePreview(value: unknown, selected: Slot): { view: PreviewView; token: string } {
  const data = record(value);
  return { view: { slot: bookingSlot(data.slot, selected),
    previewClassification: enumValue(data.previewClassification, bookingLabels), classificationChanges: changes(data.classificationChanges) },
    token: id(data.expectedStateToken) };
}
export function parseConfirm(value: unknown, selected: Slot): ConfirmView {
  const data = record(value), rawSlot = record(data.slot), reservation = record(data.reservation);
  const slot = bookingSlot(rawSlot, selected), dates = interval(reservation);
  if (rawSlot.view !== "reserved_by_me" || reservation.reservationState !== "confirmed" ||
      dates.startsAt !== slot.startsAt || dates.endsAt !== slot.endsAt) throw new Error("Invalid response");
  return { slot: { ...slot, view: "reserved_by_me" }, reservation: {
    reservationId: id(reservation.reservationId), ...dates, reservationState: "confirmed",
    classification: enumValue(reservation.classification, bookingLabels) }, classificationChanges: changes(data.classificationChanges) };
}
export function parseCsrf(value: unknown): string {
  const data = record(value);
  if (data.scope !== "session" || typeof data.csrfToken !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(data.csrfToken)) throw new Error("Invalid response");
  return data.csrfToken;
}
export function parseSchedule(value: unknown, month: string): Slot[] {
  const data = record(value);
  if (!validMonth(month) || data.month !== month || !Array.isArray(data.slots)) throw new Error("Invalid response");
  const seen = new Set<string>();
  return data.slots.map(raw => {
    const item = record(raw), dates = interval(item), slotId = id(item.slotId);
    if (!dates.startsAt.startsWith(`${month}-`) || seen.has(slotId)) throw new Error("Invalid response");
    seen.add(slotId);
    const view = enumValue(item.view, slotLabels);
    const slot: Slot = { slotId, ...dates, view };
    if (view === "reserved_by_me" && item.classification !== undefined) slot.classification = enumValue(item.classification, classificationLabels);
    // Explicit projection: no unknown response properties are retained/rendered.
    return slot;
  });
}
export function parseHistory(value: unknown): HistoryPage {
  const data = record(value);
  if (!Array.isArray(data.items) || !(data.nextCursor === null || typeof data.nextCursor === "string" && data.nextCursor)) throw new Error("Invalid response");
  const seen = new Set<string>();
  const items = data.items.map(raw => {
    const item = record(raw), dates = interval(item), reservationId = id(item.reservationId);
    if (seen.has(reservationId)) throw new Error("Invalid response");
    seen.add(reservationId);
    return { reservationId, ...dates, reservationState: enumValue(item.reservationState, reservationLabels),
      attendanceState: enumValue(item.attendanceState, { none: "なし", absent: "欠席" }),
      classification: enumValue(item.classification, classificationLabels) };
  });
  return { items, nextCursor: data.nextCursor as string | null };
}
