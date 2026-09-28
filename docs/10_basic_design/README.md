# 基本設計

基本設計文書をこのディレクトリに格納する。このフェーズでは、C4 Level 2（Container）を主要なアーキテクチャビューとして使用する。

## 文書一覧

- `01_SystemArchitecture.md` — C4 Level 2のコンテナ構成とデプロイ境界
- `02_DataModel.md` — 概念／論理データモデル、データ所有、Query方針
- `03_ScheduleModel.md` — 月間公開、具体的なレッスン枠日時、枠利用可否モデル
- `04_ReservationModel.md` — 予約履歴、現在の枠占有、キャンセル、再予約モデル
- `05_BookingAndConcurrency.md` — 予約・キャンセル・再分類のTransaction境界と競合設計。`OI-BD-006` で確定済み
- `06_APIOverview.md` — Application APIの基本原則、Command / Query境界、Identity / Role境界、Preview / Confirm、Conflict・Error方針、生徒・管理者向け主要API Flow。一括予約の専用Preview / Confirm API契約（Issue #66）を含む。API基本原則は `OI-BD-007`、生徒向けAPI基本形は `OI-BD-008`、管理者向けAPI基本形は `OI-BD-009` で確定済み

## 今後の検討項目

基本設計全体は以下の残件が完了するまで完了扱いにしない。

- #539 `OI-BD-010` — 認証・Session
- #541 `OI-BD-012` — Backup / Recovery
- #542 `OI-BD-013` — Deployment / Environment

通知・Scheduled Processingの基本形は #540 で確定済み。残りの論理Entityは #539 / #541 / #542 の確定時に必要な範囲を既存の基本設計文書へ反映する。D1の最終カラム型、補助Index、DDL、具体的Guard SQL等は `02_DataModel.md` および `05_BookingAndConcurrency.md` に従い後続の物理データ設計・詳細設計で確定する。Schedule生成・変更の基本形は `06_APIOverview.md` §12で確定済みであり、`disabled` 理由の保持・表示粒度等の具体表現は詳細設計で確定する。

外部Provider運用の関連未決 #34 は、#540 で固定したScheduled Handlerとの境界を維持し、#542 / #537 で必要な範囲を参照する。

このフェーズで未決の設計事項は上記のGitHub Issueで管理し、基本設計の論点には `OI-BD-xxx` 形式の識別子を用いる。最終決定はIssueをCloseする前に、本ディレクトリの設計文書またはADRへ反映する。
