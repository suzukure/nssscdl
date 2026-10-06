# Source code

Application source code will live here. Planned areas include web/UI, API, application/domain logic, infrastructure adapters, and shared code.

`index.ts` はApplication Workerの最小ES modules entrypointで、現在はすべてのRequestにHTTP 503を返す。
業務Endpointや成功応答は未実装。開発基盤の技術契約と残りのbootstrapは [config/README.md](../config/README.md) を参照する。

`application/schedule-query.ts` は#828のpure Schedule Query coreで、Guard解決済みの本人IDと
Repositoryの確定read stateから4種Slot Viewを導出する。Repository Port / Clockを注入し、
未来Slotの不整合は `INTEGRITY_STATE_UNAVAILABLE`、未公開・存在しない月は
`SCHEDULE_MONTH_NOT_AVAILABLE` とする。設計正本は
[`01_StudentReservationApplication.md`](../docs/20_detailed_design/01_StudentReservationApplication.md) §2〜4 / §8と
[`02_StudentReservationD1.md`](../docs/20_detailed_design/02_StudentReservationD1.md) §4。
HTTP / Guard / D1 AdapterとProduction接続は後続責務で、entrypointからcoreへの接続はない。
