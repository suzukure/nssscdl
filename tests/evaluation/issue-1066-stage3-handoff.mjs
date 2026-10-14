// #1066 Stage3 handoff contract. Pure validation; NO Chrome/process/network.
export const STAGE3_HANDOFF = Object.freeze({
  branch: "investigate/issue-1055-stage3-cft157-ubuntu22-once",
  runner: "ubuntu-22.04",
  version: "157.0.8092.0",
  requiredEnv: Object.freeze(["RUNNER_TEMP", "H9_OWNED_ROOT", "H9_CHROME_EXECUTABLE"]),
  ownerPrefix: "nssscdl-1055-",
  action: "opened",
  attempt: 1,
});
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const nonempty = value => typeof value === "string" && value.length > 0;

/** A structural proxy only: OS lstat/realpath/mode MUST supply true evidence. */
export function classifyStage3Owner({
  runnerTemp, ownedRoot, chromeExecutable, rootCanonical = false,
  rootDirectory = false, rootOwned = false, rootPrivate = false,
} = {}) {
  if (![runnerTemp, ownedRoot, chromeExecutable].every(nonempty))
    return "config-missing";
  if (![runnerTemp, ownedRoot, chromeExecutable].every(p => p.startsWith("/")))
    return "owner-root-invalid";
  if (!rootCanonical || !rootDirectory || !rootOwned || !rootPrivate)
    return "owner-root-invalid";
  const prefix = runnerTemp.replace(/\/+$/, "") + "/" + STAGE3_HANDOFF.ownerPrefix;
  if (!ownedRoot.startsWith(prefix)) return "owner-root-invalid";
  const suffix = ownedRoot.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{6,}$/.test(suffix)) return "owner-root-invalid";
  if (chromeExecutable !== ownedRoot + "/owned-extract/chrome-linux64/chrome")
    return "owner-root-invalid";
  return "owner-admitted";
}

/** Caller-side and workflow-script handshake classification; no host actions. */
export function classifyStage3Handoff({
  action, attempt, draft, headRef, baseSha, approvedBaseSha,
  eventHeadSha, checkedOutHeadSha, sourcePinned, runnerLabel,
  arch, nonroot, strictSandbox, hostMutation, env, ownerEvidence,
} = {}) {
  if (action !== STAGE3_HANDOFF.action || attempt !== STAGE3_HANDOFF.attempt ||
      draft !== true || headRef !== STAGE3_HANDOFF.branch ||
      !sha(baseSha) || !sha(approvedBaseSha) || baseSha !== approvedBaseSha)
    return "scope-disallowed";
  if (!sha(eventHeadSha) || !sha(checkedOutHeadSha) ||
      eventHeadSha !== checkedOutHeadSha) return "head-mismatch";
  if (sourcePinned !== true) return "source-hash-mismatch";
  if (runnerLabel !== STAGE3_HANDOFF.runner || arch !== "x86_64" || nonroot !== true)
    return "os-mismatch";
  if (strictSandbox !== true || hostMutation !== false) return "sandbox-disallowed";
  if (!env || STAGE3_HANDOFF.requiredEnv.some(k => !nonempty(env[k])))
    return "config-missing";
  return classifyStage3Owner({
    runnerTemp: env.RUNNER_TEMP, ownedRoot: env.H9_OWNED_ROOT,
    chromeExecutable: env.H9_CHROME_EXECUTABLE, ...ownerEvidence,
  }) === "owner-admitted" ? "pass" : "owner-root-invalid";
}
