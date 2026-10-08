-- #867: Production DDL from #611 §2; no seed/backfill or Adapter activation.
CREATE TABLE business_audit_logs (
  id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, action TEXT NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  before_json TEXT, after_json TEXT, result TEXT NOT NULL CHECK (result = 'committed')
);

CREATE TABLE notification_intents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('reservation_confirmation','classification_change')),
  recipient_student_id TEXT NOT NULL REFERENCES students(id),
  reservation_id TEXT NOT NULL REFERENCES student_reservations(id),
  occurred_at INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  obligation_state TEXT NOT NULL DEFAULT 'valid' CHECK (obligation_state IN ('valid','expired')),
  expired_at INTEGER, expiry_reason TEXT,
  CHECK ((obligation_state = 'valid' AND expired_at IS NULL AND expiry_reason IS NULL) OR
         (obligation_state = 'expired' AND expired_at IS NOT NULL AND expiry_reason IS NOT NULL))
);

CREATE TABLE notification_outbox (
  intent_id TEXT PRIMARY KEY REFERENCES notification_intents(id),
  due_at INTEGER NOT NULL, claim_token TEXT, claim_until INTEGER,
  CHECK ((claim_token IS NULL AND claim_until IS NULL) OR (claim_token IS NOT NULL AND claim_until IS NOT NULL))
);
