// #1055 finite-only: no browser launch, network, child process or workflow changes.
import { describe, expect, it } from "vitest";
import {
  classifyThreeArm, createTerminalObserver, boundedSettlement, classifyRunRoot,
} from "../evaluation/issue-1055-cft157-lifecycle.mjs";

const arm = (name: string, values: Record<string, unknown> = {}) => ({
  arm: name, response: "401", page: "stopped", jar: "empty",
  request: "finished", body: "matched",
  drain: name === "baseline" ? "not-applicable" : "eof", ...values,
});
const input = (records = [arm("baseline"), arm("treatment"), arm("native")]) => ({
  records, getCount: 3, wrongCount: 0, ownedClean: true,
});

describe("#1055 three-arm synthetic observation is not a Chromium-causality claim", () => {
  it("separates all-three success from a differential result", () => {
    expect(classifyThreeArm(input())).toBe("baseline-no-reproduction");
    expect(classifyThreeArm(input([
      arm("baseline", { body: "timeout" }), arm("treatment"), arm("native"),
    ]))).toBe("synthetic-differential-observed");
  });

  it("does not call a mixed result or all-three failure an improvement", () => {
    expect(classifyThreeArm(input([
      arm("baseline", { request: "unobserved" }),
      arm("treatment", { request: "failed" }),
      arm("native", { body: "error" }),
    ]))).toBe("all-unproved");
    expect(classifyThreeArm(input([
      arm("baseline", { body: "timeout" }),
      arm("treatment", { drain: "running" }),
      arm("native"),
    ]))).toBe("mixed-inconclusive");
    expect(classifyThreeArm(input([
      arm("baseline"), arm("treatment", { body: "timeout" }), arm("native"),
    ]))).toBe("mixed-inconclusive");
  });

  it("fails closed on GET counts, unknown requests, cookies and cleanup", () => {
    expect(classifyThreeArm({ ...input(), getCount: 2 })).toBe("unproved");
    expect(classifyThreeArm({ ...input(), wrongCount: 1 })).toBe("unproved");
    expect(classifyThreeArm({ ...input(), ownedClean: false })).toBe("unproved");
    expect(classifyThreeArm(input([arm("baseline", { jar: "nonempty" }), arm("treatment"), arm("native")]))).toBe("unproved");
    expect(classifyThreeArm(input([arm("baseline"), arm("native"), arm("treatment")]))).toBe("unproved");
    expect(classifyThreeArm(input([arm("baseline", { drain: "running" }), arm("treatment"), arm("native")]))).toBe("unproved");
  });
});

describe("#1055 exact-Request terminal latch", () => {
  it("accepts an event arriving before wait on precisely the same request", async () => {
    const obs = createTerminalObserver({ timeoutMs: 30 });
    const req = {};
    obs.record(req, "finished");
    expect(await obs.waitFor(req)).toBe("finished");
    obs.dispose();
  });

  it("accepts late finish without a fixed 100ms sample", async () => {
    const obs = createTerminalObserver({ timeoutMs: 100 });
    const req = {};
    const settled = obs.waitFor(req);
    setTimeout(() => obs.record(req, "finished"), 15);
    expect(await settled).toBe("finished");
    obs.dispose();
  });

  it("never mixes events for two Requests with equal URLs", async () => {
    const obs = createTerminalObserver({ timeoutMs: 35 });
    const a = {}, b = {};
    const wait = obs.waitFor(a);
    obs.record(b, "finished");
    obs.record(a, "failed");
    expect(await wait).toBe("failed");
    expect(await obs.waitFor(b)).toBe("finished");
    obs.dispose();
  });

  it("detects duplicate terminal events delivered before the observation", async () => {
    const obs = createTerminalObserver({ timeoutMs: 30 });
    const request = {};
    obs.record(request, "finished");
    obs.record(request, "failed");
    expect(await obs.waitFor(request)).toBe("ambiguous");
    obs.dispose();
  });

  it("marks missing events as unobserved after its deadline", async () => {
    const obs = createTerminalObserver({ timeoutMs: 5 });
    expect(await obs.waitFor({})).toBe("unobserved");
    obs.dispose();
  });

  it("disposal resolves pending watchers and prevents late completion", async () => {
    const obs = createTerminalObserver({ timeoutMs: 200 });
    const req = {}, promise = obs.waitFor(req);
    obs.dispose();
    obs.record(req, "finished");
    expect(await promise).toBe("unobserved");
    expect(await obs.waitFor(req)).toBe("unobserved");
  });

  it("rejects an invalid latch deadline", () => {
    expect(() => createTerminalObserver({ timeoutMs: 0 })).toThrow();
  });
});

describe("#1055 settlement and owned-root boundary", () => {
  it("distinguishes immediate success from failure", async () => {
    expect(await boundedSettlement(async () => {}, 50)).toBe("settled");
    expect(await boundedSettlement(async () => { throw Error("canary"); }, 50)).toBe("failed");
  });

  it("marks a never-ending cleanup operation timeout instead of success", async () => {
    expect(await boundedSettlement(() => new Promise(() => {}), 6)).toBe("timeout");
  });

  it("does not turn a late rejection into an unhandled proof of success", async () => {
    let rejectWork: (err: Error) => void = () => {};
    const pending = new Promise((_resolve, reject) => { rejectWork = reject; });
    expect(await boundedSettlement(() => pending, 5)).toBe("timeout");
    rejectWork(Error("late-canary"));
    await Promise.resolve();
  });

  it("requires an absolute, real, private, owned descendant of RUNNER_TEMP", () => {
    const complete = { rootAbsolute: true, rootReal: true, rootOwned: true,
      rootPrivate: true, underRunner: true };
    expect(classifyRunRoot(complete)).toBe("root-admitted");
    for (const key of Object.keys(complete)) {
      expect(classifyRunRoot({ ...complete, [key]: false })).toBe("root-unknown");
    }
    expect(await boundedSettlement(() => {}, 0)).toBe("invalid");
  });
});
