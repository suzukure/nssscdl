# AI開発・ClaudeレビューのGitHub運用

## 目的

Codex/OpenAIを開発者、Claudeを独立レビューアーとしてGitHub上で協調させる。Issueを検討と作業の正本、Pull Requestを成果物とレビュー対話の正本にする。

## 通常フロー

1. 人間が実装対象Issueを作成し、対象、受入条件、上流・下流影響を記録する。
2. Open Issueに `/codex develop` だけを単独コメントとして投稿する。前後の説明文、引用、Markdown code block、字下げ、前後空白を付けたコメントは実行要求として扱わず、Closed Issueへのコメントでも起動しない。入口条件はGitHub Actions式の `github.event.comment.body == '/codex develop'` であり、GitHub公式仕様どおり文字列の等値比較は大文字小文字を区別しないため、運用上の正規形は小文字の `/codex develop` とする。形式やIssue stateが一致しない場合は入口job自体が起動せず自動ガイダンスも返らないため、反応がない場合はIssueがOpenか、コメントがコマンド単独になっているかを確認する。developer App tokenやOpenAI APIを使う前に、Issue自身と対応するopen PRの停止ラベルを事前ゲートで確認する。
3. developer Appが `ai/issue-<Issue番号>` ブランチを作成・更新し、`Closes #<Issue番号>` を含むDraft PRを作成する。同じIssueの追加修正は既存PRへ集約し、自動Ready化しない。人間が下記の準備確認を終えてReady for reviewへ変更すると、Claude reviewが起動する。
4. `PR Traceability / Linked Issue` が実在するclosing Issueを確認する。
5. ClaudeがPR、信頼済み会話、closing Issue、明示された後継Issueのsnapshot、差分を確認し、reviewer Appとして `APPROVE` または `REQUEST_CHANGES` を投稿する。仕様書レビューでは `CLAUDE.md` の重点観点を適用する。Actionへ現行5-key JSON Schemaを渡し、`structured_output` をreview内容の第一入力として、current base由来の `validate-claude-review-output.sh` を通過した結果だけを投稿する。`summary` を総評、`blocking_findings` / `non_blocking_findings` を指摘事項と改善案として記録する。native出力は厳密に1個のJSON値として読み、欠落・不正JSON・schema不一致は非機密な固定reason codeでfail-closed停止する。自由テキスト `result` やMarkdown fenceへfallbackせず、verdictを推測しない。
6. `REQUEST_CHANGES` の場合は、Codexを起動する前にclosing IssueとPRへ `human-review-required` を付けて自動Claude再レビューを停止し、その状態でCodexが1回だけ修正する。人間が修正結果を確認した後、closing Issue側のラベルを先に、PR側のラベルを最後に外す。PRの `unlabeled` eventを明示的な再レビュー要求として扱い、同じheadをClaudeが1回レビューする。誤ってPR側を先に外した場合は、PRへラベルを再付与してから、closing Issue側、PR側の順に外し直す。3回目のchange request、要求変更マーカー、または人間エスカレーションマーカーではCodex修正自体を停止する。
7. Claudeが承認し、developer App作成PRが `ai/issue-<Issue番号>` ブランチで、ブランチ番号とclosing Issueが一致し、保護対象のAI指示・agent設定・GitHub自動化を変更せず、IssueとPRのどちらにも `human-review-required` ラベルがない場合だけreviewer Appがsquash mergeする。

人間や任意ブランチから作成したPRはClaudeレビューの対象にはできるが、自動マージしない。

## 関連修正の集約とレビュー準備

Issue #125で、細かな関連修正ごとのClaude呼び出しを減らすため、新規のIssue起点PRをDraftで作成する方式を採用した。レビュー単位は行数やファイル数ではなく「1つの確定判断と、その整合性を保つための関連修正」とする。

Issueを確定する際は、対象ファイル・節・IDに加え、同じ判断に伴う参照、用語、追跡表、図、検証範囲を洗い出して本文へ記録する。無関係な変更や未決判断は混ぜず、巨大な変更になる場合は各PRが安全・整合的に成立する単位へ分ける。既存の別Issueを無断で取り込まず、範囲を広げる場合は人間の決定を先にIssue本文へ反映する。

Draft中はClaude Reviewのjob条件がレビューを抑止する。Draftをpushで更新しても自動Ready化はしない。必要な追加開発だけを同じIssueへ依頼し、変更が揃うまで同じPRへ集約する。生成PR本文と通常PRテンプレートの`Review readiness`欄は人間の確認記録であり、チェックボックス自体を機械的な認可・検証ゲートとは扱わない。

人間は次を確認してからPR画面の **Ready for review** を実行する。

- 同じ判断に伴う関連修正がIssueの許可範囲内で揃っている。
- 影響するPOL / BR / REQ / AC / TC / CON / OOS、関連文書・図との整合を確認している。
- 現在headに対する必要な検証結果がPR本文または最新の開発結果コメントにあり、失敗や未実施を隠していない。古いheadのチェック欄を完了証跡として使わない。
- 未解決のBlockingや上流判断がなく、延期する影響はclosing Issue本文に既存の後継Issue契約どおり記録されている。
- PRとclosing Issueが停止中でなく、追加開発やpushが進行中でない。

`ready_for_review`後は既存のClaudeレビュー・停止・マージ条件を適用する。Draftはマージできず、Ready化は承認やマージを意味しない。新規PR作成の`--draft`は[GitHub CLI仕様](https://cli.github.com/manual/gh_pr_create)、DraftとReadyの扱いは[GitHub公式説明](https://docs.github.com/en/pull-requests/reference/pull-requests#draft-pull-requests)を参照する。

既存の非Draft PRはこの変更で自動Draft化しない。通常の追加作業をレビュー前にまとめ直す場合、人間が追加pushより前にDraftへ戻し、既に進行中のClaude runがあれば別途確認・停止する。Draftへ戻す操作だけで開始済みのAPI呼び出しを取り消せるとは扱わない。非Draftのままpushすると従来どおり`synchronize`でレビュー対象となる。

`human-review-required`は要求・レビュー判断の停止であり、Draftによる作業準備とは別である。停止ラベルをDraft化で代替せず、追加開発や再レビューのために無断解除しない。停止中の非Draft PRは従来どおり人間の確認後にclosing Issue、PRの順でラベルを外す。停止中のDraft PRは、準備・再開判断後に同じ順でラベルを外し、最後にReady化する。Draft中のラベル解除ではClaudeは起動しないため、Ready化がその後のレビュー要求になる。

### 承認後の非Blocking改善

承認後の非Blocking改善は、先行マージが安全性・正確性・要求整合性を損なわないことを人間が確認した場合だけ、次の関連保守Issueへまとめてよい。closing Issue本文へ残る影響、先行マージ可能な理由、後継Issue、範囲・完了条件・時期または順序を記録し、PR本文へ要約とリンクを反映する。詳細は「スコープ外影響と後継Issue」を正本とする。非Blockingという分類だけで延期せず、要求や判断を実質的に変更した場合は古い承認を流用せず再レビューする。不要な微修正pushで承認済みheadを変更しない。

## ChatGPT Workのコンテキスト・コスト管理

ChatGPT WorkをGitHub作業の対話窓口として使う場合は、Issue単位でチャットを分け、Actionsログを失敗stepから段階的に取得し、作業内容に応じてモデルを選択する。同一head SHA・run IDのPR本文、review、Actions Job Summaryを再利用し、状態が変わっていない証跡を繰り返し調査しない。

Project Sources、Project instructions、チャット分割条件、モデル選択基準、開始テンプレート、完了時handoffの正本は [`chatgpt-work-context-cost-operation.md`](chatgpt-work-context-cost-operation.md) とする。確定事項の正本は引き続きGitHubのIssue本文、PR本文、review、リポジトリであり、チャットやhandoffだけに決定を残さない。

## スコープ外影響と後継Issue

Codexはスコープ外影響を発見した場合、その安全性・正確性・要求整合性への影響を調査して報告する。Claudeは、対応を後継Issueへ分離する妥当性と、その後継Issueを確認する。後継Issueの存在だけでblockingを解除してはならない。

後継対応へ分離できるのは、元PRを先にマージしても安全性・正確性・要求整合性を損なわない場合に限る。確定した決定はclosing Issue本文を正本とし、残るスコープ外影響、今回のPRを先にマージできる理由、後継Issue番号、後継Issueの変更範囲・完了条件、および対応時期または順序を記録する。PR本文にはその要約と元Issue・後継Issueへのリンクを記載する。Issueコメントで決定した内容も、確定後はclosing Issue本文へ反映する。

IssueとPRでは `## Scope-out impact and follow-up` 見出しを使用する。各same-repository後継Issueは `- Follow-up Issue: #<number>` の1行で明示し、対象がなければ `none` とする。review context生成はPR本文とclosing Issue本文のこの定型欄だけを読み、closing Issueと重複しない後継Issueを再帰せずに取得する。PRとclosing Issueから抽出した異なる後継Issueの合計に適用する上限値の正本は `build-review-context.sh` の `follow_up_issue_limit` であり、現在は5件である。6件以上が抽出された場合は切り捨てずreview context生成をfail-closedで停止する。後継Issueを整理・分割するか、人間レビューへ切り替えて復旧する。後継Issueの番号・タイトル・state・本文はuntrusted data境界内のsnapshotとしてClaudeへ渡す。定型欄外の通常の番号参照は後継Issueとして扱わない。明示された後継Issueを取得できない場合も、存在しないと推測せずreview context生成をfail-closedで停止する。

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

AIモデルを変更する場合はworkflowへモデルIDを直書きせず、`CLAUDE_MODEL`、`CLAUDE_MODEL_STANDARD`、または `CODEX_MODEL` のRepository variableを更新する。これにより通常のモデル切替では `.github/**` のCode Owner保護対象workflowを変更しない。Claude reviewは自動マージゲートと同じprotected-path判定を使い、protected pathsを含む場合は `CLAUDE_MODEL`、それ以外は `CLAUDE_MODEL_STANDARD` を選ぶ。モデルvariableを未設定または空白のみの状態はサポートせず、workflowはモデル実行前のpreflightで実値を確認して該当時は失敗させる。Claude側のpreflightは、PR headをcheckoutした作業ツリーを信頼せず、通常は信頼済みcurrent base commit由来の`classify-claude-review-risk.sh`を個別に`$RUNNER_TEMP`へ取得して実行する。base commitにこのscriptがない、scriptを初めて導入するPRだけは、workflow内の固定コピーへfallbackする。このfallbackはbootstrap専用であり、PR head由来のscriptは実行しない。workflow内固定コピーと正本scriptの一致は`test-claude-review-workflow.sh`の`RISK_CLASSIFIER` fixtureで維持・検証する。これに対しmerge gateは、同じ信頼済みbase commitをcheckoutした作業ツリーから`verify-pr-gates.sh`を実行し、その兄弟scriptとして`classify-claude-review-risk.sh`を解決する。この作業ツリー依存を保つため、merge gateでclassifierの単体取得方式を使ってはならない。Codex側は追加の判定を必要としないためinlineのままとする。

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

Claude reviewのrun単位budgetはrisk classごとに設定する。protected pathsを含まないstandard review（`CLAUDE_MODEL_STANDARD`）は `--max-budget-usd 1.70`、protected pathsを含むhigh-risk review（`CLAUDE_MODEL`）は `--max-budget-usd 2.10` とする。上限到達、API失敗、出力不正をapproveへ変換せずfail-closedとし、自動retryしない。`--max-turns` は費用上限として扱わず、異常ループ検知へ別途必要になった場合だけ実測turn数以上の値を検討する。

利用量記録stepはverdict経路を阻害しない非致命stepとする。通常step logには、集計済みusage JSONを1行だけ出力し、Actions Job logs APIから回収可能にする。このJSONの項目はresult subtype、is error、turns、duration、estimated cost、input/output token、cache creation/read tokenだけである。Job Summaryにはそれらの利用量を表形式で記録し、workflowが付加するRisk class、Action outcome、Schema validも含める。Risk class、Action outcome、Schema validはusage JSONには含めない。prompt本文、review本文、raw execution file、secret値はどちらにも記録しない。execution file未設定、ファイル不在、または集計失敗時はusage JSONをstep logへ出力せず、Job Summaryへ`Execution usage was unavailable.`を記録する。集計失敗時だけはraw execution由来のstderrを通常logへ出さず、固定文言`Claude usage summarization failed.`を1行だけstderrへ出力する。

`modelUsage` が1件以上ある場合、token fieldはClaude Code session全体のモデル別累積値として、対象fieldが全modelで数値の場合だけ合算する。1modelでも欠落・非数値ならそのfieldは`null`とし、query call内の累積値であるtop-level `usage`へfield単位でfallbackしない。`modelUsage`が空または利用不能の場合だけ、token fieldをtop-level `usage`から取得する。`estimated_cost_usd`はquery全体のSDK見積りである数値の`total_cost_usd`を優先し、利用不能な場合のみ、全modelで数値の`modelUsage.costUSD`を合算する。一部でも欠落・非数値なら`null`とする。`modelUsage`とtop-level `usage`は集計範囲が異なり得る。

利用量が欠落・不正でも、review結果の厳密検証とverdict投稿は継続する。

Claude Codeの標準5分prompt cacheを使用し、Issue #61の高リスク2実行分と、後継Issue #63で追跡する実際の通常PR 1実行分のcache creation/read tokenを合わせて評価する。1時間cacheはwrite単価が高く、自動再レビューを停止した運用では再利用機会が限定されるため、反復利用の実測根拠が得られるまで有効化しない。

Message Batches APIは非同期処理であり、即時のreview verdictを必要とする同期PR gateへ導入しない。夜間処理など遅延を許容でき、複数の独立したreviewをまとめられる用途が生じた場合は別Issueで再検討する。

### Claude review失敗の分類と再実行

`execution_file` は実行成否・budget/spend/rate limit分類・usage計測に維持し、review内容はActionの `structured_output` を使用する。既存classifierの自由テキスト検証結果だけではnative出力を承認・棄却しない。Action successかつ最後のresultがsuccess/is_error=falseの場合だけnative検証へ進み、Action失敗や実行情報不正はvalidなnative出力があっても承認しない。native出力をenvへ渡す前に、固定版Actionと同じJSON直列化でexecution fileのnativeフィールドをマスクする。追加recovery pass・全reviewの自動retryは行わない。

生成用Schemaは `claude-review.yml` の `review-json-schema` データ行をcurrent baseから取得する。導入前base `9bf6ffcf5caa1dc8f98629851f0557653de542f7` にデータ行がない場合だけ固定生成制約をbootstrapし、既存base validatorを必須とする。他のbaseでの欠落、取得失敗、破損は停止する。workflow自体の改変は既存のCode Owner境界で保護し、PR側workflowが検証処理を削除した場合まで実行時に阻止する保証は追加しない。

Claude reviewの実行結果は、`Validate Claude review` stepがJob Summaryへ記録する `Reason code` を一次情報とする。`Record Claude review usage` の集計済みusage JSONと表は費用・利用量の補助証跡であり、失敗原因またはverdictを決めない。reason codeは信頼済みbase commit由来classifierによる実行分類と、workflowによるnative入力検査・base validatorの検証結果から決めるローカルな分類であり、Claude Providerの障害理由・復旧時刻・quotaを保証するものではない。raw execution fileとraw model/API output（promptおよびraw model出力中のreview本文を含む）は取得・転載・再集計しない。

Action successかつ最後のresultがsuccess/is_error=falseの場合、自由テキストresultの複数性は最終reasonを決めない。native出力がなければ `REVIEW_RESULT_MISSING`、あればnative検証結果を優先する。`REVIEW_RESULT_AMBIGUOUS` は下表の限定条件に残す。

例外として `Mask native review output` step自体が失敗すると、`Validate Claude review` はskipされ、Job Summaryのreasonは記録されない。この場合は `Save structured review` の固定エラー `CLASSIFIER_INTERNAL_ERROR` とmask stepの成否を診断の起点とし、raw出力を転載せずマスク処理を調査する。保存・verdict投稿はfail-closedで停止する。mask stepが成功してもreadyを出さない場合は通常の分類経路を継続し、native入力を空として扱う。

| Reason code | 判定 | 人間の復旧手順 |
|---|---|---|
| `REVIEW_VALID` | 構造化reviewが検証済みである。 | 既存のverdict投稿を継続する。 |
| `RUN_BUDGET_LIMIT_REACHED` | result subtypeが`error_max_budget_usd`で、当該review実行の予算上限に達した。 | 当該実行の予算を利用可能にできる判断をした後、同じheadで新しいreviewを人が起動する。自動再試行しない。 |
| `ACCOUNT_SPEND_LIMIT_REACHED` | result subtype、error type、またはerror detailsのcodeが`enforced_spend_limit_reached`である。 | アカウント側の支出上限が利用可能になったことを人が確認してから、同じheadで新しいreviewを起動する。自動再試行しない。 |
| `TRANSIENT_RATE_LIMIT` | result subtypeまたはerror typeが`rate_limit_error`である。 | 制限が解消したと人が確認してから、同じheadで新しいreviewを起動する。自動再試行しない。 |
| `CLAUDE_EXECUTION_FAILED` | Actionがexecution fileを残す前に失敗した、または上記以外のerror resultが記録された。 | Action実行、認証・設定、入力状態を必要最小限の非機密証跡で調査し、原因を解消してから再実行する。 |
| `REVIEW_RESULT_MISSING` | 検証対象となる成功resultまたはnative出力がない。 | review出力の取得・検証経路を調査してから再実行する。 |
| `REVIEW_RESULT_AMBIGUOUS` | Action successだが最後のresultがsuccess/is_error=falseではなく、優先される実行失敗分類に該当せず、既存classifierの自由テキスト成功result候補が複数ある。 | review出力の検証経路を調査してから再実行する。 |
| `REVIEW_JSON_INVALID` | execution containerまたはreview JSONが不正である。 | 出力・検証経路を調査してから再実行する。 |
| `REVIEW_SCHEMA_MISMATCH` | review JSONが固定schemaに適合しない。 | 出力・検証経路を調査してから再実行する。 |
| `CLASSIFIER_INTERNAL_ERROR` | 信頼済みclassifier/validatorのbootstrapまたは内部処理を確認できない。 | 信頼済みbase commit由来のclassifier/validator bootstrapを確認してから再実行する。 |

HTTP status、特にHTTP 429、Action logの文言、または利用量だけから`ACCOUNT_SPEND_LIMIT_REACHED`と推定してはならない。構造化metadataがこのcodeを示さない失敗は、分類不能または別のreason codeとして扱う。上限到達と分類不能な失敗（少なくとも`CLASSIFIER_INTERNAL_ERROR`、不明なreason code、またはJob Summaryを取得できない場合）では自動再試行を行わず、人間が調査・判断する。

同じheadを再実行する前に、人間はIssue番号、closing Issue、PR番号、対象PR head SHA、失敗run ID、および失敗runのhead SHAを照合する。Job Summaryの`Claude review result`でreason codeを先に確認し、必要な場合だけ該当stepの最小限の非機密情報を確認する。PR差分を変えずに再実行する場合は、GitHub Actions UIで当該runのreviewを再実行し、完了後に新しいrun IDとhead SHAが対象PRの現在head SHAに一致することを確認する。`human-review-required`による停止中は、人間が再開可能と判断してclosing Issue側を先に、PR側を最後に外す。そのPRラベル解除eventが同じheadに対する明示的なClaude再review要求となる。head SHAが変わった場合は同じ実行の再試行として扱わず、新しい差分に対するreviewとして必要な確認をやり直す。

### merge-base/stale判定による承認dismiss時の手動復旧

GitHub内部のmetadataまたは判定実装を原因として断定しない。次のすべてを人間が確認できる異常時だけ、PR headを変更せず同じbase branchへ再設定してPR基準情報のrefreshを試みてよい。

1. GitHubが既存approvalを`The merge-base changed after approval.`などのmerge-base/stale判定理由でdismissした。
2. reviewed head SHAがapproval後も不変である。
3. current base branch tipと実merge-baseを再確認し、reviewが前提にした実差分が変化していない。
4. repository workflowによる明示的dismissや、実際のheadまたはbase branchの更新などの別原因が確認されない。
5. 同一base再設定の前後でhead SHA、実merge-base、実差分が変化していない。

refresh後も同一head・同一実差分である場合だけ、同一headで得たBlockingなしClaude reviewの**内容**を人間最終reviewの証跡として再利用できる。これはdismissされたGitHub reviewを`APPROVED`へ戻すものでも、Rulesetの承認要件を代替するものでもない。merge前に人間はPR画面で、承認1件以上と最新pushへの承認必須を含むRulesetの必須checkが充足していることを確認する。dismiss後もこの承認要件が充足していない場合は、現行headを人間が独立に最終reviewした後、GitHub上で新しい`APPROVE` reviewを投稿する。protected path PRではこのreviewと投稿を人間Code Ownerが行い、その後に手動mergeする。いずれかを満たさない場合、またはhead、実merge-base、実差分が変化した場合は古いreviewを再利用せず、通常の再review条件に従う。この手順は人間による例外的manual recoveryであり、workflowからPR baseを自動更新せず、調査目的だけでClaude reviewを繰り返さない。`Dismiss stale approvals`、最新pushへの承認必須、Code Owner保護その他の安全側rulesetは弱めない。

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

- Codexが、plain textの単独行で完全一致する `[REQUIREMENTS_CHANGE_REQUIRED]` を返した。backtick・code block・字下げ・前後空白は付けず、CRLFは通常のplain-text行末として扱う。説明文中の言及は停止シグナルにしない。Codex最終応答が欠落または空の場合、または検出helperかtrusted bootstrapが失敗した場合も「マーカーなし」と扱わず、Issue起点とClaude review follow-upの両方で安全側に停止する。Claudeのマーカーはstructured review summaryからreviewer側が解釈するため、Codex最終応答の検出規則と意図的に異なる。
- Claudeが `[REQUIREMENTS_CHANGE_REQUIRED]` を返した。
- Claudeが `[HUMAN_ESCALATION_RECOMMENDED]` を返した。
- Claudeのchange requestが3回に到達した。

停止時は関連IssueとPRの両方へラベルを同期する。どちらかにラベルが残っている間は、追加の `/codex develop` 指示やClaudeのchange requestが届いてもCodexを再起動しない。許可済みのClaude change request follow-upでは、follow-up gate通過後にラベルを付けてからCodexを1回実行するため、その実行だけは継続するが、修正pushによる `synchronize` reviewは起動しない。ラベル・PR差分・closing Issueの取得に失敗した場合も安全側に停止する。job条件はevent payload時点でPRの停止ラベルを検出して早期にjobを止め、entry gateはClaude API呼び出し直前にPRとclosing Issueのラベルを再確認する二層構成である。人間が判断を記録し、再開可能と確認した後、closing Issue側を先に、PR側を最後に外す。誤ってPR側を先に外した場合は、PRへラベルを再付与してから、closing Issue側、PR側の順に外し直す。PR側の `human-review-required` が外れたeventだけが明示的なClaude再レビュー要求となる。このラベル解除順序の正本は本運用文書であり、`evaluate-followup-gate.sh`は人間向けの停止理由を、workflowはその値を変更せずに表示する。停止中に誤った順序で起動したcheckは、Job Summaryの「Claude review not run」で未実施理由を確認する。

`NOTIFICATION_WEBHOOK_URL` が設定済みならPRまたはIssueへのリンクをDiscordへ送る。通知scriptはDiscord Webhookの `{"content":"..."}` 形式を使用し、Webhook URLをログ、Issue、PRへ出力しない。未設定時はActionsにwarningを残し、GitHub上のラベルとコメントによる停止は継続する。人間が判断をIssueへ記録し、必要な修正を行った後にだけラベルを外して再開する。

### trusted diff guard

Issue起点developerとClaude review follow-upの両方で、Codex実行後かつrepository write（commit、push、PR作成・更新またはreview応答）前に、全変更をstagingした上でtrusted diff guardを評価する。両経路ともPR headやCodexが変更した作業ツリーのhelperを実行せず、current base commitから `$RUNNER_TEMP/evaluate-codex-diff-gate.sh` として取得した `evaluate-codex-diff-gate.sh` を使用する。取得・bootstrapに失敗した場合も安全側へ停止する。

helperのstdoutは1個の機械可読JSON objectであり、呼出側は `result` と全ての非負整数metricsを検証する。helperのexit statusが0で、JSONが妥当であり、かつ `result=pass` の場合にだけrepository writeへ進む。`stop`、`error`、未知のresult、helper異常終了、出力parse失敗またはmetrics不正は、いずれもwriteを許可しないfail-closed停止とする。

評価対象はstaged diffであり、hard stop閾値は changed files 25、additionsとdeletionsの合計である total changed lines 2,000、new files 10である。各値が閾値ちょうどなら `pass`、いずれか一つでも超過すれば `stop` とする。binary変更、staged `.gitattributes` の `-diff` などでnumstatを数値化できない場合は、変更を省略したり0として扱わず `error` で停止する。bypassは設けない。正当な大規模作業または数値化不能な変更は、安全性・正確性・要求整合性を保てるIssueへ分割するか、人間実装へ切り替える。

`stop` またはerror系の停止では、developer経路はclosing Issueと存在するopen PRを、follow-up経路は対象PRと解決できるclosing Issueを `human-review-required` により停止する。続いてdeveloperはIssueへ、follow-upはPRへ、非機密な停止reasonを診断commentとして記録し、Step Summaryへresult、閾値、利用可能なmetricsまたは「Metrics: unavailable」、およびrepository writeをblockedした決定を記録する。停止通知はその後の専用stepで試行する。再開は「人間エスカレーション」の規約どおり、人間が判断を記録・確認した後にclosing Issue、PRの順でラベルを解除する。

`evaluate-codex-diff-gate.sh` を変更した場合は `bash .github/scripts/test-evaluate-codex-diff-gate.sh` を実行する。AI Developer workflowの静的契約を変更した場合は `bash .github/scripts/test-ai-developer-workflow.sh` を、diff guardを変更した場合は `bash .github/scripts/test-ai-developer-diff-guard.sh` を実行する。Claude Review専用fixtureの責務（entry gate、risk classifier、model/budget配線、native output validator、execution classifier、usage計測、trusted bootstrap、workflow静的契約）を変更した場合は `bash .github/scripts/test-claude-review-workflow.sh` を実行する。`bash .github/scripts/test-ai-workflow.sh` は専用fixtureを置き換えない横断回帰であり、これらに加えて引き続き実行する。

### Codex timeout・runner異常終了時の診断と再開

AI DeveloperのCodex実行には、jobとstepの2段階のtimeoutを設定する。

* `develop-from-issue` と `respond-to-claude` のjob-level timeoutは15分とし、AI Developer全体の外側の停止境界として扱う。
* `Run Codex developer` と `Run Codex follow-up` のstep-level timeoutは30分とし、Codex processに対する内側の防御として扱う。
* step-level timeoutはrunner worker上で執行されるため、runner-lossやrunnerとの通信喪失時に30分をwall-clock上の絶対上限とは扱わない。
* job-level timeoutも15分到達時にcancellationへ移行する境界であり、runner無応答時を含め「15分ちょうどで完全終了する」とは扱わない。

#### Issue起点AI Developerの異常終了

`develop-from-issue` がsuccess以外で終了した場合は、対象Codex jobとは別runnerで `handle-issue-developer-failure` を実行し、安全側へ停止する。

failure handlerは次を行う。

* closing Issueへ `human-review-required` を付与する。
* 同じIssueに紐づくopen PRが存在する場合は、そのPRにも `human-review-required` を同期する。
* PRが存在しない場合はIssueだけを停止状態とする。
* 停止ラベル同期に失敗しても、その後の診断記録と通知を継続する。
* Issueコメントへjob result、pause sync outcome、Actions Run URLを記録する。
* `NOTIFICATION_WEBHOOK_URL` が設定されている場合はDiscord通知を試行する。
* 自動retryは行わない。

`pause sync outcome` がsuccessでない場合、人間は他の復旧作業より先に、Issueおよび存在するPRへ `human-review-required` が実際に付与されているか確認する。

Issue起点のAI Developerを再実行する前に、少なくとも次を確認する。

* 対象Issueが正しいこと。
* 失敗したActions Run URLまたはrun ID。
* `develop-from-issue` のjob result。
* pause sync outcome。
* `ai/issue-<Issue番号>` remote branchの有無と現在のhead。
* 同じIssueに紐づくopen PRの有無とPR head。
* timeoutまたは異常終了後に、予期しないcommit、push、PR作成・更新が発生していないこと。
* 取得可能な範囲で、通常の長時間実行、runner-loss、設定不備、一時的な外部障害等のどのカテゴリが最有力か。

再実行可能と人間が判断した後、停止ラベルがある場合は既存の停止解除規約どおり、closing Issue側を先に、PR側を最後に解除する。

既存PRへ追加開発を継続する場合は、PRがDraftであることと、既に開始済みのClaude Reviewがないことを確認する。非Draft PRで `human-review-required` を解除するとClaude Reviewの再実行条件になり得るため、追加開発中に意図しないレビューを起動しない。

その後、再実行が必要な場合だけ、Open Issueへ `/codex develop` を単独コメントとして投稿する。

#### Claude review follow-upの異常終了

Claude review follow-upでは、`Run Codex follow-up` の実行前に `Gate automated follow-up` がclosing IssueとPRへ `human-review-required` を付与している。

このためCodex follow-upがtimeout、runner-loss、action failure等で異常終了しても、IssueとPRは人間確認が必要な停止状態を維持する。

異常終了後にCodex follow-upを自動retryしない。現行workflowには、停止状態を維持したまま同じClaude指摘に対するCodex follow-upだけを安全に再実行する専用入口はない。

人間はActions結果とPR差分を確認し、必要な修正が残る場合は手動で修正する。修正と確認が完了した後、既存の再開規約に従いclosing Issue側を先に、PR側を最後に `human-review-required` を解除する。

非Draft PRでは、PR側の `human-review-required` 解除eventを、現在headに対する明示的なClaude再レビュー要求として扱う。Draft PRではラベル解除だけではClaude Reviewを開始せず、準備完了後のReady for reviewをレビュー要求とする。

Codex follow-up専用retry入口が将来必要になった場合は、この復旧手順へ例外を追加せず、別Issueで設計・実装する。

#### timeout後の作業分割判断

timeoutや異常終了が発生したという事実だけで、作業量が大きすぎたとは判断しない。

runner-lossやGitHub Actions基盤側の異常は、小さい変更でも発生し得るため、失敗原因がrunner-lossまたはinfrastructure failureと判断できる場合は、それだけを理由にIssueを分割しない。

一方、runnerとログが正常に動作したままCodex実行が15分近く継続してjob-level timeoutした場合、または同じscopeで長時間化を繰り返した場合は、再実行前に作業量を見直す。

分割する場合は、各IssueまたはPRが独立して実装、検証、レビューでき、安全性・正確性・要求整合性を単独で確認できる単位にする。

過去にAI Developerの長時間化を避けるため分割した作業は、新たな根拠なく再統合して大きなAI Developer jobへ戻さない。

Webhook登録、通知確認、main反映後のEnd-to-End確認はIssue #46で追跡する。

## Bootstrapと復旧

`pull_request` workflowはdefault branchにworkflowファイルが存在してから通常運用を開始する。初回導入PRは管理者が内容を確認し、reviewer Appによる一時レビューまたは手動レビューを経てマージする。通常の自動マージは `ai/issue-*` だけに限定されるため、bootstrap用ブランチは自動マージ対象外である。

Actionsが失敗した場合は、失敗step、Appのインストール先・権限、Repository secret/variable名、OIDC federation ruleの対象を確認する。モデルpreflightまたはモデル実行stepで失敗した場合は `CLAUDE_MODEL` / `CLAUDE_MODEL_STANDARD` / `CODEX_MODEL` の設定有無と、指定モデルが現在のAnthropic workspaceまたはOpenAI API projectで利用可能かを確認する。secret値とRepository variable値はログへ出さない。モデルIDについては前述のとおりIssue/PRの変更履歴・検証証跡へ記録してよいが、ログへは出さない。

`.github/scripts/**` を変更した場合、または認可・信頼境界・closing Issue・merge gateのロジックを変更した場合は次を実行し、fixtureを確認する。

```bash
bash .github/scripts/test-ai-workflow.sh
bash .github/scripts/test-claude-review-workflow.sh
bash .github/scripts/test-ai-developer-workflow.sh
```

`.github/workflows/**` を変更したが上記fixtureの対象外と判断した場合は、その理由をPR本文へ記録する。
