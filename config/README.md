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
Packageのexact version、互換性、現行test APIは実際の依存取得時に確認し、npmが生成したlockfileで固定する。

## Bootstrapの実装状況

`src/index.ts` はES modules形式の最小entrypointで、すべてのRequestにHTTP 503を返す。
Product API、業務Command、Scheduled Handler、外部Provider呼出し、DB bindingは未実装である。
このentrypointはProduct APIのError contractや提供済み機能を定義せず、Productionへdeployしない。

依存packageを取得できない制限環境ではlockfileやCloudflareのAPIを推測して作らない。
現時点では `package.json` / `package-lock.json`、TypeScript / Wrangler / lint / Vitest設定、
local D1 harness、smoke testsは未実装であり、下記コマンドはまだ実行可能なnpm scriptではない。
本IssueのDone条件は未達で、後続CIが利用する前に残りのbootstrapとローカル検証を完了する必要がある。

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
