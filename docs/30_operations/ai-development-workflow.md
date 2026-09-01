# AI開発・ClaudeレビューのGitHub運用

## 目的

Codex/OpenAIを開発者、Claudeを独立レビューアーとしてGitHub上で協調させる。Issueを検討と作業の正本、Pull Requestを成果物とレビュー対話の正本にする。

## 通常フロー

1. 人間が実装対象Issueを作成し、対象、受入条件、上流・下流影響を記録する。
2. Issueコメントに `/codex develop` と投稿する。developer App tokenやOpenAI APIを使う前に、Issue自身と対応するopen PRの停止ラベルを事前ゲートで確認する。
3. developer Appが `ai/issue-<Issue番号>` ブランチを作成・更新し、`Closes #<Issue番号>` を含むPRを作成する。
4. `PR Traceability / Linked Issue` が実在するclosing Issueを確認する。
5. ClaudeがPR、信頼済み会話、closing Issue、差分を確認し、reviewer Appとして `APPROVE` または `REQUEST_CHANGES` を投稿する。
6. `REQUEST_CHANGES` の場合はCodexが修正する。3回目のchange request、要求変更マーカー、または人間エスカレーションマーカーで自動修正を停止する。
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

EnvironmentではなくRepositoryスコープに設定する。値をIssue、PR、ログ、文書へ貼り付けない。

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

実際のcheck名がmain上で一度観測できた後、`PR Traceability / Linked Issue` をrequired status checkへ追加する。自動マージ処理自身も同じclosing Issue条件を再検証するため、required check設定前でもこの条件を迂回しない。

## 人間エスカレーション

次のいずれかで `human-review-required` を付け、自動修正と自動マージを停止する。

- CodexまたはClaudeが `[REQUIREMENTS_CHANGE_REQUIRED]` を返した。
- Claudeが `[HUMAN_ESCALATION_RECOMMENDED]` を返した。
- Claudeのchange requestが3回に到達した。

停止時は関連IssueとPRの両方へラベルを同期する。どちらかにラベルが残っている間は、追加の `/codex develop` 指示やClaudeのchange requestが届いてもCodexを再起動しない。ラベル・PR差分・closing Issueの取得に失敗した場合も安全側に停止する。人間が判断を記録し、再開可能と確認してから両方のラベルを外す。

`NOTIFICATION_WEBHOOK_URL` が設定済みならPRまたはIssueへのリンクをDiscordへ送る。通知scriptはDiscord Webhookの `{"content":"..."}` 形式を使用し、Webhook URLをログ、Issue、PRへ出力しない。未設定時はActionsにwarningを残し、GitHub上のラベルとコメントによる停止は継続する。人間が判断をIssueへ記録し、必要な修正を行った後にだけラベルを外して再開する。

Webhook登録、通知確認、main反映後のEnd-to-End確認はIssue #38で追跡する。

## Bootstrapと復旧

`pull_request` workflowはdefault branchにworkflowファイルが存在してから通常運用を開始する。初回導入PRは管理者が内容を確認し、reviewer Appによる一時レビューまたは手動レビューを経てマージする。通常の自動マージは `ai/issue-*` だけに限定されるため、bootstrap用ブランチは自動マージ対象外である。

Actionsが失敗した場合は、失敗step、Appのインストール先・権限、Repository secret/variable名、OIDC federation ruleの対象を確認する。secret値をログへ出さない。

Workflow変更時は次を実行し、認可・信頼境界・closing Issue・merge gateのfixtureを確認する。

```bash
bash .github/scripts/test-ai-workflow.sh
```
