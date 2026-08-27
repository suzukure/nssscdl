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
- `created_at`
- 作成主体を追跡するための情報（具体形は物理設計で決定）

`slot_id` にはUNIQUE制約を設け、1つの `LessonSlot` に同時に存在できる占有を最大1件とする。

`occupancy_type` は初期リリースで次のいずれかとする。

- `student_reservation`
- `admin_hold`
- `group_lesson`

種別固有情報は `StudentReservation`、`AdminHold`、`GroupLesson` の各テーブルへ分離し、それぞれ `occupancy_id` により `SlotOccupancy` と1対0..1で対応させる。

`SlotOccupancy` と対応する個別詳細レコードは同一の論理Transaction境界で作成・変更する。

## 影響

### 利点

- 同一枠の二重占有を `UNIQUE(slot_id)` という単一のDB制約で防止できる。
- 生徒予約、管理者確保、グループレッスン間の競合判定を共通化できる。
- 「空きか／何によって占有されているか」を `SlotOccupancy` を基点に取得できる。
- 将来占有種別が増えた場合でも、共通の枠競合制約を維持しやすい。
- 先にCommitした状態を優先するという要求をDB制約で支えられる。

### 欠点・トレードオフ

- 生徒予約等の作成に `SlotOccupancy` と詳細レコードの2段階の永続化が必要になる。
- 参照時のJoinが1段増える。
- `occupancy_type` と詳細テーブルの実在関係を一致させる必要がある。
- 中間不整合を防ぐため、作成・変更時のTransaction境界を明確にする必要がある。

これらの複雑性は、個別テーブルだけで複数種別間の競合をApplication側に実装する複雑性より小さく、整合性の保証を強くできるため受容する。

## 採用しなかった代替案

### 各占有種別が直接 LessonSlot を参照する

`StudentReservation.slot_id`、`AdminHold.slot_id`、`GroupLesson.slot_id` をそれぞれUNIQUEにする案。

この方式では同一テーブル内の重複は防げるが、異なるテーブル間で同一 `slot_id` が存在する状態を単純なUNIQUE制約では防げない。Application Workerが全占有種別を確認し、同時実行競合まで正しく制御する必要があるため採用しない。

## 関連項目

- `POL-008` 競合時の確定状態優先
- `POL-009` 業務上異なる意味を別の状態として扱う
- `POL-013` 重要な管理操作の説明性と監査可能性
- `REQ-003` 予約
- `REQ-006` グループレッスン表示
- `REQ-304` 管理者確保枠
- `REQ-911` 競合・整合性
- `docs/10_basic_design/02_DataModel.md`
