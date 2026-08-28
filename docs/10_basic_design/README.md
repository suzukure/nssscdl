# 基本設計

基本設計文書をこのディレクトリに格納する。このフェーズでは、C4 Level 2（Container）を主要なアーキテクチャビューとして使用する。

## 文書一覧

- `01_SystemArchitecture.md` — C4 Level 2のコンテナ構成とデプロイ境界
- `02_DataModel.md` — 概念／論理データモデル、データ所有、Query方針
- `03_ScheduleModel.md` — 月間公開、具体的なレッスン枠日時、枠利用可否モデル
- `04_ReservationModel.md` — 予約履歴、現在の枠占有、キャンセル、再予約モデル
- `05_BookingAndConcurrency.md` — 予約・キャンセル・再分類のTransaction境界と競合設計。`OI-BD-006` で検討中

## 今後の検討項目

- データモデルの継続検討：残りのEntityおよびD1物理詳細
- 予約整合性／Transaction設計（`OI-BD-006` で検討中）
- API概要
- 認証・Session設計
- Schedule生成・変更設計（利用不可理由、管理者Workflowを含む）
- 通知・Scheduled Job
- Backup / Recovery
- Deployment・Environment設計

このフェーズで未決の設計事項は、`OI-BD-xxx` 形式の識別子を持つGitHub Issueで管理する。最終決定はIssueをCloseする前に、本ディレクトリの設計文書またはADRへ反映する。
