# 生徒 Application Component・予約API・認証HTTP 詳細設計

## 1. 適用範囲と正本

初期リリースの生徒本人による月間Schedule取得、単一予約Preview / Confirm、予約履歴Queryの4 Endpointを定義する。`docs/10_basic_design/06a_APICommonPrinciples.md` §2〜5、§8、§10、`docs/10_basic_design/06_APIOverview.md` §11、`05_BookingAndConcurrency.md` §4〜5、`03_ScheduleModel.md`、`04_ReservationModel.md`の業務境界を入力とする。一括予約、キャンセルは本書の対象外である。#840のStudent認証HTTP / Provider Flowは§10で定義する。D1物理Table / Index / SQL / migrationは `02_StudentReservationD1.md` を正とする。

図の正本は `../diagrams/plantuml/c4-student-reservation-components.puml` と `../diagrams/plantuml/student-reservation-sequence.puml`。C4 Level 3は `01_SystemArchitecture.md` の単一Application Worker内の論理責務を示し、別Deploy Unitを意味しない。

## 2. Component責務

| Component | 責務と境界 |
| --- | --- |
| Web/UI Presentation | 月間Calendar / List、Preview確認、確定状態、競合時の再確認、本人履歴を表示する。追加区分には `AC-003-008` の再分類可能性を示し、金額と配送成功を表示しない。 |
| HTTP Router / API Adapter | Path、Method、JSON / Queryの形と型を検証し、Application View / ErrorをHTTPへ変換する。本人Identityや業務状態をRequest値から決定しない。 |
| Student Session / Authorization Guard | 各Requestで`06a_APICommonPrinciples.md` §10のStudent Session、期限・失効、Account / Role、最新access state / lifecycleを検証し、内部生徒IDを解決する。生徒の予約操作可否も確認する。Session失効は401、有効な認証済みSessionにStudent操作権限がない場合は403とする。D1正本・Request解決・Write内部Contextは`02_StudentReservationD1.md` §8を参照する。 |
| Schedule Query Application Service | 公開月と本人の確定状態から、各Slotにつき矛盾しない単一Viewを導出する。 |
| Reservation Preview Application Service | 対象Slot、公開、開始境界、占有、本人月間分類と既存未開始Reservationの区分差分を評価し、確認用ViewとExpected State Tokenを返す。業務状態は変更しない。 |
| Reservation Confirm Application Service | 最新確定状態を再評価し、Expected State一致と業務Guard成立時だけ予約Commandを確定する。結果はCommit済みのViewで返す。 |
| Reservation History Query Application Service | 本人のReservation履歴を安定順序でPage化し、ライフサイクル、欠席、実効分類を分離して返す。 |
| Reservation / Classification Domain Service | `BR-050〜059 / BR-066〜068` の予約可否、Slot View、月間算入、自動分類、実効分類、変更差分を計算する。 |
| Repository / Transaction Port | 確定業務状態の読取と単一予約Commandの原子的Commitを提供する。Guard失敗・Invariant異常では部分Commitしない。D1 Adapterの物理方式は `02_StudentReservationD1.md`。 |
| Audit Port | `REQ-940` に従う予約確定Audit義務を同じ業務Transactionへ渡す。 |
| Notification Intent Port | `REQ-101 / REQ-104` に従う予約確認および必要な区分変更Intentを同じ業務Transactionへ渡す。配送はCommit後の別責務。 |
| Student CSRF HTTP Adapter（設計、未実装） | §10.3〜4の取得GETを担当する。初回隔離評価のsession branchとProduction全契約の境界は§9.2。生成とunsafe POST検証は同じ純粋関数を共有する。 |

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

#865のHTTP実装はexact `POST /api/me/reservations/preview`、Queryなし、
`Content-Type: application/json`、UTF-8 body最大8192 byte、非空stringの`slotId`だけを受け付ける。
欠損・null・未定義field・重複key・不正JSON／UTF-8・超過bodyは`INVALID_REQUEST`。
HTTPSとRequest shapeの検査後、D1 §8.3のSession解決→§10.3のSession-bound CSRF / Origin→
業務認可の順とし、有効なforbidden SessionもCSRF検証後だけ403を返す。
Guard失敗・503またはCSRF不成立ではPreview read / coreへ進まない。
成功時は既存D1 read / pure coreから以下のViewだけを返し、全Responseは`Cache-Control: no-store`。
401だけ§10.2のSession Cookieを除去する。実装とisolated検証範囲は
[`src/README.md`](../../src/README.md) / [`tests/README.md`](../../tests/README.md)を参照し、public routeは有効化しない。

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

#869の実装範囲はwrite前preparationのみ。Guard解決済み本人・Slot・Expected State Tokenから、
read前のcanonical v1形式検証、共有Primary captureと既存Preview計算による最新token再照合を行う。
現在の業務拒否を優先し、一致時だけimmutableなserver-only prepared stateを返す。
内部分類planは未開始算入対象の全automatic / effective before / afterを保持し、
§5のwire差分は実効値が変化するものだけを維持する。実装・検証範囲は
[`src/README.md`](../../src/README.md) / [`tests/README.md`](../../tests/README.md)を参照する。
#872はprepared stateからDB副作用のないserver-only Transaction write planと、以下の成功Viewのprojectionを生成する。
ID生成・本人一致・全分類Guard対象と実更新対象の分離・Audit / Intent exact encodingはD1正本§2 / §5を参照する。
#873はD1正本§5の内部single-batch executorを実装する。preparation / plan生成成功を予約成立と扱わず、
正常batch応答でのみ成功projectionを返す。応答不明の内部handoffはD1正本§5を参照する。
#874は応答不明時のread-only Primary verificationと最終server-only Transaction Portを実装する。
内部3分類と専用error codeはD1正本§5.1を参照する。HTTP接続・fresh revalidationによるHTTP分類は以下の#880を参照する。

#880のisolated `ReservationConfirmHttpAdapter` はexact `POST /api/me/reservations`、Queryなし、
`Content-Type: application/json`、UTF-8 body最大8192 byteを受け付ける。
Requestは非空stringの`slotId` / `expectedStateToken`の2 fieldだけとし、field順は問わない。
欠損・null・型不正・extra field・duplicate key・不正JSON／UTF-8・超過は400 `INVALID_REQUEST`、
非HTTPSは503 `SERVICE_UNAVAILABLE`とし、いずれもSession解決前に拒否する。
§10.3のSession解決→Session-bound CSRF / exact Origin・Fetch metadata→forbidden判定を経て、
#869 `prepare(slotId, expectedStateToken, { studentId })`を1回、成功時だけ#874 `commit(prepared, context)`を1回呼ぶ。
Contextは同じRequestの解決結果をそのまま渡す。tokenのcanonical形式検証と現在業務拒否の優先順位は#869を維持する。
成功時は最終Portのexact committed resultだけを201で返し、全Responseは`Cache-Control: no-store`。
401だけ§10.2のCookieを除去し、内部error / Session / raw read setを公開しない。

exact internal `REVALIDATION_REQUIRED`の場合だけ、同じRequestでfresh Primary Session解決を1回行う。
失効は401、forbiddenは403、DB / integrity失敗は既存503とし、認証成功後だけ同じ入力とfresh本人で
read-only preparationを1回行う。安全に確定した`RESERVATION_NOT_AVAILABLE` / `RESERVATION_WINDOW_CLOSED`は409 / reload、
`RESERVATION_STATE_CHANGED`は409 / repreview、DB / integrity失敗は既存503へ変換する。
再preparation成功で業務理由を証明できなければ503 `SERVICE_UNAVAILABLE`へfail-closedする。
CSRF再検証・write retry・ID / plan再生成は行わず、その他のTransaction errorではfresh revalidationもしない。
実装・partial evidenceは上記READMEを参照する。default Worker / public routeは未接続、Schema変更はない。

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

#888のisolated `ReservationHistoryHttpAdapter` はHTTPS / exact GET・Path / bodyなしを検査し、
未定義・重複Queryを拒否する。`limit`はdecimal digitsのみで既定50、1〜100。
毎Requestで既存`StudentAccessGuard.authorize()`を使い、本人IDだけをQuery Serviceへ渡す。
GETではSession CSRFを要求せず、401 Cookie除去と全Responseの`Cache-Control: no-store`は既存HTTP共通処理を再利用する。
ApplicationはD1正本§4の順序・`limit + 1`・cursorを使い、型・件数・重複・日時・enum異常を
`INTEGRITY_STATE_UNAVAILABLE`、不正cursorを`INVALID_REQUEST`、D1 / signing利用不能を`SERVICE_UNAVAILABLE`とする。
`TC-F-005-01`はApplication / D1 / HTTP partial evidenceのみ。default Worker / public routeは未接続で503を維持する。

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

#608の人間判断を#865で同期した、単一予約Previewの409固定messageは以下とする。
既存code / HTTP / retryの意味は変更しない。`CSRF_INVALID`の固定messageは§10.8を参照する。

| code | message |
| --- | --- |
| `RESERVATION_NOT_AVAILABLE` | この枠は現在予約できません。予定を再読み込みしてください。 |
| `RESERVATION_WINDOW_CLOSED` | この枠の予約受付は終了しました。予定を再読み込みしてください。 |

404では未公開と不存在を区別せず、401ではSession失効理由を説明しない。503ではD1障害内容や永続化Invariantの具体的異常を説明しない。

`FORBIDDEN`の利用者向け`message`は「この操作は利用できません。」とし、内部Role、lifecycle、Resourceの存在を説明しない。Security Suspensionや削除等でSessionが失効した場合は`UNAUTHENTICATED`を使い、403のために失効Sessionを有効扱いしない。Confirmではtokenと最新Snapshotが異なる場合に`RESERVATION_STATE_CHANGED`を使う。Preview時点から予約不可なら`RESERVATION_NOT_AVAILABLE`、開始済みなら`RESERVATION_WINDOW_CLOSED`を使う。認証・利用可否などのGuardを先に評価し、token一致だけで確定しない。409では安全に導出できるときだけ`error.latestSlot`（§4の本人向けSlot itemと同形）または再Previewに必要な本人向け情報を付けられる。これは完全な競合列挙を保証しない。SQL Error、Constraint / Table / Column名、内部Invariant code、他生徒の識別子・個人情報を返さない。内部診断は技術Log / Monitoringへ分離する。

## 9. UI / API FlowとTraceability

Sequence正本は上記PlantUMLを参照する。各RequestでGuardを通す。Scheduleを取得しSlotを選択、Previewの日時・新規分類・既存予約への差分を確認した後だけConfirmを送る。`201`では確定状態を表示する。`409`では最新の安全なSlot Viewまたは再取得案内を示し、再Preview・再確認へ戻す。履歴は確定状態の参照手段とする。Google / Magic Linkの認証HTTP / Provider Flowは§10、永続化・Session発行合成はD1正本§9を参照する。

### 9.1 #608初回Browser presentationと状態遷移（#892）

対象は `/student` の公開月確認→単一Preview→明示Confirm→本人履歴である。標準HTML / CSS / Browser JavaScriptと既存TypeScript / Workers構成を最小選択とし、新SPA framework、router、状態管理package、汎用design system、E2E専用基盤を先行導入しない。配信・buildのexact方式は、既存CIで新Browser sourceのbuild / lint / testが可能なことを後続実装Issueが確認して定める。本設計は未検証の配信方式を固定しない。

| Browser状態 / 操作 | 表示・遷移と送信条件 |
| --- | --- |
| 月選択・読込 | 指定した `YYYY-MM` に§4のGETを行う。公開月一覧APIは追加しない。404は§8の案内を表示し別月選択へ戻す。calendar / listは同じSlot Viewを用い、4値を文字で区別し、`bookable`だけを新規予約選択対象とする。 |
| 枠選択・Preview中 | 選択Slotに§5のPOSTを送る。選択だけでConfirmしない。読込中は確定操作を無効にする。 |
| Preview確認 | 開始・終了日時をAsia/Tokyoで表示し、`previewClassification`、`classificationChanges`全件の日時とbefore / afterを提示する。差分は省略せず、追加はAC-003-008の説明を含め、継続を妨げない。内容を確認してからだけ明示Confirmを可能にする。 |
| Confirm中 | §6の `slotId / expectedStateToken` のみを送る。二重操作を抑止し、同じ確認からの自動再送をしない。UIの抑止はServerのTransaction Guardを代替しない。 |
| 201確定 | Commit済みResponseの日時・予約状態・分類・区分変更を表示する。NotificationIntent commitと配送成功を混同しない。Scheduleを更新し、§7の本人履歴へ進める。 |
| 履歴 | 予約状態、欠席、現在の実効分類を分離し、返された `nextCursor` で次Pageを読む。最新状態の確認はcursorなしの再取得とし、Page間Snapshot固定は主張しない。 |
| 月 / 枠変更、409、Session失効 | 保持したExpected State Tokenと確認状態を破棄し、fresh Schedule→必要なPreview→人間再確認へ戻す。古い非同期Responseを新しい月 / 枠の確認として採用しない。失効時は下記401の停止を優先する。 |

Expected State TokenはUI memoryに保持し、内部Snapshotを復元・表示しない。失効はServerのSession / Guard判定に従い、tokenの独自TTLやClient時刻によるCommit可否を追加しない。画面には他生徒PII、料金、月間標準回数N、内部Session / hash / Snapshotを出さない。日時・分類・差分は色だけに依存せず、月選択・表示切替・枠選択・Preview・Confirm・履歴をkeyboardで操作でき、focusが見えることを最小受入条件とする。Preview / 結果 / エラーへのfocus移動で現在状態を把握でき、320 CSS px以上の狭幅でも全差分と確定操作を確認できることを検証する。通常Page全体の横scrollを避け、calendar / table内部の局所scrollはREQ-902に従う。

エラーは§8 / §10.8のcode / message / retryを使用する。401は確認状態・memory CSRFを破棄し認証が必要と案内して停止する（隔離評価ではtrusted setupへ戻り、未実装loginを成功扱いしない）。403は操作不可、`CSRF_INVALID`は再読込・CSRF再取得と再確認を案内する。401以外はCookieを除去しない。409は安全な最新Viewを案内して上表へ戻す。503、通信断、応答不明は予約成立と表示せず、確認状態とExpected State Tokenを破棄して停止し、Confirmを自動再送しない。安全に本人履歴 / Scheduleを再取得できても、それはread-onlyの状態確認であり書込み再試行ではない。201を受け取らなかった操作の成功を推測せず、履歴では取得した現在状態だけを表示する。

### 9.2 Browser Session / CSRFと隔離composition

Session Cookieと取得GET / unsafe POSTのProduction正本は§10.2〜4、D1 Guard / Write predicateはD1正本§8、履歴cursor署名は同書§4を参照する。UIはHttpOnly Cookieを読まず、全APIをHTTPSの同一originへsame-origin fetchする。canonical originはServer設定の完全一致値とし、Request Hostから作らない。CSRF取得GETのsame-origin検証とunsafe POSTのOrigin / `X-CSRF-Token` / Fetch Metadataを省略しない。

初回評価では有効Sessionから `GET /api/auth/student/csrf` の `scope: "session"` を取得し、CSRF tokenをmemoryだけに保持する。storage / URL / Logへ保存しない。後続CSRF実装は#865 `src/http/student-session-csrf.ts` の生成式を一つの純粋関数へ抽出し、取得と検証で共有する（domain separationを変更しない）。**Productionのsession / preauth双方の契約は維持する**。先行session branchは評価専用入口に限定し、Sessionなしではtokenを返さず401へfail-closed、不正 / 失効Sessionも401、判定不能は既存503とする。preauthの発行 / 再利用やAuth flowの完了は証明せず、Production取得Endpointへの接続は全契約実装・検証後の別責務とする。

| composition案 | 初回評価への判断 |
| --- | --- |
| default Workerをflagで評価用に切り替える | 採用しない。通常 `src/index.ts` の503と `wrangler.jsonc` のremote binding / routeなしを維持し、fixture / 評価routeへの到達を開かない。 |
| 評価専用entrypoint / configで既存Adapterを明示合成する | 採用する。HTTPS local Worker / 隔離local D1へ既存4 API、Production StudentAccessGuardとProduction Repository / Transaction Adapterを接続する。exact file / command、cert / origin整合は後続で実証する。 |
| 固定fake Guard / HTTP debug loginでBrowser操作する | 採用しない。D1本人解決・失効・Write predicateの証明にならず、認可迂回になる。既存単体mapping fixtureの用途をBrowser評価へ昇格しない。 |

operator / trusted test setupだけが隔離DBへ架空Student / Account / Session / 公開Slotをseedする。Production migrations `0001〜0012`と既存Self Scope / single-batch Guardを再利用し、test-only番号をProduction番号として流用しない。Session tokenの生成・hash保存はD1 §8.2を満たし、test-owned BrowserContextへ§10.2属性のCookieを設定する。通常HTTPにseed / login入口を設けず、identity header / query / env、token allowlist、allow-all Guardで本人を注入しない。実利用者data・Production resource / credentialは使わない。

cursor用鍵はoperator / trusted server setupでWeb CryptoのHMAC-SHA-256署名鍵を生成し、評価環境専用のserver-only `CryptoKey`を既存Codec constructorへ注入する。localではtest lifecycle内で保持し、Browserへ渡さず終了時に破棄する。remote provisioningは#537の承認済みsecret store手順の責務で、通常vars / Request / Query由来の鍵、source hardcode、Production鍵共有、client bundleへの混入を禁止する。setup権限を通常Student / Admin Roleに渡さない。Session / CSRF / HMAC key、メール・PIIをURL、Log、Screenshot / trace等のArtifact、証跡に残さない。

後続compositionのproofは、(1) default entrypointのimport / build artifact / route / configから評価fixtureへ到達不可、(2) defaultへの `/student` / CSRF / 4 APIを含む実Requestが503、(3) 評価側が実GuardとProduction D1 Adapterを使い、seedはtest entrypointに限定され、任意identity入力で迂回不可、(4) config / binding / secret identity不一致でfail-closed、(5) Production Provider・Scheduled side effectへ接続不可、を静的検査とruntime assertionで確認する。UI非表示だけをproofとしない。fake Providerの観察とReservation / Audit / Intent / outboxのCommit観察は分離し、実配送を主張しない。

### 9.3 評価Gateと後続責務

Gateの証跡・完了判定は `../40_test/01_TestPlan.md` §7 / §9 / §12、deploy / migration / rollback / cleanupの共通正本は `../10_basic_design/01_SystemArchitecture.md` §6とする。順序はA: local HTTPS Browser + isolated D1、B: 必要性と人間承認後の隔離remote対象環境D1 proof、C: #537の正式Browser Matrix / 実mobile / deploy・rollback / Backup-Restore、D: Production readiness / #534 Business Cutoverである。Aの成功をB〜DのPassへ読み替えない。

| 後続の責務単位 | 依存・Doneの引継ぎ |
| --- | --- |
| #608 read-only presentation | §9.1の月選択 / calendar・list / 4 View / 本人履歴。既存wireとAC→TCを維持し、配信・build方式の既存CI適合、keyboard / focus / narrow viewportを検証する。 |
| #537 CSRF取得 | §9.2の共有生成関数・session branch・preauth fail-closedを局所検証する。Production全契約は§10.3〜4を維持し、未実装分と非公開proofを明示する。 |
| #537 trusted seed / isolated runtime composition | CSRF取得と既存Adapterに依存し、HTTPS / cert / exact origin、実Guard、Production migrations、専用entrypoint / config / key、静的・runtime隔離proofを揃える。UI実装を同じrunへ詰め込まない。 |
| #608 Preview / Confirm interaction | read-only presentationとCSRF取得に依存し、確認state・全差分・二重操作抑止・201 / 409 / 401 / 403 / 503・結果不明からの回復を既存TCで検証する。実画面での合成評価は次の責務。 |
| #537 local Browser / 実画面操作評価 | UI interactionと隔離compositionに依存し、Gate Aの正常・競合・失効・障害・fake ProviderとCommitの分離、利用者による探索的評価を証跡化して#608 / #537へcheckpointする。 |
| #537 必要時remote deploy / rollback proof | Gate A後、具体差分・費用・復旧 / 撤収方法の人間承認に依存する。Gate BのD1証拠とdeploy / migration / check / rollback / cleanup手順・実行identityを残す。Gate C / Dは別判定のまま保持する。 |

後続Issueは本設計のmain反映後にfresh R/C/P/Bと実績から独立単位・依存順・受入条件を確定して起票する。本設計で起票・実装・承認・deploy済みとはしない。§10の残Auth flow / preauth全実装は#537の認証後続責務へ引き渡し、session先行実装をProduction readinessとしない。

### 9.4 Traceability

| 詳細設計箇所 | 上位識別子 | 既存要求ベースTest |
| --- | --- | --- |
| §2〜4・§9.1 Schedule / Self Scope | REQ-001 / 002、AC-001-001〜004 / AC-002-001〜002、BR-015 / 017 / 067 / 068 / 090 | `docs/40_test/02_FunctionalTestSpecification.md` の対応TC |
| §5〜6・§9.1 Preview / Confirm | REQ-003 / 101 / 911、AC-003-001〜008 / 016〜021、AC-101-001〜002、BR-050〜059 / 066〜068 / 112 | 同上、および `02a_ReservationOwnershipTestSpecification.md` / `02b_RequirementsV1.6V1.7TestSpecification.md`（TC-F-003-08〜09） |
| §7・§9.1 履歴 | REQ-005、AC-005-001〜002、BR-066 | `02_FunctionalTestSpecification.md` の対応TC |
| §9.1 Browser操作・日時表示 | REQ-902 / 903 / 907、AC-902-001〜003 / AC-903-001 / AC-907-001〜002 | `03_NonFunctionalTestSpecification.md` のTC-NF-902-01〜02 / TC-NF-903-01 / TC-NF-907-01〜02（初回対象の部分証拠） |
| §8 Error / Audit | REQ-914 / 940、POL-014、BR-111 | `03_NonFunctionalTestSpecification.md` の対応TC |

`REQ-911 / 914 / 940`、`OOS-001 / 002`を含む既存POL→BR→REQ→AC→TCの関係は変更しない。予約確認のwireに月間回数・料金は含めず、管理者代理予約を導入しない。D1物理Schema / migration / Transaction Guardは `02_StudentReservationD1.md` で確定する。単一予約Application実装は、詳細設計・基盤確定後に#608配下の後続実装Issueとして切り出す。#536は本体build / test / PR CI基盤、#537は操作評価環境、#538はAI Developer runtime適合を扱う。

## 10. Student認証HTTP・Provider Flow契約（#840）

### 10.1 適用範囲・Component・入力

本節は`../10_basic_design/06a_APICommonPrinciples.md` §10のStudent境界を具体化する。Session物理正本・共有predicateは`02_StudentReservationD1.md` §8、Provider flowの永続化・原子的合成は同書§9を正とする。Admin認証、認証方法の明示追加／統合、プロフィール変更、Invitation管理Command全体は定義しない。新規登録に必要な氏名・所有確認済み連絡先と登録許可の接続だけを含む。Production migration / Adapter / route activationは行わない。

| Component / Port | 入力・出力と責務 |
| --- | --- |
| Student Auth HTTP Adapter | wire、Cookie、CSRF / Originを検証し、安全なApplication結果だけを返す。Clientの`studentId / accountId / role / providerResult`を受け付けない。 |
| Student Auth Application Service | Login / Registration / Logoutを制御し、検証済みidentity、既存binding、登録許可をD1 Transaction Portで再照合する。 |
| Google OIDC Port / Adapter | Server保持のcode verifier / nonce、callback codeから検証済み`{issuer, subject, verifiedEmail}`または§10.8の分類を返す。raw tokenをApplicationへ返さない。 |
| Magic Link Mail Port / Adapter | Commit済みChallengeの宛先と短期リンクだけを送る。Provider受付／結果不明／失敗を抽象化し、AccountやSessionを作成しない。 |
| Turnstile Port / Adapter | tokenと信頼する送信元から`verified / rejected / unavailable`を返す。Clientの成功flagを信用しない。 |
| Auth Transaction Port / D1 Adapter | Rate Limit予約、pre-auth / Challenge、binding、登録、Session発行・失効を同一業務D1で処理する。 |
| Student Session / Authorization Guard | §2およびD1 §8.3のRequest解決を担当する。Auth成功のResponseを次Requestの認可ticketにしない。 |

外部credential、endpoint、client ID、canonical Application originは環境ごとにServer設定から与え、Request Host / forwarded header / Client redirect URLから作らない。未設定・環境不一致は503でfail-closedする。Provider設定変更・Secrets投入は本Issueでは行わない。Google / Turnstile / Resendの実Provider compatibilityは§10.10の未検証事項とし、Adapter実装で公式契約を確認する。

### 10.2 Cookie・Session発行／削除

| Cookie | 属性と寿命 |
| --- | --- |
| `__Host-student_session` | opaque token（D1 §8.2）。`Secure; HttpOnly; SameSite=Lax; Path=/`、Domainなし。`Max-Age = max(0, expires_at - Response時のServer UTC秒)`、最大2592000秒。 |
| `__Host-student_preauth` | 独立した32 byte乱数のcanonical base64url 43文字。`Secure; HttpOnly; SameSite=Lax; Path=/`、Domainなし。最大1800秒、D1の固定expiryに合わせ残秒を設定する。SessionでもActorでもない。 |

`Lax`はGoogleのcross-site top-level GET callbackを受けるために選択し、CSRF対策は§10.3を併用する。Student Cookieだけを読む。Admin CookieからStudent Actorを導出せず、同名Cookieが複数ある場合は曖昧に選択しない（Sessionは401、pre-authはflow失敗）。本契約のHTTPはHTTPSのみとし、local / isolated fixtureでもSecureを弱めてProduction契約へ混入させない。

新Session CookieはD1の発行Commit成功後だけ設定する。通常Request、CSRF取得、Idle経過で更新・延長しない。再Loginは新Sessionを作り、同Browserが提示した期限切れ等の旧Student Sessionがある場合は新発行と同じbatchでその旧Sessionだけを失効させる。他BrowserのSessionは維持する。pre-auth tokenをSessionへ昇格しない。

Cookie削除は同じname / Path、Domainなし、`Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`で行う。Sessionが期限切れ・失効・利用不能なら401でSession Cookieを削除する。D1障害・判定不能の503では削除しない。LogoutはServer失効が確定した後だけCookieを除去して成功とする。pre-auth CookieはLogin / Registration成功、期限切れ・明示的なflow終了で除去する。callbackのstate / browser不一致だけで他の正当なflowを失効させない。停止・削除時は他BrowserのCookieを直接消せないため、Server一括失効を正本とし次Requestで除去する。

### 10.3 CSRF・Origin・共通wire

認証関連Page / API / callbackは`Cache-Control: no-store`と`Referrer-Policy: no-referrer`を返す。CORSによる他originへのcredential / CSRF公開は行わない。JSON Requestは`Content-Type: application/json`、objectの未定義field・重複key・Query parameterの重複を400で拒否する。記載したfieldは必須、`?`付きfieldだけ任意で、省略とnullを混同しない。Request bodyはUTF-8で最大8192 byteとし、超過は400。token / Cookie / code / state / nonce / verifier / email / Provider本文をアクセスLog、Audit、URL診断、エラーへ反射しない。

Session-bound CSRF tokenは`base64url(SHA-256(UTF8("student-csrf-v1:" + rawSessionToken)))`（paddingなし43文字）とする。pre-auth用は独立domain `student-preauth-csrf-v1:`とraw pre-auth tokenから同様に導出する。DB保存のSession hashからは生成しない。tokenを`GET /api/auth/student/csrf`で`{"csrfToken":"…","scope":"session"}`または`scope:"preauth"`として返し、UIはmemoryだけに保持する。Sessionが提示された場合はD1 §8.3を評価し、有効ならsession用、不正／失効なら401を返す。Cookieなしの場合は有効pre-authを再利用し、なければ新規pre-authをCommitしてCookieとtokenを返す。pre-auth期限を延長しない。

CSRF取得GETは設定originと一致するOrigin、またはOrigin欠損かつ`Sec-Fetch-Site: same-origin`を要求する。cross-site、null Origin、その他の欠損は403。通常Page navigationはこのAPIの代替ではなく、Pageからsame-origin fetchで取得する。

`POST / PUT / PATCH / DELETE`等、GET / HEAD / OPTIONS以外の全Student Cookie利用Request（業務QueryのPOST Previewを含む）では、設定originとの完全一致Originと`X-CSRF-Token`を必須とする。tokenはcanonical形式を検査してconstant-time比較する。`Sec-Fetch-Site`が存在してsame-origin以外なら拒否する。Originのsuffix一致、Referer fallback、Host由来allowlistを使わない。認証済み業務操作はSession検証→CSRF→業務認可、匿名Login開始・Magic要求／consume・登録はpre-auth検証→CSRFの順とする。Google callback GETはこのheader検証の例外で、§10.5のstate / nonce / PKCE / browser bindingを必須とする。Magic Link bearerはpre-auth CSRFを置き換えない。OPTIONS / HEAD / GETでSession発行・Logout・Magic consumeを実行しない（検証済みGoogle callbackだけは別契約）。

### 10.4 EndpointとUI wire

認証入口Pageは`/student/login`、Magic着地Pageは`/student/login/magic`、登録Pageは`/student/register`とする。Page GETでMagic / Invitationをconsumeしない。認証後は`/student`へ進み、Client指定return URLは受け付けない。

| Method / path | Request | 成功Response |
| --- | --- | --- |
| `GET /api/auth/student/csrf` | body / Queryなし | §10.3の200 JSON。必要時pre-auth Cookie。 |
| `POST /api/auth/student/google/start` | `{invitationToken?: string}`、pre-auth CSRF | `200 {"authorizationUrl":"…"}`。UIがtop-level navigationする。 |
| `GET /api/auth/student/google/callback` | `code` + `state`、または`error` + `state`。Provider補助parameterはAdapterだけで扱う | 成功時Session Cookie + `303 Location: /student`、新規時`303 Location: /student/register`（proofはServer保持）。 |
| `POST /api/auth/student/magic/request` | `{email: string, turnstileToken: string, invitationToken?: string}`、pre-auth CSRF | `202 {"status":"accepted"}`。配送・登録有無は返さない。 |
| `POST /api/auth/student/magic/preview` | `{token: string}`、現在Browserのpre-auth CSRF | 未消費の有効Challengeから`200 {"email":"…"}`。consumeせず確認対象だけを返す。 |
| `POST /api/auth/student/magic/consume` | `{token: string}`、現在Browserのpre-auth CSRF | 既存Login: Session Cookie + `200 {"next":"student"}`。新規: `200 {"next":"registration"}`（proofはServer保持）。 |
| `GET /api/auth/student/registration` | pre-auth Cookie、§10.3のsame-origin GET検証 | 有効proofから`200 {"email":"…"}`。生Provider token、内部IDを返さない。 |
| `POST /api/auth/student/registration` | `{name: string}`、pre-auth CSRF | Session Cookie + `201 {"next":"student"}`。nameはtrim後1〜100 Unicode code point、制御文字不可。本人識別根拠にはしない。 |
| `POST /api/auth/student/logout` | `{}`、Session CSRF | 当該Session失効Commit + Cookie除去、`204`。 |

Magic LinkのメールURLは設定originの`/student/login/magic#token=<opaque>`とする。UIはfragmentをmemoryへ取り込んで直ちに`history.replaceState`でURLから除去し、外部resourceを読まず、preview POSTで有効Challengeの認証先emailを表示し、「このメールで認証する」確認操作後にだけconsume POSTを送る。previewは期限／purpose／未消費／非supersededをPrimaryで検証し、Account IDや登録有無を返さず、consume時には同じ条件を再検証する。メールscannerのGETでは認証しない。要求元Browserへbindingせず別Browserで受け取れるが、consume先Browserの新しいpre-auth CSRFを必要とする。Invitation入口も`/student/login#invitation=<opaque>`で同じURL除去を行い、選んだGoogle start / Magic requestへだけ渡す。Invitationのメール送信／管理EndpointとAdmin認証は別責務。

同BrowserではGoogle start / Magic consumeでpre-auth内の古い登録proofをsupersedeする。Magic consumeは同じbatchで当該Browserの未完了Google flow（claimedを含む）もsupersedeし、遅れて戻るGoogle callbackが新proofを上書きしない。既存Student Sessionを持つBrowserは匿名認証flow開始前にLogoutを完了する。匿名Endpointへ有効Student Sessionを併送した場合は`AUTH_FLOW_INVALID`を返し、Account切替・統合を暗黙に行わない。

### 10.5 Google OIDC Authorization Code Flow

1. startはpre-auth / CSRF / Originと送信元Rate Limitを検証する。Serverは独立した32 byte乱数のstate、nonce、code verifierを生成する（各canonical base64url 43文字）。D1でpre-auth hash、purpose `student_google_login`、state hash、nonce hash、verifier、固定callback URI、任意Invitation hash、開始時刻と600秒期限を保存する。任意招待はStudent招待表で照合し、有効行だけのhashを保持する。未知／期限切れ／使用済み／supersededはNULLへ解決し、既存Loginの条件にしない。旧未完了Google flowを同BrowserでsupersedeしてからCommitする。
2. Google OIDC AdapterはServer設定のauthorization endpointへ`response_type=code`、`client_id`、固定`redirect_uri=<origin>/api/auth/student/google/callback`、`scope=openid email`、state、nonce、`code_challenge=base64url(SHA-256(ASCII(verifier)))`、`code_challenge_method=S256`を付ける。offline access / refresh token / profile scopeを要求しない。authorization URLのoriginもServer設定と照合する。
3. callbackはstate / codeまたはerrorの形を検証し、pre-auth Cookie hashとstate hash、purpose、期限、未claim / 未消費 / 非supersededをPrimaryで照合する。codeとerrorの併存、state欠損／重複、不正Browserは`AUTH_FLOW_INVALID`。callback失敗のProvider messageは使わない。正当に対応するflowだけをD1条件付き更新＋`changes() = 1` CHECK assertで一度claimする。
4. claim Commit後、Adapterだけがtoken endpointへHTTPS formで`grant_type=authorization_code`、code、同じredirect URI / client ID、保存verifierとServer secretの`client_secret`（client_secret_post）を送る。credentialをauthorization URLへ付けない。D1 Transactionを外部呼出中に保持しない。code交換・Google Loginを自動Retryしない。失敗／応答不明／途中終了のclaimを未使用へ戻さず、利用者はstartから再操作する。
5. ID tokenの署名（許可algorithmはRS256のみ、Server設定のtrusted issuerの鍵）、issの設定値との完全一致、audへの当該client ID包含、azpがある場合の当該client ID一致（aud複数ならazp必須）、整数exp / iat（`iat <= now < exp`）、nbfがあれば`nbf <= now`、nonce hash一致、非空stable sub、email、`email_verified = true`をAdapterが検証する。鍵取得先をtokenのURL fieldから選ばず、署名未検証claimを使わない。時刻はServer UTC、期限等値を無効とし許容clock skewは0秒とする。access / refresh / ID tokenと不要claimは業務DBへ保存せず処理後破棄する。署名／nonce／claim不成立は認証拒否、鍵取得不能等は利用不能として分ける。
6. 検証済み`{issuer, subject, verifiedEmail}`とServerのflow IDをApplicationへ渡し、§10.7のbindingを実行する。既存Accountならflow消費・bindingの最終再照合・§8.4 Session発行を同じPrimary batchでCommitする。新規ならServer pre-authに登録proofを保存してflowを消費する。proofの期限は元Google flowとpre-authの期限の小さい方で、Sessionはまだ発行しない。

stateを知るだけ、Google成功flag、ClientからPOSTされたID tokenではこのFlowを成立させない。error callbackもvalid state / browser照合後に当該flowを終端化する。callback errorは§10.8の安全なcodeだけを持つ`303 /student/login?error=<code>`とし、code / state / Provider error本文をLocationへ付けない。

### 10.6 Magic Link・悪用防止・配送

emailは単一のaddr-spec文字列とし、display name、制御文字、内部空白を拒否する。前後空白を除き、domainはWHATWG URLのhostname変換によるIDNA ASCII lowercase、local-partはそのまま保持して一致keyを作る。Provider固有のdot除去・plus除去・alias統合・local-partのcase foldingは行わない。全認証・連絡先一意性・Rate Limitの照合はこの同じ規則を使う。表示／配送先の原文と一致keyを区別し、任意email入力だけでは所有確認済みにしない。

requestの順序はwire / pre-auth CSRF / Origin→送信元Rate Limit→Turnstile検証→送信先Rate Limit予約→Challenge保存→Commit後Mail Portである。送信元はplatformから得る信頼する接続元であり、Clientの`X-Forwarded-For`等を使用しない。Turnstile AdapterはServer secretに加え設定hostname / action `student_magic_request`への一致を検証する。Turnstile失敗・利用不能なら送らない。

送信先制限は`AC-210-002`の60秒1回・rolling 3600秒5回・rolling 86400秒10回（設定可能）。送信元は初期rolling 60秒20回・3600秒100回、Google start / callbackは送信元rolling 60秒30回とし、環境設定で変更可能、Account恒久lockにしない。Request予約はD1時刻Tで`T-window < accepted_at <= T`を数え、同じbatchで上限assertと新行保存を行う。メール制限keyは`SHA-256(UTF8("student-magic-destination-v1:" + email_key))`、送信元は`SHA-256(UTF8("student-auth-source-v1:" + platform正本のIP文字列))`をlowercase hexにした値とし、bucketを別列で区別して平文をRate Limit表へ保存しない。IPv6はplatformのcanonical表現を使い、表現の違いで同一送信元制限を分割しない。登録有無を調べる前に同じ予約を行い、配送抑止／失敗でも予約を返還しない。

送信先制限、未登録Invitation Only、有効でない招待、停止・削除済みAccount、配送失敗／結果不明でもrequestは同じ202 / JSONとする。送信元制限だけ429、Turnstile拒否は400、Turnstile／D1共通障害は503（Account lookupより前の共通処理）。登録有無によりstatus、header、body、配送待ち時間を変えない。Responseはメール送信を待たず、Commit後の1回のbest-effort送信をWorkerのpost-response実行へ渡す。durable Delivery RecoveryをこのFlowの前提にせず、途中終了・配送失敗は公開再要求で回復する。登録有無によるレスポンス時間傾向は実装時の比較検証対象とする。

Challenge tokenはSessionと独立した32 byte乱数（canonical base64url 43文字）。DBはASCII tokenのSHA-256 lowercase hexだけを保存し、`purpose = student_magic_login | student_magic_register`、Student scope、正規化配送先、既存ならaccount IDと現在login address、任意Invitation hash、D1発行時刻と900秒期限をbindingする。新要求は同じ宛先・Student scopeの古い未使用Magic Challengeをpurposeに関係なくsupersedeし、Google / Invitation / メール変更purposeを失効させない。

consumeはtoken hash、purpose、`created_at <= T < expires_at`、未消費／非supersededを同じPrimary batchでassertする。login purposeは保存accountと現在Magic login addressの一致もassertし、メール変更後の旧リンクで認証しない。Challenge消費・binding／利用可否Guard・Session発行を同じbatchに合成する。register purposeは新規所有確認proofを現在Browserのpre-authへ保存しChallengeを消費する。proof期限は元Challengeとpre-authの期限の小さい方で延長しない。未知／期限切れ／使用済み／superseded／purpose不一致はいずれも`AUTH_FLOW_INVALID`とし、Tokenを復活・別purposeへ転用しない。

Mail AdapterはProvider受理／結果不明／最終失敗を内部で区別し、公開202にProvider message IDを出さない。安全かつ冪等と公式契約で確認した一時障害だけREQ-912の最大3回・exponential backoff / Retry-Afterを適用できる。受理後・結果不明・Permanent Errorを盲目的再送せず、未検証なら自動Retryしない。生tokenは送信処理memoryだけに置き、永続outboxや通常予約通知へ入れず処理終了時に破棄する。Magic配送失敗は通常Dashboard／管理者手動再送対象外とする。

### 10.7 Binding・Registration・Session issuance内部Context

Googleは`(issuer, subject)`のStudent bindingを最優先する。既存bindingが停止／削除等で利用不能なら新規登録へfallbackしない。未bindingの場合だけ、一意なActive Studentの同一正規化verified連絡先emailへ自動linkする。既存bindingのStudentとemail一致先が別Studentでもmerge・付替え・連絡先の上書きをしない。未verified emailをlinkに使わない。Magic loginは現在連絡先と同期したStudent Magic login addressを使い、Client emailからActorを直接生成しない。

登録proofはServer検証済みidentityとその所有確認email、元flow ID / purpose / 期限、pre-auth hash、任意Invitation hashを保持する。Registration GETはこのemailを返し、Clientにemail / subject / roleの編集権を与えない。登録POSTの同じbatchで最新binding／verified連絡先を再読込し、既存一意Accountへ解決できればそちらを利用して重複作成しない。異なるemailのAccount統合は行わず`AUTH_FLOW_INVALID`。同じidentity / emailへの並行登録はUNIQUEとCHECK Guardで一方のみ確定し、Rollback後のPrimary再照合で再操作を案内する。

新Studentが必要な場合だけ最新Registration modeを読む。Openなら所有確認済みemailから作成、Invitation Onlyなら`purpose = student_invitation`、72時間期限、未消費／非supersededの招待が必要。同じbatchで招待を消費する。Openでは招待を登録許可として使わず消費もしない。Invitation emailは登録許可／配送先でありGoogle認証emailとの一致条件にしない。新連絡先はProvider flowで所有確認したemailとする。招待は既存StudentのLogin条件には使わず、既存Login成功時にconsumeしない。招待管理側は再発行時に同じInvitationの旧Tokenをsupersedeし、期限を新発行から72時間として新hashを渡す。

新規の場合は新しいStudent ID / Account ID、active lifecycle、SecurityAccess active、氏名とverified連絡先、Student専用AuthMethodを同じbatchで作成する。削除済みの同emailは個人情報削除・匿名化完了と一意性解放後だけ再利用し、旧ID／履歴／Sessionへ再接続しない。proof消費、必要な招待消費、binding、§8.4 Session発行のどれかが不成立なら全Rollbackする。

Session issuanceへ渡す内部型は`{accountId, roleScope: "student", sourceFlowId, sourcePurpose}`とする。`accountId`は同じbatchで作成または既存bindingから解決した`student_accounts.id`、残りはServer永続flowから得る。Account IDだけのClient入力やProvider tokenを受け付けない。発行AdapterはD1 §8.4のpredicateを初期／最終assertし、flow消費／binding再照合も同じ成功境界で確認する。以後の業務Request ContextはD1 §8.3の`session_id / token_hash / student_id`へ収束し、source flowを認可ticketに使わない。

### 10.8 Error・失効・Logout

§8のJSON envelopeとretry値を再利用する。新auth codeのmessageは以下の固定文とし、Provider Adapterの生errorは公開しない。

| code | HTTP / retry | message・適用 |
| --- | --- | --- |
| `AUTH_FLOW_INVALID` | 400 / none | 認証を完了できませんでした。認証操作を最初からやり直してください。Token／state／binding／登録許可不成立を区別しない。 |
| `CSRF_INVALID` | 403 / reload | 操作を確認できませんでした。画面を再読み込みしてください。Origin / CSRF不成立。 |
| `AUTH_RATE_LIMITED` | 429 / later | 要求が多すぎます。時間をおいて再度お試しください。送信元制限だけ。`Retry-After`は超過した送信元windowが解放されるまでの秒数（複数なら最大、最小1）を返す。 |
| `AUTH_PROVIDER_UNAVAILABLE` | 503 / later | この認証方法を利用できません。別の認証方法を使うか、時間をおいて再度お試しください。Google経路の到達不能・鍵取得不能等。 |
| `AUTH_CHALLENGE_REJECTED` | 400 / reload | 確認を完了できませんでした。画面を再読み込みしてください。Turnstile拒否。 |

不正JSON等は既存`INVALID_REQUEST`、D1 / Turnstile障害・環境Gateは既存`SERVICE_UNAVAILABLE`（代替経路が必ず解決するとは案内しない）、永続化Invariant異常は既存`INTEGRITY_STATE_UNAVAILABLE`。Mail障害だけはrequestの202へ隠蔽し内部観測する。code検証不成立／Google利用者取消は`AUTH_FLOW_INVALID`、Google利用不能は`AUTH_PROVIDER_UNAVAILABLE`へAdapterで分類する。HTTP status／生Provider文字列だけからAccount状態や原因を推測しない。

業務RequestはD1 §8.3の順序で、欠損／未知／失効／期限切れ／停止／削除は401 `UNAUTHENTICATED`、有効な認証済みSessionに操作権限がない場合だけ403 `FORBIDDEN`、判定不能は503とする。Student専用Cookieに未知tokenやAdmin tokenを入れた場合はStudent lookup不存在の401であり、Admin認証が成功したことにしない。停止・解除後の古いSessionを403のために復活させない。

Logoutでは有効SessionとCSRFを確認し、Primary batchのD1時刻で当該id / hashを失効させ、同じbatchの最終assertで失効を確認する。並行Logout／停止ですでに失効していれば非復活を保ったまま204、他Sessionは失効させない。Request開始時から未知／失効Sessionの場合は401とCookie除去（Logout成功とは表示しない）。batch／再照合が失敗・応答不明なら503として成功を推測せず、Server失効確認後にだけCookieを除去する。

### 10.9 Traceability・後続実装の検証観点

以下は既存AC / TCを具体化する設計検証観点であり、新しいProduct要求・TC identifierを導入しない。

| 設計 | 上位識別子・既存TC | 確認観点 |
| --- | --- | --- |
| §10.2〜3・§10.8 | POL-006、REQ-207 / 211、AC-207-002〜003 / AC-211-001〜005、TC-F-207-02〜03 / TC-F-211-02〜03 | Cookie属性・30日等値・非延長、Session/pre-auth CSRF非互換、Origin欠損／null／cross-site、POST Preview適用、失効後401、503でCookie維持、Logoutの両Commit順。 |
| §10.5・§10.7 | BR-090 / 097 / 121、REQ-202 / 205、AC-202-001〜002 / AC-205-001〜002、TC-F-202-01〜02 / TC-F-205-01〜02 | state／nonce／PKCE不成立・callback replay／wrong Browser、Google取消／障害、同email link、stable binding優先・異email非merge、raw token／不要claim非保存、Admin非昇格。 |
| §10.6 | BR-094〜095 / 114、REQ-203 / 210、AC-203-001〜004 / AC-210-001〜007、TC-F-203-01〜03 / TC-F-210-01〜06 | 900秒等値、single-use／supersede／purpose、scanner GET無変更、別Browser consume、メール変更後旧リンク拒否、Rate Limit並行予約、Turnstile / Provider呼出順、登録済／未登録／停止／配送失敗の公開応答と時間傾向の同等性。 |
| §10.7 | BR-091 / 096 / 127、REQ-201 / 204 / 319、AC-201-001〜003 / AC-204-001〜003 / AC-319-001、TC-F-201-01〜02 / TC-F-204-01〜03 / TC-F-319-01 | 登録mode再検証、招待72時間等値／再発行、Google異email許可、既存Login不変、並行登録、一意性・削除後新ID、proof／招待／Sessionの全Rollback。 |
| §10.1・§10.8 | POL-007 / 014、REQ-209 / 912 / 914 / 934 / 935 / 940 / 951、AC-209-001〜002 / AC-912-003〜005 / AC-914-004〜005 / AC-934-001 / AC-935-001 / AC-951-001、TC-F-209-01〜02、TC-NF-912-02〜04 / TC-NF-914-03〜04 / TC-NF-934-01 / TC-NF-935-01 / TC-NF-940-01〜04 / TC-NF-951-01 | Provider交換Port、Google自動Retryなし、結果不明非再送、共通障害503、安全な固定error、token非反射・個人情報最小化、24時間削除優先。 |

既存POL→BR→REQ→AC→TC、CON-001〜003 / 006、OOS-006 / 009の意味は変更しない。図の正本は`../diagrams/plantuml/c4-student-auth-components.puml`と`../diagrams/plantuml/student-auth-sequence.puml`。

### 10.10 Handoff・未検証事項

#841はD1 §8のProduction migration、#842は本HTTP契約と#841のD1正本へのProduction StudentAccessGuard接続を担当する。§9のProvider flow保存契約のmigration／実装も、有効化する認証flowに先行して揃える（§8だけでProvider flow完成としない）。#843は削除Command全体、#844はAdmin認証詳細を担当する。実装担当が本契約のpure部分・isolated fixtureを始めるための追加Product判断はない。

本Issueは文書・PlantUML正本のみで、実Provider通信・対象D1検証・route activationをしない。Googleの設定issuer／endpoint／RS256・鍵取得・client_secret_post・S256対応、Turnstile hostname / action、Resendの受付／結果不明／安全なRetry根拠は実Providerで未検証。これらをProviderが保証するという記述ではなく、Adapterが満たす検証契約とする。設定・互換性を確認できない経路はfail-closedし、外部事実と本契約が矛盾する場合は推測で変更せず人間判断へ戻す。

#892初回評価のsession CSRF取得先行・未対応preauth fail-closedと非公開compositionの境界は§9.2を参照する。これは本節のProduction認証契約の縮小やAuth flow完了を意味しない。

#840 / #841 / #842とD1 §8.6の対象環境検証が完了するまではProduction / Production相当Reservation Adapter / public routeを有効化しない。隔離試験の結果を実D1・実Provider・Browser System / Acceptance試験のPassへ読み替えない。
