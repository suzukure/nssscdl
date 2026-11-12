-- #841: #636 §8.6(d). Only first revocation may change an issued Session.
CREATE TABLE student_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  role_scope TEXT NOT NULL CHECK (role_scope = 'student'),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(account_id, role_scope) REFERENCES student_accounts(id, role_scope),
  CHECK (expires_at > created_at AND expires_at <= created_at + 2592000),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX ix_student_sessions_account ON student_sessions(account_id);
CREATE INDEX ix_student_sessions_expiry ON student_sessions(expires_at);

CREATE TRIGGER student_session_revocation_is_final
BEFORE UPDATE OF revoked_at ON student_sessions
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT, 'student_session_revocation_is_final');
END;

CREATE TRIGGER student_session_identity_is_immutable
BEFORE UPDATE ON student_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id
  OR NEW.role_scope IS NOT OLD.role_scope OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'student_session_identity_is_immutable');
END;
