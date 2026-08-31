# AI開発・ClaudeレビューのGitHub運用

## 目的

Codex/OpenAIを開発者、Claudeを独立レビューアーとしてGitHub上で協調させる。Issueを検討と作業の正本、Pull Requestを成果物とレビュー対話の正本にする。

## 通常フロー

1. 人間が実装対象Issueを作成し、対象、受入条件、上流・下流影響を記録する。
2. Issueコメントに `/codex develop` と投稿する。
3. developer Appが `ai/issue-<Issue番号>` ブランチを作成・更新し、`Closes #<Issue番号>` を含むPRを作成する。
4. `PR Traceability / Linked Issue` が実在するclosing Issueを確認する。
5. ClaudeがPR、信頼済み会話、closing Issue、差分を確認し、reviewer Appとして `APPROVE` または `REQUEST_CHANGES` を投稿する。
6. `REQUEST_CHANGES` の場合はCodexが修正する。3回目のchange request、要求変更マーカー、または人間エスカレーションマーカーで自動修正を停止する。
7. Claudeが承認し、PRが `ai/issue-<Issue番号>` ブランチで、ブランチ番号とclosing Issueが一致し、`human-review-required` ラベルがない場合だけreviewer Appがsquash mergeする。

人間や任意ブランチから作成したPRはClaudeレビューの対象にはできるが、自動マージしない。

## 必要なGitHub Actions設定

Repository secrets:

- `DEV_APP_PRIVATE_KEY`
- `REVIEW_APP_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `SLACK_WEBHOOK_URL`（人間通知をSlackへ送る場合。未設定でもGitHub上の停止・ラベル付与は行う）

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
| Metadata | Read | Read |

reviewer Appだけが承認後のマージを担当する。developer Appは自分のPRを承認・マージしない。

## Anthropic認証

Anthropicは長期APIキーではなくGitHub OIDC / Workload Identity Federationを使う。Federation ruleはこのリポジトリの不変なowner/repository IDをsubject prefixに含め、他リポジトリからのtoken exchangeを許可しない。

## Ruleset

default branchに次を適用する。

- Pull Request必須
- 承認1件以上
- 古い承認を新しいpushで破棄
- 最新pushへの承認必須
- 会話スレッド解決必須
- squash mergeのみ
- linear history必須
- branch deletionとforce pushを禁止
- bypass actorなし

実際のcheck名がmain上で一度観測できた後、`PR Traceability / Linked Issue` をrequired status checkへ追加する。自動マージ処理自身も同じclosing Issue条件を再検証するため、required check設定前でもこの条件を迂回しない。

## 人間エスカレーション

次のいずれかで `human-review-required` を付け、自動修正と自動マージを停止する。

- CodexまたはClaudeが `[REQUIREMENTS_CHANGE_REQUIRED]` を返した。
- Claudeが `[HUMAN_ESCALATION_RECOMMENDED]` を返した。
- Claudeのchange requestが3回に到達した。

`SLACK_WEBHOOK_URL` が設定済みならPRまたはIssueへのリンクをSlackへ送る。未設定時はActionsにwarningを残し、GitHub上のラベルとコメントによる停止は継続する。人間が判断をIssueへ記録し、必要な修正を行った後にだけラベルを外して再開する。

## Bootstrapと復旧

`pull_request` workflowはdefault branchにworkflowファイルが存在してから通常運用を開始する。初回導入PRは管理者が内容を確認し、reviewer Appによる一時レビューまたは手動レビューを経てマージする。通常の自動マージは `ai/issue-*` だけに限定されるため、bootstrap用ブランチは自動マージ対象外である。

Actionsが失敗した場合は、失敗step、Appのインストール先・権限、Repository secret/variable名、OIDC federation ruleの対象を確認する。secret値をログへ出さない。
