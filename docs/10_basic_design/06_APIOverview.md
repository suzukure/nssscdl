# 06. API概要設計

## 1. 目的

本書は、Application WorkerがWeb UIへ提供するHTTP APIの基本原則を定義する。

予約・キャンセル・再分類等のTransaction境界は `05_BookingAndConcurrency.md` を正とし、本書ではそれらの業務Use CaseをAPI境界へどのように公開するかを定義する。

本段階は基本設計であり、個別Request / Response Schema、全Endpoint一覧、Correlation ID、Idempotency Key、Cookie属性、CSRF対策の具体方式等は詳細設計で確定する。

本判断は `OI-BD-007` で確定した。

## 2. APIの位置づけ

初期リリースのAPIは、同一Application Workerから配信されるWeb UIが利用する **Application API** とする。

第三者向け汎用API、外部公開SDK、複数VersionのClient互換性維持を初期リリースの目的としない。

初期リリースでは共通名前空間を `/api/...` とし、`/api/v1/...` のようなVersion Namespaceは設けない。将来、独立Frontend、外部Client、第三者連携等によりAPI互換性維持が正式要件となった時点でVersioning導入を再検討する。

この方針は、初期規模と必要機能に対して過剰な複雑化を避ける `POL-001` に従う。

## 3. Query / Command 分離

### 3.1 基本原則

APIは、参照系をQuery、業務状態を変更する操作をCommandとして明確に分離する。

- Queryは業務状態を変更しない。
- Commandは明示された1つの業務Use Caseを実行する。
- DB Entityの汎用CRUDをそのまま公開APIへ露出しない。
- API上のCommand境界は、原則として `05_BookingAndConcurrency.md` で定義した業務Transaction境界と対応させる。

### 3.2 Query

QueryはResource / View Model指向とする。

保存モデルの複数EntityをJoin・導出して、画面に必要な状態へ整形して返してよい。

例:

- 公開Scheduleと予約可否
- 自分の予約履歴
- 現在の標準／追加区分
- 管理者向けSchedule状態
- 通知失敗状態

単純参照では原則 `GET` を使用する。

### 3.3 Command

重要な更新系は、Resourceへの汎用PATCHではなく業務Commandとして表現する。

例:

- 予約確定
- 生徒キャンセル
- スクール都合キャンセル
- Schedule変更確定
- 月間標準回数変更
- 月間回数除外
- Classification Override
- 欠席設定／解除
- Security Suspension設定／解除
- 生徒削除

たとえば予約確定は `StudentReservation` の単純INSERTではなく、`StudentReservation`、`SlotOccupancy`、必要な再分類、`AuditLog`、必要な `NotificationIntent` を1つの業務Commandとして扱う。

したがって、`StudentReservation` と `SlotOccupancy` をClientが個別に作成・更新するAPIは提供しない。

## 4. Identity / Role境界

### 4.1 生徒本人APIのSelf Scope原則

生徒自身を対象とするAPIは `/api/me/...` を基本名前空間とする。

`/api/me/...` 配下のCommand / Queryでは、**対象となる生徒本人をClient入力で指定させず、認証済みSessionからServer側で一意に解決する**ことを共通原則とする。

この原則は予約確定だけでなく、生徒本人のSchedule表示、予約Preview、予約履歴、キャンセル、プロフィール等のSelf Scope操作へ共通に適用する。

具体的には次を守る。

- Self ScopeのRequest Contractに、対象本人を選択するための `student_id` を持たせない。
- 氏名、連絡先メール、Google IDその他の生徒識別情報を、対象本人を決定する正として受け取らない。
- Clientから送られたRole文字列等を、認証済みIdentity / Roleの代替として信用しない。
- Reservation作成時の `StudentReservation.student_id` は、認証済みSessionから解決した内部生徒IDをServer側で設定する。
- Reservation ID等の業務Resource IDをClientが指定するAPIでは、そのResourceが認証済み生徒本人の対象であることをServer側で必ず検証する。
- Clientが他生徒のID等を推測・改変しても、他生徒を対象とする参照・更新へ切り替わらないAPI形状と認可Ruleにする。

これにより `BR-068` および `REQ-003 / AC-003-019, AC-003-020` をAPI境界で実現する。

例:

```text
GET  /api/me/reservations
GET  /api/me/schedule-months/{month}
POST /api/me/reservations/preview
POST /api/me/reservations
POST /api/me/reservations/{reservationId}/cancel
```

上記はAPI形状の基本例であり、全Endpointの最終一覧は後続設計で確定する。個別Endpoint設計では、特別な理由がない限り本節のSelf Scope原則を参照し、`student_id` 非入力方針を重複定義しない。

### 4.2 管理者向けAPI

スクール管理者向け操作は `/api/admin/...` を基本名前空間とする。

管理者が特定生徒・予約・Schedule等を対象とする場合は、認可後に対象Resource IDを明示して操作する。

例:

```text
GET  /api/admin/schedule-months/{month}
POST /api/admin/schedule-months/{month}/changes/preview
POST /api/admin/schedule-months/{month}/changes
POST /api/admin/reservations/{reservationId}/school-cancel
```

Role判定はURLだけに依存せず、認証済みIdentityとAuthorization Ruleで必ず検証する。

同一人物が複数Roleを持つ場合でも、生徒権限と管理者権限を混在させず、操作ごとのRole境界を維持する。

## 5. Preview / Confirm Pattern

### 5.1 適用範囲

すべてのWriteへ機械的にPreviewを要求しない。

要求上、実行前に利用者が影響を理解・確認する必要があるCommandにPreview / Confirm Patternを適用する。

主な対象:

- 予約確定前の日時・新規予約classification・既存未開始Reservationへの区分変更影響確認
- Schedule変更時の既存予約への影響確認
- 月間標準回数変更時の再分類影響確認
- 生徒削除時の将来予約取消等の影響確認
- その他 `POL-013` により重要な影響説明が必要な管理操作

### 5.2 Previewは確定保証ではない

Preview結果は、その時点の状態に基づく確認用情報であり、Lockまたは将来のCommit保証ではない。

Confirm Commandでは、Clientが確認したExpected Stateまたは同等の確認情報を送信できる形とする。

ただしServerはClientのExpected Stateを正本として更新せず、Transaction内で最新確定状態を再読込・再検証する。

PreviewからCommitまでに以下のような重要状態が変化した場合は、原則としてConflictとしてCommandを成立させず再確認へ戻す。

- 対象Slotの予約可否
- 対象Reservationの状態
- standard / additional のclassification
- 新規予約に伴って区分変更される既存未開始Reservationの対象集合または変更前後のclassification
- 月間標準回数または算入状態
- Schedule変更対象集合
- 生徒削除対象となる将来Reservation集合
- その他Previewで明示した主要影響

Expected Stateの具体表現をRevision、Fingerprint、Token等のどの方式にするかは詳細設計で確定する。

### 5.3 PreviewのHTTP Method

Previewは業務状態を変更しないQueryとして扱う。

ただし、複雑な入力Bodyを必要とする場合はHTTP Methodとして `POST` を使用してよい。

したがって、本設計では「POST = Command」とは定義しない。業務状態を変更するかどうかでQuery / Commandを区別する。

### 5.4 予約Previewの区分影響差分

`REQ-003 / AC-003-021` に従い、予約Previewでは新規予約自身のclassificationだけでなく、その予約を追加した場合に区分が変化する既存の未開始Reservationがある場合、その影響差分も返す。

利用者が最終確定前に直接影響を理解できるよう、少なくとも次を画面表示可能なApplication View Modelとして表現する。

- 影響する既存ReservationのLesson日時
- 変更前classification
- 変更後classification

影響がない場合は、区分変更対象がないことを表現できればよく、空集合等の具体Schemaは詳細設計で確定する。

生徒向けPreviewに含める影響Reservationは認証済み生徒本人のReservationに限定し、他生徒のStudent ID、Reservation ID、氏名、メール等を返さない。

Confirm時には、新規予約自身のclassificationだけでなく、Previewで提示した既存Reservationの区分変更対象集合と変更前後も最新確定状態から再計算する。Previewから重要な影響差分が変化している場合は予約を成立させず、Conflictとして最新Previewの再確認へ戻す。

## 6. Commit時再検証とConflict

重要Write Commandは、認証・認可・入力検証だけでなく、Commit時の最新業務状態を再検証する。

競合時は先に正常Commitされた状態を優先し、後続Commandが確定状態を暗黙に上書きしない。

通常の業務競合では原則HTTP `409 Conflict` を使用する。

Conflict Responseは、Clientが次に何をすべきか判断できる安定したApplication Error Codeを持つ。

必要な場合は、再確認に必要な最新状態または最新状態を取得するための情報を安全な範囲で返す。

複数変更の一部だけが競合した場合は、要求・Transaction設計に従い原則として部分適用せず、全体を未適用として再確認へ戻す。

## 7. Command成功Response

Command成功時は、DB更新件数や内部テーブルの変更結果をAPI契約の中心としない。

Clientが直ちに確定状態を表示できるよう、Commit後の業務上の確定結果を返す。

例:

### 予約確定

- 確定Reservation識別子
- Lesson日時
- 確定時点の実効classification
- 同一月でclassificationが変更された既存未開始Reservationの一覧または表示に必要な差分
- 画面更新に必要な現在状態

### 生徒キャンセル

- 対象Reservationの確定キャンセル状態
- 枠の現在状態
- 同一月でclassificationが変更された未開始Reservationの一覧または表示に必要な差分

### Schedule変更

- 適用済み変更結果
- 影響した予約・Slotの確定状態

Responseは内部DB Schemaの変更へ不必要に依存しないApplication View Modelとする。

## 8. HTTP StatusとApplication Error

### 8.1 分離原則

HTTP StatusはAPI通信上の大分類、Application Error Codeは画面・Clientが安定して判断する業務上の理由を表す。

初期の基本対応は以下とする。

| HTTP Status | 基本用途 |
|---|---|
| 400 | Request形式・値が不正で処理できない入力 |
| 401 | 認証されていない |
| 403 | 認証済みだが操作権限がない |
| 404 | 利用者へ存在を示してよい対象Resourceが存在しない |
| 409 | 最新状態との通常の業務競合、先行Commit優先 |
| 503 | 整合性異常等により安全に業務処理できない状態 |

入力Validationの詳細な400/422使い分け、認証Endpoint固有Status等は個別API設計で確定する。

### 8.2 内部エラー非露出

公開API Responseへ次を直接露出しない。

- Database / D1内部エラー
- SQL文字列・SQL Error
- Stack Trace
- 内部Exception Message
- Resend / Google等Providerの生Error
- 内部実装上のTable名・Column名等、利用者対応に不要な技術詳細

利用者向けには安定したApplication Error Codeと安全な説明を返し、技術診断情報はLog / Monitoringへ分離する。

### 8.3 整合性異常

永続化済みInvariant違反等により安全に処理できない場合は、通常Conflictと区別する。

初期基本表現は以下とする。

```text
HTTP 503
Application Error Code: INTEGRITY_STATE_UNAVAILABLE
```

具体Response Schemaは詳細設計で確定する。

## 9. 保存モデルとAPI Modelの分離

APIはD1の保存Entityをそのまま外部契約にしない。

特に次を原則とする。

- `StudentReservation`、`SlotOccupancy`、各Override Entity等を機械的にそのままJSON化しない。
- 生徒向けScheduleは、保存上の占有構造ではなく、生徒が理解すべき予約可否・自分の予約状態・グループレッスン等へ整形する。
- 他生徒のStudent ID、Reservation ID、氏名、メール等、本人の操作に不要な情報を生徒APIへ返さない。
- `classification = NULL` を生徒画面へ機械的に表示せず、キャンセル・欠席・月間回数除外等の業務意味へ変換する。
- `IntegrityIncident` 等の運用監視Entityを通常利用者向け業務状態として公開しない。
- 保存Schema変更が不要にAPI破壊変更へ直結しないようApplication View Modelを介する。

## 10. 認証・Session設計との境界

本書では、APIが認証済みIdentityとRoleをServer側で解決し、その情報を用いて認可するところまでを原則として定義する。

生徒本人を対象とするAPIのIdentity決定Ruleは **4.1 生徒本人APIのSelf Scope原則** を正とし、本節では重複定義しない。

以下は後続の認証・Session基本設計で確定する。

- Session保存方式
- Session Cookie / Token方式
- Cookie属性
- CSRF対策
- Login / Logout Endpoint詳細
- Google OAuth Flow詳細
- Magic Link Flow詳細
- Session失効・更新方式

## 11. 詳細設計へ送る事項

以下は基本原則ではなく詳細設計で確定する。

- 全Endpoint一覧
- Request / Response JSON Schema
- Pagination / Sort / Filter方式
- Expected Stateの具体表現
- Correlation ID
- Command Idempotency Key
- 400 / 422等の詳細Status使い分け
- Application Error Code全一覧
- Validation ErrorのField表現
- HTTP Header方針
- CSRFの具体方式
- Cache-Control等のHTTP Cache Policy
- OpenAPI等の契約記述方法

## 12. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-004 個人情報最小化
- POL-005 通知は即時性、システム画面は確実性
- POL-006 ロール分離と最小権限
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-013 重要な管理操作の説明性と監査可能性
- POL-014 利用者向けエラー情報の安全な抽象化
- BR-055 追加レッスン事前表示
- BR-058 自動再分類
- BR-067 未来Slotの現在予約状態の一貫性
- BR-068 生徒本人予約の所有者同一性
- BR-090 内部生徒ID
- BR-132 監査
- BR-133 利用者向けエラー表現
- REQ-001 初期画面・スケジュール確認
- REQ-002 予約可能枠表示
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-104 標準／追加区分変更通知
- REQ-301 月間スケジュール管理
- REQ-307 月間標準回数設定
- REQ-309 標準／追加再分類
- REQ-311 生徒削除
- REQ-313 スクール都合キャンセル
- REQ-911 競合整合性
- REQ-914 障害・エラー時利用者表示
- REQ-940 監査Logging
- CON-001 Cloudflare基盤
- CON-006 初期規模
- OOS-002 管理者代理予約

## 13. 設計判断記録

- API基本原則とCommand / Query境界は `OI-BD-007` で検討し、本書へ確定結果を反映した。
- Transaction境界とD1実行方式は `05_BookingAndConcurrency.md` を正とする。
- 保存モデルと表示モデルの分離は `02_DataModel.md` の原則をAPI境界にも適用する。
- 要求仕様v1.5で追加された `BR-068` および `AC-003-019, AC-003-020` を受け、生徒本人APIの対象Student決定Ruleを4.1へ共通原則として集約した。
- `REQ-003 / AC-003-021` に従い、予約Previewでは新規予約による既存未開始Reservationのclassification影響差分を最終確定前に表示可能な形で返す。
