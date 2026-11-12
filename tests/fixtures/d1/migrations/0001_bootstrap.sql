-- Test-only harness fixture; not a Product schema or Production migration.
CREATE TABLE bootstrap_probe (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL
);
