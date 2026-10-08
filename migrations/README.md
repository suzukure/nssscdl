# Database migrations

Production D1 schemaの正本は番号順に一度だけ適用するversioned migrationとする。適用済みファイルを変更しない。

#841は[Student認証D1物理設計](../docs/20_detailed_design/02_StudentReservationD1.md) §8.1 / §8.6の基盤を追加する。

| Version | 内容 |
| --- | --- |
| `0001_students.sql` | Student FK接続点・lifecycle・削除後非復活 |
| `0002_student_security_access.sql` | lifecycleと独立した利用可否 |
| `0003_student_accounts.sql` | Student専用Principal・固定binding |
| `0004_student_sessions.sql` | hash・期限・失効制約、Index、不変属性・失効後非復活Trigger |
| `0005_student_session_access.sql` | 共有参照面 `student_session_access_v1` |
| `0006_command_guards.sql` | 認証・予約共通のCHECK assert Table |
| `0007_schedule.sql` | 公開月・LessonSlot |
| `0008_reservations.sql` | 生徒月間設定・Reservation・3例外Table |
| `0009_slot_occupancies.sql` | 現在占有・Reservation/Slot複合FK |
| `0010_management_details.sql` | AdminHold / GroupLessonの1対1詳細参照 |
| `0011_audit_notifications.sql` | 成功Audit・Intent・初回配送Outbox |
| `0012_reservation_indexes.sql` | 予約系Index・予約確認Intentのpartial UNIQUE |

#867は詳細設計 §2〜3のProduction予約DDLを追加し、`command_guards`を再作成・再定義せず再利用する。
`tests/fixtures/d1/migrations/`の番号・test-only schemaは独立であり、Productionの適用履歴へ流用しない。

完了確認は`PRAGMA foreign_key_check`と[`validation/student_auth.sql`](validation/student_auth.sql)の両方が0行であることを必須とする。
後者はread-onlyのIntegrity Queryで、versioned migrationではない。欠落・矛盾をactiveへ自動補完しない。
制約・Index・View・Triggerの確認は`tests/d1/student-auth-migration.test.ts`に含む。
予約migrationの完了確認には[`validation/reservation.sql`](validation/reservation.sql)も0行であることを必須とする。
月・日本時間日時、未来confirmedと現在占有、詳細参照、分類・欠席・例外、Intent宛先・義務状態・Outbox claim整合、
共有Guard定義をread-onlyで検査する。正常な取消履歴やpickup後のOutbox欠損を異常にしない。
失効Intentの残存Outboxから削除義務を推測せず、pickup時の通知義務Guardは詳細設計 §6に従う。
`tests/d1/reservation-migration.test.ts`は既存認証Schemaを保持してProduction `0007`〜`0012`を一度だけ順次適用し、
FK / CHECK / UNIQUE / Index / JSONと検出後の非修復を検証する。DB/migration **partial evidence**であり、
Confirm Command・実D1・System / Acceptance TC全体のPassを証明しない。
Studentと初期SecurityAccessの同一batch作成、発行前後のGuard、停止・削除時の一括失効は §8.4のCommand責務であり、DDLだけでCommand成功を証明しない。

`npm run d1:local`はtest-only設定の2つの隔離local DBへ適用する。
`npm run test:d1`の共通setupはProduction認証 `0001`〜`0006`を`AUTH_DB`へ適用し、
予約migration testだけが同じfile-isolated DBへProduction予約 `0007`〜`0012`を追加適用する。
既存Preview testの予約fixture適用履歴は維持する。
本変更はProduction binding / route / deploy / Provider flow / auth Adapterを接続しない。
対象環境での検証・activation Gateは詳細設計 §8.6を正とする。
