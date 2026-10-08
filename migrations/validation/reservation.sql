-- #867 / #611 §2–3: read-only, zero rows required. Run alongside
-- PRAGMA foreign_key_check and validation/student_auth.sql; never repair data.
WITH clock AS (SELECT CAST(strftime('%s','now') AS INTEGER) AS t)
SELECT 'schedule_month' AS violation, id AS entity_id
FROM schedule_months
WHERE month_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
   OR substr(month_key, 6, 2) NOT BETWEEN '01' AND '12'
UNION ALL
SELECT 'slot_datetime', s.id
FROM lesson_slots AS s
LEFT JOIN schedule_months AS m ON m.id = s.schedule_month_id
WHERE m.id IS NULL
   OR substr(s.lesson_date, 1, 7) IS NOT m.month_key
   OR strftime('%Y-%m-%dT%H:%M:%S', s.starts_at, 'unixepoch', '+9 hours')
      IS NOT s.lesson_date || 'T' || s.start_time || ':00'
   OR strftime('%Y-%m-%dT%H:%M:%S', s.ends_at, 'unixepoch', '+9 hours')
      IS NOT s.lesson_date || 'T' || s.end_time || ':00'
   OR s.start_time >= s.end_time OR s.starts_at >= s.ends_at
UNION ALL
SELECT 'future_confirmed_occupancy', r.id
FROM student_reservations AS r
JOIN lesson_slots AS s ON s.id = r.lesson_slot_id
CROSS JOIN clock
WHERE r.status = 'confirmed' AND clock.t < s.starts_at
  AND (SELECT COUNT(*) FROM slot_occupancies AS o
       WHERE o.slot_id = r.lesson_slot_id AND o.reservation_id = r.id
         AND o.occupancy_type = 'student_reservation') <> 1
UNION ALL
-- #611 §2.1 detail/reference query, including both details for every type.
SELECT 'occupancy_reference_or_detail', o.id
FROM slot_occupancies AS o
LEFT JOIN student_reservations AS r ON r.id = o.reservation_id
LEFT JOIN admin_holds AS ah ON ah.occupancy_id = o.id
LEFT JOIN group_lessons AS gl ON gl.occupancy_id = o.id
WHERE (o.occupancy_type = 'student_reservation' AND
       (r.id IS NULL OR r.status <> 'confirmed' OR r.lesson_slot_id <> o.slot_id OR
        ah.occupancy_id IS NOT NULL OR gl.occupancy_id IS NOT NULL))
   OR (o.occupancy_type = 'admin_hold' AND
       (o.reservation_id IS NOT NULL OR ah.occupancy_id IS NULL OR gl.occupancy_id IS NOT NULL))
   OR (o.occupancy_type = 'group_lesson' AND
       (o.reservation_id IS NOT NULL OR gl.occupancy_id IS NULL OR ah.occupancy_id IS NOT NULL))
   OR o.occupancy_type NOT IN ('student_reservation','admin_hold','group_lesson')
UNION ALL
SELECT 'reservation_classification_or_absence', r.id
FROM student_reservations AS r
LEFT JOIN reservation_absences AS a ON a.reservation_id = r.id
LEFT JOIN reservation_monthly_count_overrides AS c ON c.reservation_id = r.id
LEFT JOIN reservation_classification_overrides AS co ON co.reservation_id = r.id
JOIN lesson_slots AS s ON s.id = r.lesson_slot_id
CROSS JOIN clock
WHERE r.classification IS NOT CASE
        WHEN r.status <> 'confirmed' OR a.reservation_id IS NOT NULL OR c.reservation_id IS NOT NULL THEN NULL
        ELSE COALESCE(co.classification, r.automatic_classification) END
   OR (a.reservation_id IS NOT NULL AND (r.status <> 'confirmed' OR clock.t < s.ends_at))
   OR r.status NOT IN ('confirmed','student_cancelled','school_cancelled','system_cancelled')
   OR r.automatic_classification NOT IN ('standard','additional')
   OR (r.status = 'confirmed' AND r.cancelled_at IS NOT NULL)
   OR (r.status <> 'confirmed' AND r.cancelled_at IS NULL)
UNION ALL
SELECT 'duplicate_current_occupancy', slot_id
FROM slot_occupancies GROUP BY slot_id HAVING COUNT(*) > 1
UNION ALL
SELECT 'duplicate_reservation_occupancy', reservation_id
FROM slot_occupancies WHERE reservation_id IS NOT NULL
GROUP BY reservation_id HAVING COUNT(*) > 1
UNION ALL
-- Multiple cancelled history rows are valid; multiple future confirmed rows are not.
SELECT 'duplicate_future_confirmed', r.lesson_slot_id
FROM student_reservations AS r JOIN lesson_slots AS s ON s.id = r.lesson_slot_id
CROSS JOIN clock
WHERE r.status = 'confirmed' AND clock.t < s.starts_at
GROUP BY r.lesson_slot_id HAVING COUNT(*) > 1
UNION ALL
SELECT 'intent_recipient', i.id
FROM notification_intents AS i
LEFT JOIN student_reservations AS r ON r.id = i.reservation_id
WHERE r.id IS NULL OR i.recipient_student_id IS NOT r.student_id
UNION ALL
SELECT 'intent_state', i.id
FROM notification_intents AS i
WHERE i.kind NOT IN ('reservation_confirmation','classification_change')
   OR json_valid(i.payload_json) <> 1
   OR i.obligation_state NOT IN ('valid','expired')
   OR (i.obligation_state = 'valid' AND (i.expired_at IS NOT NULL OR i.expiry_reason IS NOT NULL))
   OR (i.obligation_state = 'expired' AND (i.expired_at IS NULL OR i.expiry_reason IS NULL))
UNION ALL
-- §6 rechecks validity at pickup, not an obligation to delete expired work.
-- Absent Outbox after pickup is also valid; do not infer Attempt state here.
SELECT 'outbox_reference_or_claim', o.intent_id
FROM notification_outbox AS o LEFT JOIN notification_intents AS i ON i.id = o.intent_id
WHERE i.id IS NULL OR (o.claim_token IS NULL) <> (o.claim_until IS NULL)
UNION ALL
-- Compare the existing §2 / 0006 definition without CREATE/ALTER or probe writes.
-- Fail closed on missing/changed columns, PK, nullability or CHECK contracts.
SELECT 'command_guards_definition', 'command_guards'
WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'command_guards'
    AND lower(replace(replace(replace(replace(sql, ' ', ''), char(10), ''), char(13), ''), char(9), '')) =
        'createtablecommand_guards(idtextprimarykey,captured_atintegernotnull,expected_read_settextnotnull,okintegernotnullcheck(ok=1))'
);
