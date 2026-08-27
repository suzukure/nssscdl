# 02. データモデル基本設計

## 1. 目的

本書は、要求仕様を論理データモデルへ落とし込むための基本方針を定義する。

本段階ではエンティティ間の責務と関係、整合性を担保する主要なキー・制約を確定する。D1の最終カラム型、補助Index、DDLは後続の物理データ設計で確定する。

## 2. 主要概念

以下を基本概念として扱う。

- `Student` — 生徒本人を表す。
- `LessonSlot` — 公開・管理対象となる固定レッスン時間枠を表す。
- `SlotOccupancy` — LessonSlotの現在の占有を表す共通レコード。
- `StudentReservation` — 生徒による個人レッスン予約の業務レコード。キャンセル等の履歴も保持する。
- `ReservationAbsence` — 予約に対する欠席状態。キャンセルとは別概念として扱う。
- `ReservationMonthlyCountOverride` — 管理者による月間回数算入の例外。
- `ReservationClassificationOverride` — 管理者による標準／追加区分の明示Override。
- `SchoolCancellationDetail` — スクール都合キャンセル固有の理由カテゴリ・補足。
- `StudentMonthlyLessonConfig` — 生徒・月単位の標準レッスン回数設定。
- `AdminHold` — スクール管理者による運営上の枠確保。
- `GroupLesson` — グループレッスンとしての枠占有。

`StudentReservation`、`AdminHold`、`GroupLesson` は「枠を占有する」という点では共通するが、業務上は異なる意味を持つため同一状態として扱わない。

また、Reservation周辺でも、予約ライフサイクル、欠席、月間回数算入、標準／追加区分、明示Overrideを同一状態へ統合しない。

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
└─ Reservation #503 : confirmed
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

`StudentReservation` は予約ライフサイクル状態と現在の実効classificationを保持する。

一方、次の状態・例外は別Entityとして保持する。

```text
StudentReservation 1 ───── 0..1 ReservationAbsence
                   ├───── 0..1 ReservationMonthlyCountOverride
                   ├───── 0..1 ReservationClassificationOverride
                   └───── 0..1 SchoolCancellationDetail
```

- `ReservationAbsence` — 欠席。キャンセル状態とは独立する。
- `ReservationMonthlyCountOverride` — 月間回数への算入例外。標準／追加区分のOverrideではない。
- `ReservationClassificationOverride` — standard / additional の明示Override。
- `SchoolCancellationDetail` — `school_cancelled` 固有の理由詳細。

現在の実効月間算入可否は、Reservationライフサイクル、欠席、`ReservationMonthlyCountOverride` から導出し、重複する真偽値をReservation本体へ正本として保存しない。

`classification` は月間算入対象Reservationにのみ適用する。月間算入対象外では仕様上「分類対象外（not applicable）」とし、物理的には `StudentReservation.classification = NULL` とする。`not_applicable` をclassificationの第3値としては保存しない。

`ReservationClassificationOverride` は対象Reservationが一時的に分類対象外となっても明示解除されるまで保持し、再び算入対象となった際に再適用する。

### 3.5 生徒・月単位の標準回数

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
├─ Reservation #501 : cancelled
├─ Reservation #502 : cancelled
└─ Reservation #503 : confirmed
        ▲
        │
   SlotOccupancy
   slot_id = #100
   reservation_id = #503
```

`reservation_id` が参照するReservationの `lesson_slot_id` は、`SlotOccupancy.slot_id` と同じLessonSlotでなければならない。

この整合性をDB制約のみでどこまで表現するか、Application WorkerのTransactionでどこまで担保するかは物理設計で確定する。

### 4.5 キャンセルと再予約

枠を再開放するキャンセルでは、対象 `StudentReservation` の状態を変更して履歴として残し、対応する `SlotOccupancy` を解放する。

```text
予約中
LessonSlot #100
├─ Reservation #501 : confirmed
└─ SlotOccupancy -> Reservation #501

      ↓ 開始前キャンセル

LessonSlot #100
├─ Reservation #501 : student_cancelled
└─ SlotOccupancyなし

      ↓ 再予約

LessonSlot #100
├─ Reservation #501 : student_cancelled
├─ Reservation #502 : confirmed
└─ SlotOccupancy -> Reservation #502
```

開始時刻以降はSlotOccupancyの有無とは別に時刻条件によって新規予約を禁止するため、開始後キャンセル等で占有を解放しても過去・開始済み枠が再予約可能になることはない。

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

D1での具体的なTransaction API・SQL構成は予約整合性／Transaction設計で確定する。

## 5. Index基本方針

少なくとも以下の検索・制約経路を効率化する。

- 生徒から予約履歴を検索する経路: `StudentReservation.student_id`
- 枠から予約履歴を検索する経路: `StudentReservation.lesson_slot_id`
- 枠から現在占有を検索・一意保証する経路: `SlotOccupancy.slot_id`（UNIQUE）
- 現在占有からReservationを参照する経路: `SlotOccupancy.reservation_id`
- Reservationから欠席・各Override・スクール都合詳細を参照する経路: 各 `reservation_id`（UNIQUE）
- 生徒・月別標準回数を参照する経路: `StudentMonthlyLessonConfig(student_id, schedule_month_id)`（UNIQUE）
- AdminHold / GroupLessonから占有を参照する経路: 各 `occupancy_id`
- 時系列で予約・枠を取得する経路: `LessonSlot.lesson_date`、`start_time` または相当列

複合Indexは実際のQueryパターンとD1の実行計画を踏まえて物理設計時に確定する。

## 6. 保存モデルと表示モデルの分離

保存モデルでは正規化された関係を保持し、画面/API向けには必要に応じてQuery結果から表示モデルを組み立てる。

```text
Student
  └─ StudentReservation * ── LessonSlot
          │                     │
          ├─ Absence            └─ 0..1 SlotOccupancy
          ├─ MonthlyCountOverride
          └─ ClassificationOverride
```

- 生徒の予約履歴は `StudentReservation` を基点に取得する。
- 予約カレンダーの現在状態は `LessonSlot` と `SlotOccupancy` を基点に取得する。
- 月間算入可否はReservation状態・欠席・月間算入Overrideから導出する。
- 月間算入対象では `StudentReservation.classification` の `standard` / `additional` を現在の実効区分として参照する。
- 月間算入対象外では仕様上「分類対象外」とし、保存上のclassificationはNULLとする。画面ではNULLそのものではなく、キャンセル・欠席・回数算入対象外等の業務状態を表示する。
- 実効区分の根拠となる明示Overrideは別Entityとして保持する。
- 同じ関係をStudentやLessonSlotへ予約ID配列として重複保存しない。

## 7. 整合性上の原則

- `StudentReservation` は予約の業務事実・履歴の正本とする。
- キャンセル済みReservationを、枠再開放のためだけに削除しない。
- 1つの `LessonSlot` は0件以上のReservation履歴を持てる。
- 1つの `LessonSlot` に同時に存在できる `SlotOccupancy` は最大1件とする。
- 同時占有防止の最終保証点として `SlotOccupancy.slot_id` のUNIQUE制約を用いる。
- `SlotOccupancy` は現在占有、`StudentReservation` は予約履歴として責務を分離する。
- 生徒予約による占有では `SlotOccupancy` が現在有効なReservationを参照する。
- `StudentReservation.status = confirmed` は予約成立後にキャンセルされていないことを表し、Lesson終了後も時間経過だけでは変更しない。
- Reservationライフサイクル、欠席、月間算入、標準／追加区分、明示Overrideを別概念として扱う。
- 月間算入可否をReservation本体へ重複保存せず、業務状態とOverrideから導出する。
- 月間算入対象Reservationのみ実効classificationを `standard` / `additional` として保持し、対象外は「分類対象外」としてNULLにする。
- `ReservationClassificationOverride` は一時的な分類対象外への遷移で自動削除しない。
- `Student` に予約一覧のCacheを業務上の正本として持たせない。
- 競合判定ではCommit時の最新状態を再検証する。
- 性能上の根拠なく初期段階から重複保存を導入しない。

## 8. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-010 既定ルールと例外を分離する
- POL-013 重要な管理操作の説明性と監査可能性
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
- REQ-313 スクール都合キャンセル
- REQ-315 欠席記録
- REQ-911 競合・整合性

## 9. 設計判断記録

- `SlotOccupancy` を実テーブルとして採用する判断理由は `docs/adr/ADR-002-persist-slot-occupancy.md` に記録する。
- 予約履歴と現在占有の分離は `OI-BD-001` で検討し、本書および `04_ReservationModel.md` に確定結果を反映する。
- Reservationの状態・月間算入・区分Overrideの分離は `OI-BD-002` で検討し、本書および `04_ReservationModel.md` に確定結果を反映する。
- Reservation非算入時のclassificationとライフサイクル意味は `OI-BD-003` で検討し、本書および `04_ReservationModel.md` に確定結果を反映する。

## 10. 図

PlantUML source: `docs/diagrams/plantuml/data-model-overview.puml`

Rendered SVG: `docs/diagrams/rendered/data-model-overview.svg`（自動生成）