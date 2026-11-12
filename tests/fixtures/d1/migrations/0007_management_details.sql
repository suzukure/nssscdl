-- #834 isolated test-only read slice; #611 physical contract §2.1.
-- Type/detail consistency is checked by Integrity Query, not a single DB CHECK.
-- No Production activation or management Command.
CREATE TABLE admin_holds (
  occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id)
);
CREATE TABLE group_lessons (
  occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id)
);
