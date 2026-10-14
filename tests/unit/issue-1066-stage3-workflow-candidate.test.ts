// #1066 INERT YAML candidate checks: no Actions activation and no Chrome execution.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import candidate from "../evaluation/issue-1066-stage3-workflow-candidate.yml?raw";
import archiveCode from "../evaluation/issue-1055-cft-archive-preflight.py?raw";
import admissionCode from "../evaluation/issue-1055-cft157-admission.mjs?raw";
import lifecycleCode from "../evaluation/issue-1055-cft157-lifecycle.mjs?raw";
import versionCode from "../evaluation/issue-1055-cft157-version-preflight.mjs?raw";
import browserCode from "../evaluation/issue-1055-cft157-synthetic-plan.mjs?raw";
import handoffCode from "../evaluation/issue-1066-stage3-handoff.mjs?raw";
import { STAGE3_HANDOFF } from "../evaluation/issue-1066-stage3-handoff.mjs";

const scriptText = browserCode;
const pinnedFiles: Record<string, string> = {
  "issue-1055-cft-archive-preflight.py": archiveCode,
  "issue-1055-cft157-admission.mjs": admissionCode,
  "issue-1055-cft157-lifecycle.mjs": lifecycleCode,
  "issue-1055-cft157-version-preflight.mjs": versionCode,
  "issue-1055-cft157-synthetic-plan.mjs": browserCode,
  "issue-1066-stage3-handoff.mjs": handoffCode,
};

function bashBody(yaml: string) {
  const chunks = yaml.split("\n        run: |\n");
  if (chunks.length !== 2) return null;
  const lines = chunks[1].replace(/\n$/, "").split("\n");
  if (lines.some(x => x.length && !x.startsWith("          "))) return null;
  return lines.map(x => x.startsWith("          ") ? x.slice(10) : x).join("\n") + "\n";
}

function candidateContract(yaml: string): string {
  if (!yaml.startsWith("# #1066 INERT CANDIDATE:") ||
    !yaml.includes("\non:\n  pull_request:\n    types: [opened]\n") ||
    !yaml.includes("\npermissions:\n  contents: read\njobs:\n  stage3:\n") ||
    !yaml.includes("    runs-on: " + STAGE3_HANDOFF.runner + "\n") ||
    !yaml.includes("    timeout-minutes: 8\n") ||
    !yaml.includes("    permissions:\n      contents: read\n") ||
    !yaml.includes("github.event.action == 'opened'") ||
    !yaml.includes("github.run_attempt == 1") ||
    !yaml.includes("github.event.pull_request.draft == true") ||
    !yaml.includes("github.head_ref == '" + STAGE3_HANDOFF.branch + "'") ||
    !yaml.includes("github.event.pull_request.base.sha == '25fecbf1059844a462a0d2ba22b147453f7b33a4'") ||
    !yaml.includes("ref: ${{ github.event.pull_request.head.sha }}") ||
    !yaml.includes("persist-credentials: false") ||
    !yaml.includes("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803") ||
    !yaml.includes("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")) return "scope-disallowed";
  const script = bashBody(yaml);
  if (script === null) return "yaml-run-unknown";
  if (!script.includes('export CHECKED_OUT_HEAD_SHA="$(git rev-parse HEAD)"') ||
    !script.includes('[[' + ' "$CHECKED_OUT_HEAD_SHA" == "$EVENT_HEAD_SHA" ]]') ||
    !script.includes("checkedOutHeadSha:env.CHECKED_OUT_HEAD_SHA"))
    return "head-mismatch";
  if (!script.includes('umask 077') ||
    !script.includes('H9_OWNED_ROOT="$(mktemp -d "$RUNNER_TEMP/nssscdl-1055-XXXXXX")"') ||
    !script.includes('export H9_CHROME_EXECUTABLE="$H9_OWNED_ROOT/owned-extract/chrome-linux64/chrome"') ||
    !script.includes("trap cleanup_stage3 EXIT") ||
    !script.includes("classifyStage3Handoff({") ||
    !script.includes('if(result!=="pass")process.exitCode=1;'))
    return "config-missing";
  if (!STAGE3_HANDOFF.requiredEnv.every(name => script.includes(name)) ||
    !script.includes("rootPrivate:(s.mode&0o077)===0") ||
    !script.includes("rootOwned:s.uid===process.getuid()"))
    return "owner-root-invalid";
  if (!script.includes("source-hash-mismatch") || !script.includes('git hash-object "$1"') ||
    !script.includes("archive-hash-mismatch"))
    return "source-hash-mismatch";
  if (!script.includes("unshare -Ur /usr/bin/true") ||
    !script.includes('[[ "$(lsb_release -rs 2>/dev/null)" == "22.04"') ||
    !script.includes('"$(id -u)" != "0"') ||
    !script.includes("node tests/evaluation/issue-1055-cft157-synthetic-plan.mjs") ||
    !script.includes("timeout --signal=TERM --kill-after=5s 135s"))
    return "sandbox-unknown";
  if (/--no-sandbox|sudo\s|sysctl -w|chmod\s+4755|ignoreHTTPSErrors:\s*true/.test(yaml) ||
    !script.includes("H9_STAGE3_GATE stage=cleanup; result=owned-confirmed") ||
    !script.includes('rm -rf -- "$H9_OWNED_ROOT"'))
    return "scope-disallowed";
  return "candidate-admitted-static";
}

function gitBlobSha(content: Uint8Array) {
  return createHash("sha1").update(Buffer.from("blob " + content.length + "\0"))
    .update(content).digest("hex");
}

describe("#1066 inert Stage3 candidate vs shared handoff", () => {
  it("keeps the proposed YAML inert outside GitHub's live workflow directory", () => {
    expect(candidate.startsWith("# #1066 INERT CANDIDATE:")).toBe(true);
    expect(candidateContract(candidate)).toBe("candidate-admitted-static");
    expect(candidate.includes("workflow_dispatch")).toBe(false);
    expect(candidate.includes("pull_request_target")).toBe(false);
  });

  it("checks the indented shell block and paired quoted heredoc boundary", () => {
    const script = bashBody(candidate);
    expect(script).not.toBe(null);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("node --input-type=module <<'ADMISSION'\n");
    expect(script).toContain("\nADMISSION\n");
    expect(script?.split("<<'ADMISSION'").length).toBe(2);
    expect(script?.split("\nADMISSION\n").length).toBe(2);
    // This is a static framing check, NOT a bash -n parse or a process launch.
  });

  it("rejects earlier omissions of owner binding and checked-out HEAD", () => {
    expect(candidateContract(candidate.replace('H9_OWNED_ROOT="$(mktemp -d "$RUNNER_TEMP/nssscdl-1055-XXXXXX")"', "true")))
      .toBe("config-missing");
    expect(candidateContract(candidate.replace("checkedOutHeadSha:env.CHECKED_OUT_HEAD_SHA",
      "checkedOutHeadSha:env.EVENT_HEAD_SHA"))).toBe("head-mismatch");
    expect(candidateContract(candidate.replace('ref: ${{ github.event.pull_request.head.sha }}',
      'ref: main'))).toBe("scope-disallowed");
  });

  it("rejects disabled sandbox, changed runner or allowed reruns", () => {
    expect(candidateContract(candidate.replace("runs-on: ubuntu-22.04", "runs-on: ubuntu-latest")))
      .toBe("scope-disallowed");
    expect(candidateContract(candidate.replace("github.run_attempt == 1", "github.run_attempt >= 1")))
      .toBe("scope-disallowed");
    expect(candidateContract(candidate.replace(
      '          echo "H9_STAGE3_GATE stage=browser; result=starting',
      '          # --no-sandbox\n          echo "H9_STAGE3_GATE stage=browser; result=starting'
    ))).toBe("scope-disallowed");
    expect(scriptText.includes("chromiumSandbox: true")).toBe(true);
    expect(scriptText.includes("ignoreHTTPSErrors: false")).toBe(true);
  });

  it("rejects missing source-pin checks, cleanup, and inconclusive YAML body", () => {
    expect(candidateContract(candidate.replace('git hash-object "$1"', 'echo "$1"')))
      .toBe("source-hash-mismatch");
    expect(candidateContract(candidate.replace("trap cleanup_stage3 EXIT", "true")))
      .toBe("config-missing");
    expect(candidateContract(candidate.replace("\n        run: |\n", "\n        run: ?\n")))
      .toBe("yaml-run-unknown");
  });

  it("pins actual study source blobs, not merely arbitrary 40-character strings", () => {
    for (const [path, source] of Object.entries(pinnedFiles)) {
      const pin = "check_pin tests/evaluation/" + path +
        " " + gitBlobSha(Buffer.from(source, "utf8"));
      expect(bashBody(candidate)).toContain(pin);
    }
  });

  it("requires ZIP streaming hash compatible with Python 3.10", () => {
    expect(archiveCode.includes("digest = hashlib.file_digest(stream")).toBe(false);
    expect(archiveCode).toContain("sha256 = hashlib.sha256()");
    expect(archiveCode).toContain("block = stream.read(CHUNK)");
    expect(archiveCode).toContain("sha256.update(block)");
  });

  it("records a pinned archive observation without treating it as a provider signature", () => {
    expect(candidate).toContain("28d4f185c9047a91fe79ee8d31e5e0b5b858fc107129b3df361fdd095dbb2ace");
    expect(candidate).toContain("https://storage.googleapis.com/chrome-for-testing-public/157.0.8092.0/linux64/chrome-linux64.zip");
    expect(candidate).toContain("H9_STAGE3_GATE stage=browser; result=starting; sandbox=strict; formal_proof=unproved");
  });
});
