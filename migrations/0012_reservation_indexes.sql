-- #867: #611 §2 indexes, after all referenced tables exist.
CREATE INDEX ix_slots_month_start ON lesson_slots(schedule_month_id, starts_at, id);
CREATE INDEX ix_reservations_student_slot ON student_reservations(student_id, lesson_slot_id);
CREATE INDEX ix_reservations_slot ON student_reservations(lesson_slot_id);
CREATE INDEX ix_audit_retention ON business_audit_logs(occurred_at);
CREATE INDEX ix_outbox_due ON notification_outbox(due_at, intent_id);
CREATE INDEX ix_intents_student ON notification_intents(recipient_student_id, occurred_at);
CREATE UNIQUE INDEX ux_single_confirmation ON notification_intents(reservation_id) WHERE kind = 'reservation_confirmation';
