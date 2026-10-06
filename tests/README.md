# Tests

自動Unit / Integration / End-to-End Testを格納する。

要求ベースのSystem / Acceptance Test Specificationとトレーサビリティは `docs/40_test/` を正本とする。
自動テストを要求テストへ対応付ける場合は、test name / tag / metadataに `TC-F-...` または `TC-NF-...` のTC IDを保持する。

`unit/schedule-query.test.ts` は#828のfake Repository / deterministic Clockによるpure core検証。
`TC-F-001-01` / `TC-F-001-02` / `TC-F-002-01` / `TC-F-002-02` は
API/read-model **partial evidence** としてtest nameに記し、System/Acceptance TC全体のPassへ算入しない。
4種View、本人情報だけの投影、開始境界、未公開月、未来Slot不整合のfail-closedを検証する。
HTTP認可・D1整合性検査の実統合およびUIはこのunit testの証明範囲に含まない。

#638の基盤smokeには `[bootstrap #638]` をtest nameに付け、業務TCのPass件数へ算入しない。
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
