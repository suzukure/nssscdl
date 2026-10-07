import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { readFile } from "node:fs/promises";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./tests/fixtures/d1/migrations");
  const authMigrations = await readD1Migrations("./migrations");
  const authIntegritySql = await readFile("./migrations/validation/student_auth.sql", "utf8");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./tests/fixtures/d1/wrangler.jsonc" },
        miniflare: { bindings: {
          TEST_MIGRATIONS: migrations,
          AUTH_MIGRATIONS: authMigrations,
          AUTH_INTEGRITY_SQL: authIntegritySql,
        } },
      }),
    ],
    test: {
      include: ["tests/d1/**/*.test.ts"],
      setupFiles: ["./tests/d1/setup.ts"],
    },
  };
});
