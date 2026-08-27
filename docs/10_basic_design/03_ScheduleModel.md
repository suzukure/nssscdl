# 03. 月間スケジュール・枠モデル基本設計

## 1. 目的

本書は、月単位で公開するスケジュールと、各レッスン時間枠の論理データモデルを定義する。

## 2. ScheduleMonth

公開単位が月であるため、月間スケジュールを表す `ScheduleMonth` を独立したエンティティ／D1実テーブルとして持つ。

### 2.1 最小論理属性

- `id` — 月間スケジュール識別子
- `year` — 対象年
- `month` — 対象月
- `published_at` — 公開日時。NULLなら未公開、値があれば公開済み
- `created_at`
- `updated_at`

同一年月の月間スケジュールを重複作成しないため、論理的に次の一意性を持たせる。

```text
UNIQUE(year, month)
```

初期リリースでは公開状態は「未公開／公開済み」の2状態であり、公開日時自体にも業務上の意味があるため、独立した `status` 列ではなく `published_at` を正本とする。

公開済み月の将来枠を変更した場合、その変更はCommit後ただちに有効とし、月全体の再公開操作は要求しない。

## 3. LessonSlot

`LessonSlot` は `ScheduleMonth` に所属する実際のレッスン時間枠を表す。

```text
ScheduleMonth 1 ───── 0..* LessonSlot
```

### 3.1 最小論理属性

- `id` — 枠識別子
- `schedule_month_id` — 所属する `ScheduleMonth`
- `lesson_date` — レッスン日
- `start_time` — 開始時刻
- `end_time` — 終了時刻

### 3.2 枠番号を保存しない

`LessonSlot` には「第1枠」「slot_no=2」のような枠番号を日時の正本として保存せず、**実際の開始時刻・終了時刻を保存する**。

曜日・祝日・学校設定等から時間割を選択する処理は月間スケジュール生成時のルールであり、生成後の `LessonSlot` は実際に予定された日時を自己完結して保持する。

これにより、将来既定の時間割設定が変更されても、過去または既に生成済みの枠の意味が変化しない。

### 3.3 一意性

同一月・同一日・同一開始時刻の枠を重複生成しないよう、論理的には次を一意とする。

```text
UNIQUE(schedule_month_id, lesson_date, start_time)
```

`lesson_date` が所属 `ScheduleMonth` の年月内であること、`start_time < end_time` であることも整合性条件とする。具体的なDB制約とApplication側検証の分担は物理設計で確定する。

## 4. SlotOccupancyとの関係

既決の `SlotOccupancy` は `LessonSlot` を占有する。

```text
ScheduleMonth
    │
    └─ LessonSlot
          │
          └─ 0..1 SlotOccupancy
                ├─ StudentReservation
                ├─ AdminHold
                └─ GroupLesson
```

月の公開状態、枠自体の日時、枠の占有を別の責務として扱う。

- `ScheduleMonth` — 月が公開済みか
- `LessonSlot` — その月に存在する具体的な日時枠
- `SlotOccupancy` — その枠を現在何が占有しているか

## 5. 次の設計論点: LessonSlotの利用可能状態

休業・公開後の無効化等を `LessonSlot` 自体の利用可能状態として保持する案を次の論点とする。

この場合でも、生徒予約／管理者確保／グループレッスンを `LessonSlot.status` に混在させず、それらは既決どおり `SlotOccupancy` で表現する。

すなわち、候補となる責務分離は次のとおり。

```text
LessonSlot availability
  enabled / disabled

SlotOccupancy
  empty / student reservation / admin hold / group lesson
```

この案を採る場合の状態名、無効理由の保持方法、予約済み枠を無効化する際のスクール都合キャンセルとの原子性は、次の検討で確定する。

## 6. 関連要求・方針

- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-010 既定ルールと例外を分離する
- REQ-001 初期画面・スケジュール確認
- REQ-002 予約可能枠表示
- REQ-301 月間スケジュール管理
- REQ-302 不定休・臨時休業
- REQ-303 月曜営業例外
- REQ-321 祝日
- REQ-907 タイムゾーン
- REQ-911 競合・整合性

## 7. 図

PlantUML source: `docs/diagrams/plantuml/data-model-overview.puml`

Rendered SVG: `docs/diagrams/rendered/data-model-overview.svg`（自動生成）
