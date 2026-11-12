-- #867: Production DDL from #611 §2; no seed/backfill or Adapter activation.
CREATE TABLE admin_holds (
  occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id)
);

CREATE TABLE group_lessons (
  occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id)
);
