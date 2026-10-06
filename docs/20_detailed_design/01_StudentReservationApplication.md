# 単一予約 Application Component・API 詳細設計

## 1. 適用範囲と正本

初期リリースの生徒本人による月間Schedule取得、単一予約Preview / Confirm、予約履歴Queryの4 Endpointを定義する。`docs/10_basic_design/06_APIOverview.md` §2〜5、§8、§10〜11、`05_BookingAndConcurrency.md` §4〜5、`03_ScheduleModel.md`、`04_ReservationModel.md`の業務境界を入力とする。一括予約、キャンセル、認証Providerは本書の対象外である。D1物理Table / Index / SQL / migrationは `02_StudentReservationD1.md` を正とする。

図の正本は `../diagrams/plantuml/c4-student-reservation-components.puml` と `../diagrams/plantuml/student-reservation-sequence.puml`。C4 Level 3は `01_SystemArchitecture.md` の単一Application Worker内の論理責務を示し、別Deploy Unitを意味しない。

## 2. Component責務

| Component | 責務と境界 |
| --- | --- |
| Web/UI Presentation | 月間Calendar / List、Preview確認、確定状態、競合時の再確認、本人履歴を表示する。追加区分には `AC-003-008` の再分類可能性を示し、金額と配送成功を表示しない。 |
| HTTP Router / API Adapter | Path、Method、JSON / Queryの形と型を検証し、Application View / ErrorをHTTPへ変換する。本人Identityや業務状態をRequest値から決定しない。 |
| Student Session / Authorization Guard | 各Requestで`06_APIOverview.md` §10のStudent Session、期限・失効、Account / Role、最新access state / lifecycleを検証し、内部生徒IDを解決する。生徒の予約操作可否も確認する。Session失効は401、有効な認証済みSessionにStudent操作権限がない場合は403とする。 |
| Schedule Query Application Service | 公開月と本人の確定状態から、各Slotにつき矛盾しない単一Viewを導出する。 |
| Reservation Preview Application Service | 対象Slot、公開、開始境界、占有、本人月間分類と既存未開始Reservationの区分差分を評価し、確認用ViewとExpected State Tokenを返す。業務状態は変更しない。 |
| Reservation Confirm Application Service | 最新確定状態を再評価し、Expected State一致と業務Guard成立時だけ予約Commandを確定する。結果はCommit済みのViewで返す。 |
| Reservation History Query Application Service | 本人のReservation履歴を安定順序でPage化し、ライフサイクル、欠席、実効分類を分離して返す。 |
| Reservation / Classification Domain Service | `BR-050〜059 / BR-066〜068` の予約可否、Slot View、月間算入、自動分類、実効分類、変更差分を計算する。 |
| Repository / Transaction Port | 確定業務状態の読取と単一予約Commandの原子的Commitを提供する。Guard失敗・Invariant異常では部分Commitしない。D1 Adapterの物理方式は `02_StudentReservationD1.md`。 |
| Audit Port | `REQ-940` に従う予約確定Audit義務を同じ業務Transactionへ渡す。 |
| Notification Intent Port | `REQ-101 / REQ-104` に従う予約確認および必要な区分変更Intentを同じ業務Transactionへ渡す。配送はCommit後の別責務。 |

RouterはGuardを経ずにServiceへ本人対象を渡さない。Repository / Audit / Notificationの予約Confirm物理D1境界は `02_StudentReservationD1.md` を参照する。

## 3. 共通wire規則

- APIは`/api/...`でVersion Namespaceを設けない。本人APIは`/api/me/...`とし、対象本人を選ぶ`studentId`、メール、Google ID、RoleをRequestへ持たせない。Responseも内部生徒IDを不要に露出しない。本人は毎RequestのGuardから解決する。
- JSON fieldはlowerCamelCase。Resource IDとcursorはopaque stringであり、D1 rowid、内部sort key、保存Modelをwire契約にしない。API ModelとD1保存Modelを分離する。
- Business datetimeはRFC 3339のoffset付き文字列とし、Asia/Tokyoの業務日時として一意に解釈できる値を返す。例は`2026-11-01T10:00:00+09:00`。`{month}`は暦月`YYYY-MM`。時刻の業務判定は信頼できるServer時刻を使う。
- 明示したfieldは必須とする。配列は影響なしなら`[]`、次Pageなしなら`nextCursor: null`。Requestの未定義fieldは`INVALID_REQUEST`として拒否し、本人指定や更新値として利用しない。無効なPath / Query / JSON、型、`limit`も`INVALID_REQUEST`。
- 通常ResponseはJSON。PreviewはHTTP POSTだが業務状態を変えないQuery。ConfirmだけがCommandである。

## 4. `GET /api/me/schedule-months/{month}`

公開済み月のSlotだけを返す。未公開または存在しない月は`SCHEDULE_MONTH_NOT_AVAILABLE`。`slots`はSlot日時昇順、同時刻はServer内の安定順とする。各Slotの`view`は同じ確定状態から導出した次の1値である。

| `view` | 意味 |
| --- | --- |
| `bookable` | 本人が現在新規予約できる。 |
| `reserved_by_me` | 本人のconfirmed Reservationが現在占有する。 |
| `group_lesson` | GroupLessonが占有する。 |
| `unavailable` | その他の予約不可。開始済み、disabled、AdminHold、他生徒の占有等の内部理由を区別しない。 |

Response例:

```json
{
  "month": "2026-11",
  "slots": [{"slotId":"opaque-id","startsAt":"2026-11-01T10:00:00+09:00","endsAt":"2026-11-01T11:00:00+09:00","view":"bookable"}]
}
```

`reserved_by_me`に限り本人表示用の`reservationId`と`classification`（`standard | additional | not_applicable`）を追加してよい。他のViewにはこれらを付けず、他生徒の識別子・個人情報を返さない。不整合な未来Slot状態は予約可能と推測せずfail-closedする（`BR-067`）。

## 5. `POST /api/me/reservations/preview`

Requestは`{"slotId":"opaque-id"}`。Responseは次の形とする。

```json
{
  "slot": {"slotId":"opaque-id","startsAt":"2026-11-01T10:00:00+09:00","endsAt":"2026-11-01T11:00:00+09:00"},
  "previewClassification": "standard",
  "classificationChanges": [{"reservationId":"opaque-id","startsAt":"2026-11-08T10:00:00+09:00","before":"standard","after":"additional"}],
  "expectedStateToken": "v1.opaque"
}
```

`previewClassification`は`standard | additional`。`classificationChanges`は今回の予約によって実効分類が変わる**本人の未開始Reservationのみ**とし、`before` / `after`も`standard | additional`。開始日時とReservation IDの安定順で返す。UIは日時、新規分類、全差分を最終確定前に提示し、追加の場合は開始前に再分類され得る旨を示す。金額は示さない。

### 5.1 Expected State Token

ServerはPreview時点の業務Snapshotを決定的にcanonical化し、version prefix `v1.` とfingerprint（例: SHA-256のbase64url値）からなるopaque tokenを生成する。Snapshotには少なくとも、Guardが解決した本人、対象Slotとその日時・対象月、公開・利用可否・現在占有・開始境界を含む予約可否、信頼できる時刻で判定するLesson開始境界に必要な状態、最新の月間標準回数N、新規実効classification、本人の影響する未開始Reservation集合と各変更前後の実効classificationを含める。差分表示が空でも集合を明示的にcanonical化する。実装時はfield順、配列順、日時正規化、値型、versionごとのSnapshot定義を固定し、同一業務状態で同じtokenが得られるようにする。内部Snapshotや保存Modelはwireへ出さない。

Clientはtokenをそのまま保持し、Confirmでは`slotId`とtokenのみ送る。Tokenは認可・改ざん防止の唯一のSecurity boundaryではない。ConfirmはSession本人を再解決し、同じversionのSnapshotを最新確定状態からCommit直前に再計算してfingerprintを比較する。未知version、欠損・不正形式は`INVALID_REQUEST`。一致しても最新業務GuardとTransaction上の一意性・整合性を省略しない。PreviewはSlotの確保や将来のCommitを保証しない。

## 6. `POST /api/me/reservations`

Requestは`{"slotId":"opaque-id","expectedStateToken":"v1.opaque"}`。正常時HTTP `201 Created`。Response例:

```json
{
  "reservation": {"reservationId":"opaque-id","startsAt":"2026-11-01T10:00:00+09:00","endsAt":"2026-11-01T11:00:00+09:00","reservationState":"confirmed","classification":"standard"},
  "slot": {"slotId":"opaque-id","startsAt":"2026-11-01T10:00:00+09:00","endsAt":"2026-11-01T11:00:00+09:00","view":"reserved_by_me"},
  "classificationChanges": []
}
```

`classificationChanges`のitemは§5と同形で、同じTransactionで実効分類が変わった本人の未開始Reservationを返す。Serverは本人の予約操作可否、公開月、Slot利用可否と占有、開始前、月間分類・既存Reservationへの差分、未来Slot Invariantを最新状態で再検証する。Preview後にSnapshotの業務上の意味が変わった場合は全体未適用の`RESERVATION_STATE_CHANGED`で再Previewへ戻す。Slotが現在予約不可、開始境界を越えた等の業務拒否も状態を推測して上書きしない。`standard → additional`と逆方向に同じ規則を適用する。

正常Commitは、新規ReservationとSlotOccupancy、必要な再分類、AuditLog、予約確認NotificationIntent 1件、必要な区分変更NotificationIntentを1つの業務Transactionで確定したことを意味する。`201`は外部Providerの受付・配送完了を表さず、Responseに配送成功fieldを設けない。UIは確定業務状態を画面に表示し、メール配送と混同しない。通知失敗で確定済み予約をRollbackしない。具体的なTransaction Guardと通知pickup境界は `02_StudentReservationD1.md` を参照する。

## 7. `GET /api/me/reservations`

Queryは`limit`（任意、既定50、1〜100の整数）と`cursor`（任意、opaque string）のみ。`startsAt DESC`、同値はopaque `reservationId`に対応するServer内部の安定tie-breakerで全順序とし、sort keyをwireに露出しない。Cursorはその全順序における直前Page末尾の位置を表す。初回はcursorなし、次Pageは返された`nextCursor`をそのまま送る。不正なcursorは`INVALID_REQUEST`。Page間に状態が変化した場合のSnapshot固定は約束しない。

```json
{
  "items": [{"reservationId":"opaque-id","startsAt":"2026-11-01T10:00:00+09:00","endsAt":"2026-11-01T11:00:00+09:00","reservationState":"confirmed","attendanceState":"none","classification":"standard"}],
  "nextCursor": null
}
```

`nextCursor`は続きがあるときだけopaque string、それ以外は`null`。`reservationState`は`confirmed | student_cancelled | school_cancelled | system_cancelled`、`attendanceState`は`none | absent`、`classification`は現在の実効区分`standard | additional | not_applicable`。取消、欠席、分類対象外を単一状態に統合しない。本人の履歴のみを返す。

## 8. Application Error contract

失敗時は以下の共通JSON envelopeを返す。`message`は利用者向け、`retry`は次の行動を表す安定値`none | repreview | reload | later`。HTTP statusだけを業務分岐の唯一の情報にしない。

```json
{"error":{"code":"RESERVATION_STATE_CHANGED","message":"表示後に状態が変更されました。内容を再確認してください。","retry":"repreview"}}
```

| code | HTTP | 適用と`retry` |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | Path / Query / JSON / token形式が不正。`none`。 |
| `UNAUTHENTICATED` | 401 | 有効な認証済みSessionがない。`none`。 |
| `FORBIDDEN` | 403 | 認証済みだがStudent role / self-scope操作権限がない。`none`。 |
| `SCHEDULE_MONTH_NOT_AVAILABLE` | 404 | 指定月が公開済みでない。`none`。 |
| `RESERVATION_NOT_AVAILABLE` | 409 | 対象Slotが予約不可または本人の新規予約条件を満たさない。`reload`。 |
| `RESERVATION_WINDOW_CLOSED` | 409 | Server時刻でSlot開始以降。`reload`。 |
| `RESERVATION_STATE_CHANGED` | 409 | Preview後の重要状態または分類影響が変化した。`repreview`。 |
| `SERVICE_UNAVAILABLE` | 503 | Maintenance、環境identity / feature exposureのfail-closed、D1障害等。`later`。 |
| `INTEGRITY_STATE_UNAVAILABLE` | 503 | 永続化済みInvariant違反等の整合性異常。`later`。 |

#831の人間判断で確定した、Schedule Query HTTP統合に使用する利用者向け`message`は以下とする。既存code / HTTP / retry / 認可・fail-closedの意味は変更しない。

| code | message |
| --- | --- |
| `INVALID_REQUEST` | 入力内容を確認してください。 |
| `UNAUTHENTICATED` | 認証が必要です。 |
| `FORBIDDEN` | この操作は利用できません。 |
| `SCHEDULE_MONTH_NOT_AVAILABLE` | 指定された月の予定は利用できません。 |
| `SERVICE_UNAVAILABLE` | 現在サービスを利用できません。時間をおいて再度お試しください。 |
| `INTEGRITY_STATE_UNAVAILABLE` | 現在予定情報を利用できません。時間をおいて再度お試しください。 |

404では未公開と不存在を区別せず、401ではSession失効理由を説明しない。503ではD1障害内容や永続化Invariantの具体的異常を説明しない。

`FORBIDDEN`の利用者向け`message`は「この操作は利用できません。」とし、内部Role、lifecycle、Resourceの存在を説明しない。Security Suspensionや削除等でSessionが失効した場合は`UNAUTHENTICATED`を使い、403のために失効Sessionを有効扱いしない。Confirmではtokenと最新Snapshotが異なる場合に`RESERVATION_STATE_CHANGED`を使う。Preview時点から予約不可なら`RESERVATION_NOT_AVAILABLE`、開始済みなら`RESERVATION_WINDOW_CLOSED`を使う。認証・利用可否などのGuardを先に評価し、token一致だけで確定しない。409では安全に導出できるときだけ`error.latestSlot`（§4の本人向けSlot itemと同形）または再Previewに必要な本人向け情報を付けられる。これは完全な競合列挙を保証しない。SQL Error、Constraint / Table / Column名、内部Invariant code、他生徒の識別子・個人情報を返さない。内部診断は技術Log / Monitoringへ分離する。

## 9. UI / API FlowとTraceability

Sequence正本は上記PlantUMLを参照する。各RequestでGuardを通す。Scheduleを取得しSlotを選択、Previewの日時・新規分類・既存予約への差分を確認した後だけConfirmを送る。`201`では確定状態を表示する。`409`では最新の安全なSlot Viewまたは再取得案内を示し、再Preview・再確認へ戻す。履歴は確定状態の参照手段とする。Google / Magic Linkの認証実装は本書では定義しない。

| 詳細設計箇所 | 上位識別子 | 既存要求ベースTest |
| --- | --- | --- |
| §2〜4 Schedule / Self Scope | REQ-001 / 002、AC-001-001〜004 / AC-002-001〜002、BR-015 / 017 / 067 / 068 / 090 | `docs/40_test/02_FunctionalTestSpecification.md` の対応TC |
| §5〜6 Preview / Confirm | REQ-003 / 101 / 911、AC-003-001〜008 / 016〜021、AC-101-001〜002、BR-050〜059 / 066〜068 / 112 | 同上、および `02a_ReservationOwnershipTestSpecification.md` |
| §7 履歴 | REQ-005、AC-005-001〜002、BR-066 | `02_FunctionalTestSpecification.md` の対応TC |
| §8 Error / Audit | REQ-914 / 940、POL-014、BR-111 | `03_NonFunctionalTestSpecification.md` の対応TC |

`REQ-911 / 914 / 940`、`OOS-001 / 002`を含む既存POL→BR→REQ→AC→TCの関係は変更しない。予約確認のwireに月間回数・料金は含めず、管理者代理予約を導入しない。D1物理Schema / migration / Transaction Guardは `02_StudentReservationD1.md` で確定する。単一予約Application実装は、詳細設計・基盤確定後に#608配下の後続実装Issueとして切り出す。#536は本体build / test / PR CI基盤、#537は操作評価環境、#538はAI Developer runtime適合を扱う。
