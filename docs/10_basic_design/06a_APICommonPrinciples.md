# 06a. API概要設計 — 通常判断・共通原則

本書は§1〜10のAPI共通原則の正本とする。個別APIの実行・Transaction・競合・復旧／再送、詳細設計への引継ぎ、関連要求・設計判断記録は [06_APIOverview.md](06_APIOverview.md) §11〜22を正とする。

通常判断は本書の関連共通節を入口とし、個別APIを実装するときは [基本設計README](README.md#文書一覧) から関連個別節へ進み、その節が依存する共通原則・関連正本も読む。作業に必要な節を辿り、毎回両文書の全文を読むことは求めない。

## 1. 目的

本書は、Application WorkerがWeb UIへ提供するHTTP APIの基本原則を定義する。

予約・キャンセル・再分類等のTransaction境界は `05_BookingAndConcurrency.md` を正とし、本書ではそれらの業務Use CaseをAPI境界へどのように公開するかを定義する。

本段階は基本設計であり、個別Request / Response Schema、全Endpoint一覧、Correlation ID、Idempotency Key、Cookie属性、CSRF対策の具体方式等は詳細設計で確定する。

API基本原則は `OI-BD-007`、生徒向けAPI基本形は `OI-BD-008`、管理者向けAPI基本形は `OI-BD-009` で確定した。

## 2. APIの位置づけ

初期リリースのAPIは、同一Application Workerから配信されるWeb UIが利用する **Application API** とする。

第三者向け汎用API、外部公開SDK、複数VersionのClient互換性維持を初期リリースの目的としない。

初期リリースでは共通名前空間を `/api/...` とし、`/api/v1/...` のようなVersion Namespaceは設けない。将来、独立Frontend、外部Client、第三者連携等によりAPI互換性維持が正式要件となった時点でVersioning導入を再検討する。

Backup生成、D1 Time Travel / Restore、Recovery D1 import、Production deploy / rollback、D1 migration、Infrastructure / Secret変更、Recovery cutoverは保守担当者のInfrastructure操作とし、通常のStudent / Admin Application Roleから実行できる公開業務APIに追加しない。Backup用R2権限とD1 export管理credentialを公開Application Workerの通常Request pathへ持たせない。境界は `01_SystemArchitecture.md` §3.3 / §5.3 / §6を正とする。

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
- プロフィール代理変更

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
POST /api/me/reservations/bulk/preview
POST /api/me/reservations/bulk
POST /api/me/reservations/{reservationId}/cancel
```

上記はAPI形状の基本例であり、Request / Responseの厳密なSchemaは詳細設計で確定する。個別Endpoint設計では、特別な理由がない限り本節のSelf Scope原則を参照し、`student_id` 非入力方針を重複定義しない。

### 4.2 管理者向けAPIのActor / Target Scope原則

スクール管理者向け操作は `/api/admin/...` を基本名前空間とする。

管理者APIでは、**操作主体（Actor）と業務上の操作対象（Target）を明確に分離する**。

- Actorとなる管理者IdentityおよびRoleは、Client入力の管理者IDやRole文字列から決定せず、認証済みSessionからServer側で解決する。
- Clientは、認可された管理操作に必要なStudent、Reservation、ScheduleMonth、LessonSlot等のTarget Resource IDを明示してよい。
- Targetが生徒である場合は内部生徒IDを主たる識別子とし、氏名・メール・Google ID等を更新対象決定の正本識別子として扱わない。
- ServerはTarget Resourceの存在、現在状態、および当該Admin操作でTargetに対して許可された操作かを必ず検証する。
- 重要な管理CommandのAuditLogでは、ActorはSessionから解決した管理者、TargetはRequestで指定された業務Resourceとして区別して追跡できる形とする。
- 同一人物が複数Roleを持つ場合でも、`/api/admin/...` の操作はAdmin権限として認可・監査し、生徒権限と混在させない。
- 管理者がStudent IDをTargetとして指定できることは、管理者代理予約を許可することを意味しない。`OOS-002` に従い、生徒本人の新規予約を管理者が代理実行するAPIは初期リリースでは提供しない。

例:

```text
GET  /api/admin/schedule-months/{month}
POST /api/admin/schedule-months/{month}/generate
POST /api/admin/schedule-months/{month}/changes/preview
POST /api/admin/schedule-months/{month}/changes
POST /api/admin/schedule-months/{month}/publish
POST /api/admin/reservations/{reservationId}/school-cancel/preview
POST /api/admin/reservations/{reservationId}/school-cancel
POST /api/admin/reservations/{reservationId}/absence/preview
POST /api/admin/reservations/{reservationId}/absence
POST /api/admin/reservations/{reservationId}/absence/clear/preview
POST /api/admin/reservations/{reservationId}/absence/clear
POST /api/admin/students/{studentId}/security-suspension
POST /api/admin/students/{studentId}/security-suspension/clear
POST /api/admin/students/{studentId}/deletion/preview
POST /api/admin/students/{studentId}/deletion
GET  /api/admin/students/{studentId}/profile
POST /api/admin/students/{studentId}/name-change
POST /api/admin/students/{studentId}/contact-email-change
GET  /api/admin/notification-failures/summary
GET  /api/admin/notification-failures
GET  /api/admin/notification-failures/{notificationId}
POST /api/admin/notification-failures/{notificationId}/retry
```

Role判定はURLだけに依存せず、認証済みIdentityとAuthorization Ruleで必ず検証する。

## 5. Preview / Confirm Pattern

### 5.1 適用範囲

すべてのWriteへ機械的にPreviewを要求しない。

要求上、実行前に利用者が影響を理解・確認する必要があるCommandにPreview / Confirm Patternを適用する。

主な対象:

- 予約確定前の日時・新規予約classification・既存未開始Reservationへの区分変更影響確認
- Schedule変更時の既存予約への影響確認
- 月間標準回数変更時の再分類影響確認
- 月間回数除外の設定・解除時の再分類影響確認
- スクール都合キャンセル時の取消内容・取消後Slot・再分類影響・事後登録確認
- 欠席設定・解除時の月間算入状態・再分類影響確認
- 生徒削除時の将来予約取消等の影響確認
- その他 `POL-013` により重要な影響説明が必要な管理操作

Security Suspensionの設定・解除は、実行前説明を必須とする重要管理操作だが、動的な予約集合・再分類影響を計算する操作ではないため、初期基本設計では専用Preview APIを設けず、管理画面上の確定前確認で説明要件を満たす。

プロフィール代理変更も、動的な予約集合・再分類影響を計算する操作ではないため、初期基本設計では専用Preview APIを設けない。氏名変更は変更前後を、連絡先メール変更開始は旧メールが確認完了まで有効であること、新メール所有確認が必要であること、確認完了後に旧メールへSecurity Noticeを送ることを管理画面上で確認できる形とする。

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
- スクール都合キャンセル対象Reservationの取消状態・欠席状態・再分類影響
- 欠席設定・解除対象Reservationの欠席状態・算入状態・再分類影響
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

### 6.1 Schedule複数変更のConflict説明

`REQ-301 / AC-301-009` に従い、複数のSchedule変更が競合によって全体未適用となる場合、管理者が再確認・再操作できるよう、**検出できた競合**について業務上理解可能な情報を返せる形とする。

少なくとも次を画面表示可能なApplication View Modelとして表現できるようにする。

- 検出できた競合対象のSlotまたは変更項目を識別するための情報
- 予約済みになった、Slot状態が変わった、対象状態がPreview時と異なる等の業務上の競合理由
- 再確認に必要な最新状態、または最新状態を再取得するための情報

競合理由はDatabase Constraint名、SQL Error、内部Table / Column名等ではなく、`POL-014` / `BR-133` に従う安定した業務表現とする。

本設計は、1回のConflict Responseで発生済み・発生し得る**全競合を完全列挙することを保証しない**。Transaction内Guardが最初の不成立で失敗する実装や、競合検出・最新状態再読込の後にさらに別操作がCommitされる場合もあり得るためである。

したがって「検出できた競合」は、そのCommand失敗時に安全かつ合理的に特定できた対象と理由を意味する。再実行時には再び最新確定状態を検証し、その時点で新たな競合があれば同じ原則で全体未適用として扱う。

具体的なConflict Response Schema、競合理由Code、競合対象一覧の上限・Pagination要否等は管理者向け個別API詳細設計で確定する。

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

### スクール都合キャンセル

- 対象Reservationの確定した `school_cancelled` 状態
- 通常取消／事後登録の別
- 取消確定時刻
- キャンセル後のSlot状態
- 同一月でclassificationが変更された未開始Reservationの一覧または表示に必要な差分

### 欠席設定・解除

- 対象Reservationの確定した欠席状態
- 対象Reservationの確定した実効算入状態・classification
- 同一月でclassificationが変更された未開始Reservationの一覧または表示に必要な差分

### Security Suspension設定・解除

- 対象Studentの確定したSecurity Access State
- 停止時は既存Sessionが失効済みであることを画面更新に必要な範囲で表現できる情報
- 解除時は新規Loginが必要であり、旧Sessionを復活させないことを確認できる結果

### 生徒削除

- 対象Studentの削除確定状態
- 削除により `system_cancelled` となった将来Reservationの結果
- 対象となる開始前Slotの確定状態
- 個人情報の削除・匿名化が24時間以内の後続処理対象として確実に登録されたこと

### プロフィール代理変更

- 氏名変更では、Commit後の確定プロフィール状態
- 連絡先メール変更開始では、現在有効な旧連絡先メールは変更せず、新メール所有確認待ちであることを示す状態

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

Maintenance / Recovery中は、検証未完了の復元状態に対する通常業務のQuery / Command、Login、通知Delivery、Scheduled Handlerを再開しない。公開APIは安全なMaintenance表示・安定した利用不可Responseへfail-closedし、内部Recovery状態やcredentialを露出しない。再開Gateとcutover境界は `01_SystemArchitecture.md` §5.3 / §6.5を正とし、Maintenance modeの具体wireは #537 / 詳細設計で確定する。

環境identityとbindingの整合が確認できない場合、または未完成機能が当該環境で有効と確認できない場合も、該当Query / Commandと外部副作用をserver-sideでfail-closedする。UI非表示やhostname推測を安全境界とせず、API直接アクセス、Scheduled Handler、Provider Callbackにも `01_SystemArchitecture.md` §6.1 / §6.4の隔離・露出条件を適用する。利用者向けResponseは安全な利用不可表現とし、具体Status / Application Error Codeは詳細設計で定める。

## 9. 保存モデルとAPI Modelの分離

APIはD1の保存Entityをそのまま外部契約にしない。

特に次を原則とする。

- `StudentReservation`、`SlotOccupancy`、各Override Entity等を機械的にそのままJSON化しない。
- 生徒向けScheduleは、保存上の占有構造ではなく、生徒が理解すべき予約可否・自分の予約状態・グループレッスン等へ整形する。
- 他生徒のStudent ID、Reservation ID、氏名、メール等、本人の操作に不要な情報を生徒APIへ返さない。
- `classification = NULL` を生徒画面へ機械的に表示せず、キャンセル・欠席・月間回数除外等の業務意味へ変換する。
- `IntegrityIncident` 等の運用監視Entityを通常利用者向け業務状態として公開しない。
- 保存Schema変更が不要にAPI破壊変更へ直結しないようApplication View Modelを介する。

Security Suspensionの論理状態も、将来の物理SchemaをそのままAPI Contractへ露出せず、「現在利用停止中か」「管理者が解除可能か」等の業務Viewへ整形する。

## 10. 認証・Session設計との境界

StudentのHTTP / Cookie / CSRF / Google / Magic Link / 登録接続の詳細は`../20_detailed_design/01_StudentReservationApplication.md` §10、Provider保存・発行合成は`../20_detailed_design/02_StudentReservationD1.md` §9、Session物理Guardは同書§8を正とする（#840 / #636）。Admin詳細・認証方法管理・プロフィール所有確認の全詳細は別責務として残る。

Application Workerは `01_SystemArchitecture.md` §2.1のD1正本opaque Server-side SessionをCookieで扱う。Student Account / Admin AccountとSessionはRole scopeごとに分離し、同一Sessionで権限を混在させない。各Requestで期限、失効、Account / Role、Studentの最新access state / lifecycleを検証する。Adminはabsolute最大7日・Idle 12時間（request時にlast activityを評価）、Studentはabsolute最大30日・Idleなしとする。Session bearer tokenをlocalStorage等へ保持しない。

生徒本人を対象とするAPIのIdentity決定Ruleは **4.1 生徒本人APIのSelf Scope原則** を正とし、管理者APIのActor / Target決定Ruleは **4.2 管理者向けAPIのActor / Target Scope原則** を正とする。本節では重複定義しない。

Security Suspensionについては、停止と全Student Session失効を同一Transactionで確定し、停止中は認証成功後も新しいSessionを発行せず、解除後も停止前Sessionを復活させない。Student Write Commandも現在の利用可否をCommit時に再確認する。競合境界は `05_BookingAndConcurrency.md` §3.8を正とする。

生徒削除については、削除Commandで利用不能化、全Student Session失効、Student Account / Auth Methodの通常Login対象外化、個人情報削除・匿名化義務を同一Transactionで確定する。独立したAdmin Account / Sessionは維持し、Student用認証識別子等は24時間以内に削除・匿名化する。

連絡先メール変更については、生徒本人・管理者のどちらが開始しても新メール所有確認を省略せず、確認完了までは旧メールを有効な連絡先として維持する。確認完了時は最新状態を再確認し、連絡先とStudent用Magic Link login addressを同期する。Google Auth Method bindingは変更しない。

### 10.1 Login / LogoutとRegistration

GoogleはOIDC Authorization Code Flowのcallbackでstable subject、email、email verifiedを検証する。既存のStudent用bindingを優先し、未bindingなら一意なActive Studentの同一正規化verified連絡先メールへ `REQ-205` に従いlinkできる。異なるemailの既存Accountを自動mergeせず、削除済みStudentへ接続しない。AdminはAdmin Accountへ明示的にbinding済みのidentityだけを使い、email一致やStudent側の自動linkで昇格させない。Google認証入口の異常Trafficも `REQ-210` に従いRate Limitする。

Magic Link要求は公開入口でTurnstile、送信先（初期値60秒1回・1時間5回・1日10回、設定可能）と送信元のRate LimitをProvider呼出前に適用し、登録有無で公開Responseを変えず、認証失敗だけで恒久lockしない。Challengeはpurpose / Account scopeを持ち15分・単回使用で、使用済み・期限切れ・supersededを復活させない。consumeとSession発行を安全な整合境界で扱う。Google / Magic Link成功後も現在のAccount bindingとStudent利用可否を確認し、新しいRole別Sessionを発行する。Logoutは対象SessionをServer側で即時失効させる。

Open Registrationはverified Google emailまたはMagic Linkで所有確認したemailから新Student / Student Accountを作成できる。Invitation Onlyでは有効な72時間のInvitationなしに新Studentを作らず、Invitation emailとGoogle emailの一致は求めない。再発行は新Tokenで旧Tokenを無効化する。Registration modeは既存StudentのLoginには使わない。削除済みStudentと同じemailの新登録には新しいStudent IDを発行する。

### 10.2 認可、CSRF、Admin初期化

`/api/me/...` はStudent Sessionから内部Student IDを、`/api/admin/...` はAdmin SessionからAdmin Actor / RoleをServer側で解決する。認証成功だけでRoleを付与せず、明示的な登録・Invitation・Admin setup / method追加FlowでAccountを作成・bindingする。Role判定にClient入力やURLだけを使わない。

Cookie Sessionによる認証済みunsafe methodのCommandではSession-bound CSRF tokenを検証し、Origin / same-origin確認も行う。CSRF tokenはIdentityや認可の代替にしない。Google callbackはOAuth state / nonce / PKCE等でrequest origin / replayを防ぎ、Magic Link / Invitation / 所有確認Tokenは通常Session CSRF tokenと分離したpurpose-bound・single-useのbearer challengeとする。

Public Admin Registrationは設けない。System Setupで1つのAdmin Accountと少なくとも1つの事前binding済みAuth Methodを生成する。初期候補はSetup指定Admin emailのAdmin用Magic Linkとする。Login済みAdminは `REQ-320` に従い新方式を検証後に有効化し、最後の方式を削除できない。全方式喪失時は公開ResetではなくInfrastructure / 保守権限による既存Admin Accountへの明示的な再bindingで回復し、公開EndpointやStudent登録からAdmin Roleを生成しない。運用権限は `01_SystemArchitecture.md` §6.6を正とし、具体手順は #537 / 詳細運用設計で定める。
