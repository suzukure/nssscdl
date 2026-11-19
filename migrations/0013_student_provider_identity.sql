-- #1173: §9.1 contacts, Google binding and registration mode; no seed/backfill.
CREATE TABLE student_contacts (
  student_id TEXT PRIMARY KEY NOT NULL REFERENCES students(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL
);

CREATE TABLE student_google_bindings (
  account_id TEXT NOT NULL REFERENCES student_accounts(id),
  issuer TEXT NOT NULL, subject TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX ix_google_bindings_account ON student_google_bindings(account_id);

CREATE TABLE student_registration_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('open','invitation_only'))
);
