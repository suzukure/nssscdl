-- #841: #636 §8.6(b). Missing access is never defaulted to active.
CREATE TABLE student_security_access (
  student_id TEXT PRIMARY KEY NOT NULL REFERENCES students(id),
  access_state TEXT NOT NULL CHECK (access_state IN ('active','suspended')),
  updated_at INTEGER NOT NULL
);
