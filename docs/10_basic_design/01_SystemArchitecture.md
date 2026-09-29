# 01. システムアーキテクチャ

## 1. 目的

本書は、初期リリースにおけるC4 Level 2のContainer Architectureを定義する。要求仕様ベースラインを、詳細な内部Componentを定義せずに、デプロイ境界およびRuntime境界へ落とし込む。

## 2. アーキテクチャ判断

初期リリースでは、各永続環境の公開業務アプリケーションのデプロイ単位として **単一のApplication Worker** を使用する。長期Backup生成は権限を分離したBackup専用Cloudflare Workflow / Scheduled operational componentが担う。Application WorkerとBackup OperationsのDeploy境界は §6を正とし、具体的なWorkflow / Worker構成、binding、credentialは #537 / 詳細設計で確定する。

Web UI、HTTP API、認証／Session Endpoint、予約・キャンセル処理、Schedule／管理者機能、通知Orchestration、Scheduled Job Handlerを、同一のCloudflare Workerへまとめてデプロイする。

これはデプロイ境界に関する判断であり、内部ソースコードまで単一責務へまとめることを意味しない。コード上は責務ごとに分離し、Component Levelの構造は詳細設計（C4 Level 3）で定義する。

この判断は `docs/adr/ADR-001-single-application-worker.md` に記録する。

### 2.1 Application Sessionの設計判断

初期リリースは **D1を正本とするopaqueなServer-side Session** を採用する。Browserは推測困難なSession tokenだけをSecure / HttpOnly Cookieに保持し、業務権限をCookie内容から信用しない。Student Account / Admin AccountとSessionはRole scopeごとに分離し、同一人物が両Roleを持っても1 Sessionへ混在させない。各RequestでSessionの期限・失効、Account / Role、Studentの現在の利用可否をD1で確認する。Login成功時はpre-auth状態を昇格せず新Sessionを発行し、LogoutはServer側で失効させる。localStorage等にSession bearer tokenを保持しない。CookieのSameSite最終値、Path、prefixは詳細設計で定める。

| 案 | 長所 | 本システムでの課題 | 判断 |
|---|---|---|---|
| D1正本のopaque Server-side Session | 即時失効、Role別期限、Admin Idle、Student単位の停止・削除を一つの状態境界で扱える | RequestごとのlookupとSession cleanupが必要 | 採用 |
| 自己完結JWT / stateless access tokenをSession正本にする | Session lookupを減らし水平拡張しやすい | 即時Logout・停止・削除にはdenylist / version / 短期TTL等のstateが必要。Idle 12時間もstateなしでは扱いにくい | 不採用 |
| 外部Provider session / tokenをApplication Session正本にする | 独自Session管理を減らせる可能性 | Magic Linkとの統一、内部Student ID、Role分離、停止・削除・Admin権限を委譲できず、Provider障害時の代替経路とも整合しない | 不採用 |
| Browser保存の長寿命bearer token | 実装が単純に見える | HttpOnly Cookieに比べXSS時に窃取されやすく、即時失効には別機構が必要 | 不採用 |

`REQ-207` のAdmin最大7日・Idle 12時間、Student最大30日、Logout / Security Suspension / deletionの即時失効、解除後の旧Session非復活、Google / Magic Linkの同一Application Sessionへの収束を優先する。`CON-006` の初期規模ではD1 lookupを伴う単純で監査しやすい方式が適する。将来方式を変更する場合も同等以上のrevocation、idle、Role境界を示す。Session token生成・hash・storage、last-activity更新粒度、具体revocation方式は詳細設計で定める。

## 3. C4 Level 2 Container

### 3.1 Application Worker

**技術:** Cloudflare Workers

**責務:**

- 生徒・スクール管理者向けWeb Applicationを配信する。
- HTTP Requestを受け付け、検証する。
- 認証・Session Flowを実行する。
- Google OIDC callback、Magic Link / Invitation / 所有確認の短期Challenge、Role別Accountへのbinding、D1 Sessionの発行・検証・失効を扱う。公開Magic Link要求ではTurnstileとProvider呼出前のRate Limitを適用する。
- 予約、キャンセル、Schedule、Profile、管理者向けUse Caseを実行する。
- 状態変更前に認可と業務ルールを検証する。
- 外部メール送信要求をOrchestrationし、必要なProvider Callbackを受け取る。
- Scheduled Dispatcherから通知Recovery、Reminder、Cleanup、祝日Master更新、未来Slot Integrity Scanの論理Handlerを実行する。Backup生成・Restoreはこの公開Request処理の責務に含めない。
- D1上の正式な業務状態を読み書きする。

**初期リリースでは独立Containerにしないもの:**

- Frontend Worker
- API Worker
- Authentication Worker
- Batch / Scheduled Job Worker
- Notification Worker

### 3.2 メインデータベース

**技術:** Cloudflare D1

**責務:**

- アプリケーションの正式な業務状態を保存する。
- 生徒、Role別Account / Auth Method、正本となるSession / 短期Challenge、Schedule / Slot、Reservation、Classification、通知状態、祝日Master、監査情報を保存する。
- 二重予約や無言の状態上書きを防止するために必要な整合性制御を支える。

論理Data Modelは `02_DataModel.md`、Transaction / Concurrency境界は `05_BookingAndConcurrency.md` を正とし、物理Schemaは詳細設計で定める。

### 3.3 Backup / Recovery運用Container

**技術:** Backup専用Cloudflare Workflow / Scheduled operational component、D1 Time Travel / PITR相当機能

**責務:**

- 短期RecoveryはD1 Time Travel / PITR相当機能を主経路とし、`REQ-909` の7:00–24:00 JSTで3時間、それ以外で24時間のRPOを担う。日次R2 Backupだけを3時間RPOの根拠にしない。Production投入前に対象D1で要求以上の復旧可能性を実測し、仕様変更等で証明できなければ代替方式を用意するまでProduction要件を満たした扱いにしない。
- Backup専用componentはscheduleからlogical runを開始し、D1のconsistent export、完了確認・安全なretry、R2への保存、manifest / integrity確定、Retention class更新、Monitoringへの結果記録を担う。公開Application Workerの通常Request pathにはBackup用R2権限やD1 export管理credentialを付与しない。
- Restore / Cutoverは保守担当者の運用操作とし、公開業務APIから分離する。復旧Source選定とService再開Gateは §5.3 を正とする。

### 3.4 Backup Storage

**技術:** Cloudflare R2

**責務:**

- `REQ-910` の長期Backup Artifact、manifest、Recovery metadataを保持する。Recovery Purge Registryの論理責務は `02_DataModel.md` §2.2を正とし、物理storeは詳細設計で確定する。
- Production Transaction Storeとは論理的に分離する。

長期Artifactはschema + dataを含むfull logical D1 exportを原則とする。成功はexport・R2保存・非空と基本構造の確認・checksumまたは同等のintegrity情報生成・manifestとの対応確定後だけ記録する。manifestは少なくともbackup_id、source environment / D1 identity、captured_at、source capture point、application / schema revision、artifact size、checksum、retention class membership、generation / validation statusを記録する。

成功ArtifactはDaily / Weekly / Monthlyの複数classに所属でき、物理コピーは必須としない。各classの最新15 / 4 / 3世代を保持し、必須classに属さなくなったArtifactだけをCleanup対象とする。Time Travelの保持期間を長期Retentionの根拠にしない。具体的な曜日・月境界、Object key、Lifecycleは詳細・運用設計で確定する。

## 4. 外部システム

### 4.1 Google認証

Googleを利用した利用者認証を提供する。Google固有のIntegrationはDomain Logicから分離し、Provider依存を局所化する。

Application WorkerはOIDC Authorization Code Flowのcallbackを受け、stable subject、email、email verifiedだけを業務判断に用いる。Provider認証成功だけではApplication SessionやAdmin権限を付与しない。state / nonce / PKCE等のwireは詳細設計で定める。

### 4.2 Resend

外部メール配信と、必要な配信／失敗Callbackを提供する。メール配信の成功・失敗によって、Commit済みの業務状態を置き換えたりRollbackしたりしない。

### 4.3 Cloudflare Turnstile

Magic Link発行等の公開認証入口に対するBot Abuse Mitigationを提供する。

## 5. 主な連携ルール

1. 生徒・スクール管理者からの操作はApplication Workerを入口とする。
2. Application Workerは、D1の状態を変更する前にIdentity、Authorization、Request State、業務ルールを検証する。
3. 正常CommitされたD1上の業務状態を正とし、外部Providerの結果によって無言で取り消さない。
4. Concurrency Ruleの対象となる操作ではCommit時に最新状態を再検証し、先にCommit済みの競合状態を無言で上書きしない。
5. 外部連携は、Idempotencyと内部状態の正本性を維持できる形で、業務状態遷移の前後または周辺で呼び出す。
6. 通常業務のScheduled Processingは同一Application Worker内のHandlerで実行する。Backup専用componentはこの境界から分離する。

### 5.1 Scheduled Dispatcherと論理Handler

初期リリースは単一Application WorkerのScheduled入口にDispatcherを置き、**5分tick**で各論理Handlerのdue workを判定する。物理Cron Triggerと論理Handlerは1対1に固定しない。各Handlerの責務、due判定、実行結果・失敗状態を分離する。Invocationの重複・遅延・欠落を前提に、各Handlerは現在時刻とD1の永続状態からdue workを再評価する。物理Trigger数・Cron式は業務上の正本とせず、将来Triggerを分割しても論理責務は変えない。

| 論理Handler | 責務 | 基本設計上のCadence |
|---|---|---|
| Notification Delivery Recovery | Commit済みIntent / Attemptの未処理・安全にretry可能なdue workを回収する | 5分ごと |
| Reminder Materializer | 対象Reservationの24時間前境界を通過したReminder義務を重複なくIntent化する | 15分ごと |
| Privacy / Retention Cleanup | 確定済みの削除・匿名化義務と期限切れToken、Rate Limit一時データ、Log等を処理する。Backup ArtifactのRetentionはBackup専用境界で管理する | 要求上の削除・Retention期限を確実に満たす周期。具体周期は詳細設計 |
| Holiday Master Refresh | 内閣府公式情報を検証し、成功時のみD1を更新する | 1日1回 |
| Future Slot Integrity Scan | Command Guardと独立に未来LessonSlotのInvariant違反を検知・集約する | 1時間ごと |

通常通知は業務状態とNotificationIntentのCommit後に即時deliveryをkickし、Recovery Handlerはkick失敗・Worker終了・due retryから回収する。Scheduled起点のIntentと管理者手動retryのAttemptもCommit後に同じdelivery責務へ渡す。HTTP成功ResponseはProvider受付・配送成功を待たない。Provider CallbackはScheduled Jobではなく真正性を確認する外部HTTP event入口として受ける。配送・Reminder・Callbackの状態境界は `05_BookingAndConcurrency.md` §13、管理者API境界は `06_APIOverview.md` §19を正とする。

Holiday Master Refreshは `REQ-321 / CON-004` に従い、設定された公式URLから取得して公式Domain、Parse、日付・名称形式、対象年Coverage、異常重複を検証する。全検証成功時だけD1を一体として更新し、取得・検証失敗時は部分更新せずLast Known Goodを維持する。一時的な外部障害のretryは `REQ-912` の安全条件に従う。

### 5.2 Handlerの安全性と運用観測

各Handlerは重複・並行実行と途中失敗に対してitem単位で冪等・排他・再開可能とし、D1の状態を信用できない場合は外部送信をfail-closedする。少なくともlast started、last successful completion、現在・連続失敗、due backlogまたはoldest due age、処理・失敗件数を診断可能にする。

Reminder停止、広範な通知配送停止・backlog、Mail Platform障害、Cleanupの個人情報削除期限違反のおそれ、祝日更新の継続失敗を保守側で検知する。個別通知の最終失敗は原則 `REQ-105 / REQ-314` の管理者対応とし、同一の広範原因によるAlertは `BR-110` に従って集約する。祝日更新の単発失敗ではLast Known Goodを維持する。Integrity Scan停止・Incidentは `05_BookingAndConcurrency.md` §14の集約・Fail Closed方針に従う。具体metric、閾値、severityは詳細・運用設計で定める。

Scheduled Handlerの正しさをProvider Quota pollingや変動するQuota値に依存させず、Quota確認だけの高頻度Jobは設けない。通常送信Responseから得られる情報をTelemetryに利用する余地は残す。Quota超過等を機械的にTransient Errorと扱わない。Quota / Billing等の未決は #34、Cron式と環境別bindingの具体値は #537 / 詳細設計で扱う。

### 5.3 Backup生成・復旧運用

Backup runは安定したlogical identityで追跡し、retryを別Generationとして数えない。安全なstepだけbounded retryし、未完了runと次runが重なっても同じlogical generationを競合確定しない。失敗は `REQ-910 / REQ-942` に従って保守担当者が検知できるようにし、長期世代不足やRPO機構の健全性喪失が続く場合はRecovery readiness degradedとしてエスカレーションする。Backup失敗単独に `AC-908-004` の4時間RTOを機械適用しない。

D1 exportはquery提供に影響し得るため、初期規模では低負荷時間帯を候補とする。Production前に実データ規模相当で所要時間とService影響を計測し、24時間Service方針またはRTOへ実質的に悪影響があれば方式・運用Windowを再評価する。具体時刻・retry・alert閾値・run stateの物理保存先は詳細設計で確定する。

障害原因と必要復旧時点から、検証済みの最も新しい安全なRecovery pointを選ぶ。直近障害では安全なbookmark / timestampを特定できるD1 Time Travelを第一候補とし、Production restoreはMaintenance / write停止境界でrestore前のundo用情報を記録して実行する。R2の長期Artifactは原則として隔離したRecovery D1へintegrity・schema / application互換性を確認してimportし、必要なforward migration、`REQ-952` Purge再適用、Domain invariant検査、外部副作用reconciliation、smoke test後に §6.5 のRecovery cutover境界でProductionへ切り替える。古いArtifactを無検証でProduction D1へ直接上書きしない。

通常Service再開前にsource / capture pointとArtifact / bookmark integrity、schema / application互換性、Migration、Purge / 匿名化、Session / 単回Token sanitation、Reservation / SlotOccupancy等の主要Invariant、Notificationのblind resend防止、Scheduled Handler再開可能性、Read / Login / Reservation smoke check、Recovery event・Actor・時刻・sourceの監査記録を確認する。安全に確認できなければMaintenanceを維持する。Recovery source / capture point選定、Service再開の全Gate、Recovery全体の監査記録とsmoke testは本節を正本とし、domain-specificな再開処理は `05_BookingAndConcurrency.md` §13.14を参照する。

Periodic Restore Testは月1回、Productionから分離した環境でR2 ArtifactをRecovery D1へimportし、checksum・schema、主要Invariantとsmoke query、削除済み生徒fixtureのPurge / 匿名化、Session / 単回Token sanitation、復旧所要時間を検証して証跡を残す。Time TravelもTest用D1で既知時刻の更新からpoint-in-time restoreを定期検証する。Production開始前には想定データ量で重大停止時の `REQ-908` 4時間目標内に収まる根拠を確認する。具体的なtest日・自動化・証跡保持は詳細・運用設計で確定する。

## 6. デプロイ境界・障害境界

### 6.1 Environment topologyと隔離

| 用途 | Container instanceと利用境界 |
|---|---|
| Production | 実利用者が使用する唯一の本番環境。Application Worker、D1、R2 Backup Storage / Recovery metadata、Backup Operations、Google / Resend / Turnstile credential・callback、domain / route、monitoringをProduction専用にする。 |
| Persistent Test | `docs/40_test/01_TestPlan.md` §6〜§9のProduction相当試験、migration rehearsal、Scheduled Handler、Provider fault / concurrency / clock control、Restore Testの永続環境。別Worker deployment・D1、必要に応じ別R2、Provider stubまたはNon-Production credentialを用い、Production routeと実利用者dataを持たない。原則、架空Test Dataを使う。初期規模では別の常設Stagingを設けず、Production直前確認にもまず本環境を使う。 |
| Preview / Evaluation | 価値単位やbranch / PRの操作評価に必要な場合だけ作る一時環境。Persistent Testとは用途を分け、Cloudflareの具体機能にはこの段階で固定しない。Production D1 / R2 / Workflow / Provider credential・route・callbackへ接続せず、実利用者dataを入れず、利用終了後にCleanupできること。Scheduled / Workflow等を安全に隔離できない方式ならPersistent Testで評価する。 |
| Recovery | §5.3のRestore / Cutover専用一時環境。Recovery D1とBackup / Recovery専用権限を持ち、通常利用者trafficを受けず、通常の機能Test / Previewへ再利用しない。Production Backupをrestoreする場合は個人情報を含むため、一般Test / Previewより強い保守権限境界とする。 |

C4 Level 2の同じ論理Container構成は、環境ごとに別のresource instanceとして展開する。Recoveryは公開環境の複製ではなく専用の一時運用境界である。同じ論理binding名は使えるが、ProductionとNon-ProductionでApplication Worker / route、D1、R2、Backup Workflow / Recovery metadata、Secrets、環境別variables、Google OAuth credential / callback、Resend credentialまたは送信stub、Turnstile credential / site configuration、Monitoring / log identityを共有しない。Production Backup artifactのRecovery D1への保守権限によるimportは、通常環境へのProduction binding共有とは区別する。Non-Production configにProduction resource ID、bucket、Workflow、Provider secretをfallback値として置かない。実行時・Deploy時に環境identityとbindingの整合を検証できなければfail-closedとし、hostnameから環境の安全境界を推測しない。

### 6.2 Config、Secret、Provider境界

Version controlにはnon-secret application configのschema / key、環境別binding宣言、route / scheduled configuration宣言、migration file、compatibility setting、feature exposureのnon-secret policy値、required secret名を置く。API key、OAuth / Session / CSRF secret material、Provider token、Infrastructure / Backup credentialの値は置かず、Cloudflare Secret等のsecret storeで管理し、通常のplaintext varsにも置かない。Secret / variable / bindingの値変更もruntime behaviorを変えるDeployment changeとして、対象環境・目的・影響・rollback / recoveryを識別する。

Production Provider credentialはProductionでのみ使う。Googleは環境別callbackを分け、Non-Production認証をProduction Admin / Student Accountへbindingしない。ResendはNon-Productionから実利用者へ誤送信せず、Production送信credentialをTest / Previewに渡さない。Turnstileも環境別設定を分離可能にする。Provider callbackを環境を跨いで処理しない。Resendのstub / 専用Test credential / destination allowlistの選択は #537 / 詳細設計で定める。

### 6.3 Deployable unit、source identity、Production flow

Application Worker Version / Deployment、Backup Operations Version / Deployment、D1 migration、R2 / route / binding / secret等のInfrastructure configuration、Business Cutoverを別の変更単位とする。Application Workerは各永続環境内の公開業務処理の単一Deploy / rollback単位であり、1回の変更がWeb、API、通常業務Scheduled Handlerへ同時に影響し得る。Backup Operationsは公開Application Workerから分離したDeploy / privilege boundaryとし、D1 migrationやBusiness CutoverをWorker deployと同一視しない。

Productionへ反映する対象は検証済みのimmutable source commit SHAで識別する。Deploy記録から、environment、source commit SHA、Worker version / deployment identity、migration set / schema revision、binding / config revision、deploy時刻、actor、smoke / health結果を追跡可能にし、secret valueは記録しない。mainへのmergeをProduction deploy済みとは扱わない。

Production deployでは、(1) 対象commitのCI / requirement-based test、(2) 同じcommitのPersistent Test / Evaluationでの検証、(3) Production binding・required secret・Provider callback・Backup readinessのpreflight、(4) 必要なD1 migration、(5) 成功後の対象Worker version activation、(6) read / login / 主要業務のsmoke / health確認、(7) 失敗時のrollback / recovery、の順で扱う。exact command、automation、承認UIは #537 / #536 / 詳細運用設計で定める。

### 6.4 Migration、rollback、feature exposure

Production D1 migrationは原則forward-onlyとし、Worker rollbackのためにDBを自動down migrationしない。新Workerが要求するschemaを先にexpandし、migration直後も稼働中Workerと直前のrollback候補Workerが動作できる互換性を保つ。rename / drop / meaning変更等の非互換変更は1 releaseで完結させず、必要ならexpand → code切替 / backfill → contractを複数releaseで行う。destructive contractは旧Workerをrollback候補から外せると確認してから適用する。Migration失敗時は新Workerをactivateしない。

Migration成功後にWorker deployが失敗した場合は、現在のbinding resource・schema・business dataと互換な既知good Worker versionへ戻し、必要ならforward fix migrationを追加する。Worker rollbackはcode / versionのrollbackであり、D1 / R2 dataを巻き戻さない。Data corruption等でDB state自体を戻す場合だけ、§5.3のBackup / Recoveryとする。初期規模ではGradual Deploymentを必須とせず、Test確認後に1 versionをProductionへactivateする。Traffic splitを将来採用する場合は、同時稼働中のschema / Session / business compatibilityを別途設計する。

Binding / route / secret / Provider callback変更はWorker code rollbackで復元されると仮定せず、変更前のknown-good config identityを記録して、失敗時は環境configを明示的に戻す。D1 / R2等のresourceは切替直後に削除せず、安定確認とRecovery / rollback期間を経てCleanupする。

未完成機能のcodeをProductionへdeployする場合、server-sideで到達不能またはdefault disabledとし、UI非表示だけに依存しない。API直接アクセスでも業務Commandが成立せず、Scheduled Handler / external side effectが起動せず、Production configで意図せずenableにならないことを保証する。Enable前に対応REQ / AC / TCと操作評価を確認する。具体的なflag / route / build separation方式は #537 / 詳細設計で定める。この境界は初回提供範囲を縮小せず、一部だけの先行本番提供には #534の要求変更判断を要する。

### 6.5 Technical activation、Business Cutover、Recovery cutover

WorkerのProduction activationは `docs/00_requirements/01_Introduction.md` §3のBusiness Cutoverではない。Initial Admin setup、Provider / Backup / Monitoring確認、対象月Schedule準備はCutover前にProductionで実施できる。Release readiness確認後、対象となる新しい月の予約受付を新システムで開始した時点をCutoverとし、旧運用の過去予約履歴は移行しない。Cutover後のWorker rollbackでも成立済みReservation / business stateを過去へ巻き戻さない。

Recovery D1へのrestore後は通常deployと区別する。§5.3のService再開Gate完了までpublic routeを向けず、cutover前Production D1 / binding情報をrollback用に保持する。Binding切替後にsmoke確認し、旧Production D1を即削除しない。問題時は復旧後の新規write有無を含めて戻し方を判断し、安易なbinding往復でwriteを分岐させない。Gate通過後のRecovery cutover、public route / binding切替、切替後smoke、旧Production D1の保持、write分岐を避けるrollback判断のdeploy / infrastructure操作は本節を正本とし、Gateの定義は §5.3 を参照する。具体runbookは #537 / 運用設計で定める。

### 6.6 保守権限と詳細設計への引継ぎ

Production deploy / rollback、D1 migration、route / domain、D1 / R2 / Workflowの作成・削除・binding変更、Secret / Variable、OAuth / Provider credential、Recovery cutover、Paid plan / quota関連変更はシステム保守担当者のInfrastructure権限で行い、通常のStudent / Admin Application Roleから実行できない。環境作成、Secrets / Variables、Provider credential、権限、route、plan等の外部resource変更は、具体差分・必要性・費用影響に対する人間の事前承認後に実施する。

#537 / 詳細設計・運用設計では本節のinvariantを前提に、Preview具体方式・URL / Access control、Test D1 / R2 / Provider stub、操作評価data / actor / evidence、deploy / migration / cleanupとRecovery cutoverのrunbook、feature exposure実装、Production rollback、外部resource変更時の承認差分を定める。Exact resource名、wrangler config値、secret名・設定手順、Provider構成、migration file / command、smoke / health、drift check、observabilityの具体値もそこで確定する。

D1、R2、Google認証、Resend、Turnstileはそれぞれ別のPlatform / Service境界であり、独立して障害が発生し得る。障害時の扱いは、内部業務状態の正本性、外部Retry、通知失敗、可用性／Recoveryに関する要求に従う。

## 7. 関連要求・方針

- POL-001 必要最小限・低運用負荷
- POL-002 無料枠優先・Must要件優先
- POL-003 業務状態と外部連携の分離
- POL-004 個人情報最小化
- POL-006 ロール分離と最小権限
- POL-007 外部Provider依存の局所化
- POL-008 競合時の確定状態優先
- POL-012 サービス提供時間と有人保守時間の分離
- POL-013 重要な管理操作の説明性と監査可能性
- BR-128 Backup内個人情報
- REQ-102 24時間Reminder
- REQ-105 通知失敗管理
- REQ-202 / REQ-203 / REQ-207 / REQ-209 / REQ-210 認証・Session
- REQ-211 / REQ-320 / REQ-934 停止・管理者認証・個人情報削除
- REQ-321 祝日マスタ更新
- REQ-912 外部API Retry
- REQ-908 / REQ-909 / REQ-910 RTO・RPO・長期Backup
- REQ-904 Production相当Performance
- REQ-911 競合整合性
- REQ-913 無料枠運用
- REQ-914 障害・エラー時利用者表示
- REQ-942 監視・重大Incident
- REQ-952 Backup Privacy
- REQ-951 Provider分離
- CON-001 Cloudflare Platform
- CON-002 Email Provider
- CON-003 認証
- CON-004 祝日Source
- CON-006 初期規模
- CON-007 初期管理者
- CON-009 Backup方式非依存

## 8. 図

PlantUML Source: `docs/diagrams/plantuml/c4-container.puml`

生成SVG: `docs/diagrams/rendered/c4-container.svg`（自動生成）
