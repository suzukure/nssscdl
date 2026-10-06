# Configuration

Non-secret project configuration belongs here. Secrets and credentials must not be committed.

## 本体開発の技術契約（#638）

2026-10-01のIssue #638で確定した選定を本体開発の標準とする。

| 用途 | 標準 |
| --- | --- |
| Application language | TypeScript |
| Production runtime / deploy unit | Cloudflare Workers / ES modules、単一Application Worker |
| Build / test tooling host | Node.js 24 LTS（rootの `.node-version`） |
| Package manager / lockfile | npm / `package-lock.json` |
| Worker bundle / local D1 CLI | Wrangler |
| Unit / Worker-runtime test | Vitest / `@cloudflare/vitest-plugin` |
| Worker HTTP integration test | Cloudflareの現行integration harness、Production Worker buildを経由 |

Node.jsをApplication Runtimeとして扱わない。旧 `@cloudflare/vitest-pool-workers` は新規採用しない。
Packageのexact versionはrootの [`package.json`](../package.json) を正本とする。
2026-10-06のIssue #638再開契約に従い、初期devDependenciesを次で固定する。

| Package | Candidate version |
| --- | --- |
| `@cloudflare/vitest-plugin` | `1.3.6` |
| `vitest` | `4.1.11` |
| `wrangler` | `4.146.0` |
| `typescript` | `6.0.3` |
| `eslint` | `10.10.0` |
| `typescript-eslint` | `8.71.0` |

選定根拠は同再開契約の公開package / upstream照合記録とする。
Plugin 1.3.6のVitest関連peer rangeは `^4.1.0`、typescript-eslintのTypeScript support rangeは
`>=4.8.4 <6.1.0` で、ESLint 10もsupport range内の候補である。
この段階では実際の依存取得・互換性検証・現行test API確認は未実施であり、lockfileでの固定は後段で行う。

## Bootstrapの実装状況

`src/index.ts` はES modules形式の最小entrypointで、すべてのRequestにHTTP 503を返す。
Product API、業務Command、Scheduled Handler、外部Provider呼出し、DB bindingは未実装である。
このentrypointはProduct APIのError contractや提供済み機能を定義せず、Productionへdeployしない。

依存packageを取得できない制限環境ではlockfileやCloudflareのAPIを推測して作らない。
現時点ではroot `package.json` のcandidate manifestまで作成済みである。
`private: true` とES modules形式、Node 24のtooling host条件を宣言し、依存はdevDependenciesに限定する。
`package-lock.json`、TypeScript / Wrangler / lint / Vitest設定、local D1 harness、smoke testsは未実装である。
下記コマンド名は既存契約を維持するが、npm scriptsは設定・harness実装後に定義する。
本IssueのDone条件は未達で、後続CIが利用する前に残りのbootstrapとローカル検証を完了する必要がある。

今回の停止点はcandidate manifest成立までとし、lockfileは手編集・推測生成しない。
Workflowがcommit / pushしたexact 40-hex candidate SHAを#795へ渡し、
[trusted-main npm bootstrapの既存手順](../.github/README.md#trusted-main-npm-bootstrap-792)で
validated artifactを生成・照合してから、通常PR差分としてlockfileを取り込む。
Artifact受領前に依存付きtestやD1 harnessを完成扱いしない。

## 標準コマンドの実装契約

本体のローカル実行と後続PR CI（#639）、AI Developer runtime適合（#538）は、
次の同一コマンドを使う構成とする。CI専用の別実装は作らない。

| 用途 | 実装するコマンド | 条件 |
| --- | --- | --- |
| Clean / reproducible install | `npm ci` | npmが生成したpackage / lockfile整合を検証 |
| Worker build | `npm run build` | Bundleを検証し、deployしない |
| Typecheck | `npm run typecheck` | ApplicationはWorkers、toolingはNodeとして型検証 |
| Lint | `npm run lint` | 必要最小限のlint設定 |
| Unit / Worker-runtime test | `npm run test:unit` | Worker unit smokeを含む |
| HTTP integration test | `npm run test:integration` | Production buildのHTTP境界を検証 |
| Local D1 migration / setup | `npm run d1:local` | Wranglerの `--local` 経路のみ |
| Local D1 smoke | `npm run test:d1` | Binding、migration適用、初期化・隔離を検証 |
| 全テスト | `npm test` | Unit / integration / D1 smokeをすべて実行 |

Local D1は各test / runで決定的に初期化し、Production DBへ接続しない。
Harness検証用migrationは `tests/` 内のfixture専用とし、Production正本の `migrations/` に置かない。
#636の認証schemaや#611の予約Production migrationを推測して実装しない。
将来#608のServer Clock、Provider Stub、Concurrency Barrierを注入する業務境界は、
既存の詳細設計を正とし、本bootstrapで業務fixtureや新しい業務契約を確定しない。

`npm ci`、全標準コマンド、package / lockfile整合、`git diff --check` の結果を記録する。
未実施は成功と扱わず、Codexのローカル自己申告とformal current-head CI証跡を区別する。
本選定は既存POL / BR / REQ / AC / TC / CON / OOS、基本設計および#609〜#611の製品契約を変更しない。
