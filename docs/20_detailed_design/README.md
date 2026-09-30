# 詳細設計

詳細設計文書をこのディレクトリに格納する。このフェーズでは、必要に応じてC4 Level 3（Component）を使用し、あわせてAPI、データベース、Job、Sequence等の詳細を定義する。

基本設計の完了後、選定した業務シナリオの実装に必要な範囲を着手前に詳細設計として確定する。既存の基本設計、C4 Level 3、API / DB / Job / Sequenceの該当箇所を照合し、確定済みの業務境界と期待結果に整合させる。全機能の詳細設計完了を各実装の着手条件とはしない。コード内部の細部は実装・テストで得た知見により調整し、確定設計と同期する。上位仕様の変更や未決事項を詳細設計・コードだけで決めない。

価値単位の選択と実施Issueの進行は[AI開発・ClaudeレビューのGitHub運用](../30_operations/ai-development-workflow.md#基本設計後の価値単位の開発)を正本とする。

## 文書一覧

- [01_StudentReservationApplication.md](01_StudentReservationApplication.md) — 単一予約のApplication Component、生徒向け4 APIのwire / View Model / Error、画面Flow。C4 Level 3とSequenceの正本は `../diagrams/plantuml/c4-student-reservation-components.puml` および `../diagrams/plantuml/student-reservation-sequence.puml`。
- [02_StudentReservationD1.md](02_StudentReservationD1.md) — 同じ価値単位のD1 Table / Index、Migration順序、read set、Confirm Transaction Guardと通知pickup境界。物理ERの正本は `../diagrams/plantuml/student-reservation-d1-er.puml`。
