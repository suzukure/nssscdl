# 02. データモデル基本設計

## 1. 目的

本書は、要求仕様を論理データモデルへ落とし込むための基本方針を定義する。

本段階ではエンティティ間の責務と関係を確定し、D1の最終テーブル定義、カラム型、複合Index、DDLは後続の物理データ設計で確定する。

## 2. 現時点の主要概念

以下を基本概念として扱う。

- `Student` — 生徒本人を表す。
- `LessonSlot` — 公開・管理対象となる固定レッスン時間枠を表す。
- `SlotOccupancy` — LessonSlotが何らかの業務目的で占有されていることを表す概念上の上位概念。
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

予約日時等を取得する場合は `LessonSlot` とのJoinを行う。

この検索は「全予約を毎回逐次走査する」ことを意味しない。`student_id` に適切なIndexを設け、対象生徒の予約へ効率的にアクセスする。

### 3.3 この方針を採る理由

Student側にも予約一覧を保持すると、予約作成・キャンセル・削除等のたびに複数箇所を同期更新する必要があり、次のような不整合を生みやすい。

- StudentReservationは存在するがStudent側一覧にない。
- Student側一覧に予約IDが残っているがReservationは存在しない。
- 同一予約状態を複数箇所で更新する必要がある。

したがって予約レコードを正本とし、生徒別一覧はQueryで導出する。

この方針はデータ正規化と業務状態の一元管理を優先するものであり、初期規模（生徒約20名）では性能上も十分な余裕がある。

## 4. SlotOccupancy との関係

概念モデルでは次の関係とする。

```text
LessonSlot 1 ───── 0..1 SlotOccupancy

SlotOccupancy
├─ StudentReservation
├─ AdminHold
└─ GroupLesson
```

この構造により、個人予約・管理者確保・グループレッスンのいずれであっても「対象LessonSlotが占有済みか」という共通の競合判定を表現できる。

ただし、`SlotOccupancy` をD1の独立テーブルとして実装するか、概念上の共通概念に留めて各種別を別テーブルとしてLessonSlotへ関連付けるかは、本項ではまだ確定しない。これは次の論理・物理データモデル検討で比較する。

## 5. Index基本方針

少なくとも以下の検索経路を効率化できるIndexを設計対象とする。

- 生徒から予約を検索する経路: `StudentReservation.student_id`
- 予約／占有から対象枠を検索する経路: `slot_id` またはそれに相当する関連キー
- 時系列で予約・枠を取得する経路: `LessonSlot.start_at` または相当列

`student_id + status` 等の複合Indexは、実際のQueryパターンとD1の実行計画を踏まえて物理設計時に確定する。

## 6. 保存モデルと表示モデルの分離

保存モデルでは正規化された関係を保持し、画面/API向けには必要に応じてQuery結果から表示モデルを組み立てる。

例:

```text
保存モデル
Student
StudentReservation
LessonSlot
       │
       └─ Query / Join
              ↓
表示モデル
「生徒Aの今後の予約一覧」
```

表示上は生徒に予約一覧が紐付いて見えてよいが、そのために同じ関係をStudentレコードへ重複保存しない。

## 7. 整合性上の原則

- 予約状態の正本は予約／占有を表すレコード側とする。
- `Student` に予約一覧のCacheを業務上の正本として持たせない。
- 競合判定ではCommit時の最新状態を再検証する。
- 将来Query性能が実測上問題になった場合は、Index、Query専用Projection、Cache等を段階的に検討する。
- 性能上の根拠なく初期段階から重複保存を導入しない。

## 8. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- REQ-001 初期画面・スケジュール確認
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-006 グループレッスン表示
- REQ-304 管理者確保枠
- REQ-911 競合・整合性

## 9. 図

PlantUML source: `docs/diagrams/plantuml/data-model-overview.puml`

Rendered SVG: `docs/diagrams/rendered/data-model-overview.svg`（自動生成）
