# 04. 予約モデル基本設計

## 1. 目的

本書は、生徒予約の履歴とLessonSlotの現在占有を分離し、キャンセル・再予約・競合を一貫して扱うための論理データモデルを定義する。

## 2. 基本方針

予約モデルでは次の2つを別の正本として扱う。

- `StudentReservation` — 予約という業務事実・履歴の正本
- `SlotOccupancy` — `LessonSlot` の現在占有の正本

`StudentReservation` を削除して空きを表現せず、キャンセル後も履歴として残す。一方、再予約可能な枠については `SlotOccupancy` を解放する。

## 3. LessonSlot と Reservation履歴

1つの `LessonSlot` には0件以上の `StudentReservation` が関連できる。

```text
LessonSlot 1 ───── 0..* StudentReservation
```

`StudentReservation` は `lesson_slot_id` を直接保持する。

同一Slotに複数Reservationが存在する例:

```text
LessonSlot #100
├─ Reservation #501 : student_cancelled
├─ Reservation #502 : school_cancelled
└─ Reservation #503 : active
```

これは二重予約ではなく、同じSlotに対する時系列の予約履歴を表す。

## 4. LessonSlot と現在占有

1つの `LessonSlot` に存在できる現在占有は最大1件とする。

```text
LessonSlot 1 ───── 0..1 SlotOccupancy
```

`SlotOccupancy.slot_id` のUNIQUE制約を現在占有の一意性の最終保証点とする。

```text
UNIQUE(slot_id)
```

## 5. 生徒予約で占有されている場合

`SlotOccupancy.occupancy_type = student_reservation` の場合、`SlotOccupancy.reservation_id` から現在そのSlotを占有している `StudentReservation` を参照する。

```text
                    ┌─ Reservation #501 : cancelled
                    ├─ Reservation #502 : cancelled
LessonSlot #100 ────┤
       │            └─ Reservation #503 : active
       │                         ▲
       │                         │
       └──── SlotOccupancy ──────┘
             current occupancy
```

したがって `SlotOccupancy` はReservationの子として所有されるのではなく、**LessonSlotに属する現在占有レコード**である。Reservationへの参照は現在占有の正体を示すための参照である。

## 6. キャンセルと再予約

### 6.1 開始前キャンセル

開始前キャンセルでは、Reservation履歴を残したまま現在占有を解放する。

```text
Before
LessonSlot #100
├─ Reservation #501 : active
└─ SlotOccupancy -> #501

After cancel
LessonSlot #100
├─ Reservation #501 : student_cancelled
└─ SlotOccupancyなし
```

その後に同じSlotが再予約された場合、新しいReservationを作成する。

```text
LessonSlot #100
├─ Reservation #501 : student_cancelled
├─ Reservation #502 : active
└─ SlotOccupancy -> #502
```

過去Reservationを再利用・上書きしない。

### 6.2 スクール都合キャンセル

スクール都合キャンセルでもReservation自体は履歴として保持する。

枠を再開放する場合は現在占有を解放し、枠を休業化・管理者確保へ変更する場合は、その業務変更と整合する形でSlotOccupancyを更新する。

### 6.3 開始時刻以降

開始時刻以降の新規予約禁止はSlotOccupancyとは別の時刻ルールとして判定する。

したがって開始後にReservationがキャンセル等で有効状態を失っても、そのSlotを新規予約可能とはしない。

## 7. AdminHold / GroupLessonとの関係

`SlotOccupancy` は生徒予約専用ではない。

```text
LessonSlot
  └─ 0..1 SlotOccupancy
       ├─ student_reservation -> StudentReservation
       ├─ admin_hold          -> AdminHold
       └─ group_lesson        -> GroupLesson
```

現在の占有種別は1つだけであり、異なる占有種別を同時に成立させない。

## 8. 主要整合性条件

- `StudentReservation.lesson_slot_id` は必須とする。
- 同じ `LessonSlot` を参照するReservation履歴は複数存在してよい。
- `SlotOccupancy.slot_id` はUNIQUEとする。
- `occupancy_type = student_reservation` の場合は `reservation_id` を必須とする。
- `SlotOccupancy.reservation_id` が参照するReservationの `lesson_slot_id` は `SlotOccupancy.slot_id` と一致しなければならない。
- キャンセル済みReservationを現在占有として参照しない。
- Reservation作成と現在占有確保は同一の論理トランザクション境界で整合させる。
- 枠再開放を伴うキャンセルではReservation状態変更とSlotOccupancy解放を同一の論理トランザクション境界で整合させる。

具体的なD1制約、Transaction API、競合エラー処理は `BookingAndConcurrency` 設計で確定する。

## 9. 関連要求・方針

- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- BR-051 二重予約禁止
- BR-054 キャンセル後の枠
- BR-060 月間回数除外
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-302 臨時休業
- REQ-313 スクール都合キャンセル
- REQ-911 競合・整合性

## 10. Open Item

`OI-BD-001` の決定結果を本書に反映済みとする。
