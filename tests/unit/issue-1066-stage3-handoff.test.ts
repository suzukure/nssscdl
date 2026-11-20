// #1066 finite contract check. NO browser, shell, network or Workflow mutation.
import { describe, expect, it } from "vitest";
import {
  STAGE3_HANDOFF, classifyStage3Owner, classifyStage3Handoff,
} from "../evaluation/issue-1066-stage3-handoff.mjs";

const base = "25fecbf1059844a462a0d2ba22b147453f7b33a4";
const candidate = "a".repeat(40);
const runnerTmp = "/runner/_temp";
const ownedRoot = runnerTmp + "/nssscdl-1055-cft157-abcdef";
const executable = ownedRoot + "/owned-extract/chrome-linux64/chrome";
const env = {
  RUNNER_TEMP: runnerTmp, H9_OWNED_ROOT: ownedRoot,
  H9_CHROME_EXECUTABLE: executable,
};
const ownerEvidence = {
  rootCanonical: true, rootDirectory: true, rootOwned: true, rootPrivate: true,
};
const healthy = () => ({
  action: "opened", attempt: 1, draft: true, headRef: STAGE3_HANDOFF.branch,
  baseSha: base, approvedBaseSha: base, eventHeadSha: candidate,
  checkedOutHeadSha: candidate, sourcePinned: true,
  runnerLabel: "ubuntu-22.04", arch: "x86_64", nonroot: true,
  strictSandbox: true, hostMutation: false, env: { ...env },
  ownerEvidence: { ...ownerEvidence },
});

describe("#1066 Stage3 one-shot Workflow/script static handoff", () => {
  it("admits only the exact event, checked-out HEAD, strict sandbox and owned root", () => {
    expect(classifyStage3Handoff(healthy())).toBe("pass");
    expect(STAGE3_HANDOFF.requiredEnv).toEqual([
      "RUNNER_TEMP", "H9_OWNED_ROOT", "H9_CHROME_EXECUTABLE",
    ]);
    expect(STAGE3_HANDOFF.version).toBe("157.0.8092.0");
  });

  it("rejects the previous Workflow plan lacking H9_OWNED_ROOT before browser launch", () => {
    const earlier = healthy();
    delete (earlier.env as Partial<typeof earlier.env>).H9_OWNED_ROOT;
    expect(classifyStage3Handoff(earlier)).toBe("config-missing");
  });

  it("rejects missing Chrome binary binding and missing runner temp", () => {
    for (const k of STAGE3_HANDOFF.requiredEnv) {
      const x = healthy();
      x.env[k as keyof typeof x.env] = "";
      expect(classifyStage3Handoff(x)).toBe("config-missing");
    }
  });

  it("does not guess a PR HEAD before it exists", () => {
    const mismatch = healthy();
    mismatch.checkedOutHeadSha = "b".repeat(40);
    expect(classifyStage3Handoff(mismatch)).toBe("head-mismatch");
    mismatch.checkedOutHeadSha = candidate;
    mismatch.eventHeadSha = "planned-head";
    expect(classifyStage3Handoff(mismatch)).toBe("head-mismatch");
  });

  it("checks base SHA and one-shot event constraints", () => {
    const mutationCases: Array<[string, unknown]> = [
      ["action", "synchronize"], ["attempt", 2], ["draft", false],
      ["headRef", "other-branch"], ["baseSha", "b".repeat(40)],
      ["approvedBaseSha", "guess"], ["action", "workflow_dispatch"],
    ];
    for (const [field, replacement] of mutationCases) {
      const x = healthy();
      (x as Record<string, unknown>)[field] = replacement;
      expect(classifyStage3Handoff(x)).toBe("scope-disallowed");
    }
  });

  it("requires source pins and refuses OS/runner mismatches", () => {
    expect(classifyStage3Handoff({ ...healthy(), sourcePinned: false }))
      .toBe("source-hash-mismatch");
    expect(classifyStage3Handoff({ ...healthy(), runnerLabel: "ubuntu-24.04" }))
      .toBe("os-mismatch");
    expect(classifyStage3Handoff({ ...healthy(), arch: "aarch64" }))
      .toBe("os-mismatch");
    expect(classifyStage3Handoff({ ...healthy(), nonroot: false }))
      .toBe("os-mismatch");
  });

  it("rejects disabled sandbox or host mutation", () => {
    expect(classifyStage3Handoff({ ...healthy(), strictSandbox: false }))
      .toBe("sandbox-disallowed");
    expect(classifyStage3Handoff({ ...healthy(), hostMutation: true }))
      .toBe("sandbox-disallowed");
  });

  it("requires an actual canonical private run-owned directory", () => {
    for (const k of Object.keys(ownerEvidence)) {
      expect(classifyStage3Owner({ ...ownerEvidence, [k]: false,
        runnerTemp: runnerTmp, ownedRoot, chromeExecutable: executable }))
        .toBe("owner-root-invalid");
    }
  });

  it("rejects arbitrary, missing, forged and unrelated roots", () => {
    expect(classifyStage3Owner({ ...ownerEvidence, runnerTemp: runnerTmp,
      ownedRoot: "/tmp/other/nssscdl-1055-abcdef", chromeExecutable: executable }))
      .toBe("owner-root-invalid");
    expect(classifyStage3Owner({ ...ownerEvidence, runnerTemp: runnerTmp,
      ownedRoot: runnerTmp + "/nssscdl-1055-", chromeExecutable: executable }))
      .toBe("owner-root-invalid");
    expect(classifyStage3Owner({ ...ownerEvidence, runnerTemp: runnerTmp,
      ownedRoot: runnerTmp + "/nssscdl-1055-a/../b", chromeExecutable: executable }))
      .toBe("owner-root-invalid");
    expect(classifyStage3Owner({ ...ownerEvidence, runnerTemp: runnerTmp,
      ownedRoot, chromeExecutable: "/bin/false" })).toBe("owner-root-invalid");
    expect(classifyStage3Owner({ ...ownerEvidence, runnerTemp: runnerTmp,
      ownedRoot, chromeExecutable: "" })).toBe("config-missing");
  });

  it("fails closed on missing or fabricated ownership evidence", () => {
    expect(classifyStage3Handoff({ ...healthy(), ownerEvidence: undefined }))
      .toBe("owner-root-invalid");
    expect(classifyStage3Handoff({ ...healthy(), ownerEvidence:
      { ...ownerEvidence, rootPrivate: false } })).toBe("owner-root-invalid");
  });
});
