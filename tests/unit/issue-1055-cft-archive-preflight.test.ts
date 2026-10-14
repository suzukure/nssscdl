// #1055 investigation-only fixture. No Chrome launch or external download.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CFT 157 archive preflight (without per-entry 200MB cap)", () => {
  it("accepts 201MB single entry while rejecting dangerous ZIP structures", () => {
    const run = spawnSync("python3", [
      "tests/evaluation/issue-1055-cft-archive-preflight.py", "--self-test",
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 16_384 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Ran 9 tests");
    expect(run.stderr).toContain("OK");
  }, 35_000);
});
