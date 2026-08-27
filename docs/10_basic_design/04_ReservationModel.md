# 04. 予約モデル検討メモ

データモデル完成に向け、予約履歴と現在の枠占有の責務を分離する。

現行の `StudentReservation.occupancy_id` を主関係にすると、開始前キャンセル等で `SlotOccupancy` を解放した後も予約履歴を残す要件と衝突する。

推奨する方向は次のとおり。

- `StudentReservation` は履歴を含む予約の業務レコードとして `lesson_slot_id` を直接保持する。
- `SlotOccupancy` は「現在その枠を占有しているもの」を表すレコードとする。
- 生徒予約による占有では `SlotOccupancy` から対象 `StudentReservation` を参照する。
- 開始前キャンセルやスクール都合キャンセルで枠を再開放する場合は `SlotOccupancy` を解放するが、`StudentReservation` は状態を変更して残す。
- 同一枠が再予約された場合、過去の `StudentReservation` と新しい `StudentReservation` は同じ `lesson_slot_id` を参照し得るが、同時に存在できる現在の `SlotOccupancy` は最大1件とする。

この変更は要求変更ではなく、既決の履歴要件と占有モデルを両立させるための基本設計上の整理である。
