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
- `AdminHold` — スクール管理者による運営上の枠確保。
- `GroupLesson` — グループレッスンとしての枠占有。

`StudentReservation`、`AdminHold`、`GroupLesson` は「枠を占有する」という点では共通するが、業務上は異なる意味を持つため同一状態として扱わない。

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
└─ Reservation #503 : active
```

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
└─ Reservation #503 : active
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
├─ Reservation #501 : active
└─ SlotOccupancy -> Reservation #501

      ↓ 開始前キャンセル

LessonSlot #100
├─ Reservation #501 : student_cancelled
└─ SlotOccupancyなし

      ↓ 再予約

LessonSlot #100
├─ Reservation #501 : student_cancelled
├─ Reservation #502 : active
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
- AdminHold / GroupLessonから占有を参照する経路: 各 `occupancy_id`
- 時系列で予約・枠を取得する経路: `LessonSlot.lesson_date`、`start_time` または相当列

複合Indexは実際のQueryパターンとD1の実行計画を踏まえて物理設計時に確定する。

## 6. 保存モデルと表示モデルの分離

保存モデルでは正規化された関係を保持し、画面/API向けには必要に応じてQuery結果から表示モデルを組み立てる。

```text
Student
  └─ StudentReservation * ── LessonSlot
                                │
                                └─ 0..1 SlotOccupancy
```

- 生徒の予約履歴は `StudentReservation` を基点に取得する。
- 予約カレンダーの現在状態は `LessonSlot` と `SlotOccupancy` を基点に取得する。
- 同じ関係をStudentやLessonSlotへ予約ID配列として重複保存しない。

## 7. 整合性上の原則

- `StudentReservation` は予約の業務事実・履歴の正本とする。
- キャンセル済みReservationを、枠再開放のためだけに削除しない。
- 1つの `LessonSlot` は0件以上のReservation履歴を持てる。
- 1つの `LessonSlot` に同時に存在できる `SlotOccupancy` は最大1件とする。
- 同時占有防止の最終保証点として `SlotOccupancy.slot_id` のUNIQUE制約を用いる。
- `SlotOccupancy` は現在占有、`StudentReservation` は予約履歴として責務を分離する。
- 生徒予約による占有では `SlotOccupancy` が現在有効なReservationを参照する。
- `Student` に予約一覧のCacheを業務上の正本として持たせない。
- 競合判定ではCommit時の最新状態を再検証する。
- 性能上の根拠なく初期段階から重複保存を導入しない。

## 8. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-013 重要な管理操作の説明性と監査可能性
- BR-051 二重予約禁止
- BR-054 キャンセル後の枠
- BR-060 月間回数除外
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-302 臨時休業
- REQ-304 管理者確保枠
- REQ-313 スクール都合キャンセル
- REQ-911 競合・整合性

## 9. 設計判断記録

- `SlotOccupancy` を実テーブルとして採用する判断理由は `docs/adr/ADR-002-persist-slot-occupancy.md` に記録する。
- 予約履歴と現在占有の分離は `OI-BD-001` で検討し、本書および `04_ReservationModel.md` に確定結果を反映する。

## 10. 図

PlantUML source: `docs/diagrams/plantuml/data-model-overview.puml`

Rendered SVG: `docs/diagrams/rendered/data-model-overview.svg`（自動生成）
