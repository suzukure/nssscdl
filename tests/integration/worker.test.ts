import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("[bootstrap #638] integration: returns the unavailable response over HTTP", async () => {
  const response = await exports.default.fetch("https://nssscdl.test/");

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("Application is not available.");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("[#831 activation boundary] default Worker cannot reach the Slot View endpoint", async () => {
  const response = await exports.default.fetch("https://nssscdl.test/api/me/schedule-months/2026-11");
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("Application is not available.");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("[#865 activation boundary] default Worker cannot reach Preview or CSRF issuance", async () => {
  for (const [path, method] of [["/api/me/reservations/preview", "POST"], ["/api/auth/student/csrf", "GET"]]) {
    const response = await exports.default.fetch(`https://nssscdl.test${path}`, { method });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Application is not available.");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});

it("[#872 activation boundary] default Worker cannot reach Confirm or its write plan", async () => {
  const response = await exports.default.fetch("https://nssscdl.test/api/me/reservations", {
    method: "POST", body: JSON.stringify({ slotId: "slot", expectedStateToken: "v1.opaque" }),
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("[#894 activation boundary] default Worker cannot serve student UI, assets or read-only history", async () => {
  for (const path of ["/student", "/student/", "/student/student.js", "/student/student.css", "/api/me/reservations"]) {
    const response = await exports.default.fetch(`https://nssscdl.test${path}`);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Application is not available.");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});
