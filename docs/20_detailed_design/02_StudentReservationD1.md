# 生徒予約・認証 D1物理設計・Transaction Guard

## 1. 範囲と前提

`01_StudentReservationApplication.md` の4予約EndpointのRepository Adapterを対象とする。#840のStudent Provider Flow保存・Session発行合成は§9で定義する。wire、分類規則、通知義務は同書、`../10_basic_design/04_ReservationModel.md`、`../10_basic_design/05_BookingAndConcurrency.md` §3〜5・§13を正とする。本書の物理名はlower_snake_case、IDはWorker生成のopaque TEXT、時刻はUTC Unix秒のINTEGER、月は日本時間の暦月を表す`YYYY-MM` TEXTとする。API出力だけをAsia/TokyoのRFC 3339へ変換する。Unix秒は整数として比較し、開始境界は`T < starts_at`で判定する。D1のforeign key enforcementは既定で有効であることを前提とし、通常Query / Migrationを接続ごとの`PRAGMA foreign_keys = ON`設定に依存させない。ApplicationからenforcementをOFFへ切り替えない。FK違反は§3のMigration / integrity validationで検出する。

`Student`、`StudentSecurityAccess`、Student Session / Accountの認証物理契約は#636により本書§8で確定する。`students(id)`は予約FKのProduction接続点である。Guard Portは本人の有効Session、Student role、最新lifecycle / accessと予約操作可否を解決し、Confirmでは§8.3の同じ正本をTransaction内で再照合する。ProductionおよびProduction相当の共有環境での予約Migration適用・予約Adapter有効化条件は§8.6を正とする。#611 / #636は詳細設計のみであり、後続#841の認証基盤migration実装は§8.6を参照する。auth Adapter / routeは未接続とする。

#608のlocal / isolated test・操作評価では、同じGuard Port契約を満たすtest auth fixtureを利用し、隔離したEvaluation D1へ予約Schemaを適用してよい。fixtureとProduction adapterの境界・検証範囲は§8.5を正とする。

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

CREATE TABLE admin_holds (
  occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id)
);
CREATE TABLE group_lessons (
  occupancy_id TEXT PRIMARY KEY REFERENCES slot_occupancies(id)
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

論理→物理の対応は`ScheduleMonth → schedule_months`（`year` / `month`は`month_key`へ一意符号化）、`LessonSlot → lesson_slots`、`StudentMonthlyLessonConfig → student_monthly_lesson_configs`、`StudentReservation → student_reservations`、`SlotOccupancy → slot_occupancies`、`AdminHold → admin_holds`、`GroupLesson → group_lessons`、3例外Entity → 同名の`reservation_*` Table、`AuditLog → business_audit_logs`、`NotificationIntent → notification_intents`である。`notification_outbox`と`command_guards`は業務Entityではなく配送／Transaction内部の物理補助Tableである。

### 2.1 AdminHold / GroupLessonの最小詳細参照契約（#834）

`../10_basic_design/02_DataModel.md` §4.6の1対1詳細を、Schedule Query read sliceに必要な`occupancy_id`だけで物理化する。各詳細のPKは同一Occupancyへの同種詳細の重複を禁止し、FKは存在しない`slot_occupancies.id`への参照を禁止する。表示名、講師、人数、理由等の個別属性および作成・更新Commandは定義せず、必要時に対応する管理機能の詳細設計で追加する。

型一致はDB単一制約だけでは保証しない。Schedule Query Repository / Integrity Scanは同じ`occupancy_id`について次を検査する。

| `occupancy_type` | Reservation参照 | `admin_holds` | `group_lessons` |
| --- | --- | --- | --- |
| `student_reservation` | 同じSlotの有効な`confirmed` Reservationを参照（既存契約） | 0件 | 0件 |
| `admin_hold` | `reservation_id IS NULL` | ちょうど1件 | 0件 |
| `group_lesson` | `reservation_id IS NULL` | 0件 | ちょうど1件 |

詳細欠落、type/detail不一致、両詳細存在は永続化Invariant異常である。未来Slot（`T < starts_at`）で検出した場合は`INTEGRITY_STATE_UNAVAILABLE`へfail-closedし、空き・AdminHold・GroupLessonを推測しない。開始済みSlotのApplication-level `unavailable`契約（#828）は維持し、新しいstarted-Slot error契約は追加しない。正常時の公開Viewは`01_StudentReservationApplication.md` §4を参照する。

以下は詳細一致と既存Reservation参照条件に違反する占有を列挙するIntegrity Query/Test contractである。正常時は0行であり、FK確認や他の月・日時・未来confirmedと占有の一致検査を代替しない。Schedule Queryでは対象Slot集合へ同じ条件を適用し、上記開始境界に従って判定する。結果の内部IDをwireへ公開しない。

```sql
SELECT o.slot_id, o.id AS occupancy_id
FROM slot_occupancies AS o
LEFT JOIN student_reservations AS r ON r.id = o.reservation_id
LEFT JOIN admin_holds AS ah ON ah.occupancy_id = o.id
LEFT JOIN group_lessons AS gl ON gl.occupancy_id = o.id
WHERE (o.occupancy_type = 'student_reservation' AND
       (r.id IS NULL OR r.status <> 'confirmed' OR r.lesson_slot_id <> o.slot_id OR
        ah.occupancy_id IS NOT NULL OR gl.occupancy_id IS NOT NULL))
   OR (o.occupancy_type = 'admin_hold' AND
       (o.reservation_id IS NOT NULL OR ah.occupancy_id IS NULL OR gl.occupancy_id IS NOT NULL))
   OR (o.occupancy_type = 'group_lesson' AND
       (o.reservation_id IS NOT NULL OR gl.occupancy_id IS NULL OR ah.occupancy_id IS NOT NULL))
ORDER BY o.slot_id, o.id;
```

#834の有効化範囲は本書の物理契約と`tests/fixtures/d1/migrations/0007_management_details.sql`のisolated test-only migrationまでとする。後続#867で確定済みの同じ詳細参照DDLをProduction `0010_management_details.sql`へ追加するが、Adapter / 管理Command / Production環境への有効化は行わない。#830 Schedule Query D1 Adapterは本契約を再利用する。

## 3. Migration順序

`migrations/`のversioned fileを番号順に一度だけ適用し、適用済みファイルを書き換えない。予約価値単位の導入順は (1) 認証基盤の`students(id)`とGuard Portの正本・共有`command_guards`、(2) `schedule_months`・`lesson_slots`、(3) `student_monthly_lesson_configs`・`student_reservations`・3例外Table、(4) `slot_occupancies`と依存作成後の§2.1詳細Table、(5) `business_audit_logs`・`notification_intents`・`notification_outbox`、(6) 作成済み共有`command_guards`の定義確認、(7) 上記Index、(8) FK確認・Integrity Queryの順。各段階を別の単調増加versionにし、依存関係を逆転させない。既存データがある環境ではFK確認、月／日時整合、現在占有一意性、未来confirmedと占有の一致を検証してからAdapterを公開する。違反を自動修復してMigration成功扱いにしない。後続のcancel / admin機能はこのSchemaを拡張し、既存制約を弱めず、移行とCommandを同時に設計する。

導入順(1)の認証基盤内の順序・接続条件は§8.6、隔離試験fixtureの境界は§8.5を正本とする。Migration / integrity validationでは環境を問わず`PRAGMA foreign_key_check`が0行であることを確認し、違反または検証不能なら適用完了・Adapter公開へ進まない。月CHECKは`01`〜`12`をDBで保証し、`lesson_date`の所属月およびUTCの`starts_at / ends_at`との多列整合は引き続きCommand Guard / Integrity Queryで検証する。

§2.1の詳細Tableは`slot_occupancies`作成後、Audit / Intent / Outboxより前に追加し、既存fixture migrationを書き換えない。詳細参照と型一致の検査もFK確認と合わせて行う。有効化境界は§2.1を正本とする。

#867のProduction実装は[`migrations/0007`〜`0012`](../../migrations/README.md)に依存順を保って分割する。
共有`command_guards`は既存`0006`を変更せず、[`validation/reservation.sql`](../../migrations/validation/reservation.sql)で定義を確認する。
同fileのread-only scansは意味ごとのstatementとして独立実行し、全scanの合計0行とFK / 認証scanの各0行を必須とする。巨大なcompound SELECTへ再結合せず、各scanは`{violation, entity_id}`形で返し、既存不整合を補完・修復しない。
検証範囲は[`tests/README.md`](../../tests/README.md)の#867を参照し、§8.6のactivation Gateは維持する。

## 4. Read setとQuery

Schedule Queryは公開済み`month_key`から`ix_slots_month_start`でSlotを日時・ID順に読み、`slot_occupancies.slot_id`へLEFT JOINする。生徒占有のときだけ`student_reservations.id, student_id, status, classification`を参照し、本人の`reserved_by_me`を判定する。未来の不整合占有を空きとして扱わない。PreviewはSlot IDのPK、月のPK、Occupancyのslot UNIQUEと本人月間Reservationを読む。本人月間Reservationは`ix_reservations_student_slot`から本人候補を絞りSlot PK Joinで月を選ぶ。実行計画上この経路が不足する規模に達した場合だけ月索引／非正規化を追加する。

Schedule Queryの詳細一致検査では、種別を問わず`admin_holds` / `group_lessons`の`occupancy_id` PKを現在占有のIDへLEFT JOINし、§2.1の必須・禁止条件を評価する。種別に対応する詳細だけを読むとwrong / both-detailを見逃すため、両Tableを検査する。

Expected State Token v1のcanonical read setは、Guardが解決したstudent ID、対象Slot・月の全予約可否列、公開時刻、現在占有の種別と参照先、対象生徒の現在の予約操作可否、標準回数行（欠損は既定3）、同一生徒・同一月の**全**ReservationのID・Slot日時・status・自動／実効分類・欠席・回数除外・分類Overrideを含む。集合は`starts_at, reservation.id`順に固定し、欠損とNULLを区別する。これから`04_ReservationModel.md` §9に従い、開始済み算入自動standard数、未開始算入集合、新規分類、各既存未開始Reservationのbefore / afterを計算する。Tokenはこのraw read setと計算結果をfield順・型・時刻表現を固定したJSONへcanonical化し、`v1.`+SHA-256 base64url fingerprintにする。内部JSONをwireへ出さない。時刻そのものではなく、対象と本人月間Reservationごとの`T < starts_at`判定を入れるため、同じ業務状態・同じ開始境界でtokenは同じになる。

予約履歴は`student_reservations`を本人IDで絞り、Slot PK Joinから日時を得る。`ORDER BY starts_at DESC, reservation.id DESC`で`limit + 1`件を取り、次Pageは`(starts_at < ? OR (starts_at = ? AND reservation.id < ?))`を加える。cursorにはversion、本人ID、最後の内部sort keyを署名付きopaque値として格納し、別本人・改ざん・不正versionを拒否する。表示時の欠席は`reservation_absences`、分類対象外はNULLから導出する。`ix_reservations_student_slot`とSlot PKを初期経路とし、日時順のsort costをローカル実行計画で検証する。必要なら日時の正本を保ったままmaterialized keyを移行で追加する。

ローカルSQLiteの`EXPLAIN QUERY PLAN`では、Scheduleは`month_key` UNIQUEと`ix_slots_month_start`、履歴は`ix_reservations_student_slot`とSlot PKを使用し、履歴の日時順には一時sortが残る。初期約20生徒の本人候補集合に対するsortとして許容し、実データ規模で再測定する。履歴のためだけにSlot日時をReservationへ重複保存しない。

## 5. ConfirmのD1 batch

`DB.withSession('first-primary')`でPrimary起点のSessionを作る。Previewおよび事前準備SELECTは同じcanonical read-set queryを使い、D1の`CAST(strftime('%s','now') AS INTEGER)`を同じSELECTの時刻引数`T0`として取得する。Workerはその結果から分類planと必要なIntent payloadを作る。Confirmではrequest tokenの形式／versionを検証し、本人・Slot・事前read setから再生成したtokenと比較する。ここで不一致なら409とし、D1書込みを開始しない。この事前SELECTはCommit判定ではない。

Prepared Statementだけからなる**1回の**`session.batch([...])`に次を順序どおり渡す。`BEGIN` / `COMMIT`文字列を送らない。各Guardは0件の条件付きUPDATEで済ませず、`command_guards.ok CHECK(ok = 1)`違反としてbatch全体を失敗させる。

1. `command_guards`へcommand ID、`CAST(strftime('%s','now') AS INTEGER)`の`T`、事前raw read set、`ok = 1`をINSERTする。ID衝突は障害として扱い、再利用しない。
2. その行を`UPDATE`し、`ok = CASE WHEN (同一canonical read-set SQLを現在のD1状態とGuard行のTで再実行した結果 = expected_read_set) AND (§8.3のStudent Write predicateが成立) AND (対象は公開済み・enabled・非占有・T < starts_at) AND (未来Slot Invariantが成立) THEN 1 ELSE 0 END`とする。read-set SQLはPreview用と単一実装とし、JSON配列の行順を明示して正規化する。時刻境界によるplan差異も比較対象に含める。分類planの計算結果は事前read setが一致した場合だけ有効となる。
3. `student_reservations`へ新規confirmed行をINSERT。`student_id`はRequestではなくGuard結果をbindし、分類はplanの新規値、時刻はGuard行のTをSELECTして設定する。
4. `slot_occupancies`へstudent_reservation占有をINSERT。`slot_id UNIQUE`および複合FK違反は全体Rollback。先行占有を上書きするUPSERTは使用しない。
5. planに列挙した既存未開始ReservationをIDごとに`UPDATE ... WHERE student_id = ? AND status = 'confirmed' AND automatic_classification = ? AND classification IS ? AND (SELECT starts_at FROM lesson_slots WHERE id = lesson_slot_id) > (SELECT captured_at FROM command_guards WHERE id = ?)`で更新する。NULL可の`classification`の変更前値・最終値のGuard比較には`IS ?`によるNULL安全な比較を用い、NOT NULLの`automatic_classification`には通常の`= ?`を用いる。Overrideは保持し、実効値はplanで計算した結果とする。集合UPDATEまたは固定順のprepared statementsとし、後続Guardでplan中の全IDと最終値を照合する。変更なしなら書き込まない。
6. `business_audit_logs`を1件INSERTし、Actor、予約対象、確定時刻、§2の新規予約と`derived_changes`を含む`after_json`を記録する。`notification_intents`へ予約確認を1件、実効分類が両方向のstandard/additional間で変わった既存Reservationごとに区分変更を1件INSERTし、各Intentと同じIDの`notification_outbox`をINSERTする。新規予約に区分変更Intentを作らない。必要件数／payloadをplanから固定し、どのINSERT失敗もbatch全体をRollbackする。
7. 最終Guardを`UPDATE command_guards SET ok = CASE WHEN ... THEN 1 ELSE 0 END`で実行する。検査対象は、対象Slotがまだ同じ占有を指すこと、plan中の各Reservationの最終分類、事前生成したIDによるAudit 1件・Intentとoutbox必要件数、§8.3のStudent Write predicate（最終D1時刻で再評価）、`CAST(strftime('%s','now') AS INTEGER) <`対象Slotとplan中で未開始扱いした各Slotの`starts_at`。最終時刻検査でLesson開始境界を越えたbatchはRollbackする。`T`は同一Commandの全保存時刻・分類基準として維持する。
8. Guard行をDELETEしてbatchを正常終了する。D1のatomic batch成功だけを`201`とする。`201`のViewは確定済みplanから生成し、曖昧なbatch応答では再実行せずPrimaryを再読込する。

read-set比較に使うSQLは、対象月行、Slot、Occupancy、本人月間Reservationと各例外をPK / FK Joinし、`json_object` / `json_group_array`へ**明示した安定順**で直列化する。事前readとbatch Guardは同一SQL template・同一bind順を使用し、Guard行のTだけを時刻引数へ渡す。HashはWorkerで計算するが、DB Guardはhashだけを比較せずcanonical raw JSON全体を比較する。生徒・月の別Slotへの同時予約、公開／availability変更、Nや欠席・Override変更もread-set差としてGuard失敗になる。Guard SQL、INSERT、UPDATEのいずれかで失敗したbatchにReservation・Occupancy・再分類・Audit・Intentの部分Commitを認めない。

## 6. エラー境界と配送pickup

認証Guard不成立ではRollback後に§8.3の順序で本人をPrimary再照合し、Session失効は401、認証済みだが操作権限なしは403とする。認証不成立時に予約の最新Viewを返さない。Guardのread-set不一致、最終時刻Guard、`slot_occupancies.slot_id UNIQUE`の既知競合はRollback後のPrimary再読込により、`01_StudentReservationApplication.md` §8の`RESERVATION_STATE_CHANGED`、`RESERVATION_NOT_AVAILABLE`、`RESERVATION_WINDOW_CLOSED`へ安全に変換する。Preview前から不成立なら同書の初期拒否規則を使う。未知のConstraint / FK / CHECK、更新件数不一致、未来Slot invariant異常は競合と決めつけず`INTEGRITY_STATE_UNAVAILABLE`またはD1障害なら`SERVICE_UNAVAILABLE`とする。生SQL、Table名、他生徒情報は公開しない。Rollback後のreadも失敗すれば503とし、409の最新Viewを推測で作らない。

正常Commit後にのみdeliveryをkickする。初回pickup対象は`notification_outbox.due_at <= now`かつleaseなし／期限切れで、対応Intentの`obligation_state = valid`を再検証する。5分周期のRecoveryも同じ索引を使い再発見する。claim時に最新の通知義務と宛先を再検証し、lease / fencing付きの別TransactionでDelivery Attemptをdurableに生成してoutboxを消費する。claim後の再発見はAttempt側のRecovery責務とする。Provider call中はD1 Transactionを保持しない。Provider受理・結果不明・手動再送のAttempt詳細は`05_BookingAndConcurrency.md` §13に従う後続Delivery詳細設計#637の責務であり、本予約Confirmの成功判定に含めない。

初回pickupは別batchで`UPDATE notification_outbox SET claim_token = ?, claim_until = ? WHERE intent_id = ? AND due_at <= ? AND (claim_until IS NULL OR claim_until < ?)`を実行し、直後に`INSERT INTO command_guards(id,captured_at,expected_read_set,ok) VALUES (?, ?, '', CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`でCHECK違反を強制する。正常終了前にそのGuard行を削除する。同じbatchで最新Intent・宛先をGuardし、安定したAttempt IDを作成してから`DELETE ... WHERE intent_id = ? AND claim_token = ?`する。どれかが不成立ならclaim / Attempt / outbox消費を全Rollbackする。後続Attemptの結果更新ではそのAttemptのfencing tokenを照合し、古いworkerの更新を拒否する。#637でDelivery Attempt schema、stable identity、claim / lease / fencing、結果不明・retry・Recovery境界が確定するまで、実Provider Delivery Adapterを実装・Production有効化せず、pickup / Attempt / lease / fencingのProduction有効化も行わない。#608のProvider Stubによる隔離評価は先行可能とする。

Cloudflare D1実環境でのFK enforcement / `PRAGMA foreign_key_check`、Server時刻、`withSession("first-primary").batch()`のGuard失敗時の原子性は未検証であり、#536のD1検証経路で確認する。ローカルSQLiteの結果を正式なD1実環境証跡とせず、予約Applicationの統合検証およびProduction相当環境でのAdapter有効化より前に検証を完了し、失敗時は有効化を停止する。本Issueは詳細設計文書のみを変更し、予約Migration / Production Adapter / 実Provider Deliveryを有効化しないため、認証物理設計#636の成果・有効化条件は§8を正とし、実Provider Delivery #637とD1実環境検証 #536は引き続き未実施の有効化前提である。

## 7. Traceability

| 設計 | 要求・基本設計 | 確認観点 |
| --- | --- | --- |
| §2〜4 Slot / Preview / 履歴 | REQ-001 / 002 / 003 / 005、BR-015 / 017 / 050〜059 / 066〜068、AC-001 / 002 / 003 / 005 | 公開・占有View、本人月間分類、取消履歴と安定Page |
| §2.1・§3〜4 管理占有詳細参照 | BR-017 / 067、REQ-001 / 002、AC-001-002〜003、`02_DataModel.md` §4.6 | #834 isolated D1 fixtureでvalid / missing / wrong / both-detail、PK / FK、隔離を検証。#830の`tests/d1/schedule-query.test.ts`で実Adapter / Serviceの未来fail-closed・開始済みViewも検証する。既存TC全体のSystem / Acceptance Passとはしない |
| §2〜3 Production予約migration | 上記Slot / 分類 / 詳細参照および通知の既存要求・設計 | #867の`tests/d1/reservation-migration.test.ts`でProduction DDL・Index・FK・制約とread-only integrityのDB/migration partial evidenceを検証。Command成功・実D1・System / Acceptance TC全体のPassではない |
| §5 原子的Confirm | POL-003 / 008、REQ-003 / 911 / 940、AC-003-005〜007 / 016〜021、AC-911-001〜002、AC-940-001〜005 | Guard失敗で全Rollback、Actorと時刻、再分類 |
| §2 設定主体・派生変更監査 | BR-056 / 058 / 132、REQ-940、AC-940-001〜002、`04_ReservationModel.md` §12.1、`05_BookingAndConcurrency.md` §12.2 | `updated_by` mapping、予約成立Auditから全再分類before / afterを追跡 |
| §1・§3・§5・§8 認証Guard接続 | BR-068 / 099 / 123、AC-003-019〜020 / AC-207-003 / AC-211-001〜003、`05_BookingAndConcurrency.md` §3.8 | §8の認証Guard接続・隔離試験fixture境界を参照し、同一Transactionで最新認証状態を再照合 |
| §2・§5〜6 通知 | REQ-101 / 104 / 914、BR-112 / 115 / 133、AC-101-001〜002 / AC-104-001〜003 / AC-914-004〜005 | 必須Intent同一Commit、配送分離、安全なError |

既存のPOL→BR→REQ→AC→TCは変更しない。要求ベース試験は`../40_test/02_FunctionalTestSpecification.md`、`03_NonFunctionalTestSpecification.md`と`04_RequirementsTestTraceability.md`を参照する。OOS-001 / 002を維持し、料金、管理者代理予約、Bulk / cancel / admin Command全体の物理詳細を導入しない。§8は停止・削除Commandへ合成する認証Guard部分だけを定める。

## 8. Student Session・利用可否のD1物理Guard契約（#636）

入力は`01_SystemArchitecture.md` §2.1、`02_DataModel.md` §2.1、`05_BookingAndConcurrency.md` §3.8 / §9、`06_APIOverview.md` §10 / §16〜17である。以下は認証済みStudentを予約価値単位へ接続する最小物理契約であり、この§8ではProvider flow、Admin認証、プロフィール属性・所有確認、削除Command全体の物理設計は対象外とする。#840のStudent Provider flowはApplication正本§10と本書§9で定義する。それらの実装をこのDDLだけで有効化してよい意味ではない。

### 8.1 正本とDDL

| 論理概念 | 物理正本・接続点 |
| --- | --- |
| Student | `students.id`は予約FKとGuard結果の内部Student ID。`lifecycle = active / deleted`と`deleted_at`は通常利用可能／削除確定を表す。 |
| StudentSecurityAccess | `student_security_access.student_id`で各Studentにちょうど1行、`access_state = active / suspended`を保持する。lifecycleと別軸とする。 |
| StudentAccount | `student_accounts.id`はStudent用Principal。`student_id UNIQUE`でStudentあたり最大1 Account、`role_scope = student`だけを持つ。 |
| Student Session | `student_sessions`はAccountに属するopaque server-side Session。期限・失効と固定Student role scopeを保存する。 |
| 通常利用・予約操作可否 | `lifecycle = active AND access_state = active`から導出する。重複する`can_book`、membership、休会・退会状態を追加しない（OOS-009）。Slot等の個別予約条件は既存§4〜5を維持する。 |

時刻・ID型は§1と同じ。以下はmigration実装へのDDL契約であり、Production migration fileではない。プロフィール・AuthMethod列を予約FK接続のためだけに複製しない。

```sql
CREATE TABLE students (
  id TEXT PRIMARY KEY NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','deleted')),
  deleted_at INTEGER,
  CHECK ((lifecycle = 'active' AND deleted_at IS NULL) OR
         (lifecycle = 'deleted' AND deleted_at IS NOT NULL))
);
CREATE TABLE student_security_access (
  student_id TEXT PRIMARY KEY NOT NULL REFERENCES students(id),
  access_state TEXT NOT NULL CHECK (access_state IN ('active','suspended')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE student_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT NOT NULL UNIQUE REFERENCES students(id),
  role_scope TEXT NOT NULL CHECK (role_scope = 'student'),
  UNIQUE(id, role_scope)
);
CREATE TABLE student_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  role_scope TEXT NOT NULL CHECK (role_scope = 'student'),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(account_id, role_scope) REFERENCES student_accounts(id, role_scope),
  CHECK (expires_at > created_at AND expires_at <= created_at + 2592000),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX ix_student_sessions_account ON student_sessions(account_id);
CREATE INDEX ix_student_sessions_expiry ON student_sessions(expires_at);
CREATE TRIGGER student_session_revocation_is_final
BEFORE UPDATE OF revoked_at ON student_sessions
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT, 'student_session_revocation_is_final');
END;

CREATE VIEW student_session_access_v1 AS
SELECT se.id AS session_id, se.token_hash, se.account_id, se.role_scope,
       se.created_at, se.expires_at, se.revoked_at,
       a.student_id, s.lifecycle, s.deleted_at, sa.access_state
FROM student_sessions AS se
LEFT JOIN student_accounts AS a ON a.id = se.account_id AND a.role_scope = se.role_scope
LEFT JOIN students AS s ON s.id = a.student_id
LEFT JOIN student_security_access AS sa ON sa.student_id = s.id;
```

PK / UNIQUE / FKが本人解決を最大1行にする。Student作成と初期`student_security_access(active)`作成は同一Transactionとし、欠落をactiveの既定値として補わない。AccountのStudent binding、SessionのID / Account / role / hash / created_at / expires_atは発行後不変とする。Session更新は`revoked_at`のNULLから失効時刻への遷移だけで、期限を延長しない。Accountを別Studentへ付け替えず、新規登録・再登録には新しいStudent / Account / Session IDを発行する。`deleted`から`active`へ戻さない。

Admin Account / Sessionは別の物理境界とし、このStudent専用TableへAdmin行を保存しない。Student削除・一括失効SQLはStudent Tableだけを対象とし、独立Admin Sessionへ波及しない。AdminのDDL・期限・Cookieは本書で定義しない。

削除確定は物理的な`DELETE FROM students`ではない。予約FK先のIDと削除確定状態を、必要な業務履歴との整合に必要な間だけ残す。氏名・メール・AuthMethod・Session hash等の直接／間接識別子は`REQ-934`の24時間以内削除・匿名化対象であり、tombstone / FKを理由に保持延長しない。履歴の保持・匿名化、不要行の最終削除はBR-126 / REQ-934に従う削除詳細設計側で整合させる。

### 8.2 Session tokenの保存境界

発行Adapterは暗号学的乱数32 byteを生成し、paddingなしbase64urlの43文字をopaque tokenとする。受信はcanonicalな同形式（decode後32 byte、再encode一致）だけを受け付け、Worker内でそのASCII tokenのSHA-256を計算してlowercase hex 64文字を`token_hash`に保存・検索する。高entropy tokenの照合用hashであり、Password hashingやProvider credentialの保存方式ではない。生token、Cookie、hashをLog / Audit / View / Expected State Tokenへ入れない。DBから生tokenを復元・発行しない。token_hash UNIQUE衝突時は発行失敗とし、既存SessionをUPSERTで上書きしない。

Browserへの新CookieはSession発行batchの正常Commit後だけ返し、Secure / HttpOnlyと`06_APIOverview.md` §10のCookie / CSRF境界を適用する。Cookie名・SameSite / Path / prefixおよびCSRF wireは`01_StudentReservationApplication.md` §10を正とし、route接続は後続実装の責務である。ClientのStudent ID / Account ID / Role headerをSession検索の代替にしない。

### 8.3 Request解決と重要Student Writeのstable predicate

`student_session_access_v1`を認証物理列への唯一の共有参照面とする。予約AdapterはView名、以下のpredicateとbind契約を使用し、認証Tableへ独自Joinを追加しない。View定義・predicateの変更は認証Guardと全consumerを同期するmigration / code変更で扱い、同じ`v1`の意味を無言で変えない。

Requestでは`DB.withSession('first-primary')`の単一SELECTでhashに対応するView行とD1時刻を読み、以下を順に評価する。

1. token欠損・不正、Session不存在、`revoked_at IS NOT NULL`、`T < created_at`または`T >= expires_at`なら`unauthenticated`（401）。
2. FK先・必須SecurityAccess欠落など永続化Invariant異常はfail-closedの503とし、存在するSessionの関連欠落を「許可」へ補わない。DB障害は`SERVICE_UNAVAILABLE`、整合性異常は`INTEGRITY_STATE_UNAVAILABLE`。
3. `lifecycle <> active`または`access_state <> active`は利用不能Sessionとして401。停止・削除時の一括失効が必要であり、この再照合だけでその代替としない。
4. 有効な認証済みSessionがStudent role / 当該self-scope操作権限を持たなければ`forbidden`（403）。別Roleの有効性はそのRoleのGuard責務であり、未知tokenや失効Student Sessionを403のために認証済み扱いしない。
5. 成立時だけViewの内部`student_id`を`authenticated`の`studentId`として返す。

既存`src/application/student-access-guard.ts`の`authorize(request)`と3結果はread-only HTTP Portとして維持する。Production Guardはこの解決を実装し、D1 / Invariant障害はHTTP Adapterの既存503境界へ渡す。認可結果をRequest間でcacheしない。

#842の実装は`src/infrastructure/d1-student-access-guard.ts`を参照する。共有`resolve(request)`が同一Requestの内部Contextを返し、`authorize(request)`はhash / Session IDを除いた既存結果だけを返す。`StudentAccessError`でDB / Invariantの2つの既存503を区別する。read-only HTTP consumerの401 Cookie除去・503 Cookie維持はApplication §10.2に従う。unsafe HTTP consumerのCSRF / Originと重要Writeのbatch再照合は本解決を使うだけでは完了しない。

#865の単一予約Preview HTTPはこの`resolve(request)`と既存Preview read / coreを明示compositionし、
Application §5 / §10.3のSession→CSRF / Origin→業務認可順を実装する。
Cookie parserの共用以外に本View / predicate / 内部Contextを変更せず、重要Write・public activationは未接続とする。

Write用compositionは同じRequestの解決で得た`session_id / token_hash / student_id`をServer内部の認証ContextとしてTransaction Adapterへ渡す。これはClient入力、Expected State Token、外部API結果、または再利用可能な認可ticketではない。既存read-only Portの`studentId`だけではSession失効を再照合できないため、それだけでWrite Guardを成立させない。Write Adapter実装時にはこのContextを内部で保持する解決処理を共有し、read-only Portのwire / resultを拡張してhashを外へ出さない。

Student Write predicateは以下の`EXISTS`全体である。`:session_id / :token_hash / :student_id`は上記Context、`:guard_id`は当該batchでINSERTした`command_guards.id`。`:student_id`は予約INSERT / Actorにも同じ値をbindする。

```sql
SELECT EXISTS (
  SELECT 1 FROM student_session_access_v1 AS a
  WHERE a.session_id = :session_id AND a.token_hash = :token_hash
    AND a.student_id = :student_id AND a.role_scope = 'student'
    AND a.revoked_at IS NULL
    AND a.created_at <= (SELECT captured_at FROM command_guards WHERE id = :guard_id)
    AND a.expires_at > (SELECT captured_at FROM command_guards WHERE id = :guard_id)
    AND a.lifecycle = 'active' AND a.deleted_at IS NULL
    AND a.access_state = 'active'
) AS student_write_allowed;
```

§5 step 2の`ok = CASE WHEN ...`内へこの`EXISTS`をANDで組み込み、同じ1回のbatchの中で現在のD1状態を検査する。最終step 7でも同じpredicateを評価し、時刻引数だけをそのStatementの`CAST(strftime('%s','now') AS INTEGER)`へ置き換えてSession期限到達もRollbackする。Request / Previewの時刻・Worker時刻を最終期限判定へ流用しない。失敗は`command_guards.ok CHECK(ok = 1)`で全Rollbackし、0件UPDATEだけで後続業務WriteをCommitしない。

Request解決SQLも同じView・同じ有効条件を使用するが、当該SELECT内で取得したD1時刻を引数とする。失敗分類に必要な無効行も読めるよう、lookup自体はhashだけで絞る。有効条件は「現在状態で許可」かを確認するもので、認証Contextの取得時の状態をDBへ書き戻さない。Reservation read-set / wire / classificationは変更しない。

Logout / 停止 / 削除と競合しbatchが失敗した場合、Rollback後に新しいPrimary起点の読取で本人を再照合する。失効は401を予約Conflictより先に返し、認証不成立なら最新Slot / Reservation情報を付けない。判定不能は503、認証が成立する場合の業務競合分類は§6を維持する。SQL / Triggerエラーの原文からHTTP理由を推測せず、自動再発行・自動Write Retryもしない。

### 8.4 発行・Logout・停止・削除の原子的境界

**Login / Session issuance:** Provider flowが検証・bindingを完了してServer内部で解決した既存`student_accounts.id`を入力とする。Provider responseやClientのAccount IDを直接信用してこの境界へ入れない。同じPrimary batchでTを採取し、Account / role、Student active、SecurityAccess activeをassertしてから、新しいID / hash、`created_at = T`、`expires_at = T + 2592000`、`revoked_at = NULL`でINSERTする。最後に最新access / lifecycleと新Sessionの期限を再assertしてGuard行を削除する。assert不成立はCHECK違反で全RollbackしCookieを発行しない。pre-auth Sessionの昇格、期限更新、停止前のSessionの再利用をしない。Provider固有のconsume・AuthMethod登録等が同じ整合境界を要する場合は、そのflow詳細設計側で本発行Guardと合成する。

発行時のaccess Guardは次を用いる（`:account_id`は検証済みServer入力）。この`EXISTS`を`command_guards.ok`のassertへ埋め込み、Session INSERT前と最終Guardで再利用する。

```sql
SELECT EXISTS (
  SELECT 1 FROM student_accounts AS a
  JOIN students AS s ON s.id = a.student_id
  JOIN student_security_access AS sa ON sa.student_id = s.id
  WHERE a.id = :account_id AND a.role_scope = 'student'
    AND s.lifecycle = 'active' AND s.deleted_at IS NULL
    AND sa.access_state = 'active'
) AS student_session_issuance_allowed;
```

**Logout:** 当該Student Sessionだけを`UPDATE student_sessions SET revoked_at = :T WHERE id = :session_id AND token_hash = :token_hash AND revoked_at IS NULL`で失効させる。既存失効時刻をNULLへ戻さず、他Sessionへ波及しない。Cookie除去だけでLogout完了としない。

**Security Suspension:** 認証済みAdmin Commandの同じPrimary batchで、Target Studentがactive、SecurityAccessがactiveであることをassertし、次の2 Statementと成功Auditを確定する。`:T`はbatchで採取したD1時刻で、期限切れだが未失効のSessionも一括対象とする。

```sql
UPDATE student_security_access
SET access_state = 'suspended', updated_at = :T
WHERE student_id = :student_id AND access_state = 'active';
UPDATE student_sessions SET revoked_at = :T
WHERE revoked_at IS NULL AND account_id IN (
  SELECT id FROM student_accounts WHERE student_id = :student_id
);
```

状態UPDATE直後に`changes() = 1`をCHECK assertし、最終Guardでsuspendedと対象Accountの`revoked_at IS NULL` Sessionが0行であることをassertする。Audit失敗も全Rollbackする。解除はactive lifecycle・現在suspendedをassertしてSecurityAccessだけをactiveへ戻し、更新件数と最終状態をassertしてAuditする。再停止／非停止への解除を無言のNo-opにしない。Sessionの失効時刻を消去せず、解除後は新規Loginで新Sessionを作る。停止・解除ではReservation / Occupancy / classificationを変更しない。

**Deletion:** 削除Confirmの同じbatch内で`UPDATE students SET lifecycle = 'deleted', deleted_at = :T WHERE id = :student_id AND lifecycle = 'active'`を行い、直後に`changes() = 1`をassertする。SecurityAccessがsuspendedでも削除可能とする。停止と同じSession一括失効SQLを合成し、deletedと未失効Session 0行を最終assertする。Account / AuthMethodのLogin対象外化は全Login経路がactive lifecycleを必須Guardすることで即時成立する。この認証fragmentだけを独立Commitして削除成功としない。`05_BookingAndConcurrency.md` §9の将来予約取消・占有終了・通知失効・個人情報削除義務・AuditおよびPurge Registryとのdurable整合は、削除Command全体の詳細設計・実装で同じ成功境界を満たす。後続CleanupでSession / Account行を除去する場合もdeletedをactiveへ戻さず、復旧時は既存sanitation / Purge Gateを維持する。

| 先行正常Commit | 後続操作と結果 |
| --- | --- |
| Logout / Suspension / deletion | 古いRequest ContextのStudent Write predicate不成立。予約・占有・再分類・Audit・Intentは全Rollback。 |
| Student Write | 後続停止は予約を維持して全Session失効。後続削除は最新予約集合を再照合し、Preview差分なら全体未適用・再Preview（既存契約）。 |
| Suspension / deletion | 後続Loginはissuance predicate不成立、Session / Cookieを発行しない。 |
| Login | 後続停止・削除の同じTransactionで今発行したSessionも失効。 |
| Suspension後の解除 | 古いhashは失効状態を維持。新規Loginだけが利用を再開する。 |

これらは既存D1 atomic batch契約を使う。同じ業務D1上でGuardとWriteを行い、認証を別DBや外部cacheへ分離しない。実環境での原子性・先行Commit可視性の確認は§8.6の有効化Gateであり、ローカルSQLiteを実D1の証跡として扱わない。

### 8.5 #608 isolated fixtureとProduction adapterの境界

`StudentAccessGuard`の成功は任意のStudent IDの注入ではなく、期限・失効・role・最新access / lifecycle・操作権限を満たす本人解決を意味する。#608のstateful test auth fixtureは隔離DBにStudent / Account / Session状態を用意し、RequestとWriteの同じpredicateを評価する。可能な限り上記DDL / Viewを隔離DBへ適用し、SQL試験とfixtureの意味を一致させる。DB初期化で生tokenからhashを作る処理もtest側に限定する。

既存`tests/integration/student-access-guard-fixture.ts`はread-only HTTP consumerの3結果mappingを検証する固定fakeであり、Session / race Guardの証明には使わない。Write評価は別途stateful fixtureとTransaction内assertを要し、固定`authenticated` fakeやFK用`students(id)`だけのbootstrap fixtureでProduction認可を証明した扱いにしない。

fixtureはtest entrypointからだけ注入する。Production entrypointからtest modulesをimportせず、HTTPの特殊header / query / cookie、環境switch、fixture token allowlist、認可迂回Endpoint、常時許可GuardをProductionへ持ち込まない。共有Production相当環境も実Guard / migrationを使う。既存default Workerの503と#831 read-only Adapterの未接続状態を維持する。

#842のunit / integration / local D1検証の範囲と既存TCへのpartial evidence対応は[`tests/README.md`](../../tests/README.md)を参照する。既存`AUTH_DB`へProduction migrationを適用し、実Guardと#831 consumerをtest entrypointから明示compositionする。default Worker / public routeへの接続はなく、§8.6の実環境検証・activation Gateは維持する。

以下は本物理契約の検証観点であり、既存TCの意味・受入範囲を変更しない。

| 既存AC / TC | 物理契約での確認 |
| --- | --- |
| AC-003-019〜020 / TC-F-003-06〜07、BR-090 | hashから一意な本人だけを解決。別本人ContextではWrite不成立、Reservation FKは同じStudent ID。 |
| AC-207-002 / TC-F-207-02 | expires直前は有効、等値以後は無効。発行から30日上限、Idleで期限を延長・短縮しない。 |
| AC-207-003 / TC-F-207-03 | Logout / 停止 / 削除後は旧Session不成立。DBの生token保存なし。 |
| AC-211-001〜005 / TC-F-211-02〜03 | 複数Session一括失効、停止中発行拒否、解除後旧Session非復活、新Sessionのみ有効、停止は予約不変。 |
| AC-311-002 / TC-F-311-02、AC-201-003 | deletedはLogin / Write不可。同じメールの再登録は旧Student / Sessionへ接続しない。 |
| AC-911-001〜002、`05_BookingAndConcurrency.md` §3.8 | 停止・削除 / WriteおよびLoginの両Commit順、事前解決後のLogout、batch中期限到達、CHECK失敗の全Rollbackを検証。既存TC-NF-911-01〜02の予約競合試験も維持。 |
| POL-006 / 014、REQ-914 | wrong role、未知・失効token、SecurityAccess欠落、DB障害を安全に区別し、内部情報をResponseへ出さない。 |

### 8.6 Migration依存順とactivation Gate

§3 step (1)の内側は、(a) `students`、(b) `student_security_access`、(c) `student_accounts`、(d) `student_sessions`・Index・失効Trigger、(e) `student_session_access_v1`、(f) §2で定義した共有`command_guards`の順とする。発行・停止・削除のCHECK assertもこの共有Tableを使うため、予約Schemaの導入を待たず認証基盤側で作成する。予約migrationは同じTableを再作成せず、§3 step (6)で定義一致を検証する。その後に§3の予約Schemaを適用する。#841の実装は[`migrations/0001`〜`0006`](../../migrations/README.md)でこの順序を保持し、§8.1の不変binding・Session属性・削除後非復活もTriggerで強制する。既適用migrationを書き換えず、isolated test-only migration番号をProduction番号として流用しない。

認証migrationの完了確認はFK check 0行、全StudentにSecurityAccessがちょうど1行、Account / Sessionのrole・本人接続、hash形式・一意性・期限制約、View定義と上記predicateの整合、解除後非復活Triggerを含む。既存データの欠落・矛盾は自動的にactiveへbackfillせず、検証できなければ有効化を停止する。

ProductionおよびProduction相当の共有環境では、予約migrationの前に本設計に対応する認証migrationを適用・検証する。Reservation Adapterのactivation前には、さらに次を満たす。

- Production auth AdapterがRequest解決とServer内部Contextを実装し、同じ業務D1 / View / predicateへ接続する。#636の文書完了だけでAdapter完成としない。
- 実装対象の重要Writeが初期・最終Guardを同じbatchで評価し、Logout / 停止 / 削除・発行とのraceと全Rollbackを検証する。
- #536の検証経路でD1のFK enforcement、Server時刻、`withSession('first-primary').batch()`の原子性・先行Commit状態の照合・Trigger拒否を対象環境で確認する。未検証・失敗なら有効化しない。
- `01_SystemArchitecture.md` §6の環境identity / binding、未完成機能のserver-side gateを満たし、fixtureがProduction artifact / routeへ入らない。§3の予約Integrity validationも成功する。

本設計と#841は新しい実環境検証基盤・Provider接続・activationを導入しない。#841のmigration・Integrity Queryと隔離local D1 testは物理契約の局所検証であり、#608の隔離評価は§8.5で先行できるが、実D1検証およびProduction auth Adapterの実装・有効化は既存後続責務として残る。削除Command全体、Provider flow、Admin認証、Cookie / CSRF HTTPの未実装境界をこの設計で完了した扱いにしない。

## 9. Student Provider Flowの保存・発行合成契約（#840）

### 9.1 正本・最小保存面

HTTP / Cookie / CSRF / Provider validationは`01_StudentReservationApplication.md` §10を正とする。以下は同じ業務D1に保存する認証flowのDDL契約であり、Production migrationではない。§8のTable / View / predicateを変更せず、Profile変更・Invitation管理・削除Command全体の実装を追加しない。§8のAccountへ接続するbinding／所有確認／登録許可を定義する。

```sql
CREATE TABLE student_contacts (
  student_id TEXT PRIMARY KEY NOT NULL REFERENCES students(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL
);
CREATE TABLE student_google_bindings (
  account_id TEXT NOT NULL REFERENCES student_accounts(id),
  issuer TEXT NOT NULL, subject TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX ix_google_bindings_account ON student_google_bindings(account_id);
CREATE TABLE student_registration_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('open','invitation_only'))
);
CREATE TABLE student_auth_preauth (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  CHECK (expires_at = created_at + 1800)
);
CREATE TABLE student_invitations (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  invitation_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'student_invitation'),
  recipient_email TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, superseded_at INTEGER,
  CHECK (expires_at = created_at + 259200)
);
CREATE UNIQUE INDEX ux_student_invitation_pending ON student_invitations(invitation_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE TABLE student_google_flows (
  id TEXT PRIMARY KEY NOT NULL,
  preauth_hash TEXT NOT NULL REFERENCES student_auth_preauth(token_hash)
    CHECK (length(preauth_hash) = 64 AND preauth_hash NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK (purpose = 'student_google_login'),
  state_hash TEXT NOT NULL UNIQUE CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  code_verifier TEXT, redirect_uri TEXT NOT NULL,
  invitation_hash TEXT REFERENCES student_invitations(token_hash)
    CHECK (invitation_hash IS NULL OR (length(invitation_hash) = 64 AND invitation_hash NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  claimed_at INTEGER, consumed_at INTEGER, superseded_at INTEGER,
  CHECK (expires_at = created_at + 600)
);
CREATE UNIQUE INDEX ux_student_google_pending ON student_google_flows(preauth_hash)
  WHERE claimed_at IS NULL AND consumed_at IS NULL AND superseded_at IS NULL;
CREATE TABLE student_magic_challenges (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK (purpose IN ('student_magic_login','student_magic_register')),
  account_id TEXT REFERENCES student_accounts(id),
  email TEXT NOT NULL, email_key TEXT NOT NULL,
  invitation_hash TEXT REFERENCES student_invitations(token_hash)
    CHECK (invitation_hash IS NULL OR (length(invitation_hash) = 64 AND invitation_hash NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, superseded_at INTEGER,
  CHECK (expires_at = created_at + 900),
  CHECK ((purpose = 'student_magic_login' AND account_id IS NOT NULL) OR
         (purpose = 'student_magic_register' AND account_id IS NULL))
);
CREATE UNIQUE INDEX ux_student_magic_pending ON student_magic_challenges(email_key)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE TABLE student_registration_proofs (
  preauth_hash TEXT PRIMARY KEY NOT NULL REFERENCES student_auth_preauth(token_hash)
    CHECK (length(preauth_hash) = 64 AND preauth_hash NOT GLOB '*[^0-9a-f]*'),
  source_flow_id TEXT NOT NULL,
  source_purpose TEXT NOT NULL CHECK (source_purpose IN ('student_google_login','student_magic_register')),
  issuer TEXT, subject TEXT,
  email TEXT NOT NULL, email_key TEXT NOT NULL,
  invitation_hash TEXT REFERENCES student_invitations(token_hash)
    CHECK (invitation_hash IS NULL OR (length(invitation_hash) = 64 AND invitation_hash NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  CHECK ((source_purpose = 'student_google_login' AND issuer IS NOT NULL AND subject IS NOT NULL) OR
         (source_purpose = 'student_magic_register' AND issuer IS NULL AND subject IS NULL))
);
CREATE TABLE student_auth_rate_events (
  id TEXT PRIMARY KEY NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('magic_source','magic_destination','google_source')),
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  accepted_at INTEGER NOT NULL
);
CREATE INDEX ix_student_auth_rate_window
  ON student_auth_rate_events(bucket, key_hash, accepted_at);
```

ID / 時刻は§1、hashは§8.2と同じ64文字lowercase hexとする。Invitation / Magic tokenも独立32 byte乱数のcanonical43文字で、生tokenはDBへ入れない。`state_hash / nonce_hash / preauth_hash`も受信ASCII値のSHA-256。PKCE verifierはcode交換に必要な短期秘密であり、Google flowだけに保持し、claim後の処理終了／期限でNULLにする。raw Provider ID / access / refresh token、callback codeは保存しない。

`student_contacts`は氏名・現在の所有確認済み連絡先の正本とし、logical Magic AuthMethodのlogin addressはこの行から導出する。別のMagic address列を作ってずらさない。`email_key`はApplication §10.6の単一正規化関数の結果であり、Student role scopeだけの一意性。Google bindingはstable `(issuer, subject)`だけをAccountへ結び、Google emailを連絡先変更の入力にしない。既存bindingを別AccountへUPDATE / UPSERTしない。個人情報削除完了まではdeletedの連絡先keyも予約され、Cleanupが当該行を削除／匿名化してkeyを解放した後だけ再登録可能となる。

登録modeの行は既存環境設定から明示的に1行を作り、欠損をopenと推測しない。Invitation管理側は新version発行と同じbatchで同じ`invitation_id`の旧未使用行をsupersedeして新hashを保存する。対象環境・Student purpose以外の招待をこの表へ入れない。Admin管理API／監査／配送の全設計をここで完了した扱いにしない。

全flowの期限／消費／supersedeは不可逆とする。`consumed_at / superseded_at / claimed_at`はNULLからServer時刻へ一度だけ遷移し、非NULLをNULLや別時刻へ戻さない。この更新規則はAdapterの条件付きUPDATEとCHECK assertで強制し、Tableを直接更新する別callerを認めない。期限行をpending UNIQUEから自動的に外す必要はなく、新発行batchで旧行をsupersedeしてからINSERTする。

### 9.2 原子的flow／binding／Session発行

事前Primary SELECTからbinding／mode／Challengeの候補を読み、Workerが新ID／Session hashとprepared statement planを作る。選択した既存Account IDは初期batch Guardで同じidentity／連絡先に現在も対応することをassertする。新Account IDもWorker生成で、ClientやProviderから受け取らない。事前読取を発行許可にせず、batch内でread setと条件を再照合する。

全Commandは§5と同じ`DB.withSession('first-primary').batch()`、prepared statements、共有`command_guards`のCHECK assertを使う。0件の条件付きUPDATEだけを成功としない。外部Provider呼出はbatch外で行う。Server内部のprovider検証結果は当該Requestだけで使用し、Clientから再受付しない。

**Google claim:** 同じbatchでTを採取し、pre-auth有効、state hash／browser／purpose一致、`created_at <= T < expires_at`、未claim／未消費／非supersededをassertする。`UPDATE student_google_flows SET claimed_at = :T WHERE id = :id AND claimed_at IS NULL AND consumed_at IS NULL AND superseded_at IS NULL`直後に`changes() = 1`をCHECK assertする。claimはGoogle呼出より先にCommitする。以後の最終batchはclaimed行と同じpre-auth、期限、非supersededを再確認し、state再利用を許さない。古いclaimed flowの応答が新start後に戻る場合も、新startが旧claimed行をsupersedeするため成立しない。

**Magic request:** 送信元Rate Limit上限検査と予約を1 batchで行い、Turnstile外部検証後に送信先予約とChallenge判断を別の1 batchで行う。Accountの存在／最新連絡先／利用可否と登録mode／招待から送信可否とpurposeを決める。既存停止・削除行を見つけたらregisterへfallbackしない。送信可能な場合だけ同宛先の旧未使用Challengeをsupersedeし新hashを保存する。任意Invitationは有効行だけをhashとして保持し、無効ならNULLとする。招待が必要なのに欠損／無効なら登録Challengeを作らない。送信しない場合も公開202と予約を維持する。正常Commit後だけmemoryのtokenをMail Portへ渡す。Provider障害はこのCommitを戻さない。

**Magic consumeのBrowser切替Guard:** 同じ成功batchで、当該pre-authの未完了Google flow（claimedも含む）をsupersedeし古い登録proofを除去する。previewだけでは変更しない。古いGoogle callbackはその最終Guardで不成立となる。

**既存Login:** Googleはvalidated identityとclaimed flow、Magicはtoken hashとpurposeを初期assertする。現在のbinding／連絡先／Accountを再解決し、AccountがactiveでSecurityAccess activeであることを§8.4でassertする。Google未bindingかつ一意verified連絡先一致ならGoogle bindingをINSERTする。Magicは保存accountと現連絡先keyが一致しなければ拒否する。flowを条件付きUPDATEで消費し、直後に`changes() = 1`をassertする。新Sessionを§8.4に従いINSERT、同Browser旧Sessionがあればそのid / hashだけを失効させる。最終Guardでflow消費、binding／Magic連絡先一致、新Sessionと最新lifecycle / access / 期限を再assertする。正常CommitだけがCookie発行可能となる。

**新規所有確認:** 対象Google / Magic flowと現在Browser pre-authの有効性を同様にassertする。flow消費と`student_registration_proofs`への保存を同じbatchで行う。Server検証済みemail / issuer / subjectと元flow期限を保存し、proof expiryを元flowとpre-authの期限の小さい方にする。古いproofは同Browserの新しい明示flowだけが置換可能とし、Session発行・Actor生成はまだ行わない。source IDはGoogleなら`student_google_flows.id`、Magicなら`student_magic_challenges.token_hash`。proofのsource列が指す消費済みflowのpurpose／元期限を保存・再利用時にassertする。Magicではsourceのemail keyとの一致もassertする。Googleのemail / issuer / subjectは当該claim後にAdapterが検証した結果だけをproofへ保存し、Google flow表へ不要に複製しない。

**登録確定:** pre-auth／proof／元flowの対応と期限をassertし、Application §10.7の順序で既存binding／verified連絡先を再照合する。既存一意Accountへ接続する場合は必要なbindingだけを追加し、mode／招待をLogin条件にしない。新規時は最新modeを同じbatchで読み、Invitation Onlyなら招待purpose／期限／未使用／非supersededをassert、consume UPDATE後`changes() = 1`をassertする。新Student、SecurityAccess active、Account、contacts、必要なGoogle bindingをINSERTする。Magic AuthMethodはverified contactsから利用可能となる。新／既存Accountの§8.4 issuance predicateをassertし、proofをDELETEして`changes() = 1`をassert、新SessionをINSERTする。最終Guardでproof不在、必要招待消費、現在binding / contact / access / lifecycle、新Sessionの期限を再assertし、pre-authを削除する。Google / Magic source行は最終Guardまでconsumedを保ち、復活させない。

成功Loginでも当該pre-authと不要proofを削除する。FKの参照順を守り、最終Guard後に当該pre-authを参照する全Google flowを先に削除し、その後pre-authを削除する。再利用不能性はflowが不存在である場合も維持する。Magic source行はpre-auth FKを持たず単回consume状態を保つ。登録proofが残る間はそのsource行をCleanupしない。

全assertは最終D1時刻でもpre-auth／元flow／proof／招待の必要期限を再評価する（保存時刻はTのまま）。proof DELETE前にその期限／sourceをGuard行の`expected_read_set`へ捕捉して初期assertで照合し、DELETE後の最終時刻比較にもその検証済み期限を使う。期限到達や一意競合、途中INSERT失敗ではbinding／新Student／招待消費／Sessionの部分Commitを認めない。Google claimだけは外部呼出前の独立成功境界なので、後続Rollbackで未claimへ戻さない。

既知のraceはRollback後にPrimary再照合し、flow失効／mode変更／binding競合を`AUTH_FLOW_INVALID`、Session失効を401へ抽象化する。未知constraint、参照欠落・矛盾は`INTEGRITY_STATE_UNAVAILABLE`、D1読取不能は`SERVICE_UNAVAILABLE`。失敗SQLの原文で分類せず、Response不明でも新Sessionを再発行・blind retryしない。生tokenを復元できないため、Cookie未到達／結果不明は新Login操作で回復する。

### 9.3 Cleanup・後続migration・検証

flow／proof／pre-auth／Rate Limit一時行は有効期限／最大時間窓を超えて利用せず、Cleanupで参照順に除去する。hashをAuditへ複製しない。Student削除ではcontacts、Google binding、当該AccountのMagic Challengeと該当identityを含む登録proof／短期flowも直接・間接識別子として24時間以内削除・匿名化対象にする。具体削除Command全体／Recovery Purgeは#843で既存要求に従い合成し、本節だけでは有効化しない。未完了・結果不明flowも個人情報削除を理由に保持延長しない。

§8 migration後、contacts / binding / 登録mode、pre-auth / Invitation、Google / Magic flow、proof、Rate Limitの順で必要なschemaを追加する。#841の§8 Guard migrationだけでは本節のProvider flowを有効化しない。適用済みmigrationや`student_session_access_v1`の意味を変えず、flow実装前に各追加保存面のmigration・一意性・FK・CHECK assertを揃える。対象環境の原子性・Server時刻・先行Commit可視性は引き続き§8.6のGateとする。

検証はApplication §10.9の既存AC / TCへ対応付ける。追加確認はclaim replay／old claimed callback、Magic同宛先並行再要求とconsume、登録mode／招待再発行race、同identity／同email並行登録、メール変更後旧Challenge、停止・削除／Loginの両Commit順、最終期限到達と全Rollbackである。local SQLiteのDDL／fixture検証はこの契約の局所検証であり、実D1／Provider／Browser試験の証明にはしない。
