import { expect, it } from "vitest";
import config from "../../wrangler.jsonc?raw";
import composition from "../fixtures/read-only-student-service.ts?raw";

const sources = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

it("[#899 structural isolation] Product source imports stay inside src; default Worker and config expose no evaluation entry", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  for (const [path, source] of Object.entries(sources)) {
    expect(source).not.toMatch(/read-only-student-service|trusted-student-seed|tests\/|fixtures\//);
    expect(source).not.toMatch(/\b(?:import\s*\(|require\s*\()/);
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const dependency = match[1];
      expect(dependency.startsWith(".")).toBe(true);
      const resolved: string[] = [];
      for (const part of [...path.split("/").slice(0, -1), ...dependency.split("/")]) {
        if (part === ".." && resolved.length && resolved.at(-1) !== "..") resolved.pop();
        else if (part !== ".") resolved.push(part);
      }
      expect(resolved.slice(0, 3)).toEqual(["..", "..", "src"]);
    }
  }
  expect(sources["../../src/index.ts"]).not.toMatch(/\b(?:import|export\s+\*)\b/);
  expect(JSON.parse(config)).toEqual({ name: "nssscdl", main: "src/index.ts", compatibility_date: "2026-10-06" });
  expect(composition).not.toMatch(/export default|seedTrustedStudents\(|generateKey\(|importKey\(|process\.env|Deno\.env/);
  expect(composition).not.toMatch(/reservation-preview|reservation-confirm|web\/|scheduled\s*\(/);
});
