# 05. 予約・競合・Transaction基本設計

## 1. 目的

本書は、予約・キャンセル・月間再分類等の業務操作について、D1上でどの状態変更を同一の整合範囲として扱うかを定義する。

本論点は `OI-BD-006` で検討する。未確定事項は本書で確定仕様として扱わず、確定した判断だけを本文へ反映する。

## 2. 既存の前提

以下は既存基本設計・ADRで確定済みである。

- `StudentReservation` は予約履歴の正本とする。
- `SlotOccupancy` は `LessonSlot` の現在占有の正本とする。
- `SlotOccupancy.slot_id` のUNIQUE制約を現在占有の一意性の最終保証点とする。
- 予約履歴と現在占有を分離する。
- Lesson開始済みReservationの `automatic_classification` は通常の自動再分類で遡及変更しない。
- 競合時は先に正常Commitされた状態を優先し、後続操作は最新状態を再検証する。
- Commit済みの内部業務状態を正とし、メール等の外部連携失敗を理由にRollbackしない。

## 3. 確定済み判断

### 3.1 スクール都合キャンセル後のSlot状態

スクール都合キャンセルでは、Reservationを取消したことだけを理由に `LessonSlot` を暗黙に `enabled + unoccupied` へ遷移させない。

スクール都合キャンセルを確定する業務Commandでは、少なくとも次を同一の整合範囲として扱う。

- `StudentReservation.status = school_cancelled`
- `StudentReservation.cancelled_at` の記録
- `SchoolCancellationDetail` の記録
- 元Reservationによる `SlotOccupancy` の終了
- キャンセル後のSlot状態の明示確定

キャンセル後のSlot状態は、業務目的に応じて少なくとも次のいずれかとして明示的に確定する。

1. `LessonSlot.availability_status = disabled` とする。
2. `AdminHold` 等の別占有へ置換する。
3. 明示的に再開放し、`LessonSlot.availability_status = enabled` かつ `SlotOccupancy` なしとする。

次の遷移は禁止する。

```text
school_cancelled
    ↓
元ReservationのSlotOccupancyだけを終了
    ↓
結果として暗黙に enabled + unoccupied
    ↓
意図せず生徒が再予約可能
```

「明示的に再開放する」は有効な業務選択肢であるが、スクール都合キャンセルの副作用として自動的に選択してはならない。

### 3.2 整合性上の理由

生徒の新規予約可否は、既存設計上少なくとも次から導出する。

```text
LessonSlot.availability_status = enabled
AND SlotOccupancy が存在しない
AND 公開・営業・開始時刻等の条件を満たす
```

このため、スクール都合キャンセルで元Reservationの占有だけを終了し、`LessonSlot` を `enabled` のまま残すと、業務上再開放する意思がない場合でも予約可能になる。

これは、スクール都合キャンセル後の枠を自動再開放しない既存方針、および業務上異なる状態を分離する `POL-009` に反するため禁止する。

### 3.3 外部通知との境界

スクール都合キャンセルに伴うメール送信等の外部処理は、確定済みの内部業務状態をRollbackする条件としない。

したがって、メール送信失敗が発生しても、確定済みの以下の状態を取消さない。

- `school_cancelled`
- `cancelled_at`
- `SchoolCancellationDetail`
- Reservation占有終了
- 明示確定済みのキャンセル後Slot状態

通知要求の永続化範囲と実送信の境界は、`OI-BD-006` の残論点として別途確定する。

### 3.4 予約確定Commandの原子的Transaction境界

予約確定Commandでは、少なくとも次を1つの原子的なD1 Transactionとして扱う。

- 新規 `StudentReservation` の作成
- 対象 `LessonSlot` に対する `SlotOccupancy` の確保
- 同一生徒・同一月について必要となる自動分類の再計算
- 新規Reservationおよび影響する未開始Reservationの `automatic_classification` / `classification` 更新

上記の一部だけが正常Commitされる状態を許容しない。

例えば、次のような状態を正常状態として残してはならない。

```text
StudentReservation は作成済み
AND SlotOccupancy は未作成
```

または、

```text
StudentReservation / SlotOccupancy は作成済み
AND 月間classificationは再計算前の旧状態
```

予約成立後にD1を参照したとき、その時点の月間分類まで含めて整合した状態になっていなければならない。

### 3.5 Commit直前の最新状態再検証

予約成立条件と新規Reservationのclassificationは、Preview時の状態を正本とせず、Commit直前の最新D1状態から再検証する。

少なくとも次の条件を最新状態で再評価する。

- 対象生徒が現在も予約操作可能であること。
- 対象月が公開済みであること。
- `LessonSlot.availability_status = enabled` であること。
- 信頼できるServer時刻でLesson開始前であること。
- 対象Slotに現在の `SlotOccupancy` が存在しないこと。
- 同一生徒・同一月のReservation、欠席、月間算入Override、`StudentMonthlyLessonConfig.standard_count` 等から最新の自動classificationを算出できること。

Preview後に先行Commitされた他予約、管理者変更、標準回数変更その他の業務変更は、後続の予約確定Commandから見た最新状態として扱う。

### 3.6 PreviewとCommit直前classificationの不一致

利用者が最終確認した新規予約のclassificationと、Commit直前の最新状態から算出したclassificationが異なる場合、予約を成立させずConflictとして再確認へ戻す。

これは次の両方向へ同一ルールを適用する。

```text
Preview: standard
Commit直前: additional
    → Conflict

Preview: additional
Commit直前: standard
    → Conflict
```

利用者に有利な変更か不利な変更かで処理を分けず、**最終確認したclassificationと実際にCommitするclassificationを一致させる**ことを原則とする。

Conflict時は最新状態と最新classificationを明示し、利用者が再度内容を確認してから確定操作を行う。

### 3.7 新規予約による既存Reservationの再分類

新規予約の成立によって同一生徒・同一月の既存未開始Reservationのclassificationが変化する場合、その既存Reservationの再分類も新規予約成立と同じTransactionでCommitする。

例えば標準回数 `N = 3` で、既存の未開始Reservationが次の状態であるとする。

```text
9/10 A standard
9/20 B standard
9/25 C standard
```

ここへより早い日時の予約Dを追加する場合、最新状態での再分類結果が次であれば、D作成とCの区分変更を同じTransactionで確定する。

```text
9/05 D standard
9/10 A standard
9/20 B standard
9/25 C additional
```

新規Reservationだけを先にCommitし、既存Reservationのclassification更新を後続Transactionへ分離してはならない。

開始済みReservationの `automatic_classification` は既存設計どおり遡及変更しない。

### 3.8 同一Slot以外の競合

予約競合は同一 `LessonSlot` の占有競合だけではない。

同一生徒が同一月の異なるSlotをほぼ同時に予約した場合、各Slotの `SlotOccupancy.slot_id UNIQUE` は互いに競合しないが、自動standard枠の割当ては互いに影響する。

したがって予約確定Commandでは、対象Slotの現在占有だけでなく、同一生徒・同一月の最新分類状態を再評価し、先行Commit後の状態を基準に後続Commandのclassificationを決定する。

後続Commandの新規ReservationのclassificationがPreview時から変化した場合は、3.6のConflictルールを適用する。

## 4. 関連要求・方針

- POL-003 業務状態と外部連携の分離
- POL-005 通知は即時性、システム画面は確実性
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-013 重要な管理操作の説明性と監査可能性
- BR-050 予約即時確定
- BR-051 二重予約禁止
- BR-052 予約期限
- BR-055 追加レッスン事前表示
- BR-056 月間標準回数
- BR-057 追加レッスン分類
- BR-058 自動再分類
- BR-059 明示Override優先
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- REQ-003 予約
- REQ-103 スクール都合キャンセル通知
- REQ-104 標準／追加区分変更通知
- REQ-302 不定休・臨時休業
- REQ-307 月間標準回数設定
- REQ-309 標準／追加再分類
- REQ-313 スクール都合キャンセル
- REQ-907 業務Timezone
- REQ-911 競合整合性

## 5. 未確定事項

以下は `OI-BD-006` で引き続き検討し、現時点では確定仕様として扱わない。

- 生徒キャンセルのTransaction境界
- system cancellationのTransaction境界
- AuditLogを業務Transactionへ含める範囲
- 通知Intentの永続化境界と外部送信の分離
- D1で使用する具体的なTransaction API、SQL順序、競合エラー表現

## 6. 設計判断記録

- 本書の検討Issue: GitHub Issue `#21` / `OI-BD-006`
- スクール都合キャンセル後のSlot状態は2026-08-28に確定した。
- 予約確定CommandのTransaction境界、Commit直前再検証、classification差分Conflict、新規予約による既存未開始Reservation再分類の同一Commit化は2026-08-28に確定した。
