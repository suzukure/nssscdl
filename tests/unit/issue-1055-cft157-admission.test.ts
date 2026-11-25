// #1055 static admission only. Pure contract checks: no process, Chrome or network.
import { describe, expect, it } from "vitest";
import {
  EXPECTED_CFT, classifyBinary, classifyVersion,
  classifySandbox, classifyOwnedAssets, classifyResponse,
} from "../evaluation/issue-1055-cft157-admission.mjs";

describe("#1055 Chrome157 static admission before an authorized one-shot", () => {
  it("accepts only an executable regular ELF, never a symlink or non-ELF", () => {
    expect(classifyBinary({ regular: true, executable: true, elf: true })).toBe("binary-ready");
    expect(classifyBinary({ symlink: true, regular: true, executable: true, elf: true })).toBe("binary-missing");
    expect(classifyBinary({ regular: false, executable: true, elf: true })).toBe("binary-missing");
    expect(classifyBinary({ regular: true, executable: false, elf: true })).toBe("binary-mode");
    expect(classifyBinary({ regular: true, executable: true, elf: false })).toBe("binary-format");
  });

  it.each([
    "Google Chrome for Testing 157.0.8092.0\n",
    "Google Chrome 157.0.8092.0\n",
    "Chromium 157.0.8092.0\n",
    "Chrome for Testing 157.0.8092.0\n",
  ])("accepts expected version with supported Chrome labels: %s", stdout => {
    expect(classifyVersion({ exitCode: 0, stdout })).toBe("version-confirmed");
  });

  it.each([
    "Google Chrome 154.0.8037.97\n",
    "Google Chrome 157.0.8093.0\n",
    "not a browser 157.0.8092.0",
    "Google Chrome 157.0.8092.0\nprivate-canary",
    "",
    "G".repeat(130),
    "Google Chrome 157.0.8092.0\0",
  ])("rejects unexpected version without reflecting its text: %s", stdout => {
    expect(classifyVersion({ exitCode: 0, stdout })).toBe("version-output-mismatch");
  });

  it("classifies a nonzero exit separately from a version mismatch", () => {
    expect(classifyVersion({ exitCode: 1, stdout: "private-canary" })).toBe("binary-unlaunchable");
    expect(classifyVersion({ exitCode: null })).toBe("binary-unlaunchable");
    expect(classifyVersion({ exitCode: 0, failure: true })).toBe("binary-unlaunchable");
    expect(EXPECTED_CFT).toBe("157.0.8092.0");
  });

  it("never silently treats unknown strict-sandbox capability as success", () => {
    expect(classifySandbox({ linux: false })).toBe("unsupported-platform");
    expect(classifySandbox({ linux: true })).toBe("sandbox-unknown");
    expect(classifySandbox({ linux: true, userns: "blocked" })).toBe("sandbox-blocked");
    expect(classifySandbox({ linux: true, userns: "allowed", apparmor: "unknown" })).toBe("sandbox-unknown");
    expect(classifySandbox({ linux: true, userns: "allowed", apparmor: "allowed" })).toBe("sandbox-precheck-pass");
  });

  it("requires parent Node and child Chrome tmp ownership, plus profile disposal", () => {
    expect(classifyOwnedAssets({ parentTmp: true, childTmp: true, profile: true, complete: true })).toBe("owner-precheck-pass");
    expect(classifyOwnedAssets({ parentTmp: true, childTmp: true, profile: false, complete: true })).toBe("owner-unknown");
    expect(classifyOwnedAssets({ parentTmp: false, childTmp: true, profile: true, complete: true })).toBe("owner-unknown");
    expect(classifyOwnedAssets({ parentTmp: true, childTmp: true, profile: true, complete: false })).toBe("owner-unknown");
  });

  it("never upgrades EOF alone, failed request or timeout to host-body proof", () => {
    const base = { status: 401, authStopped: true, terminal: "finished", hostBody: "matched", drain: "eof" };
    expect(classifyResponse(base)).toBe("host-confirmed");
    expect(classifyResponse({ ...base, terminal: "failed" })).toBe("unproved");
    expect(classifyResponse({ ...base, terminal: "unobserved" })).toBe("unproved");
    expect(classifyResponse({ ...base, hostBody: "timeout" })).toBe("unproved");
    expect(classifyResponse({ ...base, authStopped: false })).toBe("unproved");
    expect(classifyResponse({ ...base, status: 200 })).toBe("unproved");
    expect(classifyResponse({ ...base, terminal: "private-canary" })).toBe("unproved");
  });
});
