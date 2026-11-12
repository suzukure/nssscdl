-- #841: #636 §8.1 / §8.6(a). Production schema; no seed/backfill.
CREATE TABLE students (
  id TEXT PRIMARY KEY NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','deleted')),
  deleted_at INTEGER,
  CHECK ((lifecycle = 'active' AND deleted_at IS NULL) OR
         (lifecycle = 'deleted' AND deleted_at IS NOT NULL))
);

CREATE TRIGGER student_deletion_is_final
BEFORE UPDATE OF lifecycle ON students
WHEN OLD.lifecycle = 'deleted' AND NEW.lifecycle <> 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'student_deletion_is_final');
END;
