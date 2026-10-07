# Source code

Application source code will live here. Planned areas include web/UI, API, application/domain logic, infrastructure adapters, and shared code.

`index.ts` はApplication Workerの最小ES modules entrypointで、現在はすべてのRequestにHTTP 503を返す。
公開業務Endpointは未接続。開発基盤の技術契約と残りのbootstrapは [config/README.md](../config/README.md) を参照する。

`application/schedule-query.ts` は#828のpure Schedule Query coreで、Guard解決済みの本人IDと
Repositoryの確定read stateから4種Slot Viewを導出する。Repository Port / Clockを注入し、
未来Slotの不整合は `INTEGRITY_STATE_UNAVAILABLE`、未公開・存在しない月は
`SCHEDULE_MONTH_NOT_AVAILABLE` とする。設計正本は
[`01_StudentReservationApplication.md`](../docs/20_detailed_design/01_StudentReservationApplication.md) §2〜4 / §8と
[`02_StudentReservationD1.md`](../docs/20_detailed_design/02_StudentReservationD1.md) §4。
entrypointからcoreへの接続はない。HTTP / Guard Portの統合は下記#831を参照する。

`infrastructure/d1-schedule-query.ts` は#830のread-only D1 Adapterで、同じRepository Portを実装する。
月・Slot・占有・参照予約と全confirmed予約を単一SELECTで取得し、日時・管理詳細・分類／算入の
既存Invariantを検査してcoreへ渡す。D1実行失敗は内部診断を含まない
`ScheduleQueryDatabaseError`（`SERVICE_UNAVAILABLE`）、未来Slotの永続化不整合は
既存coreの `INTEGRITY_STATE_UNAVAILABLE` で区別する。structural D1 interfaceだけを使い、
HTTP / Guard / binding / dispatch / Production migrationは追加しない。

`http/schedule-month.ts` は#831のEndpoint専用HTTP Adapterで、
`GET /api/me/schedule-months/{month}` の暦月形式・Method・未定義Queryを検証する。
`application/student-access-guard.ts` のStudentAccessGuard Port成功結果だけを本人IDとして
Serviceへ渡し、成功Viewと既存Application Errorを上記詳細設計 §4 / §8のJSONへ変換する。
GuardのProduction物理契約は#636で詳細設計 `02_StudentReservationD1.md` §8へ確定した。
Production実装・接続は後続実装で行い、test-only fakeは `tests/integration/` に限定する。
`index.ts` / default Workerからの接続、Production binding / migration、認可迂回switchは追加しない。
