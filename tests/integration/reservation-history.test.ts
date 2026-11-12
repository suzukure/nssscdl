import { beforeAll, describe, expect, it, vi } from "vitest";
import { ReservationHistoryError, ReservationHistoryService } from "../../src/application/reservation-history";
import { StudentAccessError } from "../../src/application/student-access-guard";
import { ReservationHistoryHttpAdapter } from "../../src/http/reservation-history";
import { HmacReservationHistoryCursorCodec } from "../../src/infrastructure/reservation-history-cursor";
import { FakeStudentAccessGuard } from "./student-access-guard-fixture";

let codec: HmacReservationHistoryCursorCodec;
beforeAll(async () => { codec = new HmacReservationHistoryCursorCodec(
  await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])); });
const request = (suffix = "", method = "GET", protocol = "https") =>
  new Request(`${protocol}://nssscdl.test/api/me/reservations${suffix}`, { method });
function setup(status: "authenticated" | "unauthenticated" | "forbidden" = "authenticated") {
  const guard = new FakeStudentAccessGuard(status === "authenticated" ? { status, studentId: "resolved-self" } : { status });
  const readPage = vi.fn(async () => []);
  return { guard, readPage, adapter: new ReservationHistoryHttpAdapter(guard, new ReservationHistoryService({ readPage }, codec)) };
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error: { code, retry: status === 503 ? "later" : "none" } });
}
describe("isolated GET reservation history HTTP boundary", () => {
  it.each([["", 50], ["?limit=1", 1], ["?limit=100", 100]] as const)("accepts %s without CSRF and uses only Guard identity", async (suffix, limit) => {
    const { adapter, readPage, guard } = setup();
    const input = request(suffix);
    input.headers.set("studentId", "untrusted-other");
    input.headers.set("role", "admin");
    const response = await adapter.fetch(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(readPage).toHaveBeenCalledExactlyOnceWith("resolved-self", limit, null);
    expect(guard.requests).toEqual([input]);
  });
  it.each(["?limit=0", "?limit=101", "?limit=1.0", "?limit=+1", "?limit=%2B1", "?limit=-1", "?limit=%201", "?limit=1%20", "?limit=1%0A", "?limit=1%0D", "?limit=1%09", "?limit=1e1",
    "?limit=", "?limit=NaN", "?limit=１", "?limit=1&limit=1", "?cursor=x&cursor=y", "?unknown=1", "?studentId=other", "?email=x", "?role=admin",
    "?cursor=", "?cursor=wrong", "?cursor=v2.A.A", "/extra", "/", "%2F", "?%6cimit=1&limit=2"])("rejects %s before Guard/read", async (suffix) => {
    const { adapter, readPage, guard } = setup();
    await error(await adapter.fetch(request(suffix)), 400, "INVALID_REQUEST");
    expect(guard.requests).toEqual([]);
    expect(readPage).not.toHaveBeenCalled();
  });
  it.each(["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])("rejects method %s", async (method) => {
    const { adapter, readPage } = setup();
    await error(await adapter.fetch(request("", method)), 400, "INVALID_REQUEST");
    expect(readPage).not.toHaveBeenCalled();
  });
  it("rejects insecure protocol and body before authorization", async () => {
    const { adapter, guard } = setup();
    await error(await adapter.fetch(request("", "GET", "http")), 503, "SERVICE_UNAVAILABLE");
    const withBody = request();
    Object.defineProperty(withBody, "body", { value: new ReadableStream() });
    await error(await adapter.fetch(withBody), 400, "INVALID_REQUEST");
    expect(guard.requests).toEqual([]);
  });
  it.each([["unauthenticated", 401, "UNAUTHENTICATED"], ["forbidden", 403, "FORBIDDEN"]] as const)("maps %s without reading", async (state, status, code) => {
    const { adapter, readPage } = setup(state);
    const response = await adapter.fetch(request());
    expect(response.headers.has("set-cookie")).toBe(state === "unauthenticated");
    if (state === "unauthenticated") expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await error(response, status, code);
    expect(readPage).not.toHaveBeenCalled();
  });
  it("maps resolver failure without querying", async () => {
    const readPage = vi.fn(async () => []);
    const adapter = new ReservationHistoryHttpAdapter({ authorize: async () => { throw new StudentAccessError("SERVICE_UNAVAILABLE"); } },
      new ReservationHistoryService({ readPage }, codec));
    await error(await adapter.fetch(request()), 503, "SERVICE_UNAVAILABLE");
    expect(readPage).not.toHaveBeenCalled();
  });
  it.each(["SERVICE_UNAVAILABLE", "INTEGRITY_STATE_UNAVAILABLE"] as const)("maps %s safely", async (code) => {
    const adapter = new ReservationHistoryHttpAdapter(new FakeStudentAccessGuard({ status: "authenticated", studentId: "self" }),
      new ReservationHistoryService({ readPage: async () => { throw new ReservationHistoryError(code); } }, codec));
    await error(await adapter.fetch(request()), 503, code);
  });
  it("rejects a modified MAC at HTTP without reading", async () => {
    const { adapter, readPage } = setup();
    const cursor = await codec.encode("resolved-self", { startsAt: 1, reservationId: "r" });
    const parts = cursor.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    await error(await adapter.fetch(request(`?cursor=${parts.join(".")}`)), 400, "INVALID_REQUEST");
    expect(readPage).not.toHaveBeenCalled();
  });
  it("rejects a cross-student cursor without reading", async () => {
    const { adapter, readPage } = setup();
    const cursor = await codec.encode("other", { startsAt: 1, reservationId: "r" });
    await error(await adapter.fetch(request(`?cursor=${cursor}`)), 400, "INVALID_REQUEST");
    expect(readPage).not.toHaveBeenCalled();
  });
});
