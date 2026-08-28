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

## 4. 関連要求・方針

- POL-003 業務状態と外部連携の分離
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-013 重要な管理操作の説明性と監査可能性
- BR-051 二重予約禁止
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- REQ-103 スクール都合キャンセル通知
- REQ-302 不定休・臨時休業
- REQ-313 スクール都合キャンセル
- REQ-911 競合整合性

## 5. 未確定事項

以下は `OI-BD-006` で引き続き検討し、現時点では確定仕様として扱わない。

- 予約確定CommandのTransaction境界
- 生徒キャンセルのTransaction境界
- system cancellationのTransaction境界
- 月間再分類を原因操作と同一Commitへ含める範囲
- Preview時とCommit直前でclassificationが変化した場合のConflict方針
- AuditLogを業務Transactionへ含める範囲
- 通知Intentの永続化境界と外部送信の分離
- D1で使用する具体的なTransaction API、SQL順序、競合エラー表現

## 6. 設計判断記録

- 本書の検討Issue: GitHub Issue `#21` / `OI-BD-006`
- スクール都合キャンセル後のSlot状態は2026-08-28に確定した。
