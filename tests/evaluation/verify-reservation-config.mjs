import { readFileSync } from "node:fs";
import { verifyReservationConfig } from "./reservation-config.ts";

verifyReservationConfig(JSON.parse(readFileSync(new URL("./wrangler.reservation.jsonc", import.meta.url), "utf8")));
