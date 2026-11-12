# 基本設計

基本設計文書をこのディレクトリに格納する。このフェーズでは、C4 Level 2（Container）を主要なアーキテクチャビューとして使用する。

## 文書一覧

- `01_SystemArchitecture.md` — C4 Level 2のコンテナ構成とデプロイ境界
- `02_DataModel.md` — 概念／論理データモデル、データ所有、Query方針
- `03_ScheduleModel.md` — 月間公開、具体的なレッスン枠日時、枠利用可否モデル
- `04_ReservationModel.md` — 予約履歴、現在の枠占有、キャンセル、再予約モデル
- `05_BookingAndConcurrency.md` — 予約・キャンセル・再分類のTransaction境界と競合設計。`OI-BD-006` で確定済み
- [06a_APICommonPrinciples.md](06a_APICommonPrinciples.md) — API概要設計 — 通常判断・共通原則（§1〜10）。Application API、Command / Query、Identity / Role、認証・Session、Preview / Confirm、Commit再検証、成功Response、Conflict・Error、保存／表示モデルの共通原則。API基本原則は `OI-BD-007`、Actor / Target Scopeは `OI-BD-009`、認証・Sessionは `OI-BD-010` で確定済み
- [06_APIOverview.md](06_APIOverview.md) — API概要設計 — 個別APIの実行・復旧計画（§11〜22）。生徒・管理者向けEndpoint、実行・Transaction・競合・復旧／再送、詳細設計への引継ぎ、関連要求・設計判断記録。一括予約の専用Preview / Confirm API契約（Issue #66）を含む。生徒向けAPI基本形は `OI-BD-008`、管理者向けAPI基本形は `OI-BD-009` で確定済み

通常判断は共通原則の関連節から始め、個別APIの実装・検討では [生徒向け§11](06_APIOverview.md#11-生徒向けapi基本形) または [管理者向け§12〜19](06_APIOverview.md#12-管理者向けschedule-api基本形) の関連個別節と、その節が依存する共通原則・関連正本へ進む。作業に必要な範囲を読み、両文書の常時全文読込みは求めない。

## 基本設計の残件と引継ぎ

`OI-BD-013` / #542でDeployment / Environmentの基本境界を `01_SystemArchitecture.md` §6へ反映した。OI-BDの主要残件はなく、文書整合follow-up #558 / #564 / #561および既知の対応 #599 / #601は解消済みである。基本設計フェーズの最終判定、監査対象main commitおよび判定根拠は #584 を正本とする。判定は最新main・反映PR・Actionsと必要範囲の監査に基づき、Blocking 0件を含む全完了条件を確認して行う。本READMEの同期や個別修正PRのマージだけをもって最終PASS / Closeとはしない。

#535 / #537 / #551の後続責務は各Issueで扱う。#535は価値単位の詳細設計・実装・テスト・評価の進め方を扱う。#537はBrowser provider・exact version × OS・実端末・cost・credential・evidence・fallback、およびPreview / Test、Deploy / migration / recovery runbook、feature exposureの具体方式を扱う。#551は13 ACとCoverage summary、`TC-F-206-03` の表現整理を扱う。

通知・Scheduled Processingの基本形は #540、認証・Sessionの基本形は #539、Backup / Recoveryの基本形は #541 で確定済み。Preview / Test、Deploy / migration / recovery runbookとfeature exposureの具体方式は #537へ引き継ぐ。D1の最終カラム型、補助Index、DDL、具体的Guard SQL等は `02_DataModel.md` および `05_BookingAndConcurrency.md` に従い後続の物理データ設計・詳細設計で確定する。Schedule生成・変更の基本形は `06_APIOverview.md` §12で確定済みであり、`disabled` 理由の保持・表示粒度等の具体表現は詳細設計で確定する。

外部Provider運用の関連未決 #34 は、#540 で固定したScheduled Handlerと #542 の環境隔離境界を維持し、#537で必要な範囲を参照する。

このフェーズで未決の設計事項は上記のGitHub Issueで管理し、基本設計の論点には `OI-BD-xxx` 形式の識別子を用いる。最終決定はIssueをCloseする前に、本ディレクトリの設計文書またはADRへ反映する。
