-- Isolated Slot View fixture: #611 (02_StudentReservationD1.md) §2 DDL.
-- No Production migration, seed data, or Command/Guard implementation.
CREATE TABLE schedule_months (
  id TEXT PRIMARY KEY, month_key TEXT NOT NULL UNIQUE,
  published_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND
         substr(month_key, 6, 2) BETWEEN '01' AND '12')
);
CREATE TABLE lesson_slots (
  id TEXT PRIMARY KEY, schedule_month_id TEXT NOT NULL REFERENCES schedule_months(id),
  lesson_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('enabled','disabled')),
  UNIQUE(schedule_month_id, lesson_date, start_time),
  UNIQUE(id, schedule_month_id), CHECK (starts_at < ends_at)
);
