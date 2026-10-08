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
Production Guard実装は下記#842を参照し、test-only fakeは `tests/integration/` に限定する。
`index.ts` / default Workerからの接続、Production binding / migration、認可迂回switchは追加しない。

`infrastructure/d1-student-access-guard.ts` は#842のProduction Guard Adapter。
Student専用Cookieの重複・canonical token形式を検査し、Server側SHA-256 hashをbindして
毎Requestの `withSession('first-primary')` 単一SELECTから共有ViewとD1時刻を読む。
期限・失効→関連行Invariant→lifecycle / SecurityAccess→Student roleの順に判定する。
既存read-only Portの3結果は維持し、`StudentAccessError` のDB / Integrity異常は
HTTPの既存503へ安全に変換する。401では設計 §10.2のSession Cookie除去、503では維持する。
`resolve(request)` は同一RequestのWrite用内部Contextだけを返す共有解決処理であり、
HTTP Viewへ渡さない。将来のunsafe consumerは §10.3のCSRF / Origin検証と
D1 §8.3のTransaction内初期・最終再照合を別途必須とする。
Guard / HTTP / Serviceは明示注入でcomposition可能だが、default Workerは引き続き503。
Production設定・Provider callback・Session発行・Reservation Confirm・Admin authは未接続。

`application/reservation-preview.ts` は#860の単一予約Preview pure core。
Guard解決済み本人・確定Preview read state・Server UTC秒から新規分類と本人の未開始予約の
実効分類差分を導出する。開始済み自動分類、算入除外、明示Overrideは既存設計に従う。
`createPreviewPlan` は内部canonical Snapshot、`expectedStateToken` はWeb標準SHA-256による
`v1.` tokenを生成し、後続Preview / Confirmから同じ計算を再利用できる。
`previewReservation` のViewは詳細設計Application §5の4 fieldだけとし、Snapshot・N・本人IDを公開しない。
canonical v1のfield順・値型・Tokyo日時・予約順は明示projectionとunit assertionで固定し、
実時刻は含めず対象／各予約の開始境界を含める。D1正本 §4の当月全Reservationを含み、
設定行欠損はnull（N=3）、明示設定はobjectとして区別する。Repositoryは完全なread setと
投影外Invariantを検証し、未検証ならintegrityをinconsistentとして渡す責務を持つ。
`tests/unit/reservation-preview.test.ts` は `TC-F-003-01 / TC-F-003-02` のApplication/Preview
**partial evidence**であり、HTTP / Browser / Confirm CommitやTC全体のPassを意味しない。
HTTP・Session CSRF / Originの統合は下記#865を参照し、Confirm writeは未実装で、default Workerは引き続き503。
tokenは認可ticketでもSlot確保でもなく、Confirmは本人再解決・最新再計算・Transaction Guardを必須とする。

`infrastructure/d1-reservation-preview.ts` は#863の未接続・read-only D1 Repository Adapter。
Guard解決済み本人とSlotからPrimary起点の単一SELECTでD1時刻T0、共有認証Viewの最新操作可否、
対象月・Slot・占有、N、本人同月の全Reservationと例外状態を取得する。
`readPreview` は `{ state: PreviewReadState, evaluatedAt }` を返し、後続Confirm事前readでも再利用できる。
日時・型・分類／取消・未開始占有・両管理詳細のInvariantを検査し、異常は既存
`ReservationPreviewError` の `INTEGRITY_STATE_UNAVAILABLE`、D1実行失敗は `SERVICE_UNAVAILABLE`。
他生徒占有はSQL内で検証して安全な既存拒否へ抽象化し、他生徒ID・予約IDをApplication stateへ投影しない。
分類plan・canonical Snapshot・tokenは既存pure coreだけを再利用する。
Production migration・binding・HTTP・Confirm writeへの接続はなく、isolated検証範囲は
[`tests/README.md`](../tests/README.md) を参照する。

`http/reservation-preview.ts` は#865のEndpoint専用HTTP Adapter。
`application/reservation-preview.ts` の最小Repository Port / Serviceに、既存
`D1ReservationPreviewRepository`を注入し、`D1StudentAccessGuard.resolve()`と明示compositionする。
HTTPS / exact Method・Path / Queryなし / JSONのexact object / UTF-8最大8192 byteを検査し、
Session→Session-bound CSRF / Origin→業務認可→read / pure coreの順を維持する。
Cookie parserは`infrastructure/student-session-cookie.ts`をGuardとCSRFで共用し、
raw tokenをApplication Contextへ追加しない。`http/student-session-csrf.ts`はServer設定のcanonical
HTTPS origin完全一致とFetch metadata、domain付きSHA-256 tokenのcanonical形式・固定長比較を検証する。
設定／digest利用不能は503、不成立は`CSRF_INVALID`。error envelopeと401 Cookie除去は
既存Schedule HTTPと`http/application-error.ts`を共用する。
`GET /api/auth/student/csrf`、Provider flow、Confirm、Production migration / binding / routeは未接続。
default Workerは全Requestで503を維持し、対象環境D1・Browser・public activationの証明とはしない。
