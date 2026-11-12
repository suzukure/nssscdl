-- #841: #636 §8.6(e). Preserve missing parents/access for fail-closed lookup.
CREATE VIEW student_session_access_v1 AS
SELECT se.id AS session_id, se.token_hash, se.account_id, se.role_scope,
       se.created_at, se.expires_at, se.revoked_at,
       a.student_id, s.lifecycle, s.deleted_at, sa.access_state
FROM student_sessions AS se
LEFT JOIN student_accounts AS a ON a.id = se.account_id AND a.role_scope = se.role_scope
LEFT JOIN students AS s ON s.id = a.student_id
LEFT JOIN student_security_access AS sa ON sa.student_id = s.id;
