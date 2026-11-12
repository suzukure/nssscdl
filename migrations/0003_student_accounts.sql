-- #841: #636 §8.6(c).
CREATE TABLE student_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT NOT NULL UNIQUE REFERENCES students(id),
  role_scope TEXT NOT NULL CHECK (role_scope = 'student'),
  UNIQUE(id, role_scope)
);

CREATE TRIGGER student_account_binding_is_immutable
BEFORE UPDATE ON student_accounts
WHEN NEW.id IS NOT OLD.id OR NEW.student_id IS NOT OLD.student_id
  OR NEW.role_scope IS NOT OLD.role_scope
BEGIN
  SELECT RAISE(ABORT, 'student_account_binding_is_immutable');
END;
