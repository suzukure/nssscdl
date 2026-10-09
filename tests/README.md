# Tests

自動Unit / Integration / End-to-End Testを格納する。

要求ベースのSystem / Acceptance Test Specificationとトレーサビリティは `docs/40_test/` を正本とする。
自動テストを要求テストへ対応付ける場合は、test name / tag / metadataに `TC-F-...` または `TC-NF-...` のTC IDを保持する。

#898の `fixtures/d1/trusted-student-seed.ts` はoperator / trusted test process専用のseed helper。
Callerが専用の空local D1へProduction `0001`〜`0012`を一度適用し、既存validation SQLを渡す。
Table / Index / View / Triggerの定義fingerprint、未知schema、全業務Tableの空条件と既存Integrity scansを確認する。
seed時も同一batch内で空条件を再照合し、非空・不正schema・batch失敗では固定errorで停止し、修復・reset・retryしない。
失敗・応答不明時はtrusted setupで専用DBを調査・破棄し、同DBへの自動再実行はしない。
架空生徒2人・active Access・student Account・独立した1日期限Session、次の東京暦月15日の公開未来5枠、
本人/他人のconfirmed standard予約と占有、Group/Admin詳細だけを準備する（既定N=3、Provider送信なし）。
CSPRNG 32byteのcanonical tokenはDBにはSHA-256 lowercase hashだけ保存する。
返却 `sessions.self/other.cookie()` だけが生tokenとSecure / HttpOnly / SameSite=Lax / Path=/ / Domainなしの属性を渡す。
Session返却objectのJSON化は生tokenを含まないが、`cookie()`の結果は秘密値としてmemory内だけで扱い、Log / Artifactへ出さない。
実BrowserContext・HTTPS origin設定は後続責務。seedの専用persistent D1接続は以下の#906 opt-inで検証する。
`d1/trusted-student-seed.test.ts` / `d1/trusted-student-seed-failures.test.ts` は既存file-isolated `AUTH_DB`で
全12migration、FK / auth / reservation scans各0行、実Production Guard + Read Repositoryの4 View・本人履歴・
他生徒情報非公開、Session role/owner/expiry/hash、失効後401、GET非更新、非空・未知/不正schema・競合・Rollbackを検証する。
`TC-F-001-01〜02 / TC-F-002-01〜02 / TC-F-005-01 / TC-F-207-02〜03 / TC-NF-914-04`のlocal D1 **partial evidence**であり、
Auth flow・Browser・Confirm atomicity全体、Gate A〜D、System / Acceptance TC全体のPassには算入しない。
通常 `src/` / Worker / Browser bundle / `wrangler.jsonc`にはseedをimport・接続しない。

#899の `fixtures/read-only-student-service.ts` は非公開のRequest serviceであり、listener / runnable mainを持たない。
trusted runtimeが単一の隔離D1 binding、canonical HTTPS origin、non-exportable HMAC-SHA-256署名専用`CryptoKey`を渡し、
実Production Guardと既存Schedule / History / Session CSRF GET Adapterを一箇所で合成する。
設定不備、異なるRequest URL origin / protocol、未対応Path / Methodは既存safe errorの503。
3 GET内の400 / 401（Cookie除去）/ 403 / 月不存在・未公開404 / 503、no-store、CSRFのno-referrerは既存契約を維持する。
`d1/read-only-student-service.test.ts` は#898 seedと既存file-isolated `AUTH_DB` / Production migrationsを用い、
本人履歴・cursor継続 / 別本人 / 別鍵 / 改ざん拒否、Origin拒否、任意identity非採用、read-only / Primary readとsafe errorを検査する。
有効な別roleの403は既存D1 Portのtest-only row projectionで実Guardを通す（Student専用SchemaへAdmin行を保存しない）。
`integration/read-only-student-isolation.test.ts` は全Product sourceの参照先が`src/`内に閉じ、評価fixtureをimportしないことを検査し、
既存 `integration/worker.test.ts` がdefault Workerの3 GET / POST / UI資産の全503を回帰する。
`TC-F-001-01〜02 / TC-F-002-01〜02 / TC-F-005-01 / TC-F-207-02〜03 / TC-F-211-02 / TC-NF-914-04` の
HTTP / local D1 **partial evidence**のための試験であり、Product要求・AC→TCの意味を変更しない。
標準Product CIによるcurrent-head証跡はworkflow側で別に確認し、ローカル自己申告をformal CI successと扱わない。
#902の入口・local config・key生成の準備と#904のopt-in runtime proofは以下を参照する。
Browser assets配信・Cookie接続、unsafe APIの有効化、Provider / remote D1、Gate A〜D、
System / Acceptance TC全体のPassは後続#537 / #608へ残す。

## #902 localhost HTTPS read-only入口の準備

`evaluation/worker.ts` / `evaluation/wrangler.jsonc` は評価専用のES-module入口とconfig。
canonical originはserver側の `https://127.0.0.1:8788` 固定で、Host / Header / Queryから導出しない。
公開route / account / remote識別子 / assets / scheduled / varsを持たず、`workers_dev` / `preview_urls`はfalse。
専用binding `EVALUATION_READ_DB` のUUIDはlocal-only placeholderであり、通常`TEST_DB` / `AUTH_DB`と共有しない。
既存#899 serviceだけを使い、3 GET以外のPath / Methodは503。Sessionなしは既存401、CSRFのOrigin拒否は既存403。
HMAC-SHA-256 non-exportable sign-only鍵をWeb Cryptoで一度生成し、並行Requestは同じPromiseを共有する。
生成失敗は再起動まで503とし、鍵・binding不備はCookieなしでも503。再起動 / hot reload後は旧cursorを使わず、
cursorなしで履歴を再取得する。鍵のexport / fallback / Production鍵の流用はしない。

`integration/evaluation-worker.test.ts` は専用handlerの実`fetch`から既存service / 実Guard / Adapterへ接続し、
既存D1 Portのtest-only sourceで401、本人履歴・cursor継続、並行key生成、再起動後の別鍵拒否、
設定不備・誤URL origin・未対応routeの503、default Workerの全503と専用configの閉じた構造を確認する。
これは既存Workers test runtime内のHTTP / Harness部分証拠であり、実localhost HTTPS接続や専用D1実Listenerの証拠ではない。
通常config不変・Product sourceの評価module非importは `integration/read-only-student-isolation.test.ts` が担当する。
`TC-F-001-01〜02 / TC-F-002-01〜02 / TC-F-005-01 / TC-F-207-02〜03 / TC-F-211-02 / TC-NF-914-04`の
要求・AC→TCは変更せず、既存#898 / #899のD1部分証拠を再実装しない。

#902のlocked Wrangler 4.146.0 CLI flagsと専用configの非deploy dry-runは、
PR #903の正式Product CI #37876452937で確認済み（供給Issue contextの証拠）。
単一`EVALUATION_READ_DB`のみのbundleと`--dry-run: exiting now.`を確認した証拠であり、
実Listener / TLS / 専用D1疎通を証明しない。専用entrypoint / configは#904で変更しないため、
この証拠を再利用する。変更した場合はcurrent-headのhelp / 専用dry-runを再実施する。
Wrangler 4.146.0の`dev --help`にない`--no-infer-origin-from-routes`を使用しない。

## #904 opt-in localhost HTTPS / isolated D1 runtime proof

`evaluation/local-https-smoke.mjs`はoperator / trusted test process専用で、通常build / 全PRのCIからは起動しない。
Linux、Node 24、locked Wrangler 4.146.0とlocal workerdの準備、OpenSSL、`ss` / `ps`、
loopback listenとprocess group signalを許す外部通信禁止環境が必要。外部依存の取得・login / deploy / tunnel / remoteは行わない。
継承credential / proxy / TLS無検証設定をchildへ渡さず、HOME / config / log / certを専用一時directoryへ隔離する。
root / `tests/` / `tests/evaluation/`の`.env*` / `.dev.vars*`（`.env.example`を除く）、
既存専用persist、port衝突、専用config不一致では開始しない。既存dataをreset / 再利用しない。

リポジトリrootで開始する（明示`--run`が必須）。停止は同じterminalのCtrl-C。

```sh
node tests/evaluation/local-https-smoke.mjs --run
```

runnerは固定版の`dev --help`で`--https-key-path` / `--https-cert-path`だけを追加照合する。
一時directoryへ1日期限の自己署名RSA証明書を`openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1`
と`-subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`で作成し、
`openssl verify -CAfile <temporary>/server.pem -verify_ip 127.0.0.1 <temporary>/server.pem`で確認する。
HTTPS clientはそのcertだけを明示信頼し、hostname検証を有効にする。OS trust storeは変更せず、
`curl -k`、`NODE_TLS_REJECT_UNAUTHORIZED=0`、Browser security disableは使わない。
key / cert / raw child logはGit / Artifact / stdoutへ出さない。

実行するWrangler commandは以下の固定argv（temporaryはrunnerが作るdirectory）。

```sh
WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler d1 migrations apply nssscdl-local-read-only-evaluation --config tests/evaluation/wrangler.jsonc --local --persist-to .wrangler/student-read-only-evaluation
WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler dev --config tests/evaluation/wrangler.jsonc --ip 127.0.0.1 --port 8788 --local-protocol https --persist-to .wrangler/student-read-only-evaluation --https-key-path <temporary>/server.key --https-cert-path <temporary>/server.pem
```

専用DBだけに正本`migrations/0001`〜`0012`を一度適用する。seed / Cookie入力はない。
local SQLiteをread-onlyで観察し、migration履歴12件、正本DDLから独立作成したexpected schemaとの一致、
全業務Tableの空条件、FK / `validation/student_auth.sql` / `validation/reservation.sql`の独立12 scan各0行を確認する。
Listenerの待機だけは30秒上限、各requestは5秒、CLIは30秒上限とし、操作の自動再実行はしない。
`ss`で8788のListenerが`127.0.0.1`の1本だけで、listener PIDが起動したprocess groupに属することを確認する。
同じgroupのinspector / internal TCP Listenerも`127.0.0.1`だけであることを確認する。
これはlocal smokeの停止用上限であり、Wranglerの起動時間保証ではない。

実HTTPS requestの固定入力・期待値は既存service / Application Error / CSRF GET契約に従う。

| 入力（Cookieなし） | 期待する証拠 |
| --- | --- |
| GET `/api/me/schedule-months/2026-11`、`/api/me/reservations`、`/api/auth/student/csrf`、`Sec-Fetch-Site: same-origin` | 401 / 固定safe error / Session Cookie除去のみ |
| CSRF GET、`Origin: https://127.0.0.1:8788` | 401 |
| CSRF GET、OriginとMetadataなし / 異Origin / 正Originと`Sec-Fetch-Site: cross-site` | 403 `CSRF_INVALID`、Cookie発行なし |
| unknown GET / 3 GET pathへのPOST | 503、Cookie発行なし |
| 履歴GETの`Host: localhost:8788` | TLS IP SANの厳密検証による拒否、またはWorker側の503。いずれもCookie発行なし（Hostからcanonical originを推測しない） |
| TLS portへのHTTP | transport拒否または非redirectの4xx/5xx。HTTPSへの成功と扱わない |

JSON全体が固定safe errorと一致し、全応答no-store / CORS公開なし、CSRFはno-referrerを確認する。
GET/POST検査後もschema / migration履歴と全業務Tableの空条件が不変であることを確認する。
Cookieなし401は有効SessionのD1 read、200、CSRF issuanceを証明しない。
default Workerの全503とProductから評価moduleへ非到達の独立proofには既存試験を併用する。

```sh
node_modules/.bin/vitest run tests/integration/evaluation-worker.test.ts tests/integration/read-only-student-isolation.test.ts tests/integration/worker.test.ts
node --test tests/evaluation/local-https-smoke.test.mjs
```

後者は正本migration / 不正schema・非空・履歴欠落 / safe wire / process停止 / 明示trust・誤IP SAN拒否の
有限fixtureによる補助検査であり、Wrangler実Listenerの代用ではない。
`try/finally`でprocess groupへSIGINTを送り、10秒内に停止しない場合はSIGKILLして失敗とする。
CLIのtimeout / 中断でも同じ停止確認を行い、migration用childを残してcleanupへ進まない。
さらに5秒内のprocess終了と8788閉鎖を確認した後だけ、そのrun所有の専用persistと一時cert / logを破棄する。
process / portが不明なら専用filesを残して停止し、operatorが確認する。自動retry / 修復はしない。
専用bundleは作成しないため、既存`dist/`、通常test DB、他runのpersistは削除しない。

stdoutはcommit / UTC日時 / Node・Wrangler・OpenSSL / OS / config・binding identity、
IP SAN、route/statusと固定safe response検査、D1整合性・無副作用、停止 / cleanupの非機密checkpointのみ。
source SHAだけでは未commit変更の同一性やformal CIを証明しない。人間は検証対象差分とcurrent-head CIを別途確認し、
このcheckpointを#904 / #537へ記録する。部分検証失敗 / runtime不足は未検証としてIssueをOpenに保つ。
`TC-F-001/002/005/207/211`、`TC-NF-914`のlocal runtime **partial proof**のみで、
業務POL→BR→REQ→AC→TC / CON / OOSの意味、Browser Gate A〜Dの判定は変更しない。

## #906 opt-in trusted seed / actual persistent local D1

`evaluation/trusted-evaluation-seed.mjs`の`withTrustedEvaluationSeed(callback)`は既存#898の
`seedTrustedStudents` / `TrustedSeedSession.cookie()`を直接使う。Node 24 / locked Wrangler 4.146.0、
既存専用configの完全一致、credentialを継承しない専用Node環境、env filesなし、
正本12migration適用済みの専用空persistと停止済みWorkerが前提。通常`TEST_DB` / `AUTH_DB`へ接続しない。
`getPlatformProxy`は`configPath: tests/evaluation/wrangler.jsonc`の絶対path、`remoteBindings:false`、
`persist.path: .wrangler/student-read-only-evaluation/v3`の絶対pathに固定する。
CLIの`--persist-to .wrangler/student-read-only-evaluation`との対応はschema / migration履歴と
seed後の別proxy読取りで実測する。未知schema・非空・再seed・設定不一致・remote指定は固定errorで停止する。

```sh
node --test tests/evaluation/trusted-evaluation-seed.test.mjs
node tests/evaluation/trusted-seed-smoke.mjs --run
```

後者はLinux / Node 24 / locked依存 / local workerd / `ss`とprocess group停止を許す環境で明示opt-inする。
所有runnerが新規専用persistを作り、#904と同じ固定CLIで12migrationを一度適用する。
既存persist / env files / port 8788使用中では開始しない。Listener・証明書・Browserは起動しない。
seed proxyの`dispose()`を待った後だけ同一Node processの限定async callbackへ専用Session objectを渡す。
callback中はpersistを保持し、戻り値は破棄する。callback失敗も原因なしの`TRUSTED_EVALUATION_SEED_FAILED`。
raw Cookieはargv / env / URL / Log / Assertion diff / snapshot / Artifact / temp fileへ渡さず、DBにはhashだけ保存する。
callbackはtrusted caller専用であり、自由にLog・保存するuntrusted callbackを受け付ける公開入口ではない。

実試験`evaluation/trusted-seed-process.mjs`は別actual proxyでschema / 全12migration履歴、FK / Auth / 12予約scan、
Tokyo次月15日・公開未来5枠・本人/他人の予約とSession owner / hash / 1日期限を確認する。
二度目のseed拒否後の全Table digest不変、専用persist / 一時Log内のraw値非存在をmemory内で検査する。
seed・batch失敗／結果不明にretry・修復・upgrade・DELETEは行わない。停止はCtrl-C。
各child command上限60秒、停止確認は#904のSIGINT 10秒＋必要時SIGKILL 5秒を再利用する（強制停止は失敗）。
成功・失敗ともproxy破棄、全所有process groupと8788閉鎖を確認してから所有persist / 一時Logのみ削除する。
停止不明なら保持してoperator確認へ戻す。通常`.wrangler/d1-bootstrap-test`等は触らない。
有限Port fixtureは正常／異常dispose・callback秘匿・batch rollback／応答不明・schema／非空拒否の補助検査で、actual proxyの代用ではない。

Product CIではPR bodyの`[evaluation-seed-proof-906]`指定による一時stepで両commandを実行した。この一時stepは除去済み。
正式成功はworkflow側の対象head / UTC実行日時 / 結果と非機密checkpointで確認し、#906 / 親#537へ記録する。
一時stepを最終PRから除去する場合は対応workflow fixtureも同期し、実証headとfinal headの実行対象blob完全一致とfinal-head標準Product CI成功を別に確認する。
依存欠落・offline・部分検証成功をformal successと扱わず、検証未達なら#906はOpenに保つ。
`REQ-001/002/005/207/211`の既存AC→`TC-F-001-01〜02/002-01〜02/005-01/207-02〜03/211-02`、
`TC-NF-914-04`の**local setup partial evidence**のみ。POL→BR→REQ→AC→TC、CON / OOSの意味は変更しない。
秘密Cookieから実HTTPS 3 GETへの接続・200／改ざん／失効／non-public確認、BrowserContext、
実Auth flow・Preview / Confirm、Gate A〜Dは今回の成功に含めず、供給Issueの後続責務として保持する。

## #908 opt-in trusted Session / same-D1 HTTPS 3 GET

`evaluation/trusted-https-smoke.mjs`は#906の所有runnerを再利用する明示opt-in入口。
通常CI / buildからは起動せず、#904 / #906と同じLinux、Node 24、locked Wrangler 4.146.0、
`ss` / `ps` / OpenSSL、local workerd・loopback socket・process group停止が利用可能な環境で実行する。

```sh
node --test tests/evaluation/trusted-https-smoke.test.mjs
node tests/evaluation/trusted-https-smoke.mjs --run
```

所有runnerはcredentialを継承しない環境でfresh専用persistへ12migrationを適用し、
`evaluation/trusted-https-process.mjs`を起動する。childが#904の一時IP SAN証明書を準備し、
`withTrustedEvaluationSeed(callback)`のseedとproxy dispose後、同一persistの専用Workerを起動する。
Sessionはこのchildのmemoryにだけ保持し、`TrustedSeedSession.cookie()`から固定
`https://127.0.0.1:8788`の正規Cookie headerへ渡す。明示CA / hostname検証を維持し、
Worker・関連Listenerのloopback限定と所有process groupを#904のhelperで確認する。
Owner argv / env / IPC / URLへtokenを渡さず、BrowserContext / assets / unsafe業務操作は接続しない。

| 実HTTPS検査 | 既存正本から導いた期待値 |
| --- | --- |
| self / otherそれぞれSchedule・History・CSRF | 各200。公開未来月5枠の4 View、本人のreservationIdだけ、本人confirmed履歴1件とstandard区分。JSON全体一致で他人ID / 内部個人情報 / Session hash混入を拒否 |
| CSRFのOrigin / same-origin metadata | session scope、Application §10.3の生成式との同一Session相関、異なるSessionのCSRF不一致。値はmemory内だけで比較 |
| Cookie欠損・偽・canonical形式の改ざん | 3 GET各401とcanonical clear Cookie。identity headerは認証の代替にならない |
| 有効Cookie＋別Student identity header / Query | headerを無視して本人200。未定義Queryは既存HTTP Adapterどおり400で拒否し、別Studentへ切り替えない |
| 有効Cookie＋CSRF Origin / metadata不正 | 403。Cookie新規発行なし |
| 有効Cookie＋未知GET / 3 GETへのPOST | 503。read-only境界が開かない |
| 停止→本人Session失効→再起動 | 閉鎖8788を確認した後だけfresh local-only proxyでselfの`revoked_at`を一度更新・dispose。同じD1で旧selfの3 GETは401、otherの3 GETは200 |

全Responseはno-store / No CORS、認証CSRFは成功・失敗ともno-referrer、401以外はCookie発行なし。
`evaluation/trusted-https-assertions.mjs`の期待値は#898 seed / #899 service / Production HTTP wireに基づき、
実出力から生成しない。例外やsecret-bearing assertion diffはownerへ返さない。
`evaluation/trusted-seed-process.mjs`の既存schema / migration履歴 / integrity検査を再利用し、
Worker停止後の全Table snapshot比較はselfの検証済み`revoked_at`だけを正規化する。
他Session / 予約・占有 / Audit / Provider等の変更は許容しない。Session expiry境界は再実装しない。
raw Session / CSRFの所有persist・一時file内非存在、hashの一時log内非存在とargv / env非露出をmemory内で検査する。

childは90秒で中断、ownerは120秒（停止10秒＋必要時5秒とmarginを含む）で打ち切る。
HTTPは#904同様5秒 / response 4096文字上限。失敗・timeout・停止不明では固定非機密errorで終了し、
専用persist / cert / logを保全してoperator確認へ戻す。停止の自動retry・DB resetを行わない。
成功時はproxy dispose、Workerと所有child groupの停止・port閉鎖後に、そのrun所有filesだけをcleanupする。
通常config / 通常test DB / 他runのfilesを変更・削除しない。

補助fixtureの成功はWrangler実Listener証明ではない。正式証拠は既存Product CIのopt-in一時step等で
上記2commandを実行し、対象HEAD / UTC日時 / versions / config / status・schema・scope / cleanupの
固定非秘密checkpointを確認する。現在の恒常CIに本opt-in stepはない。
一時CI変更を除去する場合はproof-headとfinal-headの実行対象Git blob完全一致、およびfinal-head標準Product CI成功を
別々に確認する。同一HEADで実疎通した証拠と混同せず、実証未達なら#908はOpen / Draftを維持する。
`REQ-001/002/005/207/211`の既存AC→`TC-F-001-01〜02/002-01〜02/005-01/207-02〜03/211-02`、
`TC-NF-914-04`の**local HTTPS partial evidence**だけを追加する。POL→BR→REQ→AC→TC、CON / OOSの意味は変更しない。
30日期限・Logout / Suspension操作全体、実Auth / Browser / Preview / Confirm / Provider / remote D1、Gate A〜Dは未検証。

## #915 opt-in isolated Chromium TLS trust proof

`evaluation/browser-tls-trust.mjs` はLinux / Node 24のtransport専用harness。
通常build / test / 恒常CIからは起動しない。Cookie / Student / D1 / CSRF / UIを接続しない。
`playwright-core@1.64.0`をdev-onlyで固定し、runner上の実在browserを明示指定する。
browser download / global install / 外部通信 / OS trust変更は行わない。
`playwright-core@1.64.0`のlock entry（SHA-512 integrity、license、bin、engines）は、
[正式Actions #37912192152](https://github.com/suzukure/nssscdl/actions/runs/37912192152) で
npm公式registryから取得した情報を基に生成・照合し、同runで`npm ci --ignore-scripts`が成功した。
lockとrootのdev-only固定版は一致。恒常CIでは通常の`npm ci`を用いる。
一時診断stepは最終差分から撤去するため、最終HEADの標準Product CIは別途確認する。

前提はinstalled Chromium / Google Chrome、`/usr/bin/certutil`（Debian/Ubuntuの`libnss3-tools`）、
OpenSSL、`ss`、読み取り可能な同一userの`/proc`、Chromium sandboxを有効にしたlocal実行環境。
runnerにツールがない、version / HOME / NSS path / process終了が曖昧なら固定診断で停止する。
不足ツールの導入やfallbackは行わない。browser sandbox / TLS検証を無効化しない。
raw driver logを出さないため`DEBUG` / `PWDEBUG`設定時は開始しない。

```sh
NSSSCDL_CHROMIUM_PATH=/usr/bin/chromium node tests/evaluation/browser-tls-trust.mjs --run
NSSSCDL_CHROMIUM_PATH=/usr/bin/chromium node tests/evaluation/browser-tls-trust.mjs --run --fail-after-positive
node --test tests/evaluation/browser-tls-trust.test.mjs
```

第2commandは意図的失敗（exit 1）で、positive直後の停止・cleanupを正式実環境でも確認する。
Ctrl-C / SIGTERMも停止対象で、自動retryしない。各navigationは5秒、CLIとbrowser launchは30秒、
browser closeは10秒、process消滅確認とserver closeは各5秒の停止用上限（外部の性能保証ではない）。
失敗時もbrowser終了を先に確証し、HTTPS listener / port閉鎖後だけowned filesを削除する。
確認不能ならserver停止を試み、HOME / NSS / profile / cert / keyを保全して人間調査へ戻す。

run専用mkdtemp HOME（0700）と独立profileを作り、child envは許可したpath設定だけを渡す。
Chromium公式[Linux Cert Management](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md)
に従いM146以降は`HOME/.local/share/pki/nssdb`、以前は`HOME/.pki/nssdb`を明示する。
両候補が空の新HOMEだけを使用し、選ばなかった候補が出現したら停止するため、legacy優先の曖昧さを持ち込まない。
`certutil -N --empty-password`後、#904の`createCertificate`を再利用した1日限定自己署名server cert
（IP SAN `127.0.0.1`）1枚だけを`-A -t "P,,"`で登録する。
listing / nickname / fingerprint / SANを確認し、ブラウザprocessの実HOMEを`/proc`で照合する。
専用profileだけをNSS隔離の証拠にはしない。

test-only Node HTTPSは`127.0.0.1:8788`だけで固定非機密textを返す。port衝突は停止する。
同一persistent BrowserContextの実navigationで次を検査する（Node TLS client / APIRequestContext / mockを使わない）。

| 入力 | 必須結果 |
| --- | --- |
| 登録済みcert、`https://127.0.0.1:8788/trusted` | HTTPS 200 / 固定text |
| 同じ登録済みcert、`https://localhost:8788/san-mismatch`（resolverで127.0.0.1へ固定） | `net::ERR_CERT_COMMON_NAME_INVALID`、HTTP handler未到達 |
| 未登録の異なる自己署名certへserver contextを切替、同じIP origin | `net::ERR_CERT_AUTHORITY_INVALID`、HTTP handler未到達 |

不特定hostnameはresolverで拒否し、proxyを使わない。TLS session ticketを無効化し、応答はconnection closeとする。
`ignoreHTTPSErrors`はfalse、無検証flag / policy / global trust変更なし。
`withIsolatedBrowserTls(callback)` は正負probe後のowned context / 固定originだけをcallbackへ渡し、
callback終了後も同じ停止・保全契約を適用する最小test helper。#914の明示`workerHandoff`だけは
正負probe後にNode listener / socketを停止し、port閉鎖を確認して同じcontext / origin / cert pathsを渡す。
この経路だけは公開`chromium.launch()` / `Browser.newContext()`を使い、callbackへ`browser`を明示渡す。
default proof / CLIはWorker・Cookie・D1を接続しない。
非秘密checkpointはHEAD / UTC / Node・browser exact version・binary / NSS tool・OpenSSL版、
HOME相対NSS path、証明書fingerprint、固定正負結果、cleanup、未実施事項だけ。
key / cert本文 / raw browser error / child envはstdout / Artifactへ出さない。

小fixtureはpath規則・env / TLS設定・証明書1枚限定・error分類・正常と意図的失敗のcleanup順序・
状態不明時の非削除・CLI非秘密診断の**supplementary partial evidence**のみ。
正式Actions proofは既存Product CIへ一時opt-in stepを接続して上記実browser2commandを実行し、
成功runと意図的失敗runの終了・cleanupを記録する（後者の期待exit 1を成功probeへすり替えない）。
一時stepは最終差分から撤去し、proof HEAD / final HEADの実行対象blob一致、final HEAD標準Product CI /
PR Traceabilityを別途確認する。Codexのローカル報告・fixtureだけは正式実Browser証拠に算入しない。
このTLS-only proofをBrowser Cookie本人GETの正式証拠へ読み替えない。#914統合の証明範囲は次節とする。
これは既存`TC-F-001/002/005/207/211`・`TC-NF-914`のBrowser TLS環境前提の部分証拠のみ。
POL→BR→REQ→AC→TC、CON / OOSの意味・identifierは変更せず、Session本人GET / 失効401、
Gate A〜D、REQ-901/902、#608全体、System / Acceptance TC全体のPassは証明しない。

## #914 opt-in trusted BrowserContext / same-cert Worker 3 GET

Issue本文で確定した単一listener handoffを`evaluation/trusted-browser-smoke.mjs`から明示実行する。
#906 ownerのfresh persist / migrations 0001..0012とsanitized `trusted-https-process.mjs`を再利用し、
Session / CSRFの生成・比較はtrusted child内で行う。Sessionの搬出は公式Cookie設定の内部IPC→run所有Cookie jar→固定HTTPS Cookie headerだけに限定し、汎用IPCへ広げない。
標準#906 / #908経路と#915 TLS-only CLIは維持する。
Linux / Node 24 / locked Wrangler / Playwrightに加え、固定installed `/usr/bin/google-chrome`、
certutil / OpenSSL / ss / ps / readable `/proc` / browser sandboxが必須。不足時は取得・fallbackせず停止する。
`NSSSCDL_CHROMIUM_PATH`やDEBUGをchild env allowlistへ追加しない。

```sh
node --test tests/evaluation/browser-tls-trust.test.mjs tests/evaluation/trusted-browser-smoke.test.mjs
node tests/evaluation/trusted-browser-smoke.mjs --run
node tests/evaluation/trusted-browser-smoke.mjs --run --fail-after-positive
```

seed→proxy dispose→read-only inspect→run-owned NSS / profile / TLS正負probe→Node listenerとsocket停止 / port閉鎖→
同じkey/cert pathsのWranglerを同じ`https://127.0.0.1:8788`へ起動する。
証明済みbrowser process / trustは維持し、fileとlive Worker peerのfingerprint / IP SAN、loopback / process groupを照合する。
#914だけは公開`chromium.launch()`で同一Browserを所有し、TLS probe用とSession用self / other / missing / foreignを
別々の非永続`Browser.newContext()`として作る。TLS probe用ContextへCookieを入れない。
#915単独CLIの`launchPersistentContext`は維持する。そのpersistent Contextの`browser()`はnullであり、consumerのBrowser取得に使わない。
Playwright 1.64.0の`launch()`が呼出Nodeの`os.tmpdir()`へ生成する`playwright_chromiumdev_profile-*` / `playwright-artifacts-*`を、
#906 sanitized child専用TMPDIR内の実path・所有・0700・非symlinkで確認する。Chromiumの実HOMEはrun専用TLS HOMEのまま。
唯一のmainのNUL区切りexact profile引数・uid・読取り前後のPID/starttime・単一exact HOMEを検証する。
Playwright v1.64.0 Linux launcherの`detached:true`を根拠に、main PID=PGRP=SIDを専用group/sessionの起点として認証する。
起点不明・wrapper等でこの条件を満たさない場合は代替根拠へfallbackせず停止し、人間のscope判断へ戻す。
既存生成物があれば起動せず、他runのprofileを推測・glob削除しない。
公式`addCookies`のroot `url` alternative（Domain / pathを併記しない）でhost-only / Path=/を導出し、
実Cookie jarのSecure / HttpOnly / SameSite=Lax / root / host / session期限と`document.cookie`非露出を確認する。

既存`/unknown`の503 JSON documentでsame-origin pageを確立し、page内の本物の`fetch`だけで3 GETを実行する。
requestの`Sec-Fetch-Site: same-origin`はbrowser engineの生成値を観察する。強制header / route mock / APIRequestContextは使わない。
`trusted-https-assertions.mjs`のexact本人5枠 / 履歴1件 / Session CSRF、200 / missing・foreign 401、
no-store / no CORS / csrf no-referrerを再利用する。Fetchが隠す401 Set-CookieはdriverのResponse APIでmemory内だけで検査し、jar消去も確認する。
request終了→Worker停止 / port閉鎖→selfのみ失効 / inspect / proxy dispose→同cert再起動→同Context self 401 / other 200とする。
終了は公開`Browser.close()` / 関連process不在→Worker停止 / port閉鎖→Playwright生成profile / artifacts消滅確認→最終inspect / secret scan→owned files削除の順。
profile / artifacts残存も停止不明と同じ保全条件とし、手動削除や再起動で成功へ置き換えない。
停止不明・proxy失敗では関連owned DB / HOME / NSS / profile / cert / logを保全し、自動retry / resetしない。
Session / CSRF / hash / HMAC / PII / raw driver causeをstdout / env / argv / artifactへ出さず、trace / screenshot / storageState / network loggerを使わない。

一次失敗は`tls-browser-launch`（公開launch未完了）、`tls-browser-ownership`（launch resolve後の所有判定）、
`tls-browser-context`（証明用Context生成）、`tls-browser-nss`（別NSS候補検査）を区別する。
所有判定の失敗時だけ固定`OWNERSHIP` / `CLEANUP_OWNERSHIP`をprimary / cleanupに独立して付加し、
`/proc`列挙・読取り・environ、tracked owner、HOME、profile argv / 配置 / main数 / 一致 / 存在 / 数、
generated directory読取り / 種別 / owner / mode / 実path、生成物変化、関連process残存を固定codeで示す。
HOME不一致は選択根拠の優先順をprofile→run-owned Crashpad database→tracked PID/start identity→選択済み親の子孫とし、
`home-profile-main`（profile指定・typeなし）/ `home-profile-child`（profile指定・単一の非空type）/
`home-crash-db` / `home-tracked` / `home-descendant`で区別する。profile選択時のprofile引数複数指定・type複数指定・空値、
database選択時のdatabase引数複数指定は`home-unknown`とし、弱い選択根拠へfallbackしない。
子孫のHOME異値・曖昧は`home-descendant-{different|ambiguous}-type-{known|absent|unknown}`で診断する。
旧`missing` codeも入力互換として受理するが、認証済み子のHOME欠落単独では失敗しない。
HOME entryなしはmissing、一件の異値（空値を含む）はdifferent、重複または値指定のない`HOME` entryはambiguousとする。
knownはargvに`--type=renderer` / `--type=zygote` / `--type=gpu-process` / `--type=utility`のいずれかが単一指定された場合だけで、実roleは断定しない。
type指定なしはabsent、重複・空・未知値・値指定のない`--type`はunknownに縮退する。HOME判定不能は`home-descendant-unknown`、environ不読は従来の`proc-environ`とする。
既存`home-descendant`もparser互換として受理し、profile / database / trackedの強い選択根拠は細分化しない。
所有性は認証済みrootのPGRPとSIDの両方・uid・読取り前後のPID/starttime一致を必須とする。
親子閉包はgroup/session外への離脱検出にも使用し、未知のgroup memberはrootからの閉包を確認できなければ保全停止する。
tracked identityは終了まで保持し、root終了後に再親子化された既知process（PPID=1）も監視する。PID再利用へ認証を転用しない。
rootの単一exact HOMEは常に必須。認証済みgroup/session内の子だけはHOME entry欠落を単独の拒否理由にしない。
明示異値・重複・曖昧・不読、親子identity矛盾・読取り途中消滅・不明はfail-closedとし、所有物を保全する。
別group/sessionのChrome / Crashpadを暗黙に除外しない。別UIDや未知process混入も成功扱いしない。
`root-unverified` / `group-mismatch` / `session-mismatch` / `tracked-drift`を固定reasonへ追加し、旧HOME reasonはparser互換として保持する。
`OBSERVATION` / `CLEANUP_OBSERVATION`は選択根拠、state、HOME entry、type、観測整合性の順の固定5軸とする。
選択根拠はprofile / Crashpad / tracked / descendant / unknown、stateはlive / zombie / dead / unknown、
HOMEはexact / missing / different / ambiguous / unreadable / unknown、typeはrenderer / zygote / gpu-process / utility / other / absent / unknown、
整合性はstable / changed / vanished / unreadable / unknownだけを受理する。未知値は公開せずunknownへ縮退する。
statのfield 3=state、4=PPID、5=PGRP、6=SID、22=starttimeを照合する。Zはzombie、X/xはdeadの観測であり、終了証明にはしない。
同一live階級内のR/S等の遷移は識別情報の不一致にしないが、live→Z/XやPID/starttime/PPID/PGRP/SIDの変化・不読はfail-closed保全とする。
可変process titleやtype=absentは所有性の証拠にせず、空白再splitは行わない。二時点一致は原子的snapshotや実HOME伝播を保証しない。
owner parserは既存2項目形式・互換reasonを受理し、追加時は両観測の固定allowlist・固定順と全入力一致を要求する。
cleanupの追加フィールド`PRE_CLOSE`=pass / fail / not-done、`CLOSE`=resolve / reject / not-done、`POST_CLOSE`=pass / fail / not-runは独立した実施結果とする。
close未決着のdeadlineはnot-doneであり、公開APIのrejectと推測しない。pre-close不確定→close resolve→browser-ownershipをthrowする既存順序を維持するため、その経路はPOST_CLOSE=not-runとなる。
診断のために未実施のclose後消滅確認を追加せず、resolveだけをowned cleanup成功へ読み替えない。
raw path / argv / env / errorを出さず、後発cleanupは一次failureや最初のcleanup reasonを上書きしない。
診断は所有チェック・close順序・不明時保全を緩和せず、runtime原因確定やcleanup成功の証拠としない。

browser pathだけはchild実行120秒（#908の90秒＋既存browser launch 30秒）、owner180秒とする。
差分60秒はbrowser close 10秒 / process確認5秒 / proof server close 5秒 / Worker停止最大15秒と残余marginを確保する停止用予算であり、性能保証ではない。
GET / navigationは5秒、response bodyは4096文字上限を維持する。
意図的失敗commandはpositive 3 GET直後に失敗し、確認済みcleanupの固定checkpointがある場合だけownerもowned filesを削除する。期待exitは1。

標準Product CIのUnit stepで追加fixtureと既存#915 fixtureを実行する。小fixtureは公開Browser引渡し / persistent null境界 / 非永続4Context / TMPDIR・profile・実HOME所有 / main唯一性 / 停止・残存保全 / handoff順序 / Cookie属性 / response非露出の補助証拠のみ。
今回の限定scopeは上記所有権Contractの静的実装・合成fixtureと文書同期だけで、実Chromeの再実行は別途人間判断を要する。
HOME欠落 / 異値 / 重複、live / Z＋空cmdline・environ、既知type4種 / other / 欠落 / 曖昧、
root唯一性・偽profile・HOME不一致、PGRP / SID / uid差、HOME欠落子の受理・明示異値拒否、
child identity・親リンク / 親identity変化・消滅・不読・malformed stat、tracked PID再利用、
primaryとcleanupで異なるreason / 観測、pre-close fail＋close resolve＋post-close not-run、close reject・未決着、残存保全、厳格parser拒否をfixtureで確認する。
実HOME伝播、process role、Chrome / Worker / D1やowned cleanup成功の証明とはしない。
正式Browser / Worker / D1実証は未確認。別途許可された正式実証では既存Product CIのPR一時opt-in stepで上記normal / intentional failureを実行し、
HEAD / UTC / versions / origin / migrations / cert fingerprint / status / cleanupを非秘密で記録する。
一時step撤去後の実行対象Git blob完全一致、final-head標準Product CI / Traceability、独立reviewを別途確認するまでIssue Open / PR Draftを維持する。
`REQ-001/002/005/207/211`→既存AC→`TC-F-001/002/005/207/211`・`TC-NF-914-04`のlocal browser read-only partial evidenceのみ。
POL / BR / REQ / AC / CON / OOSの意味は変更しない。static assets / DOM / Preview / Confirm、REQ-901/902、Gate A〜DとTC全体Passは後続責務。

## 既存の部分証拠と標準テスト

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
