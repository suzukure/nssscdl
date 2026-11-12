import { it } from "vitest";
import { seedSlotViewFixture } from "./slot-view-fixture";

it("[#829 D1 fixture] starts empty and accepts the same IDs in another test file", async () => {
  await seedSlotViewFixture("isolation-file");
});
