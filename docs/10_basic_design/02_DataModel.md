# 02. データモデル基本設計

## 1. 目的

本書は、要求仕様を論理データモデルへ落とし込むための基本方針を定義する。

本段階ではエンティティ間の責務と関係、整合性を担保する主要なキー・制約を確定する。D1の最終カラム型、補助Index、DDLは後続の物理データ設計で確定する。

## 2. 主要概念

以下を基本概念として扱う。

- `Student` — 生徒本人を表す。
- `LessonSlot` — 公開・管理対象となる固定レッスン時間枠を表す。
- `SlotOccupancy` — LessonSlotの現在の占有を表す共通レコード。
- `StudentReservation` — 生徒による個人レッスン予約の業務レコード。キャンセル等の履歴、自動分類値、現在の実効分類を保持する。
- `ReservationAbsence` — 予約に対する欠席状態。キャンセルとは別概念として扱う。
- `ReservationMonthlyCountOverride` — 管理者による月間回数算入の例外。
- `ReservationClassificationOverride` — 管理者による標準／追加区分の明示Override。
- `SchoolCancellationDetail` — スクール都合キャンセル固有の理由カテゴリ・補足。
- `SystemCancellationDetail` — 生徒削除等のシステム処理由来キャンセル固有の原因情報。
- `StudentMonthlyLessonConfig` — 生徒・月単位の標準レッスン回数設定。
- `AdminHold` — スクール管理者による運営上の枠確保。
- `GroupLesson` — グループレッスンとしての枠占有。

`IntegrityIncident` は上記の予約・占有業務Entityとは責務を分離した**運用・整合性監視Entity**として扱う。これは予約状態・現在占有の正本ではなく、永続化済みInvariant違反の検知・集約・解決状態を追跡するための運用記録である。論理属性と運用ルールは `05_BookingAndConcurrency.md` を正とし、物理Schemaは詳細設計で確定する。

`StudentReservation`、`AdminHold`、`GroupLesson` は「枠を占有する」という点では共通するが、業務上は異なる意味を持つため同一状態として扱わない。

また、Reservation周辺でも、予約ライフサイクル、取消種別、欠席、月間回数算入、自動分類、実効classification、明示Overrideを同一状態へ統合しない。

## 3. Student・LessonSlot・StudentReservation の関係

### 3.1 Student と StudentReservation

`Student` と `StudentReservation` は **1対多** とする。

`StudentReservation` が対象生徒を示す `student_id` を保持する。

```text
Student 1 ───── 0..* StudentReservation
```

`Student` 側には予約ID一覧や予約配列を永続データとして重複保持しない。

### 3.2 LessonSlot と StudentReservation

`StudentReservation` は予約対象の `LessonSlot` を示す `lesson_slot_id` を直接保持する。

```text
LessonSlot 1 ───── 0..* StudentReservation
```

同一 `LessonSlot` に複数の `StudentReservation` が存在することを許容する。これは二重予約を許す意味ではなく、次のような予約履歴を保持するためである。

```text
LessonSlot #100
├─ Reservation #501 : student_cancelled
├─ Reservation #502 : school_cancelled
├─ Reservation #503 : system_cancelled
└─ Reservation #504 : confirmed
```

`confirmed` は予約成立後にキャンセルされていない状態を表し、Lesson終了後も時間経過だけでは別状態へ遷移しない。

過去に成立した予約がキャンセルされた後、同じ枠が再予約された場合でも、過去のReservationを削除・上書きせず新しいReservationを作成する。

### 3.3 生徒別予約一覧

「ある生徒の予約一覧」は独立した永続データではなく、`StudentReservation` を `student_id` で検索して構成する **Query結果 / View Model** として扱う。

```sql
SELECT ...
FROM student_reservations
WHERE student_id = ?
```

予約日時等を取得する場合は `StudentReservation.lesson_slot_id` から `LessonSlot` をJoinする。

`student_id` に適切なIndexを設け、Student側へ予約一覧を重複保存しない。

### 3.4 Reservation周辺の分離

`StudentReservation` は予約ライフサイクル状態に加え、次の2つの分類値を保持する。

- `automatic_classification` — 自動分類ロジックによる `standard` / `additional`。Lesson開始前は再計算され得るが、Lesson開始後は自動では変更しない。
- `classification` — 現在の実効classification。月間算入対象では自動分類またはClassificationOverrideの結果、算入対象外ではNULL。

一方、次の状態・例外・理由詳細は別Entityとして保持する。

```text
StudentReservation 1 ───── 0..1 ReservationAbsence
                   ├───── 0..1 ReservationMonthlyCountOverride
                   ├───── 0..1 ReservationClassificationOverride
                   ├───── 0..1 SchoolCancellationDetail
                   └───── 0..1 SystemCancellationDetail
```

- `ReservationAbsence` — 欠席。キャンセル状態とは独立する。
- `ReservationMonthlyCountOverride` — 月間回数への算入例外。標準／追加区分のOverrideではない。
- `ReservationClassificationOverride` — standard / additional の明示Override。
- `SchoolCancellationDetail` — `school_cancelled` 固有の理由詳細。
- `SystemCancellationDetail` — `system_cancelled` 固有の原因詳細。初期リリースでは少なくとも `reason_code = student_deleted` を扱う。

`StudentReservation.status` の初期ライフサイクル値は少なくとも `confirmed`、`student_cancelled`、`school_cancelled`、`system_cancelled` とする。`system_cancelled` は、生徒本人またはスクール管理者による明示キャンセルではなく、生徒削除等のシステム処理に伴って自動取消されたReservationを表す。

取消日時は取消種別にかかわらず `StudentReservation.cancelled_at` に保持する。`confirmed` では `cancelled_at = NULL`、`student_cancelled` / `school_cancelled` / `system_cancelled` では `cancelled_at` を必須とする。`updated_at` は取消後の別更新でも変化し得るため、取消日時の代用にはしない。

取消の大分類は `status` から一意に導出できるため、`cancelled_by_type` のような重複属性は持たない。どの生徒・スクール管理者・システム処理が取消操作を実行したかという具体ActorはAuditLog等の監査情報へ分離し、Reservation本体へ取消主体IDを重複保存しない。

現在の実効月間算入可否は、Reservationライフサイクル、欠席、`ReservationMonthlyCountOverride` から導出し、重複する真偽値をReservation本体へ正本として保存しない。

`classification` は月間算入対象Reservationにのみ適用する。月間算入対象外では仕様上「分類対象外（not applicable）」とし、物理的には `StudentReservation.classification = NULL` とする。`not_applicable` をclassificationの第3値としては保存しない。

`automatic_classification` は実効classificationとは別に保持する。月間算入対象外となって `classification = NULL` になっても、最後に確定している自動分類値は保持する。これにより、開始済みReservationが後から欠席・月間回数除外となっても過去の自動分類を遡及書換えせず、再び算入対象となった場合に確定済み自動分類を復元根拠として利用できる。

`ReservationClassificationOverride` は対象Reservationが一時的に分類対象外となっても明示解除されるまで保持し、再び算入対象となった際に再適用する。

### 3.5 生徒・月単位の標準回数と開始境界

標準レッスン回数は `StudentMonthlyLessonConfig` で管理する。

```text
Student 1 ───── 0..* StudentMonthlyLessonConfig
ScheduleMonth 1 ───── 0..* StudentMonthlyLessonConfig
```

論理的一意性は次のとおり。

```text
UNIQUE(student_id, schedule_month_id)
```

個別設定がない場合は初期既定値3回を適用する。

`standard_count` は自動分類でstandardを割り当てる基準数である。Lesson開始済みReservationの自動分類は固定し、再計算時には現在も算入対象で `automatic_classification = standard` の開始済みReservation数を消費済み自動標準枠として数える。

```text
remaining_standard_slots
  = max(standard_count - started_countable_auto_standard_count, 0)
```

この残り枠だけを、予定日時順の未開始・算入対象Reservationへ割り当てる。

## 4. SlotOccupancy の役割

### 4.1 決定

`SlotOccupancy` はD1に独立した実テーブルとして永続化し、**LessonSlotの現在の占有を表す**。

主要な関係は次のとおり。

```text
LessonSlot 1 ───── 0..1 SlotOccupancy
LessonSlot 1 ───── 0..* StudentReservation

SlotOccupancy
├─ StudentReservation を参照（生徒予約で占有中の場合）
├─ AdminHold
└─ GroupLesson
```

ここで重要なのは、`StudentReservation` の履歴関係と `SlotOccupancy` の現在占有関係を分離することである。

### 4.2 SlotOccupancy の最小論理属性

少なくとも次の論理属性を持つ。

- `id` — 占有レコード識別子
- `slot_id` — 対象 `LessonSlot`
- `occupancy_type` — 占有種別
- `reservation_id` — `occupancy_type = student_reservation` の場合に現在占有している `StudentReservation` を参照する。その他ではNULL
- `created_at` — 占有作成時刻
- `created_by` または同等の作成主体識別情報 — 監査要件との整合を踏まえ物理設計で具体化

占有種別は少なくとも次を持つ。

- `student_reservation`
- `admin_hold`
- `group_lesson`

`AdminHold` と `GroupLesson` の個別属性は対応する個別テーブル側に保持する。

### 4.3 現在占有の一意制約

`SlotOccupancy.slot_id` には **UNIQUE制約**を設ける。

```text
UNIQUE(slot_id)
```

これにより、1つの `LessonSlot` に同時に存在できる現在の占有を最大1件に制限する。

この制約は以下の競合に共通するDBレベルの最終保証点とする。

- 生徒予約 vs 生徒予約
- 生徒予約 vs 管理者確保
- 生徒予約 vs グループレッスン
- 管理者確保 vs グループレッスン

過去の `StudentReservation` が同じ `lesson_slot_id` を参照して複数存在しても、`SlotOccupancy` は最大1件であるため現在占有の一意性は維持される。

### 4.4 生徒予約による占有

`occupancy_type = student_reservation` の場合、`SlotOccupancy.reservation_id` は現在その枠を占有している `StudentReservation` を参照する。

```text
LessonSlot #100
├─ Reservation #501 : student_cancelled
├─ Reservation #502 : system_cancelled
└─ Reservation #503 : confirmed
        ▲
        │
   SlotOccupancy
   slot_id = #100
   reservation_id = #503
```

`reservation_id` が参照するReservationの `lesson_slot_id` は、`SlotOccupancy.slot_id` と同じLessonSlotでなければならない。

この整合性をDB制約のみでどこまで表現するか、Application WorkerのTransactionでどこまで担保するかは物理設計で確定する。

### 4.5 キャンセル、現在占有の終了、再予約可否

現在の `SlotOccupancy` がある `StudentReservation` を参照している状態でそのReservationのキャンセルが成立した場合、そのReservationによる現在占有は終了させる。キャンセル済みReservationを `SlotOccupancy.reservation_id` から参照し続けてはならない。

ここで、**「Reservationによる現在占有を終了すること」と「LessonSlotが新規予約可能になること」は別概念**とする。

```text
Reservationキャンセル
    ↓
そのReservationによる現在占有を終了
    ↓
LessonSlotを新規予約可能にするかは別判定
    ├─ availability_status
    ├─ Lesson開始時刻
    ├─ 新しいAdminHold / GroupLesson等の占有
    └─ 各キャンセル種別固有の業務処理
```

開始前の生徒キャンセルでは、Reservationによる占有を解放したうえで、営業・公開・availability等の条件を満たせば新規予約可能へ戻す。

```text
予約中
LessonSlot #100
├─ Reservation #501 : confirmed
└─ SlotOccupancy -> Reservation #501

      ↓ 開始前の生徒キャンセル

LessonSlot #100
├─ Reservation #501 : student_cancelled
└─ SlotOccupancyなし

      ↓ 再予約

LessonSlot #100
├─ Reservation #501 : student_cancelled
├─ Reservation #502 : confirmed
└─ SlotOccupancy -> Reservation #502
```

生徒削除等による `system_cancelled` でも、対象が未開始で枠再開放条件を満たす場合は、元Reservationによる `SlotOccupancy` を解放して新規予約可能へ戻せる。

スクール都合キャンセルでは元Reservationによる占有は終了するが、その後のSlotは休業化、AdminHoldへの置換、または条件を満たす場合の再開放など、スクール側の業務変更に従う。したがって `school_cancelled` になったことだけを理由にLessonSlotを自動的に予約可能へ戻さない。

開始時刻以降はSlotOccupancyの有無とは別に時刻条件によって新規予約を禁止するため、開始後キャンセル等でReservationによる占有を終了しても過去・開始済み枠が再予約可能になることはない。

### 4.6 AdminHold / GroupLesson

`AdminHold` と `GroupLesson` は生徒予約履歴ではなく現在の運営上の占有を表すため、`SlotOccupancy` と1対1の個別詳細として扱う。

```text
SlotOccupancy 1 ───── 0..1 AdminHold
SlotOccupancy 1 ───── 0..1 GroupLesson
```

各個別レコードの `occupancy_id` は一意とする。

### 4.7 作成・変更の原子性

現在占有を作る処理は、Reservation等の業務レコードと `SlotOccupancy` の整合を同一の論理トランザクション境界で保証する。

生徒予約作成の概念例:

```text
BEGIN
  StudentReservation INSERT
  SlotOccupancy INSERT
    └─ UNIQUE(slot_id) で現在占有を競合判定
COMMIT
```

途中で失敗した場合、現在占有とReservationが食い違う中間状態を残さない。

D1での具体的なTransaction API・SQL構成は `05_BookingAndConcurrency.md` を正とする。

## 5. Index基本方針

少なくとも以下の検索・制約経路を効率化する。

- 生徒から予約履歴を検索する経路: `StudentReservation.student_id`
- 枠から予約履歴を検索する経路: `StudentReservation.lesson_slot_id`
- 枠から現在占有を検索・一意保証する経路: `SlotOccupancy.slot_id`（UNIQUE）
- 現在占有からReservationを参照する経路: `SlotOccupancy.reservation_id`
- Reservationから欠席・各Override・スクール都合／システム起因取消詳細を参照する経路: 各 `reservation_id`（UNIQUE）
- 生徒・月別標準回数を参照する経路: `StudentMonthlyLessonConfig(student_id, schedule_month_id)`（UNIQUE）
- AdminHold / GroupLessonから占有を参照する経路: 各 `occupancy_id`
- 時系列で予約・枠を取得する経路: `LessonSlot.lesson_date`、`start_time` または相当列

複合Indexは実際のQueryパターンとD1の実行計画を踏まえて物理設計時に確定する。`IntegrityIncident` のfingerprint・status・検知時刻等に対する物理Indexは `05_BookingAndConcurrency.md` の方針に従い詳細設計で確定する。

## 6. 保存モデルと表示モデルの分離

保存モデルでは正規化された関係を保持し、画面/API向けには必要に応じてQuery結果から表示モデルを組み立てる。

```text
Student
  └─ StudentReservation * ── LessonSlot
          │                     │
          ├─ Absence            └─ 0..1 SlotOccupancy
          ├─ MonthlyCountOverride
          ├─ ClassificationOverride
          ├─ SchoolCancellationDetail
          └─ SystemCancellationDetail
```

- 生徒の予約履歴は `StudentReservation` を基点に取得する。
- 予約カレンダーの現在状態は `LessonSlot` と `SlotOccupancy` を基点に取得する。
- 取消日時は `StudentReservation.cancelled_at` を正本とし、種別固有Detailへ重複保存しない。
- 取消種別は `StudentReservation.status` から導出し、具体ActorはAuditLog等の監査情報から取得する。
- 月間算入可否はReservation状態・欠席・月間算入Overrideから導出する。
- `automatic_classification` は自動分類の確定値／再計算対象値として保持し、Lesson開始済みでは自動更新しない。
- 月間算入対象では `StudentReservation.classification` の `standard` / `additional` を現在の実効区分として参照する。
- 月間算入対象外では仕様上「分類対象外」とし、保存上のclassificationはNULLとする。画面ではNULLそのものではなく、キャンセル・欠席・回数算入対象外等の業務状態を表示する。
- `school_cancelled` と `system_cancelled` は別状態として表示・解釈し、それぞれの理由詳細を対応するDetail Entityから取得する。
- 実効区分の根拠となる明示Overrideは別Entityとして保持する。
- 同じ関係をStudentやLessonSlotへ予約ID配列として重複保存しない。
- `IntegrityIncident` は利用者向け予約状態の代替正本ではなく、保守・監視用の状態として通常表示モデルから分離する。

## 7. 整合性上の原則

- `StudentReservation` は予約の業務事実・履歴の正本とする。
- キャンセル済みReservationを、枠再開放のためだけに削除しない。
- 1つの `LessonSlot` は0件以上のReservation履歴を持てる。
- 1つの `LessonSlot` に同時に存在できる `SlotOccupancy` は最大1件とする。
- 同時占有防止の最終保証点として `SlotOccupancy.slot_id` のUNIQUE制約を用いる。
- `SlotOccupancy` は現在占有、`StudentReservation` は予約履歴として責務を分離する。
- 生徒予約による占有では `SlotOccupancy` が現在有効なReservationを参照する。
- キャンセル済みReservationを現在占有として参照しない。取消成立時には元Reservationによる現在占有を終了するが、その後LessonSlotが予約可能になるかはSlotのavailability、時刻、後続占有、キャンセル種別固有処理から別に判定する。
- `StudentReservation.status = confirmed` は予約成立後にキャンセルされていないことを表し、Lesson終了後も時間経過だけでは変更しない。
- `confirmed` では `StudentReservation.cancelled_at = NULL` とし、`student_cancelled` / `school_cancelled` / `system_cancelled` では `cancelled_at` を必須とする。
- `updated_at` を取消日時の代用にしない。
- `student_cancelled`、`school_cancelled`、`system_cancelled` は取消の業務意味が異なるため別状態として扱う。
- 取消種別は `status` から導出し、重複する `cancelled_by_type` を持たない。具体ActorはAuditLog等へ分離する。
- `system_cancelled` のReservationには `SystemCancellationDetail` を必須とし、初期リリースの `reason_code` は少なくとも `student_deleted` を持つ。
- Reservationライフサイクル、欠席、月間算入、自動分類、実効classification、明示Overrideを別概念として扱う。
- 月間算入可否をReservation本体へ重複保存せず、業務状態とOverrideから導出する。
- `automatic_classification` は `standard` / `additional` の自動分類値を保持し、Lesson開始済みReservationでは後続の自動再分類により変更しない。
- 月間算入対象Reservationのみ実効classificationを `standard` / `additional` として保持し、対象外は「分類対象外」としてNULLにする。
- `ReservationClassificationOverride` は一時的な分類対象外への遷移で自動削除しない。
- 開始済みReservationの分類変更が必要な場合は自動再分類ではなく明示Overrideとして監査可能に扱う。
- `Student` に予約一覧のCacheを業務上の正本として持たせない。
- 競合判定ではCommit時の最新状態を再検証する。
- 永続化済みInvariant違反を検出した場合はFail Closedとし、`IntegrityIncident` はその異常を追跡するための運用記録としてのみ使用する。Incidentの存在を根拠に予約・占有状態を推測または上書きしない。
- 性能上の根拠なく初期段階から重複保存を導入しない。

## 8. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-004 個人情報最小化
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-010 既定ルールと例外を分離する
- POL-013 重要な管理操作の説明性と監査可能性
- POL-014 利用者向けエラー情報の安全な抽象化
- BR-051 二重予約禁止
- BR-054 キャンセル後の枠
- BR-056 月間標準回数
- BR-057 追加レッスン分類
- BR-058 自動再分類
- BR-059 明示Override優先
- BR-060 月間回数除外
- BR-061 欠席
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- BR-066 予約状態と月間算入の分離
- BR-067 未来枠の現在予約状態の一貫性
- BR-100 生徒削除
- BR-110 重大障害通知
- BR-116 スクール都合キャンセル通知
- BR-125 将来予約処理
- BR-132 監査
- BR-133 利用者向けエラー表現
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-104 標準／追加区分変更通知
- REQ-302 臨時休業
- REQ-304 管理者確保枠
- REQ-307 月間標準回数設定
- REQ-308 月間回数除外
- REQ-309 標準／追加再分類
- REQ-310 区分Override
- REQ-311 生徒削除
- REQ-312 削除時予約処理
- REQ-313 スクール都合キャンセル
- REQ-315 欠席記録
- REQ-911 競合・整合性
- REQ-914 障害・エラー時利用者表示
- REQ-940 監査Logging
- REQ-942 監視・重大Incident

## 9. 設計判断記録

- `SlotOccupancy` を実テーブルとして採用する判断理由は `docs/adr/ADR-002-persist-slot-occupancy.md` に記録する。
- 予約履歴と現在占有の分離は `OI-BD-001` で検討し、本書および `04_ReservationModel.md` に確定結果を反映する。
- Reservationの状態・月間算入・区分Overrideの分離は `OI-BD-002` で検討し、本書および `04_ReservationModel.md` に確定結果を反映する。
- Reservation非算入時のclassificationとライフサイクル意味は `OI-BD-003` で検討し、本書および `04_ReservationModel.md` に確定結果を反映する。
- 過去Reservationのclassification自動再計算を行わない境界は `OI-BD-004` で検討し、Lesson開始時刻を確定境界として本書および `04_ReservationModel.md` に確定結果を反映する。
- 生徒削除等のシステム処理由来の自動取消は、直接確定した設計判断として `StudentReservation.status = system_cancelled` と `SystemCancellationDetail` に分離して表現する。初期 `reason_code` は `student_deleted` とする。
- Reservation取消日時・取消主体の保持方法は `OI-BD-005` で検討し、取消日時を `StudentReservation.cancelled_at` に共通化、取消種別を `status` から導出、具体ActorをAuditLog等へ分離する方針として確定・反映する。
- `OI-BD-006` で、永続化済みInvariant違反を追跡する運用Entityとして `IntegrityIncident` を導入する。これは予約・占有の正本ではなく、Command Guard / 定期Scanによる検知、重複集約、保守通知、Repair後の解決判定を支える運用状態である。

## 10. 図

PlantUML source: `docs/diagrams/plantuml/data-model-overview.puml`

Rendered SVG: `docs/diagrams/rendered/data-model-overview.svg`（自動生成）

`IntegrityIncident` は予約・占有の中核業務関係図には含めず、運用・監視データモデルとして詳細設計で物理関係を具体化する。