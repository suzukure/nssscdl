// #937: prepared D1 supply only. No Worker, HTTP, Browser, TLS or removal.
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { seedTrustedStudents } from "../fixtures/d1/trusted-student-seed.ts";
import { captureBookingBaseline, verifyBookingReadback } from "./booking-readback.ts";
import { root, validation } from "./trusted-evaluation-seed.mjs";
import { verifyReservationConfig } from "./reservation-config.ts";
import { verifyStudentAssets } from "./verify-student-assets.mjs";
import { migrations } from "./local-https-smoke.mjs";

export const persistence = resolve(root, ".wrangler/student-booking-evaluation");
export const origin = "https://127.0.0.1:8789";
export const proxyOptions = Object.freeze({ configPath: resolve(root, "tests/evaluation/wrangler.reservation.jsonc"),
  remoteBindings: false, persist: Object.freeze({ path: resolve(persistence, "v3") }) });
export const failure = () => new Error("TRUSTED_BOOKING_SEED_FAILED");
const check = (ok) => { if (!ok) throw failure(); };
const exec = promisify(execFile);
const owned = new WeakMap();

export function bookingD1(env) {
  try {
    check(env && typeof env === "object" && !Array.isArray(env) && Object.keys(env).sort().join(",") === "ASSETS,EVALUATION_BOOKING_DB");
    check(env.ASSETS && typeof env.ASSETS.fetch === "function");
    const db = env.EVALUATION_BOOKING_DB;
    check(db && typeof db.prepare === "function" && typeof db.batch === "function" && typeof db.withSession === "function");
    const session = db.withSession("first-primary");
    check(session && typeof session.prepare === "function" && typeof session.batch === "function");
    return db;
  } catch { throw failure(); }
}

export function directoryIdentity(path) {
  try {
    const s = lstatSync(path);
    check(s.isDirectory() && realpathSync(path) === path && s.uid === process.getuid());
    return Object.freeze({ dev: s.dev, ino: s.ino, uid: s.uid });
  } catch { throw failure(); }
}
export function checkDirectoryIdentity(path, expected) {
  const actual = directoryIdentity(path);
  check(expected && ["dev", "ino", "uid"].every((key) => actual[key] === expected[key]));
}
export function checkOwnedTree(path, owner = directoryIdentity(path).uid) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name), stat = lstatSync(child);
    check(stat.uid === owner && !stat.isSymbolicLink());
    if (stat.isDirectory()) { directoryIdentity(child); checkOwnedTree(child, owner); }
    else check(stat.isFile() && stat.nlink === 1);
  }
}
const present = (path) => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw failure(); } };
export function checkBookingResources(oldProfilePresent, readPortOpen, bookingPortOpen) {
  check(oldProfilePresent === false && readPortOpen === false && bookingPortOpen === false);
}

// Finite static preflight is also available to secretless Node fixtures.
export function checkBookingEnvironment(environment, config, entries) {
  try {
    verifyReservationConfig(config);
    const allowed = new Set(["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR", "WRANGLER_SEND_METRICS", "CI", "WRANGLER_LOG_PATH"]);
    check(Object.keys(environment).every((key) => allowed.has(key)) && environment.WRANGLER_SEND_METRICS === "false");
    const temporary = environment.TMPDIR;
    check(typeof temporary === "string" && temporary.length > 0 && environment.HOME === temporary &&
      environment.XDG_CONFIG_HOME === temporary && environment.WRANGLER_LOG_PATH === resolve(temporary, "wrangler.log"));
    check(!entries.some((n) => /^(\.env|\.dev\.vars)(\.|$)/.test(n) && n !== ".env.example"));
  } catch { throw failure(); }
}
async function preflight() {
  check(process.platform === "linux" && /^v24\./.test(process.version));
  checkBookingEnvironment(process.env, JSON.parse(readFileSync(proxyOptions.configPath, "utf8")),
    [root, resolve(root, "tests"), resolve(root, "tests/evaluation")].flatMap((dir) => readdirSync(dir)));
  directoryIdentity(process.env.TMPDIR);
  check((lstatSync(process.env.TMPDIR).mode & 0o077) === 0);
  for (const file of ["package.json", "package-lock.json", "node_modules/wrangler/package.json"]) {
    const pkg = JSON.parse(readFileSync(resolve(root, file), "utf8"));
    check((file === "package.json" ? pkg.devDependencies.wrangler : file === "package-lock.json" ? pkg.packages["node_modules/wrangler"].version : pkg.version) === "4.146.0");
  }
  verifyStudentAssets(root);
  // Neither old resources nor unowned listeners are adopted into this run.
  const ports = [];
  for (const port of [8788, 8789]) ports.push(Boolean((await exec("ss", ["-H", "-ltn", `sport = :${port}`],
    { env: process.env, timeout: 5000, maxBuffer: 65536 })).stdout.trim()));
  checkBookingResources(present(resolve(root, ".wrangler/student-read-only-evaluation")), ...ports);
  migrations();
}
function checkOwned(handle) {
  const record = owned.get(handle);
  check(record);
  checkDirectoryIdentity(resolve(root, ".wrangler"), record.parent);
  checkDirectoryIdentity(persistence, record.identity);
  check(process.env.TMPDIR === record.temporary);
  checkDirectoryIdentity(record.temporary, record.home);
  checkOwnedTree(persistence, record.identity.uid);
  if (present(proxyOptions.persist.path)) directoryIdentity(proxyOptions.persist.path);
  return record;
}

// Test-only D1 factory seam. Actual composition below supplies locked Wrangler.
export async function useBookingSeedProxy(createProxy, consume, confirmOwnership = () => {}) {
  let proxy;
  try {
    check(typeof consume === "function");
    proxy = await createProxy(proxyOptions);
    const db = bookingD1(proxy.env);
    const history = await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
    check(history.success && JSON.stringify(history.results.map((r) => r.name)) === JSON.stringify(migrations()));
    confirmOwnership(); // Immediately before the sole seed write boundary.
    const seed = await seedTrustedStudents(db, validation());
    confirmOwnership();
    const baseline = await captureBookingBaseline(db.withSession("first-primary"), validation());
    const closing = proxy; proxy = undefined;
    await closing.dispose(); // At most once; failed/unknown disposal suppresses handoff.
    await consume(seed, baseline); // Deliberately discard even a secret-bearing result.
  } catch { throw failure(); }
  finally { if (proxy) { try { await proxy.dispose(); } catch { throw failure(); } } }
}

// Caller enters with the same credential-free env shape as the sealed read-only
// helper. Fresh exclusive directory + in-memory capability; no persisted token.
// Failures retain all files and a spent capability, never reset or retry.
export async function prepareTrustedBooking(consume) {
  let handle;
  try {
    check(typeof consume === "function");
    await preflight();
    check(!present(persistence));
    check(readdirSync(process.env.TMPDIR).length === 0); // Fresh profile/home; never adopt read-only state.
    if (!present(resolve(root, ".wrangler"))) mkdirSync(resolve(root, ".wrangler"), { mode: 0o700 });
    const parent = directoryIdentity(resolve(root, ".wrangler"));
    mkdirSync(persistence, { mode: 0o700 });
    handle = Object.freeze({});
    owned.set(handle, { parent, identity: directoryIdentity(persistence), temporary: process.env.TMPDIR,
      home: directoryIdentity(process.env.TMPDIR), ready: false, reading: false });
    await exec(resolve(root, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", "nssscdl-local-booking-evaluation",
      "--config", proxyOptions.configPath, "--local", "--persist-to", persistence],
    { cwd: root, env: process.env, timeout: 60000, maxBuffer: 1024 * 1024 });
    await preflight(); checkOwned(handle);
    const { getPlatformProxy } = await import("wrangler");
    await useBookingSeedProxy(getPlatformProxy, async (seed, baseline) => {
      const record = checkOwned(handle);
      record.baseline = baseline; record.ready = true;
      await consume(seed, handle);
    }, () => checkOwned(handle));
  } catch {
    if (handle) owned.get(handle).ready = false;
    throw failure();
  }
}

// Separate read-only proxy; downstream owner must stop its writer before calling.
// Only the opaque same-run capability opens this DB. Unknown result is terminal.
export async function inspectTrustedBooking(handle, reservationId) {
  let proxy;
  try {
    const record = owned.get(handle);
    check(record);
    check(record.ready && !record.reading);
    record.ready = false; record.reading = true;
    await preflight(); checkOwned(handle);
    const { getPlatformProxy } = await import("wrangler");
    proxy = await getPlatformProxy(proxyOptions);
    await verifyBookingReadback(bookingD1(proxy.env).withSession("first-primary"), validation(), record.baseline, reservationId);
    checkOwned(handle);
    const closing = proxy; proxy = undefined;
    await closing.dispose();
  } catch { throw failure(); }
  finally { if (proxy) { try { await proxy.dispose(); } catch { throw failure(); } } }
}
