-- #867: Production DDL from #611 §2; no seed/backfill or Adapter activation.
CREATE TABLE student_monthly_lesson_configs (
  student_id TEXT NOT NULL REFERENCES students(id), schedule_month_id TEXT NOT NULL REFERENCES schedule_months(id),
  standard_count INTEGER NOT NULL CHECK (standard_count >= 0),
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  PRIMARY KEY(student_id, schedule_month_id)
);

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

CREATE TABLE reservation_absences (
  reservation_id TEXT PRIMARY KEY REFERENCES student_reservations(id),
  recorded_at INTEGER NOT NULL, recorded_by TEXT NOT NULL
);

CREATE TABLE reservation_monthly_count_overrides (
  reservation_id TEXT PRIMARY KEY REFERENCES student_reservations(id),
  override_mode TEXT NOT NULL CHECK (override_mode = 'excluded'),
  changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL
);

CREATE TABLE reservation_classification_overrides (
  reservation_id TEXT PRIMARY KEY REFERENCES student_reservations(id),
  classification TEXT NOT NULL CHECK (classification IN ('standard','additional')),
  changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL
);
