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

production developer / follow-upからはunreachableで、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの変更はない。後継の順序は **#649 → #652（network source escape）→ #654（filesystem source / lifecycle境界）→ #650（initial lock）→ #647（production wiring）**。本fixtureのnetwork proofだけで後継のescape検証やbootstrap完了とは扱わない。

## npm/git network source escape（#652、dormant）

検証は `bash .github/scripts/test-npm-network-sources.sh`。[`npm-network-source-probe.py`](scripts/npm-network-source-probe.py) は上記#649 runtimeのroot所有source copy、別UID proxy、service hardening、実効property snapshotと#646 primitiveを再利用するfixtureであり、production launcherではない。registry positive proofは#649の固定metadata GETを同じrestricted service内で再利用し、proxyやnetwork境界を再実装しない。

実npmの `view` と実gitの `ls-remote` がproxy指定なしでrunner自身のnon-loopback HTTP endpointへ接続できないことを確認する。同じnpm/git commandの前後のunrestricted control成功、同じsource IP/portへのUDP `EPERM`、restricted service中のlistener accept不存在を組み合わせ、失敗exitやTCP timeoutだけをdeny証拠にしない。direct subprocessの5秒deadline到達はtimeoutとして記録し、process groupを停止する。proxy経由のcommand timeoutは検証失敗で、再実行しない。

arbitrary git HTTPSは実gitの `ls-remote` と実npmの `cache add git+https://...`、remote tarballは実npmの `cache add https://...tgz` で試し、各commandの失敗とproxyの明示 `403` を要求する。宛先はnumeric runner-local IPとfixture portに固定し、外部任意hostへのprobe・DNS lookupを行わない。npm `allow-git` / `allow-remote` は有効にしてnetwork境界を検証し、これらのoptionをsecurity boundaryにしない。

npm/gitへ継承env・credentialは渡さず、空のuser/global npmrc、専用HOME/cache、git設定・prompt無効化を使う。`--ignore-scripts` / `--package-lock=false` を指定し、lock / node_modules不在を確認する。proxy停止後も同じrestricted serviceでdirect拒否とnpm/gitのconnection refusalを要求し、unrestricted fallbackを認めない。boundary preflight不成立時はnpm/gitを起動しない。

control → restricted → control → proxy停止検証を2回実行し、#649のunit / proxy / host socket・resolver不変検証に加え、source listener、subprocess groupとdisposable HOME/cacheをcleanupする。source検証付きserviceの期限は70秒、runner側waitは80秒とし、property観測の10秒期限は変えない。既存AI Workflow Regressionのfixture discoveryだけで実行する。

pure / mock検証は外部通信なし。独立runnerでは実npm/gitのlocal control・proxy拒否・proxy不在を外向きdialなしで先に検証し、その後systemd runtimeで実効direct拒否とregistry到達を検証する。制限されたCodex serviceではsocket/runtimeを `SKIP` とし、実npm/git・実効filter・registry到達の実証済みとは扱わない。独立GitHub Actions runnerのsystemd不在は失敗とする。

Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの変更はなく、production developer / follow-upは未接続。local file / directory / workspace sourceとlifecycle境界は#654、lock生成は#650、production wiringは#647に残す。scopeと後継順序の正本は#652のIssue本文とし、本検証だけで後継の完了とは扱わない。
