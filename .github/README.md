# GitHub project configuration

GitHub Actions workflows、Issue Forms、Pull Request template、およびAI開発・レビュー用の補助scriptを格納する。

運用手順は [`docs/30_operations/ai-development-workflow.md`](../docs/30_operations/ai-development-workflow.md) を参照する。

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

検証は `bash .github/scripts/test-prepare-product-npm.sh`。pure / mock fixtureに加え、ローカルtarballを専用cacheへseedした実npmの`--offline`実行でlifecycle非実行と反復`ci`を確認する。実registryやpaid AI callは不要で、既存AI Workflow Regressionの`test-*.sh`全件実行で検出される。

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

manifest不存在は`state/status=no-manifest`を返し、schema/state/statusと入力存在・不存在の証拠だけを保持する。exact manifestのみなら#645の`parse()` / `manifest_dependencies()`で検証して`state/status=bootstrap-required`を返し、exact manifestのbase64 snapshot/hashとlock不存在をhandoffする。両状態ともtool/version probe、registry/network、cache、dependency/lock生成、directory作成を行わない。bootstrap-requiredのNode/npm versionは未観測の`null`とし、#650/#662を呼ばない。後続#683がbootstrap接続を扱う。

manifest + lockは`state=locked`として#645の`validate_lock()`を再利用し、[`npm-locked-preparation.py`](scripts/npm-locked-preparation.py) を介して#649のregistry-only service内でのみ#645 `prepare()`を実行する。root所有のrun専用source / Node/npm copyと入力snapshotを作り、#654のruntime構築と#661のstaged snapshot / ACL検査を再利用する。#649のhardening・property observer・#646のlocalhost-only properties・direct deny probeを維持し、`nobody` serviceと別UIDのtrusted proxyを使う。proxyの正本allowlistはexact `registry.npmjs.org:443`のみで、serviceはnpm開始前に実効property・localhost到達・non-loopback TCP拒否/UDP `EPERM`・Host不一致等の`403`を検証する。#645の準備commandへlocalhost proxy、TLS検証有効、proxy bypassなし、fetch retryなしのtransport設定だけを追加する。境界/proxy不在、不一致、direct deny不成立では停止し、host direct npmへfallbackしない。

temporary build rootではProduct inputs / 空のbuiltin npmrc等の全書換え完了後、`cp -a`前に#661と同じphysical mode正規化を行う。symlink以外のdirectory / executableは`0755`、非executable fileは`0644`とし、host Node/npm source treeのpermission / ACLやsymlink targetを変更しない。staged copyのroot ownership・ACL除去・`staged_snapshot()`検査を維持する。

専用cacheはfreshにwarmし、service停止・collect後にsource/runtime/input不変とlistenerのdirect accept不存在、隔離外の前後controlを確認してからtrusted領域へcopyする。unsafe cacheの型・link・所有者・permission・ACLをoffline npm開始前に拒否する。続いて#677 `candidate_command()`で正本constructorを評価し、引数のproject/cache pathとtrusted Node/npm pathだけをsetup用disposable directoryへ置換してoffline ciを1回行う。不完全cache、準備・offline ci失敗、入力変更はfail-closedで、alternate transport/direct external fallbackやretryはない。このreadiness確認は#677のexact restricted service実証を置き換えず、本adapterも#654のRootDirectoryによるfilesystem隔離の実証を置き換えない。

locked成功の`status=prepared` / shared handoff schema `1`はexact manifest/validated lockのbase64 snapshotとSHA-256、Node/npm version、cache path・device/inode・全cache inventory hash、preparation source contractと#649 boundaryのunit・実通信結果・proxy target・source/staged runtime hash、#645/#649/#677等のsource path/hash、#677 `command('ci')`のsource identity、expected post-workload manifest/lock hash、artifact identityをbindする。command列やlock validatorは別正本として複製しない。artifactはworkspace / `RUNNER_TEMP`と重ならない呼出UID所有・mode `0700`・ACLなしのrun専用rootに置き、snapshot/handoff fileはmode `0400`とする。

`Handoff.record()`のJSON copyはclaimであり、`verify(claim)`はtrusted parent memoryの期待record全体と照合し、snapshot/source/cache identity・bytes/hash・入力不変を再検証する。workspaceやworkload-writable `RUNNER_TEMP`のcopyを期待証拠として再読込しない。private path/modeだけで同一UID workloadからの保護を保証せず、後続production wiringはtrusted parent memoryの保持とworkloadとの隔離を別途成立させる。context終了・失敗時は全準備artifact/cacheをcleanupし、handleをexpireする。post-workload verifier最終API、persistent cache、Product package/version選定は扱わない。

検証は `bash .github/scripts/test-product-npm-orchestrator.sh`。外部通信なしのpure/mockで3状態、stop時のtool/cache未起動、不正入力、handoff field/snapshot/source/cache改変、workspace不変、cleanup失敗とproduction unreachableを固定する。local tarballをseedするfixture専用transportで#645の実準備と#677 constructor由来offline readinessをcold/repeated cacheで確認し、cache欠落の失敗・root/dependency lifecycle非実行を検証する。追加の `bash .github/scripts/test-npm-locked-preparation.sh` はmandatory boundary・transport・準備失敗・unsafe export・host fallback不存在をpure/mockで検証する。独立systemd runnerでは#661の既存TLS/CONNECT metadata adapterから固定official fixture `is-number:7.0.0`のlockを直接構成し、bootstrapなしでorchestrator自身のcold/repeated locked preparationとoffline readinessを同じ#649 restricted経路で成功させる。proxy停止後の同経路の失敗、cleanup、workspace・host socket/resolver不変も確認する。制限されたCodex環境の実runtimeは`SKIP`であり、正式証拠は自然に走るAI Workflow Regressionのcurrent HEAD結果で確認する。既存discoveryのみを使い、production workflow / paid AI / Secrets / GitHub write tokenには接続しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。
