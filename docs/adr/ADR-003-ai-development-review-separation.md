# ADR-003: AI開発と独立レビューをGitHub上で分離する

## 状態

- 状態: 採用
- 日付: 2026-08-31

## 背景

Issue #36で、Codex/OpenAIが開発し、Claudeが独立レビューし、検討・成果・議論をIssueとPull Requestへ残す開発基盤が必要になった。開発者とレビューアーの権限分離、外部AI APIの認証、信頼できないPR内容の扱い、自動修正ループとマージの停止条件を決める必要がある。

## 決定

- developer Appとreviewer Appを別々に作り、developer Appは変更とPR、reviewer Appはレビューと承認後のsquash mergeを担当する。
- OpenAIはRepository secretのAPIキー、AnthropicはGitHub OIDC / Workload Identity Federationで認証する。
- 通常処理は `pull_request` を使い、forkのPRには認証情報を渡さず、same-repository PRだけAIレビューする。base repositoryの権限で未信頼コードを動かす `pull_request_target` は使わない。
- PR本文にはclosing keywordによる実在Issueの関連付けを必須とする。自動マージ時にも同じ条件を再検証する。
- 自動マージはdeveloper Appが作る `ai/issue-<Issue番号>` だけに限定し、番号がclosing Issueと一致することを要求する。人間や任意ブランチのPRは自動マージしない。
- PR本文、差分、Issue本文、会話はデータ境界で囲み、OWNER、MEMBER、COLLABORATORおよび明示したApp bot以外の会話はAIコンテキストから除外する。
- 要求変更・人間判断マーカー、または3回目のchange requestで関連IssueとPRの両方へ `human-review-required` を付け、Codexの自動修正と自動マージを止める。Issue起点ではdeveloper App token発行前にIssueと対応PRの両方を検査し、同期・差分・closing Issue取得に失敗した場合もfail-closedとする。Slack webhookが設定済みなら同時に通知する。
- `.github/**`、階層を問わない `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` / `CLAUDE.local.md` / `CODEOWNERS`、`.claude/**`、`.codex/**`、`.mcp.json` は人間ownerをCode Ownerとし、rulesetでCode Owner reviewを要求する。これらを変更するPRはreviewer Appで自動マージせず、人間ownerが確認してマージする。developer/reviewer AppにはWorkflows writeを付与しない。

## 検討した代替案

### `GITHUB_TOKEN`だけを使う

設定は簡単だが、開発者とレビューアーの主体・権限・監査記録を分離しにくい。承認とマージを独立したreviewer Appの操作として残すため採用しない。

### 1つのGitHub Appを共有する

secret数は減るが、自己承認に近い権限構造になる。開発とレビューの責任分離を優先して採用しない。

### Anthropicの長期APIキーを保存する

導入は単純だが、長期credentialの保管・rotationが必要になる。GitHub ActionsのOIDC tokenを短期交換できるため、Workload Identity Federationを採用する。

### `pull_request_target`でfork PRも処理する

base repositoryのsecretとwrite権限を未信頼PRへ近づける危険がある。fork PRを自動処理しない制約を受け入れ、`pull_request` とsame-repository条件を採用する。

### Claude承認だけで全PRを即時マージする

Issue連携、対象ブランチ、要求変更、人間停止を迂回できる。対象ブランチとclosing Issueを再検証し、停止ラベルを尊重する方式を採用する。

### 上限なしでCodexとClaudeを反復する

平行線の議論が有料APIを無期限に消費し、人間が気づけない。3回のchange requestで停止・通知する方式を採用する。

### same-repository PRのworkflow変更をAI承認だけで許可する

`pull_request` runがPR側のworkflow定義を評価すると、base commitから読み直す指示書やmerge gate自体を削除できる。Workflow変更の完全自動化は採用せず、Code Ownerである人間ownerの承認を必須にする。

## 影響

- GitHub App、Repository secrets/variables、Anthropic federation rule、rulesetの初期設定が必要になる。
- App tokenとOIDC tokenは各runで短期発行され、長期credentialの露出範囲を抑えられる。
- fork PRと人間作成ブランチは自動マージされず、人間の操作が必要になる。
- Slack webhookが未設定でもGitHub上では安全側に停止するが、Slack通知を有効にするにはsecret追加が必要である。
- same-repositoryのwrite権限を持つ人間はPR workflowを変更できるため、CODEOWNERSとruleset設定が継続的な防御境界になる。設定を外す場合は本ADRの再検討が必要である。

## 関連要求・記録

- 判断と導入作業: Issue #36
- Slack・E2E follow-up: Issue #38
- 運用手順: `docs/30_operations/ai-development-workflow.md`
