# 単一予約 D1物理設計・Transaction Guard

## 1. 範囲と前提

`01_StudentReservationApplication.md` の4 EndpointのRepository Adapterを対象とする。wire、分類規則、通知義務は同書、`../10_basic_design/04_ReservationModel.md`、`../10_basic_design/05_BookingAndConcurrency.md` §3〜5・§13を正とする。本書の物理名はlower_snake_case、IDはWorker生成のopaque TEXT、時刻はUTC Unix秒のINTEGER、月は日本時間の暦月を表す`YYYY-MM` TEXTとする。API出力だけをAsia/TokyoのRFC 3339へ変換する。Unix秒は整数として比較し、開始境界は`T < starts_at`で判定する。D1のforeign key enforcementは既定で有効であることを前提とし、通常Query / Migrationを接続ごとの`PRAGMA foreign_keys = ON`設定に依存させない。ApplicationからenforcementをOFFへ切り替えない。FK違反は§3のMigration / integrity validationで検出する。

既存の`Student`、`StudentSecurityAccess`、Student Session / Accountの物理Schemaと、Confirmの同一Transaction内で最新Session / role / access / lifecycleを再照合する物理契約は#636で確定する。本設計の`students(id)`は認証基盤への参照契約であり、その他の認証物理列名を先取りしない。Guard Portは本人の有効Session、Student role、最新lifecycle / accessと予約操作可否を解決し、Confirmでは同じ正本をTransaction内で再照合する。ProductionおよびProduction相当の共有環境では、#636完了と認証Migrationへの接続確認を、予約Migration適用および予約Adapter有効化の必須条件とする。

#608のlocal / isolated test・操作評価では、#636完了前でも、同じGuard Port契約を満たすtest auth fixtureを先行利用し、隔離したEvaluation D1へ予約Schemaを適用してよい。fixtureはSession期限・失効、role、本人同一性、最新access / lifecycleと、それらの変更によるTransaction内Guard失敗を検証する。fixtureはProduction schema / authorizationの代替正本ではなく、隔離DBと試験用Adapterに限定し、Productionへ持ち込める認可迂回Endpoint、設定分岐、常時許可のGuardを導入しない。

## 2. Table、制約、Index

以下は予約価値単位で必要な列とDDL形。`students(id)`へのFKを含む。`schedule_months`と`lesson_slots`の年月・日時整合は作成／変更CommandのGuardでも検証する。予約Adapterは不整合を見つけたら`INTEGRITY_STATE_UNAVAILABLE`とし、補正しない。

```sql
CREATE TABLE schedule_months (
  id TEXT PRIMARY KEY, month_key TEXT NOT NULL UNIQUE,
  published_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND
         substr(month_key, 6, 2) BETWEEN '01' AND '12')
);
CREATE TABLE lesson_slots (
  id TEXT PRIMARY KEY, schedule_month_id TEXT NOT NULL REFERENCES schedule_months(id),
  lesson_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('enabled','disabled')),
  UNIQUE(schedule_month_id, lesson_date, start_time),
  UNIQUE(id, schedule_month_id), CHECK (starts_at < ends_at)
);
CREATE INDEX ix_slots_month_start ON lesson_slots(schedule_month_id, starts_at, id);

CREATE TABLE student_monthly_lesson_configs (
  student_id TEXT NOT NULL REFERENCES students(id), schedule_month_id TEXT NOT NULL REFERENCES schedule_months(id),
  standard_count INTEGER NOT NULL CHECK (standard_count >= 0),
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  PRIMARY KEY(student_id, schedule_month_id)
);
CREATE TABLE student_reservations (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
  lesson_slot_id TEXT NOT NULL REFERENCES lesson_slots(id),
  status TEXT NOT NULL CHECK (status IN ('confirmed','student_cancelled','school_cancelled','system_cancelled')),
  automatic_classification TEXT NOT NULL CHECK (automatic_classification IN ('standard','additional')),
  classification TEXT CHECK (classification IN ('standard','additional')),
  created_at INTEGER NOT NULL, cancelled_at INTEGER, updated_at INTEGER NOT NULL,
  UNIQUE(id, lesson_slot_id),
  CHECK ((status = 'confirmed' AND cancelled_at IS NULL) OR
         (status <> 'confirmed' AND cancelled_at IS NOT NULL))
);
CREATE INDEX ix_reservations_student_slot ON student_reservations(student_id, lesson_slot_id);
CREATE INDEX ix_reservations_slot ON student_reservations(lesson_slot_id);
CREATE TABLE reservation_absences (
  reservation_id TEXT PRIMARY KEY REFERENCES student_reservations(id),
  recorded_at INTEGER NOT NULL, recorded_by TEXT NOT NULL
);
CREATE TABLE reservation_monthly_count_overrides (
  reservation_id TEXT PRIMARY KEY REFERENCES student_reservations(id),
  override_mode TEXT NOT NULL CHECK (override_mode = 'excluded'),
  changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL
);
CREATE TABLE reservation_classification_overrides (
  reservation_id TEXT PRIMARY KEY REFERENCES student_reservations(id),
  classification TEXT NOT NULL CHECK (classification IN ('standard','additional')),
  changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL
);

CREATE TABLE slot_occupancies (
  id TEXT PRIMARY KEY, slot_id TEXT NOT NULL UNIQUE REFERENCES lesson_slots(id),
  occupancy_type TEXT NOT NULL CHECK (occupancy_type IN ('student_reservation','admin_hold','group_lesson')),
  reservation_id TEXT UNIQUE, created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY(reservation_id, slot_id) REFERENCES student_reservations(id, lesson_slot_id),
  CHECK ((occupancy_type = 'student_reservation' AND reservation_id IS NOT NULL) OR
         (occupancy_type <> 'student_reservation' AND reservation_id IS NULL))
);

CREATE TABLE business_audit_logs (
  id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, action TEXT NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  before_json TEXT, after_json TEXT, result TEXT NOT NULL CHECK (result = 'committed')
);
CREATE INDEX ix_audit_retention ON business_audit_logs(occurred_at);
CREATE TABLE notification_intents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('reservation_confirmation','classification_change')),
  recipient_student_id TEXT NOT NULL REFERENCES students(id),
  reservation_id TEXT NOT NULL REFERENCES student_reservations(id),
  occurred_at INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  obligation_state TEXT NOT NULL DEFAULT 'valid' CHECK (obligation_state IN ('valid','expired')),
  expired_at INTEGER, expiry_reason TEXT,
  CHECK ((obligation_state = 'valid' AND expired_at IS NULL AND expiry_reason IS NULL) OR
         (obligation_state = 'expired' AND expired_at IS NOT NULL AND expiry_reason IS NOT NULL))
);
CREATE TABLE notification_outbox (
  intent_id TEXT PRIMARY KEY REFERENCES notification_intents(id),
  due_at INTEGER NOT NULL, claim_token TEXT, claim_until INTEGER,
  CHECK ((claim_token IS NULL AND claim_until IS NULL) OR (claim_token IS NOT NULL AND claim_until IS NOT NULL))
);
CREATE INDEX ix_outbox_due ON notification_outbox(due_at, intent_id);
CREATE INDEX ix_intents_student ON notification_intents(recipient_student_id, occurred_at);
CREATE UNIQUE INDEX ux_single_confirmation ON notification_intents(reservation_id) WHERE kind = 'reservation_confirmation';
CREATE TABLE command_guards (
  id TEXT PRIMARY KEY, captured_at INTEGER NOT NULL, expected_read_set TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1)
);
```

`StudentReservation`は同一Slotの取消履歴を複数保持できる。`slot_occupancies.slot_id UNIQUE`だけが現在占有の最終一意Guardであり、`reservation_id`の複合FKがSlot一致を保証する。`confirmed`が現在占有を持つべき未来枠、占有先のstatus、非算入時のNULL分類、`month_key`と日時の一致、AdminHold / GroupLesson詳細の有無は複数行条件なのでCommand GuardとIntegrity Scanで検査する。未実装の管理Commandが詳細行を欠いた占有を作ってよい意味ではない。`created_by`は予約時はGuardが解決したStudent actor ID、管理占有では管理actor IDとする。

`student_monthly_lesson_configs.updated_by`は`04_ReservationModel.md` §12.1の設定更新主体を保持するopaque TEXTの管理者Actor IDとし、認証済み管理者Guardが解決した値を保存する。氏名・emailやClient指定値を用いず、管理者認証物理Schemaが本書の対象外であるためFKは設けない。個別設定行がなければ既定3を導出し、既定値のためだけにActor不明の行を作らない。

`business_audit_logs`は予約Confirmの成功監査を同一Transactionに保存し、失敗の技術Logを混ぜない。`payload_json`は送信に必要な確定事実だけを保持する。予約確認は新規ReservationのID・日時・確定時分類、区分変更は既存ReservationのID・日時・before / afterを持つ。月間回数、料金、email、氏名は含めない。`notification_intents`は論理宛先、`notification_outbox`は初回配送pickupのdurable workであり、実宛先・Provider結果・Delivery Attemptは後続のDelivery詳細設計側へ分離する。

単一予約ConfirmのAuditは1業務Commandにつき1行とし、`target_type = 'student_reservation'`、`target_id = 新規Reservation ID`、`before_json = NULL`とする。`after_json`はversion 1のJSON objectとして`{"version":1,"reservation":{"id":"…","automatic_classification":"standard","classification":"standard"},"derived_changes":[]}`の形で保存する。`derived_changes`には同一Commandで自動分類または実効分類を更新した**全既存Reservation**について、`reservation_id`、`before` / `after`（各objectに`automatic_classification`と`classification`）を含め、Slotの`starts_at, reservation.id`順に固定する。実効分類がOverrideで維持され自動分類だけが変わる場合も含め、変更なしは`[]`とする。§5の検証済みplanから同じbatchへ保存し、予約成立Auditから派生変更の対象・変更前後・因果関係を追跡できるようにする。氏名・email・月間回数・料金を複製しない。

論理→物理の対応は`ScheduleMonth → schedule_months`（`year` / `month`は`month_key`へ一意符号化）、`LessonSlot → lesson_slots`、`StudentMonthlyLessonConfig → student_monthly_lesson_configs`、`StudentReservation → student_reservations`、`SlotOccupancy → slot_occupancies`、3例外Entity → 同名の`reservation_*` Table、`AuditLog → business_audit_logs`、`NotificationIntent → notification_intents`である。`notification_outbox`と`command_guards`は業務Entityではなく配送／Transaction内部の物理補助Tableである。

## 3. Migration順序

`migrations/`のversioned fileを番号順に一度だけ適用し、適用済みファイルを書き換えない。予約価値単位の導入順は (1) 認証基盤の`students(id)`とGuard Portの正本、(2) `schedule_months`・`lesson_slots`、(3) `student_monthly_lesson_configs`・`student_reservations`・3例外Table、(4) `slot_occupancies`、(5) `business_audit_logs`・`notification_intents`・`notification_outbox`、(6) `command_guards`、(7) 上記Index、(8) FK確認・Integrity Queryの順。各段階を別の単調増加versionにし、依存関係を逆転させない。既存データがある環境ではFK確認、月／日時整合、現在占有一意性、未来confirmedと占有の一致を検証してからAdapterを公開する。違反を自動修復してMigration成功扱いにしない。後続のcancel / admin機能はこのSchemaを拡張し、既存制約を弱めず、移行とCommandを同時に設計する。

導入順(1)の認証基盤への接続条件と隔離試験fixtureの境界は§1を正本とする。Migration / integrity validationでは環境を問わず`PRAGMA foreign_key_check`が0行であることを確認し、違反または検証不能なら適用完了・Adapter公開へ進まない。月CHECKは`01`〜`12`をDBで保証し、`lesson_date`の所属月およびUTCの`starts_at / ends_at`との多列整合は引き続きCommand Guard / Integrity Queryで検証する。

## 4. Read setとQuery

Schedule Queryは公開済み`month_key`から`ix_slots_month_start`でSlotを日時・ID順に読み、`slot_occupancies.slot_id`へLEFT JOINする。生徒占有のときだけ`student_reservations.id, student_id, status, classification`を参照し、本人の`reserved_by_me`を判定する。未来の不整合占有を空きとして扱わない。PreviewはSlot IDのPK、月のPK、Occupancyのslot UNIQUEと本人月間Reservationを読む。本人月間Reservationは`ix_reservations_student_slot`から本人候補を絞りSlot PK Joinで月を選ぶ。実行計画上この経路が不足する規模に達した場合だけ月索引／非正規化を追加する。

Expected State Token v1のcanonical read setは、Guardが解決したstudent ID、対象Slot・月の全予約可否列、公開時刻、現在占有の種別と参照先、対象生徒の現在の予約操作可否、標準回数行（欠損は既定3）、同一生徒・同一月の**全**ReservationのID・Slot日時・status・自動／実効分類・欠席・回数除外・分類Overrideを含む。集合は`starts_at, reservation.id`順に固定し、欠損とNULLを区別する。これから`04_ReservationModel.md` §9に従い、開始済み算入自動standard数、未開始算入集合、新規分類、各既存未開始Reservationのbefore / afterを計算する。Tokenはこのraw read setと計算結果をfield順・型・時刻表現を固定したJSONへcanonical化し、`v1.`+SHA-256 base64url fingerprintにする。内部JSONをwireへ出さない。時刻そのものではなく、対象と本人月間Reservationごとの`T < starts_at`判定を入れるため、同じ業務状態・同じ開始境界でtokenは同じになる。

予約履歴は`student_reservations`を本人IDで絞り、Slot PK Joinから日時を得る。`ORDER BY starts_at DESC, reservation.id DESC`で`limit + 1`件を取り、次Pageは`(starts_at < ? OR (starts_at = ? AND reservation.id < ?))`を加える。cursorにはversion、本人ID、最後の内部sort keyを署名付きopaque値として格納し、別本人・改ざん・不正versionを拒否する。表示時の欠席は`reservation_absences`、分類対象外はNULLから導出する。`ix_reservations_student_slot`とSlot PKを初期経路とし、日時順のsort costをローカル実行計画で検証する。必要なら日時の正本を保ったままmaterialized keyを移行で追加する。

ローカルSQLiteの`EXPLAIN QUERY PLAN`では、Scheduleは`month_key` UNIQUEと`ix_slots_month_start`、履歴は`ix_reservations_student_slot`とSlot PKを使用し、履歴の日時順には一時sortが残る。初期約20生徒の本人候補集合に対するsortとして許容し、実データ規模で再測定する。履歴のためだけにSlot日時をReservationへ重複保存しない。

## 5. ConfirmのD1 batch

`DB.withSession('first-primary')`でPrimary起点のSessionを作る。Previewおよび事前準備SELECTは同じcanonical read-set queryを使い、D1の`CAST(strftime('%s','now') AS INTEGER)`を同じSELECTの時刻引数`T0`として取得する。Workerはその結果から分類planと必要なIntent payloadを作る。Confirmではrequest tokenの形式／versionを検証し、本人・Slot・事前read setから再生成したtokenと比較する。ここで不一致なら409とし、D1書込みを開始しない。この事前SELECTはCommit判定ではない。

Prepared Statementだけからなる**1回の**`session.batch([...])`に次を順序どおり渡す。`BEGIN` / `COMMIT`文字列を送らない。各Guardは0件の条件付きUPDATEで済ませず、`command_guards.ok CHECK(ok = 1)`違反としてbatch全体を失敗させる。

1. `command_guards`へcommand ID、`CAST(strftime('%s','now') AS INTEGER)`の`T`、事前raw read set、`ok = 1`をINSERTする。ID衝突は障害として扱い、再利用しない。
2. その行を`UPDATE`し、`ok = CASE WHEN (同一canonical read-set SQLを現在のD1状態とGuard行のTで再実行した結果 = expected_read_set) AND (最新Session/Student access・lifecycleが有効) AND (対象は公開済み・enabled・非占有・T < starts_at) AND (未来Slot Invariantが成立) THEN 1 ELSE 0 END`とする。read-set SQLはPreview用と単一実装とし、JSON配列の行順を明示して正規化する。時刻境界によるplan差異も比較対象に含める。分類planの計算結果は事前read setが一致した場合だけ有効となる。
3. `student_reservations`へ新規confirmed行をINSERT。`student_id`はRequestではなくGuard結果をbindし、分類はplanの新規値、時刻はGuard行のTをSELECTして設定する。
4. `slot_occupancies`へstudent_reservation占有をINSERT。`slot_id UNIQUE`および複合FK違反は全体Rollback。先行占有を上書きするUPSERTは使用しない。
5. planに列挙した既存未開始ReservationをIDごとに`UPDATE ... WHERE student_id = ? AND status = 'confirmed' AND automatic_classification = ? AND classification IS ? AND (SELECT starts_at FROM lesson_slots WHERE id = lesson_slot_id) > (SELECT captured_at FROM command_guards WHERE id = ?)`で更新する。NULL可の`classification`の変更前値・最終値のGuard比較には`IS ?`によるNULL安全な比較を用い、NOT NULLの`automatic_classification`には通常の`= ?`を用いる。Overrideは保持し、実効値はplanで計算した結果とする。集合UPDATEまたは固定順のprepared statementsとし、後続Guardでplan中の全IDと最終値を照合する。変更なしなら書き込まない。
6. `business_audit_logs`を1件INSERTし、Actor、予約対象、確定時刻、§2の新規予約と`derived_changes`を含む`after_json`を記録する。`notification_intents`へ予約確認を1件、実効分類が両方向のstandard/additional間で変わった既存Reservationごとに区分変更を1件INSERTし、各Intentと同じIDの`notification_outbox`をINSERTする。新規予約に区分変更Intentを作らない。必要件数／payloadをplanから固定し、どのINSERT失敗もbatch全体をRollbackする。
7. 最終Guardを`UPDATE command_guards SET ok = CASE WHEN ... THEN 1 ELSE 0 END`で実行する。検査対象は、対象Slotがまだ同じ占有を指すこと、plan中の各Reservationの最終分類、事前生成したIDによるAudit 1件・Intentとoutbox必要件数、最新本人権限、`CAST(strftime('%s','now') AS INTEGER) <`対象Slotとplan中で未開始扱いした各Slotの`starts_at`。最終時刻検査でLesson開始境界を越えたbatchはRollbackする。`T`は同一Commandの全保存時刻・分類基準として維持する。
8. Guard行をDELETEしてbatchを正常終了する。D1のatomic batch成功だけを`201`とする。`201`のViewは確定済みplanから生成し、曖昧なbatch応答では再実行せずPrimaryを再読込する。

read-set比較に使うSQLは、対象月行、Slot、Occupancy、本人月間Reservationと各例外をPK / FK Joinし、`json_object` / `json_group_array`へ**明示した安定順**で直列化する。事前readとbatch Guardは同一SQL template・同一bind順を使用し、Guard行のTだけを時刻引数へ渡す。HashはWorkerで計算するが、DB Guardはhashだけを比較せずcanonical raw JSON全体を比較する。生徒・月の別Slotへの同時予約、公開／availability変更、Nや欠席・Override変更もread-set差としてGuard失敗になる。Guard SQL、INSERT、UPDATEのいずれかで失敗したbatchにReservation・Occupancy・再分類・Audit・Intentの部分Commitを認めない。

## 6. エラー境界と配送pickup

Guardのread-set不一致、最終時刻Guard、`slot_occupancies.slot_id UNIQUE`の既知競合はRollback後のPrimary再読込により、`01_StudentReservationApplication.md` §8の`RESERVATION_STATE_CHANGED`、`RESERVATION_NOT_AVAILABLE`、`RESERVATION_WINDOW_CLOSED`へ安全に変換する。Preview前から不成立なら同書の初期拒否規則を使う。未知のConstraint / FK / CHECK、更新件数不一致、未来Slot invariant異常は競合と決めつけず`INTEGRITY_STATE_UNAVAILABLE`またはD1障害なら`SERVICE_UNAVAILABLE`とする。生SQL、Table名、他生徒情報は公開しない。Rollback後のreadも失敗すれば503とし、409の最新Viewを推測で作らない。

正常Commit後にのみdeliveryをkickする。初回pickup対象は`notification_outbox.due_at <= now`かつleaseなし／期限切れで、対応Intentの`obligation_state = valid`を再検証する。5分周期のRecoveryも同じ索引を使い再発見する。claim時に最新の通知義務と宛先を再検証し、lease / fencing付きの別TransactionでDelivery Attemptをdurableに生成してoutboxを消費する。claim後の再発見はAttempt側のRecovery責務とする。Provider call中はD1 Transactionを保持しない。Provider受理・結果不明・手動再送のAttempt詳細は`05_BookingAndConcurrency.md` §13に従う後続Delivery詳細設計#637の責務であり、本予約Confirmの成功判定に含めない。

初回pickupは別batchで`UPDATE notification_outbox SET claim_token = ?, claim_until = ? WHERE intent_id = ? AND due_at <= ? AND (claim_until IS NULL OR claim_until < ?)`を実行し、直後に`INSERT INTO command_guards(id,captured_at,expected_read_set,ok) VALUES (?, ?, '', CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`でCHECK違反を強制する。正常終了前にそのGuard行を削除する。同じbatchで最新Intent・宛先をGuardし、安定したAttempt IDを作成してから`DELETE ... WHERE intent_id = ? AND claim_token = ?`する。どれかが不成立ならclaim / Attempt / outbox消費を全Rollbackする。後続Attemptの結果更新ではそのAttemptのfencing tokenを照合し、古いworkerの更新を拒否する。#637でDelivery Attempt schema、stable identity、claim / lease / fencing、結果不明・retry・Recovery境界が確定するまで、実Provider Delivery Adapterを実装・Production有効化せず、pickup / Attempt / lease / fencingのProduction有効化も行わない。#608のProvider Stubによる隔離評価は先行可能とする。

Cloudflare D1実環境でのFK enforcement / `PRAGMA foreign_key_check`、Server時刻、`withSession("first-primary").batch()`のGuard失敗時の原子性は未検証であり、#536のD1検証経路で確認する。ローカルSQLiteの結果を正式なD1実環境証跡とせず、予約Applicationの統合検証およびProduction相当環境でのAdapter有効化より前に検証を完了し、失敗時は有効化を停止する。本Issueは詳細設計文書のみを変更し、予約Migration / Production Adapter / 実Provider Deliveryを有効化しないため、#636 / #637 / #536の残存責務と実施順序はIssue #611本文の`Scope-out impact and follow-up`を正本とする。

## 7. Traceability

| 設計 | 要求・基本設計 | 確認観点 |
| --- | --- | --- |
| §2〜4 Slot / Preview / 履歴 | REQ-001 / 002 / 003 / 005、BR-015 / 017 / 050〜059 / 066〜068、AC-001 / 002 / 003 / 005 | 公開・占有View、本人月間分類、取消履歴と安定Page |
| §5 原子的Confirm | POL-003 / 008、REQ-003 / 911 / 940、AC-003-005〜007 / 016〜021、AC-911-001〜002、AC-940-001〜005 | Guard失敗で全Rollback、Actorと時刻、再分類 |
| §2 設定主体・派生変更監査 | BR-056 / 058 / 132、REQ-940、AC-940-001〜002、`04_ReservationModel.md` §12.1、`05_BookingAndConcurrency.md` §12.2 | `updated_by` mapping、予約成立Auditから全再分類before / afterを追跡 |
| §1・§3・§5 認証Guard接続 | BR-068 / 099 / 123、AC-003-019〜020 / AC-207-003 / AC-211-001〜003、`05_BookingAndConcurrency.md` §3.8 | §1の認証Guard接続・隔離試験fixture境界を参照し、同一Transactionで最新認証状態を再照合 |
| §2・§5〜6 通知 | REQ-101 / 104 / 914、BR-112 / 115 / 133、AC-101-001〜002 / AC-104-001〜003 / AC-914-004〜005 | 必須Intent同一Commit、配送分離、安全なError |

既存のPOL→BR→REQ→AC→TCは変更しない。要求ベース試験は`../40_test/02_FunctionalTestSpecification.md`、`03_NonFunctionalTestSpecification.md`と`04_RequirementsTestTraceability.md`を参照する。OOS-001 / 002を維持し、料金、管理者代理予約、Bulk / cancel / admin Commandの物理詳細を導入しない。
