# ADR-002: SlotOccupancy を独立テーブルとして永続化する

- 状態: 採用
- 日付: 2026-08-27

## 背景

1つの `LessonSlot` は、次のいずれかにより占有される。

- 生徒の個人レッスン予約 (`StudentReservation`)
- スクール管理者による枠確保 (`AdminHold`)
- グループレッスン (`GroupLesson`)

これらは「枠を占有する」という共通性を持つが、要求上は業務的に異なる意味を持ち、同一状態として扱ってはならない。

個別テーブルがそれぞれ直接 `slot_id` を保持する構成では、各テーブル内のUNIQUE制約だけでは、同一 `LessonSlot` が異なる占有種別から同時に参照されることをDBレベルで防止できない。

また本システムは `POL-008` および `REQ-911` により、競合時に先にCommitした状態を優先し、後続操作による無言の上書きを禁止する必要がある。

## 決定

`SlotOccupancy` をD1の独立した実テーブルとして永続化する。

`SlotOccupancy` は少なくとも次の論理属性を持つ。

- `id`
- `slot_id`
- `occupancy_type`
- `reservation_id` — `occupancy_type = student_reservation` の場合に現在占有している `StudentReservation` を参照する。その他ではNULL
- `created_at`
- 作成主体を追跡するための情報（具体形は物理設計で決定）

`slot_id` にはUNIQUE制約を設け、1つの `LessonSlot` に同時に存在できる占有を最大1件とする。

`occupancy_type` は初期リリースで次のいずれかとする。

- `student_reservation`
- `admin_hold`
- `group_lesson`

### 生徒予約との対応

`StudentReservation` は予約履歴の正本として `lesson_slot_id` を保持し、キャンセル後も履歴として残る。

現在そのSlotを生徒予約が占有している場合は、`SlotOccupancy.reservation_id` から現在有効な `StudentReservation` を参照する。

```text
LessonSlot 1 ───── 0..* StudentReservation  （予約履歴）
LessonSlot 1 ───── 0..1 SlotOccupancy       （現在占有）
SlotOccupancy.reservation_id
    └─> StudentReservation                  （現在の生徒予約占有）
```

`StudentReservation` 側に `occupancy_id` を保持して現在占有を表してはならない。Reservation履歴と現在占有のライフサイクルが異なるためである。

### AdminHold / GroupLessonとの対応

`AdminHold` と `GroupLesson` は現在の運営上の占有に付随する詳細として扱い、それぞれ `occupancy_id` により `SlotOccupancy` と1対0..1で対応させる。

```text
SlotOccupancy 1 ───── 0..1 AdminHold
SlotOccupancy 1 ───── 0..1 GroupLesson
```

`SlotOccupancy` と対応する業務レコード／詳細レコードは同一の論理Transaction境界で作成・変更し、中間不整合を残さない。

## 現在占有の整合性

生徒予約による現在占有では、少なくとも次を成立させる。

- `SlotOccupancy.occupancy_type = student_reservation` の場合、`reservation_id` は必須。
- `reservation_id` が参照する `StudentReservation` は `status = confirmed` でなければならない。
- `StudentReservation.lesson_slot_id = SlotOccupancy.slot_id` でなければならない。
- キャンセル済みReservationを現在占有として参照しない。
- 未来の有効な生徒予約が現在そのSlotを占有している場合、対応する `SlotOccupancy` が存在しなければならない。

予約カレンダー等で「空きか／何によって占有されているか」を判定するときは `SlotOccupancy` を現在占有の正本とする。過去Reservationを含む `StudentReservation` の一覧から現在予約者を推測しない。

## 影響

### 利点

- 同一枠の二重占有を `UNIQUE(slot_id)` という単一のDB制約で防止できる。
- 生徒予約、管理者確保、グループレッスン間の競合判定を共通化できる。
- 「空きか／何によって占有されているか」を `SlotOccupancy` を基点に取得できる。
- Reservation履歴と現在占有を分離し、キャンセル・再予約後も履歴を失わない。
- 将来占有種別が増えた場合でも、共通の枠競合制約を維持しやすい。
- 先にCommitした状態を優先するという要求をDB制約で支えられる。

### 欠点・トレードオフ

- 生徒予約等の作成に `SlotOccupancy` と業務レコード／詳細レコードの複数永続化が必要になる。
- 参照時のJoinが増える。
- `occupancy_type` と対応する業務レコード／詳細レコードの実在関係を一致させる必要がある。
- 中間不整合を防ぐため、作成・変更時のTransaction境界を明確にする必要がある。

これらの複雑性は、個別テーブルだけで複数種別間の競合判定と現在状態推定をApplication側に実装する複雑性より小さく、整合性の保証を強くできるため受容する。

## 採用しなかった代替案

### 各占有種別が直接 LessonSlot を現在占有として管理する

`StudentReservation.slot_id`、`AdminHold.slot_id`、`GroupLesson.slot_id` をそれぞれUNIQUEにして現在占有まで表現する案。

この方式では同一テーブル内の重複は防げるが、異なるテーブル間で同一 `slot_id` が存在する状態を単純なUNIQUE制約では防げない。またStudentReservationは履歴を保持するため、現在占有と履歴の意味が混在する。Application Workerが全占有種別とReservation状態を確認し、同時実行競合まで正しく制御する必要があるため採用しない。

## 関連項目

- `POL-008` 競合時の確定状態優先
- `POL-009` 業務上異なる意味を別の状態として扱う
- `POL-013` 重要な管理操作の説明性と監査可能性
- `REQ-003` 予約
- `REQ-004` 生徒キャンセル
- `REQ-006` グループレッスン表示
- `REQ-304` 管理者確保枠
- `REQ-911` 競合・整合性
- `docs/10_basic_design/02_DataModel.md`
- `docs/10_basic_design/05_BookingAndConcurrency.md`
