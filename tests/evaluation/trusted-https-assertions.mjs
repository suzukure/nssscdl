// Expected wires from #898 seed / #899 read service / Application §10.
// Never attach secret-bearing actual/expected values to an AssertionError.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const check = (condition) => { if (!condition) throw new Error("TRUSTED_HTTPS_PROOF_FAILED"); };
export const httpsProofCheckpoint = [
  "#908 TLS: IP SAN 127.0.0.1 / explicit CA / hostname verification / loopback owned listener passed",
  "TC-F-001-01 / TC-F-001-02 / TC-F-002-01 / TC-F-002-02 / TC-F-005-01 partial: self schedule=200 history=200 csrf=200; other schedule=200 history=200 csrf=200; exact owner-only schema / five views / confirmed history passed",
  "TC-F-207-02 partial: session CSRF correlation / Origin and same-origin metadata / no issuance passed",
  "TC-NF-914-04 partial: missing/fake/tampered Cookie=401 clear; Origin/metadata=403; unknown/POST=503; identity header ignored / query=400; no-store / no CORS / CSRF no-referrer / safe wire passed",
  "TC-F-207-03 / TC-F-211-02 partial: stopped Worker / closed port / local-only self revocation / proxy disposal / restart; old self three GETs=401; other three GETs=200; no business changes passed",
  "#908 D1: exact migrations/schema / integrity scans / read-only snapshots unchanged except one test-owned revoked_at; raw Session/CSRF absent from owned files, argv and env; no retry passed",
].join("\n");

export function expectedSchedule(seed, owner) {
  return { month: seed.month, slots: ["bookable", "self", "other", "group", "admin"].map((id, i) => ({
    slotId: `seed-slot-${id}`, startsAt: `${seed.date}T${10 + i}:00:00+09:00`, endsAt: `${seed.date}T${11 + i}:00:00+09:00`,
    view: id === "bookable" ? "bookable" : id === "group" ? "group_lesson" : id === owner ? "reserved_by_me" : "unavailable",
    ...(id === owner ? { reservationId: `seed-reservation-${owner}`, classification: "standard" } : {}),
  })) };
}

export function expectedHistory(seed, owner) {
  const hour = owner === "self" ? 11 : 12;
  return { items: [{ reservationId: `seed-reservation-${owner}`, reservationState: "confirmed", attendanceState: "none",
    classification: "standard", startsAt: `${seed.date}T${hour}:00:00+09:00`, endsAt: `${seed.date}T${hour + 1}:00:00+09:00` }], nextCursor: null };
}

export function checkWire(response, status, csrf = false) {
  check(response.status === status && response.headers["cache-control"] === "no-store" &&
    /^application\/json(?:;|$)/.test(response.headers["content-type"]) &&
    !Object.keys(response.headers).some((name) => name.startsWith("access-control-")));
  check(isDeepStrictEqual(response.headers["set-cookie"], status === 401 ? [
    "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ] : undefined));
  if (csrf) check(response.headers["referrer-policy"] === "no-referrer");
}

export function checkSuccess(response, kind, seed, owner) {
  checkWire(response, 200, kind === "csrf");
  const body = JSON.parse(response.body);
  if (kind === "csrf") {
    // Independent evaluation of the documented domain-separated formula.
    const expected = createHash("sha256").update("student-csrf-v1:" + seed.sessions[owner].cookie().value).digest("base64url");
    check(isDeepStrictEqual(body, { csrfToken: expected, scope: "session" }));
    return body.csrfToken;
  }
  check(isDeepStrictEqual(body, kind === "schedule" ? expectedSchedule(seed, owner) : expectedHistory(seed, owner)));
}

export function checkError(response, status, csrf = false) {
  checkWire(response, status, csrf);
  const errors = {
    400: ["INVALID_REQUEST", "入力内容を確認してください。", "none"],
    401: ["UNAUTHENTICATED", "認証が必要です。", "none"],
    403: ["CSRF_INVALID", "操作を確認できませんでした。画面を再読み込みしてください。", "reload"],
    503: ["SERVICE_UNAVAILABLE", "現在サービスを利用できません。時間をおいて再度お試しください。", "later"],
  };
  const [code, message, retry] = errors[status];
  check(isDeepStrictEqual(JSON.parse(response.body), { error: { code, message, retry } }));
}
