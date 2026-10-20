// #1055 research-only, pure, fixed-enum admission and observer contracts.
// Importing this module does not launch Chrome, fetch resources or change CI.
export const EXPECTED_CFT = "157.0.8092.0";
const BROWSER_VERSION = /^(?:Google Chrome(?: for Testing)?|Chromium|Chrome for Testing) ([0-9]+(?:\.[0-9]+){3})\s*$/;

export function classifyBinary({ regular = false, symlink = false, executable = false, elf = false } = {}) {
  if (symlink || !regular) return "binary-missing";
  if (!elf) return "binary-format";
  if (!executable) return "binary-mode";
  return "binary-ready";
}

// Do not reflect stdout/stderr in reports: both can contain uncontrolled data.
export function classifyVersion({ exitCode = null, stdout = "", failure = false } = {}) {
  if (failure || exitCode !== 0) return "binary-unlaunchable";
  if (typeof stdout !== "string" || stdout.length > 128 || stdout.includes("\0"))
    return "version-output-mismatch";
  const match = BROWSER_VERSION.exec(stdout);
  return match && match[1] === EXPECTED_CFT ? "version-confirmed" : "version-output-mismatch";
}

export function classifySandbox({ linux = false, userns = "unknown", apparmor = "unknown" } = {}) {
  if (!linux) return "unsupported-platform";
  if (userns === "blocked" || apparmor === "blocked") return "sandbox-blocked";
  // Absence of positive evidence does not prove Chrome's strict sandbox works.
  return userns === "allowed" && apparmor === "allowed" ? "sandbox-precheck-pass" : "sandbox-unknown";
}

export function classifyOwnedAssets({ parentTmp = false, childTmp = false, profile = false, complete = false } = {}) {
  return parentTmp && childTmp && profile && complete ? "owner-precheck-pass" : "owner-unknown";
}

export function classifyResponse({ status, authStopped, terminal, hostBody, drain }) {
  if (status !== 401 || authStopped !== true) return "unproved";
  if (!["finished", "failed", "unobserved", "ambiguous"].includes(terminal)) return "unproved";
  if (!["matched", "mismatch", "timeout", "error"].includes(hostBody)) return "unproved";
  if (!["not-applicable", "running", "eof", "absent", "deadline", "limit", "unavailable"].includes(drain)) return "unproved";
  return terminal === "finished" && hostBody === "matched" ? "host-confirmed" : "unproved";
}
