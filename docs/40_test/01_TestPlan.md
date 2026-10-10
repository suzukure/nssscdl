# テスト計画

## 1. 文書情報

| 項目 | 内容 |
|---|---|
| 対象システム | Net Shogi School レッスン予約システム |
| 要求ベースライン | `docs/00_requirements/` v1.21 |
| ベースライン確認日 | 2026-09-22 |
| Git基準 | GitHub `main` 上の要求仕様v1.21。要求版は `docs/00_requirements/00_RevisionHistory.md` を正本とする。 |
| 参照標準 | ISO/IEC/IEEE 29119-3:2021（Test documentation） |
| テストレベル | System Test / Acceptance Test を中心とし、必要に応じIntegration / Operational Testを含む |
| テスト方式 | Requirements-based, risk-based, black-box |

## 2. 目的

要求仕様の各Acceptance Criteria (AC) が検証可能なテスト条件へ変換され、初期リリースのMust要件が以下の観点で満たされることを確認する。

- 業務機能の正しさ
- 時刻境界・状態遷移の正しさ
- 予約、キャンセル、スケジュール変更の競合整合性
- 生徒本人予約の所有者同一性とクライアント入力による予約者差し替え防止
- 新規予約確定前に、既存の未開始Reservationへ生じる標準／追加区分の直接影響を説明できること
- 複数Schedule変更が競合で全体未適用となる場合に、検出できた競合対象・業務上の理由・再確認に必要な最新状態を管理者へ説明できること
- 標準／追加分類の非遡及性と再計算
- 認証・権限・個人情報保護
- 通知失敗と業務状態の分離、および配信結果と通知義務有効性・失効の区別
- 可用性、性能、RPO/RTO、Backup、監査等の非機能要求
- 対象外機能が意図せず製品要件へ混入していないこと

## 3. テスト対象

### 3.1 対象

- 生徒向けSchedule閲覧、予約、一括予約、キャンセル、履歴、Profile
- Email / System内通知
- Google / Magic Link認証、Session、登録、Invitation、Security Suspension
- 管理者向けSchedule管理、休業、管理者確保、分類、削除、欠席、通知失敗管理
- 祝日Master更新
- Browser / Responsive / Accessibility
- Performance / Availability / RTO / RPO / Backup
- Concurrency / Retry / Error abstraction / Audit / Monitoring / Privacy
- Provider分離、Backup Privacy

### 3.2 対象外

`docs/00_requirements/06_Constraints.md` の OOS-001〜009 は正機能としてテストしない。ただし、対象外機能が誤って提供されていないことを確認する **Scope Guard** を実施する。

## 4. リスクベース優先度

| 優先度 | 意味 | 主な対象 |
|---|---|---|
| P0 | 失敗時に予約整合性、認証、PII、復旧性へ重大影響 | 予約競合、予約所有者同一性、予約時区分影響、Schedule一括変更競合、キャンセル境界、未来枠整合性、分類、認証、削除、RPO/Backup |
| P1 | 主要業務の利用不能・誤通知・管理事故につながる | Schedule変更、通知、Suspension、監査、Error表示、Performance |
| P2 | 補助的品質・運用性 | 表示差異、補助指標、文言、Provider交換性等 |

## 5. テスト設計技法

- 同値分割
- 境界値分析
- Decision Table
- 状態遷移テスト
- Use-case / Scenario test
- Pairwise / Browser matrix
- Concurrency / Race test
- Fault injection
- Performance percentile measurement
- Restore / Recovery exercise
- Static review / Configuration inspection

## 6. 標準テストデータ

### 6.1 Actor

| ID | 内容 |
|---|---|
| `A1` | スクール管理者 |
| `S1` | Active生徒、標準回数 N=3 |
| `S2` | Active生徒、競合用 |
| `S3` | Security Suspension対象 |
| `S4` | 削除・再登録対象 |
| `U1` | 未登録メール利用者 |

### 6.2 Schedule / 時刻

すべて Asia/Tokyo とし、期限判定はServer Commit時刻で制御する。

- `D-WD`: 火〜金の通常平日
- `D-WE`: 土日
- `D-HOL`: 月曜以外の祝日
- `D-MON`: 通常月曜
- `D-MON-HOL`: 月曜祝日
- `Tstart`: Lesson開始時刻
- `Tend`: Lesson終了時刻
- 境界値: `Tstart-1ms`, `Tstart`, `Tend`, `Tend+1ms`
- Session境界: 7日、12時間Idle、30日
- Token境界: 15分、72時間
- Reminder境界: 開始24時間前

### 6.3 標準／追加分類

同一生徒・同一暦月で予定日時順 `R1 < R2 < R3 < R4 < R5` を用意する。

- 初期 `N=3`
- 自動分類基本形: `R1..R3=standard`, `R4..R5=additional`
- 開始済みstandard数 `C` を変化させ、`max(N-C, 0)` を検証する
- ClassificationOverride有無、月間算入除外有無を組み合わせる
- 予約Preview試験では、既存未開始Reservation `R2 < R3 < R4` がstandardの状態に、より早い `R1` を新規予約して既存 `R4` がstandard→additionalとなる直接影響を再現する

### 6.4 外部依存

テスト環境では以下を制御可能にする。

- Email Provider: accepted / transient error / permanent error / final delivery failure
- Google Auth: success / provider unavailable / invalid response
- Holiday Source: valid / invalid domain / parse error / coverage不足 / duplicate
- Clock: Server Commit時刻を再現可能
- Concurrency: 2つ以上のCommandを同一業務対象へ競合投入可能
- Backup: Restore専用環境へ復旧可能

## 7. テスト環境

Production相当構成を基本とする。外部Providerの破壊的Fault Injectionや時刻境界試験は、Provider Stubまたは隔離環境で行う。

通常CIではPlaywright等のChromium / Firefox / WebKit系による回帰検知を行う。これはChrome / Edge / Safari / Firefox実ブラウザの正式な互換性証跡とは区別する。

Release readiness時には `docs/10_basic_design/01_SystemArchitecture.md` §2.2の通常Stable / Release family baselineを公式情報で再確認する。familyが変わればProduction release判定前に同節を更新する。Release Test Matrixには各familyの実行対象となるexact Browser version × 代表OSを固定し、Browser名、channel、OS、公式情報のURL・公開日・取得日時、選定したexact versionを記録する。OS別build差を単一のpatch floorへ統合しない。Matrix更新だけで基本設計のsupport familyを変更しない。

Release前の `TC-NF-901-01` はCloud Browser Labまたは同等のVirtual / remote環境の実ブラウザで現行・直前familyのMust業務を確認する。代表例はWindows上のChrome / Edge / FirefoxとmacOS上のSafariとし、具体的な代表OS・provider・証跡取得方法は #537 で確定する。OS別物理実機のプロジェクト所有は必須としない。実行証跡にはMatrixの対象、実行日時、build / commit、family・version別結果を残す。

`REQ-902` のスマートフォン確認は別に行う。日常CIにはviewport / device emulationを利用できるが、Release前はCloud上の実iPhone Safari / Android Chrome等で主要Must業務を確認する。Desktopの `REQ-901` baselineはこの確認を免除しない。

### 7.1 #608初回隔離評価のGate（#892）

構成・Browser state・隔離proofの正本は `../20_detailed_design/01_StudentReservationApplication.md` §9.1〜3とする。評価専用HTTPS入口、isolated D1、trusted seed、実Production Guardを使い、default Workerの503を維持する。#894でread-only Calendar / List / 本人履歴の非公開表示部品とbuildを実装する。#896はCSRF取得GETのSession branchだけを未公開Adapterとして実装し、既存Guard・共有生成式・preauth fail-closed・安全なResponseのUnit / HTTP / isolated local D1試験を追加する（証明範囲は `../../tests/README.md`）。静的WebのHTTPS配信 / read-only DOM compositionは#922で準備し、正式normal単発Run #38025821104で部分実証した。#926は単一予約Preview / Confirm UIをsynthetic fetch / structural DOMで検証し、unsafe POSTを既存read-only評価Workerへ接続しない。actual isolated HTTP / D1 Commitを伴うPreview / Confirm、Production preauth / Auth flowと以下Gate全体は後続検証の責務である。

#928の非公開factoryは既存D1 / HTTP部品のsynthetic compositionだけを検証する。対象fixture・既存TCへの部分証拠対応は `../../tests/README.md` の#928節を参照する。実local D1 migration / atomic Commit / 読取照合 / 失敗後cleanupは#931、Worker activationは#929、実Chrome / 通信は#930の責務とし、#928の完了をこれらのPassへ読み替えない。

#931の `tests/d1/reservation-student-service.test.ts` は既存標準Product CIのD1 topologyへ追加する直列fixtureとし、Production migrations・実Guard / CSRF・Preview → Confirm → DB / 本人History・拒否時未書込みと実Guard rollbackを照合する。詳細・部分証拠と未検証境界は `../../tests/README.md` の#931節を正とする。DB破棄は既存file-isolated runtimeの責務で、read-only評価persistを変更しない。追加コードやsynthetic成功だけで実D1実行済み / Gate全体Passと判定しない。

#929の独立予約評価入口は既存Product CIでstrict local configとisolated HTTP fixtureを検査する。6資産・3 GET・2 POST、認証 / Origin / CSRF / JSON・安全なerror / Cookie / no-store、未知route / binding拒否、Production全503と旧read-only封印の回帰を対象とする。証明範囲は `../../tests/README.md` の#929節を正とし、synthetic 201を実Commitとして扱わない。実localhost HTTPS予約通信・実Chrome・owned cleanupは未検証のまま#930へ引き継ぎ、Gate全体のPassとはしない。

| Gate | 検証範囲と証拠の限界 |
| --- | --- |
| A: local操作評価 | local HTTPS Worker + local D1 + test-owned Sessionで実画面の正常・409再確認・401失効・403拒否・503 / 結果不明非再送を確認する。keyboard / focus / narrow viewportとdefault到達不可も検証する。fake Providerの結果とTransaction内Reservation / Audit / Intent / outboxのCommitを別々に観察する。local成功は実Provider配送・対象環境D1・System / Acceptance TC全体のPassではない。 |
| B: remote対象環境proof | A後に必要性を判断し、#537で具体差分・費用・復旧 / 撤収方法の人間事前承認を得た隔離環境だけを用いる。D1正本§8.6のFK enforcement、D1 Server時刻T0、Primary batch原子性、競合・先行Commit可視性、Trigger拒否を正式検証する。local fixtureで代替せず、未検証 / 失敗ならactivationへ進めない。 |
| C: Release readiness | §7のChrome / Edge / Firefox / Safari current / previous Stable、REQ-902実mobile、#537のdeploy / rollback / Backup-Restore検証を保持する。AのBrowser smokeは正式互換性証跡ではない。 |
| D: Production readiness / Business Cutover | 基本設計 `01_SystemArchitecture.md` §6、§10のExit Criteria、#534の判定に従う。設計main反映・A〜Cの個別成功だけでProduction公開済みとしない。 |

#898は `tests/fixtures/d1/trusted-student-seed.ts` と独立した `tests/d1/trusted-student-seed*.test.ts`で、
全Production migrations適用済みの専用空local D1へ架空Student / Account / active Access / 独立Session・公開未来枠・予約占有を準備する。
schema / 空条件・FK / 既存validation scans、実Guard + Read Adapterの4 View・本人履歴・他人非公開・失効fail-closedを部分証拠とする。
Session生tokenはtrusted test processの専用返却値だけで保持し、DB / Log / Artifactへ残さない。
既存TCとの対応・停止条件は `../../tests/README.md`を参照する。HTTPS Worker / BrowserContext注入・操作評価は含まず、Gate A〜DやAuth / Confirm全体のPassを証明しない。

#902は `tests/evaluation/worker.ts` / 専用configから#899のread-only 3 GETだけを使う入口とlifetime鍵を準備する。
既存integration topologyのhandler fetch / test-only D1 Portと構造検査を部分証拠とし、通常Workerの全503を維持する。
CLI flags / 非外部dry-run / 実localhost HTTPS Listener・certは別Gateとして `../../tests/README.md` の開始前条件に従う。
trusted seedのpersistent local D1 runtime proofは `../../tests/README.md` の#906 opt-inで独立検証する。
#908 opt-inは同一seed済みD1の実HTTPS Listenerへtrusted Node内Session Cookieを渡し、self / otherの3 GET各200、
本人Scope、Session-bound CSRF、安全な401 / 403 / 503、停止後のtest-owned本人失効と他本人維持、read-only不変を検査する。
既存TC-F-001/002/005/207/211・TC-NF-914のlocal HTTPS partial evidenceだけで、正式Actions実証と補助fixtureを区別する。
BrowserContext・assets・unsafe業務POSTは未接続であり、Gate A〜DのPassとしない。正式実証未達ならIssue Open / Draftを維持する。

#915の隔離Chromium TLS harness / 小fixtureと正式Actions proofの区別は `../../tests/README.md` を正本とする。
run-owned HOME / NSS / profileでの正負TLS transportだけを対象とし、Browser Session Cookie本人GET、
失効401、Gate A〜D、REQ-901/902、#608や既存TC全体のPassを証明しない。
#914 opt-in consumerは同一cert / portをNode proof listenerからWorkerへ直列handoffし、
公開`chromium.launch()`のBrowser handleを明示引き渡す（#915単独persistent proofは維持）。
隔離された非永続self / other / missing / foreign Contextの公式Cookie注入とsame-origin browser fetch 3 GETを検査する。
TLS probe用Contextも同Browserの非永続Contextとし、run TMPDIR生成profile/artifacts、実HOME、main唯一性を確認する。
#914はtrusted childを開始時から非root専用systemd unitに置き、outer ownerはunit外で管理する。
能力確認はpersist/migration書込み前、sanitized env・TLS/sandbox・NSS/単一cert・Cookie秘密境界は維持する。
全子PGRP/SID一致・mutable全子environ追跡・全PID消失方式を、専用unitの生存process不在（no-live）へ明示的に置換する。
root本人のexact NUL profile argv / 単一exact HOME / UID / 安定PID,starttime / NoNewPrivs / 専用unit所属はTLS/consumer前に確認する。
公開Browser.close一回→Worker/proxy停止・port閉鎖・生成物/secret検査→child固定report・終了→outer同一unit終端確認→所有物削除とする。
Worker停止前のbrowser全process消失、zombieを含む全PID消失、各子のexit0を証明した扱いにはしない。
ownerは正常/指定意図的失敗reportと、stop前二度の同一InvocationID active/exited・Result=success・main正常終了・再起動0・有効設定を照合する。
意図的失敗childは停止/検査確認済みのreport＋exit0、outer CLIは終端と安全な削除後も期待exit1とする。
unknown/timeout/cancel/stop/不正reportは不可逆な失敗で、後から空unitになっても成功化せずfiles保全・retry禁止とする。
最終port/生成物不在→空unit解放→作成時所有identity/実path確認→owned HOME/NSS/cert/key/temporary/persist削除はouterだけの責任とする。
child120秒・owner180秒の共通残予算と停止margin、固定report・有効設定の正本は `../../tests/README.md` の#914節とadapterを参照する。
合成fixtureは通常/意図的失敗、parent exit0/setsid子残存、InvocationID/設定差、失敗固定、report拒否、close不明、port/生成物残存、非所有物保全を検査する。
#906 / #908標準経路・#915 TLS-only proof・製品entryは維持する。今回の限定scopeは静的実装・fixture・文書同期で、正式Actions current-head通常CIは別証拠とする。
#914の正式実証と#922の成果は区別する。#922は人間承認の**normal1回**[Product CI #38025821104](https://github.com/suzukure/nssscdl/actions/runs/38025821104) / HEAD `bffb9663`で実Chrome / HTTPS / Worker / local D1 / static assets / 本人read-only DOM・停止と所有物削除を確認した。別途承認の**intentional1回**[Product CI #38029294402](https://github.com/suzukure/nssscdl/actions/runs/38029294402) / HEAD `845c397a`は、本人/別本人のBrowser GETとDOM成功直後に例外を注入し、Browser/Worker/portの停止・同一unit正常終端・所有物削除、期待CLI exit1・`INTEGRATED_INTENTIONAL=pass`を確認した。未知の障害やtimeoutの実cleanupは未検証。実404 asset-missing・実403 / 通信断・複数履歴cursorは合成と区別する。詳細は`../../tests/README.md`の#922節。
既存REQ / AC→TC-F-001/002/005/207/211・TC-NF-914へのlocal browser read-only partial evidenceのみで、
#922 static assets / DOMのprepared範囲と正式normal/intentional部分実証は `../../tests/README.md` の#922節を参照する。Preview / Confirm、Gate A〜D、REQ-901/902やTC全体Passを主張しない。

## 8. Entry Criteria

- 対象BuildがTest環境へDeploy済み
- 対応する要求・設計変更がCommit済み
- Migration適用済み
- 標準テストデータ投入可能
- Server Clock、Provider Stub、Concurrency Harness等、該当試験に必要な制御点が利用可能
- P0テストについて観測すべきAudit / Log / Business Stateの確認手段がある

## 9. 開発単位の検証・完了

基本設計後の価値単位と実施Issueの選択・分割・Done判断は `docs/30_operations/ai-development-workflow.md` の「基本設計後の価値単位の開発」を正本とする。開発単位では、対象REQ / ACと既存TCを要求側Matrixおよび本ディレクトリのAC→TC追跡表で照合し、正常・境界・競合・失敗の具体例と期待結果を実装前に確認する。テストの期待結果は要求・基本設計を正とし、実装出力から導出しない。

実施Issueの完了には変更内容に応じた設計整合とAC→TC対応、現在PR headの該当CI証跡を確認する。実装を含むIssueでは対象AC→TC→自動テストと実行結果の対応、該当するDB / API結合・競合・外部依存失敗の検証、影響する既存機能の回帰を確認する。TDD対象の重要業務ロジックは失敗確認・最小実装・構造改善後の再実行を記録する。未実施・失敗を成功と扱わず、Defectと残課題をIssueに記録する。

価値単位の完了は、実施Issueの検証を統合した業務シナリオで確認し、実際の画面を用いる探索的な操作評価で利用者が目的を達成できるか、手順の分かりにくさや既存の具体例にない問題がないかを判定する。Build / Commit、環境、Actor、操作、観察結果、必要な画面・Response / Audit証跡、Defect、改善判断をIssueに残す。複数PRで構成しても統合評価を省略しない。操作評価環境・手順の具体化は #537、CIとテスト基盤は #536 に従う。

#894の表示部品・要求世代制御・暦・cursor・安全なエラー・structural DOM試験は `tests/README.md` のpartial evidenceとする。CSSの局所scroll / 折返しとDOM focus設計を実320px / keyboard / screen reader受入や正式Browser MatrixのPassへ読み替えない。build / typecheck / lint / testのローカル報告とformal current-head Product CIを区別する。

#892の完了は詳細設計の正本・PlantUML同期と後続責務の引継ぎであり、Gate A〜Dを実行したことを意味しない。後続#608操作評価は§12の証跡へTC / AC、source commit SHA、migration revision、binding / config identity（secret値なし）、実行日時、Actor、架空test data区分、正常 / 409 / 401 / 403 / 503、画面と安全な業務状態、観察 / Defect / 制約を紐付ける。TC-F-001-01〜02 / TC-F-002-01〜02 / TC-F-003-01〜09 / TC-F-005-01と、追補 `04a_RequirementsTestTraceability_v1.6_v1.7.md` のAC-003-021対応を既存仕様に照合し、部分証拠とTC全体Passを分離する。deploy / migration / check / rollback / cleanupのexact手順と実行結果は#537の後続で正式化し、Worker rollbackとDB復旧を区別する。

この単位の完了は初期リリースの判定ではない。次節の全REQ / AC対応、P0 / P1、欠陥、非機能・Browser等のExit Criteriaは維持する。

## 10. 初期リリース全体のExit Criteria

- 全REQに1件以上のテストケースが存在する
- 全ACが `04_RequirementsTestTraceability.md` および要求変更追補Traceabilityで1件以上のTCへ対応する
- P0: 100% Pass
- P1: 原則100% Pass。未解決はRelease判断で明示承認
- Critical / Major defectが未解決で残らない
- REQ-911の競合整合性、REQ-909/910の復旧性、REQ-934のPII削除について証跡を保存する
- 実行対象Browser MatrixでMust業務が完了する

## 11. Defect Severity

| Severity | 定義例 |
|---|---|
| Critical | 二重予約、予約所有者が他の実在生徒へ誤紐付けされ利用者境界・権限・PIIに重大影響を与える、他人予約の露出、認証回避、PII重大漏えい、復旧不能 |
| Major | Critical条件に至らない予約所有者不整合（存在しない生徒への紐付け等）、主要業務が実行不能、誤った取消・分類、期限判定誤り、通知失敗で業務状態がRollback |
| Minor | 代替手段がある表示・文言・局所的UI不具合 |

## 12. 証跡

テスト結果には最低限、TC ID、Build/Commit、実行日時、環境、Actor/Test Data、結果、必要なScreenshot/Response/Audit evidence、Defect IDを残す。

PIIを証跡へ不要に複製しない。テスト用の架空データを優先する。

## 13. 自動化方針

- P0/P1の決定論的なAPI/Domain挙動は自動化を優先する。
- Browser E2EはMust業務のHappy pathと主要Boundary/Conflictへ限定し、下位レベルの自動テストと重複させすぎない。
- Performance、Concurrency、Restoreは専用Harnessを用いる。
- WCAG、文言、管理者への説明性は自動検査と人手Reviewを併用する。
- 自動テスト名またはmetadataへTC IDを埋め込み、要求テスト仕様と実装テストを追跡可能にする。

## 14. 設計進行に伴う詳細化ポイント

以下は製品要求の未決事項ではなく、テスト実装上の詳細化項目である。

- UI selector / API path / HTTP status / Application Error codeの具体値
- Test fixture生成API
- Clock injection方式
- Provider Stub / Fault injection方式
- Concurrency同期Barrier
- RPO/RTO測定・Restore手順の自動化範囲

これらが確定しても、本仕様のAC・期待業務結果は変更しない。
