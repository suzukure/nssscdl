// #1055 investigation only. Real controller + Web Streams; NOT Chromium,
// Playwright, HTTP framing, Worker/D1, or formal proof evidence.
// The candidate lives only here. Limits below are fixture parameters, not
// approved product policy. See #1055 checkpoints for upstream evidence.
import { describe, expect, it } from "vitest";
import { StudentReadController } from "../../src/web/controller";

type DrainResult = "eof" | "absent" | "limit" | "deadline" | "aborted" | "unavailable";
const bytes = new TextEncoder().encode("private-canary");

// Experimental bounded discard: no decoded text, accumulation, logging,
// refetch, or successful completion inferred from status alone.
function discard(response: Response, maximum: number, milliseconds: number, signal?: AbortSignal): Promise<DrainResult> {
  // This is an experiment-only owner cancellation seam, not a product policy.
  if (signal?.aborted) return Promise.resolve("aborted");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (!response.body) return Promise.resolve("absent");
    reader = response.body.getReader();
  } catch { return Promise.resolve("unavailable"); }
  return (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let count = 0, complete = false;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), milliseconds);
    });
    const aborted = new Promise<"aborted">(resolve => {
      if (!signal) return;
      abortListener = () => resolve("aborted");
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) resolve("aborted");
    });
    try {
      for (;;) {
        const part = await Promise.race([reader.read(), deadline, aborted]);
        if (part === "aborted") return "aborted";
        if (part === "deadline") return "deadline";
        if (part.done) { complete = true; return "eof"; }
        count += part.value.byteLength;
        if (count > maximum) return "limit";
      }
    } catch { return "unavailable"; }
    finally {
      clearTimeout(timer);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      // A hostile underlying cancel promise must not extend the deadline.
      // Cancellation is failure cleanup, never evidence of network EOF.
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();
}

function source() {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { producer = controller; },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  const response = new Response(stream, { status: 401, headers: { "Cache-Control": "no-store" } });
  return { response, producer, cancelled: () => cancelled };
}

function controller(fetcher: () => Promise<Response>) {
  return new StudentReadController("2026-12", fetcher as typeof fetch, () => {});
}
function stopped(value: StudentReadController) {
  expect(value.state.stopped).toBe(true);
  expect(value.state.scheduleLoading).toBe(false);
  expect(value.state.historyLoading).toBe(false);
  expect(value.state.slots).toEqual([]);
  expect(value.state.history.items).toEqual([]);
  expect(value.state.scheduleMessage).toContain("認証が必要です");
  expect(JSON.stringify(value.state)).not.toContain("private-canary");
}

describe("#1055 finite 401 lifecycle candidate comparison (not browser proof)", () => {
  it("baseline: actual controller stops but leaves its 401 body unconsumed", async () => {
    const s = source(), c = controller(async () => s.response);
    s.producer.enqueue(bytes); s.producer.close();
    await c.loadMonth("2026-12");
    stopped(c);
    expect(s.response.bodyUsed).toBe(false);
    expect(s.cancelled()).toBe(0);
    // Test-owned resource cleanup after observation, not controller behaviour.
    await s.response.body!.cancel();
  });

  it("rejects await-before-status: a stalled body delays actual authentication stop", async () => {
    const s = source();
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const c = controller(async () => {
      const reading = s.response.arrayBuffer(); began(); await reading;
      return s.response;
    });
    const loading = c.loadMonth("2026-12");
    await started;
    expect(c.state.stopped).toBe(false);
    expect(c.state.scheduleLoading).toBe(true);
    s.producer.enqueue(bytes); s.producer.close(); await loading;
    stopped(c);
  });

  it("candidate: authentication stops before EOF; later drain does not change state or resend", async () => {
    const s = source(); let calls = 0, finished = false;
    let draining!: Promise<DrainResult>;
    const c = controller(async () => {
      calls++;
      draining = discard(s.response, 64, 1000).then(result => { finished = true; return result; });
      return s.response;
    });
    await c.loadMonth("2026-12"); stopped(c);
    expect(finished).toBe(false);
    const state = JSON.stringify(c.state);
    s.producer.enqueue(bytes); s.producer.close();
    expect(await draining).toBe("eof");
    expect(s.cancelled()).toBe(0);
    expect(s.response.body!.locked).toBe(false);
    await c.loadMonth("2027-01"); await c.loadHistory(); await c.confirm();
    expect(calls).toBe(1);
    expect(JSON.stringify(c.state)).toBe(state);
  });

  it("candidate: a transport error retains the 401 stop and is not EOF", async () => {
    const s = source(); let draining!: Promise<DrainResult>;
    const c = controller(async () => { draining = discard(s.response, 64, 1000); return s.response; });
    await c.loadMonth("2026-12"); stopped(c);
    s.producer.error(new Error("private-canary"));
    expect(await draining).toBe("unavailable"); stopped(c);
    expect(s.response.body!.locked).toBe(false);
  });

  it.each([0, 13, 14])("reads through EOF within the fixture byte limit %s", async maximum => {
    const s = source(), draining = discard(s.response, maximum, 1000);
    s.producer.enqueue(bytes.subarray(0, maximum)); s.producer.close();
    expect(await draining).toBe("eof");
    expect(s.cancelled()).toBe(0);
    expect(s.response.body!.locked).toBe(false);
  });

  it("rejects cumulative overflow without accumulating chunks or accepting a prefix as EOF", async () => {
    const s = source(), draining = discard(s.response, 13, 1000);
    s.producer.enqueue(bytes.subarray(0, 7));
    s.producer.enqueue(bytes.subarray(7));
    expect(await draining).toBe("limit");
    expect(s.cancelled()).toBe(1);
    expect(s.response.body!.locked).toBe(false);
  });

  it("deadline terminates a never-ending read and releases its lock", async () => {
    const s = source(); let draining!: Promise<DrainResult>;
    const c = controller(async () => { draining = discard(s.response, 64, 10); return s.response; });
    await c.loadMonth("2026-12"); stopped(c);
    expect(await draining).toBe("deadline");
    expect(s.cancelled()).toBe(1);
    expect(s.response.body!.locked).toBe(false);
    stopped(c);
  });

  it("deadline does not wait on a never-resolving underlying cancellation", async () => {
    const response = new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }));
    expect(await discard(response, 64, 10)).toBe("deadline");
    expect(response.body!.locked).toBe(false);
  });

  it("does not steal an existing reader or treat an absent body as confirmed EOF", async () => {
    const s = source(), owner = s.response.body!.getReader();
    expect(await discard(s.response, 64, 10)).toBe("unavailable");
    expect(s.response.body!.locked).toBe(true);
    await owner.cancel(); owner.releaseLock();
    expect(await discard(new Response(null, { status: 401 }), 64, 10)).toBe("absent");
  });

  it("late parallel success cannot undo the real controller's 401 stop during a drain", async () => {
    const s = source(); let resolveHistory!: (response: Response) => void;
    const history = new Promise<Response>(resolve => { resolveHistory = resolve; });
    let calls = 0, draining!: Promise<DrainResult>;
    const c = controller(async () => {
      if (++calls === 1) { draining = discard(s.response, 64, 1000); return s.response; }
      return history;
    });
    const month = c.loadMonth("2026-12"), pendingHistory = c.loadHistory();
    await month; stopped(c);
    resolveHistory(Response.json({ items: [], nextCursor: null }));
    await pendingHistory; stopped(c);
    s.producer.enqueue(bytes); s.producer.close();
    expect(await draining).toBe("eof"); stopped(c); expect(calls).toBe(2);
  });
  it("two parallel initial 401 GETs retain immediate stop despite independent EOF/deadline", async () => {
    const month = source(), history = source();
    const requests: string[] = [], drains: Promise<DrainResult>[] = [];
    const fetcher: typeof fetch = async path => {
      const target = String(path);
      requests.push(target);
      if (target !== "/api/me/schedule-months/2026-12" && target !== "/api/me/reservations")
        throw new Error("unexpected fixture request");
      const fixture = target === "/api/me/reservations" ? history : month;
      drains.push(discard(fixture.response, 64, 20));
      return fixture.response;
    };
    const c = new StudentReadController("2026-12", fetcher, () => {});
    const initialMonth = c.loadMonth("2026-12");
    const initialHistory = c.loadHistory();
    await Promise.all([initialMonth, initialHistory]);
    stopped(c);
    expect(requests).toEqual(["/api/me/schedule-months/2026-12", "/api/me/reservations"]);
    expect(month.response.bodyUsed).toBe(true);
    expect(history.response.bodyUsed).toBe(true);
    const stoppedState = JSON.stringify(c.state);
    month.producer.enqueue(bytes); month.producer.close();
    expect(await drains[0]).toBe("eof");
    expect(await drains[1]).toBe("deadline");
    expect(history.cancelled()).toBe(1);
    expect(month.cancelled()).toBe(0);
    expect(month.response.body!.locked).toBe(false);
    expect(history.response.body!.locked).toBe(false);
    expect(JSON.stringify(c.state)).toBe(stoppedState);
    await c.loadMonth("2027-01"); await c.loadHistory(); await c.confirm();
    expect(requests).toHaveLength(2);
  });

  it("owner abort before read leaves 401 body untouched and does not acquire a lock", async () => {
    const s = source(), owner = new AbortController();
    owner.abort();
    expect(await discard(s.response, 64, 1000, owner.signal)).toBe("aborted");
    expect(s.response.bodyUsed).toBe(false);
    expect(s.response.body!.locked).toBe(false);
    expect(s.cancelled()).toBe(0);
    await s.response.body!.cancel();
  });

  it("owner abort during pending 401 read settles independently of EOF and preserves stop", async () => {
    const s = source(), owner = new AbortController();
    let draining!: Promise<DrainResult>, calls = 0;
    const c = controller(async () => {
      calls++;
      draining = discard(s.response, 64, 1000, owner.signal);
      return s.response;
    });
    await c.loadMonth("2026-12");
    stopped(c);
    owner.abort();
    expect(await draining).toBe("aborted");
    expect(s.cancelled()).toBe(1);
    expect(s.response.body!.locked).toBe(false);
    stopped(c);
    await c.loadMonth("2027-01"); await c.loadHistory(); await c.confirm();
    expect(calls).toBe(1);
  });

  it("late abort cannot turn observed EOF into failure or cancel complete body", async () => {
    const s = source(), owner = new AbortController();
    const draining = discard(s.response, 64, 1000, owner.signal);
    s.producer.enqueue(bytes); s.producer.close();
    expect(await draining).toBe("eof");
    owner.abort();
    expect(s.cancelled()).toBe(0);
    expect(s.response.body!.locked).toBe(false);
  });

  it("owner abort never awaits an underlying cancel promise that remains pending", async () => {
    const owner = new AbortController();
    const response = new Response(new ReadableStream({
      cancel: () => new Promise<void>(() => {}),
    }), { status: 401 });
    const draining = discard(response, 64, 1000, owner.signal);
    owner.abort();
    expect(await draining).toBe("aborted");
    expect(response.body!.locked).toBe(false);
  });

});
