# AI開発・ClaudeレビューのGitHub運用

## 目的

Codex/OpenAIを開発者、Claudeを独立レビューアーとしてGitHub上で協調させる。Issueを検討と作業の正本、Pull Requestを成果物とレビュー対話の正本にする。

## 通常フロー

1. 人間が実装対象Issueを作成し、対象、受入条件、上流・下流影響を記録する。
2. 通常のIssue起点開発では、Open Issueに `/codex develop` だけを単独コメントとして投稿する。前後の説明文、引用、Markdown code block、字下げ、前後空白を付けたコメントは実行要求として扱わず、Closed Issueへのコメントでも起動しない。timeout後の例外として `/codex develop extended` も正規commandとするが、利用条件と固定35分上限は「human-approved extended-run」を正本とする。入口はこれら2つのcommandとの等値比較だけを使用し、GitHub公式仕様どおり文字列の等値比較は大文字小文字を区別しないため、運用上の正規形は小文字とする。形式やIssue stateが一致しない場合は入口job自体が起動せず自動ガイダンスも返らないため、反応がない場合はIssueがOpenか、コメントがcommand単独になっているかを確認する。developer App tokenやOpenAI APIを使う前に、Issue自身と対応するopen PRの停止ラベルを事前ゲートで確認する。
3. developer Appが `ai/issue-<Issue番号>` ブランチを作成・更新し、`Closes #<Issue番号>` を含むDraft PRを作成する。同じIssueの追加修正は既存PRへ集約し、自動Ready化しない。人間が下記の準備確認を終えてReady for reviewへ変更すると、Claude reviewが起動する。
4. `PR Traceability / Linked Issue` が実在するclosing Issueを確認する。
5. ClaudeがPR、信頼済み会話、closing Issue、明示された後継Issueのsnapshot、差分を確認し、reviewer Appとして `APPROVE` または `REQUEST_CHANGES` を投稿する。仕様書レビューでは `CLAUDE.md` の重点観点を適用する。Actionへ現行5-key JSON Schemaを渡し、`structured_output` をreview内容の第一入力として、current base由来の `validate-claude-review-output.sh` を通過した結果だけを投稿する。`summary` を総評、`blocking_findings` / `non_blocking_findings` を指摘事項と改善案として記録する。native出力は厳密に1個のJSON値として読み、欠落・不正JSON・schema不一致は非機密な固定reason codeでfail-closed停止する。自由テキスト `result` やMarkdown fenceへfallbackせず、verdictを推測しない。
6. `REQUEST_CHANGES` の場合、reviewer Appを確認したtrusted workflowはreviewの`commit_id`がPRの現在headと一致するときだけPRをDraftへ戻す。一致しないstale reviewはDraft化もCodex follow-upも起動しない。Draft復帰jobの異常終了、gate停止、Codex異常終了、またはpush失敗ではReadyへ戻さず、`human-review-required` により停止する。`ai/issue-*` の通常follow-upは停止ラベルを付けずにCodexを1回だけ実行し、Codex正常完了、requirements gate、trusted diff guard、commit/pushの全成功後だけtrusted workflowがPRをReady for reviewへ戻す。そのReady eventが現在headへの再レビューを1回要求する。Codex対象外PRは人間または既存の明示操作でReadyへ戻す。停止ラベルを人間が解除する場合の順序・再レビュー起動条件・merged/closed PRのcleanupは「人間エスカレーション」節を正本とする。openかつ非Draft PRのPR `unlabeled` eventは明示的な再レビュー要求として維持する。3回目のchange request、要求変更マーカー、または人間エスカレーションマーカーではCodex修正自体を停止する。
7. Claudeが承認し、developer App作成PRが `ai/issue-<Issue番号>` ブランチで、ブランチ番号とclosing Issueが一致し、保護対象のAI指示・agent設定・GitHub自動化を変更せず、IssueとPRのどちらにも `human-review-required` ラベルがない場合だけreviewer Appがsquash mergeする。

人間や任意ブランチから作成したPRはClaudeレビューの対象にはできるが、自動マージしない。

## Issue起点AI Developerへ渡すtrusted conversationの選択

trusted human（`OWNER` / `MEMBER` / `COLLABORATOR`）が `/codex context-checkpoint` と完全一致する単独Issue commentを投稿した場合、その時点までのAI Developerに必要な確定判断・要求・再開条件・未解決事項がcurrent Issue本文へ集約済みであることを人間が保証する。未反映の判断、未解決の上流決定、本文にないpause解除条件や過去の安全判断が残る場合は投稿しない。checkpointはpause解除や要求承認を意味せず、既存のIssue-entry、`human-review-required`、requirements、diff guardの各gateを変更しない。

有効なcheckpointがなければ従来どおりIssue本文とtrusted comment全文をtimestamp順に渡す。有効なcheckpointがあれば最新の一意なtimestampを境界とし、current Issue本文全文と、その後のtrusted comment本文をtimestamp順に渡す。同一timestampはcanonicalなcomment表現で決定的にtie-breakする。checkpoint comment自体とそれ以前のcomment本文は省略し、model-facing contextにも省略境界を明示する。untrusted comment本文は含めない。timestampやboundary選択の異常でもtrusted comment集合を安全に確定できる場合は全文へfallbackし、その理由をcontextに示す。timestamp自体が不正なfallbackではchronological orderを保証できないこともmodel-facing contextへ明示する。metadata / identity破損により完全なtrusted comment集合自体を安全に確定できない場合は、partial historyをfull fallbackと偽らずmodel call前にfail-closed停止する。選択規則と非機密な文字数・byte数telemetryは `.github/scripts/build-development-context.py` を正本とする。Claude Review側の選択は次節を正本とする。

## Claude Reviewへ渡すtrusted conversationの選択

Claude Reviewのreview contextでは、reviewer Appによる最新のformal review（`APPROVED` または `CHANGES_REQUESTED`）を会話履歴の境界とする。境界より古いreviewer App reviewは本文を含めず、author、state、submittedAt、structured review summaryで単独行完全一致した `[REQUIREMENTS_CHANGE_REQUIRED]` と `[HUMAN_ESCALATION_RECOMMENDED]` の有無だけを保持する。境界より古いtrusted comment本文は含めない。一方、trusted humanまたはdeveloper Appによるreview本文と、最新formal review以後に必要なtrusted conversationは保持する。

formal Claude reviewがまだない初回reviewでは、trusted conversation全文を保持する。identity、metadata、timestampなどから安全に選択できない場合も、黙って一部を省略せずtrusted conversation全文へfallbackし、その事実をreview contextに明記する。過去reviewのstateとmarker情報は、`REQUEST_CHANGES`後の復旧および停止判定に使うため、本文を短縮した場合も保持する。具体的な選択条件と実装は `build-review-context.sh` を正本とする。

## Issueの分割単位

Issueは、独立して判断・実施・検証・完了判定でき、単独でmainへ反映しても安全性・正確性・要求および設計の整合性を維持できる「意味のある最小単位」とする。Issue作成時だけでなく、検討・実装・reviewによって責務境界が明らかになった時点でも、この単位を維持しているか再評価する。

1つの確定判断と、その判断に伴って整合性を維持するため不可分な関連修正は、1つのcoherent changeとして同一Issueで扱う。POL / BR / REQ / AC / TC / CON / OOS、関連する仕様・設計・実装・test・図・追跡表等を、ファイル数、識別子数、行数その他の機械的な単位で別Issueへ分割してはならない。

一方、独立して判断・実施・検証・完了できる変更を、同じ上位目的、機能、発見契機または作業時期に属することだけを理由に同一Issueへまとめてはならない。Issue境界は、少なくとも次を確認して判断する。

- 他の変更と独立して人間が判断できること。
- Issue単独で完了条件を定義し、必要な検証を実施できること。
- Issueだけをmainへ反映し、後続Issueを実施しなくても安全性・正確性・要求／設計整合性を維持できること。
- 分割によって、要求・設計・実装・test等の正本間に一時的な矛盾を発生させないこと。

これらを満たす変更は分割候補とする。逆に、分割すると正本が不整合になる変更、または1つの確定判断を成立させるために不可分な関連修正は、同一Issueで扱う。前段Issueの成果を後続Issueが利用する場合も、各Issueの完了時点でrepositoryが安全かつ整合した状態を維持できるなら、依存順序を明示して分割してよい。

複数の独立変更に共通する全体方針、共通契約、状態モデルまたは実施順序を先に検討する必要がある場合は、親Issueを検討・統括単位として使用してよい。親Issueで確定した方針に基づく具体的変更は、独立して判断・実施・検証・完了できる実施Issueへ分割する。親Issueを分割可能な実装をまとめて実施する巨大な作業Issueとして使用してはならず、単一のcoherent changeで完結する場合は不要な親Issueを新設しない。

作業開始後に独立したスコープ外責務が判明した場合も、本節の基準で分割可否を再評価する。後継Issueへ分離する場合は「スコープ外影響と後継Issue」の契約に従い、後続Issueが未実施であることを理由に不完全または不整合な状態をmainへ反映してはならない。

## 関連修正の集約とレビュー準備

Issue #125で、細かな関連修正ごとのClaude呼び出しを減らすため、新規のIssue起点PRをDraftで作成する方式を採用した。本節は、確定済みIssueのcoherent changeをDraft PRへ集約しreviewを準備する手順を定める。Issueの境界と再評価は「Issueの分割単位」を正本とする。

Issueを確定する際は、対象ファイル・節・IDに加え、同じ判断に伴う参照、用語、追跡表、図、検証範囲を洗い出して本文へ記録する。既存の別Issueを無断で取り込まず、範囲を広げる場合は人間の決定を先にIssue本文へ反映する。

### Issue本文におけるcurrent implementation contract

Open Issueへ `/codex develop` を投稿する前に、Issue本文がその時点で有効な実装契約、すなわちscope、責務境界、入出力interface、完了条件および検証範囲を表していることを確認する。trusted conversationでこれらの実装判断が更新され、本文の記述が古くなった場合は、実行前にcurrent contractをIssue本文へ同期する。

本文と矛盾する過去のtrusted commentの技術契約は履歴として残してよいが、削除ではなく、Issue本文からcurrent contractが一意に判断でき、過去契約が置き換えられたことが分かる状態にする。本文と矛盾しない補足説明や進捗コメントまで機械的に複製する必要はない。

この実行前規約は、`develop-from-issue` がIssue本文とtrusted commentをDevelopment requestへ連結するIssue起点経路へ直接適用する。Claude review follow-upは既存のPR、review、closing Issueに基づくfollow-up gateと再開契約を維持し、本規約による本文同期手順またはcontext選択方式を追加しない。

Draft中はClaude Reviewのjob条件がレビューを抑止する。Draftをpushで更新しても自動Ready化はしない。必要な追加開発だけを同じIssueへ依頼し、変更が揃うまで同じPRへ集約する。生成PR本文と通常PRテンプレートの`Review readiness`欄は人間の確認記録であり、チェックボックス自体を機械的な認可・検証ゲートとは扱わない。

### Validation provenance

AI Developerが掲載するCodex report内のvalidation記述はCodexの自己申告であり、formal GitHub Actions evidenceではない。repository changeをpushした投稿ではworkflowが取得した`Pushed commit` SHAを、そのrunが行ったrepository writeの識別子として表示する。このSHAはCodexが同一内容をvalidation済みであることを意味しない。formal current-head validationはGitHub Actions/checks側の別証拠を正本とし、AI Developerはそのstatus/resultを取得・判定しない。repository changeのないfollow-up投稿ではpush SHAを表示しない。

AI Developerの投稿またはjob successだけでは、別のmachine-generated evidenceが明示的に証明しない限り、少なくともCodex reportに記載されたcommand・条件での実行、そのreportが最後の変更後かつ表示SHAと同一内容に対する実行、各validationのexit statusまたは出力の独立確認、GitHub Actions/checksの開始・完了・status/result、job successがreport内の各validation成功を意味することを保証しない。

人間は次を確認してからPR画面の **Ready for review** を実行する。

- 同じ判断に伴う関連修正がIssueの許可範囲内で揃っている。
- 影響するPOL / BR / REQ / AC / TC / CON / OOS、関連文書・図との整合を確認している。
- Codex-reported validationを自己申告の証拠として確認し、current headに適用されるGitHub Actions/checksをformal evidenceとして別に確認している。failure、未実施、未確認事項を隠さず、PR本文または最新コメントに`passed`とあることだけをformal evidenceとして扱わない。
- 未解決のBlockingや上流判断がなく、延期する影響はclosing Issue本文に既存の後継Issue契約どおり記録されている。
- PRとclosing Issueが停止中でなく、追加開発やpushが進行中でない。

`ready_for_review`後は既存のClaudeレビュー・停止・マージ条件を適用する。Claude ReviewはReady eventのheadを対象とする。trusted Codex follow-upはpush後に期待SHAを固定し、GitHub上のPR headがそのSHAへ反映されたことをboundedに確認してからReady化する。反映待ちの上限内に一致しない場合、または別SHAが観測された場合はReady化せず停止する。verdict投稿時にcurrent PR headとの追加一致gateは設けず、merge時の`--match-head-commit`と混同しない。Ready後にheadが変わったreviewの`REQUEST_CHANGES`はfollow-up対象にせず、そのheadを人間または明示的なtrusted経路で再びReady化してレビュー要求する。Draftはマージできず、Ready化は承認やマージを意味しない。新規PR作成の`--draft`は[GitHub CLI仕様](https://cli.github.com/manual/gh_pr_create)、DraftとReadyの扱いは[GitHub公式説明](https://docs.github.com/en/pull-requests/reference/pull-requests#draft-pull-requests)を参照する。

Claudeの`REQUEST_CHANGES`後、reviewer Appを確認したtrusted workflowはreviewの`commit_id`がPRの現在headと一致するときだけPRをDraftへ戻す。一致しないstale reviewはDraft化もCodex follow-upも起動しない。通常の追加作業をレビュー前にまとめ直す場合も、人間が追加pushより前にDraftへ戻す。Draftへ戻す操作だけで開始済みのAPI呼び出しを取り消せるとは扱わない。Draftか非Draftかを問わず、単なるpushの`synchronize`はClaude Reviewを起動しない。

Issue起点の開発、resume develop、Claude Blocking follow-upは、同じcanonical `ai/issue-N` branchへのwriterとしてIssue番号由来の共通concurrency groupを使い、進行中のwriterをcancelしない。

`human-review-required`は要求・レビュー判断の停止であり、Draftによる作業準備とは別である。停止ラベルをDraft化で代替せず、追加開発や再レビューのために無断解除しない。停止中のopen PRに対する解除順序と再レビュー起動条件、merged/closed PRのstale label cleanupは「人間エスカレーション」節を正本とする。Draft PRではラベル解除だけでClaudeは起動せず、準備完了後のReady化がレビュー要求になる。

### 承認後の非Blocking改善

承認後の非Blocking改善は、先行マージが安全性・正確性・要求整合性を損なわないことを人間が確認した場合だけ、次の関連保守Issueへまとめてよい。closing Issue本文へ残る影響、先行マージ可能な理由、後継Issue、範囲・完了条件・時期または順序を記録し、PR本文へ要約とリンクを反映する。詳細は「スコープ外影響と後継Issue」を正本とする。非Blockingという分類だけで延期せず、要求や判断を実質的に変更した場合は古い承認を流用せず再レビューする。不要な微修正pushで承認済みheadを変更しない。

## ChatGPT Workのコンテキスト・コスト管理

ChatGPT WorkをGitHub作業の対話窓口として使う場合は、Issue単位でチャットを分け、Actionsログを失敗stepから段階的に取得し、作業内容に応じてモデルを選択する。同一head SHA・run IDのPR本文、review、Actions Job Summaryを再利用し、状態が変わっていない証跡を繰り返し調査しない。

Project Sources、Project instructions、チャット分割条件、モデル選択基準、開始テンプレート、チャット終了時と再開の正本は [`chatgpt-work-context-cost-operation.md`](chatgpt-work-context-cost-operation.md) とする。確定仕様はGitHub main上の正本文書、未決事項・検討状態はIssueを正本とし、チャットだけに決定を残さない。

## スコープ外影響と後継Issue

Codexはスコープ外影響を発見した場合、その安全性・正確性・要求整合性への影響を調査して報告する。Claudeは、対応を後継Issueへ分離する妥当性と、その後継Issueを確認する。後継Issueの存在だけでblockingを解除してはならない。

後継対応へ分離できるのは、元PRを先にマージしても安全性・正確性・要求整合性を損なわない場合に限る。確定した決定はclosing Issue本文を正本とし、残るスコープ外影響、今回のPRを先にマージできる理由、後継Issue番号、後継Issueの変更範囲・完了条件、および対応時期または順序を記録する。PR本文にはその要約と元Issue・後継Issueへのリンクを記載する。Issueコメントで決定した内容も、確定後はclosing Issue本文へ反映する。

IssueとPRでは `## Scope-out impact and follow-up` 見出しを使用する。各same-repository後継Issueは `- Follow-up Issue: #<number>` の1行で明示し、対象がなければ `none` とする。review context生成はPR本文とclosing Issue本文のこの定型欄だけを読み、closing Issueと重複しない後継Issueを再帰せずに取得する。PRとclosing Issueから抽出した異なる後継Issueの合計に適用する上限値の正本は `build-review-context.sh` の `follow_up_issue_limit` であり、現在は5件である。6件以上が抽出された場合は切り捨てずreview context生成をfail-closedで停止する。後継Issueを整理・分割するか、人間レビューへ切り替えて復旧する。後継Issueの番号・タイトル・state・本文はuntrusted data境界内のsnapshotとしてClaudeへ渡す。定型欄外の通常の番号参照は後継Issueとして扱わない。明示された後継Issueを取得できない場合も、存在しないと推測せずreview context生成をfail-closedで停止する。

## 必要なGitHub Actions設定

Repository secrets:

- `DEV_APP_PRIVATE_KEY`
- `REVIEW_APP_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `DEEPINFRA_API_KEY`（DeepInfra Investigator専用。read-only調査workflowのDeepInfra API call stepだけで使用し、Issue・PR・ログ・artifactへ値を出力しない）
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

例外として、DeepInfra Investigatorは任意モデルIDをIssue入力やRepository variableから実行させないことをsecurity boundaryとするため、許可するDeepSeekモデルを `.github/scripts/deepinfra-investigator.py` の `ALLOWED_MODELS` で固定する。workflow側のcommand→model対応とpreflight allowlistはentry boundaryでの多層防御として同じ許可集合を意図的に重複保持し、`test-deepinfra-investigator.sh` で一致を回帰検証する。DeepInfra Investigatorのモデル変更は通常のモデル切替ではなくsecurity allowlist変更として扱い、Issueで範囲を確定しCode Owner review対象の差分として反映する。

### DeepInfra Investigator

DeepInfra Investigatorは、信頼済みIssue上のコメント `/deepseek analyze` または `/deepseek analyze v4.1` で起動する。コメント投稿者とIssue作成者はいずれも `OWNER` / `MEMBER` / `COLLABORATOR` のいずれかでなければならない。通常コマンドは `DeepSeek-V4-Flash-0731`、`v4.1` 付きコマンドはallowlist済みの `DeepSeek-V4.1-Flash` を選ぶ。

調査workflowは `actions: read` / `contents: read` / `issues: read` のread-only権限だけを持ち、repository write、Issue/PR write、workflow dispatch、任意shell実行をモデルへ提供しない。結果はActions Step Summaryと7日保持artifactへ出力する。API失敗、schema不正、context取得失敗等はfail-closedとし、自動probe実行やproduction AI Developerの変更へ進めない。詳細な実行契約とtool allowlistの正本は `.github/workflows/deepinfra-investigator.yml` と `.github/scripts/deepinfra-investigator.py` とする。

### DeepInfra Review Benchmark

Claude Reviewのprovider移行評価は、production review経路と分離した手動のDeepInfra Review Benchmarkで行う。評価の検討状態と凍結済みexpected resultの正本はIssue #342とし、benchmark runnerへexpected verdictやexpected findingを渡してはならない。

Stage A runnerはdefault branch上の `workflow_dispatch` から、workflowに固定されたcase IDとmodel IDを1組だけ選んで起動する。任意PR番号、任意SHA、任意prompt、任意model IDは受理せず、自動matrix・自動retry・automatic fallbackを行わない。モデルvisible contextはcurrent mainの `CLAUDE.md` / `AGENTS.md` と、固定caseのbase→selected head差分・selected head時点の変更ファイル・current PR metadata/body snapshot・current closing/follow-up Issue snapshotから決定論的に構成する。follow-up候補はproduction reviewと同様にPR本文とclosing Issue本文の `Scope-out impact and follow-up` 節の和集合から重複排除して取得し、closing Issue自身を除外する。PR bodyは `Closes #N`、Summary、Validation、Scope-out等のcurrent evidenceを保持する一方、historical model verdictを後付けで漏らさないため `Review readiness` / `Review response` / `Claude review` H2節を除外する。Issue #342 / #343 / #359 は評価・runner・paid実行の管理情報であり、follow-upとして記録されていてもsnapshotをmodel contextへ取り込まない。この除外はモデルvisibleなbenchmark instructionとcase metadataへ明示し、missing follow-up evidenceやblocking理由として扱わせない。historical Claude review本文、Issue #342のexpected result、selected headより後のPR commitはcontextへ含めない。Stage Aはcurrent-contract synthetic replayであり、mutableなIssue/PR情報を使用するためexact historical replayとは表現しない。

workflow権限はcontents/issues read-onlyとし、モデルへtoolやrepository write経路を公開しない。DeepInfra API callは既存 `DEEPINFRA_API_KEY` と `.github/scripts/deepinfra-investigator.py` のshared transport / secret redaction境界を再利用する。結果はproduction Claude Reviewへ投稿せず、Actions Step Summaryと7日保持artifactだけへ出力する。structured result schemaはcurrent `.github/workflows/claude-review.yml` のreview JSON schemaを読み、schema mismatch・free-form result・truncationはfail-closedとする。DeepInfra API応答受領後にschema不正・truncation・cost guard超過等でfail-closedする場合も、取得できたtoken usage、local/provider estimated cost、duration、validation status/reasonを先にJSON/Markdownへ保存し、workflowは失敗時もSummaryとartifactを回収する。API到達前またはprovider failureでusageが得られない項目は成功値を捏造せず `unavailable` と記録する。

Stage Aで許可するcase/model集合、固定SHA、context上限、単一run cost guardの正本は `.github/scripts/deepinfra-review-benchmark.py` とする。価格表は評価時点のDeepInfra公表価格をtrusted configurationとして固定し、paid run開始前に現行価格を再確認する。Issue #342で承認されたDeepInfra評価費用は全体で$10をhard ceiling、Stage Aは$2を目標上限とし、runnerは累積費用を自動で増やすfan-outを持たない。各runのprompt/completion token、provider/local estimated cost、duration、context hashを成果物へ記録する。Stage A paid execution、Stage B/C、shadow運用、production Claude Review provider変更はrunner実装Issueとは別Issueで扱う。

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

production Claude Reviewは `anthropics/claude-code-action@9ca9355b36297178e28d37c799d1c9c8a28e6507` を固定し、Claude Code 2.1.280 / Agent SDK 0.3.280を使用する。high-risk reviewはmodelやbudgetと同じrisk選択で `--effort high` を明示する。standard-risk reviewにはeffort引数を渡さず、現行の挙動を維持する。本更新ではRepository variable `CLAUDE_MODEL` のOpus 5からOpus 5.5への切替を行わない。Opus 5.5へのmodel切替は後続Issue #415の運用で行う。

利用量記録stepはverdict経路を阻害しない非致命stepとする。通常step logには、集計済みusage JSONを1行だけ出力し、Actions Job logs APIから回収可能にする。このJSONの項目はresult subtype、is error、turns、duration、estimated cost、input/output token、cache creation/read tokenだけである。Job Summaryにはそれらの利用量を表形式で記録し、workflowが付加するRisk class、Action outcome、Schema validも含める。Risk class、Action outcome、Schema validはusage JSONには含めない。prompt本文、review本文、raw execution file、secret値はどちらにも記録しない。execution file未設定、ファイル不在、または集計失敗時はusage JSONをstep logへ出力せず、Job Summaryへ`Execution usage was unavailable.`を記録する。集計失敗時だけはraw execution由来のstderrを通常logへ出さず、固定文言`Claude usage summarization failed.`を1行だけstderrへ出力する。

`modelUsage` が1件以上ある場合、token fieldはClaude Code session全体のモデル別累積値として、対象fieldが全modelで数値の場合だけ合算する。1modelでも欠落・非数値ならそのfieldは`null`とし、query call内の累積値であるtop-level `usage`へfield単位でfallbackしない。`modelUsage`が空または利用不能の場合だけ、token fieldをtop-level `usage`から取得する。`estimated_cost_usd`はquery全体のSDK見積りである数値の`total_cost_usd`を優先し、利用不能な場合のみ、全modelで数値の`modelUsage.costUSD`を合算する。一部でも欠落・非数値なら`null`とする。`modelUsage`とtop-level `usage`は集計範囲が異なり得る。

利用量が欠落・不正でも、review結果の厳密検証とverdict投稿は継続する。

Claude Codeの標準5分prompt cacheを使用し、Issue #61の高リスク2実行分と、後継Issue #63で追跡する実際の通常PR 1実行分のcache creation/read tokenを合わせて評価する。1時間cacheはwrite単価が高く、自動再レビューを停止した運用では再利用機会が限定されるため、反復利用の実測根拠が得られるまで有効化しない。

Message Batches APIは非同期処理であり、即時のreview verdictを必要とする同期PR gateへ導入しない。夜間処理など遅延を許容でき、複数の独立したreviewをまとめられる用途が生じた場合は別Issueで再検討する。

### Claude review失敗の分類と再実行

Claude Reviewの`review` jobは異常stallに対するwall-clock hard boundaryとして15分でtimeoutさせる。15分はreview品質の目標時間ではない。job timeoutまたはsuccess以外の終了では構造化verdictが成立したと扱わず、`needs.review.result == 'success'`を満たさないためmerge jobへ進まない。timeout後の自動retryは行わず、人間が失敗runを調査して再実行を判断する。

`Claude Review Failure Handler` は別runnerの `workflow_run.completed` から同一attemptの `Review` jobを確認する。source runの同一repositoryのbranchとHEADからPRを解決し、`pull_requests` の関連付けが空でも処理できるようにする。関連付けが存在する場合は解決したPRと照合する。Review成功・skip、古いHEADやrun、明示budget/spend分類はgeneric pauseを作らない。対象PRがreview workflowを変更した場合や分類signalを信頼できない場合もgeneric reasonを推測せず停止する。候補だけをtrusted default branchのhelperで `claude_execution_failed` としてpauseし、現在PR HEADを `paused_head` に記録する。primary Issueはbranch名から推測せず、既存のclosing Issue関係に従ってラベルを同期する。GitHub pause成立後のDiscord通知、重複抑止、競合時のfail-closed処理は `create-human-pause.sh` を正本とし、自動retryは行わない。

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

同じheadを再実行する前に、人間はIssue番号、closing Issue、PR番号、対象PR head SHA、失敗run ID、および失敗runのhead SHAを照合する。Job Summaryの`Claude review result`でreason codeを先に確認し、必要な場合だけ該当stepの最小限の非機密情報を確認する。PR差分を変えずに再実行する場合は、GitHub Actions UIで当該runのreviewを再実行し、完了後に新しいrun IDとhead SHAが対象PRの現在head SHAに一致することを確認する。`human-review-required` による停止中の解除順序と、ラベル解除が同じheadへの再review要求になる条件は「人間エスカレーション」節を正本とする。head SHAが変わった場合は同じ実行の再試行として扱わず、新しい差分に対するreviewとして必要な確認をやり直す。

### Claude Review Cost Guard

Issue #390 のPhase 1は、`Claude Review` を `workflow_run` の `in_progress` と `completed` で監視する独立したread-only Cost Guardである。PR headをcheckout・実行せず、default branchから取得したhelperとActions metadataだけを使い、LLM、raw job log、usage telemetryの常時取得を使わない。`requested` はre-runで発生しないため、監視の根拠にしない。

監視keyはsame-repository head branchであり、workflow run IDではなくpaid execution attemptを単位にする。15分rolling windowは各attemptの`run_started_at`で集計し、同一run IDのRe-runも`run_attempt`ごとに別executionとして数える。初回runの`created_at`をRe-run時刻の代用にしない。最新attemptがcurrentから30分以内にあるsame-branchの全run IDについて、過去attemptを復元する。これはcurrentとその直前attemptの各15分窓を比較するためであり、最新attemptがその候補範囲より古いrunの復元は不要である。`completed` かつ `skipped` はpaid burstに数えず、`in_progress` はpaid-capable候補として数える。current attemptの窓が閾値以上で、直前のsame-key attemptの窓が閾値未満の場合だけ、その連続episodeの先頭として通知する。したがって4件目のnon-skipped / paid-capable attemptの`in_progress` activityでreview burst、3件目の`cancelled` attemptの`completed` activityでcancel stormを各1回通知し、rolling windowの前進で件数が閾値へ戻っても重複通知しない。APIから再取得した可変statusではなくevent activityを使うため、開始event後にattemptが完了しても起動回数の検知は失われない。review burstは`in_progress` activityだけを通知対象とし、同attemptの`completed` activityでは通知しない。永続stateは持たない。attempt取得はrunあたり最大20回、全候補で最大100回にboundedし、上限超過、取得不能、不正なmetadataでは通知判定を行わず診断に留める。2026-09-18〜21の実測では#378が15分8件・cancelled 6件、#339が7件・5件、#365/#343が各4件・3件だった一方、#387のreview-ready self-testは最大3件・cancelled 0件だったことが根拠である。

通知は既存`notify-human.sh`によるDiscordのみで、trigger、15分窓のrun数/cancelled数、head branch、取得可能ならPR番号、current run URL、および自動停止していない事実だけを含める。PR番号が安全に取得できないことは監視を無効化しない。metadataが不完全・不正なら0費用や正常とは推測せず診断を残し、通知判定を行わない。`NOTIFICATION_WEBHOOK_URL`未設定時は既存helperどおりwarning相当で正常終了する。

Cost Guardはreview verdict、merge、pause、`human-review-required`、budget、workflow有効化、自動retryを変更しない。standard `$1.70` / high-risk `$2.10` run budget値の確定は#173、budget/account spend limit到達時のpause・Discord通知配線は#160、wall-clock異常は#146の責務である。usage欠損を0 USDとして扱わない。compact usageを低コストかつ安全に渡す恒久方式が必要になれば、このmetadata burst detectorを拡張せず#390のscopeを再確認するか後継Issueで扱う。main反映後は、計測目的のpaid reviewを実行せず、自然なrun/re-runで`workflow_run` event挙動を確認する。

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

- Codexが、plain textの単独行で完全一致する `[REQUIREMENTS_CHANGE_REQUIRED]` を返した。backtick・code block・字下げ・前後空白は付けず、CRLFは通常のplain-text行末として扱う。説明文中の言及は停止シグナルにしない。Codex最終応答が欠落または空の場合、または検出helperかtrusted bootstrapが失敗した場合も「マーカーなし」と扱わず、Issue起点とClaude review follow-upの両方で安全側に停止する。
- Claudeのvalidated structured review `summary` に、plain textの単独行で完全一致する `[REQUIREMENTS_CHANGE_REQUIRED]` または `[HUMAN_ESCALATION_RECOMMENDED]` がある。backtick・code block・字下げ・前後空白付きの行や説明文中の言及は停止シグナルにせず、CRLFは通常のplain-text行末として扱う。判定step自体が失敗した場合はreview jobを失敗させ、mergeへ進ませない。Claude review follow-upと過去reviewのmarker短縮記録も同じ単独行規約を使う。
- Claudeのchange requestが3回に到達した。

`.github/scripts/classify-claude-human-escalation.sh` は、callerがtrusted境界で抽出したClaude structured reviewの`summary`本文だけをstdinからplain textとして受け取るpure helperである。行末CRだけを除いた単独行完全一致で上記2種類のmarkerを分類し、markerなしは`{"result":"none"}`、要求変更だけなら`{"result":"pause","reason":"requirements_change"}`、人間エスカレーションだけなら`{"result":"pause","reason":"explicit_human_escalation"}`、両方あれば`{"result":"state_inconsistent"}`を返す。同一markerの重複は同一signalとして扱い、review JSONやPR comment wrapper、自由文からreasonを推測しない。Claude Reviewはcurrent base SHA由来のhelperで分類し、markerなしは停止せず、それ以外の3結果はreasonを推測せず従来の `apply-human-pause.sh` によるラベル同期と通知を行う。Claude Reviewのhuman escalationではcommon pause recordを作らず、人間がclosing Issue、PRの順にラベルを解除する現行resumeを維持する。分類またはtrusted helperの失敗はreview jobを失敗させ、自動retryしない。

Issue起点のpost-Codex requirements gateは、明示マーカーだけを `requirements_change`、最終応答の欠落・空ファイルまたはtrusted marker helperの異常終了を `developer_execution_failed`（`failed_action=develop`）として `create-human-pause.sh` に渡す。マーカーなしは停止しない。Issue起点のdiff guardはhelper成功かつ妥当な `stop` だけを `diff_guard_exceeded`、`error`・helper失敗・不正/未知出力を `diff_guard_error` として渡す。`requirements_change` と `diff_guard_exceeded` のfingerprintはpause直前にcanonical Issueのcurrent body stringをAPIから再取得し、そのUTF-8 bytesだけをSHA-256にかけた `sha256:<64 lowercase hex>` とする。取得・形式・hashの失敗はfail-closedで停止する。両gateはCodex前にblob identityを固定したtrusted base由来のcommon helperと依存scriptをpost-Codexに再配置・照合し、developer App IDを解決して呼び出す。GitHub pause成立後の通知と重複抑止はcommon helperに委ねる。

停止時は関連IssueとPRの両方へラベルを同期する。どちらかにラベルが残っている間は、追加の `/codex develop` 指示やClaudeのchange requestが届いてもCodexを再起動しない。通常のClaude change request follow-upは停止ラベルを付けずに実行し、成功時だけReady eventで再レビューへ進む。Draft復帰jobの異常終了、3回目のchange request、要求変更、diff guard stop、Codex異常、または人間エスカレーションでは停止ラベルを付ける。ラベル・PR差分・closing Issueの取得に失敗した場合も安全側に停止する。Claude Reviewの入口は二層で保護する。workflow job条件はevent payload時点でPRがopenであり停止ラベルを持たないことを確認して早期にjobを止め、trusted base由来のentry gateはClaude API呼び出し直前にGitHubからPR stateとPR / closing Issueの停止ラベルを再取得する。entry gateはopen PRだけをreview対象とし、merged / closed PRはmodel call前に正常skipする。PR stateを安全に判定できない、または未知stateである場合はfail-closedで停止する。 workflow job条件はpull_request event payloadの小文字 `open` を判定し、trusted entry gateは `gh pr view` の `OPEN` / `CLOSED` / `MERGED` を判定するため値の語彙は異なるが、いずれもopen PRだけをpaid reviewへ進める。

人間が判断を記録し再開可能と確認した後、open PRの停止ラベルはclosing Issue側を先に、PR側を最後に外す。誤ってopen PR側を先に外した場合は、PRへラベルを再付与してからclosing Issue側、PR側の順に外し直す。openかつ非Draft PRではPR側の `human-review-required` が外れたeventが明示的なClaude再レビュー要求となり、Draft PRではラベル解除では起動せずReady for reviewが再レビュー要求となる。

manual protected-path merge等によりmerge後もstale `human-review-required` が残った場合も、cleanup順序はclosing Issue側を先に、merged/closed PR側を最後とする。ただしmerged/closed PR側のラベル解除はClaude再レビュー要求として扱わず、paid Claude Reviewを起動しない。この停止解除・cleanup順序とreview起動条件の正本は本節であり、`evaluate-followup-gate.sh`は人間向けの停止理由を、workflowはその値を変更せずに表示する。停止中に誤った順序で起動したcheckは、Job Summaryの「Claude review not run」で未実施理由を確認する。

`NOTIFICATION_WEBHOOK_URL` が設定済みならPRまたはIssueへのリンクをDiscordへ送る。通知scriptはDiscord Webhookの `content` と自動mentionを無効にする `allowed_mentions: {parse: []}` を送り、contentが1800 byteを超える場合は送信に失敗する。Webhook URLをログ、Issue、PRへ出力しない。未設定時はActionsにwarningを残し、GitHub上のラベルとコメントによる停止は継続する。人間が判断をIssueへ記録し、必要な修正を行った後にだけラベルを外して再開する。

### human pause record のschema契約

コメントへ埋め込むversion 1のrecordは `.github/scripts/human-pause-record.sh` をschema validationの正本とする。`reason` はそのrecordが扱う有効なpause reasonであり、`kind` ごとの意味は次のとおりである。

- `pause.reason` はpause作成時の初期reasonである。
- `pause-normalization.reason` はnormalization後に有効となるreasonである。normalization前のreasonは `source_pause_id` の因果chainを辿って導出し、重複する `from_reason` fieldはrecordに保持しない。
- `ai-resume-accepted.reason` はresume受理時点で有効なreasonである。

`target` は自由文字列ではなく、文字列全体が `issue:<number>` または `pr:<number>` でなければならない。`<number>` は先頭0なしの1以上の10進整数である。`pause_id` はGitHub REST comment IDを文字列化した値であり、GraphQL `node_id` は用いない。`source_pause_id` は参照先`pause_id`と同じく、文字列全体が先頭0なしの1以上の10進整数でなければならない。独立した `pause` は `source_pause_id` を持たず、厳密形式の `source_pause_id` を持つ `pause` はreplacement pauseである。`ai-resume-accepted` と `pause-normalization` は `source_pause_id` を必須とする。厳密な形式検証はschema validatorを正本とする。schema validatorは単一recordの形式と許可済みreasonだけをfail-closedで検証し、`source_pause_id` のchain解決、chainから導出したeffective reasonと `ai-resume-accepted.reason` の一致確認、または探索対象ConversationのIssue/PR種別・番号とrecord targetの一致確認は行わない。これらの因果・探索境界の検証は後続のlifecycle reconciliationおよびConversation探索でfail-closedに行う。

`.github/scripts/list-human-pause-records.sh` はこのprimitiveを用いてtrusted Conversation recordを列挙する。trusted GitHub App IDを入力として受け、REST Issue comments APIの `performed_via_github_app.id` と一致するcommentだけを候補にする。PRがあればPR番号、なければIssue番号のConversationだけを探索し、双方を混在させない。stdoutは単一のJSON object `{target, records:[{pause_id, record}]}` とし、trustedかつschema-validで探索対象と`target`が一致するrecordが0件でも成功して `records: []` を返す。REST comment `id` を`pause_id`として返す。untrusted、schema不正、または`target`不一致のcommentはskipし、Conversation取得失敗またはAPI応答shape不正はfail-closedとする。このhelperはrecord数からactive / consumed / supersededを判定しない。

`.github/scripts/validate-human-pause-record-graph.sh` はlisting helperのstdoutをstdinで受け、構造的にvalidな場合だけ同じJSONをstdoutへ返す。`pause_id` の重複、存在しない`source_pause_id`、self reference、cycle、および一つのpredecessorへの複数successorをfail-closedで拒否する。forkを禁止するため、各chainは構造上linearであり、一つのpredecessorが持てるsuccessorは高々一つである。recordの列挙順、root数、record数は意味論に使用せず、複数の独立rootまたは過去chainを許容する。このhelperはtrusted性・schema・targetを再検証せず、`pause_id` / `source_pause_id` の厳密形式も再検証しない。これはtrusted recordのschema形式を `human-pause-record.sh` に委ね、このhelperが辺解決・重複・欠損source・cycle・forkというgraph責務だけを担う意図的な分界である。lifecycle status、effective reason、active pauseも導出しない。

`.github/scripts/decompose-human-pause-record-graph.sh` はvalidated graphのstdoutをstdinで受け、同じ`target`と`{records:[...]}`からなる`chains`を返す。各chainは`source_pause_id`を持たないrootからterminalまで因果順に並べ、全recordをちょうど1回だけ含める。複数chainはroot `pause_id`を正の10進整数として精度に依存せず比較した昇順で返すため、入力列挙順に依存しない。空の`records`は空の`chains`となる。このhelperはgraph validatorの信頼性・schema・構造検証を重複せず、機械的に読めないenvelopeまたは一意に完全分解できない入力だけをfail-closedで拒否する。lifecycle status、effective reason、active pauseは導出しない。

`.github/scripts/derive-human-pause-pre-resume-state.sh` はchain decompositionのstdoutをstdinで受け、`target`、各chain、各`records`を保持したまま各chainへ`pre_resume`を付加する。正常な`pre_resume.status`は `active` である。root `pause`を初期stateとし、replacement `pause`または`pause-normalization`は直前のeffective pauseをsupersedeして、そのrecord自身の外側`pause_id`と`reason`を新しいstateとする。最初の`ai-resume-accepted`より前だけを解釈し、acceptance自身とsuffixの意味論は扱わない。chainは独立に処理し、normalizationの前reasonはsource chainからのみ導出して自由文fieldに依存しない。pre-acceptance prefixが意味論上解釈不能な場合はfail-closedとし、Conversation全体のactive集約、acceptanceのconsumed判定、production workflow wiringは扱わない。

`.github/scripts/reconcile-human-pause-resume-acceptance.sh` はpre-resume derivationのstdoutをstdinで受け、`target`、各chain、各`records`、各`pre_resume`を保持したまま各chainへ`effective`を付加する。`ai-resume-accepted` がないchainは`pre_resume`のpause identityとreasonを持つ`active`となる。acceptanceが1件だけありchain terminalで、その`source_pause_id`と`reason`が`pre_resume`と一致するときだけ、同じpause identityとreasonを持つ`consumed`となり、acceptance自身の外側`pause_id`は`accepted_record_id`として保持する。acceptance直後に `source_pause_id` でacceptanceを参照する `resume_transition_failed` のreplacement `pause` が1件あり、acceptanceの`payload.action`とreplacementの`payload.failed_action`が同じcanonical resume action（develop / validate / review / fix / follow-up / no-action）の場合だけ、replacementを新たな`active`とする。複数acceptance、その他の非terminal acceptance、sourceまたはreasonの不一致、有効でない`pre_resume`、empty `records` chain、または`pre_resume.pause_id`が当該chainの`records[].pause_id`に属さない人工入力はfail-closedとする。このhelperはreplacement / normalizationからのpre-resume state再導出、Conversation全体の集約、production workflow wiringを扱わない。

`.github/scripts/reconcile-human-pause-active-pause.sh` はresume acceptance reconciliationのstdoutをstdinで受け、各chainの`effective`をConversation単位で集約する。`effective`のstatus、pause identity、reasonが有効な`active` / `consumed`であることだけを検証し、record graph、replacement / normalization、またはacceptance semanticsを再解釈しない。`chains` の列挙順には依存せず、active chainの件数と内容だけで結果を決定する。activeが0件なら`{target, result: "no_active_pause"}`、1件ならその`effective.pause_id`と`effective.reason`を持つ`{target, result: "active", active_pause}`、2件以上なら`{target, result: "state_inconsistent"}`を返す。未知statusまたは集約に必要なshapeが不正な入力はfail-closedとし、production workflow wiringは扱わない。

`.github/scripts/create-human-pause.sh` は上記のtrusted listingとreconciliationを使うhuman pause遷移境界である。`create REPO ISSUE PR APP_ID REASON DETAIL [--paused-head SHA] [--issue-body-fingerprint sha256:<64 lowercase hex>] [--failed-action develop|fix]` はactive pauseがなければ選択したConversationにroot `pause` recordを投稿し、REST comment IDを`pause_id`とする。既存の末尾positional `PAUSED_HEAD` も受けるが、新規producerはnamed optionを使う。`--paused-head` はPRを指定した場合だけ40文字の小文字SHAとして受け、record schemaの `paused_head` へ渡す。`requirements_change` / `scope_decision` / `diff_guard_exceeded` は `--issue-body-fingerprint` を必須とし、`payload.issue_body_fingerprint` へ渡す。`developer_execution_failed` は `--failed-action develop|fix` を必須とし、`payload.failed_action` へ渡す。`failed_action=fix` は同一HEADでの再開を要するため、`--paused-head`（または既存のpositional `PAUSED_HEAD`）も必須とする。他のreasonへこれらのmachine fieldを付加できない。これらをDETAILから推測せず、未知・重複・値不足・形式不正のoptionをfail-closedで拒否する。Issue本文の取得とfingerprint計算はproducerが行う。IssueまたはPRの一方は`-`で省略できるが、少なくとも一方を指定する。PRがあればrecordはPR Conversationに置く。既存active pauseが同じreasonでも、指定されたpaused HEADとreason固有のmachine fieldが `active_pause.pause_id` のroot recordと完全一致する場合だけラベルを再同期して`already_active`を返し、欠落・不正・不一致ならfail-closedとする。DETAILの差はdedupeに使用しない。`inspect REPO ISSUE PR APP_ID PAUSE_ID` は既存IDのactive / consumedを確認し、activeならラベルを再同期し、`already_active` / `already_consumed`を返す。resume拒否や既存pauseの再検出には`inspect`を使い、これらの経路では通知しない。新しいpause作成時は `human-review-required` を関連Issue / PRへ同期し、作成したrecordがtrusted listingで確認できてからのみ `.github/scripts/format-human-pause-notification.sh` のreason別日本語文を `.github/scripts/notify-human.sh` でbest-effort送信する。作成後のreconciliationが `state_inconsistent` ならどちらのrootも正常扱いせず、GitHubの停止を維持し、同reasonの通知をbest-effortで送ってfail-closedとする。他のラベル・record整合の失敗では通知せず停止し、Discord未設定・送信失敗ではGitHub上のpauseを維持する。自由文DETAILはrecord payloadに全文を残し、Discord向け表示だけ先頭250文字に省略する。DETAILをworkflow制御には使用しない。machine-only stateはrecord schemaと通知formatterのreason allowlistに含めない。schemaのreason集合は `human-pause-record.sh reasons` から取得し、fixtureで全reasonのformatter対応を確認する。

親 #219 に関わるproduction producerへの配線順序は、#444 のcommon helper hardening、最初のproduction consumerとなる #146 のClaude Review非success handler、既存producer移行を追跡する #445 とする。#146 はtimeout・runner lossの可視性を担うため、広範なproducer整理より先に接続する。#444 の完了までは #146 をproductionへ接続せず、自動retryは追加しない。

`.github/scripts/parse-ai-resume-command.sh` はstdinからちょうど1個のJSON objectを受け、`body`、`actor`、`author_association` がすべてstringでなければfail-closedで拒否する。複数JSON value、object以外、必須field欠落、型不正もfail-closedとする。`OWNER`、`MEMBER`、`COLLABORATOR` 以外のassociation、または`/ai resume` commandでないcommentは`{"result":"ignore"}`を返す。trusted actorのresume系commentでは、1行全体に厳密一致する小文字の`/ai resume develop`、`validate`、`review`、`fix`、`follow-up #N`、`no-action`だけを受理し、`follow-up`の`N`は先頭0なしの1以上の10進整数とする。通常actionは`{result:"accepted", actor, action}`、follow-upは正のJSON numberの`follow_up_issue`を加えたaccepted objectを返し、その他は`{result:"reject", code:"invalid_command"}`を返す。このhelperはactive pause解決、GitHub target、allowlist、dispatch、production workflow wiringを扱わない。

`parse-ai-resume-command.sh` を変更した場合は `bash .github/scripts/test-parse-ai-resume-command.sh` を実行する。

`.github/scripts/inspect-ai-resume-target.sh <repo> <issue|pr> <number>` はstdinから#299のaccepted command objectをちょうど1個だけ受け、`owner/repo`と先頭0なしの正整数targetを検証してcurrent target metadataをfail-closedで正規化する。open non-PR Issueは`command`、`target:"issue:N"`、`issue:{number,state:"open"}`、`pull_request:null`を返す。open PRは`target:"pr:N"`、`issue:null`、およびnumber、open state、base/head ref、40桁のcurrent head SHA、branch名が`ai/issue-N`の場合だけの`branch_issue_number`、same-repository closing Issue URLだけをsort/uniqueした`closing_issue_numbers`を固定shapeで返す。入力`command`は#299 accepted shapeを維持し、`follow-up`では正の整数`follow_up_issue`も保持する。PR branchとclosing Issueのrelation、branch Issueのopen判定、canonical closing Issue、dispatch、production workflow wiringは扱わない。GitHub response、stdin、target、またはstateのshape不正・closed targetはすべて停止する。

`inspect-ai-resume-target.sh` を変更した場合は `bash .github/scripts/test-inspect-ai-resume-target.sh` を実行する。

`.github/scripts/resolve-ai-resume-target.sh <repo> <issue|pr> <number>` はstdinの#299 accepted command objectを#307 `inspect-ai-resume-target.sh`へ渡し、そのnormalized metadataからcanonical closing Issue relationだけをfail-closedで確定する。open non-PR Issue targetではtarget自身をclosing Issueとする。PR targetでは`head_ref`が`ai/issue-N`で`branch_issue_number`がN、かつNがsame-repository `closing_issue_numbers`に含まれることを要求し、REST APIでIssue Nがopen non-PR Issueであることを確認する。closing Issueが複数でもNをcanonicalとし、1件限定にはしない。出力は`{command,target,closing_issue:{number,state:"open"},pull_request}`の固定shapeで、Issue targetの`pull_request`はnull、PR targetではnumber、open state、base/head ref、head SHAだけを含む。`command`は#307のaccepted shapeを`follow_up_issue`も含めそのまま保持し、internal-onlyの`branch_issue_number`と`closing_issue_numbers`は出力しない。current metadata取得、closing Issue body / fingerprint / follow-up、dispatch、production workflow wiringは扱わない。

`resolve-ai-resume-target.sh` を変更した場合は `bash .github/scripts/test-resolve-ai-resume-target.sh` を実行する。

`.github/scripts/build-ai-resume-github-context.sh <repo> <issue|pr> <number>` はstdinの#299 accepted command objectを#308 `resolve-ai-resume-target.sh`へ渡し、そのrelation snapshotへcurrent canonical closing Issue本文由来のfactsを付加する。closing Issueの同一REST responseにある必須string `body`のUTF-8 bytesを末尾改行の追加・削除なしでSHA-256にかけ、`closing_issue.body_fingerprint`を`sha256:<64 lowercase hex>`とする。`follow-up` actionの場合だけ`command.follow_up_issue`のsame-repository current Issue API responseからnumber、Issue / PR種別、open / closed stateを取得し、同じclosing Issue bodyの`## Scope-out impact and follow-up`節に定型`- Follow-up Issue: #N`行があるかを`follow_up_issue.explicitly_recorded`へ記録する。抽出規則は`build-review-context.sh`と同じ見出し・行形式を使用し、自由形式proseや別見出しから推測しない。通常actionの`follow_up_issue`はnullとする。出力は`{command,target,closing_issue:{number,state,body_fingerprint},pull_request,follow_up_issue}`の固定shapeで、relation由来のcommand、target、closing Issue number/state、PR factsを保持する。API取得・body・response shapeが不正ならfail-closedとし、body内容の十分性、fingerprint差分、follow-upのresume可否、dispatch、production workflow wiringは判定しない。

`build-ai-resume-github-context.sh` を変更した場合は `bash .github/scripts/test-build-ai-resume-github-context.sh` を実行する。

`.github/scripts/build-ai-resume-prepare-context.sh <repo> <issue|pr> <number> <trusted-app-id>` はstdinの#299 accepted command objectをちょうど1個受け、最初に `build-ai-resume-github-context.sh` からcurrent GitHub factsを取得する。canonical closing Issue番号とPR番号（Issue targetでは `-`）を `list-human-pause-records.sh` へ渡し、listing、graph validation、chain decomposition、pre-resume derivation、resume acceptance reconciliation、active pause reconciliationを既存helperの順に直列合成する。各段の失敗、複数JSON value、target不整合、出力shape不正はfail-closedとする。`result:active` の場合だけ、元のtrusted listingから `active_pause.pause_id` と外側 `pause_id` が一致する唯一のentryを解決し、record本文をそのまま `pause:{result:"active",pause_id,reason,record}` に保持する。一致が0件または複数件なら停止する。active以外は既存の意味どおり `pause:{result:"no_active_pause"}` または `pause:{result:"state_inconsistent"}` とする。出力は#306の `command`、`target`、`closing_issue`、`pull_request`、`follow_up_issue` を保持して `pause` を追加した固定shapeである。GitHub facts、record schema、graph、chain、lifecycle、acceptanceの意味論はそれぞれ前段helperが正本とし、このhelperはresume可否policy、dispatch、production workflow wiringを扱わない。

`build-ai-resume-prepare-context.sh` を変更した場合は `bash .github/scripts/test-build-ai-resume-prepare-context.sh` を実行する。

`.github/scripts/prepare-ai-resume.sh` は#304のfinal PREPARE contextをstdinから1個だけ受け、GitHub APIを再取得せずにresume policyを判定する。schema不正はfail-closedで停止し、通常拒否は固定codeの `{result:"reject",code}` を返す。active source recordのidentity、kind、reason、target、open closing Issue、PRが必要なactionのopen / main / current HEADを確認する。`requirements_change` / `scope_decision` / `diff_guard_exceeded` の`develop`だけはpause時とcurrent Issue本文のfingerprint差分を必須とし、`fix` / `review` / `follow-up` / `no-action`だけはsource recordの`paused_head`とcurrent PR HEADの完全一致を必須とする。`validation_failed`は`validate` / `develop`を許可し、`validate` / `develop`に共通PREPAREのsame-HEAD条件を追加しない。`developer_execution_failed`、`review_disagreement_decision`、`resume_transition_failed`のactionはsource payloadの`failed_action`または`decided_action`からのみ判定し、`follow-up`は同一番号のopen Issueとclosing Issue本文の定型参照を要求する。詳細なallowlistと固定reject codeはhelperとfixtureを正本とする。

成功時は`{result:"prepared",dispatch}`の固定shapeを返す。dispatchはsource pause ID / reason、command actor / action、canonical closing Issue、PR番号とpause / current HEAD、pause / current Issue本文fingerprint、follow-up Issue番号をnull付きで保持するPREPARE時点のsnapshotである。producerはこの結果でsource pauseをconsumedにせず、`ai-resume-accepted` record、ラベル解除、consumer起動、ACK polling、Discord再通知を行わない。consumerはcurrent target / HEADとaction固有条件をtrusted gateで再取得・再確認する。

`/ai resume develop` のproduction producerはtrusted baseのparserとPREPAREをDeveloper App token / App IDで実行し、`{event_type:"ai-resume-develop",client_payload:{version:1,dispatch:<PREPARE dispatch>}}` の固定envelopeを送る。`client_payload` のtop-level keyは`version`と`dispatch`の2個で、inner dispatch snapshotは変更しない。consumerは`dispatch.closing_issue_number`で既存Issue Developerと同じ `codex-issue-N` concurrencyを取得した後、inner `dispatch` だけをuntrusted snapshotとしてcurrent GitHub factsとactive pauseを再取得する。source pauseより後の同じConversationにtrusted actorの厳密なcommand commentが存在し、PREPAREの全dispatch fieldが一致する場合、PR targetは先にDraftへ遷移させて再取得で確認し、その後App provenance付き `ai-resume-accepted` を投稿する。Draft遷移失敗では元pauseとlabelsを維持する。既存lifecycle pipelineでsourceがconsumedかつactive pause無しと確認してからclosing Issue、PRの順に `human-review-required` を解除し、同じrunで通常のIssue Developerへ進む。accepted後の解除失敗はacceptanceを巻き戻さず `resume_transition_failed` replacement pauseとラベル再同期を試みて停止する。producerとconsumerのrecord探索は最大10ページ（各100件）で打ち切り、上限到達やAPI異常は停止する。重複・stale dispatchはactive pause再検証で拒否する。resumeは通常timeoutだけを使用し、Codex後のrequirements gate、diff guard、write boundary、異常終了handlerは通常経路と共通である。

`prepare-ai-resume.sh` を変更した場合は `bash .github/scripts/test-prepare-ai-resume.sh` を実行する。

schema形式の正本は `human-pause-record.sh`、graph構造の正本はgraph validator、chain分解の正本はdecomposition helperである。pre-resume意味論、acceptance意味論、Conversation集約は、それぞれ後段のderive、resume-acceptance、active-pause helperが担当する。後段helperの防御的validationは、自身が安全に処理するために必要な入力境界をfail-closedで確認するものであり、上流契約を第二の正本として再実装するものではない。特に、この防御的validationをgraph validatorの第二schema正本化へ逆流させない。

### trusted diff guard

Issue起点developerとClaude review follow-upの両方で、Codex実行後かつrepository write（commit、push、PR作成・更新またはreview応答）前に、runtime-onlyの `.ai-context` をworktreeとindexから除外し、それ以外の変更をstagingしてindexを確定する。trusted diff guardはこのstaged diffを評価する。両経路ともPR headやCodexが変更した作業ツリーのhelperを実行せず、current base commit由来でpre-Codexにblob identityを固定し、post-Codex restoreで再materialize・identity再検証した `$RUNNER_TEMP/evaluate-codex-diff-gate.sh` を使用する。base helperの取得・bootstrap、post-Codex restore、blob identity検証、contract再生成またはschema検証に失敗した場合も安全側へ停止する。

引数なしの評価modeでは、helperのstdoutは1個の機械可読な評価結果JSON objectであり、呼出側は `result` と全ての非負整数metricsを検証する。helperのexit statusが0で、JSONが妥当であり、かつ `result=pass` の場合にだけrepository writeへ進む。`result=pass` 後からrepository writeまで、guardが評価したindexを維持する。再度の `git add` その他のindex更新、または `git commit -a` / `git commit -am` により、未評価のworktree変更をcommit対象へ追加してはならない。repository writeの対象は、guardが評価してpassしたstaged diffと同一でなければならない。`stop`、`error`、未知のresult、helper異常終了、出力parse失敗またはmetrics不正は、いずれもwriteを許可しないfail-closed停止とする。

hard stop閾値のproduction正本は、base-derivedの `.github/scripts/evaluate-codex-diff-gate.sh` にある3定数である。その現行参照値は、changed files / total changed lines / new filesの順に `25 / 2,000 / 10` であり、この文書は値の別正本ではない。引数なしはstaged diffを評価するmode、`--contract` はproduction contractを取得するmodeである。後者は同じ定数から `max_changed_files`、`max_changed_lines`、`max_new_files` だけを含むcontract JSON objectをstdoutへ出力し、その他の引数または複数引数はusage errorで失敗する。評価modeでは結果JSONとmetricsを、`--contract` modeでは3 keyだけからなるschemaと正の整数値を、それぞれ呼出側が検証する。

Issue起点とfollow-upのbootstrapが生成する `$RUNNER_TEMP/codex-diff-guard-contract.json` は、Codexへの早期抑止指示用 `.ai-context/diff-guard-contract.json` を作るためのdisposable inputであり、model execution前に `RUNNER_TEMP` から削除する。`.ai-context/diff-guard-contract.json` はruntime-onlyのmodel-visible worktree artifactでありCodexが変更できるため、hard-stop判定またはJob Summaryのtrusted sourceとして扱わない。hard-stop判定とJob Summaryの閾値表示は、post-Codex restore stepがtrusted baseから復元・blob identity検証した `evaluate-codex-diff-gate.sh --contract` から再生成し、schemaと値を再検証した `$RUNNER_TEMP/codex-diff-guard-contract.json` だけから導出する。PR headやCodexが変更したworktreeのcontractでこれらを上書きしてはならない。temporal rematerialization、blob identity、fail-closed orderingの詳細契約は後述「Issue起点developerのCodex実行境界」を単一正本とする。

評価対象はstaged diffである。changed files、additionsとdeletionsの合計である total changed lines、new filesの各値がcontractの対応する閾値ちょうどなら `pass`、いずれか一つでも超過すれば `stop` とする。binary変更、staged `.gitattributes` の `-diff` などでnumstatを数値化できない場合は、変更を省略したり0として扱わず `error` で停止する。bypassは設けない。正当な大規模作業または数値化不能な変更は、安全性・正確性・要求整合性を保てるIssueへ分割するか、人間実装へ切り替える。

`stop` またはerror系の停止では、developer経路はprimary Issueと、canonical branchに一致するsame-repository open PRがちょうど1件ならそのPRをcommon helperで停止し、0件ならIssueのみ停止する。same-repository候補が複数件・API結果が不正・結果打ち切りの疑いがあればPR target解決をfail-closedとし、pause成立後にIssueへ非機密な診断commentを記録する。このPR target規則はIssue起点requirements gateと異常終了handlerにも適用する。follow-up経路は対象PRと解決できるclosing Issueを `human-review-required` により停止し、PRへ診断commentを記録する。Step Summaryにはresult、閾値、利用可能なmetricsまたは「Metrics: unavailable」、およびrepository writeをblockedした決定を記録する。developer経路の通知はcommon helperがGitHub pause成立後に試行し、follow-up経路の通知は専用stepで試行する。再開時の停止ラベル解除は「人間エスカレーション」節の停止解除・cleanup契約に従う。

`evaluate-codex-diff-gate.sh` を変更した場合は `bash .github/scripts/test-evaluate-codex-diff-gate.sh` を実行する。`human-pause-record.sh` を変更した場合は `bash .github/scripts/test-human-pause-record.sh` を実行する。`list-human-pause-records.sh` を変更した場合は `bash .github/scripts/test-list-human-pause-records.sh` を実行する。`validate-human-pause-record-graph.sh` を変更した場合は `bash .github/scripts/test-validate-human-pause-record-graph.sh` を実行する。`decompose-human-pause-record-graph.sh` を変更した場合は `bash .github/scripts/test-decompose-human-pause-record-graph.sh` を実行する。`derive-human-pause-pre-resume-state.sh` を変更した場合は `bash .github/scripts/test-derive-human-pause-pre-resume-state.sh` を実行する。`reconcile-human-pause-resume-acceptance.sh` を変更した場合は `bash .github/scripts/test-reconcile-human-pause-resume-acceptance.sh` を実行する。`reconcile-human-pause-active-pause.sh` を変更した場合は `bash .github/scripts/test-reconcile-human-pause-active-pause.sh` を実行する。`reconcile-human-pause-resume-acceptance.sh` または `reconcile-human-pause-active-pause.sh` を変更した場合は、#278 → #273 の実出力直結合成性を維持する `bash .github/scripts/test-reconcile-human-pause-resume-acceptance-active-pause.sh` も実行する。AI Developer workflowの静的契約を変更した場合は `bash .github/scripts/test-ai-developer-workflow.sh` を、diff guardを変更した場合は `bash .github/scripts/test-ai-developer-diff-guard.sh` を実行する。`build-review-context.sh` のscript挙動（trusted/untrusted conversation境界、follow-up Issue抽出・重複排除・上限・取得失敗のfail-closed、linked Issue取得失敗、diff上限）を変更した場合は `bash .github/scripts/test-build-review-context.sh` を実行する。Claude Review専用fixtureの責務（review context workflow step契約・trusted bootstrap、entry gate、risk classifier、model/budget配線、native schema準備、native output masking、native output validator、execution classifier、usage計測、structured review保存、workflow静的契約）を変更した場合は `bash .github/scripts/test-claude-review-workflow.sh` を実行する。`bash .github/scripts/test-ai-workflow.sh` は専用fixtureを置き換えない横断回帰であり、これらに加えて引き続き実行する。

`create-human-pause.sh` または `format-human-pause-notification.sh` を変更した場合は `bash .github/scripts/test-create-human-pause.sh` を実行する。

### Codex timeout・runner異常終了時の診断と再開

AI DeveloperのIssue起点Codex実行は、**systemd service cgroup内のinner timeout、GitHub step timeout、job-level timeout** の3段階で有限時間へ収束させる。

* 通常 `/codex develop` はinner `RuntimeMaxSec=700s`、developer step 12分、job 15分とする。
* 人間が明示的に `/codex develop extended` を選んだ場合だけ、inner `RuntimeMaxSec=1780s`、developer step 30分、job 35分へ固定延長する。任意timeout入力、automatic fallback、automatic retryは設けない。
* transient serviceの**timeout収束に関わるproperty**として `Type=exec`、`KillMode=control-group`、`SendSIGKILL=yes`、`TimeoutStopSec=5s` を固定する。service property全体の正本は後述「Issue起点developerのCodex実行境界」とし、inner timeoutをCodex process treeのprimary bound、GitHub step timeoutをsystemd/root-shell異常時のbackstop、job timeoutをrunner-lossを含む最終外側boundとして扱う。
* `respond-to-claude` はpin済みv1.12 Actionを `safety-strategy: unsafe` のsetup専用に限定し、prompt / prompt-file / output-fileを渡さない。actual follow-up Codexはtrusted native binaryをservice-local boundary内で実行するため、Action default `drop-sudo` に依存せず、host-global socket permission、sudoers、group membershipを変更しない。
* follow-upはinner `RuntimeMaxSec=700s`、step 12分、job 15分で有限時間に収束させる。Issue起点developerと同じtrusted Action blob / localhost Responses proxy検証、runner UID + nobody GID + clear groups + no-new-privs + capabilities zero、generic AF_UNIX許可と13 fixed socketのservice-local mask、residual `/run` writable root-owned UNIX socket fail-closed scanを使う。service終了後のunit限定journal回収、rc=0時のexact preflight success marker検証、exit 51の切り分けも「Issue起点developerのCodex実行境界」を正本として同一契約を使う。workloadの前後ではread-only socket / systemd-resolved / DNS integrity observerがrepository write前に不変を確認する。OpenAI API keyはsetup Actionだけに渡し、native serviceの`env -i` allowlistには渡さない。failure時のrequirement gate、trusted diff guard、repository-write fail-closed順序とautomatic retryなしの契約は維持する。
* timeout / failure後に同jobでrepository writeへ進む例外は設けない。developer stepがsuccessしない限り、requirement gate、diff guard、commit、push、PR作成へ進まない。

#### Issue起点developerのCodex実行境界

Issue Developer / `/ai resume develop` はIssue単位のwriter concurrency内で、Codex runtime準備前に `origin/main` を明示fetchし、そのcommitをcurrent trusted base SHAとしてhelper blob、`AGENTS.md`、diff guard contractに使用する。canonical `ai/issue-N` branchが存在しない場合だけこのSHAから作成する。既存branchはremote HEADを取得し、current mainがbranch HEADのancestorである場合だけCodexへ進む。stale branch、fetch失敗、ancestry検証失敗ではremote branchへのwriteやpaid Codexを行わずfail-closedし、remote HEADがpre-write snapshotから不変なら既存failure handlerの `developer_execution_failed`（`failed_action=develop`）pauseへ進む。branchの自動merge / rebase / resetは行わず、Codex diff guardは今回のstaged diffだけを計測する。#484 / #487のpaused PRは自動同期せずsuperseded候補として保持し、pause解除やPR normalizationは#229 / #483 / #485の正本に従う。

2026-09-18の #309 調査では、Issue起点AI Developerの長時間停止を段階的に切り分けた。

* #312ではGitHub Actionsのbackground/cancel後もcomposite内部processがjob cleanupまで残り得ることを実証し、background/cancelをprocess停止境界として不採用とした。
* #313 / Run #838ではpin済みActionをsetup-only化してnpm `codex exec` を通常 `run:` stepへ分離してもjob cancellationまで収束しなかった。
* #316 / Run #57ではliteral / expressionのstep timeout自体は正常に発火しdirect parent PIDを停止できる一方、descendant processが残り得ることを実証した。direct parentが先にexitしてdescendantだけがstdioを保持するケースではstepは約5秒で収束した。
* `@openai/codex@0.156.1` のnpm entrypointはNode launcherで、platform native Codexをspawnしsignalをforwardしてchild終了を待つ。#407で `rust-v0.156.1/codex-cli/bin/codex.js` とmanaged-install環境を確認した。`0.153.4` / #318の確認はhistorical evidenceに限定する。
* #318 / Run #58ではtrusted npm packageからnative Codexをfail-closedに解決し、npm launcher/native双方が `codex-cli 0.153.4` を返すことを実証した。
* #322 / Run #60ではpin済みActionのofficial root-phaseとupstream相当`setpriv` hardeningを再現し、runner UID、nobody GID、supplementary groups empty、`NoNewPrivs=1`、全capability zero、sudo disabledを確認したが、step timeout後もhardened childが生存した。
* #324 / Run #61では同じroot-phase + `setpriv` hardening済みprocess treeをsystemd transient service cgroupへ収容し、別sessionへ逃げたsignal-resistant childを含め `RuntimeMaxSec` + `TimeoutStopSec` + `KillMode=control-group` + `SendSIGKILL=yes` で有限時間に停止できることを実証した。
* #357 / Run #103 `35496283169` では、v1.12 root-phaseのhost-global service-socket制限を分離し、`/run/systemd/notify` 制限がsystemd-resolvedのwatchdog/restart loopを起こし、さらに `/run/dbus/system_bus_socket` をroot-only化するとlate DNS failure、artifact failure、job cancellationまで再現することを確認した。systemd v255 sourceでも、restart後の非root resolvedはDNS stub開始前にsystem bus接続へ失敗し得る。
* #363 / PR #364 / Run #137 `35500874486` ではroot-phaseを呼ばず、systemd service-localのAF_UNIX deny、native ABI固定、io_uring syscall denyと既存 `setpriv` hardeningだけでactual Codex 0.153.4のlocalhost Responses request、20秒cgroup timeout、sudo不可、AF_UNIX不可、AF_INET可を同時に実証した。host側のnotify/D-Bus socket、systemd-resolved PID/NRestarts、DNSは前後不変だった。ただしこの時点ではCodex local-tool / bubblewrap pathを未検証だった。
* #368 / Run `35505392927` ではproduction service-local境界からactual Codex model callまでは成功したが、最初のlocal commandでbubblewrapが `Failed to look up lo: Address family not supported by protocol` となり、#363 positive proofにlocal-tool互換性の穴があることを確定した。
* #371ではこのproduction local-tool blockerをsecretlessに再実証する調査単位として切り出し、#372 / #374 / #376 / #377の順に原因、一変数比較、production同型userns条件、代替service-local boundaryを実証した。positive proof完了後にCloseし、production実装を#378へ分離した。
* #372 / Run `35506216726` では一変数比較により `RestrictAddressFamilies=~AF_UNIX` が上記loopback lookup failureの直接原因であることを確定した。
* #374 / Run `35507303861` ではactual Terra Code Modeの `exec -> tools.exec_command` pathでもcurrent境界は同じlookup failure、AF_UNIX controlは次段のRTM_NEWADDRまで進むことを確認した。
* #376 / Run `35507942245` ではproduction同型official userns prerequisite下でgeneric AF_UNIXを許可し、既存setpriv / NoNewPrivs / capability / cgroup境界を維持したactual Terra local toolが `codex-exec-tool-probe-ok` まで成功した。
* #377 / Run `35508896886` では、旧root-phaseが実際にmode縮小していた13 root-owned socketを `InaccessiblePaths=` でservice-localにmaskし、AF_UNIX / AF_INET可、actual Terra local tool成功、13 socketのhost inode非露出、host socket metadata / systemd-resolved / DNS前後不変を同時に実証した。

productionのIssue起点developerは#324のcgroup positive proofを維持し、#357で判明したhost-global mutationを廃止する。#363で採用したblanket AF_UNIX denyは#368/#372/#374でlocal-tool blockerと確定したため撤回し、#376/#377でpositive proofしたgeneric AF_UNIX許可 + historical 13 socketの `InaccessiblePaths` maskを採用する。runner-image driftは同service identityから `/run` のroot-owned writable UNIX socketをread-only走査し、未知socketが残ればmodel call前にfail-closedする。

`Setup Codex developer runtime` はpin済み `openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e` v1.12を維持し、Codexは0.153.4から0.156.1へ更新する。OpenAI API keyを受け取る唯一のstepとする。prompt / prompt-file / output-fileは渡さずmodel executionへ入らない。setup-only invocationでは `safety-strategy: unsafe` を明示するが、これは**Actionのhost-global `drop-sudo` を起動せずCLI / localhost Responses proxyを準備するsetup専用指定**であり、Codex workloadをunsafeで実行する意味ではない。pin済みv1.12の `writeProxyConfig()` は `unsafe` 時にもpermission / sandbox / approval設定を書かず、`model_provider = "codex-action-responses-proxy"` とlocalhost `base_url` / `wire_api = "responses"` だけを追加する。

setup前にはrunner temp `CODEX_HOME/config.toml` を削除し、前runや別設定の残存を許可しない。setup後のtrusted resolverはrunner PATH上のnpm entrypointを起点に `@openai/codex@0.156.1`、Linux x64 / arm64 platform package、native `vendor/<target>/bin/codex` をfail-closedに検証する。さらにrunner action cache内のpin済みAction `dist/main.js` を解決し、`git hash-object` がGit blob SHA `ce4e94e119abb91b980d23bfb4210688241f3a0a` と一致することを必須とする。workspace、Issue本文、comment由来のpathやpackage名は使用しない。runner UID / primary GID / supplementary GIDsはupstream `LinuxRunnerCredentials` shapeのcompact JSONとして取得し、developer step開始時に再照合する。resolverとfixed prompt stepは各3分timeoutでfail-closedに束縛する。

固定developer promptは `$RUNNER_TEMP` の専用fileへ書き、Issue本文とtrusted conversationは従来どおり `.ai-context/request.md` のdataとして読み込ませる。workflow shellへIssue本文を展開しない。

`RUNNER_TEMP` はCodex workloadをまたぐtrusted artifact保持境界として扱わない。native Codex serviceへ `RUNNER_TEMP` 自体をallowlistし、`CODEX_FINAL=$RUNNER_TEMP/codex-final.md` をworkload completion時に書き出すproduction経路が成立しているため、同directoryへpre-Codexに置いたhelper / contractについて「workloadから書換不能」とは推定しない。Issue Developerでは `notify-human.sh` / `apply-human-pause.sh` / `has-requirements-change-marker.sh` / `evaluate-codex-diff-gate.sh` のbase commit blob SHAとbase SHAをpre-Codex runner step outputへ固定し、follow-upでも同4 helperのbase blob SHAをstep outputへ固定する。これらのstep outputはnative Codex serviceの `env -i` allowlistへ渡さない。pre-Codex helperと `codex-diff-guard-contract.json` はcontext生成後に `RUNNER_TEMP` から削除し、workspace側 `.ai-context/diff-guard-contract.json` はmodel-visible dataであってpost-Codex trusted判定の正本とはしない。Codex終了後かつhost integrity observer成功後、requirement gateより前に同4 helperをexplicit base commitから再materializeし、各fileの `git hash-object --no-filters` がpre-Codexに固定したblob SHAと一致することを必須とする。missing / malformed output、`git show` failure、blob mismatchはいずれもfail-closedとし、diff guard contractは復元済み `evaluate-codex-diff-gate.sh --contract` から再生成してschemaを再検証する。その後のrequirement marker判定、human pause / notify、diff guardだけがこの復元済みartifactを使用する。Issue Developer / Claude follow-upは同じ境界を使い、root-owned temporary directory、host-global permission mutation、追加secret、追加model callには依存しない。

developer stepはtrusted Action helperのblob SHAを再確認したうえで、`sudo -n` を**transient service作成だけ**に使用する。step environment全体をrootへ継承する `sudo -E` は使用せず、pin済みActionの `drop-sudo --root-phase` は呼ばない。runner userのgroup membership、sudoers、root-owned `/run` service socketなどhost-global stateを変更しない。root shellから `systemd-run --wait --collect` で一意なtransient serviceを作成し、既存のcgroup propertiesに加えて `NoNewPrivileges=yes`、`SystemCallArchitectures=native`、`SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register` を固定する。Codex/bubblewrapがlocal tool sandbox初期化にAF_UNIXを必要とするためblanket `RestrictAddressFamilies=~AF_UNIX` は使用しない。代わりに、#377 / Run `35508896886` でpositive proofした旧root-phase対象13 socketを `InaccessiblePaths=` でtransient serviceのmount namespaceだけにmaskする。対象pathは `/run/dbus/system_bus_socket`、`/run/dhcpcd/eth0-4.unpriv.sock`、`/run/docker.sock`、`/run/snapd-snap.socket`、`/run/snapd.socket`、`/run/systemd/io.systemd.ManagedOOM`、`/run/systemd/journal/dev-log`、`/run/systemd/journal/socket`、`/run/systemd/journal/stdout`、`/run/systemd/journal/syslog`、`/run/systemd/notify`、`/run/systemd/userdb/io.systemd.DynamicUser`、`/run/uuidd/request` の13件である。runner imageでpathが存在しない場合だけ `-` prefixで無視し、host側permissionは変更しない。service内では `setpriv` を用いて次を固定する。

* `--reuid=<runner uid>`
* `--regid=<validated nobody gid>`
* `--clear-groups`
* `--no-new-privs`
* `--bounding-set=-all`
* `--inh-caps=-all`
* `--ambient-caps=-all`

native Codex exec前には同じservice / `setpriv` contextで、UID/GID、supplementary groups empty、`NoNewPrivs=1`、全capability zero、`sudo -n true` の失敗、AF_UNIX socket作成成功、AF_INET socket作成成功をfail-closedに確認する。さらにroot shellはservice起動直前に固定13 pathのうち存在するsocketについてowner/dev:inodeだけをread-only取得し、socket種別はshellの`-S`で確認してroot-owned socketであることを固定する。service側は同baselineを受け、固定pathが存在する場合はservice viewがsocket / mode 0000 / runner identityからR/W/X不可かつhost側dev:inodeとは異なることを確認する。host baseline取得後に新たに固定pathが出現した場合もraceを信用せずfail-closedする。その後 `/run` をread-only走査し、mask後もrunner identityからwrite可能なroot-owned UNIX socketが1件でも残れば、未知のrunner-image driftとしてnative Codex/model call前にfail-closedする。permission上traverse不能なpathとscan中に消滅したpathはworkloadから到達不能または通常のruntime raceとしてskipするが、それ以外のscan errorはfail-closedとする。directory symlinkは `os.walk(..., followlinks=False)` で辿らず、files entryのmetadata取得も `os.stat(..., follow_symlinks=False)` としてsymlink targetを解決しない。これはsymlink loopと `/run` 外へのscope escapeを避けるための意図的な境界であり、`ELOOP` をgeneric skip errorへ追加してfail-closed条件を弱めない。socketへconnectは行わず、host側permissionも変更しない。このguardの対象は、旧root-phaseが実際に制限していたsecurity intentに合わせたfilesystem path上のroot-owned service socket under `/run` である。abstract namespace socket、`/run` 外のfilesystem socket、非root所有socketは本guardの対象外であり、blanket AF_UNIX denyと同等の全AF_UNIX遮断を主張しない。現在のrunner/Codex evidenceではこれらを追加遮断する根拠はなく、別のprivileged IPC classがrunner imageまたはCodex threat modelで確認された場合は#328で再評価し、推測でscopeを拡張しない。なお固定13 pathの `InaccessiblePaths` maskはservice全期間で継続する一方、residual writable root-owned socket scanはnative Codex起動直前のpoint-in-time検査であり、preflight通過後に新規生成された別pathのsocketを継続監視しない。この時間的残存面も受容済みとし、runtime revalidationやrunner-image変化で新規privileged socket classが観測された場合は#328で再評価する。このpreflightはtransient serviceのExecStart内で実行されるため `RuntimeMaxSec` の内側に含まれる。service内preflightの失敗はunit journalへ `Service-local hardening preflight ...` diagnosticを残し、exit codeを `39=sudo検査不能 / 40=sudo保持 / 41=UID不一致 / 42=GID不一致 / 43=supplementary groups残存 / 44=NoNewPrivs不成立 / 45=capability非zero / 46=AF_UNIX拒否 / 47=AF_INET拒否 / 48=固定socket maskまたはhost baseline不成立 / 49=残存writable root-owned UNIX socketまたはscan異常` として付与する。root shellでservice起動前の固定path baseline取得・socket種別・owner確認が失敗した場合はexit 50とし、transient unit作成前なのでunit journalではなくdeveloper step logへ `Service-local hardening root preflight protected UNIX socket baseline failed: ...` を残す。この場合はunit限定journal回収へ到達しない。これらのcodeはnative Codex自身のexit codeと衝突し得るため、code単独で原因を確定せず、39–49はunit journal、50はdeveloper step logの対応diagnosticと併読して判定する。service自体がrc=0でも、後段のexact preflight success markerを同一unit journalから回収・検証できない場合はdeveloper stepがexit 51でfail-closedする。一方でnative Codex自身のrc=51もそのままdeveloper stepへ伝播し得るため、51だけでは原因を確定しない。developer step logに `Service-local hardening preflight success marker unavailable from unit journal.` がある場合だけmarker回収failureと判定し、同diagnosticが無い51はservice/Codex側failureの可能性を維持する。

Codexはこのhardening後かつservice cgroup内でvalidated native binaryを直接実行する。service commandは `/usr/bin/env -i` から開始し、`HOME` / `USER` / `LOGNAME` / `PATH` / `RUNNER_TEMP` / `GITHUB_WORKSPACE` / `CODEX_HOME` / `CODEX_FINAL` / `CODEX_PROMPT_FILE` / `CODEX_MODEL` / `CODEX_NATIVE` / `CODEX_PACKAGE_ROOT` / `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` / `PROTECTED_UNIX_SOCKET_PATHS` / `PROTECTED_UNIX_SOCKET_HOST_IDS` だけを明示allowlistとして渡す。後二者は上記13件の非機密な固定path listと、service起動直前にroot shellがread-only取得した存在pathのdev:inode baselineであり、同一service preflightが `InaccessiblePaths` の実効性とhost inode非露出を検証するためだけに使用する。preflight完了後のnative Codex `exec env` では両変数を明示unsetし、Codex process / local toolへhost baselineを継承しない。API key、GitHub App token、setup stepのその他environmentも継承しない。npm launcher parityとして `CODEX_MANAGED_PACKAGE_ROOT=<validated package root>`、`CODEX_MANAGED_BY_NPM=1` をchild launcher内で付与し、Bun / pnpm / Vite+ markerはunsetする。pin済みAction sourceではResponses API endpointは追加environmentではなく `CODEX_HOME/config.toml` のlocalhost providerで渡されるため、serviceはこのallowlistだけでproxyを利用する。actual Codex + localhost request pathは#363 / Run #137でservice-local hardening下でも成立済みである。

developer stepのpreflightでは `CODEX_HOME/config.toml` をTOML parseし、top-levelが `model_provider` / `model_providers` だけであること、selected providerが `codex-action-responses-proxy` であること、`base_url` が `http://127.0.0.1:<valid-port>/v1`、`wire_api` が `responses` であることを必須とする。unexpected keyやpermission / sandbox / approval設定が混入した場合はfail-closedに停止する。CLI optionはworkflow側の固定値だけとし、`--skip-git-repo-check`、workspace、final output path、trusted `CODEX_MODEL`、`model_reasoning_effort="medium"`、`default_permissions=":workspace"` を固定する。Codex 0.156.1 sourceでは `default_permissions` がpermission profile選択キーで、`:` 始まりの名前はbuilt-in profile、`:workspace` はbuilt-in workspace profileとして解決される。0.153.4 source確認は本書のcurrent根拠として扱わない。#410 / Run `35822596587` と#328 / Run `35514293157` では0.156.1 / `:workspace` のactual local-tool pathとfinite completionを確認済みだが、任意の `$RUNNER_TEMP` pathに対するlocal-tool write可否までは推測しない。一方、native Codex workload自身が同directoryの `CODEX_FINAL` を書く設計・実績があるため、`RUNNER_TEMP` をpost-Codex trusted artifactの非書込境界としては使用しない。継続的なruntime / hardening実証は#328を正本とする。service rcがnon-zeroの場合はそのcodeをdeveloper stepへ伝播させ、timeout / Codex failure / launcher failureを既存どおりfail-closedに扱う。transient serviceのstdout/stderrは既定どおりjournalへ送られるため、service終了後にはまず対象unitだけを `journalctl --unit="$unit" --no-pager --output=cat --lines=200` でboundedに回収し、preflight / native Codex / timeout failureの非機密診断をephemeral runner終了前に残す。このbounded dumpはdiagnostic専用で `|| true` を維持する。service rc=0の場合だけ、同じunique unitへ2本目のread-only `journalctl --unit="$unit" --no-pager --output=cat --quiet` を実行してそのunitの出力を取得し、journalctl固有の `--grep` / `--lines` 評価順序には依存せず、取得済みtextをshell側の `grep -Fxq` でexact `Service-local hardening preflight verified AF_UNIX/AF_INET and protected UNIX socket boundary.` markerと照合する。この2本目はtail boundを掛けず同一unit journal全体をshell変数へcaptureするため、unit journal量に応じてメモリ使用量と処理時間が増える。Run `35514293157` でpreflight markerが末尾200行から押し出された実績があり、boundedな診断用1本目だけではmarkerを確認できないためである。この2本目の取得内容はjob logへ出さない。journalctl自体の失敗またはexact marker欠落はexit 51でfail-closedとし、成功時はexpected marker 1行をstep logへ明示出力してからservice rc=0を返す。service rcがnon-zeroの場合はこのsuccess-marker確認を実行せず、marker欠落によって元のfailure rc / diagnosticを上書きしない。2本のjournalctlはいずれも同一unit限定であり、host-wide journalや他unitをdumpせず、marker用のworkload-writable fileも作成しない。

#369以降、`Run Codex developer` の直前と直後にはread-only host integrity observerを置く。beforeでは `/run/systemd/notify` と `/run/dbus/system_bus_socket` のdev / inode / uid / gid / mode、`systemd-resolved.service` のActiveState / SubState / MainPID / NRestartsを取得し、github.com / api.github.com DNS成功を確認する。capture stepは値を `$GITHUB_OUTPUT` へ書き、runnerがstep終了時にstep outputとして回収した値だけをafter observerへ渡す。`$GITHUB_OUTPUT` のbacking fileが実装上 `$RUNNER_TEMP` 配下に置かれること自体を安全根拠にはせず、Codex workloadへbaseline outputをenvironmentとして渡さないことと、capture step終了後にworkflow context経由で参照することを境界とする。afterは `if: always()` で実行し、developer stepがrunnerへ制御を返した場合に、socket identity / modeとresolved 4 propertyがbeforeと完全一致、resolvedがactive/running、両DNSが引き続き成功することをfail-closedに確認する。host状態の取得には `stat` / `systemctl show` / `getent ahosts` のread-only commandだけを使用し、値の整形・比較は `printf` / `tr` / `sort` / `test` / `grep` のshell text処理に限定する。`/run` write、permission変更、service lifecycle変更、secret出力は行わない。before observerが失敗またはそれ以前の失敗でskipされた場合、after observerはbaseline不在を検出してhost比較前にfail-closedとなり `HOST_INTEGRITY after` を残さない。この場合もhost mutationの証拠とは扱わず、観測不能としてautomatic retryせず#328へ戻る。既知のRun #846 / #853のようにdeveloper stepが `in_progress` のままjob-level cancellationまで制御を返さない場合も、後続の`if: always()`は開始できず `HOST_INTEGRITY after` は残らない。この欠落もhost mutationの証拠とは扱わず、観測不能としてautomatic retryせず#328へ戻る。

developer stepがsuccessし、host integrity after observerもsuccessし、`codex-final.md` がnon-emptyの場合だけ既存のrequirement change gate、trusted diff guard、commit、push、Draft PRへ進む。resolver / service-local hardening preflight / systemd / setpriv / native Codex / inner timeout / host integrity observerのいずれかが失敗した場合は通常後続stepをskipし、別job failure handlerで `human-review-required` へ停止する。

Codex 0.156.1固有のmain反映後production runtime再検証は#410で、現行 `CODEX_MODEL` のまま通常 `/codex develop` を1回だけ実行して行う。継続的なruntime / hardening再検証と失敗時の調査は親Issue #328を正本とする。#370でread-only host integrity observerはmainへ反映済みであり、#378のAF_UNIX/socket-mask production fixもmainへ反映されるまでは#307を再開しない。両方がmainへ入った後、#307本文は対象Issue固有の停止状態・branch / PR / unexpected repository write不存在とcurrent implementation contractを同期する。通常 `/codex develop` は#328で人間判断した対象1件へ1回だけ投入し、allowlist環境下のlocalhost Responses proxy経由model call、actual local-tool path、`:workspace` の実効permission境界、service-local preflight / setpriv / systemd cgroup収束、およびhost service socket / resolver / DNS非破壊を非機密証跡で確認する。いずれかを確認できない場合はautomatic retry / extended fallbackを行わず#328へ戻る。

upstream `openai/codex-action` で公式のprocess-tree lifecycle修正が反映された場合も、security hardeningとprocess-tree boundが本方式以上に維持されることをruntimeで確認するまで、安易にcgroup方式を撤去しない。

#### Issue起点AI Developerの異常終了

`develop-from-issue` がsuccess以外で終了した場合は、対象Codex jobとは別runnerで `handle-issue-developer-failure` を実行し、安全側へ停止する。developer jobはrepository write前にcanonical `ai/issue-<Issue番号>` remote HEADを固定する。handlerはdeveloper App tokenで同branchのcurrent remote HEADを取得し、job resultが `failure` / `cancelled`、両HEADが有効かつ完全一致する場合だけ `developer_execution_failed`（`failed_action=develop`）とする。その他の結果、HEADの欠落・取得不能・差異は `state_inconsistent` とし、直接resumeしない。差異だけから、このrunが書いたとは断定しない。

handlerはtrusted default-branch checkoutの `create-human-pause.sh` をdeveloper App IDとtokenで呼び、closing Issueと同branchのopen PR（存在する場合）を停止する。open PRが複数またはAPI結果が不正ならfail-closedにする。pause record成立後のラベル同期、重複抑止、Discord通知はcommon helperへ委ね、helper failureを正常扱いしない。自動retry、branch rollback、branch deleteは行わない。

Issue起点のAI Developerを再実行する前に、少なくとも次を確認する。

* 対象Issueが正しいこと。
* 失敗したActions Run URLまたはrun ID。
* `develop-from-issue` のjob result。
* pause recordとラベル同期の結果。
* `ai/issue-<Issue番号>` remote branchの有無と現在のhead。
* 同じIssueに紐づくopen PRの有無とPR head。
* timeoutまたは異常終了後に、予期しないcommit、push、PR作成・更新が発生していないこと。
* 取得可能な範囲で、通常の長時間実行、runner-loss、設定不備、一時的な外部障害等のどのカテゴリが最有力か。
* 「Issue本文におけるcurrent implementation contract」に従い、Issue本文が現在有効なscope、interface、完了条件を表し、trusted commentに新旧の競合する技術契約がある場合も本文からcurrent contractを一意に判断できること。
* 契約が未決または相互に矛盾する状態なら、同一の `/codex develop` を単純retryせず、実装判断を確定してIssue本文へ同期してから再実行すること。

再実行可能と人間が判断した後、停止ラベルがある場合は「人間エスカレーション」節の停止解除契約に従う。

既存PRへ追加開発を継続する場合は、PRがDraftであることと、既に開始済みのClaude Reviewがないことを確認する。openかつ非Draft PRで `human-review-required` を解除するとClaude Reviewの再実行条件になり得るため、追加開発中に意図しないレビューを起動しない。pushの`synchronize`だけではClaude Reviewを起動しない。merged/closed PRのcleanupは「人間エスカレーション」節を正本とする。

その後、再実行が必要な場合は原則としてOpen Issueへ `/codex develop` を単独コメントとして投稿する。十分に閉じたcurrent contractでも15分timeoutが再現し、通常runの単純retryではなく人間がextended-runを明示承認した場合だけ、次節の条件で `/codex develop extended` を使用する。

#### human-approved extended-run

`/codex develop extended` は通常runの代替ではなく、十分に閉じたcurrent implementation contractでも15分job timeoutが再現した場合の人間承認付き例外とする。timeout実測がない段階から最初の実行でextendedを選ぶことは運用違反とし、automation側は過去failure reasonを推測して機械判定しない。

使用前に、Issue起点の異常終了で定めるRun / branch / PR / unexpected write / current contractの確認を完了し、再開可能と人間が判断する。Issueまたは関連PRに `human-review-required` が残っている間はextended commandも起動しないため、人間が再開可能と判断した後に「人間エスカレーション」節の停止解除契約へ従ってからcommandを投稿する。

extended-runのjob-level timeoutは35分固定とし、developer stepは30分、inner cgroup `RuntimeMaxSec` は1780秒とする。通常commandはjob-level 15分 / developer step 12分 / inner cgroup 700秒とする。job 15分とdeveloper step 12分の差3分はsetup / native resolution / prompt準備、developer step前後のhost integrity observer（各stepのtimeout上限は1分）、post-gate / repository writeを含む外側余白である。observerの通常実行は短時間だが、このstep timeout上限を追加実行時間の保証値とはみなさない。inner 700秒とstep 720秒の公称差20秒は、developer step側のconfig.toml検証・runner credentials再照合、`systemd-run` unit作成、service終了後のunit限定journal回収、およびsystemd TERM→KILL収束（`TimeoutStopSec=5s`）を含む。上記「Issue起点developerのCodex実行境界」に定義するservice-local hardening preflight一式（identity / privilege、AF_UNIX/AF_INET、固定13 socket mask、`/run` residual writable root-owned socket scan）はExecStart内で実行されるため `RuntimeMaxSec` の内側である。extended側も1780秒と1800秒の公称差20秒を同じ内側収束余白として扱う。この余白の実効性は#328のruntime再検証で確認し、15分job cap内でafter observerまたは後処理へ到達できない場合はautomatic retryせず#328へ戻り、observer timeoutを含む外側budgetとinner / step timeout値を再評価する。任意timeout入力、通常15分runからのautomatic fallback、automatic retry、fail-open、停止ラベルのbypassは設けない。extended-runではCodex完了後のrepository write途中でjob cancellationへ到達し、push済みの `ai/issue-<Issue番号>` branchに対応するopen PRが存在しない状態が残る可能性もある。この場合は再実行前にbranch head、open PR、closing Issueの対応を照合し、予期しないcommit / push / PR writeがないことを確認してから復旧判断する。

extended-runでもtimeoutまたは異常終了した場合は、同じcommandを自動または単純retryしない。failure handlerによる停止を維持し、正常長時間処理、runner-loss、model/provider差、別実行経路の必要性を再調査する。extended-runの実地検証は #307 / Run #833 `35316054357` で1回実施済みで、Codex Action wrapperが完了せず収束しなかった。#365反映後は#328の再検証手順を正本として通常 `/codex develop` を人間判断した対象1件へ1回だけ投入し、service-local preflight + setpriv + systemd cgroup + native Codex経路とhost socket / resolver / DNS非破壊を再検証する。収束しなければautomatic retryせず #328 の調査へ戻る。`/codex develop extended` を投稿してもIssueへ診断commentが付かず、`human-review-required` も付かず、developer jobの記録も見当たらない場合は、job-level timeout式を含むworkflowの評価・起動前失敗の可能性を考慮し、Actions run一覧で当該eventのworkflow状態を確認する。

#### Claude review follow-upの異常終了

Claude review follow-upでは、通常の `Gate automated follow-up` は停止ラベルを付けない。trusted Draft復帰jobまたは `Run Codex follow-up` がtimeout、runner-loss、action failure等で異常終了した場合は、専用failure handlerがtrusted base checkoutの `create-human-pause.sh` でPRをprimary targetとして停止する。event HEADとdeveloper App tokenで再取得したcurrent PR HEADがともに有効な40文字の小文字SHAで一致する場合だけ、current HEADを `paused_head` とする `developer_execution_failed`（`failed_action=fix`）を記録する。HEADの差異・欠落・形式不正・取得不能は `state_inconsistent` とし、再開可能なfix failureに分類しない。common helperがclosing IssueとPRへ `human-review-required` を同期し、GitHub pause成立後に日本語Discord通知をbest-effortで試行する。通知失敗でも停止を維持し、自動retry、rollback、branch deleteは行わない。

異常終了後にCodex follow-upを自動retryしない。現行workflowには、停止状態を維持したまま同じClaude指摘に対するCodex follow-upだけを安全に再実行する専用入口はない。

人間はActions結果とPR差分を確認し、必要な修正が残る場合は手動で修正する。`Run Codex follow-up` 側の異常終了ではPRはDraftのままなので、修正と確認が完了した後、「人間エスカレーション」節の停止解除契約に従い、人間または明示的なtrusted経路がReady for reviewへ戻して再レビューを要求する。Draft復帰job自体が異常終了してopen PRが非Draftのまま停止している場合は、PR側の停止ラベルを解除する前に人間がPRをDraftへ戻し、準備完了後にReady化する。

停止ラベルの解除順序、open PRでの再レビュー起動条件、merged/closed PRのstale label cleanupは「人間エスカレーション」節を正本とする。follow-up復旧では、その契約に従って停止解除後のDraft/Ready状態を整える。

Codex follow-up専用retry入口が将来必要になった場合は、この復旧手順へ例外を追加せず、別Issueで設計・実装する。

#### timeout後の作業分割判断

timeoutや異常終了が発生したという事実だけで、作業量が大きすぎたとは判断しない。

runner-lossやGitHub Actions基盤側の異常は、小さい変更でも発生し得るため、失敗原因がrunner-lossまたはinfrastructure failureと判断できる場合は、それだけを理由にIssueを分割しない。

一方、runnerとログが正常に動作したままCodex実行が当該runのjob-level timeout値近くまで継続してtimeoutした場合、または同じscopeで長時間化を繰り返した場合は、再実行前に作業量を見直す。

分割する場合は、各IssueまたはPRが独立して実装、検証、レビューでき、安全性・正確性・要求整合性を単独で確認できる単位にする。

過去にAI Developerの長時間化を避けるため分割した作業は、新たな根拠なく再統合して大きなAI Developer jobへ戻さない。

Webhook登録、通知確認、main反映後のEnd-to-End確認はIssue #46で追跡する。

## Bootstrapと復旧

`pull_request` workflowはdefault branchにworkflowファイルが存在してから通常運用を開始する。初回導入PRは管理者が内容を確認し、reviewer Appによる一時レビューまたは手動レビューを経てマージする。通常の自動マージは `ai/issue-*` だけに限定されるため、bootstrap用ブランチは自動マージ対象外である。

`/ai resume develop` consumer自身の導入PRが `requirements_change` のactive pauseに入ると、consumer未導入のmainからは正式resumeできない。#483 / PR #484で起きたこのbootstrap deadlockでは、`human-review-required` だけを手動解除してtrusted active pause recordを孤児化させず、pauseした元Issue / PRをopenのまま維持する。Code Owner自身がbootstrap PR authorだとself-approvalではRulesetのCode Owner承認を満たせないため、Code Owner保護やRulesetを弱めない。

復旧は、停止した導入PRの実装差分を保ったまま、別のbootstrap Issueのcanonical `ai/issue-N` branchを通常のIssue起点Developer経路で更新し、Developer App authorのDraft PRとして先行反映する。#485ではsource commit `cb72d3606549ab9ec5287ff3b399425df08150b6` 由来の実装差分を変更せず、追加差分を本運用文書だけに限定する。source commit由来の実装差分、追加した運用文書差分、closing Issueと後継Issueのtraceabilityを確認し、そのPRで通常のAI Workflow Regression / PR Traceability / Claude Reviewと独立した人間Code Owner reviewを受けてから、protected-pathの手動mergeでmainへ反映する。既存reviewを新PRの承認として流用しない。main反映後に元Issue / PRのactive pauseを正式な `/ai resume develop` でconsumeして元のlifecycleを再開する。#485の後継 #483の完了条件と実施順序はclosing Issue本文の `Scope-out impact and follow-up` を正本とする。

Actionsが失敗した場合は、失敗step、Appのインストール先・権限、Repository secret/variable名、OIDC federation ruleの対象を確認する。モデルpreflightまたはモデル実行stepで失敗した場合は `CLAUDE_MODEL` / `CLAUDE_MODEL_STANDARD` / `CODEX_MODEL` の設定有無と、指定モデルが現在のAnthropic workspaceまたはOpenAI API projectで利用可能かを確認する。secret値とRepository variable値はログへ出さない。モデルIDについては前述のとおりIssue/PRの変更履歴・検証証跡へ記録してよいが、ログへは出さない。

`.github/scripts/**` を変更した場合、または認可・信頼境界・closing Issue・merge gateのロジックを変更した場合は次を実行し、fixtureを確認する。

```bash
bash .github/scripts/test-ai-workflow.sh
bash .github/scripts/test-claude-review-workflow.sh
bash .github/scripts/test-ai-developer-workflow.sh
```

`.github/workflows/**` を変更したが上記fixtureの対象外と判断した場合は、その理由をPR本文へ記録する。

AI Workflow Regressionの起動対象path一覧は `.github/workflows/ai-workflow-regression.yml` の `on.pull_request.paths` を唯一の機械正本とし、この運用文書では完全な一覧を複製しない。正本の対象pathに一致するPRでは、独立した `AI Workflow Regression / Fixtures` が `.github/scripts/test-*.sh` を全件実行し、現在PR headに対する結果をGitHub Actionsへ残す。初回導入PRはBootstrap制約に従い、このworkflowがdefault branchへ反映された後の対象PRから通常のCI証跡となる。これは専用fixtureと横断fixtureの両方を実行するrepository側の独立証跡であり、Codex自身の関連validation実行・結果報告責務を置き換えない。Codex側でvalidationを実行できない場合は理由を記録し、CI結果を確認する。対象fixtureは外部サービスへ実アクセスせず、repository内で完結する。event、実行順、timeout、concurrencyなどの詳細も同workflowを正本とする。`test-ai-workflow.sh` は正本workflowに必要なtrigger contractが残ることを検証するfixtureであり、trigger集合全体の独立した正本ではない。`docs/00_requirements/01_Introduction.md` と `docs/diagrams/README.md` は内容をfixtureで読む対象ではないが、`test-ai-developer-workflow.sh` がAGENTS固定参照のfile existenceを機械contractとして直接assertするためexact trigger対象とする。`docs/30_operations/ai-development-workflow.md` は同fixtureが停止・Draft復帰等の運用安全契約とscope-out参照先のcanonical headingを実ファイルから直接assertするためexact trigger対象とする。その他のproduct / requirements / diagrams文書はAI workflow fixtureの直接依存ではないためtriggerへ広げない。Claude review / mergeのprotected-path classifierはCode Owner保護のため `CODEOWNERS` やその他の `.github/**` もhigh-riskに含めるが、AI Workflow RegressionはAI instruction / runtime fixtureが直接依存するsubsetだけを起動対象とし、通常のIssue templateやその他のrepository governance文書の変更だけでは起動しない。この差は意図的であり、protected-path判定そのものを弱めるものではない。PR本文で上記コードブロックの手動fixtureを対象外と記録しても、この全件自動実行は免除されない。
