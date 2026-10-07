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
