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

後継#649はregistry-only bootstrap境界への再利用、#647はdeveloper / follow-upへのproduction配線を担当する。両Issueが未完了でも本helperからproduction behaviorは変わらない。
