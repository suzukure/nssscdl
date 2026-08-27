# 02. データモデル基本設計

## 1. 目的

本書は、要求仕様を論理データモデルへ落とし込むための基本方針を定義する。

本段階ではエンティティ間の責務と関係、整合性を担保する主要なキー・制約を確定する。D1の最終カラム型、補助Index、DDLは後続の物理データ設計で確定する。

## 2. 主要概念

以下を基本概念として扱う。

- `Student` — 生徒本人を表す。
- `LessonSlot` — 公開・管理対象となる固定レッスン時間枠を表す。
- `SlotOccupancy` — LessonSlotが何らかの業務目的で占有されていることを表す共通レコード。
- `StudentReservation` — 生徒による個人レッスン予約。
- `AdminHold` — スクール管理者による運営上の枠確保。
- `GroupLesson` — グループレッスンとしての枠占有。

`StudentReservation`、`AdminHold`、`GroupLesson` は「枠を占有する」という点では共通するが、業務上は異なる意味を持つため同一状態として扱わない。

## 3. Student と StudentReservation の関係

### 3.1 決定

`Student` と `StudentReservation` は **1対多** とする。

`StudentReservation` が対象生徒を示す `student_id` を保持する。

概念上の関係は次のとおり。

```text
Student 1 ───── 0..* StudentReservation
```

`Student` 側には予約ID一覧や予約配列を永続データとして重複保持しない。

### 3.2 生徒別予約一覧の扱い

「ある生徒の予約一覧」は独立した永続データではなく、`StudentReservation` を `student_id` で検索して構成する **Query結果 / View Model** として扱う。

たとえば論理的には次の検索となる。

```sql
SELECT ...
FROM student_reservations
WHERE student_id = ?
```

予約日時等を取得する場合は `SlotOccupancy` および `LessonSlot` とのJoinを行う。

この検索は「全予約を毎回逐次走査する」ことを意味しない。`student_id` に適切なIndexを設け、対象生徒の予約へ効率的にアクセスする。

### 3.3 この方針を採る理由

Student側にも予約一覧を保持すると、予約作成・キャンセル・削除等のたびに複数箇所を同期更新する必要があり、次のような不整合を生みやすい。

- StudentReservationは存在するがStudent側一覧にない。
- Student側一覧に予約IDが残っているがReservationは存在しない。
- 同一予約状態を複数箇所で更新する必要がある。

したがって予約レコードを正本とし、生徒別一覧はQueryで導出する。

この方針はデータ正規化と業務状態の一元管理を優先するものであり、初期規模（生徒約20名）では性能上も十分な余裕がある。

## 4. SlotOccupancy の永続化

### 4.1 決定

`SlotOccupancy` は概念上だけの抽象概念ではなく、**D1に独立した実テーブルとして永続化する**。

論理構造は次のとおり。

```text
LessonSlot 1 ───── 0..1 SlotOccupancy

SlotOccupancy 1 ───── 0..1 StudentReservation
              ├───── 0..1 AdminHold
              └───── 0..1 GroupLesson
```

1つの `SlotOccupancy` は `occupancy_type` により次のいずれか1種類を表す。

- `student_reservation`
- `admin_hold`
- `group_lesson`

各種別固有の属性は、対応する個別テーブル側に保持する。

### 4.2 SlotOccupancy の最小論理属性

少なくとも次の論理属性を持つ。

- `id` — 占有レコード識別子
- `slot_id` — 対象 `LessonSlot`
- `occupancy_type` — 占有種別
- `created_at` — 占有作成時刻
- `created_by` または同等の作成主体識別情報 — 監査要件との整合を踏まえ物理設計で具体化

正確な型、ID生成方式、監査情報の保持場所は物理データ設計で確定する。

### 4.3 一意制約

`SlotOccupancy.slot_id` には **UNIQUE制約**を設ける。

これにより、1つの `LessonSlot` に同時に存在できる有効な占有レコードを最大1件に制限する。

```text
UNIQUE(slot_id)
```

この制約を、以下のすべてに共通するDBレベルの競合防止点とする。

- 生徒予約 vs 生徒予約
- 生徒予約 vs 管理者確保
- 生徒予約 vs グループレッスン
- 管理者確保 vs グループレッスン
- その他、同一枠を占有する操作同士

Application Worker側の事前確認だけに依存せず、最終的な同時占有防止をD1制約でも保証する。

### 4.4 個別テーブルとの関係

`StudentReservation`、`AdminHold`、`GroupLesson` は、それぞれ対応する `SlotOccupancy` を参照する。

論理的には各個別レコードの `occupancy_id` を一意とし、1つの占有に同種の詳細レコードが複数ぶら下がらないようにする。

```text
StudentReservation.occupancy_id UNIQUE
AdminHold.occupancy_id           UNIQUE
GroupLesson.occupancy_id         UNIQUE
```

また、`SlotOccupancy.occupancy_type` と実際に存在する個別テーブルの種類は一致しなければならない。

例:

```text
occupancy_type = student_reservation
        ↓
対応する StudentReservation が1件存在
AdminHold / GroupLesson は存在しない
```

この種別整合性をDB制約のみでどこまで表現するか、Application WorkerのTransactionでどこまで担保するかは、D1の具体的な制約機能を踏まえ物理設計で確定する。

### 4.5 作成・変更の原子性

`SlotOccupancy` と対応する個別レコードは、**同一の論理トランザクション境界で作成・変更する**。

生徒予約作成の概念例:

```text
BEGIN
  SlotOccupancy INSERT
    └─ UNIQUE(slot_id) で枠取得を競合判定

  StudentReservation INSERT
COMMIT
```

途中で個別レコード作成に失敗した場合、`SlotOccupancy` だけを残さない。

これにより「占有レコードはあるが詳細レコードがない」という中間不整合を通常の業務処理から生じさせない。

D1での具体的なTransaction API・SQL構成は予約整合性／Transaction設計で確定する。

### 4.6 競合時の意味

同一 `slot_id` への `SlotOccupancy` 作成が一意制約により失敗した場合、その枠について別操作が先に確定したものとして扱う。

Application Workerは最新状態を再読込し、利用者または管理者へ状態変更・競合を明瞭に伝える。後続操作が先行状態を無言で上書きしてはならない。

これは `POL-008` および `REQ-911` の実装基盤とする。

## 5. Index基本方針

少なくとも以下の検索・制約経路を効率化する。

- 生徒から予約を検索する経路: `StudentReservation.student_id`
- 枠から占有を検索・一意保証する経路: `SlotOccupancy.slot_id`（UNIQUE）
- 個別レコードから占有を参照する経路: 各 `occupancy_id`
- 時系列で予約・枠を取得する経路: `LessonSlot.start_at` または相当列

`student_id + status` 等の複合Indexは、実際のQueryパターンとD1の実行計画を踏まえて物理設計時に確定する。

## 6. 保存モデルと表示モデルの分離

保存モデルでは正規化された関係を保持し、画面/API向けには必要に応じてQuery結果から表示モデルを組み立てる。

例:

```text
保存モデル
Student
StudentReservation
SlotOccupancy
LessonSlot
       │
       └─ Query / Join
              ↓
表示モデル
「生徒Aの今後の予約一覧」
```

表示上は生徒に予約一覧が紐付いて見えてよいが、そのために同じ関係をStudentレコードへ重複保存しない。

予約カレンダー等では `LessonSlot` と `SlotOccupancy` の関係を基点として、空き／生徒予約／管理者確保／グループレッスンを判定する。

## 7. 整合性上の原則

- 1つの `LessonSlot` に同時に存在できる `SlotOccupancy` は最大1件とする。
- 同時占有防止の最終保証点として `SlotOccupancy.slot_id` のUNIQUE制約を用いる。
- 占有の共通情報は `SlotOccupancy`、業務固有情報は対応する個別テーブルに分離する。
- `SlotOccupancy` と個別レコードは同一の論理トランザクション境界で更新する。
- 予約状態の正本は予約／占有を表すレコード側とする。
- `Student` に予約一覧のCacheを業務上の正本として持たせない。
- 競合判定ではCommit時の最新状態を再検証する。
- 将来Query性能が実測上問題になった場合は、Index、Query専用Projection、Cache等を段階的に検討する。
- 性能上の根拠なく初期段階から重複保存を導入しない。

## 8. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-013 重要な管理操作の説明性と監査可能性
- REQ-001 初期画面・スケジュール確認
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-006 グループレッスン表示
- REQ-304 管理者確保枠
- REQ-911 競合・整合性

## 9. 設計判断記録

`SlotOccupancy` を実テーブルとして採用する判断理由は `docs/adr/ADR-002-persist-slot-occupancy.md` に記録する。

## 10. 図

PlantUML source: `docs/diagrams/plantuml/data-model-overview.puml`

Rendered SVG: `docs/diagrams/rendered/data-model-overview.svg`（自動生成）
