-- #841: #636 §8.6(f), shared with future reservation migrations (§2 / §3).
CREATE TABLE command_guards (
  id TEXT PRIMARY KEY, captured_at INTEGER NOT NULL, expected_read_set TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1)
);
