-- #863 isolated Preview read fixture; #611 §2, no Production activation.
CREATE TABLE student_monthly_lesson_configs (
  student_id TEXT NOT NULL REFERENCES students(id),
  schedule_month_id TEXT NOT NULL REFERENCES schedule_months(id),
  standard_count INTEGER NOT NULL CHECK (standard_count >= 0),
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  PRIMARY KEY(student_id, schedule_month_id)
);
