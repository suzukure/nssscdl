-- Test-only read slice; preserves #611 §2 Reservation constraints.
CREATE TABLE student_reservations (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
  lesson_slot_id TEXT NOT NULL REFERENCES lesson_slots(id),
  status TEXT NOT NULL CHECK (status IN ('confirmed','student_cancelled','school_cancelled','system_cancelled')),
  automatic_classification TEXT NOT NULL CHECK (automatic_classification IN ('standard','additional')),
  classification TEXT CHECK (classification IN ('standard','additional')),
  created_at INTEGER NOT NULL, cancelled_at INTEGER, updated_at INTEGER NOT NULL,
  UNIQUE(id, lesson_slot_id),
  CHECK ((status = 'confirmed' AND cancelled_at IS NULL) OR
         (status <> 'confirmed' AND cancelled_at IS NOT NULL))
);
