import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("[bootstrap #638] D1: applies the fixture migration and reads a written value", async () => {
  const initial = await env.TEST_DB.prepare("SELECT id, value FROM bootstrap_probe").all();
  expect(initial.results).toEqual([]);

  const inserted = await env.TEST_DB.prepare(
    "INSERT INTO bootstrap_probe (id, value) VALUES (?, ?)",
  ).bind(1, "migration smoke").run();
  expect(inserted.success).toBe(true);

  const row = await env.TEST_DB.prepare(
    "SELECT id, value FROM bootstrap_probe WHERE id = ?",
  ).bind(1).first();
  expect(row).toEqual({ id: 1, value: "migration smoke" });
});
