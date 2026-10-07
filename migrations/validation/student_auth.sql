-- #636 §8.6: zero rows required, in addition to PRAGMA foreign_key_check.
-- Read-only: do not repair missing access or infer active state.
SELECT 'student_access' AS violation, s.id AS entity_id
FROM students AS s
LEFT JOIN student_security_access AS sa ON sa.student_id = s.id
WHERE sa.student_id IS NULL
   OR s.lifecycle NOT IN ('active','deleted')
   OR (s.lifecycle = 'active' AND s.deleted_at IS NOT NULL)
   OR (s.lifecycle = 'deleted' AND s.deleted_at IS NULL)
   OR sa.access_state NOT IN ('active','suspended')
UNION ALL
SELECT 'account_binding', a.id
FROM student_accounts AS a
LEFT JOIN students AS s ON s.id = a.student_id
WHERE s.id IS NULL OR a.role_scope <> 'student'
UNION ALL
SELECT 'session_binding_or_constraint', se.id
FROM student_sessions AS se
LEFT JOIN student_accounts AS a ON a.id = se.account_id AND a.role_scope = se.role_scope
WHERE a.id IS NULL OR se.role_scope <> 'student'
   OR length(se.token_hash) <> 64 OR se.token_hash GLOB '*[^0-9a-f]*'
   OR se.expires_at <= se.created_at OR se.expires_at > se.created_at + 2592000
   OR (se.revoked_at IS NOT NULL AND se.revoked_at < se.created_at)
UNION ALL
SELECT 'unrevoked_inactive_session', v.session_id
FROM student_session_access_v1 AS v
WHERE v.revoked_at IS NULL AND
      (v.lifecycle <> 'active' OR v.access_state <> 'active');
