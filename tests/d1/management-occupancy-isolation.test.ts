import { it } from "vitest";
import { seedManagementOccupancyFixture } from "./management-occupancy-fixture";

it("[#834 D1 fixture] starts empty and accepts identical occupancy / detail IDs in another file", async () => {
  await seedManagementOccupancyFixture("management-isolation-file");
});
