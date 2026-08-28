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
2. `LessonSlot.availability_status = enabled` のまま `AdminHold` 等の別占有へ置換する。
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

また `disabled` のSlotへ新たな `SlotOccupancy` を作成しない。AdminHold等へ置換する場合は `enabled + 対応するSlotOccupancy` として確定する。

### 3.2 スクール都合キャンセルと外部通知の境界

スクール都合キャンセルに伴うメール送信等の外部処理は、確定済みの内部業務状態をRollbackする条件としない。

したがって、メール送信失敗が発生しても、確定済みの以下の状態を取消さない。

- `school_cancelled`
- `cancelled_at`
- `SchoolCancellationDetail`
- Reservation占有終了
- 明示確定済みのキャンセル後Slot状態

通知要求の永続化範囲と実送信の境界は、`OI-BD-006` の残論点として別途確定する。

### 3.3 予約確定Commandの原子的Transaction境界

予約確定Commandでは、少なくとも次を1つの原子的なD1 Transactionとして扱う。

- 新規 `StudentReservation` の作成
- 対象 `LessonSlot` に対する `SlotOccupancy` の確保
- 同一生徒・同一月について必要となる自動分類の再計算
- 新規Reservationおよび影響する未開始Reservationの `automatic_classification` / `classification` 更新

上記の一部だけが正常Commitされる状態を許容しない。

```text
StudentReservation は作成済み
AND SlotOccupancy は未作成
```

または、

```text
StudentReservation / SlotOccupancy は作成済み
AND 月間classificationは再計算前の旧状態
```

といった状態を正常Commitとして残してはならない。

### 3.4 予約確定時の最新状態再検証

予約成立条件と新規Reservationのclassificationは、Preview時の状態を正本とせず、Commit直前の最新D1状態から再検証する。

少なくとも次の条件を最新状態で再評価する。

- 対象生徒が現在も予約操作可能であること。
- 対象月が公開済みであること。
- `LessonSlot.availability_status = enabled` であること。
- 信頼できるServer時刻でLesson開始前であること。
- 対象Slotに現在の `SlotOccupancy` が存在しないこと。
- 同一生徒・同一月のReservation、欠席、月間算入Override、`StudentMonthlyLessonConfig.standard_count` 等から最新の自動classificationを算出できること。

Preview後に先行Commitされた他予約、管理者変更、標準回数変更その他の業務変更は、後続の予約確定Commandから見た最新状態として扱う。

### 3.5 PreviewとCommit直前classificationの不一致

利用者が最終確認した新規予約のclassificationと、Commit直前の最新状態から算出したclassificationが異なる場合、予約を成立させずConflictとして再確認へ戻す。

```text
Preview: standard
Commit直前: additional
    → Conflict

Preview: additional
Commit直前: standard
    → Conflict
```

利用者に有利な変更か不利な変更かで処理を分けず、最終確認したclassificationと実際にCommitするclassificationを一致させる。

Conflict時は最新状態と最新classificationを明示し、利用者が再度内容を確認してから確定操作を行う。

### 3.6 新規予約による既存Reservationの再分類

新規予約の成立によって同一生徒・同一月の既存未開始Reservationのclassificationが変化する場合、その再分類も新規予約成立と同じTransactionでCommitする。

新規Reservationだけを先にCommitし、既存Reservationのclassification更新を後続Transactionへ分離してはならない。

開始済みReservationの `automatic_classification` は既存設計どおり遡及変更しない。

同一生徒が同一月の異なるSlotをほぼ同時に予約した場合も、各Slotの占有競合とは別に月間自動分類が競合し得るため、同一生徒・同一月の最新状態を再評価する。

### 3.7 生徒キャンセルCommandの原子的Transaction境界

生徒キャンセルCommandでは、少なくとも次を1つの原子的なD1 Transactionとして扱う。

- 対象 `StudentReservation.status` を `confirmed` から `student_cancelled` へ変更
- `StudentReservation.cancelled_at` にキャンセル確定時刻を記録
- 対象Reservationの `classification` をNULLへ変更
- 対象Reservationの `automatic_classification` は保持
- 対象Reservationによる `SlotOccupancy` を終了
- 同一生徒・同一月について必要となる未開始Reservationの自動再分類
- 再分類対象Reservationの `automatic_classification` / `classification` 更新

次の部分成功を正常Commitとして許容しない。

```text
Reservationは student_cancelled
AND 対応するSlotOccupancyが残存
```

```text
Reservationは student_cancelled
AND 対象Reservation.classificationがstandard/additionalのまま
```

```text
キャンセルは確定済み
AND 必要な月間再分類が旧状態のまま
```

### 3.8 生徒キャンセルの開始前／開始後の扱い

開始前と開始後〜終了時刻の生徒キャンセルで、Reservation占有終了の扱いは分けない。キャンセル成立時にはいずれも元Reservationによる `SlotOccupancy` を終了する。

違いは、その後の新規予約可否である。

```text
開始前キャンセル
  → SlotOccupancy終了
  → LessonSlotがenabledで他条件を満たす
  → 新規予約可能
```

```text
開始後〜終了時刻のキャンセル
  → SlotOccupancy終了
  → Server時刻がLesson開始時刻以降
  → 新規予約不可
```

開始後キャンセルを表現するために、元ReservationのSlotOccupancyを残したり、LessonSlotを自動的にdisabledへ変更したり、専用のclosed状態を追加したりしない。

### 3.9 生徒キャンセル時の最新状態再検証

生徒キャンセルはCommit直前の最新状態で少なくとも次を再検証する。

- 対象Reservationが操作中の生徒自身のReservationであること。
- `StudentReservation.status = confirmed` であること。
- Server Commit基準時刻がLesson終了時刻を超えていないこと。
- 現在の `SlotOccupancy` が対象Reservationを現在占有として参照していること。
- `SlotOccupancy.slot_id` と `StudentReservation.lesson_slot_id` が一致すること。

Preview／確認後にスクール都合キャンセル、システム起因キャンセルその他の先行操作が正常Commitされ、対象Reservationが既に `confirmed` でない場合は、生徒キャンセルで上書きしない。

先に正常Commitされた取消種別を正本とし、後続CommandはConflictまたは最新状態に応じた拒否として扱う。

### 3.10 Server Commit基準時刻の統一

キャンセル期限、開始前／開始後の判定、再分類対象Reservationの開始境界判定には、同一Command内で一貫したServer Commit基準時刻を用いる。

Client時刻や画面表示時刻を業務期限判定の正本としない。

例えば、利用者が開始前に確定操作を行っても、最終判定時点でLesson開始時刻を越えていれば、キャンセル自体が終了時刻前なら成立するが開始後キャンセルとして扱う。

再分類では、この同じ基準時刻で開始済みとなっているReservationの `automatic_classification` を変更しない。

### 3.11 生徒キャンセルとclassification

キャンセル対象Reservationは月間算入対象外となるため、次の状態へ変更する。

```text
classification = NULL
automatic_classification = 保持
```

キャンセルにより自動標準枠の割当てが変化する場合は、同一生徒・同一月の未開始Reservationだけを必要に応じて再分類する。

開始済みReservationの `automatic_classification` を遡及変更しない。

既存未開始Reservationの実効classificationが変化した場合はREQ-104の区分変更通知対象となる。通知Intentの永続化境界は別途確定するが、区分変更自体は生徒キャンセルTransactionと同じCommitで確定する。

### 3.12 生徒削除Commandの即時Transaction境界

初期リリースのsystem cancellationは、主として生徒削除に伴う `reason_code = student_deleted` を対象とする。

生徒削除Commandの正常Commitでは、少なくとも次を1つの原子的なD1 Transactionの整合範囲として扱う。

- 対象生徒を以後Login・新規予約・キャンセル等の通常操作ができない削除確定状態へ遷移させる。
- 対象生徒の既存Sessionを無効化する。
- 同一のServer Commit基準時刻で将来と判定される `confirmed` Reservationをすべて `system_cancelled` へ変更する。
- 各対象Reservationの `cancelled_at` を同一の基準時刻で記録する。
- 各対象Reservationに `SystemCancellationDetail.reason_code = student_deleted` を作成する。
- 各対象Reservationの `classification` をNULLへ変更し、`automatic_classification` は保持する。
- 各対象Reservationを参照する `SlotOccupancy` を終了する。
- 開始前かつ他の予約可能条件を満たすSlotを、最新状態から予約可能として判定できる状態へ戻す。
- 直接管理PIIのPurgeが必要であることを、後続処理が失われない形で永続化する。

次のような部分成功を正常Commitとして許容しない。

```text
生徒は削除確定済み
AND 将来Reservationがconfirmedのまま
```

```text
Reservationはsystem_cancelled
AND 対応するSlotOccupancyが残存
```

```text
一部の将来Reservationだけsystem_cancelled
AND 他の将来Reservationはconfirmed
```

### 3.13 PII Purgeは後続処理へ分離する

氏名、連絡先メール、Google紐付け等の直接管理PIIの実削除・匿名化は、生徒削除の即時Transactionには含めない。

REQ-311ではSession無効化を即時、直接管理PIIの削除・匿名化を24時間以内としているため、次の2段階に分離する。

```text
生徒削除Transaction
  → 即時利用不能
  → 将来予約取消
  → SlotOccupancy終了
  → PII Purge必要状態を永続化
  → COMMIT

後続Purge処理
  → 直接管理PIIを削除／匿名化
  → Purge完了状態を記録
```

生徒削除TransactionのCommit後にWorkerが停止してもPII Purge要求を失わないよう、Purge待ちであることはD1上の永続状態として追跡可能にする。具体的なEntity、列、Scheduled Jobは認証・アカウント設計および詳細設計で定義する。

### 3.14 将来ReservationはAll-or-Nothingで処理する

削除対象生徒に複数の将来Reservationが存在する場合、対象集合全体を1つの整合単位として扱う。

すべての対象Reservationについて `system_cancelled`、`cancelled_at`、`SystemCancellationDetail`、`classification = NULL`、必要な `SlotOccupancy` 終了まで成立して初めて生徒削除を正常Commitする。

競合等により一部Reservationだけを処理できない場合、そのReservationだけを飛ばして残りの生徒削除を成立させない。

### 3.15 system cancellationの基準時刻

生徒削除Commandでは1つの信頼できるServer Commit基準時刻 `T` を用いる。

削除対象となる将来Reservationは、少なくとも次を満たすものとする。

```text
StudentReservation.status = confirmed
AND LessonSlot.start_time > T
```

同じ `T` を将来予約判定、`cancelled_at`、Lesson開始境界判定へ一貫して使用する。

`T` 時点ですでに開始済みまたは過去のReservationは `student_deleted` によるsystem cancellation対象へ遡及的に含めない。

### 3.16 削除確認後の影響範囲変更はConflictとする

生徒削除は不可逆性の高い重要管理操作であるため、管理者が確認したPreview時の将来Reservation対象集合とCommit直前の最新対象集合が異なる場合は、削除を正常Commitしない。

例えば、確認後に生徒自身のキャンセル、スクール都合キャンセル、予約成立その他の先行Commitによって対象集合または状態が変化していれば、最新の削除影響を再表示し管理者の再確認を求める。

```text
Preview対象集合 != Commit直前対象集合
    → Conflict
    → 部分適用しない
    → 最新影響を再表示
    → 再確認
```

### 3.17 student_deletedとclassification

`student_deleted` では同一生徒の将来 `confirmed` Reservationをすべて取消すため、正常Commit後にその生徒の未開始 `confirmed` Reservationは残らない。

したがって初期リリースの `student_deleted` 処理では、対象Reservationを `classification = NULL` とし `automatic_classification` を保持すればよく、残存する未開始Reservationへの通常の月間自動再分類は原則発生しない。

将来 `student_deleted` 以外のsystem cancellation理由を追加し、一部Reservationだけを取消す仕様を導入する場合は、その理由ごとに月間再分類要否を改めて設計する。

## 4. 未来Slotの現在状態に関するInvariant

本節は、要求仕様 `BR-067 未来枠の現在予約状態の一貫性` を、現在採用しているデータモデルとTransaction設計で実現するための基本設計である。将来実装方式やデータモデルを変更する場合も、BR-067の業務上の一貫性要求は維持する。

### 4.1 現在占有の正本

サービスの根幹となる「このSlotは現在空いているか」「現在何によって占有されているか」「生徒予約なら誰が予約しているか」は、過去のReservation履歴から推測せず、`LessonSlot` と `SlotOccupancy` を基点に判定する。

生徒予約による現在予約者は次の一意な経路で取得する。

```text
LessonSlot
  ↓
SlotOccupancy
  occupancy_type = student_reservation
  reservation_id = R
  ↓
StudentReservation R
  student_id = S
  ↓
Student S
```

同一Slotにはキャンセル済みを含む複数のReservation履歴が存在できるため、`StudentReservation WHERE lesson_slot_id = ? AND status = confirmed` の検索結果を現在占有の正本として扱わない。

### 4.2 未来Slotで常時成立させるInvariant

少なくとも未来の `LessonSlot` について、次を常時成立させる。

1. `SlotOccupancy.slot_id` はUNIQUEであり、1つのSlotに現在占有は最大1件である。
2. `SlotOccupancy.occupancy_type = student_reservation` の場合、`reservation_id` は必須である。
3. `reservation_id` が参照する `StudentReservation` は存在し、`status = confirmed` である。
4. `StudentReservation.lesson_slot_id = SlotOccupancy.slot_id` である。
5. `student_cancelled` / `school_cancelled` / `system_cancelled` のReservationを `SlotOccupancy` が参照しない。
6. 未来の `confirmed` StudentReservationが現在そのSlotを有効に占有している場合、対応する `SlotOccupancy` が必ず存在する。
7. `LessonSlot.availability_status = disabled` の場合、現在占有を残さない。
8. `LessonSlot.availability_status = enabled` かつ `SlotOccupancy` が存在しない場合でも、公開状態、Server時刻、その他予約条件を満たす場合にのみ新規予約可能とする。

これにより、少なくとも次の矛盾を正常状態として許容しない。

```text
予約済みなのに空きとして表示される
```

```text
空きとして扱っているのに現在予約者が存在する
```

```text
キャンセル済みReservationが現在予約者として残る
```

### 4.3 Invariant違反時のFail Closed

現在予約状態に関するInvariant違反を検出した場合、Application Workerは矛盾を都合よく解釈して新規予約処理を続行してはならない。

例えば、次の状態を検出した場合、Reservationのstatusだけを見てSlotOccupancyを無視し「空き」として扱わない。

```text
SlotOccupancy
  occupancy_type = student_reservation
  reservation_id = #501

StudentReservation #501
  status = student_cancelled
```

このような状態では新規予約を拒否するFail Closedを基本とし、データ整合性異常として記録・検知対象とする。

通常の利用者競合と、既に永続化されたInvariant違反は区別する。後者を通常Commandの副作用として無言で自動修復し、そのまま予約を成立させない。

具体的な異常コード、監視通知、修復手順は後続設計で定義する。

## 5. 関連要求・方針

- POL-003 業務状態と外部連携の分離
- POL-004 個人情報最小化
- POL-005 通知は即時性、システム画面は確実性
- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-013 重要な管理操作の説明性と監査可能性
- BR-050 予約即時確定
- BR-051 二重予約禁止
- BR-052 予約期限
- BR-053 生徒キャンセル期限
- BR-054 キャンセル後の枠
- BR-055 追加レッスン事前表示
- BR-056 月間標準回数
- BR-057 追加レッスン分類
- BR-058 自動再分類
- BR-059 明示Override優先
- BR-060 月間回数除外
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- BR-067 未来枠の現在予約状態の一貫性
- BR-100 生徒削除
- BR-123 削除時即時無効化
- BR-124 直接管理PII削除
- BR-125 将来予約処理
- REQ-002 予約可能枠表示
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-103 スクール都合キャンセル通知
- REQ-104 標準／追加区分変更通知
- REQ-110 重要業務状態のシステム表示
- REQ-207 Session管理
- REQ-302 不定休・臨時休業
- REQ-307 月間標準回数設定
- REQ-309 標準／追加再分類
- REQ-311 生徒削除
- REQ-312 削除時予約処理
- REQ-313 スクール都合キャンセル
- REQ-907 業務Timezone
- REQ-911 競合整合性

## 6. 未確定事項

以下は `OI-BD-006` で引き続き検討し、現時点では確定仕様として扱わない。

- AuditLogを業務Transactionへ含める範囲
- 通知Intentの永続化境界と外部送信の分離
- D1で使用する具体的なTransaction API、SQL順序、競合エラー表現
- Invariant違反の具体的な監視・異常コード・修復手順

## 7. 設計判断記録

- 本書の検討Issue: GitHub Issue `#21` / `OI-BD-006`
- スクール都合キャンセル後のSlot状態は2026-08-28に確定した。
- 予約確定CommandのTransaction境界、Commit直前再検証、classification Conflict、既存Reservation再分類の同一Commit方針は2026-08-28に確定した。
- 生徒キャンセルCommandのTransaction境界、開始前／開始後の占有終了、最新状態再検証、Server Commit基準時刻、分類更新方針は2026-08-28に確定した。
- 生徒削除起因のsystem cancellationについて、即時利用不能、Session無効化、全将来Reservationの取消、SystemCancellationDetail、classification NULL化、SlotOccupancy終了、PII Purge必要状態を同一の原子的Transaction境界として扱う方針は2026-08-28に確定した。
- PIIの実削除・匿名化は24時間以内の後続処理へ分離し、Purge必要状態を永続化する方針は2026-08-28に確定した。
- 生徒削除Preview後に将来Reservation対象集合が変化した場合は部分適用せずConflictとして再確認する方針は2026-08-28に確定した。
- 未来Slotの現在占有を `SlotOccupancy` の正本から一意に判断し、Reservationとの双方向整合Invariantを維持し、Invariant違反時はFail Closedとする方針は2026-08-28に確定した。
- 上記未来Slot一貫性方針は要求仕様v1.3で `BR-067` として要求化し、本節をその実現設計としてトレースする。
