# 06. API概要設計

## 1. 目的

本書は、Application WorkerがWeb UIへ提供するHTTP APIの基本原則を定義する。

予約・キャンセル・再分類等のTransaction境界は `05_BookingAndConcurrency.md` を正とし、本書ではそれらの業務Use CaseをAPI境界へどのように公開するかを定義する。

本段階は基本設計であり、個別Request / Response Schema、全Endpoint一覧、Correlation ID、Idempotency Key、Cookie属性、CSRF対策の具体方式等は詳細設計で確定する。

API基本原則は `OI-BD-007`、生徒向けAPI基本形は `OI-BD-008` で確定した。管理者向けAPI基本形は `OI-BD-009` で段階的に確定する。

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

本書では、APIが認証済みIdentityとRoleをServer側で解決し、その情報を用いて認可するところまでを原則として定義する。

生徒本人を対象とするAPIのIdentity決定Ruleは **4.1 生徒本人APIのSelf Scope原則** を正とし、管理者APIのActor / Target決定Ruleは **4.2 管理者向けAPIのActor / Target Scope原則** を正とする。本節では重複定義しない。

Security Suspensionについては、停止後に既存Sessionが即時利用不能となり、停止中は認証成功後も新しいSessionを発行せず、解除後も停止前Sessionを復活させないことを基本設計上の保証とする。Session保存・revocationの具体方式は後続の認証・Session基本設計で確定する。

生徒削除については、削除Commandの正常完了時点で既存Sessionが利用不能であることを基本設計上の保証とする。個人情報の実削除・匿名化は24時間以内の後続処理とするが、後続処理が必要であるという義務自体は削除CommandのTransaction内で失われない形で永続化する。

連絡先メール変更については、生徒本人・管理者のどちらが開始しても新メール所有確認を省略せず、確認完了までは旧メールを有効な連絡先として維持する。Pending変更の物理Entity、Token、期限、再送、確認Endpoint等の具体方式は後続の認証・アカウント設計／詳細設計で確定する。

以下は後続の認証・Session基本設計で確定する。

- Session保存方式
- Session Cookie / Token方式
- Cookie属性
- CSRF対策
- Login / Logout Endpoint詳細
- Google OAuth Flow詳細
- Magic Link Flow詳細
- Session失効・更新方式
- Security Suspensionの即時Session失効・非復活を実現するrevocation方式
- 生徒削除時のSession即時失効と個人情報削除・匿名化後続処理の具体方式
- 連絡先メール所有確認のPending状態、Token、期限、再送、無効化方式

## 11. 生徒向けAPI基本形

本節は `OI-BD-008` で確定した、生徒本人向け主要API Flowの基本設計を示す。

厳密なJSON Schema、Field名、Pagination、Expected Stateの具体表現等は詳細設計で確定するが、Endpointの責務と業務境界は本節を基本とする。

### 11.1 Schedule取得

基本形を次とする。

```text
GET /api/me/schedule-months/{month}
```

生徒向け未来Slotの「新規予約可能か」と「現在何によって占有されているか」を別々の独立ロジックで返さず、`BR-067` に従って同一の確定業務状態から1つのSlot Viewを導出する。

初期のSlot Viewは少なくとも次の意味を表現する。

| Slot View | 意味 |
|---|---|
| `bookable` | 認証済み生徒本人が現在新規予約可能 |
| `reserved_by_me` | 認証済み生徒本人のconfirmed Reservationが現在占有 |
| `group_lesson` | グループレッスンとして占有 |
| `unavailable` | その他の予約不可状態 |

`reserved_by_me` と `bookable` が同一Slotについて同時成立するような矛盾した表示状態を作らない。

`unavailable` には、他生徒予約済み、AdminHold、休業、開始済み等、生徒に詳細を公開する必要がない予約不可状態を含めてよい。他生徒のStudent ID、Reservation ID、氏名、メール等は返さない。

`reserved_by_me` では本人画面に必要なReservation識別子やclassificationを関連情報として返してよい。

日時は `REQ-907` に従いAsia/Tokyoの業務時刻として一意に解釈できる形で表現する。具体Wire Formatは詳細設計で確定する。

### 11.2 予約Preview

基本形を次とする。

```text
POST /api/me/reservations/preview
```

Self Scope原則に従い、対象本人を指定する `student_id` 等はRequestに含めない。Clientが指定する主な業務対象は `LessonSlot` の識別子とする。

Serverは認証済みSessionから内部生徒IDを解決し、Preview時点の確定状態を用いて少なくとも次を評価する。

- 対象生徒が現在予約操作可能であること
- 対象月が公開済みであること
- 対象Slotが現在予約可能であること
- 信頼できるServer時刻でLesson開始前であること
- 対象Slotに現在占有がないこと
- 同一生徒・同一月の最新状態から新規予約のclassificationを算出できること
- 新規予約によって既存未開始Reservationのclassificationが変化する場合、その影響差分を算出できること

Previewは、少なくとも日時、新規予約のPreview時classification、`AC-003-021` に該当する既存Reservationの区分影響、およびConfirm時の再確認に必要なExpected State相当情報を画面へ提供できる形とする。

### 11.3 予約確定

基本形を次とする。

```text
POST /api/me/reservations
```

Requestは論理的に、対象 `LessonSlot` とPreviewで利用者が確認したExpected State相当情報を持つ。対象本人を指定する `student_id` は持たない。

Reservation所有者は4.1のSelf Scope原則に従い、認証済みSessionから解決した内部生徒IDをServer側で設定する。

Confirm時はPreview結果を正本として信用せず、`05_BookingAndConcurrency.md` に従いTransaction内で最新確定状態を再検証・再計算する。

次のような重要状態がPreviewから変化している場合は予約を成立させず、原則 `409 Conflict` として最新Previewの再確認へ戻す。

- 対象Slotの予約可否
- 新規予約のclassification
- 新規予約によって区分変更される既存未開始Reservationの対象集合
- その既存Reservationの変更前後classification

classificationは `standard → additional` と `additional → standard` の両方向について同じConflict Ruleを適用する。

予約確定成功時は、新規Resource作成としてHTTP `201 Created` を基本とする。

成功ResponseではDB更新件数ではなく、少なくともReservation識別子、Lesson日時、確定classification、現在のSlot状態、および同一Transactionでclassificationが変更された既存未開始Reservationの画面表示に必要な差分を返せる形とする。

### 11.4 予約確定Conflict時の情報

他予約または管理者変更等が先にCommitされていた場合は、先行Commitを優先する。

Conflict Responseでは他生徒の情報を公開せず、生徒本人が再確認するために安全な最新Slot Viewおよび必要に応じて最新classification等を返せる形とする。

例えば他生徒予約済みであれば `unavailable` であることは示してよいが、その予約者のStudent ID、Reservation ID、氏名等は返さない。

### 11.5 一括予約Preview / Confirm

`REQ-008 / AC-008-001〜009` に従い、一括予約は既存の単一予約APIを変更せず、専用のBulk Reservation Commandとして次の基本形を用いる。

```text
POST /api/me/reservations/bulk/preview
POST /api/me/reservations/bulk
```

いずれもSelf Scope原則に従い、対象本人を選択する `student_id` その他の生徒識別情報をRequestに持たせない。予約者は認証済みSessionからServer側で解決する。一括操作の対象月もClient入力を正とせず、Serverが選択されたLessonSlotから判定・検証する。

#### 11.5.1 Preview

Bulk Previewは状態を変更しないQueryである。Requestは論理的に、選択した複数の `LessonSlot` 識別子を持つ。具体JSON Schema、Field名、空配列・重複指定等の入力Validation表現は詳細設計で確定する。

Serverは最新確定状態から、少なくとも次を一括で検証・算出する。

- 選択対象が2件以上で、同一暦月に属する複数のSlotであること
- 選択数が対象生徒・対象月の最新の月間標準回数N以下であること。このNは当該一括操作の上限であり、月全体の予約件数上限ではないこと
- 各対象Slotが現在予約可能であり、公開済みで、信頼できるServer時刻において開始前かつ現在占有されていないこと
- 選択全体を追加した場合の各新規Reservationのclassification
- 選択対象外の既存未開始Reservationについて生じるclassificationの差分

Preview Responseは、少なくとも次を画面表示可能なApplication View Modelとして返す。

- 選択対象ごとのLesson日時とPreview時classification（`standard` / `additional`）
- 選択対象外の既存未開始Reservationへの区分影響。影響ごとにLesson日時、変更前classification、変更後classificationを表現する
- Confirm時に再確認するためのExpected State相当情報

影響がない場合の空集合等のWire表現、Nの表示有無、Expected StateのRevision / Fingerprint / Token等の具体方式は詳細設計で確定する。Responseは他生徒のStudent ID、Reservation ID、氏名、メール、内部DB構造を含めない。

#### 11.5.2 Confirm

Bulk Confirmは1つの業務Commandである。Requestは論理的に、Previewした選択 `LessonSlot` 識別子群、Expected State相当情報、および再送を識別する操作識別子を持つ。Expected Stateは、選択Slot集合、そこからServerが判定した対象月、最新N、各Slotの予約可能状態、各新規Reservationのclassification、および選択対象外の既存未開始Reservationへのclassification影響を確認する業務的Snapshotとする。Preview Response中のclassification、月間標準回数N、予約可否、対象月、または影響差分をClientが正本として指定・更新する形にはしない。

Confirm時、Serverは選択全体について最新のN、同一暦月、各Slotの予約可否・予約期限・現在占有、classification、および選択対象外の既存未開始Reservationへの区分影響を再読込・再検証する。

全対象が最新状態で条件を満たす場合のみ、選択全体を確定する。対象の一部だけを確定することはなく、単一予約のConfirmと同様に確定Reservationの予約者は認証済みSessionから解決した内部生徒IDとする。D1 Transaction、Lock、Guard SQL等の実現方式は本基本API契約では定めず、後続の詳細設計で確定する。

Expected StateはPreview後の重要状態の変化を検出してConfirm成立可否を判定するためのものであり、操作識別子によるIdempotencyの代替ではない。逆に操作識別子は再送時の二重確定を防ぐためのものであり、最新状態再検証を省略させない。同一操作識別子・同一内容のBulk Confirm再送では、新しいReservationを重複作成せず、先に確定した同一操作の結果を返せる形とする。同一操作識別子を選択Slot集合またはExpected Stateを含む異なる内容で再利用した場合は、別操作として実行せずRejectする。操作識別子の具体Field、同一内容の比較、保存、保持、一意性Guard、再送・RejectのHTTP表現は詳細設計で確定する。

成功時は複数の新規Reservationを確定した結果としてHTTP `201 Created` を基本とする。成功Responseは、少なくとも確定した各Reservationの識別子、Lesson日時、確定classification、現在のSlot状態、および同一Commandで変更された既存未開始Reservationの画面表示に必要な区分差分を返せる形とする。

#### 11.5.3 Confirm時の再確認要求

Preview後にN、対象月、対象Slotの予約可否・予約期限・現在占有、各新規Reservationのclassification、または選択対象外の既存未開始Reservationへの区分影響が変化した場合、Bulk Confirmは全体を未適用とする。

通常の業務競合は原則HTTP `409 Conflict` とし、Responseは再Previewが必要であることを表現できる安定したApplication Error Codeまたは同等のApplication Viewを持つ。安全に検出できた範囲で、少なくとも次を返せる形とする。

- 問題を検出した選択対象Slotまたは選択条件を利用者が識別できる情報
- 予約済み、予約期限超過、Nまたはclassificationが変化した等の業務上の理由
- 最新の安全なSlot View、classification影響、またはそれらを取得するための再Preview情報

Conflict Responseは全競合の完全列挙を保証しない。いずれの場合も、他生徒の個人情報、Database Constraint名、SQL Error、内部Table / Column名を公開しない。

### 11.6 生徒キャンセル

基本形を次とする。

```text
POST /api/me/reservations/{reservationId}/cancel
```

生徒キャンセルは、初期基本設計では専用Preview APIを設けない。UI上で確認表示を行うことは妨げないが、予約確定のようなPreview / Confirmの2 API構成は必須としない。

対象Reservationは4.1のSelf Scope原則に従い、認証済み生徒本人が操作可能なReservationであることをServer側で検証する。

他生徒のReservation IDを指定した場合、他生徒Resourceの存在有無を不要に漏洩しないため、生徒APIでは本人の対象として存在しない場合と同様に扱うことを基本とする。具体的なApplication Error表現は詳細設計で確定する。

本人Reservationについても、既に別種別でキャンセル済み、キャンセル可能期限外、先行する状態変更済み等で現在のCommandを成立させられない場合は、確定状態を上書きしない。

成功Responseは、キャンセル後Reservation状態、現在のSlot View、および同一月でclassificationが変更された未開始Reservationの画面表示に必要な差分を返せる形とする。

### 11.7 予約履歴

基本形を次とする。

```text
GET /api/me/reservations
```

Self Scope原則に従い、対象本人を切り替える `student_id` Query Parameter等は設けない。

予約履歴のApplication View Modelでは、業務上異なる概念を不用意に1つの状態へ統合しない。

少なくとも次の概念を分離して表現できる形とする。

```text
reservationState
  confirmed
  student_cancelled
  school_cancelled
  system_cancelled

attendanceState
  absent / none

classification
  standard / additional / 対象外
```

UI向けに複合的な表示Labelへ変換することは許容するが、API内部でキャンセル・欠席・classification等の意味を失う形へ統合しない。

### 11.8 生徒向け主要Flow

主要Flowは次を基本とする。

```text
GET Schedule
    ↓
Slot選択
    ↓
POST Reservation Preview
    ↓
日時・新規classification・既存予約への区分影響を確認
    ↓
POST Reservation Confirm
    ↓
201 確定業務状態

後日
    ↓
GET Reservations
    ↓
POST Reservation Cancel
    ↓
キャンセル後の確定業務状態
```

一括予約は単一予約と並行して次のFlowを提供する。単一予約Flowを一括予約へリダイレクトまたは置換しない。

```text
GET Schedule
    ↓
複数Slot選択（同一暦月）
    ↓
POST Bulk Reservation Preview
    ↓
全対象の日時・classification・既存予約への区分影響を確認
    ↓
POST Bulk Reservation Confirm
    ↓
201 全対象の確定業務状態

重要状態が変化
    ↓
409 全体未適用・再Preview要求
```

Schedule表示、Preview、Confirm、履歴、Cancelの全段階で、対象生徒Identityは4.1のSelf Scope原則を共通適用する。

## 12. 管理者向けSchedule API基本形

本節は `OI-BD-009` で確定した、管理者向けAPIのうち月間Scheduleに関する基本設計を示す。

管理者向け分類管理、生徒管理、通知失敗管理等の残りのAPIは `OI-BD-009` で継続検討する。Request / Responseの厳密なSchema、Expected Stateの具体表現等は詳細設計で確定する。

### 12.1 主要Endpoint

月間Scheduleの主要API基本形を次とする。

| 用途 | Endpoint | 種別 |
|---|---|---|
| 月間Schedule取得 | `GET /api/admin/schedule-months/{month}` | Query |
| 月間Schedule生成 | `POST /api/admin/schedule-months/{month}/generate` | Command |
| Schedule変更Preview | `POST /api/admin/schedule-months/{month}/changes/preview` | Query |
| Schedule変更確定 | `POST /api/admin/schedule-months/{month}/changes` | Command |
| 月間Schedule公開 | `POST /api/admin/schedule-months/{month}/publish` | Command |

公開済み月の将来枠変更はCommit後ただちに有効であり、再公開操作を必要としない。そのため、公開済み月の変更後に使用する `republish` APIは設けない。

### 12.2 管理者向けSchedule View

管理者向けSchedule Viewは、`03_ScheduleModel.md` の `ScheduleMonth`、`LessonSlot`、`SlotOccupancy` を保存モデルのまま公開せず、運営業務に必要なApplication View Modelへ整形する。

未来Slotの現在状態は、`BR-067` に従い同一の確定業務状態から矛盾なく導出する。

少なくとも次を区別できる形とする。

```text
LessonSlot availability
  enabled / disabled

Current occupancy
  none
  student_reservation
  admin_hold
  group_lesson
```

StudentReservationによる占有の場合、管理者の運営業務に必要なReservation識別子、内部Student ID、表示用生徒名、classification等を返してよい。ただしSchedule管理に不要な連絡先メール等の個人情報を常時返さず、`POL-004` の最小化原則を維持する。

### 12.3 月間Schedule生成

`POST /api/admin/schedule-months/{month}/generate` は、**対象年月のScheduleMonthがまだ存在しない場合に、現在適用される確定済み生成ルールから初期Scheduleを作成するCommand** とする。

`REQ-301 / AC-301-010` に従い、既にScheduleMonthが存在する場合に、既存のLessonSlotや管理者による手動変更を消して再生成する用途には使用しない。

この方針により、定期グループレッスン等の設定変更を既生成月へ遡及反映しない `BR-019` と整合させる。既存月を変更する必要がある場合は、明示的なSchedule変更Commandを使用する。

対象年月の重複生成を正常状態として許容せず、`ScheduleMonth` の年月一意性を維持する。既存月に対するgenerate要求の具体的なHTTP Status / Application Error Codeは詳細設計で確定する。

### 12.4 Schedule Change SetのPreview / Confirm

複数Slotに対するSchedule変更は、単なる独立PATCHの配列ではなく、管理者が一括して確認・確定する **Schedule Change Set** として扱う。

Previewでは、対象Change Setを現在の確定状態へ適用した場合の少なくとも次の影響を画面表示可能な形で返す。

- 対象Slotごとの変更前後状態
- StudentReservation、AdminHold、GroupLesson等の現在占有への影響
- school cancellationが必要となるReservationと、その理由入力・確認に必要な情報
- その他、管理者が確定前に理解すべき主要影響
- Confirm時の再確認に必要なExpected State相当情報

Confirm時はPreviewを正本とせず、Transaction内で最新状態を再検証する。一部でも競合があれば `REQ-301 / AC-301-005, AC-301-009` および6.1に従い、原則としてChange Set全体を未適用とする。

### 12.5 予約影響を伴うSchedule変更のCommand境界

StudentReservationが現在占有する将来Slotを `enabled → disabled` にする等、Schedule変更の成立にschool cancellationが必要な場合は、Schedule変更とschool cancellationを別々の独立Commandとして途中状態を残さない。

少なくとも次を、原因となるSchedule Change Setの1つの原子的な業務Transaction境界へ含める。

- 対象LessonSlotの確定変更
- 対象StudentReservationの `school_cancelled` 確定
- `cancelled_at` および `SchoolCancellationDetail`
- 対象Reservationの現在Occupancy終了
- 必要となる月間classification再計算・未開始Reservation更新
- `AuditLog`
- 必要な `NotificationIntent`

その一部だけをCommitしない。特に次のような状態を正常状態として残してはならない。

```text
LessonSlot = disabled
AND
confirmed StudentReservation が現在占有
```

school cancellation理由カテゴリ・補足は `REQ-313` に従う。複数Reservationへ同一理由を一括入力できるUIを許容しても、業務上は各Cancellationが理由情報と追跡可能に対応する形とする。

AdminHoldまたはGroupLessonが占有するSlotをdisabledにする場合も、`03_ScheduleModel.md` に従い占有を残したまま利用可否だけを変更せず、対応する占有解除・変更と整合したCommandとして扱う。

### 12.6 月間Schedule公開

`POST /api/admin/schedule-months/{month}/publish` は、未公開ScheduleMonthを公開済みにするCommandとする。

初期基本設計では専用のPublish Preview APIを設けない。管理者は公開前にSchedule View自体で対象月を確認でき、Publishそのものは既存Reservationの取消等の複雑な直接影響を発生させないためである。

Publish確定時には、Server側で少なくとも次を最新状態から検証する。

- 対象ScheduleMonthが存在すること
- 対象月が未公開であること
- Scheduleの業務整合性が成立していること
- 整合性異常等により安全に公開できない状態でないこと

公開済み月の将来枠変更は、既存設計どおりCommit後ただちに最新状態として扱い、月全体の再公開操作を要求しない。

## 13. 管理者向け分類管理API基本形

本節は `OI-BD-009` で確定した、管理者向けAPIのうち月間標準回数、月間回数除外、Classification Overrideに関する基本設計を示す。

3操作はいずれもReservationの表示上のclassificationに関係するが、業務作用を同一視しない。

- 月間標準回数変更は、自動分類でstandardを割り当てる基準数を変更し、同一生徒・同一月の未開始Reservationを再分類し得る。
- 月間回数除外の設定・解除は、月間算入対象集合や開始済み自動standardの消費数を変化させ、同一生徒・同一月の未開始Reservationを再分類し得る。
- Classification Overrideは対象Reservationの実効classificationだけへ作用し、自動標準枠の消費数・割当順・他Reservationのautomatic_classificationを変更しない。

この差異は `BR-056 / BR-058 / BR-059 / BR-060 / BR-066` および `04_ReservationModel.md` を正とする。

### 13.1 主要Endpoint

基本形を次とする。

```text
POST /api/admin/students/{studentId}/schedule-months/{month}/standard-count/preview
POST /api/admin/students/{studentId}/schedule-months/{month}/standard-count

POST /api/admin/reservations/{reservationId}/monthly-count-exclusion/preview
POST /api/admin/reservations/{reservationId}/monthly-count-exclusion
POST /api/admin/reservations/{reservationId}/monthly-count-exclusion/clear/preview
POST /api/admin/reservations/{reservationId}/monthly-count-exclusion/clear

POST /api/admin/reservations/{reservationId}/classification-override
POST /api/admin/reservations/{reservationId}/classification-override/clear
```

月間標準回数変更および月間回数除外の設定・解除は、他の未開始Reservationへ再分類影響が波及し得るためPreview / Confirm Patternを適用する。

Classification Overrideは対象Reservationだけに作用するため、初期基本設計では専用Preview APIを設けない。ただしCommit時の最新状態再検証および管理画面上の変更内容確認は省略しない。

### 13.2 月間標準回数変更

`REQ-307` に従い、Previewでは少なくとも次を管理者が確認できる形とする。

- 現在の標準回数と変更後の標準回数
- 開始済みReservationのautomatic_classificationは変更しないこと
- 変更後の消費済み自動標準枠と残り自動標準枠を踏まえた未開始Reservationへの影響
- 区分が変化する未開始ReservationのLesson日時、変更前classification、変更後classification
- Confirm時の再確認に必要なExpected State相当情報

ConfirmではPreviewを正本として使用せず、最新のReservation状態、欠席、月間回数除外、標準回数、Lesson開始時刻境界等を再評価する。

Previewから、影響する未開始Reservationの対象集合または変更前後classification等の重要影響が変化している場合は、原則 `409 Conflict` として再Previewへ戻す。

正常Commitでは、少なくとも次を1つの業務Transaction境界で整合させる。

- `StudentMonthlyLessonConfig.standard_count` の設定・変更
- 同一生徒・同一月の必要な未開始Reservation再分類
- 再分類対象Reservationの `automatic_classification` / 実効classification更新
- `AuditLog`
- `REQ-104` に該当する区分変更の `NotificationIntent`

開始済みReservationの `automatic_classification` は通常の自動再分類で遡及変更しない。

### 13.3 月間回数除外の設定・解除

`REQ-308 / AC-308-001〜003` に従い、月間回数除外の設定と解除を対称な管理操作として提供する。

Previewでは少なくとも次を確認できる形とする。

- 対象ReservationのLesson日時
- 現在の月間算入可否と、操作後に想定される実効算入可否
- 対象Reservation自身の現在の実効classificationと操作後の状態
- 同一生徒・同一月で区分が変化する未開始ReservationのLesson日時、変更前classification、変更後classification
- Confirm時の再確認に必要なExpected State相当情報

除外設定では `ReservationMonthlyCountOverride = excluded` を確定し、対象Reservationを月間算入対象外として実効classificationを「分類対象外」とする。保存上の `classification` はNULLとし、`automatic_classification` は保持する。

除外解除は、**対象Reservationを無条件に月間算入対象へ戻すCommandではない**。管理者が設定した `ReservationMonthlyCountOverride` を解除した後、Reservationのライフサイクル状態、欠席その他の算入条件を含む最新確定状態から実効算入可否を再評価する。

したがって、解除後もキャンセル済みまたは欠席等により算入対象外であれば「分類対象外」を維持する。解除後に算入対象となる場合は、`04_ReservationModel.md` に従い、そのReservation自身へ保持済みautomatic_classificationおよび保持済みClassification Overrideを必要に応じて反映し、消費済み自動標準枠の変化は未開始Reservationの再分類へだけ反映する。

Confirm時は最新状態を再検証し、Preview時から対象Reservationの算入条件、Lesson開始時刻境界、標準回数、影響する未開始Reservationの対象集合または変更前後classification等の重要影響が変化している場合は、原則 `409 Conflict` として再Previewへ戻す。

正常Commitでは、少なくとも次を1つの業務Transaction境界で整合させる。

- `ReservationMonthlyCountOverride` の設定または解除
- 対象Reservationの実効classification更新
- 同一生徒・同一月の必要な未開始Reservation再分類
- 再分類対象Reservationの `automatic_classification` / 実効classification更新
- `AuditLog`
- `REQ-104` に該当する区分変更の `NotificationIntent`

### 13.4 Classification Override

`REQ-310` および `BR-059` に従い、Classification Overrideは対象Reservationの実効classificationを `standard` または `additional` へ明示的にOverrideする管理操作とする。

初期基本設計では専用Preview APIを設けない。管理画面ではCommand実行前に、少なくとも対象ReservationのLesson日時、automatic_classification、現在の実効classification、現在のOverride、変更後のOverride内容を確認できる形とする。

Overrideの設定・変更・解除は他Reservationのautomatic_classification再計算を引き起こさない。自動標準枠の消費数・割当順も変更しない。

対象Reservationが算入対象である場合は、Override設定・変更後の値を実効classificationへ反映する。Override解除時は保持済み `automatic_classification` を実効classificationへ戻す。

既存のClassification Overrideを持つReservationがキャンセル、欠席、月間回数除外等によって分類対象外となった場合は、`04_ReservationModel.md` に従いOverride自体を明示解除まで保持しつつ、分類対象外の間は実効classificationをstandard / additionalとして扱わない。

専用Preview APIを設けない場合でも、Commandは最新のReservation状態・算入状態等をCommit時に再検証する。先行Commitにより、管理者が確認した状態とCommandの意味または実効結果が重要に変化している場合は、確定状態を無言で上書きせず再確認へ戻す。

正常Commitでは、少なくとも次を同一の業務Transaction境界で整合させる。

- `ReservationClassificationOverride` の設定・変更・解除
- 対象Reservationの実効classification更新
- `AuditLog` への変更前後、Actor、時刻等の監査記録
- `REQ-104` に該当する区分変更の `NotificationIntent`

Classification Overrideだけを理由に、他Reservationのautomatic_classificationを変更しない。

### 13.5 区分変更通知と成功Response

分類管理Commandによって既存Reservationの実効classificationが `standard → additional` または `additional → standard` へ変化した場合は、`REQ-104` に従う区分変更通知義務を発生させる。

一方、月間回数除外の設定等により対象Reservationがstandard / additionalから「分類対象外」へ変化すること自体を、`REQ-104` のstandard / additional区分変更通知として機械的に扱わない。

成功ResponseはDB更新件数ではなく、管理者が直ちに確定結果を確認できるApplication View Modelとし、操作に応じ少なくとも次を返せる形とする。

- 対象となった標準回数、月間回数除外状態、またはClassification Overrideの確定状態
- 対象Reservation自身の確定した実効算入状態・classification
- 同一Transactionで区分が変化した未開始ReservationのLesson日時と変更前後classification
- 最新状態表示に必要な情報

## 14. 管理者向けスクール都合キャンセル単独API基本形

本節は `OI-BD-009` で確定した、Schedule変更に内包されないReservation単独のスクール都合キャンセルAPI基本形を示す。

Schedule Change Setに伴うschool cancellationも本節と同じDomain Rule・Transaction原則を共有するが、Schedule変更を原因とする場合は12.5のCommand境界を正とする。

### 14.1 主要EndpointとPreview / Confirm

基本形を次とする。

```text
POST /api/admin/reservations/{reservationId}/school-cancel/preview
POST /api/admin/reservations/{reservationId}/school-cancel
```

`REQ-313 / AC-313-008, AC-313-009` および `BR-131` に従い、単独スクール都合キャンセルはPreview / Confirm Patternを適用する。

Previewでは少なくとも次を管理者が確認できる形とする。

- 対象ReservationのLesson日時、生徒、現在のReservation状態、現在の実効classification
- `REQ-313` の理由カテゴリ、補足、不要な個人情報入力を避ける注意表示
- 通常のスクール都合キャンセルか事後登録か
- 対象Reservationが月間回数から除外され「分類対象外」になること
- キャンセル後のSlot状態または事後登録時のSlot取扱い
- 同一生徒・同一月で区分が変化する未開始ReservationのLesson日時、変更前classification、変更後classification
- 生徒へスクール都合キャンセル通知が行われること。事後登録では事後登録であることが通知されること
- Confirm時の再確認に必要なExpected State相当情報

`reason_category = その他` の場合に補足を必須とし、補足入力欄には不要な個人情報を書かないよう注意を表示する。

### 14.2 通常取消と事後登録の判定

通常取消／事後登録の別はClientから送られた種別文字列を正本にせず、同一Commandで用いる信頼できるServer Commit基準時刻 `T` とLesson開始時刻からServer側で判定する。

```text
T < Lesson.start_time
  → 通常のスクール都合キャンセル

T >= Lesson.start_time
  → 事後スクール都合キャンセル
```

`BR-063 / AC-313-005` に従い、スクール都合キャンセルは原則Lesson開始前に行う。Lesson開始時刻以降は、実際にスクール都合でLessonが実施されず、緊急事情等により当時の操作ができなかった場合の事後登録として扱う。

システムは「実際にLessonが実施されなかった」という業務事実を自動判定しない。事後登録のPreview / Confirmでは、その事実を管理者が明示的に確認して確定する。これはClient入力を自動事実判定の正本とすることを意味せず、管理者による業務判断としてAuditLogから追跡可能にする。

初期リリースでは事後登録に固定日数の期限を設けない。ただし対象は、システム上参照可能で、Commit時点でも現在未取消の `confirmed` Reservationに限定する。

### 14.3 キャンセル後Slot状態

Lesson開始前の通常取消では、取消だけを理由にSlotを暗黙の空き状態へ戻さない。管理者がPreviewで確認した業務目的に応じ、少なくとも次のいずれかへ明示的に確定する。

1. `disabled + occupancyなし`
2. `enabled + AdminHold等の別占有`
3. 明示的に再開放した `enabled + occupancyなし`

AdminHold等の別占有を同時に成立させる場合は、Schedule / Occupancy側の既存Domain Ruleと同一Transactionで整合させる。

Lesson開始時刻以降の事後登録では `AC-313-006` に従い、対象Slotを再開放しない。元ReservationによるOccupancyは終了するが、school cancellationだけを理由に過去・開始済みSlotを予約可能状態へ戻す操作を行わない。Slotの `availability_status` は、別の明示的なSchedule変更を同時に行う場合を除き、事後キャンセルだけを理由に変更しない。新規予約可否はServer時刻の開始境界により成立しない。

### 14.4 欠席との関係

`AC-313-007` に従い、対象Reservationに欠席が記録済みの場合はschool cancellation Commandを成立させない。

管理者には、先に欠席解除Commandを明示的に実行する必要があることを案内する。

```text
欠席記録あり
  → school-cancel Preview / Confirm 不成立
  → 欠席を明示解除
  → school-cancel Previewを再実行
```

school cancellationの副作用として `ReservationAbsence` を暗黙に削除・解除しない。

### 14.5 Confirm時再検証とTransaction

ConfirmではPreviewを正本とせず、Transaction内で少なくとも次を最新状態から再検証する。

- 対象Reservationが現在も未取消の `confirmed`
- 欠席が未設定
- Server Commit基準時刻 `T` に基づく通常取消／事後登録の別
- 対象ReservationとSlotOccupancyの整合
- 通常取消で選択したキャンセル後Slot状態が現在も成立可能
- 月間算入状態・標準回数・開始境界
- 影響する未開始Reservation集合と変更前後classification

Preview時から対象Reservationの状態、欠席、通常／事後の別、Slot状態、再分類影響等の重要な確認内容が変化している場合は、確定状態を無言で上書きせず原則 `409 Conflict` として再Previewへ戻す。

正常Commitでは `05_BookingAndConcurrency.md` を正として、少なくとも次を1つの原子的業務Transaction境界で整合させる。

- `StudentReservation.status = school_cancelled`
- `cancelled_at = T`
- `SchoolCancellationDetail`
- 対象Reservationの `classification = NULL`、`automatic_classification` は保持
- 元Reservationの `SlotOccupancy` 終了
- 通常取消なら明示されたキャンセル後Slot状態
- 事後登録なら14.3の「再開放しない」取扱い
- 同一生徒・同一月の必要な未開始Reservation再分類
- `AuditLog`
- アプリ内未確認通知
- スクール都合キャンセルのメール `NotificationIntent`
- `REQ-104` に該当する区分変更 `NotificationIntent`

開始済みReservation自身の `automatic_classification` を事後キャンセルを理由に遡及変更しない。月間回数から外れることで空いた自動standard枠は、未開始Reservationの再分類にのみ反映する。

### 14.6 通知・振替・成功Response

`REQ-103 / AC-103-004` に従い、通常・事後のどちらでもメールとアプリ内未確認通知を生成する。事後登録では、生徒が「Lesson後に事後登録されたスクール都合キャンセル」であることを理解できる表現にする。

外部メール送信はCommit後に行い、送信失敗によって確定済みschool cancellationやアプリ内通知をRollbackしない。

`BR-065 / AC-313-004 / OOS-002` に従い、本Commandに別日時への移動・振替・管理者代理予約を含めない。必要な場合はschool cancellation確定後にSchedule側で新しい枠を用意し、生徒本人が独立した新規予約を行う。

成功Responseでは、少なくとも確定Reservation状態、通常取消／事後登録の別、取消確定時刻、理由、確定したSlot状態、対象Reservationの分類対象外状態、および同一Transactionで区分が変化した未開始Reservationの差分を返せる形とする。

## 15. 管理者向け欠席記録API基本形

本節は `OI-BD-009` で確定した、管理者による終了済みReservationの欠席設定・解除API基本形を示す。

欠席はReservationライフサイクルとは別の `ReservationAbsence` で表現する。欠席設定・解除は月間算入状態を変え、同一生徒・同一月の未開始Reservationへ再分類影響が波及し得るため、`REQ-315 / AC-315-005` に従い設定・解除ともPreview / Confirm Patternを適用する。

### 15.1 主要Endpoint

基本形を次とする。

```text
POST /api/admin/reservations/{reservationId}/absence/preview
POST /api/admin/reservations/{reservationId}/absence
POST /api/admin/reservations/{reservationId}/absence/clear/preview
POST /api/admin/reservations/{reservationId}/absence/clear
```

欠席設定と解除は意味の異なるCommandとして明示し、汎用的なReservation PATCHとして公開しない。

### 15.2 Preview

PreviewではServer側で対象ReservationとLesson日時を取得し、信頼できるServer時刻を用いてLesson終了済みであることを判定する。Client時刻やClient入力の終了済みフラグを業務判定の正本としない。

欠席設定Previewでは、対象Reservationが現在も未取消の `confirmed` で、`ReservationAbsence` が未設定であることを確認する。欠席解除Previewでは、対象Reservationが現在も `confirmed` で、`ReservationAbsence` が現在存在することを確認する。

Previewでは少なくとも次を管理者が確認できる形とする。

- 対象ReservationのLesson日時、生徒、現在のReservation状態
- 現在の欠席状態と操作後の欠席状態
- 現在の実効月間算入状態・classification
- 操作後に想定される実効月間算入状態・classification
- `AC-315-005` に該当する、区分が変化する未開始ReservationのLesson日時、変更前classification、変更後classification
- Confirm時の再確認に必要なExpected State相当情報

Lesson終了前、キャンセル済み、設定時に既に欠席設定済み、解除時に欠席未設定等、現在の業務状態で対象操作が成立しない場合は確定操作へ進めない。

### 15.3 欠席設定

欠席設定では `ReservationAbsence` を作成し、対象Reservationを月間算入対象外として実効classificationを「分類対象外」とする。保存上の `classification` はNULLとし、開始済みReservationの `automatic_classification` は保持する。

欠席設定はReservationの取消ではないため、`StudentReservation.status`、`cancelled_at`、`LessonSlot`、`SlotOccupancy` を欠席設定だけを理由に変更しない。過去Slotを再開放する処理も行わない。

開始済み自動standard Reservationを欠席として月間算入対象外にした結果、消費済み自動標準枠が減少する場合、その影響は未開始Reservationの再分類にのみ反映する。他の開始済みReservationのautomatic_classificationを遡及変更しない。

### 15.4 欠席解除

欠席解除では `ReservationAbsence` を削除する。ただし、**欠席解除は対象Reservationを無条件に月間算入対象へ戻すCommandではない**。

`ReservationAbsence` 解除後、対象Reservationのライフサイクル状態、`ReservationMonthlyCountOverride` その他の最新算入条件から実効算入可否を再評価する。正常な欠席解除対象は `confirmed` であるが、月間回数除外Override等により引き続き算入対象外であれば「分類対象外」を維持する。

解除後に算入対象へ戻る場合は、開始済みReservation自身の `automatic_classification` を再計算せず、保持済みautomatic_classificationと、存在する場合は保持済みClassification Overrideから実効classificationを復元する。消費済み自動標準枠の増加による影響は未開始Reservationの再分類にのみ反映する。

### 15.5 Confirm時再検証とConflict

ConfirmではPreview結果を正本として使用せず、Transaction内で少なくとも次を最新確定状態から再検証する。

- 対象Reservationが現在も `status = confirmed`
- 信頼できるServer Commit基準時刻 `T` がLesson終了時刻以上であること
- 設定Commandでは `ReservationAbsence` が未設定、解除Commandでは現在設定済みであること
- `ReservationMonthlyCountOverride` 等を含む対象Reservationの実効算入条件
- 同一生徒・同一月の標準回数
- 影響する未開始Reservation集合と変更前後classification

Preview時から対象Reservation状態、欠席状態、算入状態、標準回数、影響Reservation集合または変更前後classification等の重要な確認内容が変化している場合は、確定状態を無言で上書きせず原則 `409 Conflict` として再Previewへ戻す。

先に生徒キャンセル、スクール都合キャンセル、system cancellation等がCommitされていれば欠席設定・解除でその状態を上書きしない。

### 15.6 Transaction・通知・成功Response

正常Commitでは `05_BookingAndConcurrency.md` を正として、欠席設定・解除と対象Reservationの実効classification、消費済み自動標準枠の再評価、必要な未開始Reservation再分類、AuditLog、必要な区分変更NotificationIntentを1つの原子的業務Transaction境界で整合させる。

`REQ-315 / AC-315-004` および `BR-062` に従い、欠席設定または解除それ自体を理由とする専用の生徒向け自動メールNotificationIntentは作成しない。

一方、同一Transactionで既存Reservationの実効classificationが `standard → additional` または `additional → standard` に変化した場合は、`REQ-104` に従う区分変更NotificationIntentを生成する。対象Reservationが欠席設定によりstandard / additionalから分類対象外になること自体は、`REQ-104` の区分変更通知として機械的に扱わない。

成功Responseでは、対象Reservationの確定した欠席状態、実効算入状態・classification、および同一Transactionで区分が変化した未開始ReservationのLesson日時と変更前後classificationを返せる形とする。

## 16. 管理者向けSecurity Suspension API基本形

本節は `OI-BD-009` で確定した、管理者による生徒のSecurity Suspension設定・解除API基本形を示す。

Security Suspensionは `BR-099 / REQ-211 / REQ-316` に従う一時的なセキュリティアクセス制御であり、休会・退会・生徒削除・予約キャンセルとは別の状態軸として扱う。停止・解除だけを理由に既存予約、生徒データ、SlotOccupancy、月間算入状態、classificationを変更しない。

### 16.1 主要Endpointと確認方式

基本形を次とする。

```text
POST /api/admin/students/{studentId}/security-suspension
POST /api/admin/students/{studentId}/security-suspension/clear
```

初期基本設計では専用Preview APIを設けない。Security Suspensionは動的な予約集合・再分類影響を計算する操作ではないため、`AC-316-001〜003` の実行前説明は管理画面上の確認表示で満たす。

停止前には少なくとも次を確認できる形とする。

- Security Suspensionを利用すべき代表的なセキュリティ上の場面
- 既存の生徒Sessionが即時無効化されること
- 停止中はGoogle / Magic Link認証が成功してもLoginできないこと
- 新規予約、生徒キャンセル、プロフィール変更等の生徒本人操作が禁止されること
- 休会・退会・生徒削除・予約キャンセルではないこと
- 既存予約と生徒データは維持されること

解除前には少なくとも次を確認できる形とする。

- 既存予約・生徒データを維持したまま利用再開すること
- 停止前に失効したSessionは復活しないこと
- 利用再開には新規Loginが必要であること

### 16.2 Security Access Stateの分離

Security Suspensionは生徒のReservation状態や削除状態へ統合せず、論理的なSecurity Access Stateとして分離する。

```text
Student lifecycle / business data
  ≠ Security Access State

Security Access State
  active / suspended
```

物理的にStudent属性として保持するか、別Entityやrevocation状態と組み合わせるかは後続の認証・Session基本設計で確定できる。ただし、業務上 `suspended` と削除・退会・Reservation取消を同一状態として扱わない。

停止・解除CommandではTarget Studentを内部Student IDで特定し、Actorは4.2の原則どおり認証済み管理者Sessionから解決する。

### 16.3 停止時のSession失効と利用禁止

停止Commandが正常完了した時点で、少なくとも次の意味が一貫して成立していなければならない。

- 対象StudentのSecurity Access Stateが `suspended`
- 停止前に存在した対象Studentの有効Sessionが以後のRequestに使用できない
- 停止後の認証成功だけでは新しいStudent Sessionを発行しない
- `AuditLog` から管理者Actor、対象Student、停止操作、時刻を追跡できる

Session物理レコードの一括削除、revocation epoch / version等、即時失効を実現する具体方式は認証・Session基本設計で確定する。ただし方式にかかわらず、停止確定後に旧Sessionが一時的に有効なままとなることを正常状態として許容しない。

認証済みStudent Requestでも、Sessionの形式的有効性だけでなく現在のSecurity Access Stateを認可条件へ含める。停止中は少なくとも `REQ-211` が禁止する新規予約、生徒キャンセル、プロフィール変更を成立させない。他の生徒本人APIをどこまで参照可能とするかの詳細は認証・Session設計で要求との整合を確認するが、停止中にLogin済み状態として通常利用を継続できる実装にはしない。

### 16.4 解除と旧Session非復活

解除CommandはSecurity Access Stateを `suspended → active` へ戻すが、停止時に失効したSessionを再有効化しない。

解除後は `AC-211-005` に従い新規Loginを要求する。したがって、単純に `suspended = false` へ戻すだけで停止前Cookie / Tokenが再び有効になるSession設計は禁止する。

解除だけを理由にReservation、SlotOccupancy、月間算入状態、classification、既存予約を変更しない。

### 16.5 並行操作と最新状態再検証

Security Suspensionと生徒本人の予約・キャンセル・プロフィール変更等が並行した場合は、`POL-008` の先行Commit優先原則を適用する。

```text
生徒Commandが先に正常Commit
  → その確定結果を維持
  → 後続のSecurity Suspensionを成立させる

Security Suspensionが先に正常Commit
  → 後続Student Write CommandはCommit時にsuspendedを検出
  → 業務状態を変更せず不成立
```

予約等の重要Student Write Commandは、対象生徒が現在その操作を実行可能であることをCommit時Guardで確認する。Security Suspensionが先にCommitされていれば、Preview時やRequest開始時に利用可能だったとしても後続Commandを成立させない。

停止済みStudentへの再停止、またはactive Studentへの解除等、管理者が確認した状態と最新状態が異なる場合は、確定状態を無言でNo-opや上書きとして扱わず、最新状態を示して再確認させる。具体HTTP Status / Application Error Codeは詳細設計で確定する。

### 16.6 監査・通知・成功Response

`REQ-316 / AC-316-004` および `BR-132` に従い、Security Suspensionの設定・解除をAuditLogへ記録する。

停止理由の自由記述保存は現要求では必須ではないため、初期基本設計で必須入力・必須保存とはしない。将来、監査上の理由入力が要求化された場合は個人情報最小化を維持して追加する。

Security Suspension設定・解除それ自体を理由とする生徒向けメールNotificationIntentは、現要求にないため初期リリースでは必須としない。

成功Responseは、対象Studentの確定Security Access State、停止／解除の結果、および管理画面が次の行動を判断するために必要な情報を返せるApplication View Modelとする。Session物理IDやrevocation内部値を公開API Contractへ露出しない。

## 17. 管理者向け生徒削除API基本形

本節は `OI-BD-009` で確定した、管理者による生徒削除API基本形を示す。

生徒削除は `BR-100 / BR-122〜BR-128 / REQ-311 / REQ-312` に従う不可逆な管理操作であり、Security Suspensionとは異なる。削除確定時に生徒を即時利用不能とし、将来Reservationをシステム起因で取消し、直接管理する個人情報を24時間以内に削除・匿名化する。

### 17.1 主要EndpointとPreview / Confirm

基本形を次とする。

```text
POST /api/admin/students/{studentId}/deletion/preview
POST /api/admin/students/{studentId}/deletion
```

`AC-311-001` および `BR-131` に従い、Preview / Confirm Patternを適用する。対象Studentは内部Student IDで特定し、Actorは4.2の原則どおり認証済み管理者Sessionから解決する。

Previewでは少なくとも次を管理者が確認できる形とする。

- 対象Studentを確認するための必要最小限の情報
- 削除確定後は直ちにLogin、新規予約、生徒キャンセル、プロフィール変更等ができなくなること
- 既存Sessionが即時失効すること
- Server基準時刻で将来と判定される未取消confirmed Reservationが `system_cancelled` となること
- 取消対象となる各将来ReservationのLesson日時
- 各開始前Slotが取消後に再予約可能な状態へ戻ること
- 氏名、連絡先メール、認証識別子等の直接管理する個人情報が24時間以内に削除・匿名化されること
- 削除後に同じメールで再登録しても新しい生徒として扱われ、旧履歴へ再接続しないこと
- Confirm時の再確認に必要なExpected State相当情報

Preview表示に個人情報を過剰に含めず、対象確認と影響理解に必要な範囲へ限定する。

### 17.2 削除確定時の即時処理

正常な削除Commandでは `05_BookingAndConcurrency.md` の生徒削除起因system cancellationを正とし、少なくとも次を同一の原子的業務Transaction境界でAll-or-Nothingに確定する。

- 対象Studentを通常利用不能な削除確定状態へ遷移
- 既存Session失効
- Server Commit基準時刻 `T` で将来と判定される全 `confirmed` Reservationを `system_cancelled` 化
- 各 `cancelled_at = T`
- 各 `SystemCancellationDetail(reason_code = student_deleted)`
- 各対象Reservationの `classification = NULL`、`automatic_classification` は保持
- 対応する `SlotOccupancy` 終了
- 開始前Slotを最新状態から予約可否判定可能な状態へ戻す
- 個人情報削除・匿名化の後続処理が必要であることを失われない形で永続化
- `AuditLog`

複数の将来Reservationの一部だけを取消して削除を成功させない。対象ReservationまたはOccupancyに永続化済みInvariant違反を検出し安全に処理できない場合は、削除Transaction全体をFail Closedとする。

### 17.3 将来Reservationの判定と競合

削除起因system cancellationの対象は、Server Commit基準時刻 `T` で少なくとも次を満たすReservationとする。

```text
status = confirmed
AND LessonSlot.start_time > T
```

Lesson開始済み・終了済みReservationを生徒削除だけを理由に遡及キャンセルしない。

Preview後に新しい予約、キャンセル、Schedule変更等が先行Commitされ、削除対象となる将来Reservation集合が変化した場合は、原則 `409 Conflict` として削除を部分適用せず再Previewへ戻す。

対象Studentを特定する正本は内部Student IDとする。Previewで対象確認に表示した氏名・連絡先等が変更され、管理者が確認した対象表示と重要に異なる場合も、不可逆操作であることを踏まえ最新状態を再確認させる。

Security Suspension中のStudentも削除対象とできる。Security Suspensionは一時的アクセス制御、生徒削除は不可逆なライフサイクル操作であるため、両者を同一状態として扱わない。

### 17.4 個人情報削除・匿名化の後続処理

生徒削除Commandの成功と、個人情報の実削除・匿名化完了を同一意味として扱わない。

削除Commandが成功した時点では、少なくとも次が成立していることを保証する。

```text
生徒の利用不能化           完了
既存Session失効            完了
将来Reservation取消        完了
個人情報削除・匿名化義務保存 完了

個人情報の実削除・匿名化   24時間以内の後続処理
```

氏名、連絡先メール、Google等の認証紐付けなど直接管理する個人情報の実削除・匿名化は、要求どおり24時間以内に完了させる。Worker停止等があっても削除義務を失わないよう、削除CommandのTransaction内で後続処理必要状態を永続化する。

後続処理のJob / Entity / Retry / Monitoring、Backup復旧時の再適用等の具体方式は認証・アカウント設計、運用設計、詳細設計で確定する。

### 17.5 通知・履歴・成功Response

`BR-116` に従い、生徒削除に伴う `system_cancelled(reason_code = student_deleted)` について専用キャンセルメールNotificationIntentは生成しない。

開始済み・過去Reservationは削除を理由に取消さず、必要な業務履歴として扱う。ただし、個人情報の削除・匿名化後に不要な直接個人情報を履歴へ残さず、`BR-126〜BR-128` の保持・再登録・Backup方針と整合させる。

成功Responseは、対象Studentが削除確定済みであること、将来Reservationの取消結果、開始前Slotの確定状態、および個人情報削除・匿名化が24時間以内の後続処理対象として登録済みであることを管理者が理解できるApplication View Modelとする。内部Job IDや削除処理内部Schemaを公開API Contractの正本にはしない。

## 18. 管理者向けプロフィール代理支援API基本形

本節は `OI-BD-009` で確定した、管理者によるプロフィール代理支援API基本形を示す。

プロフィール代理支援は `REQ-007 / REQ-206 / REQ-317` に従い、生徒本人が変更できる初期プロフィール項目について管理者が利用支援できるようにする。ただし、管理者代理予約や認証Identityの無条件な差替えを許可する機能ではない。

### 18.1 主要Endpoint

基本形を次とする。

```text
GET  /api/admin/students/{studentId}/profile
POST /api/admin/students/{studentId}/name-change
POST /api/admin/students/{studentId}/contact-email-change
```

氏名と連絡先メールではCommand成功時の意味が異なるため、汎用 `PATCH /profile` に統合しない。氏名変更は正常Commitで即時反映する一方、連絡先メール変更Commandは新メール所有確認Flowを開始するだけであり、Command成功時点では現在の連絡先メールを変更しない。

初期基本設計では両Commandに専用Preview APIを設けない。対象Student、現在値、変更内容、およびメール変更時の確認Flowを管理画面上で確認してから実行する。

### 18.2 管理者向けプロフィールQuery

プロフィールQueryは対象Studentを内部Student IDで特定し、管理支援に必要な範囲へ情報を限定する。

少なくとも次を画面表示可能なApplication View Modelとして返せる形とする。

- 表示用氏名
- 現在有効な連絡先メール
- 連絡先メール変更が確認待ちの場合、その状態を管理者が判断するために必要な最小限の情報

Google ID、認証Token、Session内部情報等をプロフィール支援のために不要に公開しない。Actorは4.2の原則どおり認証済み管理者Sessionから解決する。

### 18.3 氏名代理変更

氏名変更Commandは、対象Studentの現在状態と管理者が確認した変更前氏名を最新状態で検証した上で、新しい氏名を確定し `AuditLog` を同じ業務Commandの監査として記録する。

管理画面を開いた後に本人または別の有効な操作で氏名が変更されており、管理者が確認した変更前状態と最新状態が重要に異なる場合は、古い画面から無言で上書きせず最新状態を示して再確認させる。

氏名変更だけを理由とする専用の生徒向けメール通知は現要求にないため、初期リリースでは必須としない。

### 18.4 連絡先メール変更開始と新メール所有確認

`REQ-206 / AC-206-001〜004` および `AC-317-002` に従い、管理者による連絡先メール変更でも新メール所有確認を省略しない。

基本Flowは次とする。

```text
管理者が新メールへの変更を開始
  ↓
新メール所有確認待ち
  ↓
確認完了までは旧メールを現在の連絡先として維持
  ↓
新メール所有確認成功
  ↓
最新状態・メール一意性を再検証
  ↓
連絡先メールを新メールへ確定変更
  ↓
以後の業務通知は新メールへ送信
  ↓
旧メールへSecurity Notice
```

管理者が新メールを入力した事実を所有確認の代替としない。Google認証との紐付けも連絡先メール変更だけを理由に変更しない。

所有確認完了時にも、対象Studentが変更可能な状態であること、当該Pending変更が現在有効であること、Activeな他Studentが新メールを連絡先として取得していないことを再検証する。確認待ちの間に重要状態が変化した場合は、古い確認情報で無言に変更を成立させない。

### 18.5 旧メール利用不能時の復旧支援

管理者による連絡先メール変更は、**旧メールが既に利用不能で、生徒本人が旧メールを使った変更開始・認証を行えない場合の復旧支援にも利用できる**。

この場合も新メール所有確認は必須とする一方、旧メール側での所有確認・承認を変更成立条件にはしない。したがって、旧メールが受信不能であっても、新メール所有確認とその他の最新状態Guardを満たせば変更を完了できる。

変更完了後の旧メールへのSecurity Noticeが配信不能であっても、`AC-206-004` に従い確定済みの連絡先メール変更をRollbackしない。

旧メールを利用できない変更依頼について、スクール管理者が依頼者本人をどのように確認するかは初期リリースのシステム機能・認証要件として固定せず、スクールの運用判断とする。システムはこの復旧経路のために旧メール確認や独自の本人確認質問等を追加の必須条件にしない。

### 18.6 Pending変更の排他・競合

初期基本設計では、1 Studentについて同時に有効な連絡先メール変更Pendingは最大1件とする。

新しい連絡先メール変更を開始した場合、以前のPending変更・確認情報が後から成立して連絡先メールを巻き戻さないよう、古いPendingを無効化する。無効化済みまたは置換済みの確認情報で変更を成立させない。

新メール所有確認完了時に、そのメールがActiveな別Studentの連絡先として既に使用されている場合は変更を成立させない。連絡先メール一意性は変更開始時だけに依存せず、変更確定時の最新状態で保証する。

Pending Entity、Token、確認期限、再送、具体的な無効化方法、確認Endpoint、Application Error Code等は認証・アカウント設計／詳細設計で確定する。

### 18.7 Security Suspension・削除との関係

`REQ-211 / AC-211-003` の「停止中はプロフィール変更を禁止する」をプロフィール変更経路全体へ適用し、Security Suspension中は生徒本人による変更だけでなく管理者による氏名・連絡先メールの代理変更も成立させない。

連絡先メール変更開始後にSecurity Suspensionが先行Commitされた場合も、所有確認完了時に停止状態を検出し、停止中にプロフィール変更を確定しない。利用再開が必要な場合はSecurity Suspensionを明示解除し、その後に最新状態から変更手続きを再確認する。

削除済みまたは削除確定処理により通常利用不能となったStudentへのプロフィール代理変更も成立させない。Security Suspensionを回避するためのAccount Recovery経路としてプロフィール代理支援を扱わない。

### 18.8 監査・成功Response

`AC-317-003 / BR-132 / REQ-940` に従い、氏名代理変更および連絡先メール変更開始を監査する。

AuditLogでは管理者Actor、対象Student、操作種別、時刻、結果、必要最小限のBefore / Afterを基本とし、氏名・メールそのものを必要なく重複保存しない。メール所有確認完了による実変更についても、変更開始との因果関係を追跡できる形を認証・アカウント設計で具体化する。

氏名変更成功ResponseはCommit後の確定プロフィール状態を返す。連絡先メール変更開始成功Responseは、旧メールが現在有効なままであること、新メール所有確認待ちであること、および管理画面が次の行動を判断するために必要な情報を返せる形とする。

## 19. 詳細設計へ送る事項

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
- Schedule Change Setの具体的なRequest / Response Wire Format
- 一括予約Preview / Confirmの具体的なRequest / Response Wire Format
- 一括予約の選択Slot集合、同一暦月、操作上限N、classification影響を確認するExpected State / Guardの具体形
- 一括予約Confirmの操作識別子の具体Field、同一内容の比較、保存Entity、保持期間、一意性Guard、再送・Reject Responseの具体形
- 一括予約固有のConflict / Business Rejection Application Error Codeと再Preview情報のWire表現
- Schedule生成済み・公開済み等の個別Conflict Error Code
- 分類管理Preview / Confirmの具体的なRequest / Response Wire Format
- Classification Override直接Commandの具体的な最新状態Guard表現
- school cancellation Preview / Confirmの具体的なRequest / Response Wire Format
- 事後登録の管理者明示確認を表現するField / Expected State / Audit Eventの具体形
- school cancellation固有のConflict / Business Rejection Application Error Code
- 欠席設定・解除Preview / Confirmの具体的なRequest / Response Wire Format
- Lesson終了境界・欠席状態・再分類影響を確認するExpected State / Guardの具体形
- 欠席設定・解除固有のConflict / Business Rejection Application Error Code
- Security Suspension設定・解除の具体的なRequest / Response Wire Format
- 停止済み／非停止状態への重複Commandを表現するConflict / Business Rejection Code
- 生徒削除Preview / Confirmの具体的なRequest / Response Wire Format
- 削除対象将来Reservation集合・対象表示情報を確認するExpected State / Guardの具体形
- 個人情報削除・匿名化後続処理の状態表現、Retry、Monitoring、24時間以内完了の確認方式
- 生徒削除固有のConflict / Business Rejection Application Error Code
- プロフィール代理支援の具体的なRequest / Response Wire Formatと最新状態Guard
- 連絡先メール変更Pendingの物理Entity、Token、確認期限、再送、置換・無効化方式
- 新メール所有確認Endpointと、確認完了時のメール一意性・Security Suspension・削除状態のGuard
- 旧メールSecurity Noticeの通知義務・Delivery・失敗時表示の具体形
- プロフィール代理支援固有のConflict / Business Rejection Application Error Code

認証・Session基本設計では、Security Suspensionの即時Session失効、停止中のSession非発行、解除後の旧Session非復活を実現するSession保存・revocation方式を確定する。

生徒削除については、認証・アカウント設計でSession即時失効、個人情報削除・匿名化対象、後続処理の永続状態と再実行可能性を具体化する。運用設計では24時間以内完了の監視・失敗時対応、Backup復旧時の再適用を具体化する。

プロフィール代理支援については、認証・アカウント設計で生徒本人と管理者開始を共通化できる連絡先メール所有確認Flow、Pending変更の排他、旧メールSecurity Noticeを具体化する。旧メール利用不能時の依頼者本人確認方法はシステム要件化せず運用判断とする。

## 20. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-004 個人情報最小化
- POL-005 通知は即時性、システム画面は確実性
- POL-006 ロール分離と最小権限
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-010 既定ルールと例外の分離
- POL-011 セルフサービスを基本とし必要な利用支援を可能とする
- POL-013 重要な管理操作の説明性と監査可能性
- POL-014 利用者向けエラー情報の安全な抽象化
- BR-015 月間スケジュール公開
- BR-016 公開後変更
- BR-017 管理者確保枠
- BR-018 定期グループレッスン
- BR-019 定期設定変更の非遡及
- BR-050 予約即時確定
- BR-051 二重予約禁止
- BR-052 予約期限
- BR-053 生徒キャンセル期限
- BR-054 キャンセル後の枠
- BR-055 追加レッスン事前表示
- BR-069 生徒一括予約
- BR-056 月間標準回数
- BR-057 追加レッスン分類
- BR-058 自動再分類
- BR-059 明示Override優先
- BR-060 月間回数除外
- BR-061 欠席
- BR-062 欠席表示
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- BR-065 専用振替なし
- BR-066 予約状態と月間算入の分離
- BR-067 未来Slotの現在予約状態の一貫性
- BR-068 生徒本人予約の所有者同一性
- BR-090 内部生徒ID
- BR-091 連絡先メール一意
- BR-099 セキュリティ利用停止
- BR-100 生徒削除
- BR-116 スクール都合キャンセル通知
- BR-120 最小プロフィール
- BR-122 削除権限
- BR-123 削除時即時無効化
- BR-124 直接管理個人情報削除
- BR-125 将来予約処理
- BR-126 過去情報
- BR-127 再登録
- BR-128 Backup内個人情報
- BR-131 管理操作説明
- BR-132 監査
- BR-133 利用者向けエラー表現
- REQ-001 初期画面・スケジュール確認
- REQ-002 予約可能枠表示
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-007 プロフィール変更
- REQ-008 生徒一括予約
- REQ-103 スクール都合キャンセル通知
- REQ-104 標準／追加区分変更通知
- REQ-206 連絡先メール変更
- REQ-207 Session管理
- REQ-211 セキュリティ利用停止
- REQ-301 月間スケジュール管理
- REQ-302 臨時休業
- REQ-303 月曜営業Override
- REQ-304 管理者確保枠
- REQ-305 定期グループレッスン設定
- REQ-307 月間標準回数設定
- REQ-308 月間回数除外
- REQ-309 標準／追加再分類
- REQ-310 区分Override
- REQ-311 生徒削除
- REQ-312 削除時予約処理
- REQ-313 スクール都合キャンセル
- REQ-315 欠席記録
- REQ-316 セキュリティ利用停止管理
- REQ-317 プロフィール代理支援
- REQ-907 業務Timezone
- REQ-911 競合整合性
- REQ-914 障害・エラー時利用者表示
- REQ-940 監査Logging
- CON-001 Cloudflare基盤
- CON-006 初期規模
- OOS-002 管理者代理予約

## 21. 設計判断記録

- API基本原則とCommand / Query境界は `OI-BD-007` で検討し、本書へ確定結果を反映した。
- 生徒向け主要API Flow、Slot View、予約Preview / Confirm、生徒キャンセル、予約履歴は `OI-BD-008` で確定した。
- 生徒一括予約の専用Preview / Confirm API契約はIssue #66で確定した。既存の単一予約APIを維持し、`REQ-008 / AC-008-001〜009` に対して、同一暦月・最新N・選択Slot・classification影響をServerが再検証する全体Confirmと、409での全体未適用・再Preview要求を定義した。
- 一括予約ConfirmのExpected Stateは、選択Slot集合、対象月、最新N、Slot予約可能状態、新規classification、既存未開始Reservationへのclassification影響を再確認する業務的Snapshotとする。Serverは最新確定状態から再計算し、ClientのExpected Stateを更新値・正本として扱わない。Expected Stateとは別に操作識別子によるIdempotencyを適用し、同一内容の再送で新規Reservationを重複作成せず、異なる内容での同一識別子再利用を別操作として実行せずRejectする方針をIssue #72で確定した。
- 管理者向けAPIのActor / Target Scope原則、および月間Schedule取得・初回生成・変更Preview / Confirm・公開の基本形は `OI-BD-009` で確定した。
- 管理者Schedule生成は未生成月の初回生成に限定し、既生成月をgenerateで上書きしない。要求仕様v1.8の `AC-301-010` と整合する。
- 予約影響を伴うSchedule変更は、必要なschool cancellation、Occupancy終了、再分類、AuditLog、NotificationIntentを原因となるSchedule変更と同一の原子的業務Transaction境界で扱う。
- 公開済み月の将来枠変更は再公開を要求せず、正常Commit後ただちに最新確定状態として扱う。
- 管理者向け分類管理では、月間標準回数変更と月間回数除外設定・解除は未開始Reservationへ波及し得るためPreview / Confirmとし、Classification Overrideは対象Reservationだけに作用するため専用Preview APIを設けない。
- 月間回数除外解除は無条件な再算入ではなく、`ReservationMonthlyCountOverride` 解除後に予約状態・欠席等の最新条件から実効算入可否を再評価する。要求仕様v1.9の `AC-308-002` と整合する。
- 月間回数除外の設定・解除で未開始Reservationの区分が変化する場合は、`AC-308-003` に従いLesson日時と変更前後classificationを確定前に提示する。
- Classification Overrideは対象Reservationの実効classificationだけを変更し、自動標準枠や他Reservationのautomatic_classificationを変更しない。
- スクール都合キャンセル単独操作はPreview / Confirmとし、通常取消／事後登録はServer Commit基準時刻とLesson開始時刻からServer側で判定する。要求仕様v1.10の `AC-313-005〜009` と整合する。
- 事後スクール都合キャンセルでは取消時刻を実際のServer Commit時刻とし、Slotを再開放しない。欠席が記録済みの場合は先に欠席を明示解除し、school cancellationの副作用として暗黙解除しない。
- 事後登録の「実際にLessonが実施されなかった」という業務事実は管理者が明示確認し、AuditLogから追跡可能にする。事後登録であることは `AC-103-004` に従い生徒通知でも明示する。
- 欠席設定・解除は、いずれも月間算入状態を変えて未開始Reservationへ再分類影響が波及し得るためPreview / Confirmとする。要求仕様v1.11の `AC-315-005` と整合する。
- 欠席設定は終了済みの未取消confirmed Reservationだけに行い、Reservationライフサイクル、Slot、Occupancyを変更せず、対象Reservationを分類対象外とした上で必要な未開始Reservation再分類を行う。
- 欠席解除は無条件な再算入ではなく、`ReservationAbsence` 解除後に月間回数除外等の最新条件から実効算入可否を再評価する。欠席設定・解除そのものの専用メールは生成せず、波及したstandard / additional区分変更だけ `REQ-104` に従い通知する。
- Security Suspensionは休会・退会・削除・Reservation取消とは別のSecurity Access Stateとして扱い、設定・解除には専用Preview APIを設けず管理画面上の確定前説明で `AC-316-001〜003` を満たす。
- Security Suspension停止時は既存Student Sessionを即時失効させ、停止中は新しいSessionを発行せず、解除しても停止前Sessionを復活させない。具体revocation方式は認証・Session基本設計で確定する。
- Security SuspensionとStudent Write Commandの並行時は先行正常Commitを優先し、停止が先行Commitされた場合は後続Student WriteをCommit時Guardで成立させない。停止・解除自体ではReservation、SlotOccupancy、月間算入、classificationを変更しない。
- 生徒削除はPreview / Confirmとし、削除確定時に利用不能化、Session失効、将来confirmed Reservation全件の `system_cancelled(reason_code = student_deleted)`、Occupancy終了、開始前Slotの再開放、個人情報削除・匿名化義務の永続化、AuditLogを同一TransactionでAll-or-Nothingに確定する。
- 生徒削除Preview後に将来Reservation対象集合が変化した場合は部分適用せずConflictとして再Previewへ戻す。Lesson開始済み・過去Reservationは削除を理由に遡及キャンセルしない。
- 生徒削除Commandの成功と個人情報の実削除・匿名化完了は分離し、後者は24時間以内の後続処理とする。生徒削除起因system cancellationには専用キャンセルメールを生成しない。
- プロフィール代理支援は氏名変更と連絡先メール変更開始を別Commandとし、汎用プロフィールPATCHへ統合しない。氏名は正常Commitで即時反映し、連絡先メールは新メール所有確認完了まで旧メールを有効な連絡先として維持する。
- 管理者による連絡先メール変更でも新メール所有確認を省略せず、Google認証紐付けは連絡先メール変更だけでは変更しない。1 Studentにつき有効なメール変更Pendingは最大1件とし、新しい変更開始時は古いPendingを無効化する。
- 旧メールが利用不能でも管理者が変更を開始し、新メール所有確認を完了すれば連絡先メールを復旧できる。旧メール側の確認は必須とせず、旧メールへのSecurity Notice失敗は確定変更をRollbackしない。変更依頼者本人の確認方法はシステム要件化せずスクールの運用判断とする。
- Security Suspension中は生徒本人・管理者代理のいずれのプロフィール変更も成立させず、Pendingメール変更も停止中には確定しない。
- 基本設計では読みやすさを優先し、`PII` の略語を原則使わず「個人情報」、必要に応じて「氏名・連絡先メール・認証識別子等の直接管理する個人情報」と記載する。
- Transaction境界とD1実行方式は `05_BookingAndConcurrency.md` を正とする。
- 保存モデルと表示モデルの分離は `02_DataModel.md` の原則をAPI境界にも適用する。
- 要求仕様v1.5で追加された `BR-068` および `AC-003-019, AC-003-020` を受け、生徒本人APIの対象Student決定Ruleを4.1へ共通原則として集約した。
- `REQ-003 / AC-003-021` に従い、予約Previewでは新規予約による既存未開始Reservationのclassification影響差分を最終確定前に表示可能な形で返す。
- `REQ-301 / AC-301-009` に従い、Schedule複数変更のConflictでは検出できた競合対象・業務理由・再確認用の最新状態を提示可能とし、全競合の完全列挙は保証しない。
