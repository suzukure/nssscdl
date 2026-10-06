import { expect, it } from "vitest";
import worker from "../../src/index";

it("[bootstrap #638] unit: returns the unavailable response", async () => {
  const response = worker.fetch();

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("Application is not available.");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
