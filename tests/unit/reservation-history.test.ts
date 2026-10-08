import { beforeAll, describe, expect, it, vi } from "vitest";
import { ReservationHistoryService, type ReservationHistoryRow } from "../../src/application/reservation-history";
import { HmacReservationHistoryCursorCodec } from "../../src/infrastructure/reservation-history-cursor";
import { D1ReservationHistoryRepository } from "../../src/infrastructure/d1-reservation-history";

const start = Date.parse("2026-11-01T10:00:00+09:00") / 1000;
const row: ReservationHistoryRow = { reservationId: "r", startsAt: start, endsAt: start + 3600,
  reservationState: "confirmed", attendanceState: "none", classification: "standard" };
let key: CryptoKey, codec: HmacReservationHistoryCursorCodec;
beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  codec = new HmacReservationHistoryCursorCodec(key);
});
const position = { startsAt: start, reservationId: "r" };

describe("reservation history Application / cursor partial evidence", () => {
  it("[TC-F-005-01] projects independent public states, Tokyo dates and no internals", async () => {
    const rows: ReservationHistoryRow[] = [
      { ...row, reservationId: "z" },
      { ...row, reservationId: "y", classification: "additional" },
      { ...row, reservationId: "x", attendanceState: "absent", classification: null },
      { ...row, reservationId: "w", reservationState: "student_cancelled", classification: null },
      { ...row, reservationId: "v", reservationState: "school_cancelled", attendanceState: "absent", classification: null },
      { ...row, reservationId: "u", reservationState: "system_cancelled", classification: null },
    ];
    const result = await new ReservationHistoryService({ readPage: async () => rows }, codec).execute("self");
    expect(result).toEqual({ items: rows.map((item) => ({
      reservationId: item.reservationId, startsAt: "2026-11-01T10:00:00+09:00", endsAt: "2026-11-01T11:00:00+09:00",
      reservationState: item.reservationState, attendanceState: item.attendanceState,
      classification: item.classification ?? "not_applicable",
    })), nextCursor: null });
  });
  it("uses limit+1 only for continuation and signs the last returned position", async () => {
    const readPage = vi.fn(async () => [{ ...row, reservationId: "z" }, { ...row, reservationId: "y" }]);
    const result = await new ReservationHistoryService({ readPage }, codec).execute("self", 1);
    expect(result.items.map((item) => item.reservationId)).toEqual(["z"]);
    expect(await codec.decode("self", result.nextCursor!)).toEqual({ startsAt: start, reservationId: "z" });
    expect(readPage).toHaveBeenCalledExactlyOnceWith("self", 1, null);
  });
  it("handles empty pages and no continuation at exactly limit", async () => {
    for (const rows of [[], [row]]) {
      expect((await new ReservationHistoryService({ readPage: async () => rows }, codec).execute("self", 1)).nextCursor).toBeNull();
    }
  });
  it.each([
    [{ ...row, reservationId: "" }], [{ ...row, startsAt: 1.5 }], [{ ...row, endsAt: start }],
    [{ ...row, endsAt: Number.MAX_SAFE_INTEGER }], [{ ...row, reservationState: "unknown" }],
    [{ ...row, attendanceState: "unknown" }], [{ ...row, classification: "unknown" }],
    [row, row], [{ ...row, reservationId: "a" }, { ...row, reservationId: "z" }], [row, row, row],
  ].map((rows) => ({ rows })))("fails closed on invalid count/order/types/enums/dates", async ({ rows }) => {
    await expect(new ReservationHistoryService({ readPage: async () => rows as ReservationHistoryRow[] }, codec)
      .execute("self", 1)).rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
  });
  it("roundtrips a signed cursor without exposing student identity in its payload", async () => {
    const cursor = await codec.encode("private-student", position);
    expect(await codec.decode("private-student", cursor)).toEqual(position);
    const payload = atob(cursor.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"));
    expect(JSON.parse(payload)).toEqual({ version: 1, ...position });
    expect(payload).not.toContain("private-student");
  });
  it("rejects wrong identity, wrong key and changed MAC/payload before reading", async () => {
    const cursor = await codec.encode("self", position);
    await expect(codec.decode("other", cursor)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const other = new HmacReservationHistoryCursorCodec(await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
    await expect(other.decode("self", cursor)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const parts = cursor.split(".");
    for (const value of ["", "opaque", cursor.replace("v1.", "v2."), `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`,
      `${parts[0]}.A${parts[1].slice(1)}.${parts[2]}`, `${cursor}=`, "v1.A.A" ]) {
      const readPage = vi.fn(async () => [row]);
      await expect(new ReservationHistoryService({ readPage }, codec).execute("self", 1, value))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(readPage).not.toHaveBeenCalled();
    }
  });
  it("fails closed on an unusable signing key without an error cause", async () => {
    const wrong = new HmacReservationHistoryCursorCodec(await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-512" }, false, ["sign"]));
    await expect(wrong.encode("self", position)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
  });
  it.each([{ version: 2, ...position }, { version: 1, startsAt: "wrong", reservationId: "r" },
    { version: 1, ...position, extra: true }, { version: 1, startsAt: start, reservationId: "" }])(
    "rejects even correctly signed invalid logical payload", async (payload) => {
      const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const tag = new Uint8Array(await crypto.subtle.sign("HMAC", key,
        new TextEncoder().encode(JSON.stringify(["reservation-history-v1", "self", encoded]))));
      const signature = btoa(Array.from(tag, (byte) => String.fromCharCode(byte)).join(""))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      await expect(codec.decode("self", `v1.${encoded}.${signature}`)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    });
});

describe("D1 history shape / read-only boundary", () => {
  const raw = { reservation_id: "r", student_id: "self", status: "confirmed", classification: "standard",
    starts_at: start, ends_at: start + 3600, absence_id: null, absence_count: 0 };
  function source(result: unknown) {
    const all = vi.fn(async () => result);
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn<(query: string) => { bind: typeof bind }>(() => ({ bind }));
    const withSession = vi.fn(() => ({ prepare }));
    return { withSession, prepare, bind, all, database: { withSession } as unknown as ConstructorParameters<typeof D1ReservationHistoryRepository>[0] };
  }
  it("uses exactly one Primary session and SELECT with owner/position/limit+1 binds", async () => {
    const input = source({ success: true, results: [raw] });
    const after = { startsAt: start + 1, reservationId: "z" };
    expect(await new D1ReservationHistoryRepository(input.database).readPage("self", 50, after)).toEqual([row]);
    expect(input.withSession).toHaveBeenCalledExactlyOnceWith("first-primary");
    expect(input.bind).toHaveBeenCalledExactlyOnceWith("self", start + 1, start + 1, "z", 51);
    expect(input.prepare).toHaveBeenCalledTimes(1);
    expect(input.all).toHaveBeenCalledTimes(1);
    expect(input.prepare.mock.calls[0][0]).toMatch(/^SELECT/);
  });
  it.each([null, {}, { success: "true", results: [] }, { success: true, results: null },
    { success: true, results: [null] }, { success: true, results: [{ ...raw, student_id: "other" }] },
    { success: true, results: [{ ...raw, absence_count: 2 }] },
    { success: true, results: [{ ...raw, absence_id: "other", absence_count: 1 }] },
    { success: true, results: [{ ...raw, classification: "unknown" }] },
    { success: true, results: [{ ...raw, starts_at: String(start) }] },
  ])("classifies malformed successful reads as integrity failure", async (result) => {
    await expect(new D1ReservationHistoryRepository(source(result).database).readPage("self", 50, null))
      .rejects.toMatchObject({ code: "INTEGRITY_STATE_UNAVAILABLE" });
  });
  it("abstracts unsuccessful D1 and thrown setup/execution errors", async () => {
    const input = source({ success: false, results: [] });
    await expect(new D1ReservationHistoryRepository(input.database).readPage("self", 50, null))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    input.withSession.mockImplementation(() => { throw new Error("internal DB reason"); });
    await expect(new D1ReservationHistoryRepository(input.database).readPage("self", 50, null))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
  });
});
