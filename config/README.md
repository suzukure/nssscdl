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
| Worker HTTP integration test | `cloudflare:workers` の `exports.default.fetch()` によるWorkers runtimeのHTTP境界 |

Node.jsをApplication Runtimeとして扱わない。旧 `@cloudflare/vitest-pool-workers` は新規採用しない。
Packageのexact versionはrootの [`package.json`](../package.json) を正本とする。
2026-10-06のIssue #638再開契約に従い、初期devDependenciesを次で固定する。

| Package | Exact version |
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
現行test APIは2026-10-06のIssue本文 `Phase B final implementation authority` と
`Phase C final implementation authority` の公式資料照合を根拠とする。
依存graphは#795のvalidated artifactから採用したroot `package-lock.json` で固定する。
LockfileのSHA-256は `63bf449c44e83296d705eb20add21e3ac5b0228a698e75f94a69c2f9c381a703`。
Phase B / Cではdependency/versionとlockfileのbytesを変更しない。

## Bootstrapの実装状況

`src/index.ts` はES modules形式の最小entrypointで、すべてのRequestにHTTP 503を返す。
Product API、業務Command、Scheduled Handler、外部Provider呼出し、DB bindingは未実装である。
このentrypointはProduct APIのError contractや提供済み機能を定義せず、Productionへdeployしない。

Phase Bではroot `package.json` とvalidated `package-lock.json`、下記設定、Worker smoke testsを実装済みである。
`private: true` とES modules形式、Node 24のtooling host条件を宣言し、依存はdevDependenciesに限定する。

| 設定 | Phase Bの責務 |
| --- | --- |
| [`tsconfig.json`](../tsconfig.json) | `src/**/*.ts` のstrict / noEmit、ES modules / bundler resolution、標準Web型。Tests / toolingのtypecheckは含まない |
| [`wrangler.jsonc`](../wrangler.jsonc) | `src/index.ts`、compatibility date `2026-10-06`。Binding / route / account / remote resourceを定義しない |
| [`vitest.config.ts`](../vitest.config.ts) | `cloudflareTest()` と `defineConfig()`、同じWrangler設定でunit / integrationを実行 |
| [`eslint.config.mjs`](../eslint.config.mjs) | Direct dependency `typescript-eslint` のflat recommended config |

Build outputの `dist/` は既存ignore対象で、commitしない。
Phase Cとしてtest-only Local D1 harness / fixture migrationと最終test aggregateも実装済み。
設定・test sourceは上記Issue authorityに従って実装し、AI内で依存を取得できなくても推測したlockfileやAPIへ置き換えない。
依存付き実行のformal proofは後続#639のcurrent-head Product CIで行う。
#638全体のDone（D1 smokeを含む依存付き実行）はまだ未実証である。

## 標準コマンドの実装契約

本体のローカル実行と後続PR CI（#639）、AI Developer runtime適合（#538）は、
次の同一コマンドを使う構成とする。CI専用の別実装は作らない。

| 用途 | 標準コマンド | Phase / 条件 |
| --- | --- | --- |
| Clean / reproducible install | `npm ci` | Phase B。Validated package / lockfileを使用 |
| Worker build | `npm run build` | Phase B。`wrangler deploy --dry-run --outdir dist`、deployなし |
| Typecheck | `npm run typecheck` | Phase B。`tsc --noEmit`、Application sourceのみ |
| Lint | `npm run lint` | `src/`、unit / integration / D1 testsとsetup、両Vitest設定のTSをESLintで検証 |
| Unit / Worker-runtime test | `npm run test:unit` | Phase B。`vitest run tests/unit`、Worker moduleのhandlerを直接呼ぶ |
| HTTP integration test | `npm run test:integration` | Phase B。`vitest run tests/integration`、上記current pluginのHTTP境界を検証 |
| Local D1 migration / setup | `npm run d1:local` | Phase C。Test-only Wrangler設定、`--local`、`--persist-to .wrangler/d1-bootstrap-test` |
| Local D1 smoke | `npm run test:d1` | Phase C。`vitest run --config vitest.d1.config.ts`、binding / migration / 隔離を検証 |
| 全テスト | `npm test` | Phase C。Unit → integration → D1 smokeの順で実行し、失敗時に停止 |

Phase CのLocal D1は各test / runで決定的に初期化し、Production DBへ接続しない。
Harness検証用migrationは `tests/` 内のfixture専用とし、Production正本の `migrations/` に置かない。
Test-only設定は [`tests/fixtures/d1/wrangler.jsonc`](../tests/fixtures/d1/wrangler.jsonc) とし、
既存entrypoint / compatibility dateを使う。`TEST_DB` は `nssscdl-bootstrap-test` と固定dummy UUIDに限る。
Production `wrangler.jsonc` にbindingを追加しない。
[`0001_bootstrap.sql`](../tests/fixtures/d1/migrations/0001_bootstrap.sql) は
`bootstrap_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)` だけを定義し、seedを持たない。
[`vitest.d1.config.ts`](../vitest.d1.config.ts) は `readD1Migrations()` でfixtureを読み、
test-only `TEST_MIGRATIONS` bindingへ渡す。`tests/d1/setup.ts` が `applyD1Migrations()` を適用する。
Pluginのper-test-file storage isolationを使用し、各ファイルが空のtableへ同じ主キーを書いて
異なるfixture valueを読めることを確認する。Persistent CLI stateをtestの証拠には使わない。
Wrangler CLI stateはgitignore対象の `.wrangler/d1-bootstrap-test` に限る。
`d1:local` は適用済みmigrationを再適用しないlocal setupであり、Vitestのisolated storageとは独立する。
CLI stateから作り直す場合は、このtest-only directoryだけを削除して `npm run d1:local` を再実行する。
#636の認証schemaや#611の予約Production migrationを推測して実装しない。
将来#608のServer Clock、Provider Stub、Concurrency Barrierを注入する業務境界は、
既存の詳細設計を正とし、本bootstrapで業務fixtureや新しい業務契約を確定しない。

`npm ci`、全標準コマンド、package / lockfile整合、`git diff --check` の結果を記録する。
外部接続できないAI内ではoffline installの結果を記録し、依存取得不能時のcommandは未実施とする。
未実施は成功と扱わず、Codexのローカル自己申告とformal current-head CI証跡を区別する。
本選定は既存POL / BR / REQ / AC / TC / CON / OOS、基本設計および#609〜#611の製品契約を変更しない。
