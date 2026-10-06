import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./tests/fixtures/d1/migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./tests/fixtures/d1/wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["tests/d1/**/*.test.ts"],
      setupFiles: ["./tests/d1/setup.ts"],
    },
  };
});
