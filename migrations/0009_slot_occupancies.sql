-- #867: Production DDL from #611 §2; no seed/backfill or Adapter activation.
CREATE TABLE slot_occupancies (
  id TEXT PRIMARY KEY, slot_id TEXT NOT NULL UNIQUE REFERENCES lesson_slots(id),
  occupancy_type TEXT NOT NULL CHECK (occupancy_type IN ('student_reservation','admin_hold','group_lesson')),
  reservation_id TEXT UNIQUE, created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY(reservation_id, slot_id) REFERENCES student_reservations(id, lesson_slot_id),
  CHECK ((occupancy_type = 'student_reservation' AND reservation_id IS NOT NULL) OR
         (occupancy_type <> 'student_reservation' AND reservation_id IS NULL))
);
