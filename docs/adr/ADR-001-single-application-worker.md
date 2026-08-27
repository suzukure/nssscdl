# ADR-001: 初期リリースでは単一Application Workerを採用する

- 状態: 採用
- 日付: 2026-08-27

## 背景

初期リリースは、小規模な個人レッスン予約サービスを対象とする。プラットフォーム制約はCloudflare Workers + D1 + R2である。基本設計では、Web UI、HTTP API、定期処理を別々のWorkerとしてデプロイするか、単一のデプロイ可能なWorkerへまとめるかを決める必要がある。

これらを複数Workerへ分離すると、デプロイ単位、Binding、Worker間通信、CI/CD経路、運用上の障害モードが増える。要求仕様では、コード上の責務境界を明確に保ちながら、運用負荷を最小化し、不要な複雑性を避けることを優先している。

## 決定

初期リリースでは、アプリケーションの単一デプロイ単位として **1つのApplication Worker** を使用する。

Application Workerには次の入口と処理を含める。

- Web UI / Static Asset配信
- HTTP API
- 認証・Session処理
- 予約・キャンセルUse Case
- Schedule・スクール管理処理
- 通知Orchestration
- Scheduled Job Handler

D1は主要なTransactionデータストアとして維持し、R2は長期Backup Storageとして使用する。Google認証、Resend、Turnstileは外部サービスとして扱う。

Workerは単一のデプロイ単位とするが、内部ソースコードは責務ごとに分離する。このADRではC4 Level 3のComponent境界は定義せず、詳細設計で決定する。

## 判断理由

- `POL-001` に沿い、運用・デプロイの複雑性を最小化できる。
- `POL-002` に沿い、Must要件を弱めずに不要なResource・保守負荷を減らせる。
- `POL-007` に沿い、外部Provider依存を局所化できる。
- Commit済み内部業務状態を正とする `POL-003` や、`POL-008` の競合ルールを変更しない。
- 現在の規模では、Web / API / Batchを独立したデプロイ単位へ分割する合理性が低い。

## 影響

### 利点

- アプリケーションのデプロイ・Rollback対象が1つになる。
- 通常の業務処理でWorker間Network境界が不要になる。
- Binding、Secret、Monitoring、CI/CDを単純化できる。
- Scheduled ProcessingとRequest Driven Processingで同じDomain / Application Logicを共有できる。

### トレードオフ

- 1回のデプロイがWeb、API、Scheduled Handlerへ同時に影響する。
- Request処理とScheduled処理のResource分離を、別Workerによって実現する構成ではない。
- 単一コードベースがモノリシックにならないよう、内部モジュール分割が重要になる。

## 再検討条件

Worker分割は、スケーリング特性、Security / Trust Boundary、デプロイ頻度、障害分離要求、Platform制限などに具体的かつ実運用上の差が生じた場合に再検討する。仮想的な将来需要だけを理由には分割しない。

## 関連要求

- POL-001
- POL-002
- POL-003
- POL-007
- POL-008
- CON-001
