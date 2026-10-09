// Finite schema/secret fixtures. They do not replace real Wrangler HTTPS proof.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";
import { checkError, checkSuccess, expectedHistory, expectedSchedule } from "./trusted-https-assertions.mjs";
import { waitForWorker } from "./local-https-smoke.mjs";

const seed = { month: "2026-11", date: "2026-11-15", sessions: {
  self: { cookie: () => ({ value: "A".repeat(43) }) }, other: { cookie: () => ({ value: "B".repeat(42) + "A" }) },
} };
const response = (body, extra = {}) => ({ status: 200, headers: {
  "cache-control": "no-store", "content-type": "application/json", "referrer-policy": "no-referrer",
}, body: JSON.stringify(body), ...extra });
const fixed = (e) => e.message === "TRUSTED_HTTPS_PROOF_FAILED" && !("cause" in e) && !("actual" in e) && !("expected" in e);

test("TC-F-001-01 / TC-F-001-02 / TC-F-002-01 / TC-F-002-02 / TC-F-005-01 partial #908: exact schema rejects owner leaks, wrong view and internal fields", () => {
  for (const owner of ["self", "other"]) {
    const schedule = expectedSchedule(seed, owner);
    const history = expectedHistory(seed, owner);
    // Independent fixture: owner self sees own 11:00, other sees own 12:00.
    assert.deepEqual(schedule.slots.map((s) => s.view), owner === "self"
      ? ["bookable", "reserved_by_me", "unavailable", "group_lesson", "unavailable"]
      : ["bookable", "unavailable", "reserved_by_me", "group_lesson", "unavailable"]);
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].startsAt, owner === "self" ? "2026-11-15T11:00:00+09:00" : "2026-11-15T12:00:00+09:00");
    checkSuccess(response(schedule), "schedule", seed, owner);
    checkSuccess(response(history), "history", seed, owner);
    for (const body of [
      { ...schedule, accountId: "private-fixture" },
      { ...schedule, slots: schedule.slots.map((s) => ({ ...s, studentId: "seed-other" })) },
      { ...schedule, slots: schedule.slots.map((s) => s.view === "unavailable" ? { ...s, reservationId: "private-fixture" } : s) },
      { ...schedule, slots: schedule.slots.map((s) => ({ ...s, view: "bookable" })) },
    ]) assert.throws(() => checkSuccess(response(body), "schedule", seed, owner), fixed);
    assert.throws(() => checkSuccess(response(expectedHistory(seed, owner === "self" ? "other" : "self")), "history", seed, owner), fixed);
    assert.throws(() => checkSuccess(response({ ...history, items: [...history.items, history.items[0]] }), "history", seed, owner), fixed);
  }
});

test("TC-F-207-02 / TC-NF-914-04 partial #908: CSRF exact session correlation; secret failures never carry assertion diffs", () => {
  const body = { csrfToken: createHash("sha256").update("student-csrf-v1:" + seed.sessions.self.cookie().value).digest("base64url"), scope: "session" };
  assert.equal(checkSuccess(response(body), "csrf", seed, "self") === body.csrfToken, true);
  for (const changed of [body.csrfToken + "private-fixture", seed.sessions.other.cookie().value]) {
    assert.throws(() => checkSuccess(response({ ...body, csrfToken: changed }), "csrf", seed, "self"), fixed);
  }
  for (const changed of [{ ...body, scope: "preauth" }, { ...body, sessionHash: "private-fixture" }]) {
    assert.throws(() => checkSuccess(response(changed), "csrf", seed, "self"), fixed);
  }
});

test("TC-NF-914-04 partial #908: no-store/no CORS/no issuance/no-referrer and canonical 401 clear cookie are mandatory", () => {
  const valid = response(expectedHistory(seed, "self"));
  for (const headers of [
    { ...valid.headers, "cache-control": "public" },
    { ...valid.headers, "access-control-allow-origin": "*" },
    { ...valid.headers, "access-control-allow-credentials": "true" },
    { ...valid.headers, "set-cookie": ["private-fixture"] },
  ]) assert.throws(() => checkSuccess({ ...valid, headers }, "history", seed, "self"), fixed);
  const csrf = response({ csrfToken: "private-fixture", scope: "session" }, { headers: { ...valid.headers, "referrer-policy": "origin" } });
  assert.throws(() => checkSuccess(csrf, "csrf", seed, "self"), fixed);
  const error = response({ error: { code: "UNAUTHENTICATED", message: "認証が必要です。", retry: "none" } }, { status: 401 });
  assert.throws(() => checkError(error, 401), fixed);
  error.headers["set-cookie"] = ["__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  checkError(error, 401);
  error.body = JSON.stringify({ error: JSON.parse(error.body).error, detail: "private-fixture" });
  assert.throws(() => checkError(error, 401), fixed);
});

test("#908 no opt-in: starts no seed, migration or listener", async () => {
  const persist = ".wrangler/student-read-only-evaluation";
  const before = existsSync(persist);
  await assert.rejects(promisify(execFile)(process.execPath, ["tests/evaluation/trusted-https-smoke.mjs"]),
    (e) => e.code === 1 && e.stdout === "");
  assert.equal(existsSync(persist), before);
});

test("#904/#908 shared readiness fixture: listener and internal sockets must be loopback and owned", async () => {
  const child = { pid: 42, exitCode: null, signalCode: null };
  const controller = new AbortController();
  const line = (address) => `LISTEN 0 511 ${address} 0.0.0.0:* users:((\"fixture\",pid=42,fd=1))`;
  const command = (main, internal, group = "42") => async (file, args) => file === "ps" ? group :
    args.includes("sport = :8788") ? line(main) : [line(main), line(internal)].join("\n");
  await waitForWorker(child, command("127.0.0.1:8788", "127.0.0.1:9229"), controller.signal);
  for (const fixture of [
    command("0.0.0.0:8788", "127.0.0.1:9229"),
    command("127.0.0.1:8788", "0.0.0.0:9229"),
    command("127.0.0.1:8788", "127.0.0.1:9229", "43"),
  ]) await assert.rejects(waitForWorker(child, fixture, controller.signal));
  await assert.rejects(waitForWorker({ ...child, spawnFailed: true }, command("127.0.0.1:8788", "127.0.0.1:9229"), controller.signal));
});
