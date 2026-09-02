# 05. 予約・競合・Transaction基本設計

## 1. 目的

本書は、予約・キャンセル・月間再分類等の重要業務Commandについて、D1上でどの状態変更を同一の整合範囲として扱い、競合・監査・通知をどのように整合させるかを定義する。

本論点は `OI-BD-006` で検討する。本書はC4 Level 2の基本設計としてTransaction境界と実行原則を定義する。個別DDL、Index、Trigger、Guard用SQL、CTE、Application Component構造等は詳細設計（Level 3）で具体化する。

## 2. 既存の前提

以下は既存要求・基本設計・ADRで確定済みである。

- `StudentReservation` は予約履歴の正本とする。
- `SlotOccupancy` は `LessonSlot` の現在占有の正本とする。
- `SlotOccupancy.slot_id` のUNIQUE制約を現在占有一意性のDBレベル最終保証点とする。
- 生徒予約の現在占有参照方向は `SlotOccupancy.reservation_id → StudentReservation` とし、`StudentReservation` は `lesson_slot_id` を履歴として保持する。
- 予約履歴と現在占有を分離する。
- Lesson開始済みReservationの `automatic_classification` は通常の自動再分類で遡及変更しない。
- 競合時は先に正常Commitされた状態を優先し、後続操作は最新状態を再検証する。
- Commit済みの内部業務状態を正とし、メール等の外部連携失敗を理由にRollbackしない。
- 重要操作はActor IDを含む必要最小限のAuditLogで監査可能にする。
- 通知義務が発生する業務では、外部送信そのものと「通知すべき事実」を分離する。
- 利用者向け画面および公開APIへ内部技術エラーを直接露出せず、安定したApplication Errorへ抽象化する。

## 3. D1 Transaction共通方針

### 3.1 実行API

重要なWrite Commandは、現在のCloudflare D1 APIでは原則として次の形を使用する。

```text
D1DatabaseSession = DB.withSession("first-primary")

D1DatabaseSession.batch([
  Prepared Statement,
  Prepared Statement,
  ...
])
```

`first-primary` によりCommandの最初のQueryをPrimary起点とし、そのSession内で最新確定状態を基準に処理する。Read Replicationを使用しない構成でも、重要Write CommandがPrimaryの最新状態を基準とする設計意図を明示する。

D1の `batch()` が提供するSQL Transaction境界を使用し、Application Workerから `BEGIN TRANSACTION` / `COMMIT` を文字列として手動送信する方式を通常業務Commandの基本方式としない。

Cloudflare側APIが将来変更される場合は、少なくとも「同一DB上の複数StatementをAll-or-NothingでCommitできる」「最終判定を最新確定状態に対して行える」という本書の保証を維持する同等方式へ置換する。

### 3.2 Prepared Statementを使用する

予約・キャンセル・再分類・AuditLog・NotificationIntent等の通常業務SQLは `prepare()` / `bind()` によるPrepared Statementを使用する。

通常業務Commandで `exec()` に動的値を組み込んで実行する方式は採用しない。`exec()` はMigrationや明示的なMaintenance等、用途を限定して扱う。

### 3.3 Commit条件はTransaction内で最終判定する

次の方式だけに依存してはならない。

```text
Transaction外でSELECT
  ↓
Worker上で「予約可能」と判定
  ↓
時間差
  ↓
batchで無条件INSERT / UPDATE
```

Transaction外のPreviewや事前SELECTは利用者表示・準備には使用できるが、正常Commit可否の最終判断には使用しない。

予約成立条件、キャンセル成立条件、classification、現在占有その他の競合条件は、原子的Transaction内で最新確定状態に対して再検証する。

### 3.4 Guard不成立を正常Commitさせない

`UPDATE ... WHERE ...` が0件更新でもSQL自体は成功し得るため、「Guard対象が0件だったが後続AuditLogやNotificationIntentだけCommitされた」という状態を許容しない。

Commit必須条件が不成立の場合は、DB Transaction全体が失敗するGuard方式を使用する。

具体方式はLevel 3で確定するが、候補には次を含む。

- UNIQUE / FOREIGN KEY / CHECK等のDB制約
- 条件付きStatementとDB側Assertion
- Trigger
- SQLite上で意図的にTransactionを失敗させるGuard Statement

`SlotOccupancy.slot_id UNIQUE` は二重占有に対する最終Guardの1つである。一方、月公開済み、Lesson開始前、Preview classification一致等、単純なUNIQUE制約だけでは表現できない条件もTransaction内Guardで扱う。

### 3.5 SQLの論理実行順序

重要Command内の論理順序は原則として次とする。

```text
1. Commit-time Guard / Invariant確認
2. 主たる業務状態変更
3. 現在占有等の関連状態変更
4. 必要な派生状態変更・再分類
5. AuditLog
6. 必須のアプリ内通知
7. NotificationIntent
8. COMMIT
```

具体的なStatement順序は、Foreign Key、Trigger、Guard実装等に応じLevel 3で調整できる。ただし途中状態をTransaction外の確定状態として露出させず、確定すべき業務状態・Audit・通知義務をAll-or-NothingでCommitする原則は変更しない。

キャンセルで「キャンセル済みReservationを現在占有として参照しない」制約を強化する場合、必要に応じ `SlotOccupancy` 終了をReservation status変更より先に実行する等、DB制約と矛盾しない順序にする。

### 3.6 派生処理は集合単位を基本とする

月間再分類、複数Reservation取消、複数NotificationIntent生成等を、不要な1件ずつのSELECT / UPDATEループへ分解しない。

可能な限り、条件付き一括UPDATE、`INSERT ... SELECT`、multi-row INSERT、CTE等の集合指向SQLを使用する。

これによりD1 Query数、Transaction時間、競合Windowを抑える。初期リリースは無料枠優先であるため、1 Worker invocationあたりのD1 Query上限も設計制約として考慮する。

### 3.7 Write Commandを盲目的に自動Retryしない

重要Write CommandでD1応答が不明瞭になった場合、同一batchを無条件に自動再実行しない。

特に「D1側ではCommit済みだがWorkerが正常応答を受け取れなかった」可能性を考慮する。

結果が不明な場合は最新確定状態を再取得し、業務結果を判定することを基本とする。一括予約Confirmの再送は5.5.3の操作識別子によるIdempotency方針に従う。他のCommandにCommand Idempotency Key等の追加方式が必要かはAPI詳細設計で判断する。

## 4. 競合・エラー表現

本節は要求仕様v1.4の `POL-014 利用者向けエラー情報の安全な抽象化`、`BR-133 利用者向けエラー表現`、`REQ-914 障害・エラー時利用者表示` を、D1 TransactionとAPI境界で実現するための基本設計である。

### 4.1 D1やProviderの生エラーをApplication Contractにしない

D1のConstraint Error、SQL Error、Stack Trace、Provider固有Error Message等を、そのまま利用者画面または公開APIの利用者向けMessageとして返さない。

内部エラーはApplication側で分類し、安定したApplication Errorへ変換する。

初期の基本区分は次とする。

- **Conflict**: 先行Commitにより最新業務状態が変化した。HTTP APIでは原則 `409 Conflict`。
- **Validation / Business Rejection**: 入力不正、権限不足、期限超過等、競合以外の利用者操作不成立。適切な4xxへ変換する。
- **Technical Failure**: D1接続不能、予期しないApplication Error等。5xx / 503等へ変換する。
- **Integrity Anomaly**: 永続化済みInvariant違反。通常Conflictとは区別し、Fail Closedする。利用者向けHTTP APIでは原則 `503 Service Unavailable` とする。

利用者には、内部技術情報ではなく「何が成立しなかったか」「必要なら何を再確認・再操作すべきか」が分かるMessageと最新業務状態を提示する。

D1 Constraint名、SQL文、Stack Trace、Provider Message、内部Invariant Code等の詳細は技術Log / Monitoring側へ記録し、公開Application Contractをこれらの文字列へ依存させない。

### 4.2 Conflict後は最新状態を返す

競合によりTransactionをRollbackした後、必要に応じPrimaryの最新状態を再読込し、利用者へ最新状態を提示する。

例:

```text
予約状況が変更されました。
現在この枠は予約済みです。
```

または、

```text
予約内容が変更されました。
現在の区分は additional です。内容を再確認してください。
```

Application固有Error Codeの具体値、HTTP Response Schema、Correlation ID等はAPI詳細設計で確定する。

## 5. 予約確定Command

### 5.1 原子的Transaction境界

予約確定では、少なくとも次を1つのTransactionでCommitする。

- 新規 `StudentReservation` 作成
- 対象 `LessonSlot` の `SlotOccupancy` 確保
- 同一生徒・同一月の必要な自動再分類
- 新規および影響する未開始Reservationの `automatic_classification` / `classification` 更新
- AuditLog
- 予約確認NotificationIntent
- 既存Reservationのclassificationが変化した場合の区分変更NotificationIntent

Reservationだけ作成されOccupancyがない状態、Reservation / Occupancyは確定したが月間classificationが旧状態、必要なAuditLogまたはNotificationIntentだけ欠落した状態を正常Commitとして許容しない。

### 5.2 Commit直前再検証

少なくとも次を最新確定状態で検証する。

- 対象生徒が現在も予約操作可能
- 対象月が公開済み
- `LessonSlot.availability_status = enabled`
- Server Commit基準時刻でLesson開始前
- 対象Slotに現在の `SlotOccupancy` がない
- 同一生徒・同一月のReservation、欠席、月間算入Override、標準回数等
- 未来SlotのInvariant

### 5.3 Preview classificationとの差分

利用者が最終確認した新規予約classificationとCommit直前の最新classificationが異なる場合、予約を成立させずConflictとして再確認へ戻す。

- `standard → additional`
- `additional → standard`

の両方向へ同じルールを適用する。

### 5.4 既存Reservation再分類

新規予約により同一生徒・同一月の既存未開始Reservationのclassificationが変化する場合、その再分類も新規予約と同じTransactionでCommitする。

開始済みReservationの `automatic_classification` は遡及変更しない。同一生徒・同一月の異なるSlotへの同時予約も、Slot競合とは別に月間分類競合として扱う。

### 5.5 一括予約ConfirmのTransaction境界と競合

`REQ-008 / AC-008-001〜009 / BR-069` に従う一括予約Confirmは、選択Slot集合全体を1つの業務Commandとして扱う。選択対象の各Slotを独立した単一予約Commandとして順番に確定したり、成功した一部だけを残したりしない。既存の単一予約Confirmは引き続き5.1〜5.4を適用し、一括予約がこれを置換しない。

#### 5.5.1 原子的Transaction境界

一括予約Confirmでは、少なくとも次を選択Slot集合全体について1つのD1 TransactionでAll-or-NothingにCommitする。

- 各選択Slotに対応する新規 `StudentReservation` 作成
- 各対象 `LessonSlot` の `SlotOccupancy` 確保
- 選択集合を反映した同一生徒・同一月の必要な自動再分類
- 各新規Reservationおよび影響する選択対象外の未開始Reservationの `automatic_classification` / `classification` 更新
- 一括予約Commandを単位とするAuditLog
- 各新規予約の予約確認NotificationIntent
- 既存Reservationのclassificationが変化した場合に必要な区分変更NotificationIntent

対象Reservation、Occupancy、再分類、AuditLog、または通知義務のいずれかを一部だけCommitする正常結果を許容しない。いずれかのCommit必須条件または同一Transaction内の書込みが不成立なら、選択集合全体をRollbackする。

#### 5.5.2 Commit直前の論理的再検証順序

具体SQLのStatement順序は詳細設計で定めるが、Transaction内ではCommit直前まで最新確定状態を基準に、少なくとも次の論理順序で再検証する。

```text
1. 認証済みSessionから解決した対象生徒が、現在も予約操作可能であることを確認する
2. 選択集合が同一暦月・一括操作上限N等の一括予約条件を満たすことを確認する
3. 各対象Slotについて、公開済み、enabled、Server Commit基準時刻で開始前、現在Occupancyなし、未来Slot Invariant成立を確認する
4. 同一生徒・同一月のReservation、欠席、月間算入Override、最新Nおよび開始境界から、選択集合全体の新規classificationと選択対象外の未開始Reservationへの再分類影響を算出する
5. Previewで確認した重要状態との一致を確認し、すべてのGuardが成立した場合だけ、5.5.1の状態変更、AuditLog、NotificationIntentをCommitする
```

この再検証はTransaction外のPreviewや事前読込だけに依存しない。

#### 5.5.3 Expected StateとIdempotency

Bulk Previewで利用者が確認した内容をBulk Confirm時に再確認するため、Expected Stateは少なくとも次の**業務上の意味**をSnapshotとして表現する。

- 選択したSlot集合
- 選択SlotからServerが判定した対象月
- 対象生徒・対象月についてPreview時に適用した月間標準回数N
- 各選択Slotの予約可能状態
- 選択集合全体を追加した場合の各新規Reservationのclassification
- 選択対象外の既存未開始Reservationへのclassification影響（対象集合および変更前後classification）

Expected Stateは、Preview時に確認した業務上の意味とCommit直前にServerが最新確定状態から再計算した意味が一致することを確認するための入力である。Clientはclassification、N、対象月、予約可能状態、または既存Reservationへの影響を更新値・正本として指定できない。Serverはこれらを最新確定状態から再判定・再計算し、一致しない場合は5.5.4のConflictとして選択集合全体を未適用とする。

Expected StateとIdempotencyは別概念である。Expected StateはPreview後の業務状態の変化を検出して初回Confirmの成立可否を判定するものであり、Idempotencyは同一Confirmの通信再送による二重確定を防止するものである。一方をもう一方の代替として扱わない。

Bulk ConfirmはClientが操作識別子を送信できる形とする。同一操作識別子で同一内容のConfirmが再送された場合、Serverは新たなReservation、Occupancy、再分類、AuditLogまたはNotificationIntentを重複して作成せず、先に確定した同一操作の結果を返せるようにする。同一操作識別子が選択Slot集合またはExpected Stateを含む異なるConfirm内容に再利用された場合は、別操作として実行せずRejectする。

操作識別子の具体Field、同一内容の比較方法、保存Entity、保持期間、一意性Guard、再送時のHTTP Response表現は詳細設計で確定する。

#### 5.5.4 Conflictと全体未適用

同時予約による対象Slotの先行占有、Commit判定中のLesson開始時刻到達、Slotの公開状態またはavailability状態の変更、最新N・月間算入条件・classificationまたは選択対象外の既存未開始Reservationへのclassification影響の変化等により、再検証またはGuardが不成立となる場合はConflictとする。

Conflict時はTransactionをRollbackし、全対象を未適用とする。先行正常Commitを優先し、選択集合の一部だけをReservation、Occupancy、再分類、Audit、または通知義務として残さない。

Rollback後は、Primaryの最新状態から安全に検出・再取得できた範囲だけをConflict Responseへ含めてよい。Responseは再Previewまたは再確認に必要な対象Slot・業務上の理由・安全な最新Slot View・classification影響を示せる形とするが、全競合または全影響の完全列挙を保証しない。

Responseへ他生徒の氏名、内部生徒ID、Reservation IDその他の個人情報を含めず、D1 / SQLエラー、Constraint名、内部Table・Column名、内部Invariant Codeも公開しない。具体的なApplication Error Code、HTTP Response Schema、Expected State、および再Preview情報のWire表現は詳細設計で確定する。

## 6. 生徒キャンセルCommand

### 6.1 原子的Transaction境界

生徒キャンセルでは、少なくとも次を1つのTransactionでCommitする。

- `StudentReservation.status = student_cancelled`
- `cancelled_at`
- 対象Reservationの `classification = NULL`
- 対象Reservationの `automatic_classification` は保持
- 元Reservationによる `SlotOccupancy` 終了
- 同一生徒・同一月の必要な未開始Reservation再分類
- 再分類対象Reservationの `automatic_classification` / `classification` 更新
- AuditLog
- 再分類による区分変更NotificationIntent

生徒本人のキャンセル自体に対する専用キャンセルNotificationIntentは初期リリースでは作成しない。

### 6.2 開始前／開始後

開始前、開始後〜終了時刻のどちらでも、キャンセル成立時には元Reservationによる `SlotOccupancy` を終了する。

- 開始前: Slotがenabledで他条件を満たせば再予約可能。
- 開始後〜終了: OccupancyがなくてもServer時刻ルールにより新規予約不可。

開始後キャンセルを表現するためにOccupancyを残さず、LessonSlotを自動disabled化せず、専用closed状態も追加しない。

### 6.3 最新状態再検証

少なくとも次をCommit時に再検証する。

- 対象Reservationが操作中生徒自身のもの
- `status = confirmed`
- Server Commit基準時刻がLesson終了時刻を超えていない
- 現在の `SlotOccupancy` が対象Reservationを参照
- Slot ID一致

先にスクール都合キャンセル、システム起因キャンセル等が正常Commitされていれば上書きしない。最初に正常Commitされた取消種別を正本とする。

## 7. Server Commit基準時刻

予約期限、キャンセル期限、開始前／開始後、再分類の開始済み境界、system cancellation対象判定には、同一Command内で一貫した信頼できるServer Commit基準時刻を用いる。

Client時刻・画面表示時刻を業務期限判定の正本としない。

利用者が開始前に操作を開始しても最終判定時に開始時刻を越えていれば、その時点の業務ルールを適用する。開始済みReservationの `automatic_classification` は通常の再分類で変更しない。

## 8. スクール都合キャンセルCommand

要求仕様v1.10の `BR-063 / BR-116 / AC-103-004 / AC-313-005〜009` に従い、スクール都合キャンセルは原則Lesson開始前に実行するが、実際にスクール都合でLessonが実施されず緊急事情等で当時の操作ができなかった場合は、現在も未取消のconfirmed ReservationをLesson開始後・終了後に事後登録できる。

通常取消と事後登録は別のReservation statusへ分離せず、どちらも `school_cancelled` とする。通常／事後の別は同一Commandで用いるServer Commit基準時刻 `T` とLesson開始時刻から導出する。

### 8.1 共通の原子的Transaction境界

スクール都合キャンセルでは、少なくとも次を同一Transactionで確定する。

- `StudentReservation.status = school_cancelled`
- `cancelled_at = T`
- `SchoolCancellationDetail`
- 対象Reservationの `classification = NULL`
- 対象Reservationの `automatic_classification` は保持
- 元Reservationの `SlotOccupancy` 終了
- 通常取消／事後登録に応じたキャンセル後Slot取扱い
- 同一生徒・同一月の必要な未開始Reservation再分類
- 再分類対象Reservationの `automatic_classification` / 実効classification更新
- AuditLog
- アプリ内未確認通知
- スクール都合キャンセルのメールNotificationIntent
- `REQ-104` に該当する区分変更NotificationIntent

その一部だけをCommitしない。外部メール実送信はCommit後とする。

開始済みReservation自身の `automatic_classification` は事後キャンセルを理由に遡及変更しない。事後キャンセルにより開始済みstandard Reservationが月間算入対象外となって消費済み自動標準枠が減少する場合、その影響は未開始Reservationの再分類にのみ反映する。

### 8.2 通常取消のキャンセル後Slot状態

Server Commit基準時刻 `T < LessonSlot.start_time` の通常取消では、Reservation取消だけを理由に暗黙の `enabled + unoccupied` へ遷移させない。

キャンセル後Slot状態は業務目的に応じ次のいずれかへ明示的に遷移させる。

1. `disabled + 占有なし`
2. `enabled + AdminHold等の別占有`
3. 明示的に再開放した `enabled + 占有なし`

「何も指定しなかった結果として空き枠になる」挙動を禁止する。`disabled` のSlotへ新たなOccupancyを作成しない。

AdminHold等の別占有を成立させる場合は、対象占有作成をschool cancellationと同一の原子的Transaction境界で整合させる。

### 8.3 Lesson開始後・終了後の事後登録

`T >= LessonSlot.start_time` の場合は事後スクール都合キャンセルとして扱う。

事後登録の `cancelled_at` は実際に管理者が確定したServer Commit基準時刻 `T` とし、Lesson開始時刻・終了時刻その他の過去時刻へ遡及させない。

事後登録では元Reservationの `SlotOccupancy` を終了するが、対象Slotを再開放しない。school cancellationだけを理由に `LessonSlot.availability_status` を変更せず、Server時刻が開始境界を越えているため新規予約不可とする。

```text
開始済み／終了済みSlot
  + 元Reservation Occupancy終了
  + availability_statusは事後キャンセルだけでは変更しない
  + Server時刻条件により新規予約不可
```

過去・開始済みSlotを再び未来の予約可能枠として扱う状態変更は行わない。

初期リリースでは事後登録に固定日数の期限を設けない。ただし、システム上参照可能で、Commit時点でも未取消の `confirmed` Reservationであることを必須とする。

### 8.4 事後登録の業務事実確認とAudit

システムは「実際にスクール都合でLessonが実施されなかった」という事実を自動判定しない。

事後登録では管理者がその業務事実を明示的に確認してCommandを確定する。この確認を単なるClient入力の自動事実判定として扱わず、管理者Actorによる業務判断としてAuditLogから追跡可能にする。

具体的な確認FieldやAudit Event属性はAPI詳細設計で確定する。

### 8.5 欠席との関係

対象Reservationに `ReservationAbsence` が存在する場合、スクール都合キャンセルCommandを成立させない。

`AC-313-007` に従い、管理者は先に欠席解除Commandを明示的に実行する。

```text
欠席記録あり
  → school cancellation 不成立
  → 欠席解除を別Commandで確定
  → 最新状態でschool cancellationを再確認
```

school cancellationの副作用として欠席を暗黙に解除・削除しない。

### 8.6 Preview後の最新状態再検証

スクール都合キャンセルConfirmでは、少なくとも次を最新確定状態で再検証する。

- 対象Reservationが現在も `status = confirmed`
- 欠席が未設定
- Server Commit基準時刻 `T` による通常取消／事後登録の別
- 対象Reservationと現在のSlotOccupancyの整合
- 通常取消で確認したキャンセル後Slot状態が現在も成立可能
- 同一生徒・同一月の算入状態・標準回数・Lesson開始境界
- 影響する未開始Reservation集合と変更前後classification

Preview時から、対象Reservation状態、欠席、通常／事後の別、キャンセル後Slot状態、影響Reservation集合または変更前後classification等の重要影響が変化している場合は、Commandを成立させずConflictとして再確認へ戻す。

先に生徒キャンセル・system cancellation・別のschool cancellation等が正常Commitされていれば上書きしない。最初に正常Commitされた取消状態を正本とする。

### 8.7 通知

通常取消・事後登録のどちらでも、`REQ-103` に従うアプリ内未確認通知とメールNotificationIntentを同一Transactionに含める。

事後登録では `AC-103-004 / BR-116` に従い、生徒がLesson開始後に事後登録されたschool cancellationであることを理解できる通知内容とする。

Resend等への外部メール送信はCommit後に行う。送信失敗によって確定済みのschool cancellation、Slot状態、アプリ内通知、再分類等をRollbackしない。

## 9. 生徒削除起因system cancellation

### 9.1 即時Transaction境界

初期リリースでは主として `SystemCancellationDetail.reason_code = student_deleted` を扱う。

生徒削除の正常Commitでは、少なくとも次を同一TransactionでAll-or-Nothingに確定する。

- 対象生徒を通常利用不能な削除確定状態へ遷移
- 既存Session無効化
- Server Commit基準時刻 `T` で将来と判定される全 `confirmed` Reservationを `system_cancelled` 化
- 各 `cancelled_at = T`
- 各 `SystemCancellationDetail(reason_code = student_deleted)`
- 各 `classification = NULL`
- 各 `automatic_classification` は保持
- 対応する `SlotOccupancy` 終了
- 開始前Slotを最新状態から予約可否判定可能な状態へ戻す
- 個人情報削除・匿名化の後続処理必要状態の永続化
- AuditLog

複数の将来Reservationは対象集合全体を1つの整合単位とし、一部だけ取消して生徒削除をCommitしない。

### 9.2 対象時刻

削除対象は少なくとも次を満たすReservationとする。

```text
status = confirmed
AND LessonSlot.start_time > T
```

開始済み・過去Reservationを `student_deleted` を理由に遡及キャンセルしない。

### 9.3 Preview後の競合

管理者が確認したPreview時の将来Reservation対象集合とCommit直前の対象集合が異なる場合はConflictとする。

```text
Preview対象集合 != Commit直前対象集合
  → 部分適用しない
  → 最新影響を表示
  → 再確認
```

### 9.4 個人情報の削除・匿名化

氏名、連絡先メール、Google紐付け等の直接管理する個人情報の実削除・匿名化は即時生徒削除Transactionに含めない。

生徒削除Commit時に個人情報削除・匿名化の後続処理必要状態をD1へ永続化し、Worker停止等があっても要求を失わない。個人情報の実削除・匿名化は24時間以内の後続処理とする。

個人情報削除・匿名化用Entity、列、Scheduled Job等は認証・アカウント設計／詳細設計で確定する。

### 9.5 classification

`student_deleted` では同一生徒の将来confirmed Reservationをすべて取消すため、正常Commit後に未開始confirmed Reservationは残らない。

対象Reservationは `classification = NULL` とし、`automatic_classification` を保持する。初期リリースでは残存未開始Reservationへの通常の月間再分類は原則不要とする。

生徒削除に伴うsystem cancellation自体には専用キャンセルNotificationIntentを生成しない。

### 9.6 生徒削除中にInvariant違反を検出した場合

削除対象の将来Reservationまたは対応するSlotOccupancyに永続化済みInvariant違反を検出した場合、その対象だけを飛ばして残りの生徒削除を正常Commitしない。

生徒削除Transaction全体をFail Closedとし、Rollback後にIntegrity Incidentを独立記録する。削除TransactionがCommitされていないため、対象生徒を削除済み扱い、Session無効化済み扱い、または一部予約だけ取消済み扱いにしない。

整合性修復中にも即時の利用停止が必要な場合は、生徒削除と混同せず既存のSecurity Suspensionを封じ込め手段として使用できる。

## 10. 分類管理Command

本節は `04_ReservationModel.md` の月間算入・自動分類・Classification Overrideモデルを、重要Write CommandのTransaction境界として確定する。

月間標準回数変更と月間回数除外設定・解除は自動再分類の入力を変える。一方、Classification Overrideは対象Reservationの実効classificationだけを変更し、他Reservationのautomatic_classificationを変更しない。この差異をTransactionでも維持する。

### 10.1 月間標準回数変更

月間標準回数変更では、少なくとも次を1つのTransactionでCommitする。

- 対象生徒・対象月の `StudentMonthlyLessonConfig.standard_count` の設定または変更
- 同一生徒・同一月の消費済み自動標準枠の再評価
- 必要な未開始・算入対象Reservationの再分類
- 再分類対象Reservationの `automatic_classification` / 実効classification更新
- AuditLog
- `REQ-104` に該当する区分変更NotificationIntent

Commit時は最新のReservation状態、欠席、`ReservationMonthlyCountOverride`、標準回数、Server Commit基準時刻によるLesson開始境界等を再検証する。

Previewで管理者が確認した影響Reservation集合または変更前後classificationがCommit直前の最新状態と重要に異なる場合は、変更を成立させずConflictとして再確認へ戻す。

開始済みReservationの `automatic_classification` は変更しない。

### 10.2 月間回数除外の設定・解除

月間回数除外の設定または解除では、少なくとも次を1つのTransactionでCommitする。

- `ReservationMonthlyCountOverride` の設定または解除
- 対象Reservationの最新条件からの実効算入可否再評価
- 対象Reservationの実効classification更新
- 同一生徒・同一月の消費済み自動標準枠の再評価
- 必要な未開始・算入対象Reservationの再分類
- 再分類対象Reservationの `automatic_classification` / 実効classification更新
- AuditLog
- `REQ-104` に該当する区分変更NotificationIntent

除外設定時は対象Reservationを月間算入対象外とし、`classification = NULL` とするが、`automatic_classification` は保持する。

除外解除は、対象Reservationを無条件に算入対象へ戻す処理ではない。`ReservationMonthlyCountOverride` を解除した後、Reservationのstatus、欠席その他の算入条件を含む最新確定状態から実効算入可否を再評価する。

解除後もキャンセル済み・欠席等により算入対象外であれば `classification = NULL` を維持する。解除後に算入対象となる場合は、対象Reservation自身には保持済み `automatic_classification` と必要に応じ保持済み `ReservationClassificationOverride` を適用し、消費済み自動標準枠の変化は未開始Reservationの再分類にだけ反映する。

Commit時は対象Reservationの算入条件、標準回数、Lesson開始境界、影響する未開始Reservation集合と変更前後classificationを最新状態で再検証する。Preview時の重要影響と異なる場合はConflictとして再確認へ戻す。

### 10.3 Classification Override

Classification Overrideの設定・変更・解除では、少なくとも次を同一Transactionで整合させる。

- `ReservationClassificationOverride` の設定・変更・解除
- 対象Reservationの実効classification更新
- AuditLog
- `REQ-104` に該当する区分変更NotificationIntent

対象Reservationが月間算入対象である場合、Override設定・変更時はOverride値を実効classificationへ反映する。Override解除時は保持済み `automatic_classification` を実効classificationへ戻す。

既存Overrideを持つReservationがキャンセル、欠席、月間回数除外等によって分類対象外となっている場合は、Override自体を明示解除まで保持できるが、分類対象外の間は `classification = NULL` を維持する。

Classification Overrideの設定・変更・解除だけを理由に、他Reservationのautomatic_classification、消費済み自動標準枠、割当順を変更しない。

専用Preview APIを設けない場合でも、対象Reservationの最新ライフサイクル・算入状態・classification等をCommit時に再検証し、管理者が確認した状態からCommandの意味または実効結果が重要に変化している場合は確定状態を無言で上書きしない。

### 10.4 通知境界

分類管理Commandによって実効classificationが `standard → additional` または `additional → standard` へ変化したReservationには `REQ-104` に従うNotificationIntentを生成する。

月間回数除外等によりstandard / additionalから分類対象外へ変化すること自体は、`REQ-104` のstandard / additional区分変更として機械的に通知対象へ含めない。

## 11. 欠席設定・解除Command

本節は `OI-BD-009` で確定した欠席設定・解除について、`04_ReservationModel.md` の `ReservationAbsence` と要求仕様v1.11の `REQ-315 / AC-315-001〜005` をTransaction境界として具体化する。

欠席はReservationライフサイクル状態ではない。設定・解除によって月間算入状態と消費済み自動標準枠が変化し、未開始Reservationへ再分類影響が波及し得るため、対象Reservation自身と派生する再分類・監査・必要な通知義務を同一Transactionで整合させる。

### 11.1 共通Guard

欠席設定・解除では、少なくとも次をCommit時に最新確定状態から再検証する。

- 対象Reservationが `status = confirmed`
- 信頼できるServer Commit基準時刻 `T` が `LessonSlot.end_time` 以上
- 設定Commandでは `ReservationAbsence` が存在しない
- 解除Commandでは `ReservationAbsence` が存在する
- 対象Reservationの `ReservationMonthlyCountOverride` 等を含む最新の月間算入条件
- 同一生徒・同一月の `StudentMonthlyLessonConfig.standard_count`
- 影響する未開始Reservation集合と変更前後classification

Preview時から対象Reservation状態、欠席状態、算入状態、標準回数、影響Reservation集合または変更前後classification等の重要影響が変化している場合は、Commandを成立させずConflictとして再確認へ戻す。

先に生徒キャンセル、school cancellation、system cancellation等が正常Commitされていれば、欠席設定・解除によってキャンセル状態を上書きしない。

### 11.2 欠席設定Transaction

欠席設定では少なくとも次を1つのTransactionでCommitする。

- 対象Reservationへの `ReservationAbsence` 作成
- 対象Reservationの実効classificationを `NULL`（仕様上「分類対象外」）へ更新
- 対象Reservationの `automatic_classification` は保持
- 同一生徒・同一月の消費済み自動標準枠を再評価
- 必要な未開始・算入対象Reservationの再分類
- 再分類対象Reservationの `automatic_classification` / 実効classification更新
- AuditLog
- `REQ-104` に該当する区分変更NotificationIntent

欠席設定だけを理由に `StudentReservation.status`、`cancelled_at`、`LessonSlot`、`SlotOccupancy` を変更しない。Lesson終了済みの過去Slotを再開放しない。

開始済みReservation自身の `automatic_classification` は欠席設定を理由に遡及変更しない。欠席設定により開始済み自動standardが月間算入対象外となって空いた自動標準枠は、未開始Reservationの再分類にのみ反映する。

### 11.3 欠席解除Transaction

欠席解除では少なくとも次を1つのTransactionでCommitする。

- 対象Reservationの `ReservationAbsence` 解除
- 解除後の最新条件から対象Reservationの実効算入可否を再評価
- 対象Reservationの実効classification更新
- 同一生徒・同一月の消費済み自動標準枠を再評価
- 必要な未開始・算入対象Reservationの再分類
- 再分類対象Reservationの `automatic_classification` / 実効classification更新
- AuditLog
- `REQ-104` に該当する区分変更NotificationIntent

欠席解除は対象Reservationを無条件に月間算入対象へ戻す処理ではない。`ReservationAbsence` を解除した後、`ReservationMonthlyCountOverride` 等の最新算入条件を再評価する。

解除後も月間回数除外Override等により算入対象外であれば `classification = NULL` を維持する。解除後に算入対象へ戻る場合は、開始済みReservationの `automatic_classification` を再計算せず、保持済みautomatic_classificationと、存在する場合は保持済み `ReservationClassificationOverride` を実効classificationへ反映する。

消費済み自動標準枠の増加による影響は、未開始Reservationの再分類にのみ反映する。他の開始済みReservationのautomatic_classificationを遡及変更しない。

### 11.4 通知境界

`AC-315-004 / BR-062` に従い、欠席設定または解除それ自体に対する専用の生徒向け自動メールNotificationIntentは生成しない。

一方、欠席設定・解除の同一Transactionで既存Reservationの実効classificationが `standard → additional` または `additional → standard` へ変化した場合は、`REQ-104` に従う区分変更NotificationIntentを生成する。

対象Reservationが欠席設定によってstandard / additionalから分類対象外へ変化すること自体は、`REQ-104` のstandard / additional区分変更として機械的に通知対象へ含めない。

## 12. AuditLog

### 12.1 成功Commandと同一Transaction

成功した重要業務Commandでは、業務状態変更と `AuditLog(success)` を同一Transactionに含める。

AuditLog作成失敗時は重要業務Command全体を正常Commitしない。

### 12.2 監査単位

監査単位はSQL文やDB行ではなく、意味のある業務Commandとする。

Audit Eventは少なくとも次を必要最小限で表現できるようにする。

- 時刻
- 操作種別
- Actor IDまたはシステム主体
- 主対象種別・対象ID
- 最小限のBefore / After
- 結果
- 同一Commandによる派生変更との因果関係

再分類や複数system cancellation等は元Commandから追跡可能にする。

### 12.3 代表的な同一Transaction監査対象

少なくとも次を対象とする。

- 予約成立
- 生徒キャンセル
- スクール都合キャンセル（事後登録を含む）
- 生徒削除 / student_deleted system cancellation
- 月間標準回数変更
- 月間回数除外設定・解除
- ClassificationOverride設定・変更・解除
- 欠席設定・解除
- Reservationへ影響するSchedule変更
- AdminHold / GroupLesson等の現在占有変更
- Security Suspension等の重要管理Command
- Integrity Incidentの明示Repair Command

### 12.4 Conflict・拒否

業務状態を変更しないConflictや重要な拒否は、必要なものだけを成功Transactionとは別のAudit記録として永続化する。

拒否Audit失敗によって利用者結果をSuccessへ変更したり、業務状態を書き換えたりしない。監査書込み失敗自体は技術Log / Monitoring対象とする。

### 12.5 Business Auditと技術Log

- Business Audit: 重要業務操作の正式監査記録。原則1年保持。
- Technical / Error / Security Log: 例外、Provider失敗、診断情報等。原則30日程度。

技術LogをBusiness Auditの代替正本としない。

AuditLogは通常Application CommandからAppend-onlyとし、保持期限または個人情報削除・匿名化以外で過去の監査事実を上書きしない。氏名・メール等を必要なく複製せず、個人情報削除要求を保持期間より優先する。

## 13. NotificationIntentと外部送信

### 13.1 通知義務を同一Transactionで永続化する

業務Commandの正常Commitによって通知義務が発生する場合、その「送るべき通知が存在する」という内部事実を `NotificationIntent` として、業務状態および必要なAuditLogと同一Transactionに含める。

NotificationIntent作成失敗時は、その通知を必須とする業務Command全体を正常Commitしない。

### 13.2 外部送信はCommit後

Resend等の外部Providerへの実送信はD1 Transactionに含めず、必ず正常Commit後に行う。Commit前にメールを送信しない。

外部送信失敗、Timeout、Provider障害等によって確定済み業務状態をRollbackしない。

### 13.3 IntentとDeliveryを分離する

```text
NotificationIntent
  = 何を、誰に通知すべきかという内部通知義務

NotificationDelivery
  = Providerへ送信を試み、どうなったかという配送状態
```

Provider受理、失敗、試行時刻、Provider Message ID等はDelivery側で扱い、Provider固有情報をReservation等のDomain Entityへ直接混在させない。

### 13.4 通知先

予約確認、区分変更、スクール都合キャンセル等の通常予約系Intentは、`recipient_student_id` 等の内部識別子による論理的通知先を基本とし、メールアドレスを必要なくIntentへ複製しない。

実送信時に有効な連絡先を解決し、実際に送った宛先をDelivery側へ必要最小限記録する。

旧連絡先へのSecurity Notice等、特定メールアドレス自体に業務意味がある通知は、認証・通知設計で宛先Snapshot等を別途定義する。

### 13.5 複数Intent

1つの業務Commandから複数通知義務が発生する場合、必要なNotificationIntentを同じTransactionで原子的に生成する。

対象Intentの一部だけ欠落した状態を正常Commitとして許容しない。

### 13.6 Retry

一時的送信失敗や再試行のたびに新しいNotificationIntentを作成せず、同一Intentに対するDelivery Attemptとして扱う。

Intent ID等から安定した冪等性識別子を導出できるようにする。Provider受理後はApplication Workerから盲目的に同一メールを重複再送せず、最終Permanent Failureは通知失敗管理対象とする。

## 14. 未来Slotの現在状態Invariant

本節は `BR-067 未来枠の現在予約状態の一貫性` の現在の実現設計である。将来データモデルを変更してもBR-067自体は維持する。

### 14.1 現在状態の正本

「現在予約可能か」「何によって占有されているか」「生徒予約なら誰か」は `LessonSlot + SlotOccupancy` を基点に判定する。

現在予約者は次の経路で取得する。

```text
LessonSlot
  → SlotOccupancy
  → StudentReservation
  → Student
```

Reservation履歴一覧から現在占有を推測しない。

### 14.2 常時成立させるInvariant

未来Slotでは少なくとも次を成立させる。

1. `SlotOccupancy.slot_id` はUNIQUE。
2. `occupancy_type = student_reservation` では `reservation_id` 必須。
3. 参照先StudentReservationは存在し `status = confirmed`。
4. `StudentReservation.lesson_slot_id = SlotOccupancy.slot_id`。
5. キャンセル済みReservationを現在占有として参照しない。
6. 未来の有効なconfirmed Reservationが現在Slotを占有する場合、対応するSlotOccupancyが存在する。
7. `LessonSlot.availability_status = disabled` では現在占有を残さない。
8. `enabled + SlotOccupancyなし` でも、公開状態・Server時刻等の他条件を満たす場合にのみ予約可能。

### 14.3 Invariant違反時はFail Closed

永続化済みInvariant違反を検出した場合、矛盾を都合よく解釈して新規予約を成立させない。

例えばキャンセル済みReservationをSlotOccupancyが参照している場合、Occupancyを無視して空き扱いにしない。

通常の利用者競合と永続化済みInvariant違反を区別する。後者を通常Commandの副作用として無言で自動修復しない。

### 14.4 検知経路はCommand Guardと定期Integrity Scanの二系統とする

Invariant違反は、予約・キャンセル等の重要Command内でのGuardに加え、Scheduled Handlerによる定期Integrity Scanでも検知する。

```text
重要Command
  → Commit-time Invariant Guard

Scheduled Handler
  → 未来LessonSlot Integrity Scan
```

初期リリースでは定期Scanを1時間ごとに実行することを既定とする。対象規模が小さいため、未来Slotを集合SQLで検査する方式を基本とする。具体的なCron式、分割、Query最適化は詳細設計で定義する。

Commandを誰も実行しないSlotでも不整合を検知できることを目的とする。

### 14.5 Integrity IncidentはRollback後に独立して永続化する

永続化済みInvariant違反を検出した場合、論理的な `IntegrityIncident` としてD1上で追跡可能にする。

少なくとも次の情報を個人情報最小で表現できるようにする。

- `incident_id`
- `anomaly_code`
- `target_type`
- `target_id`
- `status = open / resolved`
- `first_detected_at`
- `last_detected_at`
- `occurrence_count`
- `detected_by = command / scheduled_scan`

異常を検出した業務TransactionはRollbackするため、IntegrityIncidentの記録をその失敗Transaction内へ含めない。

```text
業務Transaction
  → Invariant違反
  → ROLLBACK

Rollback後
  → IntegrityIncidentを独立記録
```

Incident記録自体が失敗しても、利用者へのFail Closed判定をSuccessへ変更しない。この場合はTechnical Log / Monitoringをfallbackとする。

### 14.6 初期Invariant Code

初期リリースでは少なくとも次の内部異常コードを定義する。

| Code | 意味 |
|---|---|
| `INV-SLOT-001` | 同一Slotに複数の現在Occupancyが存在する |
| `INV-SLOT-002` | student_reservation OccupancyのReservation参照が欠落または不正 |
| `INV-SLOT-003` | Occupancyが参照するReservationが `confirmed` ではない |
| `INV-SLOT-004` | Occupancyの `slot_id` とReservationの `lesson_slot_id` が不一致 |
| `INV-SLOT-005` | 未来の有効な `confirmed` Reservationに対応Occupancyがない |
| `INV-SLOT-006` | `disabled` SlotにOccupancyが存在する |

これらは保守用内部コードであり、利用者画面や公開APIへ直接表示しない。詳細設計でコードを追加する場合も既存コードの意味を安定させる。

### 14.7 利用者向けはIntegrity Anomalyとして503系へ抽象化する

永続化済みInvariant違反は、先行Commitによる通常競合ではないため `409 Conflict` として扱わない。

利用者向けHTTP APIでは原則 `503 Service Unavailable` とし、安定したApplication Error表現へ変換する。論理的な初期Application Errorは `INTEGRITY_STATE_UNAVAILABLE` とする。

利用者へは、例えば「現在この枠の状態を安全に確認できないため操作を完了できません。時間をおいて再度お試しください。」等、状態と次の行動が理解できる案内を表示する。

内部Invariant Code、対象内部ID、SQL、Stack Trace等はPOL-014 / BR-133 / REQ-914に従い露出しない。

### 14.8 Fail Closed範囲は影響対象を最小単位とする

1件のSlot不整合だけを理由に予約機能全体を自動停止しない。

例えばSlot Aだけに不整合がある場合、Slot Aは予約・関連変更をFail Closedとするが、Invariantが正常に成立している他Slotは通常利用可能とする。

一方、次のような場合は重大Incidentへ昇格し、予約機能全体の停止を含む保守判断の対象とする。

- 複数の無関係なSlotで同種異常が発生した。
- DeploymentやMigration後にIntegrity Incidentが急増した。
- DB全体の確定状態を信用できない兆候がある。

自動的な全サービス停止の具体Thresholdは詳細設計・運用設計で定義する。

### 14.9 Incidentと通知は重複集約する

同一の次の組をIntegrity Incidentのfingerprintとする。

```text
anomaly_code
+ target_type
+ target_id
```

同じfingerprintで `open` Incidentが既に存在する場合、新規Incidentを無制限に作成せず `last_detected_at` と `occurrence_count` を更新する。

保守担当者への通知は次を基本とする。

- 最初の検知: 通知する。
- 同一open Incidentの再検知: 集約し、Alert Stormを避ける。
- resolved後の再発: 新たな通知対象とする。
- 複数対象への拡大・急増: 重大Incidentへ昇格する。

これはBR-110およびREQ-942の重大障害監視・集約通知方針に従う。

### 14.10 修復は明示的なRepair Commandとして行う

通常の予約・キャンセルCommandの副作用としてInvariant違反を無言で自動修復しない。

修復は次の手順を基本とする。

```text
1. 対象をFail Closed
2. 最新DB状態・AuditLog等を調査
3. 正しい業務状態を一意に判断
4. 明示的なRepair Commandで修復
5. Repair操作をAuditLogへ記録
6. Invariantを再Scan
7. 全Invariant成立時のみIncidentをresolved
```

正しい状態を一意に判断できない場合は推測して修復しない。必要に応じスクール管理者が業務上の事実を確認し、明示的な判断を行ったうえでRepairする。

直接D1へ手作業SQLを流すことを通常の修復経路とせず、保守用Commandまたは検証済みScriptを通じて修復し、誰が・いつ・何を・なぜ修復したかをAuditLogで追跡可能にする。

### 14.11 保持方針

Integrity IncidentとRepair Auditの保持を分離する。

- `open` Integrity Incident: 解決まで保持する。
- `resolved` Incidentの技術診断情報: Technical / Error Logと同様に原則30日程度を基本とする。
- Repair Commandの正式AuditLog: REQ-940に従い原則1年保持する。
- 個人情報削除要求は上記保持期間より優先する。

## 15. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-002 無料枠優先・Must要件優先
- POL-003 業務状態と外部連携の分離
- POL-004 個人情報最小化
- POL-005 通知は即時性、システム画面は確実性
- POL-006 ロール分離と最小権限
- POL-007 外部Provider依存の局所化
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-013 重要な管理操作の説明性と監査可能性
- POL-014 利用者向けエラー情報の安全な抽象化
- BR-050〜BR-060 予約・キャンセル・月間分類
- BR-061 欠席
- BR-062 欠席表示
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- BR-067 未来枠の現在予約状態の一貫性
- BR-068 生徒本人予約の所有者同一性
- BR-069 生徒一括予約
- BR-100 生徒削除
- BR-110 重大障害通知
- BR-111〜BR-116 通知
- BR-123〜BR-125 生徒削除時処理
- BR-131 管理操作説明
- BR-132 監査
- BR-133 利用者向けエラー表現
- REQ-002 / REQ-003 / REQ-004 / REQ-008 予約・キャンセル・一括予約
- REQ-101〜REQ-105 通知
- REQ-103 / REQ-104 / REQ-110 通知・システム表示
- REQ-207 Session管理
- REQ-302 / REQ-307 / REQ-308 / REQ-309 / REQ-310 / REQ-313 / REQ-315 / REQ-316 / REQ-317 管理操作
- REQ-311 / REQ-312 生徒削除
- REQ-907 業務Timezone
- REQ-911 競合整合性
- REQ-912 外部API Retry
- REQ-913 無料枠運用
- REQ-914 障害・エラー時利用者表示
- REQ-940 監査Logging
- REQ-942 監視・重大Incident
- REQ-951 Provider分離
- CON-001 Cloudflare Platform

## 16. 詳細設計へ送る事項

`OI-BD-006` の基本設計論点はすべて確定済みとする。

以下は本基本設計の原則を維持した上で詳細設計（C4 Level 3）または運用設計で具体化する。

- 個別DDL、Index、具体的Guard SQL、CTE
- Application Error Codeの追加値、HTTP Response Schema、Correlation ID
- Command Idempotency Key
- 一括予約ConfirmのExpected Stateの具体表現、Guard SQL、集合書込みSQL、Conflict Responseの具体Wire表現
- 一括予約Confirmの操作識別子の具体Field、同一内容の比較、保存Entity、保持期間、一意性Guard、再送Response表現
- 分類管理Commandの具体的Guard SQL、集合再分類SQL、Expected Stateの具体表現
- school cancellationの通常／事後分岐Guard、欠席Guard、事後登録確認Auditの具体表現
- 欠席設定・解除のLesson終了Guard、欠席有無Guard、実効算入再評価、集合再分類SQL、Expected Stateの具体表現
- Integrity Scanの具体Cron式、分割・Query最適化
- Integrity Incidentの物理Schema・Index
- 重大Incidentへ昇格する具体Threshold
- Repair Command / Scriptの具体実装・権限制御・Runbook

## 17. 設計判断記録

- スクール都合キャンセル後のSlot状態は2026-08-28に確定した。
- 要求仕様v1.10に従い、スクール都合キャンセルは原則Lesson開始前、例外的に開始後・終了後も事後登録可能とし、事後登録の取消時刻を実際のServer Commit時刻、Slotは再開放しない、欠席は先に明示解除、事後登録の業務事実確認をAudit対象とする方針を2026-08-30に確定した。
- 予約確定CommandのTransaction境界、Commit直前再検証、classification Conflict、既存Reservation再分類の同一Commit方針は2026-08-28に確定した。
- `REQ-008 / AC-008-001〜009 / BR-069` に従い、一括予約Confirmを選択Slot集合全体の1業務Commandとし、D1上でReservation、Occupancy、必要な再分類、AuditLog、通知義務をAll-or-Nothingに確定する。Commit直前の最新状態再検証、競合時の全体Rollback、および安全に検出できた範囲に限るConflict Responseの方針を2026-09-02に確定した。
- 一括予約ConfirmのExpected Stateを、選択Slot集合、対象月、最新N、Slot予約可能状態、新規classification、既存未開始Reservationへのclassification影響の業務的Snapshotとして再確認する方針を2026-09-02に確定した。Expected StateはClientの更新値・正本ではなく、最新確定状態からの再計算との一致確認に用いる。これとは別に、同一操作識別子・同一内容の再送では先に確定した結果を返して二重確定を防ぎ、異なる内容での同一識別子再利用は別操作として実行せずRejectする方針を同日に確定した。
- 生徒キャンセルCommandのTransaction境界、開始前／開始後の占有終了、最新状態再検証、Server Commit基準時刻、分類更新方針は2026-08-28に確定した。
- 生徒削除起因system cancellationの即時Transaction境界、個人情報削除・匿名化の後続処理分離、対象集合All-or-Nothing、Preview競合方針は2026-08-28に確定した。
- 月間標準回数変更、月間回数除外設定・解除、Classification OverrideのTransaction境界、最新状態再検証、再分類・AuditLog・NotificationIntentの同一Commit方針は2026-08-30に確定した。月間回数除外解除は無条件な再算入ではなく、Override解除後に最新の算入条件から実効算入可否を再評価する。
- 要求仕様v1.11に従い、欠席設定・解除はLesson終了済みの未取消confirmed Reservationを対象とし、`ReservationAbsence`、対象Reservationの実効classification、消費済み自動標準枠再評価、必要な未開始Reservation再分類、AuditLog、必要な区分変更NotificationIntentを同一Transactionで整合させる方針を2026-08-30に確定した。
- 欠席解除は無条件な再算入ではなく、`ReservationAbsence` 解除後に月間回数除外等の最新条件から実効算入可否を再評価する。欠席設定・解除そのものの専用メールは生成せず、波及したstandard / additional区分変更だけを `REQ-104` に従い通知する。
- 未来Slotの現在占有Invariant、ADR-002参照方向、Fail Closed方針は2026-08-28に確定した。
- 未来Slot一貫性は要求仕様v1.3の `BR-067` として要求化済みである。
- AuditLogを成功した重要業務Commandと同一Transactionへ含め、監査単位を業務Commandとし、Conflict監査を分離する方針は2026-08-28に確定した。
- NotificationIntentを通知義務として業務状態と同一Transactionへ含め、外部送信とDelivery状態を分離する方針は2026-08-28に確定した。
- D1重要Write Commandで `withSession("first-primary").batch()` とPrepared Statementを基本とし、Transaction内Guard、集合指向SQL、安定したApplication Errorへの変換、Writeの盲目的Retry禁止を採用する方針は2026-08-28に確定した。
- 利用者向け内部エラー非露出の方針は要求仕様v1.4の `POL-014` / `BR-133` / `REQ-914` として上位要求化し、本書4章をその実現設計としてトレースする。
- Invariant違反について、Command Guardと1時間ごとのIntegrity Scanの二系統検知、IntegrityIncidentの独立永続化、内部異常コード、原則503への抽象化、影響対象単位のFail Closed、Alert集約、明示Repair、再Scan後の解決判定を2026-08-28に確定した。
- 上記確定により `OI-BD-006` の基本設計論点はすべて完了した。
