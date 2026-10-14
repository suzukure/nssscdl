import { createServer } from "node:http";
// #1055 investigation only. Real controller + Web Streams; NOT Chromium,
// Playwright, HTTP framing, Worker/D1, or formal proof evidence.
// The candidate lives only here. Limits below are fixture parameters, not
// approved product policy. See #1055 checkpoints for upstream evidence.
import { describe, expect, it } from "vitest";
import { StudentReadController } from "../../src/web/controller";

type DrainResult = "eof" | "absent" | "limit" | "deadline" | "unavailable";
const bytes = new TextEncoder().encode("private-canary");

// Experimental bounded discard: no decoded text, accumulation, logging,
// refetch, or successful completion inferred from status alone.
function discard(response: Response, maximum: number, milliseconds: number): Promise<DrainResult> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (!response.body) return Promise.resolve("absent");
    reader = response.body.getReader();
  } catch { return Promise.resolve("unavailable"); }
  return (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let count = 0, complete = false;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), milliseconds);
    });
    try {
      for (;;) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part === "deadline") return "deadline";
        if (part.done) { complete = true; return "eof"; }
        count += part.value.byteLength;
        if (count > maximum) return "limit";
      }
    } catch { return "unavailable"; }
    finally {
      clearTimeout(timer);
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
  it("loopback HTTP 401 staged EOF: immediate stop and same-GET nonblocking drain", async () => {
    // Node/undici loopback only: not a Chrome, CDP, Wrangler, or product-limit test.
    for (const mode of ["baseline", "discard"] as const) {
      let release!: () => void;
      const finishBody = new Promise<void>(resolve => { release = resolve; });
      const requests: Array<{ get: boolean; noCookie: boolean }> = [];
      let wireEnded = false;
      const server = createServer((request, response) => {
        const get = request.method === "GET" && request.url === "/api/me/schedule-months/2026-12";
        requests.push({ get, noCookie: request.headers.cookie === undefined });
        if (!get) { response.writeHead(405).end(); return; }
        response.writeHead(401, { "Cache-Control": "no-store", "Content-Type": "application/json" });
        response.write('{"error":');
        void finishBody.then(() => {
          wireEnded = true;
          response.end('{"code":"UNAUTHENTICATED"}}');
        });
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => { server.off("error", onError); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback listener unavailable");
      const origin = `http://127.0.0.1:${address.port}`;
      let actual: Response | undefined, completion: Promise<DrainResult> | undefined;
      let drainSettled = false;
      try {
        const fetcher: typeof fetch = async (path, options) => {
          const response = await fetch(origin + String(path), options);
          actual = response;
          if (mode === "discard" && response.status === 401)
            completion = discard(response, 128, 2000).then(result => {
              drainSettled = true;
              return result;
            });
          return response;
        };
        const c = new StudentReadController("2026-12", fetcher, () => {});
        await c.loadMonth("2026-12");
        expect({ status: actual?.status ?? null, requests, message: c.state.scheduleMessage }).toEqual({
          status: 401, requests: [{ get: true, noCookie: true }],
          message: "認証が必要です。認証後に画面を開き直してください。",
        });
        stopped(c);
        expect(wireEnded).toBe(false);
        expect(requests).toEqual([{ get: true, noCookie: true }]);
        expect(actual?.status).toBe(401);
        if (mode === "baseline") {
          expect(actual?.bodyUsed).toBe(false);
        } else {
          expect(actual?.bodyUsed).toBe(true);
          expect(drainSettled).toBe(false);
        }
        // Only now send EOF; no new request, no UI resumption and no POST.
        release();
        if (mode === "baseline") {
          expect(actual?.bodyUsed).toBe(false);
          await actual?.body?.cancel();
        } else {
          expect(await completion).toBe("eof");
          expect(actual?.body?.locked).toBe(false);
        }
        stopped(c);
        expect(requests).toEqual([{ get: true, noCookie: true }]);
      } finally {
        release();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  });

});
