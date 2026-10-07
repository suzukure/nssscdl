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

後続の予約migrationは`command_guards`を再作成せず、詳細設計 §3の定義確認を行う。
`tests/fixtures/d1/migrations/`の番号・test-only schemaは独立であり、Productionの適用履歴へ流用しない。

完了確認は`PRAGMA foreign_key_check`と[`validation/student_auth.sql`](validation/student_auth.sql)の両方が0行であることを必須とする。
後者はread-onlyのIntegrity Queryで、versioned migrationではない。欠落・矛盾をactiveへ自動補完しない。
制約・Index・View・Triggerの確認は`tests/d1/student-auth-migration.test.ts`に含む。
Studentと初期SecurityAccessの同一batch作成、発行前後のGuard、停止・削除時の一括失効は §8.4のCommand責務であり、DDLだけでCommand成功を証明しない。

`npm run d1:local`はtest-only設定の2つの隔離local DBへ適用し、`npm run test:d1`はProduction migration自体を`AUTH_DB`へ適用して検証する。
本変更はProduction binding / route / deploy / Provider flow / auth Adapterを接続しない。
対象環境での検証・activation Gateは詳細設計 §8.6を正とする。
