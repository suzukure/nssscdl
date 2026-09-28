# 01. システムアーキテクチャ

## 1. 目的

本書は、初期リリースにおけるC4 Level 2のContainer Architectureを定義する。要求仕様ベースラインを、詳細な内部Componentを定義せずに、デプロイ境界およびRuntime境界へ落とし込む。

## 2. アーキテクチャ判断

初期リリースでは、アプリケーションのデプロイ単位として **単一のApplication Worker** を使用する。

Web UI、HTTP API、認証／Session Endpoint、予約・キャンセル処理、Schedule／管理者機能、通知Orchestration、Scheduled Job Handlerを、同一のCloudflare Workerへまとめてデプロイする。

これはデプロイ境界に関する判断であり、内部ソースコードまで単一責務へまとめることを意味しない。コード上は責務ごとに分離し、Component Levelの構造は詳細設計（C4 Level 3）で定義する。

この判断は `docs/adr/ADR-001-single-application-worker.md` に記録する。

## 3. C4 Level 2 Container

### 3.1 Application Worker

**技術:** Cloudflare Workers

**責務:**

- 生徒・スクール管理者向けWeb Applicationを配信する。
- HTTP Requestを受け付け、検証する。
- 認証・Session Flowを実行する。
- 予約、キャンセル、Schedule、Profile、管理者向けUse Caseを実行する。
- 状態変更前に認可と業務ルールを検証する。
- 外部メール送信要求をOrchestrationし、必要なProvider Callbackを受け取る。
- Scheduled Dispatcherから通知Recovery、Reminder、Cleanup、祝日Master更新、未来Slot Integrity Scanの論理Handlerを実行する。Backup関連処理の設計は #541 で定める。
- D1上の正式な業務状態を読み書きする。

**初期リリースでは独立Containerにしないもの:**

- Frontend Worker
- API Worker
- Authentication Worker
- Batch / Scheduled Job Worker
- Notification Worker

### 3.2 メインデータベース

**技術:** Cloudflare D1

**責務:**

- アプリケーションの正式な業務状態を保存する。
- 生徒、アプリケーションに必要な認証紐付け情報、設計に従ったSession / Token、Schedule / Slot、Reservation、Classification、通知状態、祝日Master、監査情報を保存する。
- 二重予約や無言の状態上書きを防止するために必要な整合性制御を支える。

D1 SchemaおよびTransaction / Concurrency設計は、別の基本設計項目として扱う。

### 3.3 Backup Storage

**技術:** Cloudflare R2

**責務:**

- Backup / Retention要件で必要となる長期Backup Artifactを保持する。
- Production Transaction Storeとは論理的に分離する。

具体的なBackup生成・Restore方式はBackup / Recovery設計で定義する。

## 4. 外部システム

### 4.1 Google認証

Googleを利用した利用者認証を提供する。Google固有のIntegrationはDomain Logicから分離し、Provider依存を局所化する。

### 4.2 Resend

外部メール配信と、必要な配信／失敗Callbackを提供する。メール配信の成功・失敗によって、Commit済みの業務状態を置き換えたりRollbackしたりしない。

### 4.3 Cloudflare Turnstile

Magic Link発行等の公開認証入口に対するBot Abuse Mitigationを提供する。

## 5. 主な連携ルール

1. 生徒・スクール管理者からの操作はApplication Workerを入口とする。
2. Application Workerは、D1の状態を変更する前にIdentity、Authorization、Request State、業務ルールを検証する。
3. 正常CommitされたD1上の業務状態を正とし、外部Providerの結果によって無言で取り消さない。
4. Concurrency Ruleの対象となる操作ではCommit時に最新状態を再検証し、先にCommit済みの競合状態を無言で上書きしない。
5. 外部連携は、Idempotencyと内部状態の正本性を維持できる形で、業務状態遷移の前後または周辺で呼び出す。
6. Scheduled Processingは同一Application Worker内のHandlerで実行し、初期リリースでは独立したデプロイ単位にしない。

### 5.1 Scheduled Dispatcherと論理Handler

初期リリースは単一Application WorkerのScheduled入口にDispatcherを置き、**5分tick**で各論理Handlerのdue workを判定する。物理Cron Triggerと論理Handlerは1対1に固定しない。各Handlerの責務、due判定、実行結果・失敗状態を分離する。Invocationの重複・遅延・欠落を前提に、各Handlerは現在時刻とD1の永続状態からdue workを再評価する。物理Trigger数・Cron式は業務上の正本とせず、将来Triggerを分割しても論理責務は変えない。

| 論理Handler | 責務 | 基本設計上のCadence |
|---|---|---|
| Notification Delivery Recovery | Commit済みIntent / Attemptの未処理・安全にretry可能なdue workを回収する | 5分ごと |
| Reminder Materializer | 対象Reservationの24時間前境界を通過したReminder義務を重複なくIntent化する | 15分ごと |
| Privacy / Retention Cleanup | 確定済みの削除・匿名化義務と期限切れToken、Rate Limit一時データ、Log等を処理する。Backup artifactは #541 の対象 | 要求上の削除・Retention期限を確実に満たす周期。具体周期は詳細設計 |
| Holiday Master Refresh | 内閣府公式情報を検証し、成功時のみD1を更新する | 1日1回 |
| Future Slot Integrity Scan | Command Guardと独立に未来LessonSlotのInvariant違反を検知・集約する | 1時間ごと |

通常通知は業務状態とNotificationIntentのCommit後に即時deliveryをkickし、Recovery Handlerはkick失敗・Worker終了・due retryから回収する。Scheduled起点のIntentと管理者手動retryのAttemptもCommit後に同じdelivery責務へ渡す。HTTP成功ResponseはProvider受付・配送成功を待たない。Provider CallbackはScheduled Jobではなく真正性を確認する外部HTTP event入口として受ける。配送・Reminder・Callbackの状態境界は `05_BookingAndConcurrency.md` §13、管理者API境界は `06_APIOverview.md` §19を正とする。

Holiday Master Refreshは `REQ-321 / CON-004` に従い、設定された公式URLから取得して公式Domain、Parse、日付・名称形式、対象年Coverage、異常重複を検証する。全検証成功時だけD1を一体として更新し、取得・検証失敗時は部分更新せずLast Known Goodを維持する。一時的な外部障害のretryは `REQ-912` の安全条件に従う。

### 5.2 Handlerの安全性と運用観測

各Handlerは重複・並行実行と途中失敗に対してitem単位で冪等・排他・再開可能とし、D1の状態を信用できない場合は外部送信をfail-closedする。少なくともlast started、last successful completion、現在・連続失敗、due backlogまたはoldest due age、処理・失敗件数を診断可能にする。

Reminder停止、広範な通知配送停止・backlog、Mail Platform障害、Cleanupの個人情報削除期限違反のおそれ、祝日更新の継続失敗を保守側で検知する。個別通知の最終失敗は原則 `REQ-105 / REQ-314` の管理者対応とし、同一の広範原因によるAlertは `BR-110` に従って集約する。祝日更新の単発失敗ではLast Known Goodを維持する。Integrity Scan停止・Incidentは `05_BookingAndConcurrency.md` §14の集約・Fail Closed方針に従う。具体metric、閾値、severityは詳細・運用設計で定める。

Scheduled Handlerの正しさをProvider Quota pollingや変動するQuota値に依存させず、Quota確認だけの高頻度Jobは設けない。通常送信Responseから得られる情報をTelemetryに利用する余地は残す。Quota超過等を機械的にTransient Errorと扱わない。Quota / Billing等の未決は #34、Cron式と環境別bindingは #542 で扱う。

## 6. デプロイ境界・障害境界

Application Workerは1つのデプロイ・Rollback単位である。このため、1回のWorkerデプロイがWeb Request、API Request、Scheduled Handlerへ同時に影響する可能性がある。

D1、R2、Google認証、Resend、Turnstileはそれぞれ別のPlatform / Service境界であり、独立して障害が発生し得る。障害時の扱いは、内部業務状態の正本性、外部Retry、通知失敗、可用性／Recoveryに関する要求に従う。

## 7. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-002 無料枠優先・Must要件優先
- POL-003 業務状態と外部連携の分離
- POL-007 外部Provider依存の局所化
- POL-008 競合時の確定状態優先
- REQ-102 24時間Reminder
- REQ-105 通知失敗管理
- REQ-321 祝日マスタ更新
- REQ-912 外部API Retry
- REQ-913 無料枠運用
- REQ-942 監視・重大Incident
- REQ-951 Provider分離
- CON-001 Cloudflare Platform
- CON-002 Email Provider
- CON-004 祝日Source
- CON-003 認証
- CON-009 Backup方式非依存

## 8. 図

PlantUML Source: `docs/diagrams/plantuml/c4-container.puml`

生成SVG: `docs/diagrams/rendered/c4-container.svg`（自動生成）
