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
- `availability_status` — 枠自体の利用可否。`enabled` / `disabled`

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

## 4. LessonSlot の利用可能状態

### 4.1 決定

生成済みの `LessonSlot` 自体が現在利用可能かどうかを `availability_status` で保持する。

初期リリースの状態は次の2値とする。

- `enabled` — 枠自体は利用可能
- `disabled` — 枠自体を利用不可とする

予約済み、管理者確保、グループレッスン等の占有状態は `LessonSlot.availability_status` に含めず、既決どおり `SlotOccupancy` で表現する。

したがって「枠の利用可否」と「枠の占有」は独立した軸とする。

```text
LessonSlot.availability_status
  enabled / disabled

SlotOccupancy
  none / student_reservation / admin_hold / group_lesson
```

### 4.2 予約可能判定

生徒が新規予約できるためには、少なくとも次の両方を満たす必要がある。

1. `LessonSlot.availability_status = enabled`
2. 対応する `SlotOccupancy` が存在しない

概念上の表示・予約可能状態は次のように導出する。

| LessonSlot | SlotOccupancy | 意味 |
| --- | --- | --- |
| enabled | なし | 予約可能 |
| enabled | StudentReservation | 予約済み |
| enabled | AdminHold | 管理者確保／予約不可 |
| enabled | GroupLesson | グループレッスン |
| disabled | なし | 休業・無効化等により予約不可 |

`disabled` の枠に新たな `SlotOccupancy` を作成してはならない。

### 4.3 生成ルールと無効化の分離

通常の営業ルール上そもそも存在しない時間枠は `disabled` の `LessonSlot` として大量生成せず、**LessonSlot自体を生成しない**。

例:

- 通常休業日で対象時間枠が存在しない
- その曜日・日種別の既定時間割に存在しない時間帯

一方、既に生成済みの将来枠を、臨時休業その他の運営判断により後から利用不可とする場合は、対象 `LessonSlot` を `enabled` から `disabled` に変更する。

この分離により、次を区別する。

- 既定ルール上「存在しない枠」
- 生成済みだが後から「利用不可になった枠」

これは `POL-010` の既定ルールと例外の分離に従う。

### 4.4 占有済み枠を無効化する場合

`StudentReservation` が存在する枠を管理者が `disabled` にしようとする場合、単に `availability_status` だけを変更して予約を残してはならない。

要求仕様のスクール都合キャンセル処理として、概念上次を一まとまりの業務操作として扱う。

```text
StudentReservation が存在
        ↓
スクール都合キャンセルを確定
        ↓
予約占有を解放
        ↓
LessonSlot を disabled に変更
```

利用者への影響確認、通知、監査、競合時の再検証は既存要求に従う。

この一連の変更をD1上でどのTransaction境界・SQL順序で実現するかは、予約整合性／Transaction設計で確定する。

`AdminHold` または `GroupLesson` が存在する枠を `disabled` にする場合も、占有を残したまま利用可否だけを変更して意味が曖昧にならないよう、対応する占有の解除・変更と整合した業務操作として扱う。

### 4.5 disabled の理由

`disabled` となった理由を監査・管理画面上どの粒度で保持するかは、スケジュール変更設計で具体化する。

ただし、曜日・祝日等の通常生成ルールと、生成済み枠に対する個別無効化理由を同一の状態値へ押し込まない。`availability_status` はあくまで現在の利用可否を表す。

## 5. SlotOccupancyとの関係

既決の `SlotOccupancy` は `LessonSlot` を占有する。

```text
ScheduleMonth
    │
    └─ LessonSlot
          │ availability_status
          │ enabled / disabled
          │
          └─ 0..1 SlotOccupancy
                ├─ StudentReservation
                ├─ AdminHold
                └─ GroupLesson
```

月の公開状態、枠自体の日時・利用可否、枠の占有を別の責務として扱う。

- `ScheduleMonth` — 月が公開済みか
- `LessonSlot` — その月に存在する具体的な日時枠と現在の利用可否
- `SlotOccupancy` — その枠を現在何が占有しているか

## 6. 関連要求・方針

- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-010 既定ルールと例外を分離する
- POL-013 重要な管理操作の説明性と監査可能性
- REQ-001 初期画面・スケジュール確認
- REQ-002 予約可能枠表示
- REQ-003 予約
- REQ-103 スクール都合キャンセル通知
- REQ-301 月間スケジュール管理
- REQ-302 不定休・臨時休業
- REQ-303 月曜営業例外
- REQ-313 スクール都合キャンセル
- REQ-321 祝日
- REQ-907 タイムゾーン
- REQ-911 競合・整合性

## 7. 図

PlantUML source: `docs/diagrams/plantuml/data-model-overview.puml`

Rendered SVG: `docs/diagrams/rendered/data-model-overview.svg`（自動生成）
