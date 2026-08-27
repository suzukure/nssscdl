# 04. 予約モデル基本設計

## 1. 目的

本書は、生徒予約の履歴とLessonSlotの現在占有を分離し、さらに予約ライフサイクル、欠席、月間回数算入、自動分類、実効classification、管理者Overrideを業務上異なる概念として一貫して扱うための論理データモデルを定義する。

## 2. 基本方針

予約モデルでは次の責務を分離する。

- `StudentReservation` — 予約という業務事実・履歴の正本。予約ライフサイクル状態、自動分類値、現在の実効区分を保持する。
- `SlotOccupancy` — `LessonSlot` の現在占有の正本。
- `ReservationAbsence` — 欠席という、キャンセルとは異なる事実。
- `ReservationMonthlyCountOverride` — 管理者による月間回数算入の例外。
- `ReservationClassificationOverride` — 管理者による標準／追加区分の明示Override。
- `SchoolCancellationDetail` — スクール都合キャンセル固有の理由カテゴリ・補足。
- `StudentMonthlyLessonConfig` — 生徒・月単位の標準レッスン回数設定。

`StudentReservation` を削除して空きを表現せず、キャンセル後も履歴として残す。一方、再予約可能な枠については `SlotOccupancy` を解放する。

また、以下を同一の状態へ統合しない。

```text
予約ライフサイクル ≠ 欠席
予約ライフサイクル ≠ 月間回数算入
月間回数算入       ≠ 自動分類
自動分類           ≠ 実効classification
自動分類           ≠ 明示Classification Override
```

これは `POL-009` の「業務上異なる意味を別の状態として扱う」に従う。

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
└─ Reservation #503 : confirmed
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

`SlotOccupancy.occupancy_type = student_reservation` の場合、`SlotOccupancy.reservation_id` から現在そのSlotを占有している `StudentReservation` を参照する。

`SlotOccupancy` はReservationの子として所有されるのではなく、LessonSlotに属する現在占有レコードである。

## 5. StudentReservation

### 5.1 最小論理属性

`StudentReservation` は少なくとも次の論理属性を持つ。

- `id` — 予約識別子
- `student_id` — 対象生徒
- `lesson_slot_id` — 対象LessonSlot
- `status` — 予約ライフサイクル状態
- `automatic_classification` — 自動分類ロジックによる `standard` / `additional`
- `classification` — 現在の実効標準／追加区分。分類対象外では物理的にNULLとする
- `created_at` — 予約成立日時
- `updated_at` — 業務状態の最終更新日時

正確なDB型、Enum表現、更新時刻の持ち方は物理設計で確定する。

### 5.2 statusの責務

`status` は予約ライフサイクルだけを表し、欠席、月間算入、自動分類、実効classificationを混在させない。

初期リリースで少なくとも識別すべきライフサイクル状態は次のとおり。

- `confirmed` — 正常に成立し、キャンセルされていない予約
- `student_cancelled` — 生徒キャンセル済み
- `school_cancelled` — スクール都合キャンセル済み

`confirmed` は「これから実施される予約」だけを意味しない。Lesson終了後もキャンセルされていなければ `confirmed` のままとし、時間経過だけを理由に `completed` 等へ遷移させない。

したがって、Lessonの未来／開始済み／終了済みは `status` ではなく `LessonSlot` の日時との比較から判断する。欠席は `ReservationAbsence` で別に表す。

要求仕様上の表示語「予約済み」はこの非キャンセル状態に対応する。内部状態名を `confirmed` とすることは要求仕様上の表示語を変更するものではない。

生徒削除等のシステム起因取消を独立した状態コードとして持つか、取消原因を別属性で持つかは、削除処理の物理・詳細設計で確定する。ただし生徒キャンセルやスクール都合キャンセルを無言で同一状態へ潰さない。

### 5.3 automatic_classificationの責務

`automatic_classification` は、管理者Overrideを適用する前の自動分類結果を保持する。

```text
standard
additional
```

Lesson開始前のReservationでは、自動分類条件の変化により更新され得る。Lesson開始時刻以降は、そのReservationの `automatic_classification` を後続の自動再分類によって変更しない。

この「開始済みなら自動更新しない」という判定は、開始時刻にバッチ処理や状態遷移を実行するという意味ではない。再分類処理の都度、`LessonSlot` の開始時刻と現在時刻を比較して更新対象を未開始Reservationへ限定する。

月間算入対象外となった場合でも、`automatic_classification` は削除・NULL化せず、最後に確定している自動分類値を保持する。これは過去の自動分類を遡及書換えせず、後から再び算入対象になった場合の復元・標準枠消費判定に利用するためである。

### 5.4 classificationの責務

`classification` は、**月間回数への算入対象であるReservationに現在適用されている実効区分**を保持する。

```text
standard
additional
```

月間回数への算入対象外となったReservationにはstandard / additionalを適用せず、仕様上 **「分類対象外（not applicable）」** と呼ぶ。

「分類対象外」はclassificationの第3の業務値ではない。物理データ上は `StudentReservation.classification = NULL` を基本表現とし、画面や仕様説明でNULLという語を状態名として表示しない。

月間算入対象Reservationでは、`ReservationClassificationOverride` がなければ `automatic_classification` を実効classificationとする。Overrideがあれば、そのOverride値を実効classificationとする。

```text
月間算入対象
  ├─ ClassificationOverrideなし
  │      → classification = automatic_classification
  └─ ClassificationOverrideあり
         → classification = Override値

月間算入対象外
         → classification = NULL
```

利用者画面・通知等で参照する現在値は `StudentReservation.classification` とする。

## 6. キャンセルと再予約

### 6.1 開始前キャンセル

開始前キャンセルでは、Reservation履歴を残したまま現在占有を解放する。

```text
Before
LessonSlot #100
├─ Reservation #501 : confirmed
└─ SlotOccupancy -> #501

After cancel
LessonSlot #100
├─ Reservation #501 : student_cancelled
└─ SlotOccupancyなし
```

キャンセル後は月間回数の算入対象外となるため、対象Reservationのclassificationは「分類対象外」とし、物理的にはNULLとする。一方、`automatic_classification` は履歴上の自動分類値として保持する。

その後に同じSlotが再予約された場合、新しいReservationを作成する。過去Reservationを再利用・上書きしない。

### 6.2 スクール都合キャンセル

スクール都合キャンセルでは `StudentReservation.status = school_cancelled` とし、理由カテゴリ・任意補足は `SchoolCancellationDetail` に保持する。

スクール都合キャンセル後も月間回数の算入対象外となるため、classificationは「分類対象外」とする。`automatic_classification` は保持する。

枠を再開放する場合は現在占有を解放し、枠を休業化・管理者確保へ変更する場合は、その業務変更と整合する形でSlot状態・SlotOccupancyを更新する。

### 6.3 開始時刻以降

開始時刻以降の新規予約禁止はSlotOccupancyとは別の時刻ルールとして判定する。

したがって開始後にReservationがキャンセル等で有効状態を失っても、そのSlotを新規予約可能とはしない。

## 7. ReservationAbsence

### 7.1 決定

欠席は予約ライフサイクル状態とは別の `ReservationAbsence` として保持する。

```text
StudentReservation 1 ───── 0..1 ReservationAbsence
```

最小論理属性:

- `reservation_id` — 対象Reservation。UNIQUE
- `recorded_at` — 欠席記録日時
- `recorded_by` — 記録した管理主体

欠席理由等の自由記述は初期要求にないため保持しない。

### 7.2 意味

```text
status = confirmed / ReservationAbsenceなし
    → 通常の非キャンセル予約

status = confirmed / ReservationAbsenceあり
    → 欠席

status = *_cancelled
    → キャンセル済み。欠席として扱わない
```

欠席はLesson終了後のみ設定・解除できる。既にキャンセル済みのReservationへ欠席を設定してはならない。

欠席中は月間回数の算入対象外となるためclassificationは「分類対象外」とする。ただし開始済みReservationの `automatic_classification` は変更しない。

欠席設定により開始済みの自動standardが算入対象外になった場合、その自動標準枠は未開始Reservationの再分類でのみ再利用する。他の開始済みReservationを遡及変更しない。

欠席解除で再び算入対象となった場合は、そのReservation自身には保持済みの `automatic_classification` と必要に応じ保持済みClassificationOverrideを再適用し、標準枠消費数の変化は未開始Reservationの再分類にだけ反映する。

設定・解除操作そのものの履歴はAuditLogへ記録する。

## 8. 月間回数算入

### 8.1 実効算入は導出する

月間回数への実効算入可否を `StudentReservation` に重複保存せず、Reservation状態、欠席、管理者Overrideから導出する。

初期ルールでは概念的に次のとおり。

```text
status = confirmed
AND ReservationAbsenceなし
AND ReservationMonthlyCountOverrideによる除外なし
    → 月間回数へ算入

それ以外
    → 月間回数から除外
```

生徒キャンセル、スクール都合キャンセル、欠席は初期リリースでは算入しない。

### 8.2 ReservationMonthlyCountOverride

管理者が特定予約を月間回数から明示的に除外する例外を `ReservationMonthlyCountOverride` として保持する。

```text
StudentReservation 1 ───── 0..1 ReservationMonthlyCountOverride
```

最小論理属性:

- `reservation_id` — 対象Reservation。UNIQUE
- `override_mode` — 月間回数算入Override。初期リリースでは少なくとも `excluded`
- `changed_at` — 設定日時
- `changed_by` — 設定した管理主体

`CountOverride` という省略名は意味が曖昧なため使用しない。正式名称は **`ReservationMonthlyCountOverride`** とする。

このEntityは標準／追加区分そのものを変更するものではない。算入対象の集合が変わった結果として、未開始Reservationの自動分類が再計算される場合がある。

`excluded` の間は対象Reservationを「分類対象外」とし、classificationを物理的にNULLとする。`automatic_classification` は保持する。

Overrideを解除した場合、未開始Reservationなら通常の自動再分類対象へ戻す。開始済みReservationなら保持済み `automatic_classification` をそのReservation自身の基準値として復帰させ、標準枠消費数の変化は未開始Reservationだけに反映する。

Overrideの解除・変更履歴はAuditLogへ記録する。

### 8.3 分類対象外（not applicable）

「分類対象外」は、Reservationが現在standard / additionalの実効分類対象ではないことを表す仕様用語である。

初期リリースでは少なくとも次の場合に分類対象外となる。

- `status = student_cancelled`
- `status = school_cancelled`
- `ReservationAbsence` あり
- `ReservationMonthlyCountOverride.override_mode = excluded`

保存上はclassificationの第3値 `not_applicable` を追加せず、`StudentReservation.classification = NULL` とする。

```text
月間算入対象
    → classification = standard / additional

月間算入対象外
    → 仕様上: 分類対象外（not applicable）
    → 保存上: classification = NULL
```

利用者画面ではNULLや `not_applicable` を機械的に表示するのではなく、生徒キャンセル、スクール都合キャンセル、欠席、回数算入対象外など、そのReservationが分類対象外である理由となる業務状態を表示する。

分類対象外への遷移は `automatic_classification` を消去することを意味しない。

## 9. 標準／追加区分とOverride

### 9.1 用語上の注意: 標準回数は「実効standard件数の上限」ではない

`StudentMonthlyLessonConfig.standard_count`（以下、標準回数N）は、**自動分類によってstandardを割り当てる基準数**を表す。

標準回数Nを「最終的にstandardと表示されるReservationの最大件数」と解釈してはならない。

理由は2つある。

1. ClassificationOverrideによる例外standardは自動標準枠を消費しない。
2. Lesson開始済みReservationの自動分類は後続の標準回数変更等で遡及変更しないため、Nを後から小さくしても開始済み自動standardがそのまま残る場合がある。

文書・実装上、必要に応じて次の呼び分けを用いる。

- **自動standard** — `automatic_classification = standard` のReservation
- **例外standard** — `automatic_classification = additional` だがClassificationOverrideにより実効standardとなったReservation
- **実効classification** — 月間算入可否とOverrideを反映した、画面・通知等が参照する最終区分
- **消費済み自動標準枠** — 開始済みかつ現在も月間算入対象で、`automatic_classification = standard` のReservation件数

### 9.2 Lesson開始時刻を確定境界とする

自動分類の確定境界は `LessonSlot` の開始時刻とする。

```text
未開始Reservation
    → automatic_classification は再計算対象

Lesson開始時刻到達
    ↓

開始済みReservation
    → automatic_classification は自動では変更しない
```

開始時刻到達時にCronやバッチで「確定」更新を行う必要はない。再分類処理が発生した時点で、信頼できる現在時刻と `LessonSlot.start_time` を比較し、開始済みを更新対象から除外する。

### 9.3 自動再分類アルゴリズム

同一生徒・同一月の再分類では、まず開始済みReservationと未開始Reservationを分ける。

開始済みReservationについては `automatic_classification` を変更しない。そのうち現在も月間算入対象で `automatic_classification = standard` の件数を `C` とする。

標準回数を `N` とすると、未開始Reservationへ割り当て可能な残り自動標準枠 `R` は次のとおり。

```text
C = 開始済み
    AND 月間算入対象
    AND automatic_classification = standard
    の件数

R = max(N - C, 0)
```

次に月間算入対象の未開始Reservationを予定日時順に並べる。

```text
未開始・算入対象Reservation
    ↓ 予定日時順
先頭R件      → automatic_classification = standard
R+1件目以降  → automatic_classification = additional
```

未開始・算入対象外Reservationは自動分類の割当て集合から除外する。ただし既存の `automatic_classification` を履歴上の値として消去する必要はない。

自動分類処理後、算入対象Reservationの実効classificationを次の順で更新する。

```text
ClassificationOverrideあり
    → classification = Override値

ClassificationOverrideなし
    → classification = automatic_classification

算入対象外
    → classification = NULL
```

### 9.4 過去の変更は未来にだけ伝播させる

開始済みReservationに後から欠席・月間回数除外等を設定した場合、そのReservation自身は分類対象外へ変更できるが、他の開始済みReservationの `automatic_classification` は変更しない。

例えばN=3で次の状態とする。

```text
A standard   終了済み
B standard   終了済み
C standard   終了済み
D additional 終了済み
E additional 未開始
```

Aを後から欠席とした場合:

```text
A 分類対象外  ← A自身の実効classificationだけ変更
B standard    ← 過去の自動分類を維持
C standard    ← 過去の自動分類を維持
D additional  ← 遡ってstandardにしない
E standard    ← 空いた自動標準枠を未来へ反映
```

同様にAの欠席を解除した場合、Aは保持済み自動分類に基づきstandardへ戻る。消費済み自動標準枠が増えるため、必要ならE等の未開始Reservationだけを再分類する。

### 9.5 ReservationClassificationOverride

管理者が特定Reservationの標準／追加区分を明示指定した場合、その明示指定を別Entityとして保持する。

```text
StudentReservation 1 ───── 0..1 ReservationClassificationOverride
```

最小論理属性:

- `reservation_id` — 対象Reservation。UNIQUE
- `classification` — `standard` または `additional`
- `changed_at`
- `changed_by`

Overrideが存在する場合、その値を対象Reservationの `automatic_classification` より優先し、算入対象である間は `StudentReservation.classification` へ実効値として反映する。

**ClassificationOverrideは対象Reservationだけに作用し、automatic_classification、消費済み自動標準枠、他Reservationの自動分類を変更しない。**

したがって、自動standardに加えて、additionalからstandardへOverrideされたReservationが存在することがある。この状態は「標準回数を超過した」のではなく、**「自動standardに、管理者が認めた例外standardが加わっている」**と解釈する。

例: N = 3、Dが4件目の場合

```text
automatic_classification
A → standard
B → standard
C → standard
D → additional

D に ClassificationOverride = standard を設定

実効classification
A → standard  （自動standard）
B → standard  （自動standard）
C → standard  （自動standard）
D → standard  （例外standard）
```

DのOverrideは自動標準枠を消費しない。

対象Reservationがキャンセル・欠席・月間算入除外によって分類対象外となった場合でも、`ReservationClassificationOverride` 自体は明示的に解除されるまで保持する。この間、`classification` はNULLだが、Overrideに表された管理者の意思は失わない。

開始済みReservationを後からstandard/additionalへ変更する必要がある場合も、自動再分類ではなくClassificationOverrideとして明示的に実施し、監査する。これによって他Reservationを連鎖的に再分類しない。

Overrideを解除した場合、算入対象なら `classification` を保持済み `automatic_classification` へ戻す。Override解除だけを理由に他Reservationのautomatic_classificationを変更しない。

区分変更前後、Actor、日時はAuditLogへ記録する。

### 9.6 自動分類を再計算する入力

未開始Reservationの自動分類再計算を引き起こす代表例は次のとおり。

- Reservationの新規成立
- 生徒キャンセル／スクール都合キャンセル
- 欠席の設定・解除
- `ReservationMonthlyCountOverride` の設定・解除
- `StudentMonthlyLessonConfig.standard_count` の変更
- 時刻経過により、再計算時点で一部ReservationがLesson開始境界を越えていること

`ReservationClassificationOverride` の設定・変更・解除は、自動分類の入力条件そのものではない。

## 10. SchoolCancellationDetail

スクール都合キャンセル固有の情報を `SchoolCancellationDetail` として保持する。

```text
StudentReservation 1 ───── 0..1 SchoolCancellationDetail
```

最小論理属性:

- `reservation_id` — 対象Reservation。UNIQUE
- `reason_category`
- `comment` — 任意補足。ただし理由が「その他」の場合は必須

理由カテゴリは要求仕様に従い、少なくとも次を持つ。

- 講師都合
- 臨時休業
- 設備・会場都合
- 災害・交通事情
- その他

`SchoolCancellationDetail` が存在する場合、対象Reservationは `school_cancelled` でなければならない。逆に `school_cancelled` のReservationには理由詳細を必須とする。

## 11. StudentMonthlyLessonConfig

### 11.1 決定

生徒・月単位の標準レッスン回数はReservationとは別の `StudentMonthlyLessonConfig` として管理する。

```text
Student 1 ───── 0..* StudentMonthlyLessonConfig
ScheduleMonth 1 ───── 0..* StudentMonthlyLessonConfig
```

最小論理属性:

- `student_id`
- `schedule_month_id`
- `standard_count`
- `updated_at`
- `updated_by`

論理的一意性:

```text
UNIQUE(student_id, schedule_month_id)
```

初期既定値は3回とする。個別設定が存在しない生徒・月では既定値3回を適用し、管理者が変更した月について個別設定を保持する方式を基本とする。

ここで `standard_count` は「自動分類でstandardを割り当てる基準数」であり、ClassificationOverride適用後の実効standard件数に対する上限ではない。また開始済みReservationの自動分類を遡及変更してN件に合わせるための値でもない。

標準回数変更前には、開始済みReservationの自動分類が維持されることと、変更によって影響する未開始Reservationの分類変化をプレビューする。確定後は開始済みを変更せず、未開始Reservationだけを再分類する。

## 12. 状態組み合わせと整合性

代表的な組み合わせは次のとおり。

| Reservation lifecycle | Absence | MonthlyCountOverride | automatic_classification | classification | 意味 |
| --- | --- | --- | --- | --- | --- |
| confirmed | なし | なし | standard / additional | standard / additional | 通常の非キャンセル・算入対象Reservation |
| confirmed | あり | なし | 保持 | 分類対象外（NULL） | 欠席・算入対象外 |
| confirmed | なし | excluded | 保持 | 分類対象外（NULL） | 管理者除外・算入対象外 |
| student_cancelled | なし | 任意 | 保持 | 分類対象外（NULL） | 生徒キャンセル・算入対象外 |
| school_cancelled | なし | 任意 | 保持 | 分類対象外（NULL） | スクール都合キャンセル・算入対象外 |

次を不正状態として扱う。

- キャンセル済みReservationへ `ReservationAbsence` を設定する。
- `school_cancelled` なのに `SchoolCancellationDetail` が存在しない。
- `SchoolCancellationDetail` が存在するのにReservationが `school_cancelled` ではない。
- `SlotOccupancy` がキャンセル済みReservationを現在占有として参照する。
- 月間算入対象外Reservationにstandard / additionalの実効classificationを保持する。
- 月間算入対象ReservationのclassificationがNULLのまま確定状態になる。
- 開始済みReservationの `automatic_classification` を通常の自動再分類処理で変更する。
- `ReservationClassificationOverride` が対象Reservation以外の実効classificationを直接書き換える。

`ReservationMonthlyCountOverride` と `ReservationClassificationOverride` は意味上独立した例外として保持する。前者は未開始Reservationの自動分類対象集合や、開始済み自動standardの消費数を変化させ得る。後者は対象Reservationの実効区分だけを変更し、自動標準枠には影響しない。

## 13. AdminHold / GroupLessonとの関係

`SlotOccupancy` は生徒予約専用ではない。

```text
LessonSlot
  └─ 0..1 SlotOccupancy
       ├─ student_reservation -> StudentReservation
       ├─ admin_hold          -> AdminHold
       └─ group_lesson        -> GroupLesson
```

現在の占有種別は1つだけであり、異なる占有種別を同時に成立させない。

## 14. Transaction上の原則

- Reservation作成と現在占有確保は同一の論理Transaction境界で整合させる。
- Reservation作成時には、その月の最新状態で `automatic_classification` と実効classificationを確定する。
- 枠再開放を伴うキャンセルではReservation状態変更とSlotOccupancy解放を同一の論理Transaction境界で整合させる。
- スクール都合キャンセルではReservation状態、`SchoolCancellationDetail`、SlotOccupancy／LessonSlot変更を一連の業務操作として整合させる。
- 月間算入条件や標準回数が変化した場合、開始済みReservationの `automatic_classification` は保持したまま、消費済み自動標準枠の再評価と未開始Reservationの再分類を同じ確定操作の整合範囲で扱う。
- 分類対象外への遷移では、対象ReservationのclassificationをNULLへ更新する処理も同じ確定操作の整合範囲で扱う。
- ClassificationOverrideの設定・変更・解除では、対象Reservationの実効classification更新と監査記録を整合させるが、Overrideのみを理由に他Reservationの自動分類を組み替えない。
- Commit直前に最新の予約状態、算入状態、標準回数、Lesson開始時刻境界を再検証し、先行Commitを無言で上書きしない。

具体的なD1制約、Transaction API、再計算のロック／競合エラー処理は `BookingAndConcurrency` 設計で確定する。

## 15. 主要整合性条件

- `StudentReservation.lesson_slot_id`、`student_id` は必須とする。
- 同じ `LessonSlot` を参照するReservation履歴は複数存在してよい。
- `StudentReservation.status = confirmed` は予約の実施前後では変化せず、キャンセルされていないことを表す。
- `StudentReservation.automatic_classification` は `standard` または `additional` とする。
- 開始済みReservationの `automatic_classification` は通常の自動再分類では変更しない。
- 月間算入対象Reservationの `StudentReservation.classification` は `standard` または `additional` とする。
- 月間算入対象外Reservationの `StudentReservation.classification` はNULLとする。
- ClassificationOverrideがない算入対象Reservationでは `classification = automatic_classification` とする。
- ClassificationOverrideがある算入対象Reservationでは `classification = ReservationClassificationOverride.classification` とする。
- `SlotOccupancy.slot_id` はUNIQUEとする。
- `occupancy_type = student_reservation` の場合は `reservation_id` を必須とする。
- `SlotOccupancy.reservation_id` が参照するReservationの `lesson_slot_id` は `SlotOccupancy.slot_id` と一致しなければならない。
- キャンセル済みReservationを現在占有として参照しない。
- `ReservationAbsence.reservation_id` はUNIQUEとする。
- `ReservationMonthlyCountOverride.reservation_id` はUNIQUEとする。
- `ReservationClassificationOverride.reservation_id` はUNIQUEとする。
- `SchoolCancellationDetail.reservation_id` はUNIQUEとする。
- `StudentMonthlyLessonConfig` は `(student_id, schedule_month_id)` でUNIQUEとする。

## 16. 関連要求・方針

- POL-008 競合時の確定状態優先
- POL-009 業務上異なる意味を別の状態として扱う
- POL-010 既定ルールと例外を分離する
- POL-013 重要な管理操作の説明性と監査可能性
- BR-051 二重予約禁止
- BR-054 キャンセル後の枠
- BR-056 月間標準回数
- BR-057 追加レッスン分類
- BR-058 自動再分類
- BR-059 明示Override優先
- BR-060 月間回数除外
- BR-061 欠席
- BR-063 スクール都合キャンセル
- BR-064 予約済み枠の休業化
- BR-066 予約状態と月間算入の分離
- REQ-003 予約
- REQ-004 生徒キャンセル
- REQ-005 予約履歴
- REQ-104 標準／追加区分変更通知
- REQ-307 月間標準回数設定
- REQ-308 月間回数除外
- REQ-309 標準／追加再分類
- REQ-310 区分Override
- REQ-313 スクール都合キャンセル
- REQ-315 欠席記録
- REQ-911 競合・整合性

## 17. Open Item

- `OI-BD-001` — 予約履歴と現在占有の分離。確定・反映済み。
- `OI-BD-002` — Reservationの状態・月間算入・区分Overrideの分離。確定・反映済み。
- `OI-BD-003` — Reservation非算入時のclassificationとライフサイクル意味。確定・反映済み。
- `OI-BD-004` — 過去Reservationのclassification自動再計算を行わない境界。Lesson開始時刻を確定境界として確定・反映済み。
