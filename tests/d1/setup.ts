import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.TEST_DB, env.TEST_MIGRATIONS);
