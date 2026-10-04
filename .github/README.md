# GitHub project configuration

GitHub Actions workflows、Issue Forms、Pull Request template、およびAI開発・レビュー用の補助scriptを格納する。

運用手順は [`docs/30_operations/ai-development-workflow.md`](../docs/30_operations/ai-development-workflow.md) を参照する。

## AI Workflow Regression impact selector（#696 / #697 / #709）

[`select-ai-workflow-fixtures.py`](scripts/select-ai-workflow-fixtures.py) の `select(repo_root, changed_paths_nul)` はrepository rootとexact changed-path集合のNUL-delimited bytesを受け取り、coarse suiteを選ぶread-only helperである。CLIは `python3 -B .github/scripts/select-ai-workflow-fixtures.py --repo-root /absolute/repository < paths.nul`。regression callerは検証済みevent base/head SHAから `git merge-base BASE HEAD` を取得し、`git diff --no-renames --name-only -z MERGE_BASE HEAD` の取得済みbytesを渡す。helperはgit実行・changed path取得・shell展開・fixture実行を行わない。

stdoutは単一のcanonical JSONで、`schema:ai-workflow-fixture-selection` / `version:1`、`mode:selected|full`、入力本文を含まない固定 `reason`、sort/deduplicateした `suites` / `fixtures` を返す。明示inventoryとexact path mappingの機械正本はscriptで、#695基準commit `275f4ba6f875969ea267ef55d77d5cc209e370b2` の68件（Product npm 11 / resume-human-pause 26 / Claude 11 / DeepInfra 9 / AI Developer-Codex 7 / failure evidence 2 / common 2）を保持する。現在checkoutの#692 / #684 / #711 / #738 / #741追加fixture、本selector fixture、#701 common guardも明示登録し、計75件を検証する。局所変更には対象suite全件とcommonを選び、shared helperには利用suiteのunionを選ぶ。登録済みchanged fixture自身も必ず含める。

workflow変更では、全workflowを走査するproduction未接続guardを持つsuiteを必ず含める。`.github/workflows/claude-review.yml` はProduct npm / failure evidenceも共有境界としてmappingし、commonを含む全7 suite・75 fixtureを `selected / known_paths` で返す。他のworkflow pathは下記のfull fallbackに従う。

parse済みchanged pathsはtrusted baseの `TRIGGER_PATTERNS` に一致するものだけをselection対象とする。trigger対象外pathはmixed PRでも影響せず、trigger対象内のselector自身・そのfixture・regression workflow変更は `global_boundary`、trigger対象内の未知path（未mapping script、対象docs / AGENTS / CLAUDE / .codex / .claude / .mcp.json等を含む）は `unmapped_path`、UTF-8 / 絶対path / traversal / 非canonical path / NUL framing不正は `malformed_input`、空入力・filter後0件は `empty_selection`、mapping矛盾・未対応trigger patternは `mapping_conflict`、repositoryの `test-*.sh` 集合との不一致・新規未登録fixture・不正file型は `inventory_mismatch`、想定外例外は `selector_error` としてfullへ戻す。fullではrepository上の全 `.github/scripts/test-*.sh` を返す。探索不能は `full / inventory_unavailable` と空fixture集合を返し、CLIはexit `1`で停止する。通常のselected/full決定はexit `0`、CLI構文不正は入力を反射せずexit `2`となる。

検証は `bash .github/scripts/test-select-ai-workflow-fixtures.sh` と `bash .github/scripts/test-ai-workflow.sh`。trigger一覧の正本はworkflowの `on.pull_request.paths` とし、後者でselectorの宣言とのexact集合同期と未対応patternの拒否をmachine checkする。matcherはliteral prefix / basename / segment-directory / exact pathだけを扱う。#697でregressionへ接続し、selection policyはPR headではなくtrusted event base commitから取得する。caller側のfail-closed validation、selected/full実行、bounded Summaryの運用契約は [AI開発運用文書](../docs/30_operations/ai-development-workflow.md#bootstrapと復旧) を正本とする。selector自身はnetwork / GitHub API / repository write / Secrets / env-driven policy / paid AIを使用しない。parallel executionは対象外で、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

## Cross-suite production-unreachable common guard（#701）

[`test-production-unreachable.sh`](scripts/test-production-unreachable.sh) はscript / workflowをread-only走査する軽量common fixtureである。`product-npm-orchestrator.py` のproduction workflow接続・未知non-test caller、`build-failure-evidence-packet.py` のworkflow直接接続・`collect-failure-evidence.py` 以外のproduction caller、および `verify_post_workload` のworkflow直接参照・orchestrator source自身以外のnon-test script参照を拒否する。selectorの `BASELINE` / `PATH_SUITES` とselector fixtureの `cases` では既知のexact宣言的literalだけをASTで許容し、実行参照・追加参照・重複宣言をfail-closedで拒否する。implementation自身と直下の `test-*.sh` / `test-*.py` は構造的に区別し、guardはhelperをimport・実行しない。

#711では `production_session` / `workload_session` / `_WorkloadSession` もguard対象とする。closed `production_session` callbackを呼ぶexact dormant runtimeと、そのruntimeからsynthetic probeへの参照だけを追加許容する。orchestratorの `SOURCES` はexact source identity literalだけをASTで許容し、実行参照・重複・未知callerは拒否する。raw sessionはruntimeへ許可しない。

snapshotは `git ls-files --stage -z` でscripts / workflows配下のtracked filesだけをNUL-safeに列挙し、working treeのsource bytesを検査する。#711の2つのexact dormant sourceと#738 / #741 / #747 helper、および#747専用workflowは提案時のuntracked状態でも明示読込する。#738 staging helperと#741 supply helperはproduction workflow / 未知non-test callerを拒否し、selectorのexact宣言、synthetic fixtureと下記#747のclosed proof helperだけを許容する。削除したPR HEAD actual proofへのworkflow接続も拒否する。untracked `__pycache__/*.pyc` 等は対象にしない。列挙失敗・不正path・未解決index stage・tracked symlink / 特殊file・ancestorの不正型・読込失敗・不正UTF-8はsilent skipせずFAILする。

検証は `bash .github/scripts/test-production-unreachable.sh`。synthetic caller / workflow / AST mutationはmemory内だけで構成し、repositoryを書き換えない。selected modeではcommonとともに必ず選択され、無関係なhelper変更で重いProduct npm suiteの常時選択を必要としない。inventory同期には既存#684 fixtureの未登録解消も含む。既存Product npm / failure-evidence fixtureの重複guardは維持する。production workflow / event / permission / stateは変更せず、network / GitHub API / Secrets / paid AIを使用しない。#697のregression callerでもcommon guardの必須実行を検証し、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

## Product runtime exact staging（#738、prepared / dormant）

[`product-runtime-staging.py`](scripts/product-runtime-staging.py) の `PreparedRuntime(rows, trusted_uids=..., excluded_roots=..., root_api=...)` はtrusted parent保持のprepared Contractである。`root_api`には既存#710の `CanonicalRoot` を渡し、そのancestry / mount identityとphysical座標を再利用する。trusted base由来module・parent memory・sourceをmodel変更から隔離し、Product workspace / cache等の全workload変更可能rootを `excluded_roots` に指定する責務はtrusted callerにある。UIDやmodeだけをprovenanceの根拠にせず、同一trusted UIDの並行攻撃からの隔離は本synthetic fixtureでは実証しない。

rowのclosed schemaとruntime class集合はhelperを機械正本とする。shell、Python runtime/module/extension、Node、Codex package/native、exact ELF loader/library closure、bounded preflight descriptor/metadataを、explicit regular-fileのsource→destination mappingとして表現する。closureの発見・最終inventory決定・descriptorのlive実行は行わない。absolute canonical path、全ancestorのno-follow traversal、single-link file、明示trusted owner、ACL/capability不存在とunsafe書込み／replacement authorityの拒否を要求する。trusted ownerの異なるsafe modeを許容し、trusted-owned sticky ancestorではtrusted-owned childのreplacement protectionを用いる。fileのdevice/inode/UID/GID/mode/link count/size/mtime/ctimeとSHA-256、ancestorのidentity/owner/mode、mount identityを保持して再照合する。ancestorのsize/timeは無関係な兄弟entryで変わるためidentity判定には使わない。

`with prepared.stage(staging_parent) as sealed:` はsource / excluded rootと物理分離したsafe parent内へfresh rootを作り、各fileのcopy前後と全copy完了後にsource identity/hashを再検証する。optional `directories` は必要な空directoryのexact destination集合であり、host directoryを取り込まない。source treeを再帰copyせず、destination重複・file/directoryのprefix衝突・traversal・source aliasを拒否する。staged permissionはhelperのexact policyへ正規化し、`sealed.verify()` は全file/directoryの型・owner/mode・identity/hashとexact inventoryをparent memoryのsealに照合する。serialized inventoryはclaimであり期待証拠へ復元しない。追加／削除pathやruntime-added residualは許容しない。context終了時にhandleを失効させrootを破棄し、copy・seal・cleanup失敗は成功にしない。

検証は `bash .github/scripts/test-product-runtime-staging.sh`。synthetic temp sourceのみでcanonical受理、host owner/mode差、symlink / hardlink / wrong type / writable authority / identity/hash drift、destination衝突、permission正規化、seal改変とcleanupを固定する。Product npm suiteへexactly-once登録し、common production-unreachable guardでproduction workflow / non-test callerを拒否する。#741 prepared Contractのsynthetic fixtureはsealed supplyからのsource受入だけに再利用し、source authority条件を緩和しない。production caller、systemd / RootDirectory execution、#737 integrationは未接続である。actual runnerの最終inventoryと実行可能性のformal proofは後続#739の責務であり、本fixtureの成功では主張しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

## Trusted runtime sealed supply（#741、prepared / dormant）

[`trusted-runtime-supply.py`](scripts/trusted-runtime-supply.py) の `PreparedSupply(rows, setup=..., excluded_roots=..., root_api=..., staging_api=...)` はmodel / Product workload / PR由来arbitrary executable開始前のtrusted preparation専用Contractである。callerはpin済みsetup/resolver、trusted module、parent memory、phase順序を保証する。`setup` はhelperのclosed `SETUP` と、version probe前に捕捉したexact source集合の`observe()`証拠だけを保持する。serialized claimやUID/modeだけではprovenanceを認証できない。sourceはProduct workspace/cache等の全workload変更可能rootと物理分離し、callerはそれらを`excluded_roots`へ漏れなく指定する。

source acceptanceはcanonical absolute path、no-follow ancestor、single-link regular file、exact inventory、dev/inode/owner/mode/size/mtime/ctime/SHA-256とmount identityをbindする。prepared policyではext4 sourceとそのancestorの`user.*` metadataだけを許可候補として表現し、exact nameとvalueのSHA-256をsource evidenceへbindしてcopy前後・再検証時のdriftを拒否する。metadataをtrust根拠にはせず、`security.*` / `system.*` / `trusted.*`とその他unknown namespace、観測失敗はfail-closedにする。xattr件数・name/value bytes上限はhelperを正本とする。source owner/modeのwritable状態はtrusted setupの時間境界内でのみ観測・copyし、#738のtrusted authorityへ直接渡さない。copy前後・全copy後にidentity/hashを再照合し、duplicate、traversal、特殊permission、symlink/hardlink/special file、未知authorityを拒否する。file件数・単体bytes・総bytes上限はhelperを正本とし、recursive host-tree copyやgeneric host rootのbindは提供しない。

`with prepared.snapshot(supply_parent) as sealed:` はroot:rootのsafe parent内にfresh dedicated rootを作る。source/excluded rootとのphysical overlapを既存#710 `CanonicalRoot`で拒否し、directories/executablesを`0555`、dataを`0444`へexact normalizationする。rootからの全ancestorもowner/mode・filesystem・xattrを検証する。Linuxの一意なmount/device/root座標を持つ**ext4かつsealed destinationとその全ancestorのxattr不存在**だけを受理し、source metadataはcopyしない。POSIX ACL/capability以外の未知xattr、unsupported filesystem、観測失敗をfail-closedにする。ext4以外のportabilityやrunner image自体の耐改竄性は主張しない。

`sealed.verify()` はparent memoryのexact type/owner/mode/inventory/identity/hash sealを再照合する。`sealed.prepared_runtime()` はsealed側のsourceだけを#738 `PreparedRuntime`へ渡す。consumerはroot権限・replacement capabilityを持たないことが前提で、original toolcache pathをconsumerへ公開しない。handleはcontext内だけ有効で、cleanupはroot identityを確認してfresh rootだけを削除し、失敗は伝播する。source原本のconsumer接続、RootDirectory/systemd/network実行、最終ELF closure/inventoryは#739に残す。

検証は [`test-trusted-runtime-supply.sh`](scripts/test-trusted-runtime-supply.sh) のsynthetic/focused fixtureと既存AI Workflow Regressionの `Fixtures` で行う。syntheticではroot ownership/ext4を仮想化し、実copy/hash/no-follow/cleanupと否定条件、およびmock xattrのname/value drift、#738へのsealed-path handoffを固定する。pull_request workflowでPR HEAD scriptをsudo/root実行するactual proof helperと専用jobは除去し、production workflowへは接続しない。新しいSecrets/Variables、model/Responses call、repository write lifecycle変更はない。

親 **#743** はproof infrastructure導入 **#747** とactual GitHub-hosted privileged proof **#748** へ分離する。actual runnerのexact xattr allowlist決定、setup-only actual Codex runtimeとsealed supply → #738のactual C0判定は#748の責務とする。#741 / #747のsynthetic成功からactual runnerのauthority/xattr対応やformal proof済み/C0化済みとは主張しない。#739の再開判断には#748完了・#743完了の証拠とmain反映が必要であり、RootDirectory/systemd/network consumerは含めない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### Trusted-main runtime-supply proof infrastructure（#747、prepared）

[`trusted-main-runtime-supply-proof.yml`](workflows/trusted-main-runtime-supply-proof.yml) は入力なしの `workflow_dispatch` 専用である。main反映後、Actionsの同workflowを `main` で明示起動する。source gateはdefault branch `main`、`refs/heads/main`、workflow source ref、workflow SHAとproof対象SHAの一致、入力集合が空であることをcheckout/setup/sudo前に要求する。対象はdispatch時のexact main SHAであり、自由入力SHAやPR HEADを受理しない。checkoutはそのSHAに固定し `persist-credentials:false`、権限は `contents:read` のみとする。PR regressionからactual privileged proofは到達不能である。

setupは既存pin済み `openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e` / Codex `0.159.3` をkey / promptなしで使う。pin済みActionはCLIとproxy packageをinstallするが、空key / promptではResponses proxyを起動せず `codex exec` に入らない。固定 `allow-users:'*'` はAction内のpermission API確認を省略するためであり、workflow_dispatchのGitHub側認可やsource gateを置き換えない。Action内部のsetup network以外の通信を追加しない。Secrets / Variables / App tokenを参照せず、proof processは `env -i` で `PATH` とtrusted `PROOF_SHA` だけを受け取る。

[`trusted-main-runtime-supply-proof.py`](scripts/trusted-main-runtime-supply-proof.py) のclosed modeは `--observe` / `--prepare` だけとする。Linux x64のinstalled npm layoutからNode、Codex launcher・metadata、native package metadata・binaryの5 regular-file rowsを決定し、既存Action blob pinとcheckout SHAを照合する。非root observationはno-follow descriptorでsourceと `/var/lib` の全ancestorをread-only観測し、`runtime-supply-observation` version `1` にsource class、ancestor depth（対象自身が0）、xattr name、filesystem / mountの非機密identifier、固定status/reason/errnoだけを記録する。最大192 records、各32 names・name 255 bytes、JSON出力128 KiB、mount table 1 MiB・4096 rows・escaped row 32件に束縛する。absolute source path、mount coordinate、xattr value/digest、file content、env、credentialを出力しない。unsupported authorityは失敗であり、#741 `filesystem()` の対象外escaped coordinateによるglobal rejectもrowのmount ID / device / filesystemと `relation:unrelated` で観測できる。policyを緩和しない。

root preparationはmain由来helperだけを使う。#741 source evidenceを同じparent memoryへ捕捉してからversion probesを非root `runner` UID/GID・補助groupなし・最小envで実行し、launcher/nativeの `codex-cli 0.159.3` 一致を要求する。#710 `CanonicalRoot` だけを再利用し、Product consumerを起動しない。fresh `/var/lib/runtime-supply-proof-*` 内で#741 sealと#738 prepared handoffを検証してcleanupし、成功JSONも `c0_decision:not-made` とする。未知layout/authority・drift・cleanup失敗・timeoutは停止し、retry/fallbackしない。Product workspace/cache、RootDirectory/systemd/network、model、repository writeへの接続はない。

PR上の検証は既存 `test-trusted-runtime-supply.sh` のsynthetic/static fixtureとcommon production-unreachable guardを使用し、fixture数75を維持する。専用workflow以外のproof caller、PR event、candidate codeのroot実行、event input injection、追加permission/credential、key/prompt、診断への禁止情報混入を検査する。本IssueのDoneはprepared infrastructureのreview/merge可能性であり、actual runは実施・消費しない。#748はmain反映後に同workflowを起動し、authority観測・actual proofとC0可否を判断する。700秒timeout後のblind retryは行わない。

## Failure evidence packet（#686 / #687）

[`build-failure-evidence-packet.py`](scripts/build-failure-evidence-packet.py) の `build(data)` は `failure-evidence-packet:v1` のpure builderである。入力schema・必須key・source locator・provenance区分と許容値はscriptを正本とし、fixtureが最小呼出例を示す。成功時は `status:complete`、`packet`、keyをsortしたcanonical `serialized` を返す。最終serialization自身のchars / UTF-8 bytesをintegrityに記録し、**32768 bytes以下**だけをcompleteとする。unknown field、不正schema、mandatory欠落は `incomplete`、source identity矛盾は `conflict`、SHA不一致は `stale`、mandatory evidence過大は `oversized` とし、拒否時の `packet` / `serialized` は `null`、reasonは入力値を含まない固定codeとなる。

trusted callerが取得済みのIssue各節・Product impact、checkpoint選択結果、job step metadata/log、diff file / numstat、code rangeをmemoryで渡す。locatorはrepo/ref/SHA/path/line rangeとIssue/PR/run/attempt/job/stepをbindする。Issue locatorのmain SHAは取得時のrepository snapshotとの対応であり、Issue本文の不変性を保証しない。Issue本文・comment由来textは `untrusted_issue`、checkpointは `trusted_selector`、logは `trusted_collector`、code/diffは `trusted_repository` に限定し、model outputを正本にしない。provenance区分は入力宣言の検証であり、取得元を認証するcollectorではない。checkpoint選択は既存 [`build-development-context.py`](scripts/build-development-context.py) が正本で、本builderはmode / boundary / fallback reasonを保持するだけで再選択しない。Issue textからmodel routingやsecurity policyを選ばない。

jobのstep番号順でfirst failureと直前のsuccess 1件を選ぶ。logは4096 bytesに束縛し、過大logでは最初のlexical error/assertionの2行前からverbatim excerptを保持する（matchなしは先頭）。passは1024 bytes、各code rangeは2048 bytesのverbatim UTF-8 prefixとする。cap超過時もこれらだけを決定的に縮め、identity・locator・Issue contract・diff summaryは削らない。切断時は `truncated:true`、original locator / chars / bytesを保持する。upstreamの切断も同情報を必須とし、非切断宣言と原文countsの不一致を拒否する。locator/countsの真偽とjob step集合の完全性はtrusted callerの責務である。assertion / error / errno / syscall / pathは保持したfailure excerptのlexical matchだけを抽出し、未観測項目は `null` とmissing一覧へ残す。root cause、safe/unsafe、allowlist、修正案は判断しない。

builder自身はGitHub API / LLM / network / env読込 / repository write / credentialを使用しない。入力全体で既知token形式・Bearer・private key header・credential代入形を検出すると本文を返さず拒否する。例外はcredential値全体がexact literal `***` のmask placeholderだけで、`token: ***` / `Bearer ***` をsecretそのものとは扱わない。代入値の既存delimiter（空白・`,`・`}`・末尾）、Bearer値のdelimiter（空白・末尾）まで完全一致を要求し、部分mask、別asterisk長、引用符付き値、実credential-like値は引き続きfail-closed。collectorとbuilderは同じ `SECRET` 検査式を使用し、全文検査の範囲を維持する。maskは観測textとして残り得るがcredentialとして解釈・復元しない。全secret形式の検出保証ではなく、collectorはcredential-free evidenceを渡す責務を持つ。

検証は `bash .github/scripts/test-failure-evidence-packet.sh`。既存AI Workflow Regressionの `test-*.sh` discoveryだけを使い、workflowは変更しない。[#654 replay fixture](scripts/fixtures/failure-evidence-654.json) は供給Issueと既存診断に基づく7分岐のsynthetic reconstructionで、実Actions log・run identity・正式runner証拠ではない。現在の `ReadWritePaths=+/project +/tmp` と異なるhistorical `ReadWritePaths=/project /tmp` も観測textとして保持し、正誤を決めない。parentは#658、read-only collector / artifact integrationは#687として下記に接続する。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### AI Workflow Regression read-only collector（#687）

[`failure-evidence-collector.yml`](workflows/failure-evidence-collector.yml) は `AI Workflow Regression` の `workflow_run:completed` / `conclusion:failure` だけを処理する独立consumerである。`${{ github.sha }}` のdefault-branch snapshotから [`collect-failure-evidence.py`](scripts/collect-failure-evidence.py) とbuilder / checkpoint selectorを取得し、source SHAのcodeはAPIで読むだけで実行しない。権限は `actions / contents / pull-requests / issues:read`、credentialはbuiltin `github.token` だけとし、App token・repository Secret・paid callは使用しない。source workflow / run result / PR / Issue / label / human pauseは変更せず、retryや通知も行わない。

collectorはfresh APIでrepository ID/name、workflow ID/name/path、completed failure / pull_request event、run ID/attempt/head、attempt-specific jobsとindividual jobの所属、associated PR 1件、current PR head、current main、same-repository closing Issue 1件を照合する。最新runのattemptも一致させ、superseded attemptを拒否する。PR baseはmain、source headとcurrent PR headは一致が必要で、不一致は `stale`。PR/Issue 0件は `incomplete`、複数件やidentity矛盾は `conflict` とする。API error / malformed shape / pagination欠落はcompleteへ昇格せず、PR / main / Issue / closing relation / latest runをbuilder直前に再照合する。取得間の競合を完全に排除する保証ではない。

failed jobは1件だけを許可し、そのstep番号順のfirst failureを選ぶ。step番号・名前の重複は拒否し、`gh run view --attempt --job --log` のjob/step prefixでphysical line rangeをbindする。source log全文を上記secret-like evidence境界で検査した後、4096 bytesのfailure excerptと直前successの1024 bytesだけをbuilderへ渡す。raw full logは短命tempfileに限定し、artifactへ保存しない。API responseは2 MiB、source log取得は16 MiBを上限とし、超過は `oversized` とする。source artifactは取得・展開しない。

Issue contractは以下のexact `## <heading>` 対応表にある6節から取得する（scriptの `HEADINGS` が機械正本）。case変更・別headingや本文からのsection inferenceは行わない。

| packet key | 受理するheading |
| --- | --- |
| `goal` | `目的` / `Goal` / `利用者、完了する業務、価値` |
| `scope` | `対象` / `Scope` / `実装・DB・テスト・運用の範囲` / `対象IDと設計` |
| `security` | `Security` / `Security boundary` / `Permissions` / `セキュリティ境界` |
| `non_goals` | `Non-goals` / `対象外` / `依存関係と対象外` |
| `done` | `完了条件` / `Done` / `完了条件と残課題` |
| `product_impact` | `Product impact` / `Product impact / traceability` / `Product影響` |

`product_impact` はheadingの代わりに、行頭の `Product POL / BR / REQ / AC / TC / CON / OOS impact: <value>` / `Product POL / BR / REQ / AC / TC / CON / OOS 影響: <value>`、または上表の `done` 節内だけの `Product影響: <value>` を受理する。各行は任意の `- ` prefixを許可し、#654で報告された `- Product影響: none。` を原文・行番号付きで保持する。valueは空白以外を必須とし意味を推測しない。fenced code block内のheading / inline行は契約宣言にしない。delimiterの種類・長さを照合し、未閉鎖blockは `incomplete` とする。headingとinlineの併記を含む重複は、同値でも `conflict`、欠落・空値は `incomplete` とする。

本文・log内の命令文字列は実行しない。commentsのtrusted checkpoint選択は既存selectorを再利用する。PR filesを全page取得し、`changed_files`件数との一致を確認してfile / additions / deletionsだけを保存する。full diffは保存しない。failure excerptにある `.github/scripts/<path>:<line>` / Python traceback locatorから最大3件・各9行のcode rangeをsource SHAで取得し、各2048 bytesに束縛する。未観測code locatorはbuilderのmissing fieldsへ残し、symbolや原因を推測しない。

artifact名は `failure-evidence-<source run_id>-<run_attempt>`、retentionは3日、対象fileは `failure-evidence-packet.json` 1件だけとする。complete時はbuilderのcanonical `failure-evidence-packet:v1` JSON、拒否時は同schemaの `status / reason / packet:null` recordを保存する。拒否recordはcomplete packetではなく、source本文や未検証identityを含めない。どちらも32768 bytes以下とし、Job Summaryには固定status文だけを記録する。拒否時はconsumerを失敗終了するが、artifact uploadは `always()` で試みる。source runの結果は変更しない。

検証は `bash .github/scripts/test-failure-evidence-collector.sh` とbuilder回帰。既存AI Workflow Regressionのfixture discoveryで到達し、source workflow自体は変更しない。[#654本文相当fixture](scripts/fixtures/failure-evidence-654-issue.md) は供給された#687修正要件とrepositoryの#654仕様に基づく再構成であり、実Issue本文の取得copyではない。7つのsynthetic log分岐すべてでこのDone内inline contractを使い、exact heading aliases・原文locator・重複/欠落/空値/fenced textの拒否を確認する。collector fixtureのActions形式相当checkout logには `with:` / `token: ***` を含め、failure excerptの `Bearer ***` とともにbuilderまで通してcompleteを確認する。同じcheckout input位置の実credential-like値・部分maskの置換、およびexcerpt外のcredential-like値は `incomplete / secret_like_evidence` で拒否する。実Actions identity・logとの統合証拠はnaturalな次回failureのartifactでdefault branch反映後に確認する。packet-first diagnosisは親#658の後続、AI Developer / Claude Reviewの収集は対象外。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

## Product npm trusted preparation（#645、dormant）

共通helper [`prepare-product-npm.py`](scripts/prepare-product-npm.py) はtrusted setup用の準備済み実装である。production developer / follow-upからは呼び出さず、Product要求・実装と現在のAI Developer behaviorを変更しない。親#644のnetwork boundaryとproduction wiringは後続で扱う。

呼出interfaceは以下とする。pathはすべて絶対pathで指定し、Node/npmは呼出側が信頼済みruntimeから選ぶ。`--run-root` はworkspaceと重ならない、呼出UID所有・mode `0700` の既存run専用directoryとする。

```bash
python3 .github/scripts/prepare-product-npm.py \
  --workspace /absolute/workspace --run-root /absolute/private-run-root \
  --node /absolute/trusted/bin/node --npm /absolute/trusted/bin/npm
```

stdoutは単一のprovenance JSONで、成功はexit `0`、失敗はexit `1` / `status:error`と固定`reason`で返す。入力状態`state`は`no-manifest` / `bootstrap-required` / `locked`（分類前の拒否は`unknown`）、成功時`status`は`no-manifest` / `bootstrap-required` / `prepared`となる。manifestなしではnpmのversion確認だけを行い、registry操作・lock生成をしない。manifestありではtop-level全dependency sectionのexact versionを要求し、workspaces / overrides / bundled dependency等はfail-closedで拒否する。exact manifestがありlockがない場合は`bootstrap-required`を返し、version確認以外のnpm command・依存解決・network access・lock生成は行わない。対応lockは`lockfileVersion:2 / 3`、公式registryのpackage/versionに対応するHTTPS tarball URLと有効なSRI digestを持つ通常entryに限定する。

各呼出しは新しい`preparation_path`と専用`cache_path`を作り、既存lock全体をnpm実行前に検証し、成功した`locked`状態だけ隔離したnpm設定・環境と`npm ci --ignore-scripts`で専用cacheをwarmする。disposable install directoryと`node_modules`は終了時に破棄する。workspaceには書き戻さず、`bootstrap-required`時のmanifest snapshot、`prepared`時のmanifest / lock snapshotと`provenance.json`を準備directoryに残す。provenanceはstate/status、入力bytesのSHA-256（lock未存在時は`null`）、registry/source contract、Node/npm version、cacheと準備directoryを記録する。失敗時に残るcache・provenanceは成功成果物として使用しない。run終了時のdirectory破棄は呼出側の責務で、cross-run cacheを再利用しない。

呼出側はworkload開始前にtrusted base由来helperを実行し、workspace copyとstdoutのworkload側copyをpost-Codex trusted evidenceにしない。mode `0700` やworkspace外配置だけでは同一UIDのworkloadに対する保護を保証しないため、後続wiringはsetup時のhashと結果をworkloadへ渡さないtrusted orchestration証跡へ固定し、workspace内やworkloadが書ける`RUNNER_TEMP`のprovenanceを後から正本として読まない。helperのsource validationとregistry指定はnetwork遮断の代替ではなく、egress境界は#644の後続責務とする。

security boundaryはnpm実行前にsource/integrity/manifest/pathを検証した既存lockの依存closureとし、npm source-policy flag単独を信用しない。初回lock生成は本helperの責務に含めず、#646のlocalhost-only network primitiveを前提に別Issueでtrusted bootstrap専用のregistry-only境界を実証してから扱う。production wiringも後続責務とする。

検証は `bash .github/scripts/test-prepare-product-npm.sh`。pure / mock fixtureに加え、ローカルtarballを専用cacheへseedした実npmの`--offline`実行でlifecycle非実行と反復`ci`を確認する。実registryやpaid AI callは不要で、既存AI Workflow Regressionのselected/full実行で検出される。

## Codex service network boundary（#646、dormant）

共通helper [`codex-network-boundary.py`](scripts/codex-network-boundary.py) の `properties` は、`--property=IPAddressDeny=any` と `--property=IPAddressAllow=localhost` を各1行で返す。developer / follow-up production serviceには未接続で、Product POL / BR / REQ / AC / TC / CON / OOSへの影響はない。trusted base由来のhelperを使い、propertyの実効検証に失敗した場合は停止する。env-only境界へのfallbackは設けない。

```bash
python3 .github/scripts/codex-network-boundary.py properties
bash .github/scripts/test-codex-network-boundary.sh
```

`probe --address <runner-local-IPv4> --port <1024..65535> --ipv6-port <1024..65535> [--unit codex-network-probe-<32-lowercase-hex>.service]` はfixture専用のlocal endpointを検証し、単一JSONとexit `0` / `status:pass`またはexit `1` / `status:error`・固定`reason`を返す。CLI構文不正はexit `2`。名前解決は行わず、non-loopbackの宛先はrunnerに現在割当済みのIPv4に限定する。`--unit`なしは接続成功のcontrol、指定時は同一unitのdeny/allow propertyと実通信を検証する。property表示だけでは成功にしない。

fixtureはtrusted側でIPv4 localhost・non-loopbackの同一portとIPv6 localhostにserverを設け、network property以外が同じtransient serviceでcontrol → restricted → controlを2回実行する。IPv4/IPv6 localhost TCP、localhost UDP、AF_UNIX/AF_INET作成を許可し、non-loopback TCPの接続不成立とserver側のaccept不存在を確認する。TCPの結果は`timeout`または`error`・`errno:1`をそのまま記録する。timeout単独やconnection refusedはdeny証明にせず、同じnon-loopback IP・portへのUDP送信が明示的な`EPERM`となること、前後のcontrolでTCP/UDPが成功することも必須にする。これはIP packet境界の検証であり、TCP timeout自体を明示的errnoと表現しない。

unsupported property、property読取不能、実効filter不在、local address不足、localhost失敗、deny判定不能はfail-closed。外部internet endpoint、registry、paid AIを使わず、productionのNoNewPrivileges / capability除去 / protected UNIX socket / io_uring EPERM denyを変更しない。fixture自身のserviceも非root UID・NoNewPrivileges・capability除去で実行し、各unit・server socketを成功/失敗時にcleanupする。既存AI Workflow Regressionがfixtureを検出する。制限されたCodex service内、またはローカルのsystemd不在環境ではruntimeの`SKIP`理由を表示し、実証済みと扱わない。独立GitHub Actions runnerではsystemd不在を失敗にする。

registry-only bootstrap境界での再利用は下記#649、developer / follow-upへのproduction配線は#647の責務とする。production wiring完了までは本helperからproduction behaviorは変わらない。

## npm registry-only network boundary（#649、dormant）

[`npm-registry-proxy.py`](scripts/npm-registry-proxy.py) はtrusted runner側のlocalhost-only CONNECT forwarderである。`serve [--port <1024..65535>]` は `127.0.0.1` にのみlistenし、省略時は空きportを選び、stdoutへ単一のready JSON（address / port / exact target）を返す。許可するrequestは `CONNECT registry.npmjs.org:443 HTTP/1.1` と同じexact `Host` の組合せだけで、arbitrary CONNECT / HTTP request、別port、userinfo、suffix、IP literal、重複header、body指定、credential headerを `403` で拒否する。通常HTTP forwardingは提供しない。外向きdialは固定hostnameのDNS結果のうちpublic address・port `443` だけに限定し、private addressを含む回答全体を拒否する。upstream不在は `502`、接続後の失敗はtunnelを閉じ、direct internetへのfallbackはしない。DNS/TLS/registryの成功保証は設けない。

proxyはTLSを終端せず、opaque streamをforwardする。client側がofficial registryのhostnameとcertificateを検証する。認証tokenは不要で、proxyはrequest / header / body / package payloadをlogへ出さない。header size / deadline、同時tunnel数、tunnel lifetimeを束縛する。呼出側はtrusted base由来sourceをroot所有・非writableなdirectoryへ固定し、proxyとrestricted serviceを別UIDで実行して、Secrets / GitHub write tokenを渡さずに最小envで起動する。runner UID所有のmode `0700` directoryだけを保護境界にしない。

```bash
bash .github/scripts/test-npm-registry-boundary.sh
```

既存AI Workflow Regressionの `test-*.sh` discoveryだけで検出する。pure / mock検証は外部通信を行わない。独立systemd runnerでのruntime fixture [`npm-registry-boundary-runtime.py`](scripts/npm-registry-boundary-runtime.py) はroot所有のrun専用source copy、runner UIDのproxy、`nobody` UIDのtransient serviceを使用する。両processへ継承env・credentialを渡さない。serviceでは#646の `IPAddressDeny=any` / `IPAddressAllow=localhost` に、productionから読み取る固定13 socket maskとio_uring EPERM filter、NoNewPrivileges / capability除去を併用する。同一serviceでAF_UNIX/AF_INET作成、保護socket拒否、io_uring EPERM、trusted source書込不能、別proxy UIDを確認する。

socket maskでservice内の `systemctl` が使えないため、trusted runnerが実unitのnetwork propertyを取得・検証し、root所有の読取専用snapshotにunit名とともに固定する。observerは同一unitを既存の10秒期限内だけ再観測し、一時的なempty / partial / 不一致表示では公開せず、`validate_properties` が完全一致した場合だけatomic publishする。期限までに一致しなければfail-closedとし、最後のproperty出力・validation reasonを診断に残す。この再観測はservice実行のretryではない。serviceはsnapshotの所有者・permission・unit identityを確認し、#646 helperの共通 `validate_properties` と `probe(..., verifier=...)` を利用する。snapshot不在・不一致は停止し、property表示だけでは合格にしない。localhost成功、runner-local non-loopback TCP不成立、同じIP/portへのUDP `EPERM`、前後のcontrol成功とlistener側accept不存在を必須にする。

同じrunnerでofficial registryのTLS経由 `GET /is-number/7.0.0`（固定metadata、最大64 KiB、redirectなし）とarbitrary target / Host不一致の `403` を検証する。package選定・取得・npm/git実行・lock生成は行わない。proxy停止後のrestricted serviceが `proxy-unavailable` で失敗することも確認する。control → restricted → controlとproxy不在検証を2回実行し、各cycleのelapsed time、service / proxy process / socket / root所有fixture directoryのcleanupとhost socket / resolver不変を確認する。proxy cleanupはprocess終了とtrusted runnerから同じ `127.0.0.1:port` への接続が `ECONNREFUSED` となることで確認し、TIME_WAITの影響を受けるbare rebindは使わない。接続成功・timeout・その他のerrorはcleanup成功にしない。失敗やtimeoutはretryせず、systemdの元error textを検証失敗に残す。

制限されたCodex service内ではruntimeを `SKIP` とし、systemd不在の独立GitHub Actions runnerでは失敗する。`SKIP` はregistry到達・実効network境界の実証済みを意味しない。実registry positive proofは独立runnerの結果を確認してから判定する。

production developer / follow-upからはunreachableで、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの変更はない。後継の順序は **#649 → #652（network source escape）→ #654（filesystem source境界）→ #656（lifecycle script境界）→ #650（initial lock）→ #647（production wiring）**。本fixtureのnetwork proofだけで後継のescape検証やbootstrap完了とは扱わない。

## npm/git network source escape（#652、dormant）

検証は `bash .github/scripts/test-npm-network-sources.sh`。[`npm-network-source-probe.py`](scripts/npm-network-source-probe.py) は上記#649 runtimeのroot所有source copy、別UID proxy、service hardening、実効property snapshotと#646 primitiveを再利用するfixtureであり、production launcherではない。registry positive proofは#649の固定metadata GETを同じrestricted service内で再利用し、proxyやnetwork境界を再実装しない。

実npmの `view` と実gitの `ls-remote` がproxy指定なしでrunner自身のnon-loopback HTTP endpointへ接続できないことを確認する。同じnpm/git commandの前後のunrestricted control成功、同じsource IP/portへのUDP `EPERM`、restricted service中のlistener accept不存在を組み合わせ、失敗exitやTCP timeoutだけをdeny証拠にしない。direct subprocessの5秒deadline到達はtimeoutとして記録し、process groupを停止する。proxy経由のcommand timeoutは検証失敗で、再実行しない。

subprocessのstdout / stderrは分離して保持する。npm unrestricted controlはexit `0`とstdoutのversion値がexact `1.0.0`であることを要求し、stderrのwarningをversion判定へ混ぜない。拒否経路の `403` / `ECONNREFUSED` / git subprocess確認には両出力を診断として使う。

arbitrary git HTTPSは実gitの `ls-remote` と実npmの `cache add git+https://...`、remote tarballは実npmの `cache add https://...tgz` で試し、各commandの失敗とproxyの明示 `403` を要求する。宛先はnumeric runner-local IPとfixture portに固定し、外部任意hostへのprobe・DNS lookupを行わない。npm `allow-git` / `allow-remote` は有効にしてnetwork境界を検証し、これらのoptionをsecurity boundaryにしない。

npm/gitへ継承env・credentialは渡さず、空のuser/global npmrc、専用HOME/cache、git設定・prompt無効化を使う。`--ignore-scripts` / `--package-lock=false` を指定し、lock / node_modules不在を確認する。proxy停止後も同じrestricted serviceでdirect拒否とnpm/gitのconnection refusalを要求し、unrestricted fallbackを認めない。boundary preflight不成立時はnpm/gitを起動しない。

control → restricted → control → proxy停止検証を2回実行し、#649のunit / proxy / host socket・resolver不変検証に加え、source listener、subprocess groupとdisposable HOME/cacheをcleanupする。source検証付きserviceの期限は70秒、runner側waitは80秒とし、property観測の10秒期限は変えない。既存AI Workflow Regressionのfixture discoveryだけで実行する。

pure / mock検証は外部通信なし。独立runnerでは実npm/gitのlocal control・proxy拒否・proxy不在を外向きdialなしで先に検証し、その後systemd runtimeで実効direct拒否とregistry到達を検証する。制限されたCodex serviceではsocket/runtimeを `SKIP` とし、実npm/git・実効filter・registry到達の実証済みとは扱わない。独立GitHub Actions runnerのsystemd不在は失敗とする。

Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの変更はなく、production developer / follow-upは未接続。local file / directory / workspace sourceは#654、lifecycle script境界は#656、lock生成は#650、production wiringは#647に残す。scopeと後継順序は各Issue本文を正本とし、本検証だけで後継の完了とは扱わない。

## npm local filesystem source escape（#654、dormant）

検証は `bash .github/scripts/test-npm-filesystem-sources.sh`。[`npm-filesystem-boundary-runtime.py`](scripts/npm-filesystem-boundary-runtime.py) は外部通信のない独立fixtureで、production launcherではない。既存#645の`manifest_dependencies`を再利用し、全top-level dependency sectionの`file:` / relative・absolute directory / traversal / symlink sourceとworkspaces等をnpm開始前に拒否する。この文字列policy単独をsecurity boundaryにしない。

`ProtectSystem=strict`の書込例外は`ReadWritePaths=+/project +/tmp`で`RootDirectory`内に限定する。npm開始前に同じservice UIDで`/project/cache`のdirectory型を確認し、固定名の空directoryを1回作成・削除して残存がないことを確認する。失敗はphase / path / errnoだけを診断に残してnpm未起動で停止し、host cacheへのfallbackは行わない。mockでexact property、作成・削除・残存確認、書込拒否と予期しないerror時のfail-closedを検証する。

実効境界はroot所有のrun専用`RootDirectory`である。Node binary、ELF loader/library closure、npm distribution、trusted probeだけをcopyし、hostの`/usr` / `/lib`全体やProduct workspaceをbindしない。npm runtimeの領域外symlinkは準備時に拒否する。visible source rootは`/project`に固定し、ここにdisposable manifest / HOME / cacheと空のnpmrcを置く。`nobody` serviceは#649のcapability除去・NoNewPrivileges・io_uring filter・socket mask・network propertiesを再利用する。`/proc` / `/sys` / `/run` / `/home` / `/root`はdisposable root内へ空directoryとしてstageし、service内のhost content非公開性は下記probeのempty / hidden checksとexact runtime-artifact invariantで実証する。`+` prefixのない`InaccessiblePaths=/proc /sys /run /home /root`と継承したsocket maskはhost-root基準であり、`RootDirectory`内のpathを直接maskする説明や非公開性の根拠には用いない。`/run/host/os-release`の不可視性もexplicit hidden checkで実証する。host由来のPrivateTmp mountは使わず、disposable root内の空の`/tmp`を使う。callerとnpmのenvをそれぞれ`env -i`で固定し、Secrets / GitHub write tokenを渡さない。隔離起動失敗、rootの所有者・permission・marker不一致、host source可視、command timeoutは停止し、host filesystemへのfallbackやretryを行わない。

[`npm-filesystem-source-probe.js`](scripts/npm-filesystem-source-probe.js) は同一service内でroot inventory・marker・UID・host sentinel非公開を確認してから実npmを起動する。arbitrary host directoryに作るreadable package / tarballの同一UID controlを前後に置き、workspace sourceも含め、policyを迂回した`npm pack --dry-run --json --offline`でも`file:` / absolute directory / relative traversal / absolute・relative symlink経由の参照が`ENOENT` / `EACCES` / `ENOTDIR`で失敗することを要求する。visible local packageへの前後の成功controlが壊れたnpmによる偽陽性を防ぐ。このlocal packageはfixture control専用で、top-level policyの許可対象ではない。lock / node_modulesを生成せず、`--ignore-scripts`の指定はlifecycle非実行の実証と扱わない。

root inventoryは`boundary.visible_root`の全staged entryの存在・型（symlink不可）・所有者・group/other書込不可を必須にする。systemd起動時の追加entryは名前をallowlistせず、root所有・書込不可・特殊permissionなしのdirectoryだけに限定し、service UIDから列挙できる場合は空、`EACCES` / `EPERM`の場合は不可視を要求する。追加file / symlink / device、可視content、予期しない検査errorはnpm開始前にfail-closedとし、phase・source class・pathを診断に残す。既存host contentの補助hidden checkに、runtime構築で使用する`/usr/bin/env`も含める。

意図的に空directoryとしてstagingする`/sys` / `/run` / `/home` / `/root` / `/proc`は、directory object自体のopen成功をhost content露出と扱わない。root inventoryの型・所有者・permission検証を維持した上で、service UIDから列挙できれば空であることを要求し、`EACCES` / `EPERM` / `ENOENT`はnon-exposureとして扱う。file / symlink / deviceへの型変化、下記exact invariant以外の可視entry、予期しない検査errorはnpm開始前に拒否する。具体的なhost content path（sentinel、actual workspace、`/usr/bin/env`、`/etc/os-release`、`/run/host/os-release`、`/proc/1/root`）には従来のaccess失敗を引き続き要求する。

staged / runtime-added directoryがnon-emptyで失敗する場合、既存のphase・source class・pathに加え、各entryの`parent_path` / `entry_name` / `type`（directory / file / symlink / other）/ `uid` / `mode`（lstatの数値）だけを固定JSONで診断へ残す。symlink target、file内容、env、Secrets、tokenは出力しない。下記exact invariant以外のnon-emptyは引き続きfail-closedとする。mock fixtureで診断項目とnpm開始前の拒否を検証する。

Issue #654のformal runner evidenceに基づき、通常空の`/run`に限り、直下がexactly `systemd` 1件（directory / uid=0 / mode=0755）、その直下がexactly `incoming` 1件（directory / uid=0 / mode=0600）の場合だけsystemd namespace artifactとして扱う。service UID=nobodyで`incoming`のopen、readdir、synthetic childのstatを行い、すべて`EACCES` / `EPERM`で明示拒否されることを要求する。成功や`ENOENT`等の判定不能はfail-closedとし、内部を再帰探索・信用しない。兄弟entry、型・uid・modeの差異も拒否し、`/run/systemd`全般を許可しない。`/run/systemd/notify`、`/run/systemd/journal/socket`、`/run/systemd/journal/stdout`、`/run/systemd/userdb/io.systemd.DynamicUser`にも既存のhidden checkを要求する。mockでexact invariantと両denial、兄弟entry・属性差異・各操作成功／予期しないerrorの拒否、診断の固定項目・内容非出力を検証する。

新しいrootで2回実行し、成功・失敗時のunit停止・collectとroot削除、host fixtureのcleanupを確認する。既存AI Workflow Regressionの`test-*.sh` discoveryだけで到達し、production developer / follow-upからはunreachable。制限されたCodex serviceではpure / mockとruntime copy構築を検証し、実serviceは`SKIP`とする。`SKIP`は実効filesystem隔離の実証済みを意味しない。独立GitHub Actions runnerでsystemdがない場合は失敗する。

same-UID前後controlの必須証拠は`/tmp`直下のfixture directoryとpackage / tarballのpermissionを明示固定したarbitrary-host sentinelだけとし、各pathを個別にopenする。失敗時はpre / post、source class、path、exit codeと元のstdout / stderrを残し、host sentinelが隔離外で読めなければfail-closedとする。repository workspace内のsentinelはrunnerのancestor permissionに依存する隔離外readabilityを要求しない。trusted側はworkspace sentinelの存在と、構築時・staging後の全root inventoryにworkspace path / sentinel contentがないことを確認する。service内ではactual workspace path / sentinelへのaccessとnpmによる参照が失敗することを要求し、hidden / npm検証の失敗にもphase・source class・pathを残す。workspaceをbind/copyせず、sentinelは成功・失敗時ともcleanupする。既存の`.git/HEAD` / `/etc/os-release`は隔離内の補助hidden checkに限定し、runner依存の隔離外readabilityを必須条件にしない。

Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの変更はない。#649/#652の外部network proofは再実行しない。後継は **#656 → #650 → #647**。#656は同じdisposable rootの構築・service前提を利用してlifecycle script非実行を独立検証し、#650/#647のlock生成・production wiringはその完了を待つ。

## npm lifecycle script boundary（#656、dormant）

検証は `bash .github/scripts/test-npm-lifecycle-scripts.sh`。[`npm-lifecycle-boundary-runtime.py`](scripts/npm-lifecycle-boundary-runtime.py) は#654のroot construction / exact service command / hardening / unit cleanupを再利用する独立fixtureであり、production launcherではない。既存probeから境界検査だけを`isolationPreflight`として共有し、root inventory、empty / hidden checks、`/run/systemd/incoming`のexact invariantとcache書込検証を変更せずにnpm開始前へ適用する。`ReadWritePaths=+/project +/tmp`を維持し、Product workspaceや追加host pathをbind/copyしない。unprefixed `InaccessiblePaths=`と継承socket maskのhost-root基準については#654の説明を正本とする。

[`npm-lifecycle-script-probe.js`](scripts/npm-lifecycle-script-probe.js) は同じ`nobody` service / `RootDirectory`内で実npmのeffective `ignore-scripts=true`、bare project `npm install --json`成功を順に要求する。CLIは`--offline` / `--ignore-scripts` / `--package-lock=false`を固定する。root projectの`preinstall` / `install` / `postinstall` / `prepare`には、実行された場合にdisposable `/project/markers`だけへtoken・event別markerを作るscriptを置き、npm開始前にmanifest全体の完全一致で存在を検証する。外部dependencyが不要なfixtureとし、install結果の`added` / `removed` / `changed`はすべて0を要求する。各operationの前後でmarkerと`package-lock.json` / `npm-shrinkwrap.json` / `.package-lock.json`がないこと、専用cacheの内容以外のpath・型に変化がないことを確認する。manifestの変更、unexpected artifact、symlinkや特殊fileもfail-closedとする。formal runnerで`--ignore-scripts`指定時にも`prepare`が起動した`npm pack`はproof primitiveとして使用せず、dependency rebuildによる検証も置き換える。#645のProduct manifest policyは変更しない。

npm spawn前にCLI / operation / envの完全一致と空のdisposable user/global npmrc、project `.npmrc`不在を検証する。`--ignore-scripts`欠落、scripts enabled相当の上書き、重複flag、config差替え、unsafe env、malformed / unsupported commandはnpm未起動でfail-closed。caller → systemd-runのbounded envは#654の固定commandをそのまま使い、npmへは`PATH` / `HOME` / `LC_ALL`だけを明示指定する。Secrets / GitHub write token、caller credential、`NODE_OPTIONS` / npm config envは継承しない。effective setting不成立、timeout、operation失敗、markerまたはlock生成は停止し、scripts enabledやhost npmへのfallback / retryは行わない。

pure / mockでcontract改変時のnpm未起動、config / install各operationの失敗時停止、env非継承、marker / lock / unexpected artifact検出とcleanup失敗時の拒否を検証する。独立したlocal real npmの2 fresh fixtureでもservice probeと同じoperation shapeでbare project install成功、marker / lock不在、専用cache以外のinventory不変を確認する。local fixtureのscriptには実在するNodeとfixture内のmarker writerを指定し、writerは自身のdirectory配下の`markers`だけへ書き込む。service用の絶対pathがlocalでは存在しないことを非実行の根拠にせず、writerの書込先はmockで両配置について検証する。これはservice隔離の実証とは区別する。独立systemd runnerでは同じrestricted serviceで2 fresh rootsを実行し、成功・失敗時ともunit / root / fixtureをcleanupする。制限されたCodex service内では独立runtimeを`SKIP`とし、実効service境界の実証済みと扱わない。独立GitHub Actions runnerでsystemdがない場合は失敗する。

既存AI Workflow Regressionの`test-*.sh` discoveryだけで検出され、production developer / follow-upからはunreachable。外部network proof、paid diagnostic、initial lock生成、production wiringは追加しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの変更はない。#650は本Issueと#654の独立runner evidenceを確認し、merge後のlatest mainでfresh scope評価してinitial lock生成へ進む。production wiringは#647に残す。

## npm initial lock lifecycle proof（#660、dormant）

検証は `bash .github/scripts/test-npm-initial-lock.sh`。[`npm-initial-lock-runtime.py`](scripts/npm-initial-lock-runtime.py) と [`npm-initial-lock-probe.js`](scripts/npm-initial-lock-probe.js) は#650の分割fixtureであり、production launcherではない。#645の`manifest_dependencies`を再利用し、disposable rootのtop-level dependencyは`initial-lock-dependency:1.0.0`だけとする。Product package/versionの選定やpolicy変更は行わない。#654のroot construction / `isolationPreflight` / exact service command / hardening / unit cleanupを再利用するが、registry-only/network/filesystem境界との統合は下記#661の独立fixtureで扱う。

initial-lock生成commandの正本はprobeの`command('lock', port)`で、引数の順序・個数も完全一致を要求する。`port`はtrusted local fixtureの整数`1024..65535`だけとし、hostname解決・外部network・upstream forwardingは行わない。

```bash
/runtime/node /runtime/npm/bin/npm-cli.js \
  --ignore-scripts --package-lock=true --lockfile-version=3 \
  --audit=false --fund=false --update-notifier=false --workspaces=false \
  --include=dev --include=optional --include=peer \
  --fetch-retries=0 --fetch-timeout=5000 --registry=http://127.0.0.1:<port>/ \
  --userconfig=/project/empty.npmrc --globalconfig=/project/global.npmrc \
  --cache=/project/cache install --package-lock-only --json
```

cwdは`/project`、npm envは`PATH=/runtime` / `HOME=/project` / `LC_ALL=C`だけに固定する。user/global/built-in npmrcはdisposable copyで空とし、project `.npmrc`はdangling symlinkも含め不在を要求する。npm起動前にCLI / env / configを検証し、disable flagの欠落・重複・上書き、alternate config、credential-like env、npm config env、proxy、unsupported operationを拒否する。同じflag setによる`config get ignore-scripts`が`true`となった後に固定commandを1回だけ実行する。timeout・npm failure・unsupported result・marker・unexpected artifactはfail-closedで、scripts-enabled、別command、host-global npmへのfallback/retryはない。

root projectとdependency fixtureの`preinstall` / `install` / `postinstall` / `prepare`は実在するNodeとmarker writerを参照し、npm開始前にmanifest全体を完全一致で検証する。fixture tarballはPythonで直接生成し、`npm pack`を使用しない。writerはproject markerとmanaged host sentinelへの書込を試み、host sentinelがRootDirectory内で`ENOENT`でもproject markerは生成する。host sentinelは隔離外ではservice UIDから書込可能なfixtureとし、trusted側で空のままであることを要求する。writerの両書込・`ENOENT`時のproject書込はmockのみで検証し、scripts-enabled controlは実行しない。

local registryはdependencyのexact metadata（scripts / tarball URL / integrityを含む）だけを返し、tarballやその他requestは拒否する。trusted側の観測でmetadata requestが1件以上、tarball/unsupported requestが0件であることを要求する。成功証拠はNode/npm version、exact command、candidate `package-lock.json`、project marker 0件、`host_side_effects:0`、`tarball_requests:0`、`dependency_execution_path:not-entered`を含む。このcommandではdependency package content/script execution経路へ入らないことを証拠とし、「dependency scriptを抑止した」とは扱わない。#656のbare install proofや、formal runnerで観測した`npm pack --ignore-scripts`による`prepare`起動を全npm経路の非実行証明へ拡張しない。

空cache・lockなしから開始し、candidate以外のlock、`node_modules`、symlink/特殊file、専用cache以外のpath・bytes変更を拒否する。candidateの存在とfixture identityを確認するだけで、generated lockの最終validation/provenanceは#662の責務とする。local real npmと独立restricted serviceのそれぞれで2 fresh fixturesを実行し、成功・失敗時ともroot / host sentinel / registry thread・socketをcleanupする。unit停止・collectは#654を正本とする。

既存AI Workflow Regressionの`test-*.sh` discoveryだけで到達し、production developer / follow-up / #645 preparationからはunreachable。制限されたCodex環境でsocketが`EPERM`ならlocal real npmを`SKIP`とし、継承service境界では独立systemd runtimeも`SKIP`にする。これらは実command成功・lifecycle非実行のformal evidenceではない。独立runnerではlocal operationとsystemd runtimeを必須にし、systemd不在も失敗とする。#660のDone判定には独立runnerの成功証拠を確認する。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの変更はない。境界統合は下記#661、後続のlock validation/provenanceは#662、production wiringは#647の責務とする。


## npm registry-only initial lock integration（#661、dormant）

検証は `bash .github/scripts/test-npm-registry-lock.sh`。[`npm-registry-lock-runtime.py`](scripts/npm-registry-lock-runtime.py) / [`npm-registry-lock-probe.js`](scripts/npm-registry-lock-probe.js) は固定official fixture `is-number:7.0.0` 専用で、Product dependency選定やproduction launcherではない。#645のmanifest policy、#654のRootDirectory構築・`isolationPreflight`・service command・hardening・unit cleanup、#649の別UID CONNECT proxyと実効property observerを再利用する。observerは共通関数へ抽出し、10秒期限・完全一致検証・root所有snapshotのatomic publishを維持する。追加observerなしの既存filesystem/lifecycle serviceは従来のcommandを使用する。

exact manifest bytesをdisposable `/project/package.json` とroot所有の読取専用 `/runtime/manifest.json` に固定し、trusted側でSHA-256を記録する。同じservice内でsnapshotとのbytes/hash一致とfixture manifest全体（rootの4 lifecycle eventsを含む）をnpm開始前・完了後に確認する。dependency sourceやProduct workspaceをstageしない。これはfixtureの入力・runtime確認であり、#662の最終provenance形式を定義しない。

source provenanceとruntime isolation boundaryを分離する。sourceの正本は`select_runtime()` / `runtime_provenance()`で、既存Node hardening fixtureと同じ固定root `/opt/hostedtoolcache/node` のinstalled Node 24/x64 candidateをpath降順に並べ、先頭を選択する。新規download/installやPATH fallbackは行わない。選択したversion directoryは `24.<整数>.<整数>`、Node実fileは同prefixの `bin/node`、npm launcher解決先は同prefixの `lib/node_modules/npm/bin/npm-cli.js` と完全一致させる。symlink全hopは選択distribution内、npm treeのlinkはnpm distribution内に限定し、loop・dangling link・特殊fileを拒否する。npm package metadataのname/bin/versionと選択Nodeで起動する両version commandの結果を照合し、source path / selected root / Node/npm version / Node・npm CLIのSHA-256をrun evidenceへ記録する。candidateなし・layout/pairing不一致・read/hash/version確認失敗はstaging/proxy/service開始前に停止し、別candidateへfallbackしない。

host source全ancestorのowner/mode/ACLをworkload isolationの合否条件にはしない。`/usr/local` / `/opt` 等を個別allowlistせず、host-global chmod/chownも行わない。trusted workflow/base/helper/runner imageをsetup側のtrust rootとし、このfixtureでrunner image自体の改竄耐性を証明するとは扱わない。sourceから必要runtimeだけをdisposable build rootへcopyし、そのNode/npm CLI hashがsource選択時と一致した後に `/run` 配下のfresh stagingへroot権限でcopyする。

実行時security boundaryの正本は`staged_snapshot()`が検証するroot-owned staged runtime snapshotである。restricted service起動前にstaging parent（rootから `/run` を含む）/ RootDirectory / runtime tree / ELF closure / boundary marker / manifest snapshotのroot UID/GID・group/other非書換・特殊permission不在・型を確認する。access ACLは拒否し、検査errorも `ENODATA` 以外はfail-closed。npm tree内の相対symlinkだけをcontainment検証して受理し、その他のsymlinkを拒否する。project/tmpだけを`nobody:nogroup`所有にし、marker token / manifest hash・bytes / sourceとstaged Node/npm hashの一致を検証完了してから既存serviceを起動する。service内のruntime/manifest書込不能と既存`ProtectSystem=strict`も維持する。service完了後もsnapshot・manifest・Node/npm hashを再検証し、sourceとstaged hashの対応をrun evidenceへ含める。

mockはmode `0777` のhost ancestorを含むsource選択成功、複数installed candidateの降順選択、unsafe PATH先頭非参照、source/pairing/symlink/read失敗時の停止、staged parent/runtime/library/marker/manifestのowner・mode・ACL違反とhash不一致時のservice未起動、完了後の不一致拒否を固定する。正式な実配置の受理・official candidate生成・2 fresh runs・proxy unavailable fail-closedは自然に走るAI Workflow Regressionで確認する。

#660の `command('lock', port)` / `runNpm` / npm env / config検査を変更せず使用する。[`npm-registry-lock-adapter.js`](scripts/npm-registry-lock-adapter.js) は同じrestricted service内の別Node processで、既存proxyにexact `CONNECT registry.npmjs.org:443` を行い、official hostname/certificateを検証したTLS socketで固定 `GET /is-number/7.0.0` だけを取得する。DNSやdirect dial、redirect、retryは行わず、5秒・64 KiB・HTTP 200・fixture identityを要求する。そのmetadataのversion entryを変更せず単一versionのpackumentへ包み、localhostの `GET /is-number` だけに返す。他method/path、tarball requestは403で拒否する。一般HTTP forwarderではなく、#649 proxyのCONNECT allowlistとpublic-address制限を変更しない。npm commandのlocalhost portはこのadapterを指す。

serviceはnpm開始前に自身のunit identityに対応したroot所有のvalidated property snapshotを確認する。同じrunner-local IP/portへのUDP `EPERM`、TCP `EPERM`またはtimeout、trusted listenerのaccept不存在と隔離外の前後TCP/UDP成功controlを要求する。arbitrary git / remote tarballとlocal file / directory / workspace sourceの独立証拠は既存#652/#654回帰を正本とし、再実装しない。envは既存固定値だけを使い、Secrets / GitHub write tokenを継承しない。host-global firewall/socket/mountを変更しない。

空cache・lockなしからconfig確認とexact lock commandを各1回実行し、#660 inventoryでmarkerなし・node_modulesなし・cache/candidate以外の変更なしを要求する。restricted probeはcandidate存在・fixture version/official tarball URLと生成bytesのSHA-256を記録し、adapter終了前後のcandidate一致を確認する。最終source/integrity検証は下記#662のtrusted phaseを正本とする。adapterの観測でmetadata requestが1件以上、content/unsupported requestが0件を要求し、dependency execution経路を`not-entered`と記録する。adapter/process/socket、service/unit、root、proxyを成功・失敗時ともcleanupする。

独立runnerでは2 fresh成功runsに加え、各cycleでproxyを停止して別のfresh rootを起動し、npm未起動・candidateなしのfail-closedを確認する。root再利用、workspace差分、host socket/resolver変更、cleanup不成立は拒否する。pure/mockは外部通信なしでmetadata異常・proxy障害・manifest/runtime/property不一致・direct deny不成立・npm失敗・marker/unexpected artifact・cleanup失敗を確認する。制限されたCodex serviceでは実runtimeを`SKIP`とし、official registry到達・candidate生成・実効境界の正式証拠と扱わない。独立GitHub Actions runnerではsystemd不在も失敗とし、自然に走るAI Workflow Regressionの結果で実証を確認する。

既存`test-*.sh` discovery以外のworkflow配線を追加せず、production developer / follow-up / #645からunreachableを維持する。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。candidateの最終validation / provenance / #645 handoffは下記#662、production wiringは#647を正本とする。

## npm generated lock validation / provenance / handoff（#662、dormant）

[`npm-registry-lock-runtime.py`](scripts/npm-registry-lock-runtime.py) の `freeze_candidate()` / `verify_handoff()` は#661のservice停止・collectとpost-run `staged_snapshot()` 成功後にだけ使用するtrusted phaseである。trusted base由来scriptと、service起動前からparent memoryに保持するexact manifest bytes/hash、source/staged Node/npm identity/hash、contract source hash、generation/run identityを入力とする。workload側manifest/provenance copyをtrusted evidenceにしない。restricted probeのhash・version・command・非実行結果は照合対象のclaimとしてのみ扱う。

trusted側でmanifest snapshot・project manifest・candidateをsymlink/hardlink/特殊file・過大入力を拒否して再読込し、exact manifest bytesと生成hashを照合してmemoryへfreezeする。source/integrity/manifest規則とJSON parseは#645 `prepare-product-npm.py` の `validate_lock()` / `manifest_dependencies()` / `parse()` を再利用し、複製・緩和しない。malformed lock、root/dependency不一致、non-official source、integrity欠落・不正はfail-closed。validation前後とartifact作成後にも入力bytesを再読込し、変化を拒否する。bootstrap commandは#660のtrusted constructorを評価して順序・個数を含め照合するだけで、npm/network/bootstrap/lifecycle proofを再実行しない。

出力はRootDirectory / workspaceと重ならないtrusted run専用directory配下のfresh `validated-lock-*` に限定する。run directoryとartifactはtrusted UID所有・mode `0700`・ACLなし、fileはmode `0400`とし、restricted `nobody` UIDと分離する。RootDirectory内へ公開せず、同一UID workloadのwiringにそのまま流用しない。handoff対象はexact `package.json` / validated `package-lock.json` / `provenance.json` の3 fileだけであり、node_modules/cache/tempは渡さずworkspaceへcopy/commit/pushしない。

provenance schema `1` / status `validated` / validation `pass` は、manifest SHA-256、generated/validated lock SHA-256、Node/npm versionとsource/staged hash対応、exact bootstrap command、#660 lifecycle非実行contract、#649/#652/#654/#661と関連boundaryのsource path/SHA-256 identity、canonical validator identity、generation root/id・run id、artifact path/idをbindする。handoff時はparent memoryの期待record全体と完全一致を要求し、必須field欠落・unknown identity・hash不一致・追加artifactを拒否する。lock/manifestを再hashし、#645 canonical validatorによる受入とvalidation後のbytes不変を確認する。provenance自身を書換えてhashを合わせてもtrusted recordとの不一致で停止する。

検証は `bash .github/scripts/test-npm-registry-lock.sh` に統合する。外部通信なしのpure/mockは不正lock、生成後/validation中/handoff前のmutation、provenance欠落・identity/hash不一致、#645受入、only snapshots、generation root削除後のhandoff、workspace不変・cleanupを確認する。同じinputでcontract/content hashの安定とfresh artifact/generation/run identityの差を区別する。正式runnerでは既存#661の2 fresh成功runsからfreezeし、generation root削除後にhandoffを再検証してからtrusted artifactも破棄する。失敗時も両rootをcleanupする。制限されたCodex環境のsystemd runtimeは`SKIP`であり、official candidateを使う統合証拠は自然に走るAI Workflow Regressionで確認する。追加のpaid diagnosticやworkflow配線は行わない。

Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。#645のcache warm / persistent cache / production callerは未接続。merge後の親#650完了判定と#647のlatest main fresh scope評価は人間・既存workflowの責務とする。

## npm production candidate offline ci lifecycle proof（#677、dormant）

検証は `bash .github/scripts/test-npm-offline-ci.sh`。[`npm-offline-ci-runtime.py`](scripts/npm-offline-ci-runtime.py) / [`npm-offline-ci-probe.js`](scripts/npm-offline-ci-probe.js) は#647のproduction配線前の独立fixtureである。exact production candidate commandの正本はprobeの`command('ci')`とし、引数の順序・個数、cwd `/project`、env `PATH=/runtime` / `HOME=/project` / `LC_ALL=C`を完全一致で固定する。

```bash
/runtime/node /runtime/npm/bin/npm-cli.js \
  --offline --ignore-scripts --package-lock=true \
  --audit=false --fund=false --update-notifier=false --workspaces=false \
  --include=dev --include=optional --include=peer \
  --fetch-retries=0 --fetch-timeout=5000 --registry=https://registry.npmjs.org/ \
  --userconfig=/project/empty.npmrc --globalconfig=/project/global.npmrc \
  --cache=/project/cache ci --json
```

#650/#660の`validateInvocation()`を共有し、CLI/env一致、空のuser/global/built-in npmrc、dangling symlinkを含むproject `.npmrc`不在をnpm起動前に要求する。config確認とciは各1回だけ実行する。effective `ignore-scripts=true`不成立、flag欠落・重複・上書き、alternate config、credential/npm/proxy env、timeout・signal・unsupported resultはfail-closedで、retryやhost npmへのfallbackはない。共通検査の抽出は#660のcommand/env/config契約を変更しない。

入力は#660のexact manifest（rootとdependencyに4 lifecycle events）とPythonで直接作ったdeterministic tarball、official resolved URL / SRI付きlockである。#645の`parse()` / `validate_lock()` / `prepare()`を使用する。外部通信を行わないfixture transportとして、`prepare()`のfresh専用cacheへローカルtarballを`npm cache add --offline --ignore-scripts`でseedし、準備ciに`--offline`だけを追加して実行する。validator・source policy・準備helper本体は変更しない。このtransportはofficial registry取得の実証ではない。成功した準備結果のcacheをdisposable `/project/cache`へcopyし、cache miss fixtureではそのcopyを空にする。persistent cacheやworkspaceへの書戻しはない。

実ci成功時はdependencyが1件展開され、installed manifest/scripts/writerがfixtureとbytes一致することを要求する。dependency content経路へ実際に入るため、#660の`dependency_execution_path:not-entered`は流用しない。rootとdependencyのmarker writerはproject markerとhost sentinelを試みる既存#660実装で、trusted側のmarker 0件・host side effect 0件を成功証拠とする。host sentinelは隔離外の同service UIDで前後に書込可能なことをcontrolで確認する。marker writerの各event・host `ENOENT`時にもprojectへ書く性質はmockで検証し、scripts-enabled npmは起動しない。`--ignore-scripts`単独を一般security proofと扱わない。

cache欠落時は同じexact ciが`ENOTCACHED`で失敗し、dependency content・markerがないことを要求する。成功/失敗の両経路でmanifest/lockのtrusted memory bytesとread-only runtime snapshotへの一致、canonical再validation、cache/node_modules以外のinventory不変、symlink/特殊file拒否を確認する。成功時のnode_modulesもfixture contentとhidden lockのexact closureに限定し、未知のnpm behaviorを受理しない。

正式runnerは#661のNode 24選択・source/staged hash・ACL正規化・`staged_snapshot()`、#654のroot構築・`isolationPreflight`・exact service command・hardening・unit cleanupを再利用する。#649のproperty observerは#646の`validate_properties()`で実効`IPAddressDeny=any` / `IPAddressAllow=localhost`を検証してroot所有snapshotへ固定する。同service内で#661の`snapshot()` / `directDeny()`を再利用し、runner-local non-loopback TCP拒否・UDP `EPERM`、trusted listener accept不存在、隔離外の前後TCP/UDP成功を要求する。registryを含むnon-loopback宛先を許可せず、external endpointへのdial/DNSやproxyは起動しない。IPv4/IPv6 localhost TCPとAF_UNIX IPCも同service内で成功させ、Responses用のsocket familyを維持する。protected socket・io_uring・filesystem境界を弱めない。

2 cyclesのそれぞれで成功用とcache miss用のfresh rootを分け、計4 rootsを実行する。unit・root・host sentinel・準備directory・listener/thread/socketを成功/失敗時ともcleanupし、host socket/resolverとworkspaceの不変を要求する。pure/mockはunsafe contract、lifecycle/manifest/lock/artifact mutation、境界・staging・service・証拠・cleanup失敗とretry不存在を検証する。local real npmは#656同様のPython subprocessでcanonical JS constructor由来commandを実行し、actual Node/writerを参照するscriptsを持つ4 fresh rootsでcache-only/`ENOTCACHED`を確認する。local operationはsystemd/network隔離の正式証拠とは区別する。

既存AI Workflow Regressionの`test-*.sh` discoveryだけで到達し、production developer / follow-up / #645からunreachable。制限されたCodex service内では独立runtimeを`SKIP`とし、正式実証済みと扱わない。独立GitHub Actions runnerではsystemd不在も失敗とする。#677のDone判定には自然に走る正式runnerの成功証拠を確認する。#645/#646/#650/#656関連回帰を維持する。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はなく、production wiringは#647の責務である。

## Product npm shared orchestrator（#682、dormant）

[`product-npm-orchestrator.py`](scripts/product-npm-orchestrator.py) のPython parent API `prepare(workspace, run_root, node, npm)` はcontext managerとしてrun-local `Handoff`を返す。trusted base由来moduleをtrusted parentで読み込み、handleと期待bytesをそのmemoryに保持する。CLIやproduction developer / follow-up配線は追加しない。

manifest不存在は`state/status=no-manifest`を返し、schema/state/statusと入力存在・不存在の証拠だけを保持する。exact manifestのみなら#645の`parse()` / `manifest_dependencies()`で検証して`state/status=bootstrap-required`を返し、exact manifestのbase64 snapshot/hashとlock不存在をhandoffする。両状態とも`prepare()`ではtool/version probe、registry/network、cache、dependency/lock生成、directory作成を行わない。bootstrap-requiredのNode/npm versionは未観測の`null`とし、`prepare()`から#650/#662を呼ばない。明示的なbootstrap接続は下記#691、locked preparationへの収束は下記#692が扱う。

manifest + lockは`state=locked`として#645の`validate_lock()`を再利用し、[`npm-locked-preparation.py`](scripts/npm-locked-preparation.py) を介して#649のregistry-only service内でのみ#645 `prepare()`を実行する。root所有のrun専用source / Node/npm copyと入力snapshotを作り、#654のruntime構築と#661のstaged snapshot / ACL検査を再利用する。#649のhardening・property observer・#646のlocalhost-only properties・direct deny probeを維持し、`nobody` serviceと別UIDのtrusted proxyを使う。proxyの正本allowlistはexact `registry.npmjs.org:443`のみで、serviceはnpm開始前に実効property・localhost到達・non-loopback TCP拒否/UDP `EPERM`・Host不一致等の`403`を検証する。#645の準備commandへlocalhost proxy、TLS検証有効、proxy bypassなし、fetch retryなしのtransport設定だけを追加する。境界/proxy不在、不一致、direct deny不成立では停止し、host direct npmへfallbackしない。

temporary build rootではProduct inputs / 空のbuiltin npmrc等の全書換え完了後、`cp -a`前に#661と同じphysical mode正規化を行う。symlink以外のdirectory / executableは`0755`、非executable fileは`0644`とし、host Node/npm source treeのpermission / ACLやsymlink targetを変更しない。staged copyのroot ownership・ACL除去・`staged_snapshot()`検査を維持する。

restricted workerは成功・失敗とも`diagnostic` schema `1`を返す。`stage`は`preflight` / `node-version` / `npm-version` / `npm-ci` / `post-validate` / `prepared`に限定し、`canonical_reason`は#645の既存fixed reasonまたは`null`だけを受理する。adapterがcanonical subprocess呼出しの前後で`npm_ci_entered` / `npm_ci_completed` / `node_version_probe_completed` / `npm_version_probe_completed`をbooleanとして追跡する。completedはsubprocess成功を表し、その後のcanonical version/input検証成功とは区別する。workerの`service_result`は`pass` / `error`のみ。trusted service launcherは失敗をassertする前に閉じたschemaを検証して診断を出力し、launcher側の結果を`pass` / `worker-error` / `invalid-evidence` / `observer-error` / `timeout` / `launch-error`で分類する。raw npm stdout/stderr、HTTP request/header、URL、package payload、env/credential、任意exception textは診断へ含めない。proxy counterは追加せず、stageとcanonical reasonで失敗箇所を絞る。#645 public evidence、#649 allowlist、transport/retry/fallback、service hardeningは変更しない。

専用cacheはfreshにwarmし、service停止・collect後にsource/runtime/input不変とlistenerのdirect accept不存在、隔離外の前後controlを確認してからtrusted領域へcopyする。unsafe cacheの型・link・所有者・permission・ACLをoffline npm開始前に拒否する。続いて#677 `candidate_command()`で正本constructorを評価し、引数のproject/cache pathとtrusted Node/npm pathだけをsetup用disposable directoryへ置換してoffline ciを1回行う。不完全cache、準備・offline ci失敗、入力変更はfail-closedで、alternate transport/direct external fallbackやretryはない。このreadiness確認は#677のexact restricted service実証を置き換えず、本adapterも#654のRootDirectoryによるfilesystem隔離の実証を置き換えない。

locked成功の`status=prepared` / shared handoff schema `1`はexact manifest/validated lockのbase64 snapshotとSHA-256、Node/npm version、cache path・device/inode・全cache inventory hash、preparation source contractと#649 boundaryのunit・実通信結果・proxy target・source/staged runtime hash、#645/#649/#677等のsource path/hash、#677 `command('ci')`のsource identity、expected post-workload manifest/lock hash、artifact identityをbindする。command列やlock validatorは別正本として複製しない。artifactはworkspace / `RUNNER_TEMP`と重ならない呼出UID所有・mode `0700`・ACLなしのrun専用rootに置き、snapshot/handoff fileはmode `0400`とする。

`Handoff.record()`のJSON copyはclaimであり、`verify(claim)`はtrusted parent memoryの期待record全体と照合し、snapshot/source/cache identity・bytes/hash・入力不変を再検証する。workspaceやworkload-writable `RUNNER_TEMP`のcopyを期待証拠として再読込しない。private path/modeだけで同一UID workloadからの保護を保証せず、後続production wiringはtrusted parent memoryの保持とworkloadとの隔離を別途成立させる。context終了・失敗時は全準備artifact/cacheをcleanupし、handleをexpireする。post-workload verifierは下記#684、caller-specific workspace policyと消費用cacheは下記#702が扱い、persistent cache、Product package/version選定は扱わない。

検証は `bash .github/scripts/test-product-npm-orchestrator.sh`。外部通信なしのpure/mockで3状態、stop時のtool/cache未起動、不正入力、handoff field/snapshot/source/cache改変、workspace不変、cleanup失敗とproduction unreachableを固定する。local tarballをseedするfixture専用transportで#645の実準備と#677 constructor由来offline readinessをcold/repeated cacheで確認し、cache欠落の失敗・root/dependency lifecycle非実行を検証する。追加の `bash .github/scripts/test-npm-locked-preparation.sh` はmandatory boundary・transport・準備失敗・unsafe export・host fallback不存在をpure/mockで検証する。独立systemd runnerでは#661の既存TLS/CONNECT metadata adapterから固定official fixture `is-number:7.0.0`のlockを直接構成し、bootstrapなしでorchestrator自身のcold/repeated locked preparationとoffline readinessを同じ#649 restricted経路で成功させる。proxy停止後の同経路の失敗、cleanup、workspace・host socket/resolver不変も確認する。制限されたCodex環境の実runtimeは`SKIP`であり、正式証拠は自然に走るAI Workflow Regressionのcurrent HEAD結果で確認する。既存discoveryのみを使い、production workflow / paid AI / Secrets / GitHub write tokenには接続しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

## Product npm bootstrap composition（#691、dormant）

[`product-npm-orchestrator.py`](scripts/product-npm-orchestrator.py) の明示的なcontext manager `bootstrap(input_handle, run_root)` は、activeな#682 `Handoff`の`state/status=bootstrap-required`だけを受理する。serialized recordやworkspace / `RUNNER_TEMP` copyを入力証拠にせず、parent memoryのexact manifest bytes / snapshot / hash一致を確認する。`prepare()`のno-manifest / bootstrap-required停止・existing locked動作は維持する。output rootはworkspace / repository / `RUNNER_TEMP`と重ならないtrusted UID所有・mode `0700`・ACLなしとし、呼出ごとにfresh `bootstrap-run-*`を作る。

[`npm-registry-lock-runtime.py`](scripts/npm-registry-lock-runtime.py) の `generate_validated()` は#650/#661のruntime選択・root構築・registry-only proxy・property observer・service hardening・direct deny・前後controlを再利用し、exact manifest bytesだけをstageする。#660 `command('lock', port)` / `runNpm()` / env / config / inventoryを正本とし、commandの複製やhost npm fallback、retryはない。service停止・collectとpost snapshot確認後にだけ#662 `freeze_candidate()`を呼び、generation root削除後にも`verify_handoff()`を行う。proxy / listener / rootのcleanupとhost socket / resolver / workspace不変確認が完了するまで成功artifactを公開しない。

#661の固定fixture transportは維持し、明示bootstrap modeだけで同じTLS/CONNECT metadata adapterへ#645が検証したroot dependency集合を渡す。rootのofficial packumentとexact version identityをnpm開始前に確認し、npmからのrequestは通常名またはscoped名のmetadata `GET`だけを受理する。transitive packumentも同じ固定official hostname・TLS certificate検証・既存proxy経路で取得する。各responseは5秒・64 KiB・HTTP 200に束縛し、redirect / credential転送 / direct dial / tarball / arbitrary URL / query / traversalを許可しない。metadata不正・取得失敗・content/unsupported requestはfail-closed。metadataはrun-local memoryだけに保持し、npm cacheもgeneration rootとともに破棄する。依存なしのmanifestだけはmetadata request 0件を受理し、同じexact commandとcanonical validationを使う。

成功出力の `ValidatedBootstrap` は#662 provenance schemaをそのまま使い、manifest snapshot/hash、generated / validated lock snapshot/hash、artifact path/id、generation root/id・run id、Node/npm source/staged identity、#650/#662 contract identity、lifecycle resultをbindする。snapshotはartifact内のexact `package.json` / `package-lock.json`であり、candidateやworkload-writable copyを期待証拠として渡さない。`verify(claim)`はparent memoryのrecord全体、元の#682 handle、artifact device/inode・source contract、#662 `verify_handoff()`を再検証する。context終了時はhandleをexpireしてrun専用artifactを破棄し、cleanup失敗を成功にしない。

検証は `bash .github/scripts/test-product-npm-bootstrap.sh` と#650/#662/#682関連回帰。外部通信なしのpure/mockでmetadata経路・不正candidate / provenance / mutation / cleanup・反復hash安定とfresh identity・generation root削除後のverify・workspace不変・production unreachableを確認する。独立systemd runnerでは#682 exact manifest handleから2 fresh official bootstrap runsを実行し、validated artifactを検証する。制限されたCodex環境の実runtimeは`SKIP`とし、正式証拠は自然に走るAI Workflow Regressionで確認する。production workflow / paid AI / Secrets / GitHub write token・persistent cacheは未接続。validated artifactを#682 locked preparationへ渡すこととfinal shared handoffは下記#692、post-workload verifierは下記#684、workspaceへのtrusted lock materializationは下記#702、production wiringは後続の責務とする。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。


## Product npm validated bootstrap locked preparation（#692、dormant）

[`product-npm-orchestrator.py`](scripts/product-npm-orchestrator.py) の明示的なcontext manager `prepare_bootstrap(validated, run_root, node, npm)` はactiveな#691 `ValidatedBootstrap`だけを受理する。`prepare()` → `bootstrap()` → `prepare_bootstrap()`をtrusted parentのnested contextで使用し、serialized claim、candidate-only / unvalidated lock、失効handleはlocked準備へ渡さない。`ValidatedBootstrap.verify()`（#662 `verify_handoff()`を含む）の成功後にexact manifest / validated lock bytesをmemoryへ読み、trusted manifestとの一致、generated / validated lock hashとの一致と再検証を要求する。#650/#662のschema・generation・validation・commandは変更しない。

workspace / repository / `RUNNER_TEMP`と重ならないprivate run root配下にfresh `bootstrap-composition-*`を作り、mode `0700`・ACLなしの`inputs` / `locked`を兄弟directoryとして置く。mode `0400`のexact snapshotsを`inputs`へmaterializeし、既存#682 `prepare(inputs, locked, node, npm)`をそのまま再利用する。#649 registry-only cache preparation、unsafe cache拒否、#677 constructor由来offline readiness、shared handoff検証は複製しない。元workspaceへlockを書かず、direct existing-lock / no-manifest経路はbootstrapへ接続しない。

成功出力は同じ`Handoff` / shared schema `1` / `state=locked` / `status=prepared`で、既存locked fieldsの意味を維持する。`input_presence`と`expected_post_workload_hashes`はmanifest / validated lockの準備済みsnapshotを示し、元workspaceのlock不存在は元のactive #682 handleで別途検証する。追加field `bootstrap_provenance`には#691が再検証した#662 record全体をそのままbindし、generation root/id・run id・artifact path/id、generated / validated lock hash、#650/#662と関連source contract identityを保持する。final `verify(claim)`でも#691/#662のactive handleとrecord完全一致、元workspace入力不変、既存#682のsnapshot/source/cache検証を要求する。

このAPIはvalidated handleをconsumeする。成功・失敗・consumer例外のいずれでもinner handoff / final handle / validated handleをexpireし、準備cache/artifact、private input、#691 validated artifactを破棄する。上位`bootstrap()` contextは残るrun directoryをcleanupする。cleanup失敗は伝播し、retry / fallbackしない。post-workload verifierは下記#684、caller-specific workspace policyは下記#702とし、production wiring、persistent cache、Product package/version選定は後続の責務とする。

検証は `bash .github/scripts/test-product-npm-bootstrap-preparation.sh` と#662/#677/#682/#691関連回帰。外部通信なしのpure/mockでcanonical #662 freeze/verifyから既存locked preparationへの収束、existing locked fieldsとprovenanceの完全一致、bytes/hash/provenance/source identity mutation・失効・未検証入力の拒否、locked/cache/offline/consumer/cleanup失敗、反復content hash安定・fresh identity、workspace不変・lock不存在、production unreachableを確認する。依存なしのlocal real npmでも既存準備とoffline readinessを実行する。独立systemd runnerでは2 fresh official bootstrap → locked preparation成功と、bootstrap成功後のlocked proxy停止によるfail-closed・cleanupを同じAPIで確認する。制限されたCodex環境の実runtimeは`SKIP`であり、正式証拠は自然に走るAI Workflow Regressionで確認する。既存fixture discoveryのみを使い、production workflow / paid AI / Secrets / GitHub write tokenは未接続。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。


## Product npm post-workload verifier（#684、dormant）

[`product-npm-orchestrator.py`](scripts/product-npm-orchestrator.py) の `verify_post_workload(handoff, claim=None)` は、trusted parentがworkload開始前からmemoryに保持するactiveな `Handoff` を唯一の期待証拠とするread-only gateである。#682の3 stateと#692のfinal bootstrap-origin locked handoffを同じAPIで検証する。serialized record、workspace / workload-writable `RUNNER_TEMP` copy、失効handleは期待証拠として受理しない。任意の `claim` は既存 `Handoff.verify(claim)` による完全一致の照合対象だけであり、originや期待hashを上書きしない。trusted base由来module、parent memory保持とworkload隔離はcallerの前提で、private path / modeだけによる同一UID workloadからの保護保証は追加しない。

`expected_post_workload_hashes` はprepared snapshotのhashとして照合し、workspace presenceのoracleにしない。workspace期待値はdirect originではparent-held original pair、bootstrap originでは元のactive input handleが保持するmanifest-only pairとする。direct existing-lockでは元のmanifest / lockのpresence・exact bytes/hash不変を要求する。bootstrapではgenerated / validated lockのhash対応とprepared snapshotを検証し、workspaceのlock不存在を要求する。prepared lockと同じbytesがworkspaceへ現れても `lock-presence-mismatch` で拒否し、verifierは書き戻さない。no-manifestでは元のpair全体（元からlockだけ存在する場合も含む）を維持し、新しいmanifest / lock生成を拒否する。別途確定したcaller-specific許可変更は下記#702のsessionだけで扱い、本APIのoriginal-workspace契約は維持する。

prepared hash / base64 snapshot対応を確認した後、既存 `Handoff.verify()`、active `ValidatedBootstrap.verify()`、#645 canonical validatorと#662 `verify_handoff()` を再利用する。artifact全record・exact bytes/hash・bootstrap provenance・source contract・Node/npm version identity・#677 offline command source identity・dedicated cache path/device/inode/inventoryをtrusted memoryと再照合する。Node/npmの再起動・version probe、準備/bootstrap再実行、schema/commandの複製、cache変更、workspace writeは行わない。

返却schema `1` は `status:pass / error`、`state:no-manifest / bootstrap-required / locked / unknown`、`manifest_hash_check` / `lock_hash_check` / `prepared_evidence_check` / `provenance_check` / `preparation_identity_check`、`category`、`reason` を持つ。各checkは `pass / fail / not-checked / not-applicable`。workspaceの不存在一致もhash checkの `pass` とし、stop stateのprovenance / preparation identityは `not-applicable` とする。prepared evidenceの全検証成功後だけprovenance / identityを `pass` にし、途中拒否では未完了のcheckを成功へ昇格しない。callerは全gate通過の `status=pass` だけで成功を判定する。

拒否categoryは `trusted-handoff / workspace / prepared-evidence`、reasonは `invalid-trusted-handoff`、`unsafe-workspace-input`、`manifest-presence-mismatch` / `lock-presence-mismatch`、`manifest-hash-mismatch` / `lock-hash-mismatch`、`prepared-hash-mismatch`、`prepared-snapshot-mismatch`、`bootstrap-hash-mismatch`、`handoff-verification-failed` に固定する。成功時はcategory / reasonとも `null`。malformed/missing evidence、unsafe path・symlink/hardlink/特殊file、予期しない検証例外もfail-closedとし、raw例外・入力文字列・secretを返さない。検証はhandleをexpireせず反復可能で、cleanupは既存context managerの責務を維持する。

短いcallerは既存preparation context内でworkload終了後に使用する。developer / follow-upへのproduction接続は行わない。

```python
result = orchestrator.verify_post_workload(handoff)
if result['status'] != 'pass':
    raise RuntimeError(result['reason'])
```

検証は `bash .github/scripts/test-product-npm-post-workload.sh` と#662/#677/#682/#691/#692関連回帰。外部通信なしのlocal/mock preparationと実#662 freeze/verifyで全origin、manifest/lock追加・削除・改変、validated lock/provenance/hash/identity改変、malformed/missing claim・artifact、失効、unsafe入力/path、反復決定性、成功/失敗時の書込み不存在とproduction unreachableを確認する。新fixtureはlocal gateだけを扱い、systemd / registryの正式証拠は既存fixtureの自然なAI Workflow Regression結果で確認する。既存 `test-*.sh` discoveryだけを使い、production workflow / paid AI / Secrets / App permissionは未接続。Product #638 / Draft PR #641のblockerは状態参照に留め、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。


## Product npm workload session boundary（#702、dormant）

[`product-npm-orchestrator.py`](scripts/product-npm-orchestrator.py) の `workload_session(handoff, export_root=None)` は、activeな#682 / #692 `Handoff`を保持する同一trusted parent内のcontext managerである。pre-workload準備 → `session.run(consumer)` → post-workload gateの間、期待bytes・origin・bootstrap provenanceはparent memoryを正本とし、serialized claimからsessionを復元しない。consumerはtrusted launcher callbackであり、将来workloadを起動・待機する責務を持つ。本Issueではproduction workflow / paid AIへ接続しない。

consumerへ渡すread-only contractは `policy` と `cache_path` だけとする。policyの機械正本は下記#710の `state_policy(origin)` とする。no-manifestではtrusted setupによるworkspace/cache書込みを行わず、cache pathは `null`、package.json新規作成だけを許可する。作成fileには#645のsafe regular single-link読込み・`parse()` / `manifest_dependencies()`を再利用し、valid JSON・exact registry version・unsupported mechanism不存在を要求する。lock生成を拒否し、npm output/config/cacheの既存inventory（`node_modules` / `npm-shrinkwrap.json` / `cache` / `.npm*` / `.package-lock.json*` / `npm-debug.log*`）の変化も拒否する。元からlockだけあるno-manifestや、まだlocked準備を終えていないbootstrap-required handleはsessionへ受理しない。Product package/versionの選定は通常のdiff / human reviewに残す。

bootstrap originでは#691 / #662と#692のactive evidenceおよび元manifest-only workspaceを再検証してから、validated prepared lockのexact bytesだけをdescriptor-relativeな排他的新規作成でmaterializeする。既存lockはprepared hash一致でも拒否する。unsafe path / symlink / hardlink / special fileを拒否し、workspace identity・新規lock identity・書込前後hash一致をparent memoryへbindする。workload baselineはexact manifest + trusted materialized lockとする。direct lockedではtrusted workspace writeを行わず元のexact pairをbaselineにする。両者ともpost-workloadのmanifest / lock変更を拒否する。

locked / bootstrapの `export_root` はtrusted evidenceと重ならない呼出UID所有・mode `0700`・ACLなしの既存directoryとし、その配下のfresh `npm-consumable-*/cache`だけをconsumerへ渡す。trusted cacheとのbytes/type対応、別directory/file identity、source cache不変を公開前に検証する。公開後のexport改変は許可し、exportをexpected evidenceとして再利用しない。handoff / artifact / provenance / source identityやtrusted pathはconsumer contractへ渡さない。private modeだけでは同一UID workloadへの保護にならず、trusted rootのfilesystem隔離とtrusted base由来moduleの使用は後続#679 production wiringの責務とする。persistent cacheには昇格しない。

`session.run()` は1 callbackだけを実行し、返値がexact `True`の場合にだけpost gateへ進む。例外・その他返値は `consumer-failed`。`session.verify()` はactiveかつ正常完了したsessionにだけ、workspace policyと既存prepared evidence / provenance / source / command / cache identityの検証を分けて反復実行する。#684 `verify_post_workload()` / public `Handoff.verify()` / `ValidatedBootstrap.verify()` のoriginal-workspace semanticsは変更しない。

machine result schema `1` は `status:pass / error`、`origin`、`workspace_check` / `prepared_evidence_check`（`pass / not-checked`）、`category`、固定 `reason` を返し、raw workload値・例外・secretを含めない。成功時category / reasonは `null`。拒否reasonは `active-completed-session-required` / `pre-workload-verification-failed` / `consumer-failed` / `workspace-policy-failed` / `prepared-evidence-failed`。callerは `status=pass`だけを成功として扱い、contextの準備・cleanup例外も失敗とする。context終了時はsessionを失効させ消費用exportを破棄し、trusted artifactのcleanupは外側の既存preparation contextが担う。

```python
with orchestrator.workload_session(handoff, consumable_root) as session:
    result = session.run(launch_and_wait)  # callback(contract) returns exact True on success
    if result['status'] != 'pass':
        raise RuntimeError(result['reason'])
```

検証は既存focused fixture `bash .github/scripts/test-product-npm-post-workload.sh` に統合し、#678 / #684関連回帰も実行する。外部通信なしのpure/mockと実#662 freeze/verifyで3 origin、safe manifest作成、lock / npm side effect・不正入力拒否、trusted materialization、baseline変更、evidence改変、消費用cache分離・改変、active lifetime、consumer失敗、反復決定性、cleanup、production unreachableを確認する。fixtureのproduction guardは既存orchestrator fixtureと同じexact AST検査を使い、selector内の宣言的inventory参照だけを許可する。追加workflow・paid diagnostic・GitHub write・commit/pushはない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。Product #638 / Draft PR #641はblocker状態の参照に留める。

## Product npm pure production session（#710、dormant）

`CanonicalRoot(path)` はabsolute canonical existing directoryだけを受理し、relative / `..` / symlink ancestor / missing / non-directoryを拒否する。descriptor-relativeなdevice/inode ancestryにLinux `/proc/self/mountinfo` のdevice/root座標を併用し、bind alias越しの同一・祖先関係も検出する。`RootBoundary(workspace, repository, trusted_roots=(), consumable=None)` は4群間のphysical overlapを拒否する（trusted evidence群内のnested rootは許可）。`verify()` は保持したancestry・mount identityとの再一致を要求し、観測不能・不一致をlexical判定へfallbackしない。#702 sessionではtrusted moduleのrepository rootを使用し、cache export / lock materialization前とpre/post gateで境界を再検証する。これはfilesystem namespace隔離や同一UIDの並行攻撃に対する保護証明ではない。

`state_policy(origin)` は `no-manifest / bootstrap / locked` のclosed read-only policyを返す。既存の `allow_create_manifest` / `allow_generate_lock:false` に `allow_install` / `allow_registry_resolution:false` / `preserve_manifest_lock_bytes` / `dependency_versions:canonical-exact-registry` と固定 `prompt` を加え、上記#702の許可変更を一箇所から取得する。no-manifestのinstallを禁止し、bootstrap / lockedではprepared dependencyだけを使用する。raw Issue・secret・trusted path・Product package/versionをpolicyへ埋め込まない。

`production_session(handoff, consumer, export_root=None)` はactiveな#682 / #692 handleを同一parent memoryに保持したまま#702をcomposeする。準備済みhandleが前提で、bootstrap生成やnpm準備を再実行しない。consumer contractは引き続き `policy` / `cache_path` だけであり、runtime consumerのexact `True`完了後に同じparentでpost gateを実行する。結果schema `1` は `status` / `origin` / `category` / 固定 `reason` / `downstream_write_allowed` / `failure_ownership` を返す。context cleanupまで成功した `status:pass` / `downstream_write_allowed:true` だけが後続writeを許可し、helper自身はgit commit/pushしない。

bootstrap成功時のlock ownershipは `retained`。pre/consumer/post失敗ではactive sessionの `cleanup_materialized_lock()` が保持するfile device/inode・exact bytes/hash・workspace/root identityを照合し、一致したlockだけを削除して `removed` とする。変更・置換・欠落・不明状態は `dirty` / hard failで、consumerのmanifest変更等はrollbackしない。session entry failureはidentity/hash証拠を取得できないため保守的に `dirty` とする。no-manifest / lockedは `none` でworkspace cleanupしない。cleanup結果によって失敗を成功へ昇格せず、ephemeral runner破棄をsecurity契約にしない。#684 public verifierのoriginal-workspace semanticsを維持する。

検証は既存 `bash .github/scripts/test-product-npm-post-workload.sh` に統合する。canonical/physical ancestry・synthetic bind alias・identity変化、3 origin composition、policy非漏洩、consumer不正返値/例外、pre/post失敗、trusted lock cleanupのidentity/hash guardと反復検証を含む。#711のruntime接続・独立proofとfixture / selector / cross-suite guard統合は下記を正本とする。production activationは#708に残す。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。


## Product npm independent production session runtime（#711、dormant）

[`product-npm-session-runtime.py`](scripts/product-npm-session-runtime.py) の `run_session()` はsecretless synthetic consumer専用のdormant boundaryであり、#710のclosed `production_session()` callback内で#654 restricted serviceを起動・待機する。raw sessionを取得・保持・公開しない。trusted helper checkoutとsynthetic workspace、trusted preparation / bootstrap evidence、consumable exportは物理分離し、同一parentの既存preparation contextをpost gateまで保持する。production workflowからのcaller、paid model call、repository write、registry / generic internet accessは追加しない。実production配置とactivationは#708の責務とする。

locked / bootstrapではsynthetic workspaceを `/project`、#702がbytes/type一致を検証済みのfresh消費用cacheだけを `/project/cache` へbindする。trusted evidenceはstage/bindせず、workload argvには固定alias・bounded synthetic recordだけを渡す。service内の `/tmp` の空検証、既存root inventory / host path / protected socket preflightでhost tree非露出を確認する。no-manifestではworkspace/cacheを公開せずdisposable projectでnetwork / isolationだけを確認し、npm ciを実行しない。別UIDのservice用にsynthetic workspace/export所有者を一時変更し、unit終了後に呼出UIDへ戻す。これはproduction配置方式の決定ではない。

bootstrap / locked installは#677の `probe()` / `command()` / config / env / lifecycle / cache miss検証をそのまま再利用する。cache missのproofが成功してもconsumer開始へ昇格させない。sourceとconstructor identity、root-owned staged runtimeの型・mode・ACL・bytes、source/staged Node/npm hashを検証し、post gateも同一parentで行う。network snapshotは#646のexact propertiesに加えNoNewPrivileges / caps zero / io_uring filterの実効設定を確認してから公開する。既存localhost / non-loopback TCP・UDPとlistener前後control、unit停止・collect、staging/export cleanupを維持する。診断は固定case/statusだけでraw evidence・例外を出力しない。

post-serviceのstaged snapshot差分は、追加path集合がexactly `root/etc`, `root/usr`, `root/var`, `root/run/systemd`, `root/run/systemd/incoming` の5件で、削除も既存entryのmetadata / content変更もない場合だけsystemd residualとして許容する。trusted側でroot UID/GID所有・directory型・group/other書込不可・ACLなしを再検証し、incoming以外は特殊permissionも拒否する。expected-empty shapeは `root/etc` / `root/usr` / `root/var` が空、`root/run/systemd` の直下が `incoming` 1件だけとする。`incoming` の内容は列挙せず、service内の非露出検証は上記#654の既存contractを維持する。それ以外のresidual・属性・content差分や検証不能はfail-closedとする。

#715ではcleanup例外をそのままparentへ伝播させ、`NameError` へ置換しない。parentの固定reasonと `downstream_write_allowed:false` を維持し、raw例外・path・secretのlogを追加しない。#654 `service(..., command_factory=None)` は呼出時に `command_factory or command` を解決する。明示注入APIを維持し、省略時は現在のmodule `command` を使用する。`run_session()` の明示 `command_factory=launch` は維持する。

検証は [`test-product-npm-production-session.sh`](scripts/test-product-npm-production-session.sh)。local tarballによる実#645準備と#677 offline readiness、synthetic generationと実#662 freeze/verifyを使い、registry取得やbootstrap generation自体の実証とは区別する。3 originの成功、entry / cache / export / source / command / unsupported property失敗時のconsumer未開始、consumer失敗、manifest/lock改変、bootstrap lockの `retained / removed / dirty` と失敗時write不許可を確認する。#715のlocal mockはcleanup例外の保持・write不許可、exact residual受理・未知path / metadata / content変更の拒否、command factoryの呼出時defaultと明示注入を固定する。新fixtureはProduct npmへexactly-once登録し、helper / probe / fixture変更でProduct npm + commonを選ぶ。#709 trigger filtering / three-dot diff / inventory mismatch時fullは維持する。

filesystem supportはLinux `/proc/self/mountinfo` の最深mountが一意で `st_dev` のmajor:minorと一致し、descriptor ancestry・mount identityが安定している構成に限定する。fixtureは実際のfilesystem種別・mount ID・deviceだけをboundedに観測し、device不一致・同深度mount曖昧性はlexical fallbackなしで拒否する。btrfs subvolume / overmount等を一般対応済みとは主張せず、不一致構成はfail-closedとする。GitHub-hosted runnerの対応実証はcurrent-head AI Workflow Regressionの成功証拠で確認する。Codex環境のlocal検証と独立systemd実測は区別し、独立GitHub Actionsではsystemd不在・継承Codex境界によるSKIPを禁止する。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。
