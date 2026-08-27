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
- Reminder、Cleanup、祝日Master更新、Backup関連処理等のScheduled Handlerを実行する。
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

## 6. デプロイ境界・障害境界

Application Workerは1つのデプロイ・Rollback単位である。このため、1回のWorkerデプロイがWeb Request、API Request、Scheduled Handlerへ同時に影響する可能性がある。

D1、R2、Google認証、Resend、Turnstileはそれぞれ別のPlatform / Service境界であり、独立して障害が発生し得る。障害時の扱いは、内部業務状態の正本性、外部Retry、通知失敗、可用性／Recoveryに関する要求に従う。

## 7. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-002 無料枠優先・Must要件優先
- POL-003 業務状態と外部連携の分離
- POL-007 外部Provider依存の局所化
- POL-008 競合時の確定状態優先
- CON-001 Cloudflare Platform
- CON-002 Email Provider
- CON-003 認証
- CON-009 Backup方式非依存

## 8. 図

PlantUML Source: `docs/diagrams/plantuml/c4-container.puml`

生成SVG: `docs/diagrams/rendered/c4-container.svg`（自動生成）
