# テスト計画

## 1. 文書情報

| 項目 | 内容 |
|---|---|
| 対象システム | Net Shogi School レッスン予約システム |
| 要求ベースライン | `docs/00_requirements/` v1.19 |
| ベースライン確認日 | 2026-09-05 |
| Git基準 | `main` commit `a3f7502fbcba7da89b4fb9caa175b7888ae78be1` 時点の要求仕様 |
| 参照標準 | ISO/IEC/IEEE 29119-3:2021（Test documentation） |
| テストレベル | System Test / Acceptance Test を中心とし、必要に応じIntegration / Operational Testを含む |
| テスト方式 | Requirements-based, risk-based, black-box |

## 2. 目的

要求仕様の各Acceptance Criteria (AC) が検証可能なテスト条件へ変換され、初期リリースのMust要件が以下の観点で満たされることを確認する。

- 業務機能の正しさ
- 時刻境界・状態遷移の正しさ
- 予約、キャンセル、スケジュール変更の競合整合性
- 生徒本人予約の所有者同一性とクライアント入力による予約者差し替え防止
- 新規予約確定前に、既存の未開始Reservationへ生じる標準／追加区分の直接影響を説明できること
- 複数Schedule変更が競合で全体未適用となる場合に、検出できた競合対象・業務上の理由・再確認に必要な最新状態を管理者へ説明できること
- 標準／追加分類の非遡及性と再計算
- 認証・権限・個人情報保護
- 通知失敗と業務状態の分離
- 可用性、性能、RPO/RTO、Backup、監査等の非機能要求
- 対象外機能が意図せず製品要件へ混入していないこと

## 3. テスト対象

### 3.1 対象

- 生徒向けSchedule閲覧、予約、一括予約、キャンセル、履歴、Profile
- Email / System内通知
- Google / Magic Link認証、Session、登録、Invitation、Security Suspension
- 管理者向けSchedule管理、休業、管理者確保、分類、削除、欠席、通知失敗管理
- 祝日Master更新
- Browser / Responsive / Accessibility
- Performance / Availability / RTO / RPO / Backup
- Concurrency / Retry / Error abstraction / Audit / Monitoring / Privacy
- Provider分離、Backup Privacy

### 3.2 対象外

`docs/00_requirements/06_Constraints.md` の OOS-001〜009 は正機能としてテストしない。ただし、対象外機能が誤って提供されていないことを確認する **Scope Guard** を実施する。

## 4. リスクベース優先度

| 優先度 | 意味 | 主な対象 |
|---|---|---|
| P0 | 失敗時に予約整合性、認証、PII、復旧性へ重大影響 | 予約競合、予約所有者同一性、予約時区分影響、Schedule一括変更競合、キャンセル境界、未来枠整合性、分類、認証、削除、RPO/Backup |
| P1 | 主要業務の利用不能・誤通知・管理事故につながる | Schedule変更、通知、Suspension、監査、Error表示、Performance |
| P2 | 補助的品質・運用性 | 表示差異、補助指標、文言、Provider交換性等 |

## 5. テスト設計技法

- 同値分割
- 境界値分析
- Decision Table
- 状態遷移テスト
- Use-case / Scenario test
- Pairwise / Browser matrix
- Concurrency / Race test
- Fault injection
- Performance percentile measurement
- Restore / Recovery exercise
- Static review / Configuration inspection

## 6. 標準テストデータ

### 6.1 Actor

| ID | 内容 |
|---|---|
| `A1` | スクール管理者 |
| `S1` | Active生徒、標準回数 N=3 |
| `S2` | Active生徒、競合用 |
| `S3` | Security Suspension対象 |
| `S4` | 削除・再登録対象 |
| `U1` | 未登録メール利用者 |

### 6.2 Schedule / 時刻

すべて Asia/Tokyo とし、期限判定はServer Commit時刻で制御する。

- `D-WD`: 火〜金の通常平日
- `D-WE`: 土日
- `D-HOL`: 月曜以外の祝日
- `D-MON`: 通常月曜
- `D-MON-HOL`: 月曜祝日
- `Tstart`: Lesson開始時刻
- `Tend`: Lesson終了時刻
- 境界値: `Tstart-1ms`, `Tstart`, `Tend`, `Tend+1ms`
- Session境界: 7日、12時間Idle、30日
- Token境界: 15分、72時間
- Reminder境界: 開始24時間前

### 6.3 標準／追加分類

同一生徒・同一暦月で予定日時順 `R1 < R2 < R3 < R4 < R5` を用意する。

- 初期 `N=3`
- 自動分類基本形: `R1..R3=standard`, `R4..R5=additional`
- 開始済みstandard数 `C` を変化させ、`max(N-C, 0)` を検証する
- ClassificationOverride有無、月間算入除外有無を組み合わせる
- 予約Preview試験では、既存未開始Reservation `R2 < R3 < R4` がstandardの状態に、より早い `R1` を新規予約して既存 `R4` がstandard→additionalとなる直接影響を再現する

### 6.4 外部依存

テスト環境では以下を制御可能にする。

- Email Provider: accepted / transient error / permanent error / final delivery failure
- Google Auth: success / provider unavailable / invalid response
- Holiday Source: valid / invalid domain / parse error / coverage不足 / duplicate
- Clock: Server Commit時刻を再現可能
- Concurrency: 2つ以上のCommandを同一業務対象へ競合投入可能
- Backup: Restore専用環境へ復旧可能

## 7. テスト環境

Production相当構成を基本とする。外部Providerの破壊的Fault Injectionや時刻境界試験は、Provider Stubまたは隔離環境で行う。

Browser Matrixは要求の「現行Major＋1つ前」を実行時点で確定し、実行記録へVersionを固定する。

## 8. Entry Criteria

- 対象BuildがTest環境へDeploy済み
- 対応する要求・設計変更がCommit済み
- Migration適用済み
- 標準テストデータ投入可能
- Server Clock、Provider Stub、Concurrency Harness等、該当試験に必要な制御点が利用可能
- P0テストについて観測すべきAudit / Log / Business Stateの確認手段がある

## 9. Exit Criteria

- 全REQに1件以上のテストケースが存在する
- 全ACが `04_RequirementsTestTraceability.md` および要求変更追補Traceabilityで1件以上のTCへ対応する
- P0: 100% Pass
- P1: 原則100% Pass。未解決はRelease判断で明示承認
- Critical / Major defectが未解決で残らない
- REQ-911の競合整合性、REQ-909/910の復旧性、REQ-934のPII削除について証跡を保存する
- 実行対象Browser MatrixでMust業務が完了する

## 10. Defect Severity

| Severity | 定義例 |
|---|---|
| Critical | 二重予約、予約所有者が他の実在生徒へ誤紐付けされ利用者境界・権限・PIIに重大影響を与える、他人予約の露出、認証回避、PII重大漏えい、復旧不能 |
| Major | Critical条件に至らない予約所有者不整合（存在しない生徒への紐付け等）、主要業務が実行不能、誤った取消・分類、期限判定誤り、通知失敗で業務状態がRollback |
| Minor | 代替手段がある表示・文言・局所的UI不具合 |

## 11. 証跡

テスト結果には最低限、TC ID、Build/Commit、実行日時、環境、Actor/Test Data、結果、必要なScreenshot/Response/Audit evidence、Defect IDを残す。

PIIを証跡へ不要に複製しない。テスト用の架空データを優先する。

## 12. 自動化方針

- P0/P1の決定論的なAPI/Domain挙動は自動化を優先する。
- Browser E2EはMust業務のHappy pathと主要Boundary/Conflictへ限定し、下位レベルの自動テストと重複させすぎない。
- Performance、Concurrency、Restoreは専用Harnessを用いる。
- WCAG、文言、管理者への説明性は自動検査と人手Reviewを併用する。
- 自動テスト名またはmetadataへTC IDを埋め込み、要求テスト仕様と実装テストを追跡可能にする。

## 13. 設計進行に伴う詳細化ポイント

以下は製品要求の未決事項ではなく、テスト実装上の詳細化項目である。

- UI selector / API path / HTTP status / Application Error codeの具体値
- Test fixture生成API
- Clock injection方式
- Provider Stub / Fault injection方式
- Concurrency同期Barrier
- RPO/RTO測定・Restore手順の自動化範囲

これらが確定しても、本仕様のAC・期待業務結果は変更しない。
