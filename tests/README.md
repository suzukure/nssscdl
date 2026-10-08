# Tests

自動Unit / Integration / End-to-End Testを格納する。

要求ベースのSystem / Acceptance Test Specificationとトレーサビリティは `docs/40_test/` を正本とする。
自動テストを要求テストへ対応付ける場合は、test name / tag / metadataに `TC-F-...` または `TC-NF-...` のTC IDを保持する。

`unit/schedule-query.test.ts` は#828のfake Repository / deterministic Clockによるpure core検証。
`TC-F-001-01` / `TC-F-001-02` / `TC-F-002-01` / `TC-F-002-02` は
API/read-model **partial evidence** としてtest nameに記し、System/Acceptance TC全体のPassへ算入しない。
4種View、本人情報だけの投影、開始境界、未公開月、未来Slot不整合のfail-closedを検証する。
HTTP認可・D1整合性検査の実統合およびUIはこのunit testの証明範囲に含まない。

`d1/slot-view-schema.test.ts` / `d1/slot-view-isolation.test.ts` は#829のisolated read fixture検証。
`fixtures/d1/migrations/0002`〜`0006`は[確定D1物理設計](../docs/20_detailed_design/02_StudentReservationD1.md) §1〜4の
read sliceだけを保持し、`students(id)`はtest-only FK parentとする。
月・Slot・Reservation・OccupancyのFK / CHECK / UNIQUE、read index、`PRAGMA foreign_key_check`と
同じIDを使う別test file間の隔離を確認する。Test nameの `[#829 D1 fixture]` はSchema制約の証拠であり、
業務TC全体のPassへ算入しない。Production auth / migrationは含まない。Adapter検証は下記#830のtestを参照する。
既存bootstrap smokeも引き続き同じ標準D1コマンドで実行する。

`d1/management-occupancy.test.ts` / `d1/management-occupancy-isolation.test.ts` は#834のisolated詳細参照検証。
`fixtures/d1/migrations/0007_management_details.sql`は上記物理設計 §2.1の
`admin_holds(occupancy_id PK/FK)` / `group_lessons(occupancy_id PK/FK)`だけを追加する。
`d1/management-occupancy-fixture.ts`のIntegrity Queryは同節のSQLと一致し、3種占有ごとの全4詳細組合せ、
有効な詳細、orphan FK拒否、同種重複拒否、confirmed参照条件、FK確認と別file間の隔離を検証する。
`[#834 D1 fixture]`はSchema / Integrity Queryの証拠であり、System / Acceptance TC全体のPassへ算入しない。
未来Slotのerror / 開始済みSlotのViewへのAdapter統合は下記#830で検証し、Production有効化・管理Commandは含まない。

`d1/schedule-query.test.ts` は#830の実Adapterと#828 Serviceのcomposition検証。
既存#829 / #834 fixtureに、#611 §2の既定DDLと一致するtest-only
`fixtures/d1/migrations/0008_reservation_read_integrity.sql`（欠席・回数除外・分類Override）を追加する。
公開月、安定順序、4種View、本人情報だけの投影、未来不整合のfail-closedと開始済みViewを確認する。
FKで保存できない参照欠落／Slot不一致は、test-only source adapterでReservation read sourceを変更し、
実Queryをlocal D1で実行する破損read fixtureとして検証する（FK無効化なし）。
`unit/d1-schedule-query.test.ts` はDB実行失敗の安全な抽象化と単一statement／bindを確認する。
TC ID付きtestは引き続きAPI/read-model **partial evidence** とし、HTTP認可・UI・Production D1、
System / Acceptance TC全体のPassを証明しない。

`integration/schedule-month.test.ts` は#831のHTTP Adapter → test-only fake Guard → Serviceを
Workers runtime内で直接構成し、月・Method・Query検証、毎RequestのGuard、本人ID、
400 / 401 / 403 / 404 / 503の安全なenvelope / message / retryを検証する。
`d1/schedule-month-http.test.ts` は同じHTTP Adapter / fake Guardと実D1 Adapterを既存isolated
fixtureで構成し、成功wire、本人情報限定、4種View、安定順序、未公開／不存在、整合性異常と
D1実行失敗のpartial evidenceを得る。既存TC IDを保持し、System / Acceptance TC全体のPassには算入しない。
Production Session / Account / Role / access / lifecycle、UI、Production D1は証明範囲外。
`integration/worker.test.ts` は実default WorkerへのHTTPで新Endpointにも既存503を返すことを確認する。
Product moduleの統合とpublic activationの到達不能確認を同じ既存標準コマンドで実行する。

#638の基盤smokeには `[bootstrap #638]` をtest nameに付け、業務TCのPass件数へ算入しない。
`d1/student-auth-migration.test.ts`は#841のProduction `migrations/0001`〜`0006`を別のisolated local D1 `AUTH_DB`へそのまま適用する。
FK / 一意性 / hash / 30日期限境界 / 本人接続、固定binding・Session属性、失効不可逆、停止解除後の旧Session非復活、削除後非復活、
共有View / Index / CHECK・Trigger失敗時のPrimary batch全Rollback、read-only Integrity Queryによる欠落・未失効検出を確認する。
`TC-F-003-06` / `TC-F-207-02〜03` / `TC-F-211-02〜03` / `TC-F-311-02`付きtestはDB物理契約の **partial evidence** である。
HTTP / Provider / Admin・削除Command全体 / 実環境D1 / System・Acceptance TC全体のPassを証明しない。
既存予約fixtureの`TEST_DB`と適用履歴を共有せず、Production entrypointへ接続しない。

#867の `d1/reservation-migration.test.ts` は、共通setupの認証 `0001`〜`0006`の後に
Production予約 `0007`〜`0012`のbytesを同じfile-isolated `AUTH_DB`へ順次適用する。
認証Table / View / Trigger / 共有Guard定義・既存Guard行の保持、各段階のTable / Index依存順、
生徒FK・予約制約・JSON・partial UNIQUE、FK / authの各0行とreservationの独立read-only scans全ての合計0行を検証する。
DDLでは防げない永続化異常の検出と非修復も確認する。DB/migration **partial evidence**のみであり、
Confirm / Transaction Write Adapter / HTTP / 実D1 / System・Acceptance TC全体のPassを証明しない。
既存Preview suiteは認証migrationと独立した予約fixture履歴を維持し、新bindingやpublic activationはない。

#842の `unit/d1-student-access-guard.test.ts` はProduction GuardのCookie形式・重複・purpose、
hash bind / Primary / 単一SELECT、D1時刻の期限等値、結果評価順と安全なDB / Integrity異常を検証する。
`integration/production-student-access.test.ts` は同Guardを既存HTTP / Serviceへ注入し、
毎Request再照合・401 Cookie除去・403 / 503でCookie維持・内部情報非露出を検証する。
`integration/student-session-fixture.ts` の合成read sourceはtestからだけimportする。
`d1/student-access-guard.test.ts` は既存`AUTH_DB`とProduction migrationをそのまま使い、
実Guardの本人解決・内部Contextと既存Write predicateの接続、失効・停止・削除の次Request反映、
停止解除後旧Session非復活、新Session、期限非延長、SecurityAccess欠落のfail-closedを確認する。
read-only HTTP consumerは既存Repository Portのfixtureへ接続し、予約Production schemaを追加しない。
`TC-F-003-06` / `TC-F-207-02〜03` / `TC-F-211-02〜03` / `TC-F-311-02` / `TC-NF-914-04`は
Guard / HTTP / local D1の **partial evidence**。重要Write batch / race、Provider・Browser、
実環境D1、System / Acceptance TC全体のPassは証明しない。公開有効化Gateは詳細設計 §8.6を維持する。

業務を実装したテストでは、上記prefixに代えて対応する既存TC IDをtest nameへ保持する（例: `[TC-F-003-01] ...`）。
未実装業務のTCを基盤smokeへ割り当てない。
Phase Bでは `unit/worker.test.ts` でWorker moduleのhandlerを直接呼び、
`integration/worker.test.ts` でWorkers runtimeの `cloudflare:workers` / `exports.default.fetch()` を使う。
両方とも既存503応答のstatus / body / headersを確認する。
Phase Cの `d1/migration.test.ts` と `d1/isolation.test.ts` はtest-only migrationを適用し、
両ファイルが空のtableへ同じ主キーをinsert / selectできることを確認する。
Storage共有時には失敗する構成とし、手動DELETEで隔離の不具合を隠さない。
これらも業務TCのPass件数へ算入しない。実装・隔離条件と標準コマンドは
[config/README.md](../config/README.md) を正本とする。

#863の `d1/reservation-preview.test.ts` / `d1/reservation-preview-isolation.test.ts` は、
`reservation-preview-fixture.ts` から既存isolated `AUTH_DB` の認証migration／共有Viewへ、
既存予約fixture migration `0003`〜`0008` と新規test-only `0009_monthly_lesson_configs.sql` を適用する。
FK用Student fixture `0002` は適用せず、認証Schema・共有Viewの契約をそのまま再利用する。
Production migrationの追加・変更、Production相当共有環境への昇格、新bindingはない。
単一Primary SELECTとD1時刻T0、最新操作可否、設定行欠損と明示N、本人当月全予約の安定順、
欠席／取消／算入除外／分類Override、開始済み／未開始、管理詳細・占有異常のfail-closed、
他生徒情報非投影、同一状態の決定性、既存coreへのcompositionを確認する。
時刻境界／FKで保存できない破損状態はtest-only source adapterから実SQLへ注入し、
FKを無効化せず、実D1 Server時刻の検証とは分ける。同一IDの別file seedでstorage isolationを確認する。
`unit/d1-reservation-preview.test.ts` は単一SELECT／bind／Primary／T0と型・値異常、安全なDB errorを検証する。
`TC-F-003-01 / TC-F-003-02` はD1/Preview readの **partial evidence** のみ。
HTTP／CSRF／Origin／Browser／Confirm Commit／Session認可・race／実環境D1／TC全体のPassは証明しない。
公開有効化Gateは詳細設計D1 §8.6を維持し、default Workerは503のままとする。

#865の `unit/student-session-csrf.test.ts` は独立SHA-256 vector、canonical token、
固定43文字全体の比較と設定欠損fail-closedを検証する。
`integration/reservation-preview.test.ts` は実Production Guardとtest-only read sourceを構成し、
exact入力・重複key・UTF-8 byte上限、Session→CSRF→業務認可順、本人ID、固定View / Error、
401のみCookie除去、Guard / digest / read障害・整合性異常の503と内部情報非反射を確認する。
`d1/reservation-preview-http.test.ts` は#863のisolated `AUTH_DB` / migration / read fixtureをそのまま再利用し、
実Guard→HTTP→実Repository→coreでstandard / additional・本人分類差分・token、
失効／停止・CSRF不成立時read未実行、409 / 503・Cookie維持、予約非更新を確認する。
時刻境界は既存Portのtest-only source adapterで注入し、実D1 T0の経路は別testとする。
`integration/worker.test.ts` はPreview / CSRF取得にもdefault Workerが503を維持することを確認する。
`TC-F-003-01 / TC-F-003-02 / TC-F-207-03 / TC-NF-914-04`はHTTP / isolated D1の
**partial evidence**のみで、新TC・Product要求の意味変更はない。
Browser、CSRF token取得、Confirm Commit / race、実環境D1、Production activation、TC全体のPassは証明しない。

#896の `unit/student-session-csrf.test.ts` は取得 / 検証の共有生成関数について、既存独立digest vector、
生成tokenの受入れ・旧Session / 誤token / noncanonical形式拒否と固定長比較を回帰する。
`integration/student-session-csrf-get.test.ts` はProduction `D1StudentAccessGuard` と既存test-only read sourceを使い、
exact 200 JSON、Origin有無 / Metadata、HTTPS / origin設定 / Method / Path / Query / bodyのfail-closed、
Cookie欠損 / 重複 / malformed / 失効 / 停止 / 削除 / role、DB / integrity / crypto障害を検証する。
`d1/student-session-csrf-get.test.ts` は既存file-isolated `AUTH_DB` / Production auth migrationで実Guardを解決し、
独立vector・期限等値 / 失効 / 停止 / 削除の次Request反映、Cookie非更新、DB行の非更新、
関連行欠落・実SQL失敗の安全な503を検証する。fixtureはtests側だけで、Production認証全体のproofとしない。
全Responseのno-store / no-referrer、401 Cookie除去・503維持・200 Cookie未発行、CORSなし、
preauth-only / Cookieなしの401とpreauth生成 / 再利用なしを確認する。
`integration/worker.test.ts` の既存CSRF GETを含む全routeの503試験と既存POST Preview / Confirmを回帰対象とする。
`TC-F-207-02〜03 / TC-F-211-02〜03 / TC-NF-914-03〜04`に関するSession / 認証安全性の
**partial evidence**であり、既存POL→BR→REQ→AC→TC、CON / OOSの意味やidentifierは変更しない。
実環境D1・HTTPS実Browser・trusted seed / dedicated evaluation Worker、full auth / preauth flow・
Production activation・Gate A〜D・System / Acceptance TC全体Passを証明しない。

#869の`unit/reservation-confirm.test.ts` / `d1/reservation-confirm.test.ts`はwrite前preparationの検証。
既存#863のisolated fixture / Guard解決済み本人 / Primary read-only Portを再利用し、
canonical token形式とread前拒否、Preview token再照合、最新業務拒否を優先するmismatch、
重要状態変更、D1 T0、raw JSONの決定性・欠損／NULL・安定順、共有SQLの時刻引数／bind順を確認する。
Overrideでautomaticだけ変化する全内部分類planと実効値だけのwire差分、prepared stateのfreeze、
成功・malformed・mismatch・業務拒否・DB error時の予約／Guard等の非更新を検証する。
`unit/d1-reservation-preview.test.ts`は共通query / mappingとPreview Port非露出も固定する。
`TC-F-003-01 / TC-F-003-02`はApplication / isolated D1の**partial evidence**のみ。
Transaction Guard / Commit / race、Confirm HTTP / Browser、実環境D1、TC全体のPassは証明しない。
新TC・Production migration / bindingは追加せず、既存Workerの503回帰を維持する。

#872の`unit/reservation-confirm-plan.test.ts`はpure Transaction write planの検証。
Audit / Intent JSONのbyte一致・field順、automatic-only監査、両方向の実効変更Intent、
変更なしを含む全Guard対象と実更新対象の安定順、本人不一致・全ID組合せの重複拒否、
最小UUID Port、PII / Session / 保存時刻の非投影、immutable copyと#869 preparation再利用を確認する。
`TC-F-003-01 / TC-F-003-02 / TC-F-101-01 / TC-F-104-01 / TC-NF-940-01 / TC-NF-940-02`の
Application plan **partial evidence**のみであり、DB Commit / final Guard / 配送 / HTTP / Browser / 実D1は証明しない。
既存標準unit suiteとWorkerの503回帰を使用し、新しいproof infrastructureやpublic activationは追加しない。

#873の`d1/reservation-confirm-executor.test.ts`は内部single-batch executorの検証。
既存file-isolated `AUTH_DB`へProduction予約migrationをそのまま適用し、実preparation / pure planを入力とする。
初期raw read-set / Student Write predicate、先行Commit保持・占有UNIQUE、再分類before値・更新件数、
Audit / Intent / Outbox INSERT失敗、exact projection / 件数異常、最終Session / 開始境界と全Rollbackを確認する。
変更あり・automatic-only・変更なしの全`classificationGuardTargets`の開始境界を検査し、
既存予約の開始境界試験では新規Slotをより後に置いてtarget guardによる隠蔽を防ぐ。
時刻・race・応答欠落はtest-only D1 interface adapterから注入し、実SQLを同じPrimary batchで実行する。
成功時の共通Command T・Guard cleanup・同一result、Commit後の応答欠落とRollbackの双方で
同一immutable attempt.plan・ID非再生成・batch 1回・raw error / Session情報非露出を検査する。
Session生成・prepare / bindの失敗は既存`SERVICE_UNAVAILABLE`でbatch 0回、永続化不変、
attempt / raw cause非保持・ID非再生成となることを同じfixtureで検査する。
`TC-F-003-01 / TC-F-003-04 / TC-F-003-05〜06`、`TC-NF-911-01`の内部Command / local D1 **partial evidence**とし、
Audit / Intentの観点は既存`TC-F-101-01 / TC-F-104-01 / TC-NF-940-01〜02`へ対応する。
Session / lifecycleの観点は既存`TC-F-207-02〜03 / TC-F-211-02 / TC-F-311-02`へ対応する。
HTTP / CSRF / Browser、#874のPrimary verification、実環境D1、配送、TC全体のPassは証明しない。
schema変更・public activation・新しいproof infrastructureは追加せず、既存標準D1 suiteで実行する。

#874の`unit/reservation-confirm-transaction.test.ts` / `d1/reservation-commit-verification.test.ts`は
最終server-only Transaction Portとambiguous outcome verificationの検証。
正常応答のread省略、exact handoff限定、same immutable plan / ID、generator / executor各1回、write retryなし、
local D1でのCommit後応答喪失と成功回収、未適用、部分生成・Audit / Intent / Outbox欠落、payload / 内容 / 時刻不一致、
部分再分類、残存guard、単一read-only Primary statement・stable collection ordering・closed projectionを確認する。
read / decode不能と内容不整合のcode分離、最終errorの内部情報非露出も検査する。
#873のGuard / race / rollback suiteは変更・複製せず、既存標準D1 suiteで回帰する。
`TC-F-003-01 / TC-NF-911-01 / TC-NF-914-04`のApplication / local D1 **partial evidence**とし、
HTTP / fresh revalidation / CSRF / Browser / 実D1 / 配送 / TC全体のPassは証明しない。
default Workerの503回帰・既存Product CI / PR Traceability経路を維持し、新しいproof infrastructureは追加しない。

#880の`integration/reservation-confirm.test.ts`は実Guard / CSRF / preparationとtest-only Transaction Portを合成し、
二項目strict wire・順序・same-request Context・exact 201 / error・401 Cookie除去・内部情報非反射を検証する。
exact `REVALIDATION_REQUIRED`だけfresh解決し、fresh本人・現在業務拒否優先・still-validの503、commit最大1回を確認する。
`d1/reservation-confirm-http.test.ts`は既存file-isolated `AUTH_DB` / Production migration / D1 interfaceを再利用し、
実Guard→HTTP→実preparation→最終Transaction Port→executor / verifierでCommit・応答喪失回収、
未適用後のfresh Primary分類・Rollback・Audit / Intent同一Commit、ID生成1回・write非再試行を検証する。
時刻・race・応答喪失は既存interfaceのtest-only adapterから注入し、新しいproof infrastructureは追加しない。
`TC-F-003-01 / TC-F-003-05〜06 / TC-F-207-03 / TC-NF-911-01 / TC-NF-914-04`の
Application / HTTP / isolated D1 **partial evidence**のみであり、新TC IDやProduct要求の意味変更はない。
既存#865 Preview、#873 Guard / race / rollback、#874 verifier / Portとdefault Workerの503は同じ標準suiteで回帰する。
Browser / 実環境D1 / Provider配送 / public activation / TC全体のPassは証明しない。

#888の`unit/reservation-history.test.ts`、`integration/reservation-history.test.ts`、
`d1/reservation-history.test.ts`は`TC-F-005-01`のApplication / D1 / isolated HTTP **partial evidence**。
状態・欠席・実効分類の分離、本人限定、DESC順とcursor継続、不正入力 / MAC / 別本人拒否、
D1 / integrity失敗、no-store / 401 Cookie除去、read-onlyと既存indexのquery planを検証する。
D1試験はProduction migration・Guardをlocalで合成し、cancelled / absence行は保存Schema fixtureで用意する。
取消 / 欠席Command、Production鍵provisioning、public route、Browser、実D1、System / Acceptance全体Passは証明しない。


#894の `unit/student-read.test.ts` はCalendar / List / 4 Slot View・選択・本人履歴の
`TC-F-001-01〜02 / TC-F-002-01〜02 / TC-F-005-01` と
`TC-NF-903-01 / TC-NF-907-01 / TC-NF-914-03〜04` の **partial evidence**。
Gregorian曜日・閏年・月年境界、+09:00表示、4状態、本人状態軸、cursor継続/最新、GET限定、
401 / 403 / 404 / 503・通信失敗・不正応答非反射、並行readの古い応答排除・401双方無効化を検証する。
test-only structural DOM adapterでlabel・button / 非活性説明・切替focus維持・status focus・
複数/大量枠の非省略を確認する。実DOM、layout計測、実keyboard / screen reader / Browser互換性の証明ではない。
`integration/worker.test.ts` は `/student` / UI資産 / 本人履歴へのdefault HTTPが503 / no-storeのままなことを回帰する。
320px overflow、端末timezone別実Browser、HTTPS / asset serving、Gate A〜DとTC全体Passは#537へ保持する。
