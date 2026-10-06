import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("[bootstrap #638] integration: returns the unavailable response over HTTP", async () => {
  const response = await exports.default.fetch("https://nssscdl.test/");

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("Application is not available.");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
