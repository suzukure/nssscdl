// Supplementary #915 fixtures. No claim of real Chromium / NSS runtime proof.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkTlsFailure, checkTrustListing, cleanupOwned, launchOptions, nssPath, ownedProcesses } from "./browser-tls-trust.mjs";

test("#915 supplied Chromium rule: M145 legacy, M146+ modern; ambiguous versions stop", () => {
  const home = "/fixture-owned-home";
  assert.equal(nssPath(home, "Chromium 145.0.1.2"), join(home, ".pki/nssdb"));
  for (const version of ["Chromium 146.0.1.2", "Chromium 154.0.8037.0", "Google Chrome 154.0.8037.97"]) {
    assert.equal(nssPath(home, version), join(home, ".local/share/pki/nssdb"));
  }
  for (const version of ["", "Chromium unknown", "Chromium 154.0.1.2 extra", "Firefox 146.0.1.2"]) {
    assert.throws(() => nssPath(home, version));
  }
  assert.throws(() => nssPath("relative", "Chromium 154.0.1.2"));
});

test("#915 isolated child env and launch options preserve TLS verification and browser sandbox", () => {
  const options = launchOptions("/fixture-home", "/fixture-browser");
  assert.equal(options.env.HOME, "/fixture-home");
  assert.equal(options.env.XDG_DATA_HOME, "/fixture-home/.local/share");
  assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
  assert.equal(options.ignoreHTTPSErrors, false);
  assert.equal(options.chromiumSandbox, true);
  assert.ok(!options.args.some((arg) => /ignore-certificate|allow-insecure|no-sandbox/.test(arg)));
  assert.equal(options.serviceWorkers, "block");
});

test("#915 /proc proves actual child HOME and refuses a profile with another HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "nssscdl-browser-process-fixture-"));
  const profile = join(home, "profile");
  try {
    for (const actualHome of [home, "/fixture-other-home"]) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`], {
        env: { PATH: process.env.PATH, HOME: actualHome }, stdio: "ignore",
      });
      const stopped = new Promise((done) => child.once("close", done));
      try {
        await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
        if (actualHome === home) {
          assert.ok(ownedProcesses(home, profile).some((entry) => entry.pid === child.pid && entry.main));
        } else assert.throws(() => ownedProcesses(home, profile), /HOME mismatch/);
      } finally { child.kill("SIGTERM"); await stopped; }
      assert.deepEqual(ownedProcesses(home, profile), []);
    }
  } finally { rmSync(home, { recursive: true }); }
});

test("#915 exactly the run-owned server cert with P,, trust; additional or CA trust fails", () => {
  const heading = "Certificate Nickname                                         Trust Attributes\n                                                             SSL,S/MIME,JAR/XPI\n\n";
  checkTrustListing(heading + "nssscdl-run-server                                            P,,\n");
  for (const rows of ["", "other P,,\n", "nssscdl-run-server CT,,\n", "nssscdl-run-server P,,\nother P,,\n"]) {
    assert.throws(() => checkTrustListing(heading + rows));
  }
});

test("#915 negative browser probes require the exact TLS error category, never any navigation failure", () => {
  for (const code of ["ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_COMMON_NAME_INVALID"]) {
    checkTlsFailure(new Error(`page.goto: net::${code} at fixed loopback URL`), code);
    for (const failure of [undefined, new Error("net::ERR_CONNECTION_REFUSED"), new Error("navigation timeout"), new Error(`net::${code}_OTHER`)]) {
      assert.throws(() => checkTlsFailure(failure, code));
    }
  }
});

test("#915 normal and intentional failure cleanup: confirm browser, listener, port before removal", async () => {
  for (const intentionalFailure of [false, true]) {
    const events = [];
    const cleanup = () => cleanupOwned({
      closeBrowser: async () => { events.push("close-browser"); },
      browserStopped: async () => { events.push("confirm-process"); return true; },
      closeServer: async () => { events.push("close-server"); },
      portClosed: async () => { events.push("confirm-port"); return true; },
      remove: async () => { events.push("remove-owned"); },
    });
    const operation = async () => {
      try { if (intentionalFailure) throw new Error("intentional fixed fixture failure"); }
      finally { await cleanup(); }
    };
    if (intentionalFailure) await assert.rejects(operation(), /intentional fixed fixture failure/);
    else await operation();
    assert.deepEqual(events, ["close-browser", "confirm-process", "close-server", "confirm-port", "remove-owned"]);
  }
});

test("#915 unknown close/process/listener/port state preserves all files without retry", async () => {
  for (const failure of ["browser-close", "process", "server-close", "port"]) {
    let removed = 0, browserCloses = 0, serverCloses = 0;
    await assert.rejects(cleanupOwned({
      closeBrowser: async () => { browserCloses++; if (failure === "browser-close") throw new Error("unknown"); },
      browserStopped: async () => failure !== "process",
      closeServer: async () => { serverCloses++; if (failure === "server-close") throw new Error("unknown"); },
      portClosed: async () => failure !== "port",
      remove: async () => { removed++; },
    }));
    assert.equal(removed, 0);
    assert.equal(browserCloses, 1);
    assert.ok(serverCloses <= 1);
  }
});

test("#915 missing opt-in or dependency stops with fixed diagnostics and no secret reflection", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nssscdl-browser-cli-fixture-"));
  try {
    for (const args of [[], ["--run", "unexpected"], ["--run"]]) {
      const outputPath = join(temporary, "diagnostic");
      const fd = openSync(outputPath, "w", 0o600);
      let exitCode;
      try {
        const child = spawn(process.execPath, ["tests/evaluation/browser-tls-trust.mjs", ...args], {
          env: { PATH: process.env.PATH, HOME: temporary, NSSSCDL_CHROMIUM_PATH: "/fixture-private-canary-missing" },
          stdio: ["ignore", fd, fd],
        });
        exitCode = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
      } finally { closeSync(fd); }
      const output = readFileSync(outputPath, "utf8");
      assert.equal(exitCode, 1);
      assert.ok(!output.includes("fixture-private-canary"));
      assert.match(output, args.length === 1 ? /BROWSER_TLS_TRUST_PREFLIGHT_FAILED/ : /Opt-in only/);
    }
  } finally { rmSync(temporary, { recursive: true }); }
});
