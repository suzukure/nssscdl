-- Test-only read indexes from #611 §2–4, after the dependent tables.
CREATE INDEX ix_slots_month_start ON lesson_slots(schedule_month_id, starts_at, id);
CREATE INDEX ix_reservations_student_slot ON student_reservations(student_id, lesson_slot_id);
CREATE INDEX ix_reservations_slot ON student_reservations(lesson_slot_id);
