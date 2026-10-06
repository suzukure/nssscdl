-- #830 test-only read integrity support; existing #611 §2 DDL unchanged.
-- Not Production migration, auth, or a write/management Command.
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
