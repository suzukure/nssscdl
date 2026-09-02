# AI開発・ClaudeレビューのGitHub運用

## 目的

Codex/OpenAIを開発者、Claudeを独立レビューアーとしてGitHub上で協調させる。Issueを検討と作業の正本、Pull Requestを成果物とレビュー対話の正本にする。

## 通常フロー

1. 人間が実装対象Issueを作成し、対象、受入条件、上流・下流影響を記録する。
2. Issueコメントに `/codex develop` と投稿する。developer App tokenやOpenAI APIを使う前に、Issue自身と対応するopen PRの停止ラベルを事前ゲートで確認する。
3. developer Appが `ai/issue-<Issue番号>` ブランチを作成・更新し、`Closes #<Issue番号>` を含むPRを作成する。
4. `PR Traceability / Linked Issue` が実在するclosing Issueを確認する。
5. ClaudeがPR、信頼済み会話、closing Issue、差分を確認し、reviewer Appとして `APPROVE` または `REQUEST_CHANGES` を投稿する。仕様書レビューでは `CLAUDE.md` の重点観点を適用し、Actionの `execution_file` からworkflowの固定JSON schemaで検証したreview結果だけを正本として、`summary` を総評、`blocking_findings` / `non_blocking_findings` を指摘事項と改善案として記録する。結果が入力全体を占める単一の `json` Markdown fenceで包まれている場合だけ外枠を除去し、前後の説明文、複数候補、欠落・不正なschemaは受理せず、verdictを推測せずfail-closedでjobを失敗させる。
6. `REQUEST_CHANGES` の場合は、Codexを起動する前にclosing IssueとPRへ `human-review-required` を付けて自動Claude再レビューを停止し、その状態でCodexが1回だけ修正する。人間が修正結果を確認した後、closing Issue側のラベルを先に、PR側のラベルを最後に外す。PRの `unlabeled` eventを明示的な再レビュー要求として扱い、同じheadをClaudeが1回レビューする。誤ってPR側を先に外した場合は、PRへラベルを再付与してから、closing Issue側、PR側の順に外し直す。3回目のchange request、要求変更マーカー、または人間エスカレーションマーカーではCodex修正自体を停止する。
7. Claudeが承認し、developer App作成PRが `ai/issue-<Issue番号>` ブランチで、ブランチ番号とclosing Issueが一致し、保護対象のAI指示・agent設定・GitHub自動化を変更せず、IssueとPRのどちらにも `human-review-required` ラベルがない場合だけreviewer Appがsquash mergeする。

人間や任意ブランチから作成したPRはClaudeレビューの対象にはできるが、自動マージしない。

## 必要なGitHub Actions設定

Repository secrets:

- `DEV_APP_PRIVATE_KEY`
- `REVIEW_APP_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `NOTIFICATION_WEBHOOK_URL`（人間通知用のDiscord Webhook URL。未設定でもGitHub上の停止・ラベル付与は行う）

Repository variables:

- `DEV_APP_CLIENT_ID`
- `REVIEW_APP_CLIENT_ID`
- `ANTHROPIC_FEDERATION_RULE_ID`
- `ANTHROPIC_ORGANIZATION_ID`
- `ANTHROPIC_SERVICE_ACCOUNT_ID`
- `ANTHROPIC_WORKSPACE_ID`
- `CLAUDE_MODEL`（protected pathsを含む高リスクClaudeレビューで使用するモデルを指定する）
- `CLAUDE_MODEL_STANDARD`（protected pathsを含まない通常Claudeレビューで使用するモデルを指定する）
- `CODEX_MODEL`（Issue開発とClaudeレビュー追従の両方でCodexが使用するモデルを指定する）

EnvironmentではなくRepositoryスコープに設定する。Repository variableの値は既定でIssue、PR、ログ、文書へ貼り付けない。ただし `CLAUDE_MODEL` / `CLAUDE_MODEL_STANDARD` / `CODEX_MODEL` のモデルIDは機微情報ではないため、変更履歴と検証証跡を残す目的でIssueやPRへ記録してよい。

AIモデルを変更する場合はworkflowへモデルIDを直書きせず、`CLAUDE_MODEL`、`CLAUDE_MODEL_STANDARD`、または `CODEX_MODEL` のRepository variableを更新する。これにより通常のモデル切替では `.github/**` のCode Owner保護対象workflowを変更しない。Claude reviewは自動マージゲートと同じprotected-path判定を使い、protected pathsを含む場合は `CLAUDE_MODEL`、それ以外は `CLAUDE_MODEL_STANDARD` を選ぶ。モデルvariableを未設定または空白のみの状態はサポートせず、workflowはモデル実行前のpreflightで実値を確認して該当時は失敗させる。Claude側のpreflightは、自動マージゲートとprotected-path判定を一本化するため、信頼済みbase commit由来の判定scriptを再利用する。Codex側は追加の判定を必要としないためinlineのままとする。

## GitHub Apps

developer Appとreviewer Appを分離し、対象リポジトリだけへインストールする。

| 権限 | developer App | reviewer App |
|---|---:|---:|
| Actions | Read | Read |
| Checks | Read | Read |
| Contents | Read and write | Read and write |
| Issues | Read and write | Read and write |
| Pull requests | Read and write | Read and write |
| Workflows | No access | No access |
| Metadata | Read | Read |

reviewer Appだけが承認後のマージを担当する。developer Appは自分のPRを承認・マージしない。どちらのAppにもWorkflows writeを付与してはならない。

GitHub CLI経由のメタデータではApp actorが `app/<slug>` に正規化される場合があるため、CLI/API由来のidentity検証では設定済みslugに対する `<slug>`、`<slug>[bot]`、`app/<slug>` の3形式だけを同一Appとして扱う。Webhook payloadを直接検証する箇所は、そのpayloadが返す `<slug>` または `<slug>[bot]` を完全一致で検証する。

## Anthropic認証

Anthropicは長期APIキーではなくGitHub OIDC / Workload Identity Federationを使う。Federation ruleはこのリポジトリの不変なowner/repository IDをsubject prefixに含め、他リポジトリからのtoken exchangeを許可しない。

## Claude API消費制御

Claude reviewは1実行につき `--max-budget-usd 1.50` を設定し、上限到達、API失敗、出力不正をapproveへ変換せずfail-closedとする。`--max-turns` は費用上限として扱わず、異常ループ検知へ別途必要になった場合だけ実測turn数以上の値を検討する。

利用量記録はverdict経路を阻害しない非致命stepとする。Action outcome、result subtype、schema検証結果、turns、duration、estimated cost、input/output token、cache creation/read tokenをJob Summaryへ記録し、prompt本文、review本文、secret値は記録しない。`modelUsage` はClaude Code session全体のモデル別累積値として合算する。利用量が欠落・不正でもreview結果の厳密検証とverdict投稿は継続する。

Claude Codeの標準5分prompt cacheを使用し、まず3実行分のcache creation/read tokenを記録して効果を評価する。1時間cacheはwrite単価が高く、自動再レビューを停止した運用では再利用機会が限定されるため、反復利用の実測根拠が得られるまで有効化しない。

Message Batches APIは非同期処理であり、即時のreview verdictを必要とする同期PR gateへ導入しない。夜間処理など遅延を許容でき、複数の独立したreviewをまとめられる用途が生じた場合は別Issueで再検討する。

## Ruleset

default branchに次を適用する。

- Pull Request必須
- 承認1件以上
- Code Owner review必須（`.github/**`、任意階層の `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` / `CLAUDE.local.md` / `CODEOWNERS`、`.claude/**`、`.codex/**`、`.mcp.json` は人間ownerのみ）
- 古い承認を新しいpushで破棄
- 最新pushへの承認必須
- 会話スレッド解決必須
- squash mergeのみ
- linear history必須
- branch deletionとforce pushを禁止
- bypass actorなし

`pull_request` runはsame-repository PR側のworkflow定義を評価し得るため、`.github/CODEOWNERS` とCode Owner reviewを防御境界とする。AI AppはCode Ownerに指定せず、Workflow・AI指示書・agent設定の変更には人間ownerの承認と手動マージを必須にする。自動マージゲートも対象パスを検出して失敗する。

`PR Traceability / Linked Issue` のcheck名はmain上で観測済みで、default branch rulesetのrequired status check `Linked Issue` として有効化済みである。自動マージ処理自身も同じclosing Issue条件を再検証するため、このrequired checkに加えてmerge gateでも条件を迂回しない。

## 人間エスカレーション

次のいずれかで `human-review-required` を付け、自動修正と自動マージを停止する。

- CodexまたはClaudeが `[REQUIREMENTS_CHANGE_REQUIRED]` を返した。
- Claudeが `[HUMAN_ESCALATION_RECOMMENDED]` を返した。
- Claudeのchange requestが3回に到達した。

停止時は関連IssueとPRの両方へラベルを同期する。どちらかにラベルが残っている間は、追加の `/codex develop` 指示やClaudeのchange requestが届いてもCodexを再起動しない。許可済みのClaude change request follow-upでは、follow-up gate通過後にラベルを付けてからCodexを1回実行するため、その実行だけは継続するが、修正pushによる `synchronize` reviewは起動しない。ラベル・PR差分・closing Issueの取得に失敗した場合も安全側に停止する。人間が判断を記録し、再開可能と確認した後、closing Issue側を先に、PR側を最後に外す。誤ってPR側を先に外した場合は、PRへラベルを再付与してから、closing Issue側、PR側の順に外し直す。PR側の `human-review-required` が外れたeventだけが明示的なClaude再レビュー要求となる。停止中に誤った順序で起動したcheckは、Job Summaryの「Claude review not run」で未実施理由を確認する。

`NOTIFICATION_WEBHOOK_URL` が設定済みならPRまたはIssueへのリンクをDiscordへ送る。通知scriptはDiscord Webhookの `{"content":"..."}` 形式を使用し、Webhook URLをログ、Issue、PRへ出力しない。未設定時はActionsにwarningを残し、GitHub上のラベルとコメントによる停止は継続する。人間が判断をIssueへ記録し、必要な修正を行った後にだけラベルを外して再開する。

Webhook登録、通知確認、main反映後のEnd-to-End確認はIssue #46で追跡する。

## Bootstrapと復旧

`pull_request` workflowはdefault branchにworkflowファイルが存在してから通常運用を開始する。初回導入PRは管理者が内容を確認し、reviewer Appによる一時レビューまたは手動レビューを経てマージする。通常の自動マージは `ai/issue-*` だけに限定されるため、bootstrap用ブランチは自動マージ対象外である。

Actionsが失敗した場合は、失敗step、Appのインストール先・権限、Repository secret/variable名、OIDC federation ruleの対象を確認する。モデルpreflightまたはモデル実行stepで失敗した場合は `CLAUDE_MODEL` / `CLAUDE_MODEL_STANDARD` / `CODEX_MODEL` の設定有無と、指定モデルが現在のAnthropic workspaceまたはOpenAI API projectで利用可能かを確認する。secret値とRepository variable値はログへ出さない。モデルIDについては前述のとおりIssue/PRの変更履歴・検証証跡へ記録してよいが、ログへは出さない。

`.github/scripts/**` を変更した場合、または認可・信頼境界・closing Issue・merge gateのロジックを変更した場合は次を実行し、fixtureを確認する。

```bash
bash .github/scripts/test-ai-workflow.sh
```

`.github/workflows/**` を変更したが上記fixtureの対象外と判断した場合は、その理由をPR本文へ記録する。
