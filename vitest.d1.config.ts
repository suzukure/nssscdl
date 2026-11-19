import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { readFile } from "node:fs/promises";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./tests/fixtures/d1/migrations");
  const productionMigrations = await readD1Migrations("./migrations");
  // Preserve auth-only and Preview fixture suites' independent histories.
  const authMigrations = productionMigrations.filter((migration) => Number(migration.name.slice(0, 4)) <= 6);
  const reservationMigrations = productionMigrations.filter((migration) => {
    const version = Number(migration.name.slice(0, 4));
    return version > 6 && version <= 12;
  });
  const providerMigrations = productionMigrations.filter((migration) => Number(migration.name.slice(0, 4)) > 12);
  const authIntegritySql = await readFile("./migrations/validation/student_auth.sql", "utf8");
  // This SQL file contains independent statements, with no embedded semicolons.
  const reservationIntegrityScans = (await readFile("./migrations/validation/reservation.sql", "utf8"))
    .split(";").map((scan) => scan.trim()).filter(Boolean);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./tests/fixtures/d1/wrangler.jsonc" },
        miniflare: { bindings: {
          TEST_MIGRATIONS: migrations,
          AUTH_MIGRATIONS: authMigrations,
          AUTH_INTEGRITY_SQL: authIntegritySql,
          RESERVATION_MIGRATIONS: reservationMigrations,
          PROVIDER_MIGRATIONS: providerMigrations,
          RESERVATION_INTEGRITY_SCANS: reservationIntegrityScans,
        } },
      }),
    ],
    test: {
      include: ["tests/d1/**/*.test.ts"],
      setupFiles: ["./tests/d1/setup.ts"],
    },
  };
});
